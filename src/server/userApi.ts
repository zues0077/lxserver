import { VM } from 'vm2'
import * as fs from 'fs'
import * as path from 'path'
import {
    beginSourceReload,
    markSourceBusy,
    reviewSourceScript,
    describeIsolationReason,
    isolateSlowSource,
} from './sourceGuard'
import { isProbeQuiet, recordSuppressed } from './probeQuiet'
import { isHardFailure, reportManualFailure, isPlatformDemoted } from './sourceProbe'
import { getGovernorConfig, isThrottled as isGovernorThrottled, noteSyncBlock, runWithGovernor, listWorkerPresetCandidates } from './sourceGovernor'
import { tryWorkerCall, disposeSourceWorker, shouldRouteToWorker, markWorkerEligible } from './sourceWorkerHost'
import { inspectSourceContract, summarizeContract, unwrapMusicUrlValue, normalizeQualityList } from './sourceContract'
import type { ContractReport } from './sourceContract'
import { applyQualityLedger, clearQualityLedger, noteQualityResult } from './sourceQualityLedger'
import { notePlayResult, rankCandidatesByHistory, adaptiveTimeoutMs, buildPlayRankPriors, planProbeCandidate, noteProbeSuccessReset, PROBE_BUDGET_MS } from './sourcePlayRank'
import { markLedgerDirty } from './sourceLedgerDirty'
import { clearRateLimit, clearRateLimitForSource, isRateLimitFailure, isRateLimited, noteRateLimit } from './sourceRateLimit'
import { syncLog } from '../utils/log4js'

/**
 * 自定义源单次请求的硬上限（毫秒）。
 * 音源脚本自己传的 timeout 也不能超过这个帽：挂死的源会把整条换源队列堵住。
 */
const CUSTOM_SOURCE_REQUEST_MAX_MS = (() => {
    const raw = Number(process.env.CUSTOM_SOURCE_REQUEST_MAX_MS)
    return Number.isFinite(raw) && raw >= 5000 ? Math.round(raw) : 30000
})()

/**
 * 自定义源单次响应体的硬上限（字节，默认 8MB，CUSTOM_SOURCE_MAX_BODY_MB 可调）。
 *
 * 实测依据：246 上一轮音源巡检（40 源 / 146 平台）期间，堆内存从常态 225MB 冲到 **979MB**，
 * 5 秒内触发 60 次 GC，事件循环连续停转 5.7s / 4.9s —— 卡顿归因给出的嫌疑都是
 * 「响应刚回来」的音源。根源是 vm2 边界要把响应体整份 JSON.parse + decontextify 深拷贝，
 * 一份几十 MB 的响应在 NAS 的弱 CPU 上就是数秒同步阻塞 + 双份常驻内存。
 *
 * 音乐接口（搜索/取链/歌词）正常响应都在几百 KB 以内，上 MB 的多半是源站错误页、
 * 整站 JS bundle 或脚本自己拼的大对象 —— 这些内容交给脚本也只会被当成异常数据。
 * 因此超限直接以错误回调脚本（脚本按「取链失败」处理，走它自己的重试/换源），
 * 既保住事件循环，也把内存尖峰掐在解析之前。
 */
const CUSTOM_SOURCE_MAX_BODY_BYTES = (() => {
    const raw = Number(process.env.CUSTOM_SOURCE_MAX_BODY_MB)
    const mb = Number.isFinite(raw) && raw > 0 ? raw : 8
    return Math.round(mb * 1024 * 1024)
})()
/** 超大响应告警的节流窗口：同一音源一分钟内只记一条，避免刷屏 */
const OVERSIZE_LOG_WINDOW_MS = 60 * 1000
const oversizeLoggedAt = new Map<string, number>()
import {
    acquireRequestSlot,
    getActivitySnapshot,
    getRecentActivity,
    jitterDelay,
    noteCallback,
    noteLoadEnd,
    noteLoadStart,
    noteRequest,
    resetActivity,
} from './sourceActivity'

import needle from 'needle'
import { encodeRequestUrl } from '../utils/urlEncode'
import * as crypto from 'crypto'
import * as zlib from 'zlib'
import { promisify } from 'util'

import * as tunnel from 'tunnel'
import { getProxyAgent } from '../modules/utils/proxy.js'
import { tryResolveByAccount, isEnabled, isPriority, isSupportedSource, getPlatform } from './musicAccount'
import { isUserAllowed } from './musicAccount/permission'

// ---- 汽水/B站的脚本平台 key 别名 ----
// 社区脚本声明这两个平台时 key 写法不一（qs / qishui / soda…、bili / bilibili…），
// 服务端统一 id 是 soda / bili。候选脚本匹配、平台开关判定、取链调用都按脚本声明的
// 原始 key 走（scriptPlatformKeys），只有落回服务端通道（extraSources）时才归一。
const EXTRA_SOURCE_ALIASES: Record<string, string[]> = {
    soda: ['soda', 'qs', 'qishui', 'qsmusic'],
    bili: ['bili', 'bilibili', 'bilivideo'],
}
/** 服务端统一 id -> 脚本可能声明的平台 key 列表（非额外音源返回自身） */
export function scriptPlatformKeys(source: string): string[] {
    return EXTRA_SOURCE_ALIASES[String(source || '').trim().toLowerCase()] || [source]
}
/** 是否汽水/B站（服务端通道由 extraSources 提供） */
export function isExtraSourceId(source: string): boolean {
    return !!EXTRA_SOURCE_ALIASES[String(source || '').trim().toLowerCase()]
}

/**
 * 汽水/B站的「服务端通道」（extraSources）：
 * 与五大平台的 musicAccount 账号通道同角色 —— 名单内带管理员 Cookie（高音质/签名器），
 * 名单外或未配 Cookie 时匿名。匿名流本就是公开音源，名单只控制 Cookie 不封通道。
 * 返回 null 表示通道没出链，交给后续脚本循环 / 报错分支。
 */
async function resolveViaExtraChannel(
    source: string, songInfo: any, quality: string, clientUsername?: string,
): Promise<{ url: string; type: string; sourceName: string; via?: string; key?: string } | null> {
    try {
        const extraSources = require('./extraSources')
        const extra = await extraSources.getMusicUrl(source, songInfo, quality, clientUsername)
        return extra?.url ? extra : null
    } catch {
        return null
    }
}
import { checkLiteralTarget, createGuardedLookup, logBlocked } from './requestGuard'
const inflate = promisify(zlib.inflate)
const deflate = promisify(zlib.deflate)

/**
 * 把任意「抛出物」转成可读的错误描述。
 *
 * 自定义源脚本抛出的往往不是标准 Error 对象：可能是纯字符串、undefined、
 * 或跨 vm 上下文后丢失 message 的对象。直接读 `e.message` 会打出
 * `调用请求异常: undefined`（日志里很常见），排障时等于没有信息。
 * 这里统一兜底：message → msg → code → JSON → 类型标签，保证日志始终可读。
 */
export function describeError(e: any): string {
    if (e === undefined) return 'undefined（源未提供错误信息）'
    if (e === null) return 'null'
    if (typeof e === 'string') return e || '(空字符串)'
    if (typeof e === 'number' || typeof e === 'boolean') return String(e)
    if (typeof e === 'object') {
        const rawMsg = typeof e.message === 'string' ? e.message : (typeof e.msg === 'string' ? e.msg : '')
        const code = e.code !== undefined ? ` [code=${e.code}]` : ''
        if (rawMsg) {
            const name = typeof e.name === 'string' && e.name && e.name !== 'Error' ? `${e.name}: ` : ''
            return `${name}${rawMsg}${code}`
        }
        try {
            const s = JSON.stringify(e)
            if (s && s !== '{}') return `${s}${code}`
        } catch {
            // 循环引用 / 含 Buffer 等无法序列化，落到类型标签
        }
        return `${Object.prototype.toString.call(e)}${code}`
    }
    return String(e)
}

/** 把沙箱日志的多个参数拼成一行文本（非字符串参数走 describeError 兜底） */
function formatLogArgs(args: any[]): string {
    return args
        .map(a => (typeof a === 'string' ? a : describeError(a)))
        .join(' ')
}

// 彻底切断与沙箱上下文的联系
function decontextify(obj: any): any {
    if (obj === null || obj === undefined) return obj

    // 非对象直接返回
    if (typeof obj !== 'object') return obj

    // 处理 Buffer (极其重要：使用 Uint8Array 中转以切断 Proxy 链)
    try {
        if (Buffer.isBuffer(obj) || obj instanceof Uint8Array || (obj && obj.constructor && obj.constructor.name === 'Buffer')) {
            return Buffer.from(Uint8Array.from(obj as any))
        }
    } catch (e) { }

    // 处理数组
    if (Array.isArray(obj)) {
        try {
            return obj.map(item => decontextify(item))
        } catch (e) {
            return []
        }
    }

    // 处理 Error (增加对沙箱内 Error 的识别)
    if (obj instanceof Error || (obj && obj.constructor && obj.constructor.name === 'Error')) {
        const err = new Error(obj.message)
        err.stack = obj.stack
        return err
    }

    // 处理普通对象 (预防 Proxy Traps)
    try {
        const newObj: any = {}
        const keys = Object.keys(obj)
        for (const key of keys) {
            try {
                newObj[key] = decontextify(obj[key])
            } catch (e) { }
        }
        return newObj
    } catch (e) {
        try {
            const str = JSON.stringify(obj)
            return str ? JSON.parse(str) : String(obj)
        } catch (e2) {
            return String(obj)
        }
    }
}

// 出站响应「decontextify + 回调」串行化队列。
// 根治主线程卡顿（手册 P-1046）：一批自定义源响应同时回来时，若每个回调都同步做 vm2 边界深拷贝，
// 会叠成数秒阻塞。这里把这段工作收进队列，逐批执行、批间让出事件循环，
// 最长连续阻塞被切成约等于「单次 decontextify 耗时」的小段，事件循环不再被长时间卡死。
// 语义保持不变：回调仍会执行，槽位仍等回调结束才归还。
let dqTail: Promise<void> = Promise.resolve()

/** 单条响应处理（JSON.parse + decontextify + 脚本回调）超过该值即记账，用于定位剩余卡顿 */
const SLOW_RESPONSE_TASK_MS = 400
/** 同一音源的慢任务日志节流窗口：一轮巡检里同一个源可能连续踩中，不节流会刷屏 */
const SLOW_TASK_LOG_WINDOW_MS = 60 * 1000
const slowTaskLoggedAt = new Map<string, number>()

interface DqTaskMeta {
    owner?: string
    id?: string
    name?: string
    /** 响应体字节数（用于区分「大包深拷贝」与「脚本自身算得慢」） */
    bytes?: number
}

/** 单条响应处理内部的三段耗时，由任务自己打点回填 */
interface DqTaskProbe {
    parseMs?: number
    deconMs?: number
    callbackMs?: number
}

/**
 * 「响应体体积」被判定为主因的阈值：parse + 深拷贝合计超过它，才考虑降体积闸。
 *
 * 实测（2026-11-02，本地 vm2 复现 3.56MB / 6528 条纯数据）：
 *   JSON.parse 21ms + decontextify 递归 11ms + 传参进沙箱 1ms + 沙箱内遍历 284ms ≈ 317ms
 * 也就是说 3.5MB 的纯数据走完整条边界只要 0.3 秒，**6 秒不可能是体积造成的**。
 * 所以这里必须按段判定：只有 parse/拷贝真的占了大头才降闸，否则降闸既拦不住卡顿、
 * 又白白削弱了那个源。
 */
const BODY_COST_SUSPECT_MS = 1000
/** 自适应体积闸有效期：到期自动恢复默认上限，避免一次偶发把源永久阉掉 */
const ADAPTIVE_LIMIT_TTL_MS = 30 * 60 * 1000
/** 自适应闸门的地板：音乐接口正常响应很少超过 1MB，再低就开始误伤正常请求 */
const ADAPTIVE_LIMIT_FLOOR_BYTES = 1024 * 1024
/** 判定为体积问题后，把该源上限压到本次体积的这个比例 */
const ADAPTIVE_LIMIT_SHRINK = 0.6

interface AdaptiveLimit {
    limit: number
    until: number
    /** 触发时实测到的体积与耗时，日志里要能自证 */
    bytes: number
    cost: number
}

const adaptiveBodyLimits = new Map<string, AdaptiveLimit>()
/** 同一源在窗口内命中「超长同步任务」的次数：用于区分偶发与常态 */
const slowTaskHits = new Map<string, { count: number; since: number }>()
const SLOW_TASK_HIT_WINDOW_MS = 30 * 60 * 1000
/** 判定为「这个源根本处理不了这个量级」的硬阈值 */
const SLOW_TASK_HARD_MS = 2000

/**
 * 单次「脚本同步块」达到这个时长就直接把该源搬进独立线程（worker），
 * 不必等 sourceGovernor 攒够 2 次/2500ms 才判降速。
 *
 * 实测依据（246，2026-11-06 01:15）：非常刀 单次同步块 5326ms → 判降速；
 * 但判完还要等「下一次调用」才走 worker，而这一轮巡检里它和西瓜聚合源、
 * 1010🎵音源 的响应接连回来，串行 dq 队列把三段同步块连成一次 **11888ms** 的主线程停转。
 * 正常源的单次同步块都在几十毫秒（同轮 /health 里 lastLoadCostMs 7~203ms），
 * 门槛设在 1.2s 不会误伤；真被搬走的源功能不受影响，只是换个线程跑。
 * `CUSTOM_SOURCE_WORKER_PROMOTE_MS` 可调，设 0 关闭提前提升。
 */
const WORKER_PROMOTE_SYNC_MS = (() => {
    const raw = Number(process.env.CUSTOM_SOURCE_WORKER_PROMOTE_MS)
    if (Number.isFinite(raw) && raw >= 0) return Math.round(raw)
    return 1200
})()

/**
 * 慢源熔断：脚本自身同步重活（体积闸拦不住的那一类）连续命中就自动停用。
 *
 * 背景（2026-11-04 实测）：「非常刀」「西瓜聚合源」单条响应稳定卡 4.8~5.6 秒，
 * 拆开看 parse 0ms / 深拷贝 3~12ms / **脚本回调 4.9~5.6 秒** —— 卡顿全部来自脚本自己的
 * 同步逻辑，跟响应体大小无关，所以「降体积闸」这条路对它们完全无效（日志自己都写了「降闸无效」）。
 * 但事件循环卡顿归因那套（sourceGuard 的 stall 判定）噪声太大、默认关闭，靠它只会误伤。
 *
 * 这里改成**按实测证据熔断**：同一个源在 30 分钟窗口内第 N 次单条响应同步处理超 2 秒，
 * 就认定它扛不住，走隔离机制停用（隔离 = 强制跳过加载，但仍保留原因、可解除、24h 自动放行复核）。
 * 只处理「回调为主因」的；体积为主因的继续走降闸，不该因为数据大就停掉一个正常源。
 */
const SLOW_SOURCE_ISOLATE_ENABLED = process.env.SOURCE_SLOW_ISOLATE !== '0'
const SLOW_SOURCE_MIN_CALLBACK_MS = Number(process.env.SOURCE_SLOW_ISOLATE_MIN_MS) || 2000
const SLOW_SOURCE_ISOLATE_STREAK = Math.max(2, Number(process.env.SOURCE_SLOW_ISOLATE_STREAK) || 3)

/** 当前生效的响应体上限：默认值与该源的自适应上限取小。仅供测试调用 */
export function effectiveBodyLimit(owner: string, id: string): number {
    const hit = adaptiveBodyLimits.get(`${owner}_${id}`)
    if (!hit) return CUSTOM_SOURCE_MAX_BODY_BYTES
    if (Date.now() >= hit.until) {
        adaptiveBodyLimits.delete(`${owner}_${id}`)
        return CUSTOM_SOURCE_MAX_BODY_BYTES
    }
    return Math.min(CUSTOM_SOURCE_MAX_BODY_BYTES, hit.limit)
}

/** 人类可读的体积，日志里比裸字节好认 */
const formatBytes = (n?: number): string => {
    if (!n || n <= 0) return '0B'
    if (n < 1024) return `${n}B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
    return `${(n / 1024 / 1024).toFixed(2)}MB`
}

function dqEnqueue(task: (probe: DqTaskProbe) => void, meta?: DqTaskMeta): void {
    dqTail = dqTail
        .then(async () => {
            // 让出事件循环，确保本批 decontextify 不与其它响应回调挤在同一个同步长块里
            await new Promise<void>(r => setImmediate(r))
            const startedAt = Date.now()
            const probe: DqTaskProbe = {}
            try {
                task(probe)
            } finally {
                // 队列把「并发回来的多份响应」拆成了一任务一 tick，但单个任务本身仍可能是
                // 数秒的同步块（超大响应体的 JSON.parse + 深拷贝，或脚本自己的同步重活）。
                // 这类卡顿此前只能靠事件循环监控+活动账本间接归因，命中谁全凭时间窗，
                // 这里直接量到「哪个源、多大响应、三段各花多少」，让归因从猜测变成实证。
                const cost = Date.now() - startedAt
                if (cost >= SLOW_RESPONSE_TASK_MS) reportSlowTask(meta, cost, probe)
            }
        })
        .catch(() => {
            /* 单任务异常不影响后续入队任务 */
        })
}

/** 慢任务记账 + 按实测归因做自适应处置（体积问题才降闸；脚本自身重活只记不改）。仅供测试调用 */
export function reportSlowTask(meta: DqTaskMeta | undefined, cost: number, probe: DqTaskProbe): void {
    const key = `${meta?.owner || ''}_${meta?.id || ''}`
    const now = Date.now()
    const bytes = meta?.bytes || 0
    const parseMs = probe.parseMs || 0
    const deconMs = probe.deconMs || 0
    const callbackMs = probe.callbackMs || 0
    const bodyCost = parseMs + deconMs
    const bodyIsBlame = bodyCost >= BODY_COST_SUSPECT_MS && bytes >= ADAPTIVE_LIMIT_FLOOR_BYTES

    // 处置策略按实测归因分两条路：
    //   体积为主因（parse+拷贝超 1s）→ 当场降闸，下一次同量级响应在 parse 之前就被丢弃
    //   脚本自身重活 → 体积闸拦不住卡顿，只有「这个源处理这个量级就是不行」时（窗口内第 2 次
    //     超 2s）才降闸；一次偶发不动它，避免为一次性抖动牺牲一个正常音源
    // 命中计数与响应体大小无关：脚本自己同步死循环时响应体可能只有几 KB，一样会卡住事件循环。
    // 所以计数放在体积分支外面，两种成因共用同一份窗口计数。
    const prev = slowTaskHits.get(key)
    const hits = (!prev || now - prev.since > SLOW_TASK_HIT_WINDOW_MS)
        ? { count: 1, since: now }
        : { count: prev.count + 1, since: prev.since }
    slowTaskHits.set(key, hits)

    let adapted = ''
    if (bytes > ADAPTIVE_LIMIT_FLOOR_BYTES && meta?.owner && meta?.id) {
        const shouldShrink = bodyIsBlame
            ? true
            : (cost >= SLOW_TASK_HARD_MS && hits.count >= 2)
        if (shouldShrink) {
            const limit = Math.max(ADAPTIVE_LIMIT_FLOOR_BYTES, Math.round(bytes * ADAPTIVE_LIMIT_SHRINK))
            if (limit < effectiveBodyLimit(meta.owner, meta.id)) {
                adaptiveBodyLimits.set(key, { limit, until: now + ADAPTIVE_LIMIT_TTL_MS, bytes, cost })
                adapted = `；已把该源响应体上限降到 ${formatBytes(limit)}`
                    + `（${ADAPTIVE_LIMIT_TTL_MS / 60000} 分钟内有效，超限按失败回调，脚本自行换源）`
            }
        }
    }

    // 脚本自身同步重活 → 先转「降速运行」，而不是直接停用。
    // 降速是首选处置：源仍然能取链，只是同一时刻只跑一个请求、巡检排到队尾，
    // 不再和别的慢源叠成十几秒的同步阻塞。统计口径与 callRequest 里的同步块实测共用一份窗口。
    if (meta?.owner && meta?.id && callbackMs > 0) {
        noteScriptSyncCost(meta.owner, meta.id, meta.name || meta.id, callbackMs)
    }

    // 体积型不动：它降闸就够，且数据大不是源的错。
    // 已进入「降速运行」的源不再走熔断停用——降速就是它的处置结论，再停用等于一刀切。
    let isolated = ''
    const governorActive = meta?.owner && meta?.id ? isGovernorThrottled(meta.owner, meta.id) : false
    if (
        SLOW_SOURCE_ISOLATE_ENABLED
        && !governorActive
        && !bodyIsBlame
        && callbackMs >= SLOW_SOURCE_MIN_CALLBACK_MS
        && meta?.owner && meta?.id
        && hits.count >= SLOW_SOURCE_ISOLATE_STREAK
    ) {
        const record = isolateSlowSource(
            meta.owner,
            meta.id,
            meta.name || meta.id,
            Math.round(callbackMs),
            hits.count,
        )
        if (record) {
            isolated = `；已自动停用该音源（${SLOW_TASK_HIT_WINDOW_MS / 60000} 分钟内第 ${hits.count} 次同步卡顿，`
                + `可到「隔离记录」解除）`
            // 停用后计数清零：解除隔离重新加载时重新累计，不带着旧账再被秒停
            slowTaskHits.delete(key)
        }
    }

    if (now - (slowTaskLoggedAt.get(key) || 0) < SLOW_TASK_LOG_WINDOW_MS) return
    slowTaskLoggedAt.set(key, now)

    const verdict = bodyIsBlame
        ? '体积为主因'
        : (callbackMs >= BODY_COST_SUSPECT_MS ? '脚本自身同步重活（降闸无效，按次数熔断）' : '')
    const msg = `[响应处理] 单条响应同步耗时 ${cost}ms：${meta?.name || '未知源'}`
        + `（响应体 ${formatBytes(bytes)}｜parse ${parseMs}ms / 深拷贝 ${deconMs}ms / 脚本回调 ${callbackMs}ms`
        + `${verdict ? `｜${verdict}` : ''}｜窗口内第 ${hits.count} 次）${adapted}${isolated}`
    console.warn(msg)
    syncLog.warn(msg)
}

/**
 * 把一次「脚本自身同步块」的实测耗时交给调度层（sourceGovernor）。
 *
 * 这里只做记账与一条日志，真正的隔离手段在 governor 里：慢源之间互斥、同源单飞、
 * 巡检排到队尾。**不在这里停用源** —— 慢但能出链的源仍然可用，只是不再拖累别人。
 */
function noteScriptSyncCost(owner: string, id: string, name: string, syncMs: number): void {
    if (!owner || !id || !Number.isFinite(syncMs) || syncMs < 50) return
    // 带上脚本指纹：降速状态要落盘，脚本更新后必须让旧记录失效，
    // 否则一个新版本脚本会被旧版本的黑历史永远按在 worker 里
    const res = noteSyncBlock(owner, id, name, syncMs, loadedScriptHashes.get(`${owner}/${id}`))
    if (!res.justThrottled) return
    const cfg = getGovernorConfig()
    const mins = Math.round(cfg.ttlMs / 60000)
    const why = res.hits >= cfg.minHits
        ? `（${mins} 分钟窗口内第 ${res.hits} 次）`
        : `（单次即超过严重阈值 ${cfg.severeSyncMs}ms）`
    const msg = `[音源调度] ${name} 脚本同步块 ${Math.round(syncMs)}ms${why}`
        + `，转为「降速运行」：同一时刻只处理一个请求、巡检排到队尾、${mins} 分钟内无新的慢记录自动恢复`
        + `（不影响正常取链，也不停用该源；已降速期间不再累计隔离计数）`
    console.warn(msg)
    syncLog.warn(msg)
}

// 用户API信息接口
interface UserApiInfo {
    id: string
    name: string
    description: string
    version: number | string
    author: string
    homepage: string
    script: string
    sources: Record<string, any>
    enabled: boolean
    owner: string // 'open' or username
    allowUnsafeVM?: boolean
}

export interface ApiStatusInfo {
    status: 'success' | 'failed'
    error?: string
    updateAlert?: {
        name?: string
        log?: string
        updateUrl?: string
    }
}

// 加载的 API 实例
const loadedApis = new Map<string, any>()

// API 初始化状态追踪 map<id, status>
const apiStatus = new Map<string, ApiStatusInfo>()

// 更新嗅探去重：同一音源在窗口期内重复上报同一条更新提示时只处理一次，
// 避免脚本自身重试/重复请求导致的日志刷屏与状态抖动。
const sniffDedupeMap = new Map<string, { sig: string; at: number }>()
const SNIFF_DEDUPE_WINDOW_MS = 60 * 1000

// 上次全量/增量重载耗时（毫秒），供 /health 与诊断日志使用
let lastReloadDurationMs = 0
export function getLastReloadDurationMs() { return lastReloadDurationMs }

/** 汇总当前进程的活跃资源（定时器/句柄）数量，用于诊断定时器泄漏。 */
export function getActiveResourceSummary(): Record<string, number> {
    try {
        const getInfo = (process as any).getActiveResourcesInfo
        if (typeof getInfo !== 'function') return {}
        const list: string[] = getInfo.call(process) || []
        return list.reduce<Record<string, number>>((acc, name) => {
            acc[name] = (acc[name] || 0) + 1
            return acc
        }, {})
    } catch (e) {
        return {}
    }
}

/** 已加载音源实例中登记的定时器/在途请求总数，用于诊断泄漏。 */
export function getTrackedTimerCount() {
    let total = 0
    for (const api of loadedApis.values()) {
        total += (api?.timers?.size || 0) + (api?.pendingAborts?.size || 0)
    }
    return total
}

/**
 * 音源沙箱定时器回调的执行时长超过该值即记录（毫秒）。
 *
 * 音源脚本用宿主 setInterval 注册的回调跑在主线程上：一次几秒的重计算
 * 就会让事件循环停转同样长的时间（所有 HTTP 请求与音频下发集体停顿）。
 * 这类卡顿与 [GC] 大额暂停在时间上互相印证，即可锁定「是哪个音源的定时器」。
 */
const SLOW_TIMER_CALLBACK_MS = 300

/**
 * 慢回调直接触发归因的阈值（毫秒）。
 *
 * 事件循环延迟监控（monitorEventLoopDelay）估出的卡顿时长会明显偏小：实测在 NAS 上
 * 一段 4000ms 的同步阻塞只被估成 2892ms（-28%），恰好漏过归因阈值；同一份代码在
 * 开发机上的估值却是 3678ms。估值依赖采样时机，弱 CPU 上偏差更大。
 * 而这里记录的是回调自身的墙钟耗时（Date.now() 首尾夹逼），是精确值。
 * 因此当某个音源的定时器回调本身已经占到这个量级时，直接以它作为卡顿量级触发归因，
 * 不再依赖那个会低估的估算值。
 */
const SLOW_CALLBACK_ATTRIBUTE_MS = 2000

/** 由 index.ts 注入的归因回调（sourceGuard.attributeStall），保持依赖注入风格避免循环依赖 */
let slowCallbackAttributeHook: ((costMs: number) => void) | null = null

export function setSlowCallbackAttributeHook(fn: ((costMs: number) => void) | null): void {
    slowCallbackAttributeHook = fn
}

export interface TrackedTimerInfo {
    owner: string
    id: string
    name: string
    kind: 'timeout' | 'interval'
    /** 注册时声明的间隔（毫秒）；未知为 -1 */
    intervalMs: number
    registeredAt: number
    /** 查询时计算得出的已存活时长（毫秒） */
    ageMs?: number
}

/** 全部存活中的沙箱定时器明细（按 timer id 索引），供 /health 排查「谁注册了长间隔定时器」。 */
const trackedTimerRegistry = new Map<any, TrackedTimerInfo>()

/** 当前存活的沙箱定时器明细：长间隔定时器（如 10 分钟）往往是周期性 CPU 尖峰的来源。 */
export function getTrackedTimerDetails(): TrackedTimerInfo[] {
    const now = Date.now()
    return Array.from(trackedTimerRegistry.values()).map(item => ({ ...item, ageMs: now - item.registeredAt }))
}

/**
 * 最近一批「慢定时器回调」记录（按时间正序，最多保留 30 条）。
 *
 * 这是卡顿联动归因的第一信号：音源的定时器回调是同步执行的，
 * 它跑多久事件循环就停多久——回调耗时与主线程卡顿时长直接对应。
 */
export interface SlowTimerRecord {
    owner: string
    id: string
    name: string
    kind: string
    /** 注册时声明的间隔（毫秒）；未知为 -1 */
    intervalMs: number
    /** 回调实际耗时（毫秒） */
    costMs: number
    /** 回调完成的时刻（Date.now()） */
    at: number
}

const recentSlowTimerCallbacks: SlowTimerRecord[] = []
const MAX_SLOW_TIMER_RECORDS = 30

/** 最近的慢定时器回调明细，供自检护栏在卡顿发生时做归因。 */
export function getRecentSlowTimerCallbacks(): SlowTimerRecord[] {
    return recentSlowTimerCallbacks.slice()
}

/**
 * 卡顿归因第三信号：卡顿窗口内**有活动**的音源。
 *
 * 慢回调只覆盖「回调本身同步执行很久」，而「一批响应同时回来」和「脚本正在加载」
 * 这两类卡顿在回调视角上是分散的，必须靠请求/加载埋点才能看见。
 */
export function getRecentSourceActivity(windowMs: number): ReturnType<typeof getRecentActivity> {
    return getRecentActivity(windowMs)
}

/** 诊断面板用：活动账本快照（在途请求数、累计请求/回调、加载耗时、是否被降速）。 */
export function getSourceActivitySnapshot(): ReturnType<typeof getActivitySnapshot> {
    return getActivitySnapshot()
}

const reportSlowTimerCallback = (ref: { owner: string; id: string; name: string }, kind: string, intervalMs: number | undefined, costMs: number): void => {
    if (costMs < SLOW_TIMER_CALLBACK_MS) return
    const msg = `[自定义源-${ref.name}] ${kind}回调耗时 ${costMs}ms（间隔 ${intervalMs ?? '未知'}ms）——` +
        '此期间事件循环被占满，所有 HTTP 请求与音频下发都会停顿'
    console.warn(msg)
    syncLog.warn(msg)
    recentSlowTimerCallbacks.push({
        owner: ref.owner,
        id: ref.id,
        name: ref.name,
        kind,
        intervalMs: typeof intervalMs === 'number' ? intervalMs : -1,
        costMs,
        at: Date.now(),
    })
    if (recentSlowTimerCallbacks.length > MAX_SLOW_TIMER_RECORDS) recentSlowTimerCallbacks.shift()

    // 回调自身耗时已达卡顿量级 → 立即归因。
    // 这是精确测量，无需等待（也不受）事件循环延迟监控那套会低估的估算值。
    if (costMs >= SLOW_CALLBACK_ATTRIBUTE_MS) {
        try { slowCallbackAttributeHook?.(costMs) } catch { /* 归因失败不得影响业务 */ }
    }
}

/** 返回已成功加载的 API 源数量，用于状态展示与健康检查。 */
export function getLoadedApisCount() {
    return loadedApis.size
}

/**
 * 列出当前已加载的音源。自检护栏的复检归因需要知道「现在都有谁在跑」，
 * 才能逐个卸载并观察 CPU 是否回落。
 */
export function getLoadedApiRefs(): Array<{ owner: string; id: string; name: string }> {
    const refs: Array<{ owner: string; id: string; name: string }> = []
    for (const api of loadedApis.values()) {
        const info = api?.info
        if (!info?.id) continue
        refs.push({
            owner: String(info.owner || 'open'),
            id: String(info.id),
            name: String(info.name || info.id),
        })
    }
    return refs
}

export function getApiStatus(owner: string, id: string): ApiStatusInfo | undefined {
    return apiStatus.get(`${owner}_${id}`)
}

/**
 * 按 order.json 里的位置排序候选源；**没被列出的按 id 字典序兜底**。
 *
 * 抽成纯函数是为了让「顺序可复现」这条规则可测：以前 order.json 没覆盖到源时
 * （新装、手工拷入、`_open` 下根本没这个文件）直接沿用 Map 插入顺序，
 * 也就是脚本加载完成顺序 —— 那是异步竞态，同一份数据两次启动可能选到不同的源。
 */
export const sortCandidatesByOrder = (candidates: any[], idToIndex: Map<string, number>): any[] => {
    const orderIndex = (api: any): number => {
        const id = String(api?.info?.id || '')
        return idToIndex.has(id) ? idToIndex.get(id)! : 999999
    }
    return [...candidates].sort((a: any, b: any) => {
        const ia = orderIndex(a)
        const ib = orderIndex(b)
        if (ia !== ib) return ia - ib
        const ka = String(a?.info?.id || '')
        const kb = String(b?.info?.id || '')
        return ka < kb ? -1 : ka > kb ? 1 : 0
    })
}

/** 已经尝试过落盘的 order.json 路径（含失败），避免每个请求都去写盘 */
const orderSnapshotTried = new Set<string>()

/**
 * order.json 缺失时，把「当前生效的顺序」落盘冻结一次。
 *
 * 为什么不是按 id 字典序兜底：字典序是**任意**的。实测（2026-11-08，wy/晴天 320k）
 * 按 id 排会把 `1010音源`、`Ciallo` 顶到最前，每次请求白跑 5.5s 才轮到能出链的源，
 * 而原来的顺序只要 0.2s —— 用户什么都没改，却平白慢了 20 倍。
 *
 * 冻结当前顺序同时拿到三件事：
 *   - 不打扰：用户此刻用的顺序就是它，第一次启动后原样保留，不会莫名重排；
 *   - 可复现：落盘后重启不再漂移，排查「重启后某平台变慢」有据可查；
 *   - 可调整：面板里拖一下就改 order.json，不再受加载竞态影响。
 *
 * 只写一次：写完文件就存在了，下次读到就走正常路径。写不了（只读挂载）时
 * 记进 tried 集合，别每个请求都重试一遍。
 */
export const persistOrderSnapshot = (orderPath: string, ids: string[]): boolean => {
    if (!orderPath || ids.length < 2) return false
    if (orderSnapshotTried.has(orderPath)) return false
    orderSnapshotTried.add(orderPath)
    try {
        // 已有文件就绝不覆盖：那可能是用户手改的，也可能被并发请求抢先写了
        if (fs.existsSync(orderPath)) return false
        fs.mkdirSync(path.dirname(orderPath), { recursive: true })
        const tmp = orderPath + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(ids, null, 2), 'utf-8')
        fs.renameSync(tmp, orderPath)
        console.log(`[自定义源] 未找到 order.json，已按当前加载顺序冻结 ${ids.length} 个源：${orderPath}`)
        return true
    } catch (e: any) {
        console.log(`[自定义源] 冻结 order.json 失败（按 id 字典序兜底）：${e?.message || e}`)
        return false
    }
}

/** 单测用：清掉「已尝试落盘」标记 */
export const __resetOrderSnapshotState = (): void => { orderSnapshotTried.clear() }

/**
 * 取某个已加载音源的协议契约自检报告。
 *
 * 未加载（禁用/加载失败）时返回 undefined —— 契约只有在脚本真的 inited 之后
 * 才存在，列表接口据此区分「没加载」和「加载了且合规」。返回值是只读快照，
 * 调用方不应把它写回实例。
 */
export function getSourceContract(owner: string, id: string): ContractReport | undefined {
    const api = loadedApis.get(`${owner}_${id}`)
    return api?.info?.contract || undefined
}

/**
 * 全局契约自检汇总，供 `/health` 使用。
 *
 * 只有一条统计口径有意义：**有多少个已加载源声明违规**。合规数没意义（大多数源
 * 本来就合规），`byIssue` 才是排查用的——它回答「当前这批源里最普遍的协议问题是哪种」，
 * 比如一片 `unsupported_actions` 就说明有人批量装了一批同一来源的改造脚本。
 */
export function getContractSummary(): {
    checked: number
    compliant: number
    violating: number
    byIssue: Record<string, number>
} {
    const reports: ContractReport[] = []
    for (const api of loadedApis.values()) {
        const report: ContractReport | undefined = api?.info?.contract
        if (report) reports.push(report)
    }
    return summarizeContractReports(reports)
}

/**
 * 汇总逻辑抽成纯函数，便于单测（loadedApis 是模块内私有状态，外部注入不了）。
 * 统计口径：`violating` 按**源**计数（一个源多个平台违规只算一个源），
 * `byIssue` 按**问题码**计数（同一个错误码出现几次）。
 */
export function summarizeContractReports(reports: ContractReport[]): {
    checked: number
    compliant: number
    violating: number
    byIssue: Record<string, number>
} {
    let compliant = 0
    const byIssue: Record<string, number> = {}
    for (const report of reports) {
        if (report.compliant) compliant += 1
        for (const issue of report.issues) {
            if (issue.severity !== 'error') continue
            byIssue[issue.code] = (byIssue[issue.code] || 0) + 1
        }
    }
    return {
        checked: reports.length,
        compliant,
        violating: reports.length - compliant,
        byIssue,
    }
}

/**
 * 供「平台可用性巡检」（sourceProbe.ts）使用：返回已加载音源实例及其沙箱调用入口。
 * 只暴露巡检所需的最小面（owner/id/name/支持平台/callRequest），
 * 外部无法借此改动实例内部状态，也避免把 loadedApis 整个泄漏出去。
 */
export function getProbeTargets(): Array<{
    owner: string
    id: string
    name: string
    platforms: string[]
    qualities: Record<string, string[]>
    callRequest: (action: string, source: string, info: any) => Promise<any>
}> {
    const targets: Array<{
        owner: string
        id: string
        name: string
        platforms: string[]
        qualities: Record<string, string[]>
        callRequest: (action: string, source: string, info: any) => Promise<any>
    }> = []
    for (const api of loadedApis.values()) {
        const info = api?.info
        if (!info?.id || typeof api.callRequest !== 'function') continue
        const sources: Record<string, any> = info.sources || {}
        const qualities: Record<string, string[]> = {}
        for (const [platform, meta] of Object.entries(sources)) {
            // 与契约校验同口径：既接受 ['128k']，也接受 [{ type: '128k', label: '标准' }]。
            // 官方文档的写法是后者，以前这里只认字符串，对象式声明会被整条丢掉，
            // 巡检就只能在 qualitys 为空时退回 128k（对「仅128k」的源恰好蒙对，对别的档就错了）。
            const normalized = normalizeQualityList((meta as any)?.qualitys)
            if (normalized.list.length) qualities[platform] = normalized.list
        }
        targets.push({
            owner: String(info.owner || 'open'),
            id: String(info.id),
            name: String(info.name || info.id),
            platforms: Object.keys(sources),
            qualities,
            callRequest: api.callRequest,
        })
    }
    // 额外音源巡检目标已撤销：汽水/B站不再作为独立 target 参与巡检，
    // 脚本声明的 qs/bili 平台随 loadedApis 的常规目标自动纳入（与五大平台同待遇）。
    return targets
}


// 从脚本注释中提取元数据
export function extractMetadata(script: string): Partial<UserApiInfo> {
    const meta: any = {}

    // 匹配 JSDoc 风格的注释 (支持 /*! 和 /**)
    const commentMatch = script.match(/\/\*[*!]([\s\S]*?)\*\//)
    if (commentMatch) {
        const comment = commentMatch[1]

        // @name
        const nameMatch = comment.match(/@name\s+(.+)/)
        if (nameMatch) meta.name = nameMatch[1].trim()

        // @description
        const descMatch = comment.match(/@description\s+(.+)/)
        if (descMatch) meta.description = descMatch[1].trim()

        // @version
        const verMatch = comment.match(/@version\s+(.+)/)
        if (verMatch) meta.version = verMatch[1].trim()

        // @author
        const authorMatch = comment.match(/@author\s+(.+)/)
        if (authorMatch) meta.author = authorMatch[1].trim()

        // @repository or @homepage
        const repoMatch = comment.match(/@(?:repository|homepage)\s+(.+)/)
        if (repoMatch) meta.homepage = repoMatch[1].trim()
    }

    return meta
}

// 创建 lx.request 包装器（使用 needle）
// pendingAborts: 由调用方传入的登记表，用于在音源卸载时中止其尚未返回的在途请求，
// 避免脚本实例被释放后回调仍写入已失效的实例（也是定时器/请求泄漏的一部分）。

// 出站护栏单例：自定义源不允许访问内网/保留地址（详见 requestGuard.ts）。
// 开关每次请求实时读配置，改完不重载音源也能生效。
const privateNetLookup = createGuardedLookup(() => configBool('customSource.blockPrivateNetwork', true))

async function createLxRequest(
    isUnsafe: boolean = false,
    onSniffUpdate?: (alert: { name?: string, log?: string, updateUrl?: string }) => void,
    pendingAborts?: Set<() => void>,
    meta?: { owner: string; id: string; name: string },
    /**
     * 音源实例是否已释放。
     *
     * 请求在并发闸门里排队时，音源可能正好被卸载（禁用/重载/隔离）。原实现是同步发起
     * needle 请求，不存在这个窗口；加了闸门后必须先确认实例还活着再发——否则回调会
     * 写进已经释放的 VM2 沙箱，轻则抛 contextified 错误，重则直接 SIGSEGV 崩进程。
     */
    isDisposed?: () => boolean
) {
    // 活动账本埋点：脚本视角的「发起请求」与「响应回来」都要记下来。
    // 卡顿归因靠的就是这两个时间锚点——一批响应同时回来时，每个回调都要在
    // 沙箱边界做 decontextify（同步深拷贝）+ JSON.parse，叠在一起就是数秒阻塞。
    const owner = meta?.owner || ''
    const id = meta?.id || ''
    const name = meta?.name || ''
    const tracked = !!owner && !!id

    // 自定义音源脚本调用 lx.request 是同步的，无法在调用时 await，
    // 因此这里预先按 http/https 各建一个 agent，调用时按目标协议取用。
    // 走 customSource 分类的独立开关（未配置时沿用 proxy.all.*）。
    const agentHttps = await getProxyAgent('https://lx-proxy-probe.invalid', 'customSource')
    const agentHttp = agentHttps ? await getProxyAgent('http://lx-proxy-probe.invalid', 'customSource') : undefined

    return (url: string, options: any, callback: Function) => {
        const safeOptions = decontextify(options || {})
        const { method = 'get', timeout, headers, body, form, formData } = safeOptions

        let requestOptions: any = {
            headers,
            follow_max: 5,
            // 显式写出来而不是靠 needle 默认值：下面的超时守卫要按它算总时长预算
            open_timeout: 10000,
            // 内网护栏：needle 会把这个 lookup 透传给 http.request，建连前按解析结果拦截。
            // 放在 lookup 而不是请求前查 URL，是为了同时挡住 302 跳转与 DNS rebinding。
            lookup: privateNetLookup,
            // 单请求上限从 60s 收到 30s（可用 CUSTOM_SOURCE_REQUEST_MAX_MS 覆盖）：
            // 外层「换源总预算」到点返回后，底层请求仍会跑满自己的超时把槽位占着，
            // 实测一个挂死的源能把整轮换源拖到 180s+。砍一半上限对正常源无影响，
            // 对挂死的源能把空转时间直接减半。
            response_timeout: Math.min(
                typeof timeout === 'number' && timeout > 0 ? timeout : CUSTOM_SOURCE_REQUEST_MAX_MS,
                CUSTOM_SOURCE_REQUEST_MAX_MS
            ),
        }
        /**
         * read_timeout 必须显式设：needle 默认是 0（永不超时）。
         *
         * response_timeout 只覆盖「等响应头」这一段；一旦响应头回来了、body 传到一半
         * 对端不再发字节（聚合源里很常见：子接口返回一半就断、或 CDN 卡住），
         * 这个请求就永久挂在 socket 上：真实请求早死了，服务端还以为它「在飞」。
         * 246 实测（2026-11-06 02:05）Hei Music聚合源 requests 120 / callbacks 55，
         * inflight 卡在 65 静默 70 秒纹丝不动，同时 rss 冲到 1.07GB（挂起的 body 都还在内存里）。
         */
        requestOptions.read_timeout = requestOptions.response_timeout

        if (agentHttps && /^https:/i.test(String(url))) requestOptions.agent = agentHttps
        else if (agentHttp) requestOptions.agent = agentHttp

        let data = body
        if (form) {
            data = form
            requestOptions.json = false
        } else if (formData) {
            data = formData
            requestOptions.json = false
        }

        const abortHolder: { fn: (() => void) | null } = { fn: null }
        let cancelled = false
        let slotRelease: (() => void) | null = null
        let slotReleased = false
        const releaseSlotOnce = () => {
            // 槽位只能还一次：回调正常结束与 abort 可能都走到这里
            if (slotReleased) return
            slotReleased = true
            slotRelease?.()
        }
        if (tracked) noteRequest(owner, id, name)

        /**
         * inflight 记账必须与 noteRequest 严格配对，且只能减一次。
         *
         * 原来只在 handleResponse 里 noteCallback：脚本自己调 abort、或请求还在
         * acquireRequestSlot 排队时源被卸载/禁用，needle 从未真正发出请求，
         * handleResponse 永远不会来 —— inflight 只增不减。
         * 246 实测（2026-11-06 01:24）Hei Music聚合源 requests 111 / callbacks 53，
         * inflight 虚高 58，/health 里的「活跃音源/在飞请求」全部失真，
         * 归因时会把一个根本没在跑的源算成嫌疑。
         */
        let inflightClosed = false
        const closeInflightOnce = () => {
            if (inflightClosed) return
            inflightClosed = true
            if (tracked) noteCallback(owner, id, name)
        }

        /**
         * 终态护栏：needle 的 open_timeout / response_timeout 到点只 `request.destroy()`，
         * **不调 done()**；只有 read 超时那条路才 `done(new Error('read timeout'))`。
         * destroy() 不带 error 不会触发 needle 的 'error' 监听 → 回调永不触发。
         *
         * 结果就是「请求早死了，账本里还挂着」：246 实测（2026-11-06 05:46）
         * Hei Music聚合源 requests 130 / callbacks 59，在飞 71，且静默几分钟计数不动。
         * 聚合源向几十个子接口并发，连不上/DNS 卡住/响应头迟迟不回全走这条路。
         *
         * 这里用三条互补的守卫把终态收口，且保证脚本回调最多触发一次：
         *   1) needle 流上的 'timeout' 事件（非 read 类型）→ 当场失败收口；
         *   2) 'response' 事件 → 撤掉本跳计时器，后续交给 needle 的 read_timeout（它会 done）；
         *   3) 每跳一个总时长兜底，覆盖「连 timeout 事件都没等到」的极端情况。
         */
        let settled = false
        let guardTimer: any = null
        const clearGuard = () => {
            if (guardTimer) {
                clearTimeout(guardTimer)
                guardTimer = null
            }
        }
        const settle = (): boolean => {
            if (settled) return false
            settled = true
            clearGuard()
            return true
        }
        const failOnce = (err: any) => {
            if (!settle()) return
            closeInflightOnce()
            releaseSlotOnce()
            try {
                callback.call(null, decontextify(err), null, null)
            } catch { /* 沙箱实例可能已被释放，回调失败不影响主流程 */ }
        }

        const launch = () => {
            // 排队期间实例可能已被卸载（禁用/重载/隔离），此时发起请求会让回调
            // 写进已释放的 VM2 沙箱——实测会直接 SIGSEGV 崩掉整个进程
            if (cancelled || isDisposed?.()) { settle(); closeInflightOnce(); releaseSlotOnce(); return }
                const handleResponse = (err: any, resp: any, body: any) => {
                    // 响应回来的时刻是卡顿归因的关键锚点，必须抢在任何同步处理之前记下
                    closeInflightOnce()
                    // 已经由超时护栏收口过的请求，迟到的响应直接丢弃，避免脚本收到两次回调
                    if (!settle()) return
                    if (abortHolder.fn) pendingAborts?.delete(abortHolder.fn)

                    // 体积闸门：必须在 JSON.parse / decontextify 之前判，否则内存尖峰与同步阻塞
                    // 已经发生（见 CUSTOM_SOURCE_MAX_BODY_BYTES 注释里的实测数据）。
                    const bodyBytes = typeof body === 'string'
                        ? Buffer.byteLength(body)
                        : (Buffer.isBuffer(body) ? body.length : 0)
                    if (!err && bodyBytes > effectiveBodyLimit(owner, id)) {
                        const bodyLimit = effectiveBodyLimit(owner, id)
                        const limitText = formatBytes(bodyLimit)
                        const key = `${owner}_${id}`
                        const now = Date.now()
                        if (now - (oversizeLoggedAt.get(key) || 0) >= OVERSIZE_LOG_WINDOW_MS) {
                            oversizeLoggedAt.set(key, now)
                            const msg = `[自定义源-${name || id}] 响应体 ${formatBytes(bodyBytes)} 超过上限 ${limitText}，`
                                + `已丢弃并回调错误（避免整份深拷贝阻塞事件循环）`
                            console.warn(msg)
                            syncLog.warn(msg)
                        }
                        releaseSlotOnce()
                        try {
                            callback.call(null, Object.assign(
                                new Error(`响应体过大（${formatBytes(bodyBytes)} > ${limitText}），已按失败处理`),
                                { code: 'EBODYTOOLARGE' },
                            ), null, null)
                        } catch { /* 沙箱实例可能已被释放，回调失败不影响主流程 */ }
                        return
                    }

                    // 把「decontextify + 回调」收进串行化队列（根治主线程卡顿，见手册 P-1046）：
                    // 一批响应同时回来时，逐个同步深拷贝会叠成数秒阻塞；入队后本回调立即返回，
                    // 队列逐批处理、批间让出事件循环，最长连续阻塞被切成约等于单次 decontextify 的小段。
                    dqEnqueue((probe) => {
                        if (isDisposed?.()) { releaseSlotOnce(); return }
                        try {
                            if (err) {
                                const tErr = Date.now()
                                try {
                                    callback.call(null, decontextify(err), null, null)
                                } finally {
                                    probe.callbackMs = Date.now() - tErr
                                }
                                return
                            }
                            let parsedBody = body
                            if (typeof body === 'string') {
                                const tParse = Date.now()
                                try {
                                    parsedBody = JSON.parse(body)
                                } catch { }
                                probe.parseMs = Date.now() - tParse
                            }

                            // 自动嗅探第三方脚本通过 HTTP 响应返回的更新提醒 (例如独家音源、各大更新接口)
                            if (onSniffUpdate && parsedBody && typeof parsedBody === 'object') {
                                const targetData = parsedBody.data || parsedBody
                                const updateMsg = targetData.updateMsg || targetData.log || targetData.updateLog || targetData.msg
                                const updateUrl = targetData.updateUrl || targetData.url || targetData.downloadUrl
                                if (updateMsg && (updateUrl || typeof updateMsg === 'string' && updateMsg.includes('更新'))) {
                                    onSniffUpdate({
                                        log: String(updateMsg),
                                        updateUrl: updateUrl ? String(updateUrl) : ''
                                    })
                                }
                            }

                            // 深拷贝这一段单独计时：它是「体积导致卡顿」唯一能被宿主控制的成本，
                            // 和脚本回调里的同步重活必须分开量，否则永远分不清该改哪一头
                            const tDecon = Date.now()
                            let safeResp: any = {
                                statusCode: resp.statusCode,
                                statusMessage: resp.statusMessage,
                                headers: resp.headers,
                                body: decontextify(parsedBody)
                            }

                            // 核心修复：原生 VM 模式下，将响应对象通过 JSON 转换以修复原型链，但保留原始 Body 引用（如果不是对象）
                            if (isUnsafe) {
                                const jsonBody = (typeof parsedBody === 'object' && !Buffer.isBuffer(parsedBody))
                                    ? JSON.parse(JSON.stringify(parsedBody))
                                    : parsedBody;

                                safeResp = JSON.parse(JSON.stringify({
                                    statusCode: resp.statusCode,
                                    statusMessage: resp.statusMessage,
                                    headers: resp.headers
                                }));
                                safeResp.body = jsonBody;
                            }
                            probe.deconMs = Date.now() - tDecon

                            const tCb = Date.now()
                            try {
                                callback.call(null, null, safeResp, safeResp.body)
                            } finally {
                                probe.callbackMs = Date.now() - tCb
                            }
                        } catch (error: any) {
                            callback.call(null, decontextify(error), null, null)
                        } finally {
                            // 槽位在回调彻底结束后才归还：回调体内的 decontextify/JSON.parse
                            // 才是真正的同步开销，提前还槽会让下一路请求挤进同一个阻塞段
                            releaseSlotOnce()
                        }
                    }, { owner, id, name, bytes: bodyBytes })
                }

            // 自己跟随跳转：needle 的自动跳转（follow_max）是内部直接请求新地址，目标不经校验——
            // 源只要把 Location 写成 http://127.0.0.1:9527/ 就能绕过内网护栏。
            // 这里每跳先校验再发，needle 只负责单次请求。
            const MAX_FOLLOW = 5
            let currentReq: any = null

            const follow = (targetUrl: string, reqMethod: string, reqData: any, hops: number): void => {
                if (settled) return
                // 取消/卸载：静默收口（与脚本主动 abort 的语义一致——已 abort 的请求不再回调）
                if (cancelled || isDisposed?.()) { settle(); closeInflightOnce(); releaseSlotOnce(); return }
                const blocked = checkLiteralTarget(targetUrl)
                if (!blocked.ok) {
                    logBlocked(blocked.host, blocked.host, blocked.reason)
                    failOnce(Object.assign(new Error(`目标地址属于内网保留网段（${blocked.reason}），已被自定义源出站护栏拦截: ${blocked.host}`), { code: 'EBLOCKEDPRIVATE' }))
                    return
                }

                // follow_max 必须是 -1 而不是 0：needle 的计数从 0 开始（`count <= follow_max`），
                // 传 0 时第一次跳转 0<=0 仍成立，会被内部悄悄跟一跳 —— 那一跳完全绕过校验。
                let req: any = null
                try {
                    req = needle.request(reqMethod as any, encodeRequestUrl(targetUrl), reqData, { ...requestOptions, follow_max: -1 }, (err: any, resp: any, body: any) => {
                        if (settled) return
                        if (!err && resp && resp.statusCode >= 300 && resp.statusCode < 400 && hops < MAX_FOLLOW) {
                            const rawLocation = Array.isArray(resp.headers?.location) ? resp.headers.location[0] : resp.headers?.location
                            let nextUrl = ''
                            if (rawLocation) {
                                try { nextUrl = new URL(String(rawLocation), targetUrl).toString() } catch { /* 非法 Location 当普通响应处理 */ }
                            }
                            if (nextUrl) {
                                // 303 与「非 GET 收到 301/302」按惯例改成 GET 且不带 body；
                                // 307/308 要求原样重发，否则脚本拿到的语义就变了
                                const keepMethod = resp.statusCode === 307 || resp.statusCode === 308
                                const isBodyless = /^(get|head)$/i.test(reqMethod)
                                const nextMethod = keepMethod ? reqMethod : (isBodyless ? reqMethod : 'get')
                                const nextData = (keepMethod || isBodyless) ? reqData : null
                                follow(nextUrl, nextMethod, nextData, hops + 1)
                                return
                            }
                        }
                        handleResponse(err, resp, body)
                    })
                } catch (e: any) {
                    // needle 同步抛（URL/headers 非法等）：原来会一路冒泡到 acquireRequestSlot 的
                    // then 里变成 unhandled rejection，回调与账本都不收口，请求永久计在「在飞」。
                    failOnce(e)
                    return
                }
                currentReq = req

                try {
                    // 响应头一到就撤掉本跳计时器：之后的 body 传输由 needle 的 read_timeout 兜着
                    // （那条路会 done()，回调正常回来）
                    req?.on?.('response', clearGuard)
                    // needle 的 open/response 超时不回调，只能靠这个事件主动收口
                    req?.on?.('timeout', (type: string) => {
                        if (type === 'read') return
                        failOnce(Object.assign(
                            new Error(`${type} timeout（needle 此路径不会回调，已由宿主收口）`),
                            { code: 'ETIMEDOUT' },
                        ))
                    })
                } catch { /* 老版本 needle 返回非 EventEmitter 时忽略，仍有兜底计时器 */ }

                // 总时长兜底：open + response 两段都不回调，靠上面的 timeout 事件通常已足够；
                // 这里再兜一层，防止连 'timeout' 事件都等不到（例如底层 socket 直接哑掉）
                const guardMs = (requestOptions.open_timeout || 10000) + (requestOptions.response_timeout || 30000) + 5000
                clearGuard()
                guardTimer = setTimeout(() => {
                    failOnce(Object.assign(
                        new Error(`请求超时 ${guardMs}ms 未收到响应（宿主兜底守卫）`),
                        { code: 'ETIMEDOUT' },
                    ))
                }, guardMs)
                if (guardTimer && typeof guardTimer.unref === 'function') guardTimer.unref()

                const abortFn = () => {
                    const reqObj = (currentReq as any).request
                    if (reqObj && !reqObj.aborted) reqObj.abort()
                }
                if (pendingAborts && abortHolder.fn) pendingAborts.delete(abortHolder.fn)
                abortHolder.fn = abortFn
                if (cancelled) abortFn()
                else if (pendingAborts) pendingAborts.add(abortFn)
            }

            follow(url, method, data, 0)
        }

        if (tracked) {
            // 并发闸门：被自动降速的脚本会在这里排队，拿到槽位才真正发出请求。
            // 脚本视角 lx.request 仍是同步返回 abort 函数，行为不变。
            void acquireRequestSlot(owner, id).then(release => {
                slotRelease = release
                launch()
            })
        } else {
            launch()
        }

        return () => {
            cancelled = true
            if (abortHolder.fn) {
                abortHolder.fn()
                pendingAborts?.delete(abortHolder.fn)
            }
            // 主动 abort 后 needle 可能不再回调错误，靠这里把 inflight 收口
            settle()
            closeInflightOnce()
            releaseSlotOnce()
        }
    }
}

// 加载自定义源脚本
export async function loadUserApi(apiInfo: UserApiInfo): Promise<any> {
    // 从脚本中提取元数据
    const metadata = extractMetadata(apiInfo.script)
    const fullApiInfo = { ...apiInfo, ...metadata }

    // 创建事件处理映射
    const eventHandlers = new Map<string, Function>()
    let registeredSources: any = {}
    /** 脚本声明的能力契约自检结果；inited 之前为 null */
    let contractReport: ContractReport | null = null

    // ===== 实例级资源登记（用于卸载时彻底释放，避免定时器/请求泄漏）=====
    // 音源脚本运行在沙箱中，但 setTimeout/setInterval 用的是宿主真实实现。
    // 若不在卸载时清理，每次重载都会遗留上一批实例的定时器：
    //   CPU 随「重载次数」线性上涨、内存只增不减，最终拖死事件循环。
    let disposed = false
    const sandboxTimers = new Set<any>()
    const pendingAborts = new Set<() => void>()
    /** 登记/注销定时器明细：/health 要能回答「哪个音源注册了长间隔定时器」 */
    const registerTimer = (id: any, kind: 'timeout' | 'interval', ms: number | undefined) => {
        sandboxTimers.add(id)
        trackedTimerRegistry.set(id, {
            owner: fullApiInfo.owner,
            id: fullApiInfo.id,
            name: fullApiInfo.name,
            kind,
            intervalMs: typeof ms === 'number' ? ms : -1,
            registeredAt: Date.now(),
        })
    }
    const unregisterTimer = (id: any) => {
        sandboxTimers.delete(id)
        trackedTimerRegistry.delete(id)
    }
    const trackedSetTimeout = (fn: Function, ms?: number, ...args: any[]) => {
        // 长周期定时器加随机抖动：几个脚本的周期任务（典型是 600s 自排健康探测）
        // 撞在同一刻会叠加成数秒阻塞，错峰后峰值明显下降。
        // 账本与慢回调上报仍记标称周期，避免误判成「脚本自己把周期改了」。
        const delay = typeof ms === 'number' ? jitterDelay(ms) : ms
        const id = setTimeout(() => {
            unregisterTimer(id)
            if (disposed) return
            const startedAt = Date.now()
            try { fn(...args) } catch (e: any) {
                console.warn(`[自定义源-${fullApiInfo.name}] 定时器回调异常: ${e?.message || e}`)
            } finally {
                reportSlowTimerCallback(fullApiInfo, '定时器', ms, Date.now() - startedAt)
            }
        }, delay)
        registerTimer(id, 'timeout', ms)
        return id
    }
    const trackedSetInterval = (fn: Function, ms?: number, ...args: any[]) => {
        const intervalDelay = typeof ms === 'number' ? jitterDelay(ms) : ms
        const id = setInterval(() => {
            if (disposed) return
            const startedAt = Date.now()
            try { fn(...args) } catch (e: any) {
                console.warn(`[自定义源-${fullApiInfo.name}] 定时器回调异常: ${e?.message || e}`)
            } finally {
                reportSlowTimerCallback(fullApiInfo, '间隔定时器', ms, Date.now() - startedAt)
            }
        }, intervalDelay)
        registerTimer(id, 'interval', ms)
        return id
    }
    const trackedClearTimer = (id: any) => {
        unregisterTimer(id)
        clearTimeout(id)
        clearInterval(id)
    }
    const disposeInstance = () => {
        if (disposed) return
        disposed = true
        const timerCount = sandboxTimers.size
        for (const id of sandboxTimers) {
            clearTimeout(id)
            clearInterval(id)
            trackedTimerRegistry.delete(id)
        }
        sandboxTimers.clear()
        const abortCount = pendingAborts.size
        sniffDedupeMap.delete(`${fullApiInfo.owner}_${fullApiInfo.id}`)
        for (const abort of pendingAborts) {
            try { abort() } catch (e) { }
        }
        pendingAborts.clear()
        eventHandlers.clear()
        if (timerCount > 0 || abortCount > 0) {
            console.log(`[自定义源] 已释放 ${fullApiInfo.name} 的资源: 定时器 ${timerCount} 个, 在途请求 ${abortCount} 个`)
        }
    }
    // =================================================================

    // ========== 关键修改：提前创建 initPromise ==========
    let initResolve: (() => void) | null = null
    let initReject: ((err: Error) => void) | null = null
    const initPromise = new Promise<void>((resolve, reject) => {
        initResolve = resolve
        initReject = reject
    })
    // ==================================================

    // lx 环境数据准备
    const lxDataInside = {
        version: '2.0.0',
        env: 'desktop',
        platform: 'web',
        currentScriptInfo: {
            name: fullApiInfo.name,
            description: fullApiInfo.description,
            version: fullApiInfo.version,
            author: fullApiInfo.author,
            homepage: fullApiInfo.homepage,
            rawScript: fullApiInfo.script,
        },
        EVENT_NAMES: {
            request: 'request',
            inited: 'inited',
            updateAlert: 'updateAlert'
        }
    }

    // 构建 lx 工具集
    const lxUtils = {
        buffer: {
            from: (d: any, e: any) => Buffer.from(decontextify(d), decontextify(e)),
            bufToString: (b: any, f: any) => Buffer.isBuffer(b) ? b.toString(f) : Buffer.from(b, 'binary').toString(f)
        },
        crypto: {
            md5: (str: string) => crypto.createHash('md5').update((decontextify(str) || '') as any).digest('hex'),
            aesEncrypt: (buffer: any, mode: string, key: any, iv: any) => {
                const dKey = decontextify(key)
                const dIv = decontextify(iv)
                const dBuffer = decontextify(buffer)
                const algorithm = `aes-${(dKey as any).length * 8}-${mode}`
                const cipher = crypto.createCipheriv(algorithm as any, dKey as any, dIv as any)
                return Buffer.concat([cipher.update(dBuffer as any) as any, cipher.final() as any])
            },
            rsaEncrypt: (buffer: any, key: any) => crypto.publicEncrypt(decontextify(key) as any, decontextify(buffer) as any),
            randomBytes: (size: number) => crypto.randomBytes(size),
        },
        zlib: {
            inflate: (buffer: any) => inflate(decontextify(buffer) as any),
            deflate: (buffer: any) => deflate(decontextify(buffer) as any),
        }
    }

    // 核心 lx 对象
    const lxObject = {
        ...lxDataInside,
        utils: lxUtils,
        request: await createLxRequest(
            !!apiInfo.allowUnsafeVM && !!global.lx.config['system.allowUnsafeVM'],
            (alert) => {
                const apiKey = `${fullApiInfo.owner}_${fullApiInfo.id}`
                // 去重只看提示内容本身：同一音源脚本常在初始化/重试中连发多次相同提示，
                // 而 updateUrl 每次可能带不同参数，按整串比较会漏判、造成日志刷屏。
                const sig = String(alert.log || '')
                const now = Date.now()
                const last = sniffDedupeMap.get(apiKey)
                const repeated = !!last && last.sig === sig && now - last.at < SNIFF_DEDUPE_WINDOW_MS

                const currentStatus = apiStatus.get(apiKey) || { status: 'success' }
                currentStatus.updateAlert = {
                    name: alert.name || fullApiInfo.name,
                    log: alert.log,
                    updateUrl: alert.updateUrl
                }
                apiStatus.set(apiKey, currentStatus)
                if (!repeated) {
                    sniffDedupeMap.set(apiKey, { sig, at: now })
                    console.log(`[自定义源] [更新嗅探] 嗅探到源 ${fullApiInfo.name} 的更新提示: ${alert.log}`)
                }
            },
            pendingAborts,
            { owner: fullApiInfo.owner, id: fullApiInfo.id, name: fullApiInfo.name },
            () => disposed
        ),
        send: (eventName: string, data: any) => {
            if (disposed) return
            const dData = decontextify(data)
            // console.log(`[自定义源-${fullApiInfo.name}] send:`, eventName)
            if (eventName === 'inited') {
                if (dData && dData.sources) {
                    registeredSources = dData.sources
                    // 契约自检：把「声明违规」在加载时就变成一条指向平台与字段的日志。
                    // 以前这类问题要等用户点歌失败、翻沙箱日志才看得见（豆包音源的
                    // 多声明 actions + 返回对象就是这样被当成「源坏了」的）。
                    // 只记日志不拒绝加载——能不能播由取链阶段决定。
                    try {
                        contractReport = inspectSourceContract(registeredSources)
                        const brief = summarizeContract(contractReport)
                        if (brief) {
                            const level = contractReport.compliant ? 'warn' : 'error'
                            console[level](`[自定义源-${fullApiInfo.name}] 协议契约不合规（${brief}）；` +
                                `不影响加载，取链时按可用性决定是否成功`)
                        }
                    } catch { /* 自检本身绝不能影响加载 */ }
                    if (global.lx.config['debug.enabled']) {
                        console.log(`[自定义源-${fullApiInfo.name}] 已注册音源:`, Object.keys(registeredSources).join(', '))
                    }
                }
                if (initResolve) initResolve()
            } else if (eventName === 'updateAlert') {
                let alertPayload: any = {}
                if (typeof dData === 'object' && dData !== null) {
                    alertPayload = {
                        name: dData.name || fullApiInfo.name,
                        log: dData.log || dData.updateMsg || dData.msg || (typeof dData === 'string' ? dData : ''),
                        updateUrl: dData.updateUrl || dData.url || ''
                    }
                } else if (typeof dData === 'string') {
                    alertPayload = {
                        name: fullApiInfo.name,
                        log: dData,
                        updateUrl: ''
                    }
                }
                const error: any = new Error(`发现新版本, 需要更新: ${alertPayload.log || JSON.stringify(dData)}`)
                error.updateAlert = alertPayload
                if (initReject) initReject(error)
            }
        },
        on: (eventName: string, handler: Function) => {
            // console.log(`[UserApi-${fullApiInfo.name}] on:`, eventName)
            if (eventName === 'request') {
                eventHandlers.set(eventName, handler)
            }
        }
    }

    // 针对音源脚本沙箱的 console 代理：非 DEBUG 模式下静默普通的 log/info/debug 等输出
    const rawSandboxConsole: Record<string, any> = {
        log: (...args: any[]) => { if (global.lx.config['debug.enabled']) console.log(...args) },
        info: (...args: any[]) => { if (global.lx.config['debug.enabled']) console.info(...args) },
        debug: (...args: any[]) => { if (global.lx.config['debug.enabled']) console.debug(...args) },
        warn: (...args: any[]) => { if (global.lx.config['debug.enabled']) console.warn(...args) },
        time: (...args: any[]) => { if (global.lx.config['debug.enabled']) console.time(...args) },
        timeEnd: (...args: any[]) => { if (global.lx.config['debug.enabled']) console.timeEnd(...args) },
        timeLog: (...args: any[]) => { if (global.lx.config['debug.enabled']) (console as any).timeLog?.(...args) },
        group: (...args: any[]) => { if (global.lx.config['debug.enabled']) (console as any).group?.(...args) },
        groupCollapsed: (...args: any[]) => { if (global.lx.config['debug.enabled']) (console as any).groupCollapsed?.(...args) },
        groupEnd: () => { if (global.lx.config['debug.enabled']) (console as any).groupEnd?.() },
        table: (...args: any[]) => { if (global.lx.config['debug.enabled']) (console as any).table?.(...args) },
        trace: (...args: any[]) => { if (global.lx.config['debug.enabled']) console.trace(...args) },
        clear: () => {},
        count: (...args: any[]) => { if (global.lx.config['debug.enabled']) (console as any).count?.(...args) },
        countReset: (...args: any[]) => { if (global.lx.config['debug.enabled']) (console as any).countReset?.(...args) },
        assert: (condition?: boolean, ...data: any[]) => { if (global.lx.config['debug.enabled']) console.assert(condition, ...data) },
        dir: (...args: any[]) => { if (global.lx.config['debug.enabled']) console.dir(...args) },
        dirxml: (...args: any[]) => { if (global.lx.config['debug.enabled']) (console as any).dirxml?.(...args) },
        error: (...args: any[]) => {
            // 巡检期间源脚本自身的报错属于「预期内的失败探测」，静默并聚合，
            // 避免单轮数百行刷屏；非巡检期间 error 一律原样输出（通常值得看）。
            if (isProbeQuiet()) {
                recordSuppressed(fullApiInfo.name, formatLogArgs(args))
                return
            }
            console.error(...args)
        }
    }

    const sandboxConsole = new Proxy(rawSandboxConsole, {
        get(target, prop: string) {
            if (prop in target) {
                return target[prop]
            }
            if (typeof (console as any)[prop] === 'function') {
                return (...args: any[]) => {
                    if (global.lx.config['debug.enabled']) {
                        return (console as any)[prop](...args)
                    }
                }
            }
            return () => {}
        }
    })

    // 完整沙箱环境
    // 注意：setTimeout/setInterval 使用被登记的包装版本，卸载时才能统一清理，
    // 否则每次重载都会遗留下一个永不释放的定时器（CPU/内存泄漏的根源）。
    const sandbox: any = {
        console: sandboxConsole,
        setTimeout: trackedSetTimeout,
        clearTimeout: trackedClearTimer,
        setInterval: trackedSetInterval,
        clearInterval: trackedClearTimer,
        // 未被登记的调度原语同样会造成「卸载后仍在空转」：部分混淆脚本用
        // setImmediate / queueMicrotask 做自旋，这里统一映射到可追踪的定时器，
        // 使其在实例卸载时能被一并清理（与 setTimeout 同一登记集合）。
        setImmediate: (fn: Function, ...args: any[]) => trackedSetTimeout(() => fn(...args), 0),
        clearImmediate: trackedClearTimer,
        queueMicrotask: (fn: Function) => trackedSetTimeout(() => fn(), 0),
        Buffer,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        process: {
            nextTick: (fn: Function, ...args: any[]) => trackedSetTimeout(() => fn(...args), 0),
            env: { NODE_ENV: process.env.NODE_ENV || 'production' }
        },
        lx: lxObject,
        // 关键：适配混淆脚本对全局变量的引用
        global: null,
        window: null,
        globalThis: null,
        atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
        crypto: crypto
    }
    sandbox.global = sandbox
    sandbox.window = sandbox
    sandbox.globalThis = sandbox

    try {
        if (apiInfo.allowUnsafeVM && global.lx.config['system.allowUnsafeVM']) {
            console.log(`[自定义源] ${fullApiInfo.name} 正在以原生 VM 模式启动...`)
            const vm = require('vm')
            const context = vm.createContext(sandbox)
            // 不再注入 injectionCode 字符串，环境已在 sandbox 中就绪
            vm.runInContext(apiInfo.script, context, {
                filename: `custom_source_${fullApiInfo.id}.js`,
                timeout: 10000
            })
        } else {
            // 保持 vm2 逻辑用于安全模式
            try {
                const vmInstance = new VM({
                    timeout: 10000,
                    sandbox,
                    eval: true,
                    wasm: false,
                })
                await vmInstance.run(apiInfo.script)
            } catch (e: any) {
                const isContextError = e.message.includes('contextified object') || e.message.includes('Operation not allowed')
                if (isContextError) {
                    console.warn(`[自定义源] ${fullApiInfo.name} 触发 vm2 安全限制，正在提示用户开启 VM 模式`)
                    throw new Error('REQUIRE_UNSAFE_VM')
                }
                throw e
            }
        }

        // 等待脚本调用 lx.send('inited')，最多等待 3 秒；完成后清理超时定时器
        let initTimeout: NodeJS.Timeout | undefined
        try {
            await Promise.race([
                initPromise,
                new Promise((_, reject) => {
                    initTimeout = setTimeout(() => reject(new Error('初始化超时，请确保脚本调用了 lx.send("inited", ...)')), 3000)
                })
            ])
        } finally {
            if (initTimeout) clearTimeout(initTimeout)
        }

        // 保存加载 of the API
        const apiInstance = {
            info: { ...fullApiInfo, sources: registeredSources, contract: contractReport },
            handlers: eventHandlers,
            timers: sandboxTimers,
            pendingAborts,
            dispose: disposeInstance,
            callRequest: async (action: string, source: string, info: any) => {
                try {
                    if (disposed) throw new Error(`源 ${fullApiInfo.name} 已被卸载`)
                    const handler = eventHandlers.get('request')
                    if (!handler) throw new Error(`源 ${fullApiInfo.name} 未注册 request 处理器`)

                    // 核心修复：如果是原生 VM 模式，将传入数据 JSON 化以纯净化原型链（确保它是 VM 内的对象）
                    let inputData = { action, source, info }
                    if (apiInfo.allowUnsafeVM && global.lx.config['system.allowUnsafeVM']) {
                        inputData = JSON.parse(JSON.stringify(inputData))
                    }

                    // 慢源独立线程：已被降速的源改走 worker，脚本同步块与
                    // lx.request 的响应解析/回调都不再落在主线程（见 P-1046）。
                    // 命中后完全跳过 runWithGovernor 的「慢源互斥闸」，让多个慢源真正并行；
                    // worker 失败且允许回退时，才落回下面的主线程 vm2 路径。
                    if (shouldRouteToWorker(fullApiInfo.owner, apiInfo.id)) {
                        const worker = await tryWorkerCall(
                            {
                                owner: fullApiInfo.owner,
                                id: apiInfo.id,
                                name: fullApiInfo.name,
                                script: fullApiInfo.script,
                            },
                            action,
                            source,
                            info,
                        )
                        if (worker.handled) {
                            if (worker.error) throw worker.error
                            return worker.value
                        }
                    }

                    const result = await runWithGovernor(
                        fullApiInfo.owner,
                        apiInfo.id,
                        fullApiInfo.name,
                        async () => {
                            // 「脚本自身同步重活」的实测口径：handler 同步执行到第一个 await 的耗时。
                            // 不能拿整个 await 的时长判定 —— 那里面大部分是网络等待，
                            // 慢网络不等于重脚本，用它只会把一堆正常源打成慢源。
                            const syncStartedAt = Date.now()
                            const pending = handler(inputData)
                            const syncCost = Date.now() - syncStartedAt
                            noteScriptSyncCost(
                                fullApiInfo.owner,
                                apiInfo.id,
                                fullApiInfo.name,
                                syncCost,
                            )
                            // 一旦这次同步块把源判成降速，当场登记为 worker 常驻并预热。
                            // 不能等「下一次调用再用 shouldRouteToWorker 判定」：复检在循环开头
                            // 就跳过降速源，该源往往整轮只被调用一次，worker 永远等不到机会；
                            // governor TTL 过期后下一次巡检又会回到主线程卡十几秒。
                            // 另外：单次同步块超过「提升阈值」就直接进 worker，不必等 governor 的
                            // 2 次/2500ms 判降速 —— 那段时间里它还会在主线程再卡一遍。
                            markWorkerEligible(fullApiInfo.owner, apiInfo.id, {
                                owner: fullApiInfo.owner,
                                id: apiInfo.id,
                                name: fullApiInfo.name,
                                script: fullApiInfo.script,
                            }, syncCost >= WORKER_PROMOTE_SYNC_MS)
                            return decontextify(await pending)
                        },
                    )
                    return result
                } catch (e: any) {
                    if (isProbeQuiet()) {
                        // 巡检期的失败是「预期内噪音」，聚合到摘要里，不逐条打印
                        recordSuppressed(fullApiInfo.name, describeError(e))
                    } else {
                        console.error(`[自定义源-${fullApiInfo.name}] 调用请求异常:`, describeError(e))
                    }
                    // 自定义源脚本可能 `throw undefined` / 抛纯字符串 / 抛跨 vm 丢了 message 的对象。
                    // 原样透传会让上层读 `e.message` 时二次抛 TypeError，把「取链失败」变成
                    // 「Cannot read properties of undefined」的 500，前端连提示都拿不到。
                    // 这里统一归一成 Error，保证调用方永远能安全读 message。
                    throw e instanceof Error ? e : new Error(describeError(e))
                }
            }
        }

        // 临时验证/分析实例只用于提取注册源信息，不加入运行时注册表，
        // 且必须立即 dispose，防止验证脚本遗留更新嗅探定时器或网络请求。
        if (fullApiInfo.owner === 'temp') {
            disposeInstance()
        } else {
            loadedApis.set(`${fullApiInfo.owner}_${apiInfo.id}`, apiInstance)
        }
        console.log(`[自定义源] ✓ 成功加载: ${fullApiInfo.name} v${fullApiInfo.version} (所属: ${fullApiInfo.owner})`)
        console.log(`[自定义源]   支持平台: ${Object.keys(registeredSources).join(', ')}`)
        return { success: true, apiInstance, error: null }
    } catch (error: any) {
        // 加载失败时同样要回收已创建的定时器/在途请求，避免半成品实例泄漏
        disposeInstance()
        console.error(`[自定义源] ✗ 加载失败 ${fullApiInfo.name}:`, error.message)
        if (error.stack && error.message !== 'REQUIRE_UNSAFE_VM') {
            console.error(`[自定义源] [错误堆栈] ${fullApiInfo.name}:`, error.stack)
        }

        let isRequireUnsafe = !apiInfo.allowUnsafeVM && (error.message === 'REQUIRE_UNSAFE_VM' || error.message.includes('初始化超时') || error.message.includes('timeout'))

        // 如果在 VM2 模式下加载失败，且系统允许 VM 模式，尝试测试原生 VM 模式能否成功加载
        if (!isRequireUnsafe && !apiInfo.allowUnsafeVM && global.lx.config['system.allowUnsafeVM']) {
            try {
                const testUnsafeRes = await loadUserApi({
                    ...apiInfo,
                    id: `${apiInfo.id}_test_vm`,
                    allowUnsafeVM: true
                })
                if (testUnsafeRes.success) {
                    console.log(`[自定义源] ${fullApiInfo.name} 在 VM2 模式下失败，但在原生 VM 模式下成功，标记 requireUnsafe = true`)
                    isRequireUnsafe = true
                }
            } catch (e) { }
        }

        return { success: false, apiInstance: null, error: error.message, requireUnsafe: isRequireUnsafe, updateAlert: error.updateAlert }
    }
}

/**
 * 「返回对象」的降级解包日志节流。
 *
 * 协议要求 `musicUrl` 返回字符串；返回对象是只在源自家 App 生效的私有扩展。
 * 这里放行（能播比合规重要），但必须留痕，否则永远没人去修脚本。
 * 同一源同一字段 10 分钟内只记一次——换源队列会对同一首歌反复尝试，不节流会刷屏。
 */
const unwrapLogAt = new Map<string, number>()
const UNWRAP_LOG_INTERVAL_MS = 10 * 60 * 1000
const noteUnwrapOnce = (key: string, line: string): void => {
    const now = Date.now()
    const last = unwrapLogAt.get(key) || 0
    if (now - last < UNWRAP_LOG_INTERVAL_MS) return
    unwrapLogAt.set(key, now)
    if (unwrapLogAt.size > 500) {
        for (const [k, t] of unwrapLogAt) if (now - t >= UNWRAP_LOG_INTERVAL_MS) unwrapLogAt.delete(k)
    }
    console.warn(line)
}

export const validateReturnedMusicUrl = (rawUrl: any, sourceName?: string): string => {
    const unwrapped = unwrapMusicUrlValue(rawUrl)
    if (!unwrapped) {
        if (!rawUrl || typeof rawUrl !== 'string') {
            const shape = rawUrl && typeof rawUrl === 'object'
                ? `（返回了对象，字段: ${Object.keys(rawUrl).slice(0, 6).join(',') || '空'}）`
                : ''
            throw new Error(`音源未返回有效的链接字符串${shape}`)
        }
        throw new Error(`音源返回了非播放链接内容: ${String(rawUrl).trim().slice(0, 40)}`)
    }
    if (unwrapped.fromObject) {
        noteUnwrapOnce(`${sourceName || ''}|${unwrapped.path}`,
            `[自定义源] ${sourceName || '未知'} 的 musicUrl 返回了对象（协议要求字符串），已按 .${unwrapped.path} 解包降级，建议作者修正`)
    }
    const trimmed = unwrapped.url
    const lower = trimmed.toLowerCase()
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
        throw new Error(`音源返回了非播放链接内容: ${trimmed.slice(0, 40)}`)
    }
    // 拦截 404 页面或无效报错链接
    if (lower.includes('/404') || lower.includes('status=404') || lower.includes('error.html')) {
        throw new Error(`音源 [${sourceName || '未知'}] 返回了 404/失效链接，拒绝并自动尝试下一个音源`)
    }
    // 拦截试听片段特征（网易云 jd-musicrep-ts、QQ音乐 RS02 试听等）
    if (lower.includes('jd-musicrep-ts') ||
        lower.includes('/musicrep-ts/') ||
        lower.includes('-ts/') ||
        lower.includes('/rs02') ||
        lower.includes('trialinfo') ||
        lower.includes('freetrial')) {
        throw new Error(`音源 [${sourceName || '未知'}] 返回了试听片段 (URL 包含试听标记)，拒绝并自动尝试下一个音源`)
    }
    return trimmed
}

/** 取链的默认超时（毫秒）。脚本自身没有超时概念，卡住会让整个轮询无限期挂着。 */
const DEFAULT_CALL_TIMEOUT_MS = 20000
/** 链接可用性校验的请求超时（毫秒）。只在拿不到结论时才会拖时间，给小一点避免拖慢整次取链 */
const VERIFY_TIMEOUT_MS = 3000

// ==================== 播放取链的「运行时沉底」账本 ====================
// 只存在于内存：进程重启即清零，任何一次成功立刻清除。它不写 states.json，
// 因此绝不会让音源或平台「消失」，只影响下次取链时谁先被尝试。
/** 沉底的观察窗口（毫秒）：多久之前的失败还算数 */
const PLAY_SINK_WINDOW_MS = 15 * 60 * 1000
/**
 * 窗口内失败几次才沉底。
 *
 * 2026-11-05 定为 1：用户拍板「第一次取链失败先降权，第二次再关平台」——
 * 播放侧的沉底与巡检的降权必须同一步调，否则会出现「巡检已经降权、播放侧还把它排第一」
 * 的割裂。沉底的代价只是「下次先试别的源」，成功一次立刻恢复原位，误伤成本极低。
 */
const PLAY_SINK_MIN_FAILS = 1
/**
 * 平台级故障护栏的沉底名单门槛：单平台沉底达到这个数（且占候选 1/3 以上）时，
 * 更可能是平台整体故障（kg 风控空返回、上游集体失效），不再按单源沉底重排。
 * 依据：39 个源、5 个平台，正常单平台坏 8 个以上的「恰好同时」场景几乎不存在；
 * 3h soak 里唯一的超大名单是 15 个（kg 风控窗口），8 的门槛既能拦住它，又远高于
 * 正常「巡检+播放各自记失败」的日常水位（实测日常 ≤5）。
 */
export const PLATFORM_SINK_CALM_MIN = 8
interface PlaySinkRecord { fails: number; lastFailAt: number }
const playFailSink = new Map<string, PlaySinkRecord>()

const playSinkKey = (owner: string, id: string, platform: string): string => `${owner || ''}:${id || ''}:${platform || ''}`

/**
 * 按「近期是否反复失败」把候选分成两拨：先试 fresh，再试 sunk。
 *
 * 判定依赖两份模块内账本（播放沉底 + 限流退避）与巡检侧的降权状态，
 * 因此 `now` 可注入以便单测固定在某一时刻。
 */
export const partitionByPlaySink = (
    candidates: any[],
    platform: string,
    now: number = Date.now(),
): { fresh: any[]; sunk: any[] } => {
    const isSunk = (api: any): boolean => {
        const rec = playFailSink.get(playSinkKey(api?.info?.owner, api?.info?.id, platform))
        if (rec && rec.fails >= PLAY_SINK_MIN_FAILS && now - rec.lastFailAt < PLAY_SINK_WINDOW_MS) return true
        // 平台刚回过 429：30 秒内先排到队尾，别立刻再撞一次。
        // 这与沉底不同——限流不进失败账本，30 秒后自动恢复（见 sourceRateLimit.ts）。
        if (isRateLimited(api?.info?.owner, api?.info?.id, platform, now)) return true
        // 巡检侧的降权观察：第一次探测失败就点亮，成功一次 / 过期自动撤销。
        // 两套账本各管一段（播放侧管「本次失败」，巡检侧管「平台级证据」），任一命中都排到队尾。
        return isPlatformDemoted(api?.info?.owner, api?.info?.id, platform, now)
    }
    return {
        fresh: candidates.filter(api => !isSunk(api)),
        sunk: candidates.filter(isSunk),
    }
}

const playSinkEnabled = (): boolean => {
    const v = (global.lx && global.lx.config) ? (global.lx.config as any)['customSource.playSink.enabled'] : undefined
    return v !== false
}

/** 「源 × 平台 × 音质档」短路开关。默认开；关掉后只保留原来的源级沉底 */
const qualityLedgerEnabled = (): boolean => {
    const v = (global.lx && global.lx.config) ? (global.lx.config as any)['customSource.qualityLedger.enabled'] : undefined
    return v !== false
}

/**
 * 按历史成绩正向排序的开关。默认开。
 *
 * 与前两个开关的分工：沉底/短路都只做减法（坏源靠后、必败档不发），
 * 这个做加法 —— 把实测更快的源提到前面。关掉后回到「只按 order.json 顺序」。
 */
const playRankEnabled = (): boolean => {
    const v = (global.lx && global.lx.config) ? (global.lx.config as any)['customSource.playRank.enabled'] : undefined
    return v !== false
}

/**
 * 记一次取链失败——只用于排序，不参与定罪。
 *
 * `failMessage` 用来分流：**限流（429）不进沉底账本**，改走 30 秒短退避。
 * 限流是平台侧的临时状态，源本身没坏；记进失败账本会让健康源被排到队尾十几分钟，
 * 还会污染「源 × 档」账本，把能用的档位判成必败档。
 */
export const notePlayFailure = (api: any, platform: string, failMessage?: string): void => {
    if (!api?.info) return
    if (failMessage && isRateLimitFailure(failMessage)) {
        noteRateLimit(api.info.owner, api.info.id, platform)
        return
    }
    const key = playSinkKey(api.info.owner, api.info.id, platform)
    const rec = playFailSink.get(key) || { fails: 0, lastFailAt: 0 }
    rec.fails += 1
    rec.lastFailAt = Date.now()
    playFailSink.set(key, rec)
    try { markLedgerDirty() } catch { /* 落盘标记失败不影响投递 */ }
}

/** 取链成功——立刻撤销沉底/冷却/限流退避 */
export const clearPlayFailure = (api: any, platform: string): void => {
    if (!api?.info) return
    playFailSink.delete(playSinkKey(api.info.owner, api.info.id, platform))
    cooldownSink.delete(playSinkKey(api.info.owner, api.info.id, platform))
    // 成功即归零阶梯：下次偶发超时回到最短的 90 秒，不因为过去挂过就长期缩短机会
    cooldownStreak.delete(playSinkKey(api.info.owner, api.info.id, platform))
    try { markLedgerDirty() } catch { /* 落盘标记失败不影响投递 */ }
    try {
        clearRateLimit(api.info.owner, api.info.id, platform)
        // 刻意不清「源 × 平台 × 档」账本：成功的是**本次请求那一档**，
        // 平台下别的档（典型是长期坏的 flac）证据不该被这次 128k 成功一笔勾销。
        // 早先在这里清整平台，结果 flac 永远攒不够样本、永远短路不了 ——
        // 恰好把这个账本要解决的问题（坏档每次白吃十几秒超时）还给了自己。
        // 该档自身的恢复由 noteQualityResult(ok=true) 负责；
        // 脚本换新导致旧证据失效时，在 reloadSingleSource 里整体清（见那里）。
    } catch { /* 记账失败绝不能影响播放 */ }
}

// ==================== 回源超时的「短冷却」账本 ====================
// 与沉底的区别：沉底只降权（冷却期内仍会被尝试，每首新歌白吃一次 5~10s 超时预算），
// 冷却在第一轮直接跳过该源。只认超时类失败（取链超时/回源超时）——那是「这个源的
// 后端现在很慢」的信号，与歌曲无关；软失败（无版权/已下架）不该触发。
// 可用性保障：冷却不剥夺机会——全部常规源失败后第二轮再试冷却中的源，只是顺序变了。
//
// **阶梯冷却**（2026-11-08 实测加）：原来固定 90 秒，但裤佬这类源是「时好时坏」——
// 8 小时里 8 次 5 秒满超时，每次都是「超时→90 秒后再试→又超时」，同一个坑反复踩。
// 改成连续超时一次拉长一档（90s → 5min → 15min），成功一次立刻归零：
// 偶发一次超时仍然是 90 秒（不误伤），反复挂死的源才被真正拉开距离。
export const PLAY_COOLDOWN_STEPS_MS = [90 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]
/**
 * 冷却源提前兜底的触发点：常规源只剩这么多个未试时，
 * 有历史成功记录的冷却源插到它们前面先试（见 planCooldownSequence）。
 */
export const COOLDOWN_PROMOTE_LEFT = 2
const cooldownSink = new Map<string, number>()
const cooldownStreak = new Map<string, number>()
const COOLDOWN_MSG_RE = /超时/

/** 取链失败后按错误信息记账：超时类失败才进冷却账本 */
export const notePlayCooldown = (api: any, platform: string, failMessage: string): void => {
    if (!api?.info || !COOLDOWN_MSG_RE.test(String(failMessage || ''))) return
    const key = playSinkKey(api.info.owner, api.info.id, platform)
    const streak = (cooldownStreak.get(key) || 0) + 1
    cooldownStreak.set(key, streak)
    const windowMs = PLAY_COOLDOWN_STEPS_MS[Math.min(streak, PLAY_COOLDOWN_STEPS_MS.length) - 1]
    cooldownSink.set(key, Date.now() + windowMs)
    try { markLedgerDirty() } catch { /* 落盘标记失败不影响投递 */ }
}

/** 按「是否处于回源超时冷却期」把候选分成两轮：第一轮试 hot，全败后第二轮试 cooled */
export const partitionByCooldown = (
    candidates: any[],
    platform: string,
    now: number = Date.now(),
): { hot: any[]; cooled: any[] } => {
    if (!playSinkEnabled() || candidates.length < 2) return { hot: candidates, cooled: [] }
    const hot: any[] = []
    const cooled: any[] = []
    for (const api of candidates) {
        const until = cooldownSink.get(playSinkKey(api?.info?.owner, api?.info?.id, platform)) || 0
        ;(until > now ? cooled : hot).push(api)
    }
    return { hot, cooled }
}

/**
 * 平台级故障窗口判定（沉底名单收敛）。
 *
 * 单平台沉底名单 ≥ `PLATFORM_SINK_CALM_MIN` 个、且占候选 1/3 以上时，判为平台级故障窗口：
 * 此时「谁近期失败过」已不反映单个源的优劣，按单源沉底重排只会把优源压到队尾。
 */
export const isPlatformSinkWindow = (sunkLen: number, totalLen: number): boolean =>
    totalLen > 0 && sunkLen >= PLATFORM_SINK_CALM_MIN && sunkLen * 3 >= totalLen

/**
 * 冷却源兜底提前：常规源只剩最后 `promoteLeft` 个未试时，把**有历史成功记录**的冷却源
 * 插到它们前面。纯函数，`proven` 判定该源历史上成功过（见调用处的跨档先验）。
 *
 * 返回 `head → promoted → tail → restCooled` 四段，拼起来就是实际尝试顺序。
 * 没有可提前的源时，等价于原来的 `hot + cooled`。
 */
export const planCooldownSequence = (
    hot: any[],
    cooled: any[],
    proven: (api: any) => boolean,
    promoteLeft: number = 2,
): { head: any[]; promoted: any[]; tail: any[]; restCooled: any[] } => {
    if (hot.length <= promoteLeft || cooled.length === 0) return { head: hot, promoted: [], tail: [], restCooled: cooled }
    const promoted = cooled.filter(proven)
    if (promoted.length === 0) return { head: hot, promoted: [], tail: [], restCooled: cooled }
    const cut = hot.length - promoteLeft
    return {
        head: hot.slice(0, cut),
        promoted,
        tail: hot.slice(cut),
        restCooled: cooled.filter((a: any) => !promoted.includes(a)),
    }
}

/** 沉底 / 超时冷却 / 阶梯计数三份内存账本的落盘结构（重启后不丢学习成果） */
export interface PlaySinkState {
    v: 1
    fails: Array<[string, PlaySinkRecord]>
    cooldowns: Array<[string, number]>
    streaks: Array<[string, number]>
}

export const exportPlaySinkState = (now: number = Date.now()): PlaySinkState => {
    const fails: Array<[string, PlaySinkRecord]> = []
    for (const [key, rec] of playFailSink) {
        if (!rec || !(now - rec.lastFailAt < PLAY_SINK_WINDOW_MS)) continue
        fails.push([key, { ...rec }])
    }
    const cooldowns: Array<[string, number]> = []
    for (const [key, until] of cooldownSink) {
        if (until > now) cooldowns.push([key, until])
    }
    return { v: 1, fails, cooldowns, streaks: [...cooldownStreak] }
}

/** 恢复。返回载入的条目数；异常一律吞掉（账本丢了只是从头学，不能挡住启动） */
export const importPlaySinkState = (state: any, now: number = Date.now()): number => {
    if (!state) return 0
    let n = 0
    if (Array.isArray(state.fails)) {
        for (const item of state.fails) {
            if (!Array.isArray(item) || item.length < 2) continue
            const [key, rec] = item
            if (typeof key !== 'string' || !key || !rec) continue
            const lastFailAt = Number(rec.lastFailAt) || 0
            if (!lastFailAt || now - lastFailAt >= PLAY_SINK_WINDOW_MS) continue
            playFailSink.set(key, { fails: Number(rec.fails) || 1, lastFailAt })
            n += 1
        }
    }
    if (Array.isArray(state.cooldowns)) {
        for (const item of state.cooldowns) {
            if (!Array.isArray(item) || item.length < 2) continue
            const [key, until] = item
            if (typeof key !== 'string' || !key) continue
            const ts = Number(until) || 0
            if (ts <= now) continue
            cooldownSink.set(key, ts)
            n += 1
        }
    }
    if (Array.isArray(state.streaks)) {
        for (const item of state.streaks) {
            if (!Array.isArray(item) || item.length < 2) continue
            const [key, streak] = item
            if (typeof key !== 'string' || !key) continue
            const v = Number(streak) || 0
            if (v > 0) cooldownStreak.set(key, Math.min(v, 99))
        }
    }
    return n
}

/**
 * 把本轮取链里「硬故障」的失败交给巡检账本。
 *
 * hasControlGroup=true 表示同一首歌、同一平台有别的音源成功返回了链接——
 * 既然歌确定能播，那么这些源失败只能是它们自己的后端挂了，可以让巡检按阈值处置。
 * 没有对照组时只累加计数，不处置。
 */
const reportPlayHardFailures = (failures: Array<{ api: any; message: string }>, platform: string, hasControlGroup: boolean): void => {
    if (!failures.length) return
    for (const f of failures) {
        // 限流不是硬故障：交给巡检只会让一个健康源被降权/关闭。
        // isHardFailure 本来就不含 429，但文案里可能同时出现 5xx 与 429（上游包装过），
        // 所以这里显式先排除。
        if (isRateLimitFailure(f.message)) continue
        if (!isHardFailure(f.message)) continue
        try {
            reportManualFailure({
                owner: f.api?.info?.owner || 'open',
                sourceId: f.api?.info?.id || '',
                sourceName: f.api?.info?.name || '未知音源',
                platform,
                error: f.message.slice(0, 300),
                hasControlGroup,
            })
        } catch (e) {
            // 记账失败绝不能影响播放
        }
    }
}

/**
 * 状态码是否代表「这个链接确定取不到」。
 *
 * 只认 404 / 410 / 5xx：403 / 401 / 405 几乎都是防盗链或 upstream 不支持 HEAD，
 * 判死会误杀大量可用的源，得不偿失。导出是为了让单测能直接覆盖这张判定表。
 */
export const isUnplayableStatusCode = (code?: number): boolean =>
    code === 404 || code === 410 || (typeof code === 'number' && code >= 500)

const configNumber = (key: string, fallback: number): number => {
    const raw = (global.lx && global.lx.config) ? (global.lx.config as any)[key] : undefined
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : fallback
}

// 布尔开关：配置项缺失（老配置文件升级上来）时按默认值走
const configBool = (key: string, fallback: boolean): boolean => {
    const raw = (global.lx && global.lx.config) ? (global.lx.config as any)[key] : undefined
    return typeof raw === 'boolean' ? raw : fallback
}

/**
 * 给取链调用套一层超时。
 *
 * 脚本里没有超时概念：某个源内部串行试十几二十个后端、或请求一个不响应的域名，
 * 宿主就会一直 await 下去。轮询是串行的，一个卡住的源能把整次播放拖到不可用。
 * 超时只是让宿主不再等待（脚本自身无法被强制中断），后续回调由 disposed 机制兜底。
 */
export const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            reject(new Error(message))
        }, ms)
        promise.then(
            value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } },
            error => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } }
        )
    })

/**
 * 校验音源返回的链接是否真的可取，返回 null 表示可用，否则返回不可用原因。
 *
 * 为什么需要它：字符串校验挡不住「URL 长得完全正常、实际是 404」。
 * 实测某源对不存在的歌曲照样返回 `xxx.php?id=000000000&...`，实际请求是 nginx 404 页面，
 * 宿主却判定「✓ 成功返回链接」并就此停止轮询 —— 后面三十多个能真正播放的源一个都不试，
 * 用户点下去就是播放失败。
 *
 * 只把「确定取不到」判为失败：404 / 410 / 5xx。
 * 403 / 401 / 405 更可能是防盗链或 upstream 不支持 HEAD，一律放行，绝不误杀可用的源。
 * 网络错误与超时同样放行 —— 我们只是在做一次尽力的复核。
 */
/**
 * content-type 是否明确是「网页/文本」而不是音频。
 *
 * 用途：识别「源把错误页当成直链返回」这种假成功（实测 `https://music.163.com/404`）。
 * 只认明确列出的文本类型；`application/octet-stream`、`audio/*`、`text/plain`、空值一律不算 ——
 * 大量正常音频直链的 content-type 并不规范（无扩展名文件常被标 text/plain），宁可放过也不能误杀。
 */
export const isTextualContentType = (contentType: unknown): boolean => {
    const t = String(contentType || '').toLowerCase().trim()
    if (!t) return false
    return /^(text\/html|text\/xml|application\/json|application\/xml)\b/.test(t)
}

export const verifyUrlPlayable = async (url: string, sourceName: string, timeoutMs?: number): Promise<string | null> => {
    if ((global.lx && global.lx.config as any) && (global.lx.config as any)['customSource.verifyPlayable'] === false) {
        return null
    }
    let referer = ''
    try { referer = new URL(url).origin } catch { /* ignore */ }
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(referer ? { 'Referer': referer } : {}),
    }
    const agent = await getProxyAgent(url, 'music').catch(() => undefined)
    // 音源直链里带中文文件名时，needle（url.parse）会抛 unescaped characters，
    // 被当成「链接不可播」误杀——这里统一编码后再探测（已编码的 %XX 不受影响）。
    const safeUrl = encodeRequestUrl(url)
    // 复核自身可用的时间预算：取链整体有硬预算，前面的源已经耗掉大部分时，
    // 这里若仍按满额 3s×2 去校验，就会出现「链接已经拿到、却因为复核超时而整条请求判失败」。
    const verifyTimeout = Math.max(500, Math.min(VERIFY_TIMEOUT_MS, Math.round(timeoutMs ?? VERIFY_TIMEOUT_MS)))
    const request = async (method: 'head' | 'get', insecure: boolean = false): Promise<{ code?: number; contentType: string }> => {
        const resp: any = await needle(method, safeUrl, null, {
            follow_max: 2,
            response_timeout: verifyTimeout,
            read_timeout: verifyTimeout,
            agent,
            // 源返回的链接同样过内网护栏：脚本可以不自己发请求，只把 http://127.0.0.1:xxx
            // 当成「直链」返回，让宿主替它去访问
            lookup: privateNetLookup,
            headers: method === 'get' ? { ...headers, Range: 'bytes=0-0' } : headers,
            // insecure：跳过证书校验。needle 会把该选项注入 agent.options，
            // 仅在严格校验因证书类错误抛错后的复核用（见下方 catch 分支）
            ...(insecure ? { rejectUnauthorized: false } : {}),
        })
        const contentType = String((resp?.headers as any)?.['content-type'] || '').toLowerCase()
        return {
            code: typeof resp?.statusCode === 'number' ? resp.statusCode : undefined,
            contentType,
        }
    }
    // 只把「确定取不到」判为失败：404 / 410 / 5xx。
    // 403 / 401 / 405 更可能是防盗链或 upstream 不支持 HEAD，一律放行，绝不误杀可用的源。
    // 网络错误与超时同样放行 —— 我们只是在做一次尽力的复核。
    try {
        const head = await request('head')
        // ① 状态码判死（老逻辑）：HEAD 判死不可尽信 —— 不少 CDN / 防盗链只认 GET，
        //    HEAD 一律回 404 或 405，所以再拿 1 字节的 Range GET 复核一次。
        if (isUnplayableStatusCode(head.code)) {
            const get = await request('get')
            if (!isUnplayableStatusCode(get.code)) return null
            return typeof get.code === 'number' && get.code >= 500
                ? `音源 [${sourceName}] 返回的链接源站报错（HTTP ${get.code}）`
                : `音源 [${sourceName}] 返回的链接实际不存在（HTTP ${get.code}）`
        }
        // ② 状态码 200 也可能根本不是音频（2026-11-05 实测）：
        //    自定义源「回避聚合」对拿不到的歌直接返回 https://music.163.com/404，
        //    那是网易的 404 页面，HTTP 200 + text/html。只查状态码等于放行，
        //    结果「取链成功」→ 前端拉流拿到网页 → 播放失败 → 换源 → 又拿回同一条，死循环。
        //    这里只认**明确的文本类型**（html/json/xml/plain），二进制类型和缺失一律放行，
        //    避免误杀 content-type 不规范的正常音频直链。
        if (isTextualContentType(head.contentType)) {
            const get = await request('get')
            if (!isTextualContentType(get.contentType)) return null
            return `音源 [${sourceName}] 返回的不是音频文件（content-type: ${get.contentType || head.contentType}）`
        }
        return null
    } catch (e: any) {
        // === 证书不匹配 CDN 上的「过期直链」兜底（2026-11-08 soak W-3 实测新增）===
        // 酷狗 CDN 发的是错误共享证书（altnames 无 *.tx.kugou.com），严格校验在 TLS 层
        // 就抛错——原先一律放行，导致这类 CDN 上的 404/410/5xx 死链（典型：带时间戳的
        // 过期直链）从来看不到状态码、照发不误。现在对证书类错误做一次**跳过校验**的复核：
        // 拿到状态码就按同一套「404/410/5xx 判死、其余放行」的口径判定；
        // 仍然连不上（真超时/拒连）→ 放行不误杀。实测同一条好链 -k 探测得 206/2048。
        const code = String(e?.code || '')
        if (/CERT|ALTNAME|LEAF_SIGNATURE|ISSUER|SSL/i.test(code)) {
            try {
                const head2 = await request('head', true)
                if (isUnplayableStatusCode(head2.code)) {
                    const get2 = await request('get', true)
                    if (isUnplayableStatusCode(get2.code)) {
                        return typeof get2.code === 'number' && get2.code >= 500
                            ? `音源 [${sourceName}] 返回的链接源站报错（HTTP ${get2.code}）`
                            : `音源 [${sourceName}] 返回的链接实际不存在（HTTP ${get2.code}）`
                    }
                }
            } catch { /* 复核也失败：按原口径放行，避免误伤 */ }
        }
        // 网络不通、超时、不支持 HEAD —— 一律当作可用，避免误伤
        return null
    }
}

// 调用自定义源的 getMusicUrl
export async function callUserApiGetMusicUrl(
    source: string,
    songInfo: any,
    quality: string,
    clientUsername?: string,
    onProgress?: (attempt: any) => Promise<void> | void,
    enableAutoSwitchApiSource?: boolean,
    excludeApiSources?: string[],
    deadlineAt?: number
): Promise<{ url: string, type: string, sourceName?: string, sourceId?: string, attempts?: any[], hasMoreSources?: boolean, via?: string, key?: string, extraChannel?: boolean }> {
    /**
     * 取到链接后的「可播性复核」要按剩余预算收缩。
     * 复核满额是 HEAD 3s + Range GET 3s = 6s，而调用方（/api/music/url）整体只有 25s 硬预算：
     * 前面若干源串行失败耗掉 20s 后，最后一个源成功、复核却把总时长顶过 25s，
     * 调用方拿到 null → 用户看到「取链超时」500，可实际上链接已经拿到了（2026-10-31 实测复现）。
     */
    const verifyWithBudget = async (url: string, sourceName: string): Promise<string | null> => {
        if (!deadlineAt) return verifyUrlPlayable(url, sourceName)
        const left = deadlineAt - Date.now()
        if (left <= 1200) {
            console.warn(`[自定义源] ${sourceName} 已取到链接，但剩余预算仅 ${Math.max(0, Math.round(left))}ms，跳过可播性复核直接返回`)
            return null
        }
        return verifyUrlPlayable(url, sourceName, Math.min(VERIFY_TIMEOUT_MS, left - 700))
    }
    // 使用权限：后台「平台账号 → 使用权限」名单外的用户不消费账号 Cookie（名单为空=所有人可用）
    const accountAllowed = isUserAllowed(clientUsername)
    // 换源重试时前端会把已试过的源记进排除清单（`extra:soda` / 源名）——
    // 服务端通道同样要遵守，否则「取链成功但拉流 403」的死链会在换源循环里反复命中。
    const extraChannelAllowed = (): boolean => {
        if (!Array.isArray(excludeApiSources) || excludeApiSources.length === 0) return true
        let label = ''
        try { label = String(require('./extraSources').displayName(source) || '').toLowerCase() } catch { }
        return !excludeApiSources.some((n: any) => {
            const s = String(n || '').trim().toLowerCase()
            if (!s) return false
            return s === `extra:${source}` || (!!label && (s === label || s.startsWith(label)))
        })
    }
    // 标准化 songInfo 格式：将 meta 中的字段提升到顶层
    const normalizedSongInfo = { ...songInfo }
    if (songInfo.meta) {
        // 将 meta 中的所有字段展开到顶层
        Object.assign(normalizedSongInfo, songInfo.meta)

        // ========== 通用字段映射 ==========
        // songId -> songmid (通用)
        if (songInfo.meta.songId && !normalizedSongInfo.songmid) {
            normalizedSongInfo.songmid = songInfo.meta.songId
        }

        // 图片字段统一
        if (songInfo.meta.picUrl && !normalizedSongInfo.img) {
            normalizedSongInfo.img = songInfo.meta.picUrl
        }

        // 音质信息
        if (songInfo.meta.qualitys && !normalizedSongInfo.types) {
            normalizedSongInfo.types = songInfo.meta.qualitys
        }
        if (songInfo.meta._qualitys && !normalizedSongInfo._types) {
            normalizedSongInfo._types = songInfo.meta._qualitys
        }

        // ========== 各平台特有字段 ==========
        // 酷狗 (kg): hash, albumId
        if (songInfo.meta.hash && !normalizedSongInfo.hash) {
            normalizedSongInfo.hash = songInfo.meta.hash
        }
        if (songInfo.meta.albumId && !normalizedSongInfo.albumId) {
            normalizedSongInfo.albumId = songInfo.meta.albumId
        }

        // 咪咕 (mg): copyrightId, lrcUrl, mrcUrl, trcUrl
        if (songInfo.meta.copyrightId && !normalizedSongInfo.copyrightId) {
            normalizedSongInfo.copyrightId = songInfo.meta.copyrightId
        }
        if (songInfo.meta.lrcUrl && !normalizedSongInfo.lrcUrl) {
            normalizedSongInfo.lrcUrl = songInfo.meta.lrcUrl
        }
        if (songInfo.meta.mrcUrl && !normalizedSongInfo.mrcUrl) {
            normalizedSongInfo.mrcUrl = songInfo.meta.mrcUrl
        }
        if (songInfo.meta.trcUrl && !normalizedSongInfo.trcUrl) {
            normalizedSongInfo.trcUrl = songInfo.meta.trcUrl
        }

        // QQ音乐 (tx): strMediaMid, albumMid
        if (songInfo.meta.strMediaMid && !normalizedSongInfo.strMediaMid) {
            normalizedSongInfo.strMediaMid = songInfo.meta.strMediaMid
        }
        if (songInfo.meta.albumMid && !normalizedSongInfo.albumMid) {
            normalizedSongInfo.albumMid = songInfo.meta.albumMid
        }

        // 不再删除 meta 对象，以免有些严谨的脚本报错（许多脚本会读取 info.meta）
        // delete normalizedSongInfo.meta
    }

    // ========== 顶层字段兜底映射 ==========
    if (!normalizedSongInfo.hash && songInfo.hash) {
        normalizedSongInfo.hash = songInfo.hash
    }
    if (!normalizedSongInfo.copyrightId && songInfo.copyrightId) {
        normalizedSongInfo.copyrightId = songInfo.copyrightId
    }
    if (!normalizedSongInfo.strMediaMid && songInfo.strMediaMid) {
        normalizedSongInfo.strMediaMid = songInfo.strMediaMid
    }
    if (!normalizedSongInfo.albumMid && songInfo.albumMid) {
        normalizedSongInfo.albumMid = songInfo.albumMid
    }
    if (!normalizedSongInfo.albumId && songInfo.albumId) {
        normalizedSongInfo.albumId = songInfo.albumId
    }
    if (!normalizedSongInfo.lrcUrl && songInfo.lrcUrl) {
        normalizedSongInfo.lrcUrl = songInfo.lrcUrl
    }
    if (!normalizedSongInfo.mrcUrl && songInfo.mrcUrl) {
        normalizedSongInfo.mrcUrl = songInfo.mrcUrl
    }
    if (!normalizedSongInfo.trcUrl && songInfo.trcUrl) {
        normalizedSongInfo.trcUrl = songInfo.trcUrl
    }
    if (typeof normalizedSongInfo.hash === 'string' && !normalizedSongInfo.hash) {
        delete normalizedSongInfo.hash
    }

    // ========== 平台账号优先通道 ==========
    // 配置了某平台自己的会员账号时，先用账号取链：账号能拿到更高音质，
    // 也能播自定义源拿不到的付费曲目。取不到再回落自定义音源，不打断原有链路。
    // accountAllowed：后台「使用权限」名单外的用户不走账号通道（名单为空=所有人可用）。
    if (isEnabled() && isPriority() && accountAllowed) {
        const acct = await tryResolveByAccount(source, normalizedSongInfo, quality)
        if (acct?.url) {
            const platformName = acct.accountName || getPlatform(source)?.name || source
            const attempt = {
                name: `我的${platformName}账号`,
                status: 'success',
                message: `账号直连成功（${acct.via || '账号通道'}${acct.isVip ? '，会员音质' : ''}）`,
            }
            if (onProgress) await onProgress(attempt)
            return {
                url: acct.url,
                type: acct.quality || quality,
                sourceName: `我的${platformName}账号`,
                sourceId: `account:${source}`,
                attempts: [attempt],
                // 只有确实还有自定义源可试时才告诉上层「可换源」，
                // 否则会让播放器显示一个点了也没用的换源按钮
                hasMoreSources: isSourceSupported(source, clientUsername),
                // [R76 修复] key/via 必须透传：汽水签名通道随链下发的 CENC 解密密钥
                // 曾在这里被丢弃，导致上层解密分支永远不触发、带钥加密流被当 DRM 拦掉
                via: acct.via,
                key: acct.key,
            } as any
        }
    }

    // ========== 汽水/B站服务端通道（「首选自己的账号」开 = 服务端通道优先） ==========
    // 与五大平台的账号优先钩子同位：isPriority 开时先走服务端通道（名单内带 Cookie，
    // 名单外匿名），取不到再落脚本循环。key/via 透传给上层（汽水 CENC 解密 / 登录态复核）。
    if (isExtraSourceId(source) && isEnabled() && isPriority() && extraChannelAllowed()) {
        const extra = await resolveViaExtraChannel(source, normalizedSongInfo, quality, clientUsername)
        if (extra) {
            const attempt = { name: extra.sourceName, status: 'success', message: `服务端通道（${extra.via || '直连'}）` }
            if (onProgress) await onProgress(attempt)
            return {
                url: extra.url,
                type: extra.type,
                sourceName: extra.sourceName,
                sourceId: `extra:${source}`,
                attempts: [attempt],
                hasMoreSources: isSourceSupported(source, clientUsername),
                via: extra.via,
                key: extra.key,
            } as any
        }
    }

    let supportedCount = 0;
    let lastError: Error | null = null;

    // 查找支持该 source 的 API
    // 收集所有支持该 source 的 API，并根据权限过滤
    let candidates: any[] = []
    const userApiIds = new Set<string>()

    // 读取当前用户的公开源状态覆盖（启用/禁用）以及私有源 ID 集合
    let userStates: Record<string, any> = {}
    const dataPath = process.env.DATA_PATH || path.join(process.cwd(), 'data')
    if (clientUsername && clientUsername !== 'default' && clientUsername !== 'open') {
        const userPath = path.join(dataPath, 'users', 'source', clientUsername)
        const statesPath = path.join(userPath, 'states.json')
        const metaPath = path.join(userPath, 'sources.json')

        if (fs.existsSync(statesPath)) {
            try { userStates = JSON.parse(fs.readFileSync(statesPath, 'utf-8')) } catch (e) { }
        }
        // 预收集私有源 ID（用于屏蔽同名公开源）
        //
        // 例外：`_open` 是匿名/公共空间，它目录下的 sources.json 就是「公共源清单本身」，
        // 不是某个用户的私有源。若把它当私有源收集，后面每个公共源都会命中
        // `userApiIds.has(api.info.id)` 而被当作「被同名私有版本覆盖」跳过，
        // 结果匿名用户永远没有候选源，取链直接报「未找到支持 xx 平台的自定义源」。
        // 匿名请求（未登录播放器）与小爱投送的匿名分支都会落到这里，影响面很大。
        if (clientUsername !== '_open' && fs.existsSync(metaPath)) {
            try {
                const userSources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
                for (const s of userSources) userApiIds.add(s.id)
            } catch (e) { }
        }
    } else {
        const openStatesPath = path.join(dataPath, 'users', 'source', '_open', 'states.json')
        if (fs.existsSync(openStatesPath)) {
            try { userStates = JSON.parse(fs.readFileSync(openStatesPath, 'utf-8')) } catch (e) { }
        }
    }

    const getSourceState = (id: string) => {
        return userStates[id] || userStates[decodeURIComponent(id)] || userStates[encodeURIComponent(id)] || {}
    }

    // 按载入的 APIs 收集所有可用候选源（权限过滤，不强制任何顺序）
    // 汽水/B站：脚本声明的 key 可能是 qs/qishui/bilibili 等别名，按别名集合匹配。
    const sKeys = scriptPlatformKeys(source)
    for (const [apiId, api] of loadedApis) {
        if (!api.info.sources || !sKeys.some(k => api.info.sources[k])) continue

        const state = getSourceState(api.info.id)

        if (api.info.owner === 'open') {
            // 计算公开源对当前用户的有效启用状态
            let isEnabled = api.info.enabled
            if (clientUsername && clientUsername !== 'default' && clientUsername !== 'open') {
                if (typeof state.enabled === 'boolean') {
                    isEnabled = state.enabled
                }
            }
            if (!isEnabled) continue
            if (userApiIds.has(api.info.id)) continue  // 被同名私有版本覆盖，跳过

            // 检查平台是否被禁用（按脚本声明的 key 判定）
            if (Array.isArray(state.disabledSources) && sKeys.some(k => state.disabledSources.includes(k))) {
                continue
            }

            candidates.push(api)
        } else if (clientUsername && api.info.owner === clientUsername) {
            if (!api.info.enabled) continue

            // 检查平台是否被禁用（按脚本声明的 key 判定）
            if (Array.isArray(state.disabledSources) && sKeys.some(k => state.disabledSources.includes(k))) {
                continue
            }

            candidates.push(api)
            userApiIds.add(api.info.id) // 兜底：确保后续不重复添加公开同名源
        }
    }

    // === 实时按 order.json 对候选列表排序（缺失则冻结当前顺序）===
    // 不依赖 loadedApis 的 Map 插入顺序（部分 reload 后顺序会乱），
    // 每次解析都直接读 order.json，无需重启服务器即可生效。
    //
    // ⚠️ order.json 缺失/没覆盖到某些源时，**绝不能退化成加载完成顺序**：
    // 那是异步竞态（脚本初始化快慢、沙箱启动先后都会影响它），同一份数据两次启动
    // 可能把不同的源排到第一位。实测（2026-11-08 A/B，wy/起风了）两个实例数据与配置
    // 完全相同，只因顺序不同：一个命中 110ms 的源，另一个命中 1.9s 的源，差 17 倍。
    //
    // 处理顺序：
    //   1. 有 order.json → 按它排（用户/面板说了算）；
    //   2. 没有 → 把**当前这份顺序**写进 order.json 冻结一次（不重排、不扰民），
    //      从此重启也稳定。不用「id 字典序」当默认：字典序是任意的，实测会把
    //      慢源顶到最前，白白多花 5.5s；
    //   3. 写盘失败（只读挂载）→ 才退到 id 字典序兜底，至少保证可复现。
    if (candidates.length > 1) {
        const dataPath = process.env.DATA_PATH || path.join(process.cwd(), 'data')
        let orderData: string[] = []

        // 优先读用户自己的排序（admin/order.json），再回退到公开源排序（_open/order.json）
        const orderCandidates = clientUsername && clientUsername !== 'default' && clientUsername !== 'open'
            ? [
                path.join(dataPath, 'users', 'source', clientUsername, 'order.json'),
                path.join(dataPath, 'users', 'source', '_open', 'order.json')
              ]
            : [path.join(dataPath, 'users', 'source', '_open', 'order.json')]

        for (const orderPath of orderCandidates) {
            if (fs.existsSync(orderPath)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(orderPath, 'utf-8'))
                    orderData = Array.isArray(parsed) ? parsed : []
                    if (orderData.length > 0) break
                } catch (e) { }
            }
        }

        if (orderData.length === 0) {
            // 没有排序文件：先把当前顺序冻结落盘，再按这份顺序排 ——
            // 这样「首次启动」和「之后每次启动」用的是同一份顺序。
            //
            // 注意 candidates 是**按平台过滤过**的（只含声明了该平台的源），
            // 只拿它冻结会漏掉其它平台的源（实测 37 个源只冻住 23 个），
            // 漏掉的源在别的平台请求里会被当成「未列出」排到末尾。
            // 所以：本平台候选在前（保持当前生效顺序）+ 同 owner 其余源按加载顺序补齐。
            const snapshotIds: string[] = candidates
                .map((a: any) => String(a?.info?.id || ''))
                .filter(Boolean)
            const seen = new Set(snapshotIds)
            const ownerKey = String(candidates[0]?.info?.owner || 'open')
            for (const [, api] of loadedApis) {
                const info: any = api?.info
                const id = String(info?.id || '')
                if (!id || seen.has(id)) continue
                if (String(info?.owner || '') !== ownerKey) continue
                if (info?.owner === 'open' && info?.enabled === false) continue
                seen.add(id)
                snapshotIds.push(id)
            }

            const writePath = orderCandidates.find(p => {
                try { return fs.existsSync(path.dirname(p)) } catch (e) { return false }
            }) || orderCandidates[orderCandidates.length - 1]
            if (persistOrderSnapshot(writePath, snapshotIds)) orderData = snapshotIds
        }

        const idToIndex = new Map(orderData.map((id, i) => [id, i]))
        candidates = sortCandidatesByOrder(candidates, idToIndex)
    }
    // =========================================

    // === 按历史成绩正向排序：把实测更快的源提到前面 ===
    // 沉底只做减法（坏源靠后），这条做加法。依据是「源 × 平台 × 档」的成功耗时 EWMA
    // 与成功率，样本不足时给中性分、保持原有顺序（见 sourcePlayRank.ts 的注释）。
    // 放在沉底之前：沉底是最终裁决（近期连续失败必须垫底），不能被历史成绩翻盘。
    if (candidates.length > 1 && quality && playRankEnabled()) {
        const ranked = rankCandidatesByHistory(candidates, source, quality)
        if (ranked.some((api: any, i: number) => api !== candidates[i])) {
            console.log(`[自定义源] 按历史成绩重排 ${source}/${quality} 候选：${ranked.slice(0, 5).map((a: any) => a.info?.name).join(' > ')}`)
            candidates = ranked
        }
    }

    // === 运行时沉底：近期反复失败的音源排到队尾 ===
    // 不写 states.json、不禁用、不删源——只改变尝试顺序。
    // 目的是让「已知是坏的源」不再挡在前面白白吃掉几秒，而不是把它从池子里拿掉：
    // 手动取链是单首歌单次失败，无版权/已下架这类软失败占比很高，凭一次失败禁用会误伤一批。
    // 沉底只认「同一平台近期连续失败」，且该源任意一次成功即立刻恢复原位。
    if (candidates.length > 1 && playSinkEnabled()) {
        const { fresh, sunk } = partitionByPlaySink(candidates, source)
        // === 平台级故障护栏（2026-11-08 soak 实测新增）===
        // 3h soak 里出现过「15 个近期失败的音源已排到队尾」——连 kg 上最快的 K×H测试 都在
        // 名单里。成因是 kg 搜索风控空返回这类**平台级**临时故障：15 分钟窗口内把所有 kg 源
        // 各记了一次失败，沉底账本忠实反映成了一个大名单。这不是 15 个源同时坏了，
        // 按单源沉底重排只会把优源压到队尾、下首歌再绕一遍。所以：单平台沉底名单
        // 达到 PLATFORM_SINK_CALM_MIN 个且占候选 1/3 以上时，判为平台级故障窗口，
        // 本轮不做单源沉底（保持 playRank 排好的顺序）；失败记录仍在，「成功即恢复」
        // 与窗口过期机制照常洗白，平台恢复后名单自然收敛。
        if (sunk.length && fresh.length && isPlatformSinkWindow(sunk.length, candidates.length)) {
            console.log(`[自定义源] ${source} 平台 ${sunk.length}/${candidates.length} 个源近期失败，` +
                `疑似平台级故障窗口，本轮不按单源沉底重排（成功即恢复机制不变）`)
        } else if (sunk.length && fresh.length) {
            candidates = [...fresh, ...sunk]
            console.log(`[自定义源] ${sunk.length} 个近期失败的音源已排到队尾（不禁用、成功即恢复）：` +
                sunk.map((a: any) => a.info?.name).join('、'))
        }
    }

    // === 排除已在当前请求中上报失败/失效的自定义源 ===
    if (Array.isArray(excludeApiSources) && excludeApiSources.length > 0) {
        const excludeSet = new Set(excludeApiSources.map(s => String(s).trim().toLowerCase()))
        candidates = candidates.filter(api => {
            const name = (api.info?.name || '').trim().toLowerCase()
            const id = (api.info?.id || '').trim().toLowerCase()
            return !excludeSet.has(name) && !excludeSet.has(id)
        })
    }

    // === 按「源 × 平台 × 音质档」排序：这一档已证明必败的源排到队尾 ===
    // 与沉底的分工：沉底是「这个源在这个平台不行」→ 排到队尾但仍会试；
    // 这里是「这个源的这一档不行」→ 优先发给别的源，省掉整段超时预算，
    // 让真正能出这一档的源早点上场（flac 档尤其明显：一个壳源能耗掉十几秒）。
    // 铁律：账本只允许省掉白跑，不允许造成无源可用 ——
    // 所以被短路的源**排到队尾兜底**而不是本次不发：前面有源成功就白省了，
    // 前面全败时它们还会被试一次，误判只让这次慢一拍，不会变成播放失败。
    if (qualityLedgerEnabled() && candidates.length > 0 && quality) {
        const plan = applyQualityLedger(candidates, source, quality)
        if (plan.blocked.length > 0) {
            const names = plan.blocked.map((a: any) => a.info?.name).join('、')
            if (plan.rescuedAll) {
                console.log(`[自定义源] ${source}/${quality} 档的源全部处于短路期，本次忽略账本放行探路：${names}`)
            } else {
                candidates = plan.candidates
                console.log(`[自定义源] ${plan.blocked.length} 个音源在 ${source}/${quality} 档已连续失败且零成功，` +
                    `本次排到队尾兜底（前面的源全败才试）：${names}`)
            }
        }
    }

    if (enableAutoSwitchApiSource === false && candidates.length > 1) {
        candidates = [candidates[0]]
    }

    // === ε-greedy 试探（2026-11-09 Y.11 修复「账本锁定」）===
    // 排序/沉底/冷却全是「证据优先」：首选源持续成功时，一个本平台没被证明过（或旧失败）
    // 的源永远不会被尝试——实测最快源失败一次后 10 首 0 次被试（280ms/首），生产 tx 上
    // 84ms 的西瓜聚合源全程 0 次尝试。这里做反向探索：首选被证明稳定后，周期性给
    // 「本平台未证明 + 有跨平台成功史」的源一次队首先手，预算收紧到 PROBE_BUDGET_MS。
    // 成功 → 记录重置重新洗牌（noteProbeSuccessReset）；失败 → 照常记账，代价有界。
    // 只在 playRank 开关开启时生效（它是排序策略的一部分，不是独立机制）。
    let probeApi: any
    if (candidates.length >= 3 && playRankEnabled()) {
        const probe = planProbeCandidate(candidates, source, quality)
        if (probe?.api) {
            probeApi = probe.api
            const rest = candidates.filter((a: any) => a !== probeApi)
            candidates = [probeApi, ...rest]
            console.log(`[自定义源] ε-greedy 试探：首选 ${rest[0]?.info?.name} 稳定成功，` +
                `给 ${probeApi.info?.name} 一次队首先手（预算 ${PROBE_BUDGET_MS}ms；` +
                `成功清记录重排，失败照常记账）`)
        }
    }

    supportedCount = candidates.length

    if (supportedCount === 0) {
        // 没有任何自定义源可用时，账号就是唯一出路 —— 这种情况不该受「优先级」影响，
        // 否则会出现「明明配了会员账号，却因为没装自定义源而播不了」。
        if (isEnabled() && accountAllowed) {
            const acct = await tryResolveByAccount(source, normalizedSongInfo, quality)
            if (acct?.url) {
                const platformName = acct.accountName || getPlatform(source)?.name || source
                const attempt = {
                    name: `我的${platformName}账号`,
                    status: 'success',
                    message: `无可用自定义源，账号直连成功（${acct.via || '账号通道'}${acct.isVip ? '，会员音质' : ''}）`,
                }
                if (onProgress) await onProgress(attempt)
                return {
                    url: acct.url,
                    type: acct.quality || quality,
                    sourceName: `我的${platformName}账号`,
                    sourceId: `account:${source}`,
                    attempts: [attempt],
                    hasMoreSources: false,
                    // [R76 修复] 同上：透传汽水 CENC 解密密钥与通道名
                    via: acct.via,
                    key: acct.key,
                } as any
            }
        }

        // 汽水/B站：无任何脚本声明 qs/bili 时，服务端通道是唯一出路（匿名也可用，
        // 不受账号总开关限制 —— 公共匿名通道保持既有可用性）。
        if (isExtraSourceId(source)) {
            const extra = await resolveViaExtraChannel(source, normalizedSongInfo, quality, clientUsername)
            if (extra) {
                const attempt = { name: extra.sourceName, status: 'success', message: `无可用自定义源，服务端通道兜底（${extra.via || '直连'}）` }
                if (onProgress) await onProgress(attempt)
                return {
                    url: extra.url,
                    type: extra.type,
                    sourceName: extra.sourceName,
                    sourceId: `extra:${source}`,
                    attempts: [attempt],
                    hasMoreSources: false,
                    via: extra.via,
                    key: extra.key,
                } as any
            }
        }

        const hasExcluded = Array.isArray(excludeApiSources) && excludeApiSources.length > 0
        const accountTried = isEnabled() && isSupportedSource(source)
        let errMsg: string
        if (hasExcluded) {
            errMsg = `支持 ${source} 平台的自定义源均已被本次请求排除（已排除 ${excludeApiSources.length} 个音源），无可用源可播放`
        } else if (accountTried) {
            errMsg = `未找到支持 ${source} 平台的自定义源，你配置的账号本次也未能取到链接（详见服务端日志 [平台账号]）`
        } else {
            errMsg = `未找到支持 ${source} 平台的自定义源，请在设置中添加或启用相关源`
        }
        if (onProgress) await onProgress({ name: '系统', status: 'fail', message: errMsg })
        const err: any = new Error(errMsg)
        err.allSourcesExhausted = true
        throw err
    }

    // 逻辑分歧：
    // 1. 如果只有一个源支持 -> 重试 3 次
    // 2. 如果有多个源支持 -> 每个源试一次 (轮询)

    const attempts: any[] = []
    // 单个音源取链的超时上限：脚本内部可能串行试十几个后端，默认给 20s。
    const callTimeoutMs = configNumber('customSource.callTimeoutMs', DEFAULT_CALL_TIMEOUT_MS)
    /**
     * 调用方给了整体 deadline 时，单个源的超时要按**剩余预算 / 剩余源数**分配。
     *
     * 实测（2026-11-03 17:29，tx《起风了》）：25 秒硬预算被第一个聚合源一次吃光 ——
     * 它自带 20 秒超时、内部串行试 12 个后端，等它失败时只剩 5 秒，
     * 后面的源连上场机会都没有；而排在后面的星澜其实 0.9 秒就能出链。
     * 更糟的是调用方 25 秒返回 500 之后，这层循环还在挨个源继续请求，
     * 17:29:49 才在后台拿到链（白打 20 秒上游）。
     *
     * 所以两点：
     * 1. 单源超时 = (剩余预算 - 800ms) / 剩余源数，下限 5 秒 —— 保证每个源都能上场；
     * 2. 预算见底（<1.5s）立即跳出，不再后台空转。
     */
    const budgetForSource = (api: any, remainingSources: number): number => {
        if (!deadlineAt) return callTimeoutMs
        const left = deadlineAt - Date.now()
        const share = Math.floor((left - 800) / Math.max(1, remainingSources))
        // 地板不再固定 5000ms：按该源的历史成绩收紧（见 sourcePlayRank.adaptiveTimeoutMs）。
        // 只对「已证明很快」的源生效（EWMA×4 夹在 3~5s），无样本/慢源仍是 5s ——
        // 目的是让挂死的快源早 2 秒换人，而不是把慢源判死。
        const floor = adaptiveTimeoutMs({
            owner: String(api?.info?.owner || ''),
            id: String(api?.info?.id || ''),
            platform: source,
            quality: quality || '',
        })
        return Math.max(floor, Math.min(callTimeoutMs, share))
    }
    const budgetExhausted = (): boolean => !!deadlineAt && deadlineAt - Date.now() < 1500
    // 本轮取链里失败的音源（用于轮末把硬故障证据交给巡检）
    const roundFailures: Array<{ api: any; message: string }> = []

    // 本轮实际调脚本时传「脚本声明的 key」（qs/bilibili 等），别在脚本内部做归一
    const scriptKeyFor = (api: any): string => sKeys.find(k => api.info?.sources?.[k]) || source

    /**
     * 记一次「源 × 平台 × 档」的结果。
     * 只影响下次要不要跳过这一档，绝不参与启停决策；任何异常都吞掉，不能影响取链。
     *
     * 两条准入限制（都是实测踩出来的）：
     *  1. **限流不进账本**：429 是平台临时状态，源没坏。混进来 3 次就能把一个好档
     *     短路一小时，与 sourceRateLimit.ts 的设计直接冲突。
     *  2. **同一轮内同一源只记一次失败**：单源场景会重试 3 次，三次全是同一首歌、
     *     同一时刻的连续失败，属于同一个事件。按次计数会让 minSamples=3 退化成
     *     「一次播放请求就短路一小时」，一首本来就没版权的歌能把整个档封掉。
     */
    const qualityFailNoted = new Set<string>()
    const noteQuality = (api: any, ok: boolean, failMessage?: string): void => {
        if (!quality) return
        if (!ok && failMessage && isRateLimitFailure(failMessage)) return
        const key = `${api?.info?.owner || ''}:${api?.info?.id || ''}`
        if (!ok) {
            if (qualityFailNoted.has(key)) return
            qualityFailNoted.add(key)
        }
        try {
            noteQualityResult(
                {
                    owner: String(api?.info?.owner || ''),
                    id: String(api?.info?.id || ''),
                    platform: source,
                    quality,
                },
                ok,
            )
        } catch { /* 记账失败不影响播放 */ }
    }

    /**
     * 记一次尝试的「成绩」：成功耗时进 EWMA，失败只加计数。
     * 与档位账本分开：账本管「要不要跳过这一档」，这里只管「下次谁先上」。
     */
    const notePlayPerf = (api: any, ok: boolean, costMs: number = 0): void => {
        if (!quality) return
        try {
            notePlayResult(
                {
                    owner: String(api?.info?.owner || ''),
                    id: String(api?.info?.id || ''),
                    platform: source,
                    quality,
                },
                ok,
                costMs,
            )
        } catch { /* 排序统计失败不影响播放 */ }
    }

    if (supportedCount === 1) {
        const api = candidates[0]
        const maxRetries = 3

        for (let i = 0; i < maxRetries; i++) {
            if (budgetExhausted()) break
            const perTimeout = budgetForSource(api, maxRetries - i)
            try {
                console.log(`[自定义源] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (第 ${i + 1}/${maxRetries} 次, 所属: ${api.info.owner})`)
                const attemptStartedAt = Date.now()

                const rawUrl = await withTimeout(
                    api.callRequest('musicUrl', scriptKeyFor(api), {
                        musicInfo: normalizedSongInfo,
                        quality: quality,
                        type: quality
                    }),
                    perTimeout,
                    `音源 [${api.info.name}] 取链超时（超过 ${perTimeout}ms 未返回）`
                )
                const url = validateReturnedMusicUrl(rawUrl, api.info.name)
                // 字符串校验挡不住「URL 正常但请求下来是 404」——实测某源对不存在的歌
                // 照样返回可解析的链接，宿主判成功后停止轮询，用户点开就是播放失败。
                const unplayable = await verifyWithBudget(url, api.info.name)
                if (unplayable) throw new Error(unplayable)

                console.log(`[自定义源] ✓ ${api.info.name} 成功返回链接 (所属: ${api.info.owner})`)
                clearPlayFailure(api, source)
                noteQuality(api, true)
                notePlayPerf(api, true, Date.now() - attemptStartedAt)
                // 单源场景没有对照组（没人证明这首歌能播），只记账不处置
                reportPlayHardFailures(roundFailures, source, false)
                const att = { name: api.info.name, status: 'success', message: `第 ${i + 1} 次尝试成功` }
                attempts.push(att)
                if (onProgress) await onProgress(att)
                return { url, type: quality, sourceName: api.info.name, sourceId: api.info.id, attempts, hasMoreSources: false }
            } catch (error: any) {
                console.error(`[自定义源] ${api.info.name} 失败 (第 ${i + 1}/${maxRetries} 次):`, `音源日志：${describeError(error)}`)
                lastError = error
                notePlayFailure(api, source, describeError(error))
                noteQuality(api, false, describeError(error))
                notePlayPerf(api, false)
                roundFailures.push({ api, message: describeError(error) })
                const att = { name: api.info.name, status: 'fail', message: `第 ${i + 1} 次尝试失败,音源日志：${describeError(error)}` }
                attempts.push(att)
                if (onProgress) await onProgress(att)
                // 如果不是最后一次尝试，等待一小会儿
                if (i < maxRetries - 1) {
                    await new Promise(r => setTimeout(r, 1000))
                }
            }
        }
    } else {
        // 多个源，轮流尝试。分两轮：第一轮跳过处于「回源超时冷却」的源，
        // 全部常规源失败后第二轮再试它们（冷却只改顺序、不剥夺机会，可用性不变）
        const { hot, cooled } = partitionByCooldown(candidates, source)
        if (cooled.length) {
            console.log(`[自定义源] ${cooled.length} 个音源处于回源超时冷却期（先跳过，全败后兜底再试）：` +
                cooled.map((a: any) => a.info?.name).join('、'))
        }
        // === 冷却源兜底提前（2026-11-08 soak c18/c77/c80 实测新增）===
        // 原先冷却源必须等**全部**常规源失败才上场，三个「同源却更慢」样本（最高 7.4s）的
        // 共同模式是：冷却中的源其实已经恢复，却要陪跑完前面所有失败。改为——
        // 常规源只剩最后 2 个未试时，把**曾成功过的**冷却源插到它们前面先试；
        // 从没成功过的冷却源仍留队尾（没有证据说明它好，提前只会白吃超时）。
        // 「曾成功过」看 playRank 跨档先验（同源任意平台/档位有成功记录即算），
        // 与排序开关无关——这是历史事实，不是策略。
        // 只影响顺序：冷却源若仍失败，后面剩下的常规源照常试，可用性不变。
        const priors = buildPlayRankPriors()
        const provenByHistory = (api: any): boolean => {
            const entry = priors.byKey.get(`${api?.info?.owner || ''}:${api?.info?.id || ''}`)
            return !!(entry && Number.isFinite(entry.anyKey))
        }
        const plan = planCooldownSequence(hot, cooled, provenByHistory, COOLDOWN_PROMOTE_LEFT)
        if (plan.promoted.length) {
            console.log(`[自定义源] ${plan.promoted.length} 个冷却中的源有历史成功记录，` +
                `提前到剩余 ${COOLDOWN_PROMOTE_LEFT} 个常规源之前兜底：` +
                plan.promoted.map((a: any) => a.info?.name).join('、'))
        }
        const passSeq: Array<{ api: any; inCooldownPass: boolean }> = [
            ...plan.head.map((api: any) => ({ api, inCooldownPass: false })),
            ...plan.promoted.map((api: any) => ({ api, inCooldownPass: true })),
            ...plan.tail.map((api: any) => ({ api, inCooldownPass: false })),
            ...plan.restCooled.map((api: any) => ({ api, inCooldownPass: true })),
        ]
        for (let candidateIndex = 0; candidateIndex < passSeq.length; candidateIndex++) {
            const { api, inCooldownPass } = passSeq[candidateIndex]
            // 预算见底就别再挨个源打了：调用方早就返回 500，这里继续请求只是白烧上游配额
            if (budgetExhausted()) break
            // 试探源预算收紧：挂了最多白吃 PROBE_BUDGET_MS，不会拖垮整体 deadline
            const perTimeout = api === probeApi
                ? Math.max(1000, Math.min(PROBE_BUDGET_MS, budgetForSource(api, passSeq.length - candidateIndex)))
                : budgetForSource(api, passSeq.length - candidateIndex)
            try {
                console.log(`[自定义源] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (所属: ${api.info.owner}${inCooldownPass ? ', 冷却兜底轮' : ''})`)
                const attemptStartedAt = Date.now()

                const rawUrl = await withTimeout(
                    api.callRequest('musicUrl', scriptKeyFor(api), {
                        musicInfo: normalizedSongInfo,
                        quality: quality,
                        type: quality
                    }),
                    perTimeout,
                    `音源 [${api.info.name}] 取链超时（超过 ${perTimeout}ms 未返回）`
                )
                const url = validateReturnedMusicUrl(rawUrl, api.info.name)
                // 同上：链接长得正常但请求下来是 404，必须判失败并继续试下一个源，
                // 否则「第一个源假成功」会把后面几十个真能播的源全挡住。
                const unplayable = await verifyWithBudget(url, api.info.name)
                if (unplayable) throw new Error(unplayable)

                console.log(`[自定义源] ✓ ${api.info.name} 成功返回链接 (所属: ${api.info.owner})`)
                clearPlayFailure(api, source)
                noteQuality(api, true)
                if (api === probeApi) {
                    // 试探成功 = 旧惩罚判错了：清记录重置，让它从这次成功重新参与竞争
                    // （照常记账的话 50% 失败率惩罚会把它压回队尾，试探白做）
                    noteProbeSuccessReset(
                        {
                            owner: String(api?.info?.owner || ''),
                            id: String(api?.info?.id || ''),
                            platform: source,
                            quality,
                        },
                        Date.now() - attemptStartedAt,
                    )
                    console.log(`[自定义源] ε-greedy 试探成功：${api.info.name} 记录已重置，下次请求按新成绩参与排序`)
                } else {
                    notePlayPerf(api, true, Date.now() - attemptStartedAt)
                }
                // 本源成功 = 这首歌在这个平台确定可播 → 本轮硬故障失败的源有了对照组
                reportPlayHardFailures(roundFailures, source, true)
                const att = { name: api.info.name, status: 'success' }
                attempts.push(att)
                if (onProgress) await onProgress(att)
                return {
                    url,
                    type: quality,
                    sourceName: api.info.name,
                    sourceId: api.info.id,
                    attempts,
                    hasMoreSources: candidateIndex < passSeq.length - 1
                }
            } catch (error: any) {
                const failMsg = describeError(error)
                console.error(`[自定义源] ${api.info.name} 失败:`, `音源日志：${failMsg}`)
                lastError = error
                notePlayFailure(api, source, failMsg)
                noteQuality(api, false, failMsg)
                notePlayPerf(api, false)
                notePlayCooldown(api, source, failMsg)
                roundFailures.push({ api, message: failMsg })
                const att = { name: api.info.name, status: 'fail', message: `音源日志：${failMsg}` }
                attempts.push(att)
                if (onProgress) await onProgress(att)
                continue
            }
        }
    }

    // ========== 账号兜底通道 ==========
    // 配置为「自定义源优先」时，所有源都失败才轮到自己的账号。
    // 这条路径的意义在于：自定义源拿不到（版权受限/源挂了）时，会员账号可能还能播。
    if (isEnabled() && !isPriority() && accountAllowed) {
        const acct = await tryResolveByAccount(source, normalizedSongInfo, quality)
        if (acct?.url) {
            const platformName = acct.accountName || getPlatform(source)?.name || source
            const attempt = {
                name: `我的${platformName}账号`,
                status: 'success',
                message: `自定义源全部失败，账号兜底成功（${acct.via || '账号通道'}）`,
            }
            if (onProgress) await onProgress(attempt)
            return {
                url: acct.url,
                type: acct.quality || quality,
                sourceName: `我的${platformName}账号`,
                sourceId: `account:${source}`,
                attempts: [...attempts, attempt],
                hasMoreSources: false,
                // [R76 修复] 同上：透传汽水 CENC 解密密钥与通道名
                via: acct.via,
                key: acct.key,
            } as any
        }
    }

    // ========== 汽水/B站服务端兜底通道 ==========
    // 脚本循环全败后落服务端通道（extraSources）：名单内带 Cookie、名单外匿名。
    // 匿名流是公开音源，不受账号总开关限制 —— 保持「无脚本也能播汽水/B站」的既有可用性。
    if (isExtraSourceId(source) && extraChannelAllowed()) {
        const extra = await resolveViaExtraChannel(source, normalizedSongInfo, quality, clientUsername)
        if (extra) {
            const attempt = { name: extra.sourceName, status: 'success', message: `脚本源全部失败，服务端通道兜底（${extra.via || '直连'}）` }
            if (onProgress) await onProgress(attempt)
            return {
                url: extra.url,
                type: extra.type,
                sourceName: extra.sourceName,
                sourceId: `extra:${source}`,
                attempts: [...attempts, attempt],
                hasMoreSources: false,
                via: extra.via,
                key: extra.key,
            } as any
        }
    }

    // 全部失败：没有任何音源证明这首歌能播，只把硬故障记进账本，不做任何处置
    reportPlayHardFailures(roundFailures, source, false)

    const detailMsg = supportedCount === 1
        ? `自定义源 [${candidates[0].info.name}] 解析失败`
        : `已尝试了 ${supportedCount} 个支持 ${source} 平台的源，但全部解析失败`

    const finalError: any = new Error(`${detailMsg} (音源日志: ${describeError(lastError)})`)
    finalError.attempts = attempts
    throw finalError
}

// 辅助函数：加载单个音源（全量加载与增量重载共用同一实现，保证行为一致）
// 返回值 needsSave 表示该音源的元数据（支持平台列表/版本等）发生了变化，需要回写 sources.json
/**
 * 加载埋点包装：脚本加载/重载要在主线程同步 eval 整个脚本（实测 61KB 脚本约 6 秒），
 * 期间事件循环被完全独占。把这段时间窗记进活动账本，卡顿归因才能把
 * 「谁正在加载」列为嫌疑人——此前这类卡顿一律归因失败。
 */
async function loadOneSource(
    dirPath: string,
    owner: string,
    source: any,
    stats: { loadedCount: number; isolatedCount?: number }
): Promise<{ needsSave: boolean }> {
    noteLoadStart(owner, source.id, source.name)
    try {
        return await loadOneSourceInner(dirPath, owner, source, stats)
    } finally {
        noteLoadEnd(owner, source.id, source.name)
    }
}

async function loadOneSourceInner(
    dirPath: string,
    owner: string,
    source: any,
    stats: { loadedCount: number; isolatedCount?: number }
): Promise<{ needsSave: boolean }> {
    const apiKey = `${owner}_${source.id}`

    // 禁用的音源一律不再加载执行（含公开源）：
    // 此前仅 owner 非 open 时才跳过，导致面板禁用公开源只挡住路由、
    // 脚本照常执行——自带定时器/探测循环的音源（如 600s 健康探测）会继续烧 CPU。
    // 热切换（custom-source/toggle → reloadSingleSource）也因此对公开源失效。
    if (!source.enabled) {
        console.log(`[自定义源] [${owner}] 跳过已禁用: ${source.name}`)
        apiStatus.delete(apiKey)
        // 增量场景下必须显式移除旧实例，否则禁用后仍会残留在 loadedApis 中被调用
        unloadLoadedApi(apiKey)
        return { needsSave: false }
    }

    const scriptPath = path.join(dirPath, source.id)
    if (!fs.existsSync(scriptPath)) {
        console.warn(`[自定义源] [${owner}] 脚本文件未找到: ${source.id}`)
        unloadLoadedApi(apiKey)
        return { needsSave: false }
    }

    try {
        const script = fs.readFileSync(scriptPath, 'utf-8')
        // 记录脚本内容指纹：文件监控只在内容真的变了时才重载（见 watcher 里的判断）。
        // 音源脚本经常自己往目录里写文件（自愈保存、缓存落盘等），
        // 如果只看「文件变了」就重载，就会形成
        // 「重载(2~3 秒同步 eval) → 脚本再写文件 → 再重载」的自激循环，
        // 期间整个事件循环被卡住，正在下发的音频会断流。
        loadedScriptHashes.set(`${owner}/${source.id}`, crypto.createHash('sha1').update(script).digest('hex'))
        const metadata = extractMetadata(script)

        // [自检护栏] 加载前体检：命中 A 级特征（反调试自旋 / 空死循环 / 沙箱逃逸）时按策略隔离。
        // 隔离只是内存态跳过加载，不改写 sources.json、不删除脚本文件；
        // 脚本内容一更新（指纹变化）隔离会自动解除。
        const guardDecision = reviewSourceScript(
            { owner, id: source.id, name: metadata.name || source.name },
            script
        )
        if (guardDecision.flag) {
            const guardReasons = guardDecision.flag.reasons.join('+')
            if (guardDecision.isolate) {
                console.warn(`[自检护栏] ⚠ 命中高危特征，已隔离: ${guardDecision.flag.name} (${source.id}) 原因=${guardDecision.reason}`)
            } else if (guardDecision.flag.level === 'A') {
                console.warn(`[自检护栏] ⚠ 命中高危特征（告警模式，未隔离）: ${guardDecision.flag.name} (${source.id}) 原因=${guardReasons}`)
            } else {
                console.warn(`[自检护栏] ⓘ 命中可疑特征（仅标记，不隔离）: ${guardDecision.flag.name} (${source.id}) 原因=${guardReasons}`)
            }
        }
        if (guardDecision.isolate) {
            // 持久隔离记录命中时 flag 可能为 null（上次运行隔离的），这里必须留痕，
            // 否则音源「莫名消失」在日志里没有任何解释。
            if (!guardDecision.flag) {
                console.warn(`[自检护栏] ⓘ 命中既有隔离记录，跳过加载: ${metadata.name || source.name} (${source.id}) 原因=${guardDecision.reason}`)
            }
            apiStatus.set(apiKey, { status: 'failed', error: `已被自检护栏隔离（${describeIsolationReason(guardDecision.reason)}）` })
            unloadLoadedApi(apiKey)
            stats.isolatedCount = (stats.isolatedCount || 0) + 1
            return { needsSave: false }
        }

        const result = await loadUserApi({
            id: source.id,
            name: metadata.name || source.name,
            description: metadata.description || '',
            version: metadata.version || 1,
            author: metadata.author || '',
            homepage: metadata.homepage || '',
            script,
            sources: {},
            enabled: source.enabled, // 传递原本的开关状态
            allowUnsafeVM: source.allowUnsafeVM, // 传递不安全模式标志
            owner: owner // 设置 owner
        })

        if (result.success) {
            stats.loadedCount++
            const prevStatus = apiStatus.get(apiKey)
            apiStatus.set(apiKey, {
                status: 'success',
                updateAlert: result.updateAlert || prevStatus?.updateAlert
            })

            // [Self-Healing] 检查并修复 supportedSources
            const runtimeSources = Object.keys(result.apiInstance.info.sources).sort();
            const storedSources = (source.supportedSources || []).sort();

            if (JSON.stringify(runtimeSources) !== JSON.stringify(storedSources)) {
                console.log(`[自定义源] [自动修复] [${owner}] 更新源 ${source.name} 的支持列表: ${JSON.stringify(storedSources)} -> ${JSON.stringify(runtimeSources)}`);
                source.supportedSources = runtimeSources;
                if (metadata.version && source.version !== metadata.version) source.version = metadata.version;
                if (metadata.author && source.author !== metadata.author) source.author = metadata.author;
                if (metadata.description && source.description !== metadata.description) source.description = metadata.description;
                if (metadata.homepage && source.homepage !== metadata.homepage) source.homepage = metadata.homepage;
                return { needsSave: true };
            }
        } else {
            console.error(`[自定义源] [${owner}] 加载 ${metadata.name || source.name} 失败: ${result.error}`)
            apiStatus.set(apiKey, { status: 'failed', error: result.error, updateAlert: result.updateAlert })
            // 加载失败时清掉旧实例，避免继续使用过期脚本
            unloadLoadedApi(apiKey)
        }
    } catch (error: any) {
        console.error(`[自定义源] [${owner}] 加载 ${source.name} 失败:`, error.message)
        apiStatus.set(apiKey, { status: 'failed', error: error.message, updateAlert: error.updateAlert })
        unloadLoadedApi(apiKey)
    }
    return { needsSave: false }
}

// 辅助函数：加载指定目录下的源
async function loadSourcesFromDir(dirPath: string, owner: string, stats: { loadedCount: number; isolatedCount?: number }) {
    const metaPath = path.join(dirPath, 'sources.json')
    if (!fs.existsSync(metaPath)) {
        return
    }

    try {
        let sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        let needsSave = false

        // === 按 order.json 排序，确保 loadedApis 插入顺序 = 用户配置的优先级顺序 ===
        const orderPath = path.join(dirPath, 'order.json')
        if (fs.existsSync(orderPath)) {
            try {
                const order: string[] = JSON.parse(fs.readFileSync(orderPath, 'utf-8'))
                if (order.length > 0) {
                    const idToIndex = new Map(order.map((id, i) => [id, i]))
                    sources = [...sources].sort((a: any, b: any) => {
                        const ia = idToIndex.has(a.id) ? idToIndex.get(a.id)! : 999999
                        const ib = idToIndex.has(b.id) ? idToIndex.get(b.id)! : 999999
                        return ia - ib
                    })
                }
            } catch (e) { }
        }
        // =========================================================================

        for (const [index, source] of sources.entries()) {
            // 逐个音源之间让出事件循环（setImmediate 是真让步，await 产生的微任务让步不算）：
            // vm 编译/执行音源脚本是同步重活，几十个源会糊成一整块 2~3 秒的卡顿，
            // 期间 HTTP 请求与音频下发全部停顿。分片后每次只堵单个脚本的时长（几十毫秒）。
            if (index > 0) {
                await new Promise<void>(resolve => { setImmediate(resolve) })
            }
            const res = await loadOneSource(dirPath, owner, source, stats)
            if (res.needsSave) needsSave = true
        }

        if (needsSave) {
            // 在保存前更新该用户的最后操作时间，防止启动时 Self-Healing 触发 watcher 重复重载
            lastReloadMap.set(owner, Date.now())
            // Write back using the original (file-order) sources array to avoid overwriting sources.json ordering
            const originalSources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            const updatedMap = new Map(sources.map((s: any) => [s.id, s]))
            const merged = originalSources.map((s: any) => updatedMap.get(s.id) || s)
            fs.writeFileSync(metaPath, JSON.stringify(merged, null, 2));
            console.log(`[自定义源] [${owner}] 已更新 sources.json 元数据`);
        }
    } catch (error: any) {
        console.error(`[自定义源] [${owner}] 读取 sources.json 失败:`, error.message)
    }
}

/** 从 loadedApis 中移除实例，并释放其登记的定时器与在途请求。 */
function unloadLoadedApi(apiKey: string) {
    const old = loadedApis.get(apiKey)
    if (old) {
        loadedApis.delete(apiKey)
        try { old.dispose?.() } catch (e) { }
    }
    // 清掉活动账本：音源已卸载，账本不该继续把它列为卡顿嫌疑人
    if (old?.info?.owner && old?.info?.id) {
        resetActivity(old.info.owner, old.info.id)
        disposeSourceWorker(old.info.owner, old.info.id)
        return
    }
    const idx = apiKey.indexOf('_')
    if (idx > 0) {
        resetActivity(apiKey.slice(0, idx), apiKey.slice(idx + 1))
        disposeSourceWorker(apiKey.slice(0, idx), apiKey.slice(idx + 1))
    }
}

/** 释放某个用户空间下所有已加载实例（全量重载前调用）。 */
function unloadOwnerApis(owner: string) {
    const keys: string[] = []
    for (const [key, api] of loadedApis.entries()) {
        if (api?.info?.owner === owner) keys.push(key)
    }
    for (const key of keys) unloadLoadedApi(key)
}

/**
 * 增量重载单个音源：仅卸载并重新解析目标音源，其余音源实例完全不受影响。
 *
 * 这是修复「每导入/启用/禁用/删除一个音源，都会把该空间全部音源重新解析一遍」
 * 所导致的 O(n²) CPU 放大的核心改动：单次操作的解析成本由 O(n) 降为 O(1)。
 */
export async function reloadSingleSource(owner: string, sourceId: string): Promise<{ success: boolean; error?: string }> {
    const dataPath = process.env.DATA_PATH || path.join(process.cwd(), 'data')
    const sourceRoot = path.join(dataPath, 'users', 'source')
    const dirName = owner === 'open' ? '_open' : owner
    const dirPath = path.join(sourceRoot, dirName)
    const metaPath = path.join(dirPath, 'sources.json')
    const apiKey = `${owner}_${sourceId}`
    // 保留当前有效优先级；替换实例后再恢复 Map 顺序，避免单源更新意外改变回退顺序
    const previousOrder = Array.from(loadedApis.values()).map(api => api?.info?.id).filter(Boolean)

    // [自检护栏] 增量重载同样属于正常负载，标记忙碌避免误判
    markSourceBusy()
    lastReloadMap.set(owner, Date.now())

    // 先卸载旧实例：既避免加载失败时残留旧脚本，也保证定时器被释放
    unloadLoadedApi(apiKey)
    apiStatus.delete(apiKey)

    // 脚本换新 = 旧证据作废：档位短路和限流退避都是针对**旧实现**的判断。
    // 不清的话，作者修好脚本后我们还会按老账把人挡在门外（还得等一小时才放行探路）。
    // 这是这几本账唯一该整体清空的时机 —— 不是每次取链成功都清。
    try {
        clearQualityLedger(owner, sourceId)
        clearRateLimitForSource(owner, sourceId)
    } catch { /* 清理失败不影响重载 */ }

    if (!fs.existsSync(metaPath)) return { success: true }

    try {
        const sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        const source = sources.find((s: any) => s.id === sourceId)
        // 源已被删除：卸载即完成
        if (!source) return { success: true }

        const stats = { loadedCount: 0 }
        const { needsSave } = await loadOneSource(dirPath, owner, source, stats)

        if (needsSave) {
            lastReloadMap.set(owner, Date.now())
            const originalSources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            const updatedMap = new Map([[source.id, source]])
            const merged = originalSources.map((s: any) => updatedMap.get(s.id) || s)
            fs.writeFileSync(metaPath, JSON.stringify(merged, null, 2))
            console.log(`[自定义源] [${owner}] 已更新 sources.json 元数据`)
        }
        // reloadSingleSource 替换 Map 项时会把新实例放到末尾，这里恢复原来的源优先级
        applyOrderToLoadedApis(previousOrder)
        return { success: true }
    } catch (error: any) {
        console.error(`[自定义源] [${owner}] 增量重载 ${sourceId} 失败:`, error.message)
        return { success: false, error: error.message }
    }
}

/** 仅卸载指定音源实例（删除音源后调用，无需重新解析其余音源）。 */
export function unloadSource(owner: string, sourceId: string) {
    unloadLoadedApi(`${owner}_${sourceId}`)
    apiStatus.delete(`${owner}_${sourceId}`)
    lastReloadMap.set(owner, Date.now())
}

/**
 * 按给定 ID 顺序在内存中重排已加载音源，不做任何脚本解析。
 *
 * 说明：音源优先级在每次解析时由 order.json 实时决定（见 callUserApiGetMusicUrl），
 * 因此拖拽排序只需同步 Map 顺序即可，无需重新加载任何脚本。
 */
export function applyOrderToLoadedApis(orderedIds: string[]) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) return
    const idx = new Map<string, number>()
    orderedIds.forEach((id, i) => idx.set(id, i))
    const decorated = Array.from(loadedApis.entries()).map(([key, api], seq) => ({
        key,
        api,
        seq,
        rank: idx.has(api?.info?.id) ? idx.get(api.info.id)! : Number.MAX_SAFE_INTEGER
    }))
    decorated.sort((a, b) => (a.rank - b.rank) || (a.seq - b.seq))
    loadedApis.clear()
    for (const d of decorated) loadedApis.set(d.key, d.api)
}

// ===== 全量重载的并发合并 =====
// 同一 key（用户空间）同时只允许一个全量重载在跑；期间到来的请求只标记 dirty，
// 由正在跑的那一轮在结束后再补跑一次，从而把 N 次请求压缩为最多 2 轮重载。
interface ReloadGate { running: boolean; dirty: boolean; waiters: Array<() => void> }
const reloadGates = new Map<string, ReloadGate>()

async function runCoalescedReload(key: string, task: () => Promise<void>): Promise<void> {
    let gate = reloadGates.get(key)
    if (!gate) {
        gate = { running: false, dirty: false, waiters: [] }
        reloadGates.set(key, gate)
    }

    if (gate.running) {
        gate.dirty = true
        // 等待「本轮 + 合并后的下一轮」全部跑完，保证调用方拿到的是最新状态
        await new Promise<void>(resolve => gate!.waiters.push(resolve))
        return
    }

    gate.running = true
    try {
        do {
            gate.dirty = false
            await task()
        } while (gate.dirty)
    } finally {
        gate.running = false
        const waiters = gate.waiters
        gate.waiters = []
        for (const w of waiters) w()
    }
}

// 文件监控相关
let fsWatcher: fs.FSWatcher | null = null
const lastReloadMap = new Map<string, number>() // 记录每个用户的最后加载时间

/**
 * 每个已加载音源脚本的内容指纹（sha1）。
 *
 * 用来判断「文件事件触发的变化」是不是内容真的变了：
 * 音源脚本运行时经常自己往源目录里写文件（自愈保存、缓存落盘），
 * 只看文件事件就重载会形成自激循环，而每次重载都要在主线程同步 eval
 * 整个脚本（2~3 秒），期间事件循环被卡住 → 正在下发的音频断流 → 听感断断续续。
 */
const loadedScriptHashes = new Map<string, string>()

/** 当前是否正在往音箱下发音频（正在放音时不能做重载这种重活） */
const isAudioStreaming = (): boolean => {
    try {
        // 延迟 require，避免与 xiaoai 模块产生循环依赖
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { hasActiveStream } = require('./xiaoai/stream')
        return hasActiveStream()
    } catch {
        return false
    }
}

/**
 * 真正执行一次「文件变了 → 重载音源」的处理。
 *
 * 两道保护：
 *  1) **放音期间不做**：重载要在主线程同步 eval 整个音源脚本（2~3 秒），
 *     事件循环一卡，正在下发的音频就断流（听感是突然静音一两秒）。
 *     放音时先压着，隔几秒再试。
 *  2) **内容没变就不做**：音源脚本运行时经常自己往源目录里写文件（自愈保存、缓存落盘），
 *     只看「文件事件」就重载会形成「重载 → 脚本再写 → 再重载」的自激循环，
 *     每轮都要卡住主线程 2~3 秒。用内容指纹比对即可一劳永逸地掐断。
 */
function applySourceChange(
    username: string,
    baseName: string,
    eventType: string,
    filename: string,
    sourceRoot: string,
    attempt = 0,
) {
    // 放音期间：暂缓，稍后重试（最多等 2 分钟）
    if (isAudioStreaming()) {
        if (attempt < 24) {
            console.log(`[自定义源] [文件监控] 正在播放音频，暂缓重载 ${username}/${baseName}`)
            syncLog.info(`[自定义源] [文件监控] 正在播放音频，暂缓重载 ${username}/${baseName}`)
            const timer = setTimeout(() => {
                applySourceChange(username, baseName, eventType, filename, sourceRoot, attempt + 1)
            }, 5000)
            timer.unref?.()
        }
        return
    }

    // 单个音源脚本变化：只重载该音源，避免「改一个文件重载全部音源」的放大
    if (baseName.endsWith('.js')) {
        const scriptPath = path.join(sourceRoot, username === 'open' ? '_open' : username, baseName)
        let changed = true
        try {
            const now = crypto
                .createHash('sha1')
                .update(fs.readFileSync(scriptPath, 'utf-8'))
                .digest('hex')
            changed = now !== loadedScriptHashes.get(`${username}/${baseName}`)
        } catch {
            changed = true
        }
        if (!changed) {
            console.log(`[自定义源] [文件监控] 音源脚本内容未变化，跳过重载 ${username}/${baseName}`)
            return
        }
        console.log(`[自定义源] [文件监控] 检测到音源脚本变动 (${eventType}): ${filename} -> 增量重载 ${username}/${baseName}`)
        syncLog.info(`[自定义源] [文件监控] 检测到音源脚本变动 (${eventType}): ${username}/${baseName} -> 增量重载`)
        reloadSingleSource(username, baseName).catch(err => {
            console.error(`[自定义源] [文件监控] 增量重载失败:`, err)
        })
        return
    }

    // 源清单 (sources.json) 变化：增删/启停集合可能已变，仍需全量重载
    console.log(`[自定义源] [文件监控] 检测到源清单变动 (${eventType}): ${filename} -> 全量重载 ${username}`)
    syncLog.info(`[自定义源] [文件监控] 检测到源清单变动 (${eventType}): ${username} -> 全量重载`)
    initUserApis(username).catch(err => {
        console.error(`[自定义源] [文件监控] 重新加载失败:`, err)
    })
}

// 启动文件监控
function startWatcher(sourceRoot: string) {
    if (fsWatcher) return

    console.log(`[自定义源] 启动源文件监控: ${sourceRoot}`)
    const debounceMap = new Map<string, NodeJS.Timeout>()

    try {
        // Warning: recursive option for fs.watch is generally supported on Windows/macOS but not Linux
        // For better cross-platform support, chokidar would be preferred, but using fs.watch as requested/minimal dependency
        fsWatcher = fs.watch(sourceRoot, { recursive: true }, (eventType, filename) => {
            if (!filename) return

            // 仅关注 .js 和 sources.json 文件的变化
            if (!filename.endsWith('.js') && !filename.endsWith('sources.json')) {
                return
            }

            // 解析用户名 (目录名)
            // filename on Windows might be "username\file.js"
            const parts = (filename as string).split(path.sep)
            let username = parts[0]

            // 如果是 _open 目录，对应 'open' 用户
            if (username === '_open') {
                username = 'open'
            }

            // 简单的防抖处理
            if (debounceMap.has(username)) {
                clearTimeout(debounceMap.get(username)!)
            }

            debounceMap.set(username, setTimeout(() => {
                // 检查是否是最近刚加载或写入过 (避免面板上传或服务端自愈保存造成的重复加载)
                // 阈值设为 4000ms
                const lastReload = lastReloadMap.get(username) || 0
                if (Date.now() - lastReload < 4000) {
                    return
                }

                const baseName = parts[parts.length - 1]
                applySourceChange(username, baseName, eventType, filename as string, sourceRoot)
            }, 2000)) // 2秒防抖，等待文件写入完成
        })

        // 进程退出时关闭监听，并释放所有音源实例登记的定时器
        process.on('exit', () => {
            if (fsWatcher) fsWatcher.close()
            for (const key of Array.from(loadedApis.keys())) unloadLoadedApi(key)
        })
    } catch (e) {
        console.error('[自定义源] 启动文件监控失败:', e)
    }
}

// 从文件系统加载所有已启用的自定义源
// 路径变更：DATA_PATH/users/source/{username} 和 DATA_PATH/users/source/_open
export async function initUserApis(targetUser?: string) {
    // 同一用户空间的全量重载合并执行，避免高频操作叠加触发多次全量解析
    const gateKey = targetUser || '__all__'
    await runCoalescedReload(gateKey, () => doInitUserApis(targetUser))
}

async function doInitUserApis(targetUser?: string) {
    const startedAt = Date.now()
    const dataPath = process.env.DATA_PATH || path.join(process.cwd(), 'data')
    const sourceRoot = path.join(dataPath, 'users', 'source')
    const stats = { loadedCount: 0 }

    // [自检护栏] 新一轮全量加载：清空上一轮的标记与隔离快照，并标记为「忙碌」，
    // 避免加载动作自身的 CPU 开销被后续的采样判定误认为空闲热点。
    beginSourceReload()

    // 更新最后加载时间
    if (targetUser) {
        lastReloadMap.set(targetUser, Date.now())
    } else {
        // 全局加载
    }

    console.log(`[自定义源] ========================================`)

    // 如果根目录不存在，无需加载
    if (!fs.existsSync(sourceRoot)) {
        console.log(`[自定义源] 未找到自定义源根目录: ${sourceRoot}`)
        console.log(`[自定义源] ========================================`)
        return
    }

    // 尝试启动监控 (只会在第一次调用且无 watcher 时启动)
    if (!fsWatcher) {
        startWatcher(sourceRoot)
    }

    if (targetUser) {
        console.log(`[自定义源] 重新加载用户源: ${targetUser}`)
        // 清理该用户的旧源和状态
        // 注意：必须通过 unloadOwnerApis 逐个 dispose，才能释放各音源脚本注册的定时器，
        // 否则每次重载都会遗留一批永不回收的定时器（CPU 持续占用 + 内存只增不减）。
        unloadOwnerApis(targetUser)
        for (const key of apiStatus.keys()) {
            if (key.startsWith(`${targetUser}_`)) {
                apiStatus.delete(key)
            }
        }

        // 加载该用户的源
        let dirName = targetUser

        // 特殊处理：如果是 'open'，对应目录是 '_open'
        if (targetUser === 'open') {
            dirName = '_open'
        }

        const userSourceDir = path.join(sourceRoot, dirName)
        if (fs.existsSync(userSourceDir)) {
            await loadSourcesFromDir(userSourceDir, targetUser, stats)
        }

    } else {
        console.log(`[自定义源] 初始化所有自定义源...`)
        // 全量重建前先释放所有实例的定时器，避免泄漏
        for (const key of Array.from(loadedApis.keys())) {
            unloadLoadedApi(key)
        }
        loadedApis.clear()

        // 扫描 sourceRoot 下的所有子目录
        try {
            const entries = fs.readdirSync(sourceRoot, { withFileTypes: true })
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    let owner = entry.name
                    // 如果目录是 _open，owner 为 'open'
                    if (entry.name === '_open') {
                        owner = 'open'
                    }

                    const dirPath = path.join(sourceRoot, entry.name)
                    await loadSourcesFromDir(dirPath, owner, stats)
                }
            }
        } catch (error: any) {
            console.error('[自定义源] 扫描源目录失败:', error.message)
        }
    }

    lastReloadDurationMs = Date.now() - startedAt

    // 把「上一轮进程里已确认的慢源」直接预置进 worker。
    //
    // 现有提升机制是「实测卡了一次才搬走」，代价是每次进程重启后第一次搜索都要
    // 再卡一遍：246 实测 02:12 一份 3.18MB 响应里，西瓜聚合源回调 5420ms、
    // 非常刀 5251ms，串成 11934ms 的主线程停转（深拷贝仅 2ms，时间全在脚本同步逻辑）。
    // governor 的降速状态本身已经落盘（见 sourceGovernor 的 loadGovernorState），
    // 这里加载完音源就按它预热 worker，脚本指纹变了会自动不认旧记录。
    if (stats.loadedCount > 0) {
        try {
            const candidates = listWorkerPresetCandidates()
            let promoted = 0
            for (const item of candidates) {
                const instance = loadedApis.get(`${item.owner}_${item.id}`)
                if (!instance) continue
                const info = instance.info || {}
                // 指纹不一致说明脚本已经更新，旧版本的慢记录不适用于新脚本
                const currentHash = loadedScriptHashes.get(`${item.owner}/${item.id}`)
                if (item.scriptHash && currentHash && item.scriptHash !== currentHash) continue
                markWorkerEligible(item.owner, item.id, {
                    owner: item.owner,
                    id: item.id,
                    name: info.name || item.name || item.id,
                    script: info.script,
                }, true)
                promoted++
            }
            if (promoted > 0) {
                console.log(`[自定义源] 按上次运行的慢源记录把 ${promoted} 个源预置到独立线程（避免重启后首轮再卡主线程）`)
            }
        } catch (e: any) {
            console.warn(`[自定义源] 慢源预置失败（不影响加载）: ${e?.message || e}`)
        }
    }

    console.log(`[自定义源] 本次加载: ${stats.loadedCount} 个源`)
    console.log(`[自定义源] 当前总计: ${loadedApis.size} 个源`)
    // [诊断] 重载耗时与活跃资源数量，便于用户自查定时器泄漏 / 重载放大
    console.log(`[自定义源] 重载耗时: ${lastReloadDurationMs}ms | 活跃资源: ${JSON.stringify(getActiveResourceSummary())} | 已登记定时器: ${getTrackedTimerCount()}`)
    console.log(`[自定义源] ========================================`)
}

// 获取所有已加载的 API
export function getLoadedApis() {
    return Array.from(loadedApis.values()).map(api => api.info)
}

// 检查某个源是否被支持
// clientUsername: 调用者的用户名。如果未提供，则只能检查 open 源
export function isSourceSupported(source: string, clientUsername?: string): boolean {
    // 汽水/B站：服务端通道（extraSources）匿名即可用，恒视为支持；
    // 脚本通道是否可用由取链编排自己探（脚本声明的 qs/bilibili 等别名按 scriptPlatformKeys 匹配）。
    if (isExtraSourceId(source)) return true

    const dataPath = process.env.DATA_PATH || path.join(process.cwd(), 'data')
    let userStates: Record<string, any> = {}
    if (clientUsername && clientUsername !== 'default' && clientUsername !== 'open') {
        const statesPath = path.join(dataPath, 'users', 'source', clientUsername, 'states.json')
        if (fs.existsSync(statesPath)) {
            try { userStates = JSON.parse(fs.readFileSync(statesPath, 'utf-8')) } catch (e) { }
        }
    } else {
        const openStatesPath = path.join(dataPath, 'users', 'source', '_open', 'states.json')
        if (fs.existsSync(openStatesPath)) {
            try { userStates = JSON.parse(fs.readFileSync(openStatesPath, 'utf-8')) } catch (e) { }
        }
    }

    const getSourceState = (id: string) => {
        return userStates[id] || userStates[decodeURIComponent(id)] || userStates[encodeURIComponent(id)] || {}
    }

    for (const [apiId, api] of loadedApis) {
        if (!api.info.sources || !api.info.sources[source]) {
            continue
        }

        const state = getSourceState(api.info.id)
        let isEnabled = api.info.enabled
        if (api.info.owner === 'open' && clientUsername && clientUsername !== 'default' && clientUsername !== 'open') {
            if (typeof state.enabled === 'boolean') {
                isEnabled = state.enabled
            }
        }
        if (!isEnabled) continue

        // 检查平台是否被禁用
        if (Array.isArray(state.disabledSources) && state.disabledSources.includes(source)) {
            continue
        }

        // 权限检查
        if (api.info.owner === 'open' || (clientUsername && api.info.owner === clientUsername)) {
            return true
        }
    }
    return false
}
