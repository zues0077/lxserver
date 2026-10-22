/**
 * 自定义音源「脚本自检护栏」。
 *
 * 背景：第三方音源脚本是黑盒。实测存在单个混淆脚本（jsjiami v7 + 尾部 while(!![]){}）
 * 加载成功后持续占用约 60% 单核 CPU、内存涨到 270MB，而音源「数量」本身无关；
 * 这类问题的特征是「加载成功、静默空转」，从既有日志里看不出任何异常。
 *
 * 因此这里提供三层防护：
 *   1. 静态特征扫描（加载前，零运行时开销）：识别反调试 / 空转 / 沙箱逃逸 / 混淆特征
 *   2. 运行期 CPU 采样（加载后）：空闲状态下持续高占用即视为异常
 *   3. 可疑复检归因：逐个卸载候选脚本，用 CPU 是否回落来确认真凶
 *
 * 分级判定以避免误伤：A 级（反调试/空转/逃逸）默认隔离；B 级（混淆等）只标记不隔离，
 * 因为市面上大量音源都用 jsjiami 混淆，混淆本身不等于恶意。
 *
 * 隔离语义：内存态跳过加载 + 在 DATA_PATH/source-guard.json 记录脚本指纹；
 * 不改写 sources.json、不删除文件，脚本内容一变（指纹不同）隔离自动解除。
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { syncLog } from '../utils/log4js'
import { getActiveHostActivities, registerStallHit } from './sourceActivity'

// ============================ 类型 ============================

export type GuardLevel = 'A' | 'B'
export type GuardMode = 'warn' | 'isolate'
export type IsolateSource = 'static' | 'probe'

export interface ScanFinding {
    level: GuardLevel
    code: string
}

export interface ScanResult {
    level: GuardLevel | null
    findings: ScanFinding[]
    hexIdentifiers: number
    maxLineLength: number
    size: number
}

export interface GuardFlag {
    id: string
    name: string
    owner: string
    level: GuardLevel
    reasons: string[]
    fingerprint: string
    at: string
}

export interface IsolateRecord extends GuardFlag {
    /** 隔离原因（静态特征码组合或复检测得的 CPU 占用） */
    reason: string
    source: IsolateSource
}

export interface SourceRef {
    owner: string
    id: string
    name: string
}

/** 复检所需的外部能力（由调用方注入，避免与 userApi 形成循环依赖） */
export interface GuardDeps {
    listLoaded: () => SourceRef[]
    unload: (owner: string, id: string) => void
    reload: (owner: string, id: string) => Promise<unknown>
    /**
     * 最近的慢定时器回调记录（卡顿归因第一信号）。
     * 音源定时器回调同步执行，耗时即事件循环停顿时长，与卡顿规模直接对应。
     */
    getRecentSlowTimers?: () => Array<{
        owner: string
        id: string
        name: string
        kind: string
        intervalMs: number
        costMs: number
        at: number
    }>
    /** 当前登记的沙箱定时器明细（卡顿归因佐证：长间隔定时器往往是周期性尖峰来源） */
    getTrackedTimers?: () => Array<{
        owner: string
        id: string
        name: string
        kind: string
        intervalMs: number
        registeredAt: number
        ageMs?: number
    }>
    /**
     * 卡顿窗口内「有活动」的音源（卡顿归因第二信号，行为级证据）。
     *
     * 慢回调只覆盖「回调本身同步执行很久」这一种情形；而「一批响应同时回来」
     * 与「脚本正在加载」这两类卡顿在回调视角上是分散的，必须靠宿主请求埋点与
     * 加载埋点才能看见。这是行为级信号，不依赖脚本内容，混淆脚本同样有效。
     */
    getRecentActivity?: (windowMs: number) => Array<{
        owner: string
        id: string
        name: string
        kinds: Array<'loading' | 'callback' | 'request' | 'inflight'>
        callbacks: number
        inflight: number
        loadCostMs: number
        agoMs: number
    }>
    /**
     * 服务当前是否「忙到不能被打扰」（例如正在往音箱下发音频）。
     *
     * 复检要卸载/重载自定义源脚本，重载会在主线程同步 eval 整个脚本（实测 2~3 秒），
     * 期间事件循环完全卡住——正在下发的音频会断流，音箱缓冲被抽干，
     * 听感就是「每隔几十秒突然静音一两秒」。所以有音频在放时必须让路。
     */
    isBusy?: () => boolean
}

export interface GuardStatus {
    enabled: boolean
    mode: GuardMode
    idleCpuPercent: number
    flagged: Array<{ id: string; name: string; level: GuardLevel; reasons: string[] }>
    isolated: Array<{ id: string; name: string; reason: string; level: GuardLevel; at: string; source: IsolateSource }>
    lastProbe: { at: string; candidates: number; confirmed: string[] } | null
    /** 单次采样尖峰计数：5~6 秒级的卡顿会被 15s 窗口均值稀释，这里单独捕捉 */
    cpuSpikes: { count: number; lastAt: string | null }
    /** 卡顿联动归因记录（最近 10 条）：事件循环监控发现 >3s 卡顿时自动归因到音源 */
    stallAttributions: Array<{ at: string; stallMs: number; suspects: string[]; action: string }>
    lastStallAttribution: { at: string; stallMs: number; suspects: string[]; action: string } | null
}

export interface GuardDecision {
    isolate: boolean
    reason: string
    flag: GuardFlag | null
    scan: ScanResult
}

interface GuardConfig {
    enabled: boolean
    mode: GuardMode
    thresholdPercent: number
    sampleIntervalMs: number
    windowMs: number
    probeEnabled: boolean
    probeWindowMs: number
    probeMaxScripts: number
    /** 卡顿归因：超过该值的卡顿才触发归因（毫秒） */
    stallMinMs: number
    /** 卡顿归因：慢定时器回调的时间窗（毫秒），窗外的记录不作为证据 */
    stallSuspectWindowMs: number
    /** 两条归因通道的去重窗口（毫秒） */
    attributionDedupMs: number
    /** 卡顿归因：隔离模式下同一音源连续被归因几次才动手 */
    stallIsolateStreak: number
    /** 卡顿归因：是否真正隔离（默认 false = 告警模式先行） */
    stallIsolateEnabled: boolean
}

// ============================ 配置 ============================

const envNum = (key: string, fallback: number): number => {
    const raw = process.env[key]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    // 显式 0 必须生效（用于「设为 0 即关闭某机制」的开关），
    // 只有非数字 / 负数才回落到默认值。
    return Number.isFinite(value) && value >= 0 ? value : fallback
}

const envBool = (key: string, fallback: boolean): boolean => {
    const raw = process.env[key]
    if (raw === undefined || raw === '') return fallback
    const str = String(raw).trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(str)) return true
    if (['false', '0', 'no', 'n', 'off'].includes(str)) return false
    return fallback
}

let configCache: GuardConfig | null = null

const cfg = (): GuardConfig => {
    if (!configCache) {
        configCache = {
            enabled: envBool('SOURCE_GUARD_ENABLED', true),
            mode: String(process.env.SOURCE_GUARD_MODE || 'isolate').trim().toLowerCase() === 'warn' ? 'warn' : 'isolate',
            // 阈值取 30%：留出余量，避免把「正在播放/下载」的正常负载判成空闲热点
            thresholdPercent: envNum('SOURCE_GUARD_CPU_THRESHOLD_PERCENT', 30),
            sampleIntervalMs: envNum('SOURCE_GUARD_SAMPLE_INTERVAL_MS', 2000),
            windowMs: envNum('SOURCE_GUARD_WINDOW_MS', 15000),
            probeEnabled: envBool('SOURCE_GUARD_PROBE_ENABLED', true),
            probeWindowMs: envNum('SOURCE_GUARD_PROBE_WINDOW_MS', 3000),
            probeMaxScripts: envNum('SOURCE_GUARD_PROBE_MAX_SCRIPTS', 6),
            // 卡顿联动归因：CPU 采样会被阻塞错过 5~7s 的爆发，事件循环延迟不会。
            // 默认只告警不隔离（warn 先行），连续归因同一源 N 次且显式开启开关才隔离。
            // 归因触发阈值。默认 2000ms（实测依据：NAS 上 4000ms 的真实阻塞被
            // 事件循环延迟监控低估成 2892ms，若设 3000 会漏掉；开发机同场景估值 3678ms）。
            // 2s 级的事件循环停顿本身就已经能让音频下发明可感知地断流，值得归因。
            stallMinMs: envNum('SOURCE_GUARD_STALL_MIN_MS', 2000),
            stallSuspectWindowMs: envNum('SOURCE_GUARD_STALL_SUSPECT_WINDOW_MS', 15000),
            attributionDedupMs: envNum('SOURCE_GUARD_ATTRIBUTION_DEDUP_MS', 2000),
            stallIsolateStreak: envNum('SOURCE_GUARD_STALL_ISOLATE_STREAK', 3),
            stallIsolateEnabled: envBool('SOURCE_GUARD_STALL_ISOLATE_ENABLED', false),
        }
    }
    return configCache
}

/** 仅供测试：清空配置缓存以便重新读取环境变量 */
export function resetGuardConfig(): void {
    configCache = null
}

// ============================ 静态特征扫描 ============================

const MIN_SCAN_SIZE = 128
const HEX_COUNT_LIMIT = 2000
const MAX_LINE_LENGTH_LIMIT = 5000

/**
 * 统计混淆标识符数量（形如 _0x1a2b）。
 *
 * 刻意不用 `script.match(/_0x.../g)` 收集数组：在 1.8MB 量级的高度混淆脚本上，
 * 单次匹配会产生数万个字符串对象，叠加「几十个音源并发加载」的场景会显著抬高峰值内存
 * （实测曾触发 V8 `RegExpCompiler Allocation failed` 导致进程崩溃）。
 * 这里改为 indexOf 逐点定位 + 小窗口校验，并设上限提前退出。
 */
const countHexIdentifiers = (script: string, limit = HEX_COUNT_LIMIT): number => {
    let count = 0
    let from = 0
    while (count < limit) {
        const idx = script.indexOf('_0x', from)
        if (idx === -1) break
        if (/^[0-9a-f]{4}/i.test(script.slice(idx + 3, idx + 40))) count++
        from = idx + 3
    }
    return count
}

/**
 * 统计高频轮询定时器（间隔 ≤ 16ms）的数量。
 * 同样避免让正则在整份大脚本上做回溯：先用 indexOf 定位，再只对 400 字符小窗口套正则。
 */
const countBusyPollingTimers = (script: string, limit = 2): number => {
    const pattern = /^setInterval\s*\([^;]{1,300}?,\s*(?:0|[1-9]|1[0-5])\s*[,)]/
    let count = 0
    let from = 0
    while (count < limit) {
        const idx = script.indexOf('setInterval', from)
        if (idx === -1) break
        if (pattern.test(script.slice(idx, idx + 400))) count++
        from = idx + 11
    }
    return count
}

/** 最长行长度：逐字符扫描（不用 split 产生数组），一旦超过阈值立即返回 */
const maxLineLengthOf = (script: string, stopAt = MAX_LINE_LENGTH_LIMIT): number => {
    let max = 0
    let lineStart = 0
    for (let i = 0; i < script.length; i++) {
        if (script.charCodeAt(i) === 10) {
            const len = i - lineStart
            if (len > max) max = len
            if (max > stopAt) return max
            lineStart = i + 1
        }
    }
    const tail = script.length - lineStart
    return tail > max ? tail : max
}

/**
 * 对脚本源码做静态体检。
 *
 * 只看「结构特征」而非具体业务代码，因此对正常音源几乎零误报；
 * 混淆类特征（B 级）刻意不参与隔离决策。
 */
export function scanScript(script: string): ScanResult {
    const findings: ScanFinding[] = []
    const size = typeof script === 'string' ? Buffer.byteLength(script, 'utf-8') : 0
    const add = (level: GuardLevel, code: string) => {
        if (!findings.some(item => item.code === code)) findings.push({ level, code })
    }

    if (typeof script !== 'string' || size < MIN_SCAN_SIZE) {
        return { level: null, findings, hexIdentifiers: 0, maxLineLength: 0, size }
    }

    // ---------- A 级：反调试 / 空转 / 逃逸 ----------
    // 1. 真死循环：**空循环体**的 while(!![]){} / while(true){}。
    //    注意：非空体的 while(!![]) 是 jsjiami 混淆模板里常见的「字符串解密自检」循环
    //    （形如 while(!![]){try{...;break}catch(e){}}，体内有 break），实测 46 个真实音源中有
    //    10 个使用该写法且完全正常，因此绝不能判为高危，只做标记。
    if (/while\s*\(\s*!!\[\]\s*\)\s*\{\s*\}/.test(script) || /while\s*\(\s*(?:!0|1|true)\s*\)\s*\{\s*\}/.test(script)) {
        add('A', 'infinite_loop')
    } else if (/while\s*\(\s*!!\[\]\s*\)/.test(script)) {
        add('B', 'while_true_loop')
    }
    // 2. debugger 陷阱：反调试语句被塞进循环或定时器回调里
    if (/(?:while|for)\s*\([^)]*\)\s*\{[^}]{0,200}?debugger/.test(script) ||
        /(?:setInterval|setTimeout|setImmediate)\s*\(\s*(?:function\s*\([^)]*\)\s*\{|\s*\(\s*\)\s*=>\s*\{)[^}]{0,200}?debugger/.test(script)) {
        add('A', 'debugger_trap')
    }
    // 3. 沙箱逃逸：用构造器拿回宿主全局
    if (/(?:Function|constructor)\s*\(\s*['"]return\s+(?:this|global|process|globalThis)['"]/.test(script)) {
        add('A', 'sandbox_escape')
    }
    // 4. 忙轮询：高频定时器（间隔 ≤ 16ms）出现多次，典型的时间片自旋
    if (countBusyPollingTimers(script) >= 2) add('A', 'busy_polling')

    // ---------- B 级：混淆与可疑行为（只标记，不隔离）----------
    if (/jsjiami\.com|sojson\.com|obfuscator\.io|javascript-obfuscator/i.test(script)) add('B', 'obfuscated')
    const hexIdentifiers = countHexIdentifiers(script)
    if (hexIdentifiers >= 300) add('B', `hex_identifiers:${hexIdentifiers}${hexIdentifiers >= HEX_COUNT_LIMIT ? '+' : ''}`)
    if (/(?:var|let|const)\s+_0x[0-9a-f]{4,}\s*=\s*\[/.test(script)) add('B', 'string_array')
    if (/(?:^|[^.\w])eval\s*\(/.test(script)) add('B', 'dynamic_eval')
    if (/process\s*\.\s*exit\s*\(/.test(script)) add('B', 'host_access')

    const maxLineLength = maxLineLengthOf(script)
    if (maxLineLength > MAX_LINE_LENGTH_LIMIT) add('B', 'long_line')
    if (findings.length === 0 && script.includes('debugger')) add('B', 'debugger_statement')

    const level: GuardLevel | null = findings.some(item => item.level === 'A')
        ? 'A'
        : findings.length > 0 ? 'B' : null
    return { level, findings, hexIdentifiers, maxLineLength, size }
}

/** 脚本内容指纹：用于「脚本一更新即自动解除隔离」 */
export const fingerprintOf = (script: string): string =>
    crypto.createHash('sha256').update(String(script || ''), 'utf-8').digest('hex').slice(0, 16)

// ============================ 隔离记录持久化 ============================

interface GuardStore {
    version: number
    isolated: IsolateRecord[]
}

const storeFilePath = (): string =>
    path.join(process.env.DATA_PATH || path.join(process.cwd(), 'data'), 'source-guard.json')

let storeCache: GuardStore | null = null

const loadStore = (): GuardStore => {
    if (storeCache) return storeCache
    try {
        const parsed = JSON.parse(fs.readFileSync(storeFilePath(), 'utf-8'))
        storeCache = { version: 1, isolated: Array.isArray(parsed?.isolated) ? parsed.isolated : [] }
    } catch (e) {
        storeCache = { version: 1, isolated: [] }
    }
    return storeCache
}

const saveStore = (): void => {
    if (!storeCache) return
    try {
        const file = storeFilePath()
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(storeCache, null, 2), 'utf-8')
    } catch (e: any) {
        console.warn(`[自检护栏] 隔离记录写入失败: ${e?.message || e}`)
    }
}

const recordKey = (owner: string, id: string) => `${owner}_${id}`

/**
 * 判断该脚本是否已被隔离。
 * 脚本指纹与记录不一致（内容被更新过）时自动解除隔离并落盘。
 */
export function shouldSkipSource(owner: string, id: string, fingerprint: string): IsolateRecord | null {
    if (!cfg().enabled || cfg().mode !== 'isolate') return null
    const store = loadStore()
    const key = recordKey(owner, id)
    const hit = store.isolated.find(item => recordKey(item.owner, item.id) === key)
    if (!hit) return null
    // fingerprint 为空表示记录时未读到脚本内容，此时不做自动解除
    if (hit.fingerprint && hit.fingerprint !== fingerprint) {
        store.isolated = store.isolated.filter(item => item !== hit)
        saveStore()
        console.log(`[自检护栏] 脚本内容已更新，自动解除隔离: ${hit.name} (${hit.id})`)
        return null
    }
    return hit
}

export function recordIsolation(
    ref: SourceRef,
    fingerprint: string,
    level: GuardLevel,
    reason: string,
    source: IsolateSource
): IsolateRecord {
    const store = loadStore()
    const key = recordKey(ref.owner, ref.id)
    store.isolated = store.isolated.filter(item => recordKey(item.owner, item.id) !== key)
    const record: IsolateRecord = {
        owner: ref.owner,
        id: ref.id,
        name: ref.name,
        fingerprint,
        level,
        reason,
        reasons: reason ? reason.split('+') : [],
        source,
        at: new Date().toISOString(),
    }
    store.isolated.push(record)
    saveStore()
    return record
}

/** 手动解除某条隔离记录（脚本内容不变但用户确认安全时使用） */
export function clearIsolation(owner: string, id: string): boolean {
    const store = loadStore()
    const key = recordKey(owner, id)
    const before = store.isolated.length
    store.isolated = store.isolated.filter(item => recordKey(item.owner, item.id) !== key)
    activeIsolations.delete(key)
    if (store.isolated.length !== before) {
        saveStore()
        return true
    }
    return false
}

// ============================ 运行时状态 ============================

/** 本次加载实际被隔离的脚本（用于 /health 展示当前生效的隔离） */
const activeIsolations = new Map<string, IsolateRecord>()
/** 静态扫描命中但未隔离的脚本（B 级为主） */
const flagged = new Map<string, GuardFlag>()

let idleCpuPercent = 0
let lastProbe: { at: string; candidates: number; confirmed: string[] } | null = null
/** 单次采样尖峰：窗口均值会稀释几秒级的卡顿，单独计数便于与 [GC]/慢定时器日志互相印证 */
let cpuSpikeCount = 0
let lastCpuSpikeAt: string | null = null
/**
 * 单次采样达到该百分比即记一次尖峰。
 *
 * 取 50% 而非 70%：卡顿期间采样定时器被推迟，恢复后首个样本理论值很高，
 * 但非纯 CPU 阻塞（混有 I/O 等待、GC）时会落到 50~70% 区间——
 * 阈值定 70% 会把这类爆发整批漏掉（246 的豆包定制循环即如此）。
 * 该计数只用于日志归因，不触发任何隔离，误报成本低。
 */
const SPIKE_SAMPLE_PERCENT = 50
/** 复检冷却截止时间：避免在告警模式（不隔离，异常持续存在）下反复复检、反复重载音源 */
let probeCooldownUntil = 0
const PROBE_COOLDOWN_MS = 10 * 60 * 1000

// ============================ 对外主入口 ============================

/**
 * 加载前体检：返回是否应跳过加载。
 * 由 userApi 在读到脚本内容后、真正解析脚本前调用。
 */
export function reviewSourceScript(ref: SourceRef, script: string): GuardDecision {
    const fingerprint = fingerprintOf(script)
    const scan = scanScript(script)
    const reasons = scan.findings.map(item => item.code)
    const key = recordKey(ref.owner, ref.id)

    // 1. 历史隔离记录（脚本未变化）优先
    const existing = shouldSkipSource(ref.owner, ref.id, fingerprint)
    if (existing) {
        activeIsolations.set(key, existing)
        return { isolate: true, reason: existing.reason, flag: null, scan }
    }
    // 走到这里说明本轮不再隔离（护栏关闭 / 记录已解除 / 脚本内容已更新三种情况），
    // 同步清掉运行时快照，避免 /health 继续展示已经不生效的隔离
    activeIsolations.delete(key)

    if (!cfg().enabled) return { isolate: false, reason: '', flag: null, scan }

    const flag: GuardFlag | null = scan.level
        ? {
            id: ref.id,
            name: ref.name,
            owner: ref.owner,
            level: scan.level,
            reasons,
            fingerprint,
            at: new Date().toISOString(),
        }
        : null

    // 2. A 级 + 隔离模式 → 记录并跳过加载
    if (scan.level === 'A' && cfg().mode === 'isolate') {
        const reason = reasons.join('+')
        const record = recordIsolation(ref, fingerprint, 'A', reason, 'static')
        activeIsolations.set(key, record)
        flagged.delete(key)
        return { isolate: true, reason, flag, scan }
    }

    // 3. 其余情况正常加载，仅登记标记
    if (flag) flagged.set(key, flag)
    else flagged.delete(key)
    return { isolate: false, reason: '', flag, scan }
}

/** 开始一轮全量加载：清空上一轮的标记，加载过程中会重新登记 */
export function beginSourceReload(): void {
    flagged.clear()
    activeIsolations.clear()
    markSourceBusy()
}

/**
 * 标记「正在做音源相关工作」，避免把加载/重载的正常 CPU 负载误判为空闲热点。
 */
export function markSourceBusy(ms = 8000): void {
    busyUntil = Math.max(busyUntil, Date.now() + ms)
}

/** 供 /health 与诊断日志使用 */
export function getSourceGuardStatus(): GuardStatus {
    const current = cfg()
    return {
        enabled: current.enabled,
        mode: current.mode,
        idleCpuPercent: Number(idleCpuPercent.toFixed(2)),
        flagged: Array.from(flagged.values()).map(item => ({
            id: item.id,
            name: item.name,
            level: item.level,
            reasons: item.reasons,
        })),
        isolated: Array.from(activeIsolations.values()).map(item => ({
            id: item.id,
            name: item.name,
            reason: item.reason,
            level: item.level,
            at: item.at,
            source: item.source,
        })),
        lastProbe,
        cpuSpikes: { count: cpuSpikeCount, lastAt: lastCpuSpikeAt },
        stallAttributions: getStallAttributions(),
        lastStallAttribution: stallAttributionLog.length > 0 ? summarizeAttribution(stallAttributionLog[stallAttributionLog.length - 1]) : null,
    }
}

// ============================ 运行期 CPU 采样 ============================

let lastCpu = process.cpuUsage()
let lastCpuAt = Date.now()
let busyUntil = 0
let probing = false
let highStreak = 0
let sampler: NodeJS.Timeout | null = null
let guardDeps: GuardDeps | null = null
const samples: number[] = []

/** 采一次瞬时 CPU（单核百分比） */
const sampleOnce = (): number => {
    const now = Date.now()
    const usage = process.cpuUsage()
    const deltaUs = (usage.user - lastCpu.user) + (usage.system - lastCpu.system)
    const elapsedUs = Math.max(1, (now - lastCpuAt) * 1000)
    lastCpu = usage
    lastCpuAt = now
    return Math.max(0, (deltaUs / elapsedUs) * 100)
}

/** 在给定时长内测量平均 CPU（单核百分比） */
const sampleCpuOver = async (ms: number): Promise<number> => {
    const startCpu = process.cpuUsage()
    const startAt = Date.now()
    await sleep(ms)
    const endCpu = process.cpuUsage()
    const endAt = Date.now()
    const deltaUs = (endCpu.user - startCpu.user) + (endCpu.system - startCpu.system)
    const elapsedUs = Math.max(1, (endAt - startAt) * 1000)
    return Math.max(0, (deltaUs / elapsedUs) * 100)
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const windowAvg = (): number =>
    samples.length === 0 ? 0 : samples.reduce((sum, value) => sum + value, 0) / samples.length

const scheduleSampler = (): void => {
    if (sampler || probing || !cfg().enabled) return
    lastCpu = process.cpuUsage()
    lastCpuAt = Date.now()
    sampler = setInterval(tick, cfg().sampleIntervalMs)
    if (typeof sampler.unref === 'function') sampler.unref()
}

const tick = (): void => {
    const current = cfg()
    if (!current.enabled) return

    const value = sampleOnce()
    idleCpuPercent = value

    // 短尖峰单独记录：5~6 秒的卡顿摊进 15s 窗口均值会被稀释到阈值以下，
    // 单次采样却能到 70%+。这里抓「单次就很高」的情况，归因看同刻的
    // [GC] 大额暂停与 [自定义源-*] 定时器耗时日志，三者时间重合即锁定真凶。
    if (value >= SPIKE_SAMPLE_PERCENT && !probing && Date.now() >= busyUntil) {
        cpuSpikeCount++
        lastCpuSpikeAt = new Date().toISOString()
        const msg = `[自检护栏] CPU 尖峰：单次采样 ${value.toFixed(0)}%（该时刻事件循环应处于卡顿状态）。` +
            '短尖峰会被窗口均值稀释故单独记录，归因请对照同刻的 [GC] 与 [自定义源-*] 定时器耗时日志'
        console.warn(msg)
        syncLog.warn(msg)
    }

    const capacity = Math.max(2, Math.round(current.windowMs / current.sampleIntervalMs))
    samples.push(value)
    while (samples.length > capacity) samples.shift()

    if (probing) return
    // 窗口填满前不判定，避免启动阶段（大量加载动作）误报
    if (samples.length < capacity) return
    // 正在加载/重载/下载：属于正常工作负载
    if (Date.now() < busyUntil) {
        highStreak = 0
        return
    }
    // 复检冷却期内不重复触发
    if (Date.now() < probeCooldownUntil) {
        highStreak = 0
        return
    }
    // 正在往音箱下发音频：这时绝对不能卸载/重载音源（会卡住事件循环、断掉音频流）
    if (guardDeps?.isBusy?.()) {
        highStreak = 0
        return
    }

    const avg = windowAvg()
    if (avg < current.thresholdPercent) {
        highStreak = 0
        return
    }

    highStreak++
    // 连续两个窗口都超标才认定异常（约 30s 持续高占用），排除偶发抖动
    if (highStreak < 2) return
    highStreak = 0

    console.warn(`[自检护栏] 检测到空闲 CPU 异常: ${Math.round(current.windowMs / 1000)}s 窗口均值 ${avg.toFixed(1)}%（阈值 ${current.thresholdPercent}%），正在排查来源`)
    if (current.probeEnabled && guardDeps) void runProbe(guardDeps, avg)
}

// ============================ 复检归因 ============================

/** 读取脚本原文，用于给复检确认的脚本留下指纹 */
const readSourceScript = (ref: SourceRef): string => {
    try {
        const dataPath = process.env.DATA_PATH || path.join(process.cwd(), 'data')
        const dirName = ref.owner === 'open' ? '_open' : ref.owner
        return fs.readFileSync(path.join(dataPath, 'users', 'source', dirName, ref.id), 'utf-8')
    } catch (e) {
        return ''
    }
}

/** 候选优先级：A 级最高，其次按混淆标识符数量排序 */
const candidateWeight = (ref: SourceRef): number => {
    const flag = flagged.get(recordKey(ref.owner, ref.id))
    if (!flag) return 0
    const hex = flag.reasons.find(reason => reason.startsWith('hex_identifiers:'))
    const hexCount = hex ? Number(hex.split(':')[1]) || 0 : 0
    return (flag.level === 'A' ? 1_000_000 : 0) + hexCount
}

/**
 * 逐个卸载候选脚本，观察 CPU 是否回落来确认「是谁在空转」。
 * 代价是每个候选一个 3s 窗口；未确认的会立即恢复加载，不影响其他音源。
 */
const runProbe = async (deps: GuardDeps, baseline: number): Promise<void> => {
    const current = cfg()
    // 复检会卸载/重载自定义源脚本，重载要在主线程同步 eval 整个脚本（实测 2~3 秒）。
    // 正在往音箱下发音频时绝不能做：事件循环一卡，正在下发的音频就断流。
    if (deps.isBusy?.()) {
        console.log('[自检护栏] 正在播放音频，跳过本轮复检（避免重载音源打断播放）')
        highStreak = 0
        return
    }
    probing = true
    // 复检期间暂停常规采样，避免两套测量互相污染
    if (sampler) {
        clearInterval(sampler)
        sampler = null
    }

    const confirmed: string[] = []
    let candidates: SourceRef[] = []

    try {
        candidates = deps.listLoaded()
            .filter(ref => !activeIsolations.has(recordKey(ref.owner, ref.id)))
            .map(ref => ({ ref, weight: candidateWeight(ref) }))
            .sort((a, b) => b.weight - a.weight)
            .slice(0, current.probeMaxScripts)
            .map(item => item.ref)

        if (candidates.length === 0) {
            console.warn('[自检护栏] 空闲 CPU 异常，但当前没有可复检的自定义音源（负载可能来自宿主自身或同步任务）')
            return
        }

        console.log(`[自检护栏] 开始复检 ${candidates.length} 个候选音源（基线 ${baseline.toFixed(1)}%，单候选 ${Math.round(current.probeWindowMs / 1000)}s）`)

        for (const ref of candidates) {
            // 只卸载这一个，其余音源不受影响
            deps.unload(ref.owner, ref.id)
            // 先给残留自旋一点退出时间，再测一个干净的窗口
            await sleep(current.probeWindowMs)
            const after = await sampleCpuOver(current.probeWindowMs)
            const drop = baseline - after

            if (drop < Math.max(10, baseline * 0.4)) {
                console.log(`[自检护栏] 复检排除: ${ref.name}，卸载后 CPU ${after.toFixed(1)}%（下降不明显），已恢复加载`)
                await deps.reload(ref.owner, ref.id)
                continue
            }

            // 命中：卸载后 CPU 明显回落
            confirmed.push(ref.name)
            if (current.mode === 'isolate') {
                const script = readSourceScript(ref)
                const reason = `cpu_probe:${after.toFixed(1)}%`
                const record = recordIsolation(ref, script ? fingerprintOf(script) : '', 'A', reason, 'probe')
                activeIsolations.set(recordKey(ref.owner, ref.id), record)
                console.warn(`[自检护栏] ✓ 复检确认热点并已隔离: ${ref.name} (${ref.id})，卸载后 CPU ${after.toFixed(1)}%（基线 ${baseline.toFixed(1)}%）`)
            } else {
                await deps.reload(ref.owner, ref.id)
                console.warn(`[自检护栏] ⚠ 复检确认热点（告警模式，未隔离，建议在音源管理中手动禁用）: ${ref.name} (${ref.id})，卸载后 CPU ${after.toFixed(1)}%（基线 ${baseline.toFixed(1)}%）`)
            }

            // 关键：真凶一被卸载，最初测得的 baseline 就失效了，
            // 继续复检后面的候选只会因为「CPU 本来就是 0」而被逐个误判成命中。
            // 因此定位到一个就收工；若仍有其他热点，下一轮采样会重新触发。
            console.warn('[自检护栏] 本轮已定位到热点，停止继续复检')
            break
        }
    } catch (e: any) {
        console.warn(`[自检护栏] 复检过程异常: ${e?.message || e}`)
    } finally {
        if (confirmed.length > 0) {
            console.warn(`[自检护栏] 复检完成，确认热点 ${confirmed.length} 个: ${confirmed.join(', ')}`)
        } else {
            console.log('[自检护栏] 复检完成，未定位到具体脚本（异常可能来自宿主自身负载或网络等待）')
        }
        lastProbe = { at: new Date().toISOString(), candidates: candidates.length, confirmed }
        probing = false
        // 设置冷却期：本轮刚动过音源，让 CPU 曲线稳定下来再判断
        probeCooldownUntil = Date.now() + PROBE_COOLDOWN_MS
        samples.length = 0
        highStreak = 0
        lastCpu = process.cpuUsage()
        lastCpuAt = Date.now()
        scheduleSampler()
    }
}

// ============================ 卡顿联动归因 ============================

/**
 * 事件循环监控发现 >3s 卡顿时调用，直接把嫌疑锁定到音源。
 *
 * 为什么不做纯 CPU 归因：卡顿是同步阻塞，阻塞期间采样定时器本身也被推迟，
 * 5~7 秒的爆发经常一次都采不到；而「哪个音源的定时器回调刚跑完、耗时多少」
 * 是同步事实，与卡顿时长严格对应。本案（豆包定制 600s 自排探测循环）正是
 * 窗口均值 + 连续窗口 + 采样错过三重原因下完全隐形的典型。
 *
 * 信号优先级：
 *   1. 慢定时器回调（硬证据）：回调同步执行，耗时 ≈ 事件循环停顿时长；
 *      要求 costMs >= 卡顿时长的一半，且发生在卡顿前 N 秒内。
 *   2. 活动长定时器（佐证）：>=60s 间隔的定时器是周期性尖峰的常见来源，
 *      在没有硬证据命中时作为候选列出。
 *
 * 默认 warn 模式：只记录与告警，不动任何音源（避免误伤正常源）。
 * SOURCE_GUARD_STALL_ISOLATE_ENABLED=true 后，同一源连续被归因
 * STALL_ISOLATE_STREAK 次才隔离；播放音频时一律推迟。
 */

export interface StallSuspect {
    owner: string
    id: string
    name: string
    evidence: string
}

export interface StallAttribution {
    at: string
    stallMs: number
    suspects: StallSuspect[]
    action: 'none' | 'warn' | 'isolated' | 'deferred'
    /** 本次归因触发的自动降速动作（请求并发闸门），没有则为 undefined */
    throttle?: string
    /**
     * 卡顿时刻宿主正在进行的批量动作（如音源巡检）。
     * 巡检会同时驱动几十个脚本发请求，这时的卡顿真凶是宿主自己，
     * 列出的嫌疑人只是「恰好有响应回来」，据此禁用音源会误伤。
     */
    hostActivity?: string[]
}

const stallAttributionLog: StallAttribution[] = []
const MAX_STALL_ATTRIBUTION_LOG = 10
/**
 * 隔离模式下的连续归因计数：同一源连续 N 次被归因才隔离。
 * 与 warn 模式的观察计数相互独立——warn 跑一段时间后再切 isolate，
 * 隔离模式应重新开始自己的观察期，而不是继承旧计数立即动手。
 */
const stallStreak = new Map<string, number>()
/** warn 模式的观察计数（只写日志，不触发任何动作） */
const warnStreak = new Map<string, number>()

/** 归因记录只保留 suspects 的简要描述，避免 /health  payload 过大 */
const summarizeAttribution = (a: StallAttribution) => ({
    at: a.at,
    stallMs: a.stallMs,
    suspects: a.suspects.map(s => `${s.name}（${s.evidence}）`),
    action: a.action,
    throttle: a.throttle,
    hostActivity: a.hostActivity,
})

export function getStallAttributions(): Array<ReturnType<typeof summarizeAttribution>> {
    return stallAttributionLog.map(summarizeAttribution)
}

/** 长定时器判定阈值：>=60s 的间隔才纳入佐证候选 */
const LONG_TIMER_INTERVAL_MS = 60 * 1000

/**
 * 同一卡顿事件可能同时被「延迟监控」与「慢回调直报」两条通道命中，
 * 去重窗口内只记一次——否则隔离模式的连续计数会被同一事件重复累加，提前动手。
 * 自动化测试需要连续触发多个场景，可用 SOURCE_GUARD_ATTRIBUTION_DEDUP_MS=0 关闭。
 */
let lastAttributionAt = 0
let lastAttributionRecord: StallAttribution | null = null

export function attributeStall(stallMs: number): StallAttribution | null {
    const current = cfg()
    if (!current.enabled) return null
    if (stallMs < current.stallMinMs) return null

    const now = Date.now()

    // 两条归因通道会在同一次阻塞上先后到达（先回调直报、后延迟监控察觉），
    // 不去重的话隔离模式的连续计数会被同一事件重复累加，进而提前触发隔离。
    if (lastAttributionRecord && now - lastAttributionAt < current.attributionDedupMs) {
        return lastAttributionRecord
    }
    lastAttributionAt = now

    const suspects: StallSuspect[] = []
    const seen = new Set<string>()

    // ---- 信号一：慢定时器回调（硬证据）----
    const slowTimers = guardDeps?.getRecentSlowTimers?.() || []
    for (const rec of slowTimers) {
        if (now - rec.at > current.stallSuspectWindowMs) continue
        // 回调耗时对不上卡顿规模（小于卡顿时长一半）→ 不是这次卡顿的主因
        if (rec.costMs < stallMs * 0.5) continue
        const key = `${rec.owner}_${rec.id}`
        if (seen.has(key)) continue
        seen.add(key)
        const ago = Math.max(0, Math.round((now - rec.at) / 1000))
        const interval = rec.intervalMs > 0 ? `${Math.round(rec.intervalMs / 1000)}s` : '未知'
        suspects.push({
            owner: rec.owner,
            id: rec.id,
            name: rec.name,
            evidence: `定时器回调耗时 ${rec.costMs}ms（间隔 ${interval}，${ago}s 前完成）`,
        })
    }

    // ---- 信号二：活动账本（行为证据）----
    // 卡顿窗口内谁在加载、谁的响应刚回来，就是最直接的行为线索：
    //   - 脚本加载 = 主线程同步 eval，实测 61KB 脚本要 6 秒；
    //   - 响应回来 = 沙箱边界 decontextify + JSON.parse 的同步开销，
    //     一批响应同时回来时这些开销会叠成数秒阻塞。
    if (suspects.length === 0) {
        const active = guardDeps?.getRecentActivity?.(current.stallSuspectWindowMs) || []
        for (const a of active) {
            // 仅「正在加载」与「刚有响应回来」算证据；单纯有在途请求可能是常规播放
            if (!a.kinds.includes('loading') && !a.kinds.includes('callback')) continue
            const key = `${a.owner}_${a.id}`
            if (seen.has(key)) continue
            seen.add(key)
            const ago = (Math.round(a.agoMs / 100) / 10).toFixed(1)
            suspects.push({
                owner: a.owner,
                id: a.id,
                name: a.name,
                evidence: a.kinds.includes('loading')
                    ? `脚本加载中（最近一次加载耗时 ${a.loadCostMs}ms，同步 eval 会独占事件循环）`
                    : `${ago}s 前有响应回来（并发回来时沙箱边界的同步序列化开销会叠加）`,
            })
            if (suspects.length >= 3) break
        }
    }

    // ---- 信号三：活动长定时器（弱佐证，仅在前两类都没命中时列出）----
    if (suspects.length === 0) {
        const tracked = guardDeps?.getTrackedTimers?.() || []
        for (const t of tracked) {
            if (t.intervalMs < LONG_TIMER_INTERVAL_MS) continue
            const key = `${t.owner}_${t.id}`
            if (seen.has(key)) continue
            seen.add(key)
            suspects.push({
                owner: t.owner,
                id: t.id,
                name: t.name,
                evidence: `活动长定时器 ${Math.round(t.intervalMs / 1000)}s（已存活 ${Math.round((t.ageMs || 0) / 1000)}s）`,
            })
        }
    }

    const attribution: StallAttribution = {
        at: new Date(now).toISOString(),
        stallMs,
        suspects,
        action: 'none',
    }
    lastAttributionRecord = attribution

    if (suspects.length === 0) {
        console.warn(`[自检护栏][归因] 主线程卡顿 ${stallMs}ms，未定位到音源定时器（可能来自宿主负载、GC 或同步任务）`)
        pushAttribution(attribution)
        return attribution
    }

    const primary = suspects[0]
    const names = suspects.map(s => `${s.name}（${s.evidence}）`).join('; ')
    console.warn(`[自检护栏][归因] 主线程卡顿 ${stallMs}ms → 疑似音源: ${names}`)

    // 宿主正在跑批量动作（典型是音源巡检）时，卡顿真凶很可能是宿主自己，
    // 列出的嫌疑人只是「恰好有响应回来」。标出来，避免据此禁用无辜的音源。
    const hostActive = getActiveHostActivities()
    if (hostActive.length > 0) {
        attribution.hostActivity = hostActive.map(h => `${h.kind}（已进行 ${Math.round(h.elapsedMs / 1000)}s）`)
        console.warn(`[自检护栏][归因] ⓘ 卡顿期间宿主活动: ${attribution.hostActivity.join('、')}` +
            ' —— 若巡检正在跑，本条嫌疑人仅供参考，勿据此禁用音源')
    }

    // L2 自动降速：被归因命中就累计，连续命中达到阈值后压低该脚本的请求并发。
    // 这是纯运行时治理——不动脚本一个字，混淆脚本一样有效，也不需要预先识别脚本内容。
    const throttleNote = registerStallHit(primary.owner, primary.id, primary.name)
    if (throttleNote) {
        attribution.throttle = throttleNote
        console.warn(`[自检护栏][降速] ${primary.name} ${throttleNote}`)
    }

    if (!current.stallIsolateEnabled) {
        // 告警模式：只标记，不动音源。观察计数仅用于日志，与隔离模式的计数独立。
        attribution.action = 'warn'
        const key = `${primary.owner}_${primary.id}`
        const streak = (warnStreak.get(key) || 0) + 1
        warnStreak.set(key, streak)
        console.warn(`[自检护栏][归因] ⚠ 告警模式（未隔离）：${primary.name} 第 ${streak} 次被归因，建议在音源管理中手动禁用或联系作者`)
        pushAttribution(attribution)
        return attribution
    }

    // 隔离模式：播放中一律推迟（卸载/重载会断音频流）
    if (guardDeps?.isBusy?.()) {
        attribution.action = 'deferred'
        console.warn('[自检护栏][归因] 正在播放音频，推迟隔离处置（下次卡顿再评估）')
        pushAttribution(attribution)
        return attribution
    }

    const key = `${primary.owner}_${primary.id}`
    const streak = (stallStreak.get(key) || 0) + 1
    stallStreak.set(key, streak)

    if (streak < current.stallIsolateStreak) {
        attribution.action = 'warn'
        console.warn(`[自检护栏][归因] ⚠ 隔离模式观察期：${primary.name} 第 ${streak}/${current.stallIsolateStreak} 次被归因，达上限才隔离`)
        pushAttribution(attribution)
        return attribution
    }

    // 连续多次归因同一源 → 隔离（脚本内容更新后自动解除，与静态隔离同机制）
    const script = readSourceScript(primary)
    const reason = `stall:${stallMs}ms`
    const record = recordIsolation(primary, script ? fingerprintOf(script) : '', 'A', reason, 'probe')
    activeIsolations.set(key, record)
    guardDeps?.unload(primary.owner, primary.id)
    stallStreak.delete(key)
    warnStreak.delete(key)
    attribution.action = 'isolated'
    console.warn(`[自检护栏][归因] ✓ 连续 ${streak} 次归因同一音源，已隔离: ${primary.name} (${primary.id})，脚本更新后自动解除`)
    pushAttribution(attribution)
    return attribution
}

const pushAttribution = (a: StallAttribution): void => {
    stallAttributionLog.push(a)
    while (stallAttributionLog.length > MAX_STALL_ATTRIBUTION_LOG) stallAttributionLog.shift()
}

// ============================ 生命周期 ============================

export function startSourceGuard(deps: GuardDeps): void {
    guardDeps = deps
    const current = cfg()
    if (!current.enabled) {
        console.log('[自检护栏] 已禁用（SOURCE_GUARD_ENABLED=false）')
        return
    }
    const isolatedCount = loadStore().isolated.length
    console.log(`[自检护栏] 已启用：模式=${current.mode}，空闲 CPU 阈值=${current.thresholdPercent}%，采样 ${current.sampleIntervalMs}ms × ${Math.max(2, Math.round(current.windowMs / current.sampleIntervalMs))} 次`)
    if (isolatedCount > 0) {
        console.log(`[自检护栏] 载入 ${isolatedCount} 条隔离记录（脚本内容更新后会自动解除）`)
    }
    scheduleSampler()
}

export function stopSourceGuard(): void {
    if (sampler) {
        clearInterval(sampler)
        sampler = null
    }
}
