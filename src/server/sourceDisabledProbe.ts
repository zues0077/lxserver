/**
 * 整源停用源的「复检与自愈」任务（disableReason 标签机制，2026-11-13）
 *
 * 背景：加载层对 enabled=false 的源直接跳过（loadOneSourceInner），因此这类源
 * 完全不在主巡检视野里 —— 既不会被定罪，也永远不会恢复。但「停用」其实有好几种
 * 来源，语义完全不同：
 *   - `after-import`：hunter 灌入落盘时的默认停用（新源条目生来 enabled=false）。
 *     这类源不该被打标冷冻；零成本策略下本任务也不主动探测它（临时 eval 太重），
 *     等用户/hunter 显式启用时清标签，验证交给主巡检；
 *   - `probe-dead`：after-import 源被本任务连续判定无效后的升级态。hunter 看到它
 *     才打标冻结（所有服务端平台不再灌入）；
 *   - `manual`（含无标签的老数据兜底）：用户/hunter 手动停用，尊重意愿，永不探测。
 *
 * 状态机（零成本策略，2026-11-13 二次修订）：
 *   灌入落盘(enabled=false, after-import)
 *     └─ 不主动探测（临时 eval = 主线程同步 eval 整个脚本，违背「放音期不重载/
 *        重载须串行」两条历史规则的成本太大）。等用户或 hunter 显式启用时清标签，
 *        之后交给主巡检做平台级验证 —— 主巡检本来就有完善的失效处置。
 *   probe-dead（历史遗留的判死态，数量极少）
 *     └─ 持续低频复检（self-heal，无永久死区），严格走 runSerialized + 放音期跳过
 *            ├─ 恢复有效 → 启用 + 清标签 → hunter veto 自动解除
 *            └─ deadAt 满 allDownDays → 移入回收站（不留僵尸）
 *   注：新 probe-dead 只能由历史数据/升级路径产生，本任务不再把 after-import 升级
 *   为 probe-dead（不探就没有失败计数）。
 *
 * 与主巡检（sourceProbe.ts）的分工：
 *   主巡检管「已加载源的平台可用性」，处置是平台级；
 *   本任务管「未加载源的源级启停」，处置是源级。判定口径复用主巡检的
 *   probePlatform（含 verifyLink）与测试曲目池，绝不开第二套标准。
 *
 * 安全边界：
 *   1. 只碰 `disableReason` 为 probe-dead 的停用源，manual / after-import 永不探测；
 *   2. 放音期整轮跳过探测（isAudioStreaming，重载 = 主线程同步 eval 会断流）；
 *   3. 临时 eval 与重载一律排进 runSerialized 全局串行队列，绝不并发叠加；
 *   4. 每轮最多 restoreBatch 个源，按最久未探轮转；
 *   5. 探测期间 markSourceBusy，避免被自检护栏误判；临时实例探完立即 dispose；
 *   6. 清理动作只在本任务（restoreIntervalMinutes > 0）里执行 ——
 *      保证「清理前必有低于 allDownDays 的复检窗口」（用户 2026-11-13 口径）；
 *   7. 平台轮转：每轮换一个声明的平台探测，避免单个失效平台把好源永久冤死。
 */
import fs from 'node:fs'
import path from 'node:path'
import { configOf, probePlatform, pickTestSongsForDisabledProbe } from './sourceProbe'
import { buildMainThreadApiInstance, reloadSingleSource, isAudioStreaming } from './userApi'
import { normalizeQualityList } from './sourceContract'
import { moveScriptToTrash } from './sourceTrash'
import { markSourceBusy } from './sourceGuard'
import { isThrottled } from './sourceGovernor'
import { beginHostActivity, endHostActivity, runSerialized } from './sourceActivity'
import type { ProbeTestSong } from './sourceProbe'
import type { ScheduledTask, TaskExecutionResult } from './task/types'

export const DISABLED_PROBE_TASK_ID = 'custom_source_disabled_restore'
const DISABLED_STATUS_FILE = 'disabled-probe-status.json'

/** 停用原因标签（写在 sources.json 条目的 disableReason 字段） */
export type DisableReason = 'after-import' | 'probe-dead' | 'manual'

/**
 * 归一化调用方传入的停用原因。
 * 只有显式的 after-import 会被采纳，其余一律落 manual（含老数据无标签兜底）——
 * 「拿不准就当用户手动停用」是最安全的缺省：不探测、不自动启用，hunter 照旧打标。
 */
export const normalizeDisableReason = (reason: unknown): DisableReason =>
    reason === 'after-import' ? 'after-import' : 'manual'

/** 连续无效达到阈值 → 升级 probe-dead */
export const shouldMarkDead = (failCount: number, threshold: number): boolean =>
    Number.isFinite(threshold) && threshold >= 1 && failCount >= threshold

/** probe-dead 满多少天移入回收站（allDownDays 口径，0 = 关闭时间窗） */
export const shouldTrashDisabled = (deadAt: number, allDownDays: number, now: number = Date.now()): boolean =>
    deadAt > 0 && Number.isFinite(allDownDays) && allDownDays > 0
    && now - deadAt >= allDownDays * 24 * 60 * 60 * 1000

// ============================ 状态读写 ============================

interface DisabledSourceState {
    name: string
    /** 当前标签（与 sources.json 条目保持同步，这里只做缓存） */
    reason: DisableReason
    /** 连续无效次数（成功即清零） */
    failCount: number
    lastCheckAt: number
    lastOkAt: number
    lastError: string
    /** 升级 probe-dead 的时刻（清理倒计时起点） */
    deadAt?: number
    /** 平台轮转游标 */
    platformCursor?: number
}

interface DisabledStatusFile {
    version: 1
    updatedAt: number
    sources: Record<string, DisabledSourceState>
}

const dataPath = () =>
    (global as any).lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
const ownerDirName = (owner: string) => (owner === 'open' ? '_open' : owner)
const ownerDir = (owner: string) => path.join(dataPath(), 'users', 'source', ownerDirName(owner))
const registeredUsers = (): string[] => {
    const users = (global as any).lx?.config?.users || []
    return users.map((u: any) => u && u.name).filter((n: any): n is string => !!n)
}

const statusPath = (owner: string) => path.join(ownerDir(owner), DISABLED_STATUS_FILE)

const readStatus = (owner: string): DisabledStatusFile => {
    try {
        const raw = JSON.parse(fs.readFileSync(statusPath(owner), 'utf-8'))
        if (raw && typeof raw === 'object' && raw.sources && typeof raw.sources === 'object') {
            return { version: 1, updatedAt: Number(raw.updatedAt) || 0, sources: raw.sources }
        }
    } catch { /* 不存在/损坏按空处理 */ }
    return { version: 1, updatedAt: 0, sources: {} }
}

const writeStatus = (owner: string, status: DisabledStatusFile): void => {
    try {
        status.updatedAt = Date.now()
        fs.writeFileSync(statusPath(owner), JSON.stringify(status, null, 2))
    } catch (e: any) {
        console.warn(`[停用源复检] 写状态失败 (${owner}):`, e?.message || e)
    }
}

const listStatusOwners = (): string[] => ['open', ...registeredUsers()]

// ============================ 主流程 ============================

export interface DisabledProbeRunResult {
    startedAt: number
    durationMs: number
    sourcesChecked: number
    enabledCount: number
    markedDeadCount: number
    trashedCount: number
    skippedThrottled: number
    /** after-import 源数量（零成本策略下只统计不探测） */
    skippedAfterImport: number
    message: string
}

/** 读取 sources.json 原始条目列表 */
const readSourcesManifest = (owner: string): { path: string; sources: any[] } => {
    const metaPath = path.join(ownerDir(owner), 'sources.json')
    let sources: any[] = []
    try {
        sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        if (!Array.isArray(sources)) sources = []
    } catch { sources = [] }
    return { path: metaPath, sources }
}

/**
 * 跑一轮「停用源复检」。任务调度入口（也是 probe-now 手动触发的复用点）。
 * `only` 指定则只探这些源（owner_id），用于测试与手动触发。
 */
export async function runDisabledSourceProbe(options: { only?: Array<{ owner: string; id: string }> } = {}): Promise<DisabledProbeRunResult> {
    const startedAt = Date.now()
    const conf = configOf()
    const empty: DisabledProbeRunResult = {
        startedAt, durationMs: 0, sourcesChecked: 0, enabledCount: 0,
        markedDeadCount: 0, trashedCount: 0, skippedThrottled: 0, skippedAfterImport: 0, message: '',
    }
    if (!conf.enabled) return { ...empty, message: '巡检已关闭' }
    if (!conf.restoreIntervalMinutes) return { ...empty, message: '复检间隔为 0，停用源复检不执行' }

    beginHostActivity('sourceDisabledProbe', '停用源复检中')
    markSourceBusy(conf.timeoutMs * 4)

    // 收集候选：enabled=false 且标签为 after-import / probe-dead 的条目
    const wanted = options.only && options.only.length
        ? new Set(options.only.map(o => `${o.owner}_${o.id}`))
        : null
    const candidates: Array<{ owner: string; entry: any; state: DisabledSourceState; status: DisabledStatusFile; metaPath: string; sources: any[] }> = []
    let skippedAfterImport = 0
    for (const owner of listStatusOwners()) {
        const status = readStatus(owner)
        const { path: metaPath, sources } = readSourcesManifest(owner)
        for (const entry of sources) {
            if (!entry || !entry.id) continue
            if (entry.enabled !== false) continue
            const reason: DisableReason = entry.disableReason === 'probe-dead'
                ? entry.disableReason : 'manual'
            // 零成本策略：after-import（灌入后停用）不建状态、不探测 ——
            // 等用户/hunter 显式启用时由 handleToggle 清标签，之后交给主巡检验证。
            // 只有 probe-dead（历史判死态，数量极少）才值得花一次临时 eval 的成本。
            if (entry.disableReason === 'after-import') { skippedAfterImport++; continue }
            if (reason === 'manual') continue
            if (wanted && !wanted.has(`${owner}_${entry.id}`)) continue
            if (!status.sources[entry.id]) {
                status.sources[entry.id] = { name: entry.name || entry.id, reason, failCount: 0, lastCheckAt: 0, lastOkAt: 0, lastError: '' }
            }
            const state = status.sources[entry.id]
            state.reason = reason
            state.name = entry.name || entry.id
            candidates.push({ owner, entry, state, status, metaPath, sources })
        }
    }

    const result: DisabledProbeRunResult = { ...empty, startedAt, sourcesChecked: candidates.length, skippedAfterImport }

    if (!candidates.length) {
        result.durationMs = Date.now() - startedAt
        result.message = skippedAfterImport
            ? `没有待复检的判死源（灌入后停用 ${skippedAfterImport} 个，零成本策略不探测）`
            : '没有待复检的停用源'
        return result
    }

    // 每轮限量：restoreBatch 个，按最久未探优先轮转
    candidates.sort((a, b) => (a.state.lastCheckAt || 0) - (b.state.lastCheckAt || 0))
    const planned = candidates.slice(0, conf.restoreBatch)

    // 逐个探测（源级探测要临时 eval 整个脚本，重于平台级探测，串行 + 节流）
    // 放音期整轮跳过：临时 eval = 主线程同步 eval 整个脚本（实测 2~6 秒），会直接断流
    const streaming = isAudioStreaming()
    if (streaming) {
        console.log('[停用源复检] 正在播放音频，本轮跳过探测（回收站清理照常执行）')
    }
    if (!streaming) for (const c of planned) {
        const { owner, entry, state } = c

        // 降速慢源跳过：临时 eval 一次 = 主线程同步 eval 整个脚本，慢源一探就是几秒
        if (isThrottled(owner, entry.id)) {
            result.skippedThrottled++
            continue
        }

        // 平台轮转：每轮换一个声明平台，避免单个失效平台永久冤死好源
        const platforms: string[] = Array.isArray(entry.supportedSources) && entry.supportedSources.length
            ? entry.supportedSources
            : []
        if (!platforms.length) {
            state.lastCheckAt = Date.now()
            state.lastError = '条目未声明支持平台，无法探测'
            continue
        }
        const cursor = ((state.platformCursor || 0) % platforms.length + platforms.length) % platforms.length
        state.platformCursor = cursor + 1
        const platform = platforms[cursor]

        const songs: ProbeTestSong[] = await pickTestSongsForDisabledProbe(platform)
        if (!songs.length) {
            state.lastCheckAt = Date.now()
            state.lastError = '无可用测试曲目'
            continue
        }

        // 临时 eval 出实例探一次（探完立即 dispose，防止脚本定时器/请求泄漏）
        // 注意：dispose 必须放在**探测结束之后**（实测踩坑：写在 finally 里会在探测前
        // 就销毁实例，callRequest 调用直接报「源已被卸载」，所有源都会被误判无效）。
        // eval 是主线程同步重活，必须排进全局串行队列（历史规则：重载必须串行）。
        let callRequest: ((action: string, source: string, info: any) => Promise<any>) | null = null
        let inst: any = null
        try {
            const scriptPath = path.join(ownerDir(owner), entry.id)
            if (!fs.existsSync(scriptPath)) {
                state.lastCheckAt = Date.now()
                state.lastError = '脚本文件不存在'
                continue
            }
            const script = fs.readFileSync(scriptPath, 'utf-8')
            markSourceBusy(conf.timeoutMs * 2)
            inst = await runSerialized(() => buildMainThreadApiInstance(
                { id: entry.id, script, enabled: false, allowUnsafeVM: !!entry.allowUnsafeVM, owner } as any,
                { id: entry.id, script, enabled: false, allowUnsafeVM: !!entry.allowUnsafeVM, owner, name: entry.name } as any,
            ))
            callRequest = typeof inst?.callRequest === 'function' ? inst.callRequest.bind(inst) : null
        } catch (e: any) {
            try { inst?.dispose?.() } catch { /* 忽略 */ }
            state.lastCheckAt = Date.now()
            state.failCount++
            state.lastError = `临时加载失败：${(e && e.message) || e}`
            continue
        }

        if (!callRequest) {
            try { inst?.dispose?.() } catch { /* 忽略 */ }
            state.lastCheckAt = Date.now()
            state.lastError = '脚本实例未提供 callRequest'
            continue
        }

        const probeTarget = {
            owner, id: entry.id, name: entry.name || entry.id,
            // 用实例自报的音质档而不是空对象：pickQuality 拿不到声明会退回 128k，
            // 对「只吃特定档位」的源会因「不支持该音质」被误判无效。
            // 声明可能是字符串数组也可能是 [{type}]，统一归一化（与主巡检同口径）。
            platforms, qualities: (() => {
                const declared = normalizeQualityList((inst?.info?.sources?.[platform] as any)?.qualitys)
                return declared.list.length ? { [platform]: declared.list } : {}
            })(),
            callRequest: (action: string, source: string, info: any) => callRequest!(action, source, info),
        }
        let outcome: { ok: boolean; error?: string }
        try {
            outcome = await probePlatform(probeTarget as any, platform, songs[0], conf)
        } finally {
            // 探测结束才释放实例
            try { inst?.dispose?.() } catch { /* 忽略 */ }
        }
        state.lastCheckAt = Date.now()

        if (outcome.ok) {
            // 恢复有效：启用 + 清标签（hunter 侧 veto 依赖列表里的 enabled，自动解除）
            try {
                entry.enabled = true
                delete entry.disableReason
                fs.writeFileSync(c.metaPath, JSON.stringify(c.sources, null, 2))
                // 重载以注册实例（同样排进全局串行队列，避免与文件监控/手动操作的重载叠加）
                await runSerialized(() => reloadSingleSource(owner, entry.id))
                state.failCount = 0
                state.lastOkAt = Date.now()
                state.lastError = ''
                delete state.deadAt
                result.enabledCount++
                console.log(`[停用源复检] ${owner}/${entry.name || entry.id} 探测有效（${platform}），已自动启用并清除标签`)
            } catch (e: any) {
                state.lastError = `启用失败：${(e && e.message) || e}`
                console.warn(`[停用源复检] 启用失败 (${owner}/${entry.id}):`, e?.message || e)
            }
        } else {
            // probe-dead 复检仍失败：只累计与记录。零成本策略下本任务不再把
            // after-import 升级为 probe-dead（不探就没有失败计数），判死升级仅
            // 保留历史语义（shouldMarkDead 供外部/测试使用）。
            state.failCount++
            state.lastError = outcome.error || '探测失败'
        }
    }

    // 落盘状态缓存
    const touchedOwners = new Set(planned.map(c => c.owner))
    for (const owner of touchedOwners) writeStatus(owner, readStatusCachedDuringRun(owner, planned))

    // 清理：probe-dead 满 allDownDays → 回收站（只在本任务里做，保证清理前必有复检窗口）
    if (conf.restoreIntervalMinutes > 0 && conf.allDownDays > 0) {
        for (const owner of touchedOwners) {
            const status = readStatus(owner)
            const { path: metaPath, sources } = readSourcesManifest(owner)
            let manifestDirty = false
            for (const [id, state] of Object.entries(status.sources)) {
                if (state.reason !== 'probe-dead') continue
                if (!shouldTrashDisabled(state.deadAt || 0, conf.allDownDays)) continue
                const entry = sources.find(s => s && s.id === id)
                if (!entry || entry.enabled !== false) continue
                const trashed = moveScriptToTrash(owner, id, { by: 'probe', reason: 'probe-dead 满 allDownDays 天未恢复', entry })
                if (trashed) {
                    manifestDirty = true
                    const idx = sources.findIndex(s => s && s.id === id)
                    if (idx >= 0) sources.splice(idx, 1)
                    delete status.sources[id]
                    result.trashedCount++
                    console.warn(`[停用源复检] ${owner}/${state.name || id} probe-dead 满 ${conf.allDownDays} 天未恢复，已移入回收站`)
                }
            }
            if (manifestDirty) fs.writeFileSync(metaPath, JSON.stringify(sources, null, 2))
            writeStatus(owner, status)
        }
    }

    result.durationMs = Date.now() - startedAt
    const parts: string[] = []
    if (result.enabledCount) parts.push(`启用 ${result.enabledCount}`)
    if (result.markedDeadCount) parts.push(`判死 ${result.markedDeadCount}`)
    if (result.trashedCount) parts.push(`清理 ${result.trashedCount}`)
    if (result.skippedThrottled) parts.push(`跳过慢源 ${result.skippedThrottled}`)
    if (result.skippedAfterImport) parts.push(`灌入后停用不探 ${result.skippedAfterImport}`)
    result.message = parts.length ? `停用源复检：${parts.join('、')}` : `停用源复检完成（${result.sourcesChecked} 个候选）`
    if (result.enabledCount || result.markedDeadCount || result.trashedCount) {
        console.log(`[停用源复检] ${result.message}`)
    }
    return result
}

/** 本轮内存里的状态（planned 更新后还没落盘时用它，避免清理段读到旧缓存） */
const readStatusCachedDuringRun = (owner: string, planned: Array<{ owner: string; state: DisabledSourceState; status: DisabledStatusFile; entry: any }>): DisabledStatusFile => {
    const status = readStatus(owner)
    for (const c of planned) {
        if (c.owner !== owner) continue
        status.sources[c.entry.id] = c.state
    }
    return status
}

/** 注册到后台任务调度器（间隔复用 restoreIntervalMinutes，与平台复检错峰启动） */
export function createDisabledSourceProbeTask(): ScheduledTask {
    const conf = configOf()
    const minutes = conf.restoreIntervalMinutes
    const task: ScheduledTask = {
        id: DISABLED_PROBE_TASK_ID,
        name: '停用源复检（判死源低频复检自愈）',
        intervalMs: Math.max(1, minutes) * 60 * 1000,
        enabled: conf.enabled && minutes > 0,
        isRunning: false,
        // 平台快速复检 20 分钟后开跑，本任务错峰再推 10 分钟，避免启动期三连撞
        startupDelayMs: 30 * 60 * 1000,
        run: async (): Promise<TaskExecutionResult> => {
            const result = await runDisabledSourceProbe()
            return {
                taskId: DISABLED_PROBE_TASK_ID,
                timestamp: Date.now(),
                success: true,
                message: result.message,
                details: result,
            }
        },
    }
    return task
}
