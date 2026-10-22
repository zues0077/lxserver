import { VM } from 'vm2'
import * as fs from 'fs'
import * as path from 'path'
import {
    beginSourceReload,
    markSourceBusy,
    reviewSourceScript,
} from './sourceGuard'
import { isProbeQuiet, recordSuppressed } from './probeQuiet'
import { isHardFailure, reportManualFailure } from './sourceProbe'
import { syncLog } from '../utils/log4js'
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
import * as crypto from 'crypto'
import * as zlib from 'zlib'
import { promisify } from 'util'

import * as tunnel from 'tunnel'
import { getProxyAgent } from '../modules/utils/proxy.js'
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
            const list = (meta as any)?.qualitys
            if (Array.isArray(list)) qualities[platform] = list.filter((q: any) => typeof q === 'string' && q)
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
            response_timeout: typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, 60000) : 60000
        }

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

        const launch = () => {
            // 排队期间实例可能已被卸载（禁用/重载/隔离），此时发起请求会让回调
            // 写进已释放的 VM2 沙箱——实测会直接 SIGSEGV 崩掉整个进程
            if (cancelled || isDisposed?.()) { releaseSlotOnce(); return }
                const request = needle.request(method, url, data, requestOptions, (err: any, resp: any, body: any) => {
                    // 响应回来的时刻是卡顿归因的关键锚点，必须抢在任何同步处理之前记下
                    if (tracked) noteCallback(owner, id, name)
                    if (abortHolder.fn) pendingAborts?.delete(abortHolder.fn)
                    try {
                        if (err) {
                            callback.call(null, decontextify(err), null, null)
                        } else {
                            let parsedBody = body
                            if (typeof body === 'string') {
                                try {
                                    parsedBody = JSON.parse(body)
                                } catch { }
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

                            callback.call(null, null, safeResp, safeResp.body)
                        }
                    } catch (error: any) {
                        callback.call(null, decontextify(error), null, null)
                    } finally {
                        // 槽位在回调彻底结束后才归还：回调体内的 decontextify/JSON.parse
                        // 才是真正的同步开销，提前还槽会让下一路请求挤进同一个阻塞段
                        releaseSlotOnce()
                    }
                })

            const abortFn = () => {
                const reqObj = (request as any).request
                if (reqObj && !reqObj.aborted) reqObj.abort()
            }
            abortHolder.fn = abortFn
            if (cancelled) abortFn()
            else if (pendingAborts) pendingAborts.add(abortFn)
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
            info: { ...fullApiInfo, sources: registeredSources },
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

                    const result = await handler(inputData)
                    return decontextify(result)
                } catch (e: any) {
                    if (isProbeQuiet()) {
                        // 巡检期的失败是「预期内噪音」，聚合到摘要里，不逐条打印
                        recordSuppressed(fullApiInfo.name, describeError(e))
                    } else {
                        console.error(`[自定义源-${fullApiInfo.name}] 调用请求异常:`, describeError(e))
                    }
                    throw e
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

const validateReturnedMusicUrl = (rawUrl: any, sourceName?: string): string => {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('音源未返回有效的链接字符串')
    }
    const trimmed = rawUrl.trim()
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
/** 窗口内失败几次才沉底 */
const PLAY_SINK_MIN_FAILS = 2
interface PlaySinkRecord { fails: number; lastFailAt: number }
const playFailSink = new Map<string, PlaySinkRecord>()

const playSinkKey = (owner: string, id: string, platform: string): string => `${owner || ''}:${id || ''}:${platform || ''}`

/** 按「近期是否反复失败」把候选分成两拨：先试 fresh，再试 sunk。纯函数，便于单测 */
export const partitionByPlaySink = (
    candidates: any[],
    platform: string,
    now: number = Date.now(),
): { fresh: any[]; sunk: any[] } => {
    const isSunk = (api: any): boolean => {
        const rec = playFailSink.get(playSinkKey(api?.info?.owner, api?.info?.id, platform))
        return !!rec && rec.fails >= PLAY_SINK_MIN_FAILS && now - rec.lastFailAt < PLAY_SINK_WINDOW_MS
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

/** 记一次取链失败（原因不限）——只用于排序，不参与定罪 */
export const notePlayFailure = (api: any, platform: string): void => {
    if (!api?.info) return
    const key = playSinkKey(api.info.owner, api.info.id, platform)
    const rec = playFailSink.get(key) || { fails: 0, lastFailAt: 0 }
    rec.fails += 1
    rec.lastFailAt = Date.now()
    playFailSink.set(key, rec)
}

/** 取链成功——立刻撤销沉底，并把它清出账本 */
export const clearPlayFailure = (api: any, platform: string): void => {
    if (!api?.info) return
    playFailSink.delete(playSinkKey(api.info.owner, api.info.id, platform))
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
export const verifyUrlPlayable = async (url: string, sourceName: string): Promise<string | null> => {
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
    const request = async (method: 'head' | 'get'): Promise<number | undefined> => {
        const resp: any = await needle(method, url, null, {
            follow_max: 2,
            response_timeout: VERIFY_TIMEOUT_MS,
            read_timeout: VERIFY_TIMEOUT_MS,
            agent,
            headers: method === 'get' ? { ...headers, Range: 'bytes=0-0' } : headers,
        })
        return typeof resp?.statusCode === 'number' ? resp.statusCode : undefined
    }
    // 只把「确定取不到」判为失败：404 / 410 / 5xx。
    // 403 / 401 / 405 更可能是防盗链或 upstream 不支持 HEAD，一律放行，绝不误杀可用的源。
    // 网络错误与超时同样放行 —— 我们只是在做一次尽力的复核。
    try {
        const headCode = await request('head')
        if (!isUnplayableStatusCode(headCode)) return null
        // HEAD 判死不可尽信：不少 CDN / 防盗链只认 GET，HEAD 一律回 404 或 405。
        // 所以再拿 1 字节的 Range GET 复核一次，两次都说取不到才判失败。
        const getCode = await request('get')
        if (!isUnplayableStatusCode(getCode)) return null
        return typeof getCode === 'number' && getCode >= 500
            ? `音源 [${sourceName}] 返回的链接源站报错（HTTP ${getCode}）`
            : `音源 [${sourceName}] 返回的链接实际不存在（HTTP ${getCode}）`
    } catch {
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
    excludeApiSources?: string[]
): Promise<{ url: string, type: string, sourceName?: string, sourceId?: string, attempts?: any[], hasMoreSources?: boolean }> {
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

    let supportedCount = 0;
    let lastError: Error | null = null;

    // 查找支持该 source 的 API
    // 收集所有支持该 source 的 API，并根据权限过滤
    let candidates: any[] = []
    const userApiIds = new Set<string>()

    // 读取当前用户的公开源状态覆盖（启用/禁用）以及私有源 ID 集合
    let userStates: Record<string, any> = {}
    const dataPath = process.env.DATA_PATH || path.join(process.cwd(), 'data')
    if (clientUsername && clientUsername !== 'default') {
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

    // 按 loadedApis 收集所有可用候选源（权限过滤，不强制任何顺序）
    for (const [apiId, api] of loadedApis) {
        if (!api.info.sources || !api.info.sources[source]) continue

        const state = getSourceState(api.info.id)

        if (api.info.owner === 'open') {
            // 计算公开源对当前用户的有效启用状态
            let isEnabled = api.info.enabled
            if (clientUsername && clientUsername !== 'default') {
                if (typeof state.enabled === 'boolean') {
                    isEnabled = state.enabled
                }
            }
            if (!isEnabled) continue
            if (userApiIds.has(api.info.id)) continue  // 被同名私有版本覆盖，跳过

            // 检查平台是否被禁用
            if (Array.isArray(state.disabledSources) && state.disabledSources.includes(source)) {
                continue
            }

            candidates.push(api)
        } else if (clientUsername && api.info.owner === clientUsername) {
            if (!api.info.enabled) continue

            // 检查平台是否被禁用
            if (Array.isArray(state.disabledSources) && state.disabledSources.includes(source)) {
                continue
            }

            candidates.push(api)
            userApiIds.add(api.info.id) // 兜底：确保后续不重复添加公开同名源
        }
    }

    // === 实时按 order.json 对候选列表排序 ===
    // 不依赖 loadedApis 的 Map 插入顺序（部分 reload 后顺序会乱），
    // 每次解析都直接读 order.json，无需重启服务器即可生效
    if (candidates.length > 1) {
        const dataPath = process.env.DATA_PATH || path.join(process.cwd(), 'data')
        let orderData: string[] = []

        // 优先读用户自己的排序（admin/order.json），再回退到公开源排序（_open/order.json）
        const orderCandidates = clientUsername && clientUsername !== 'default'
            ? [
                path.join(dataPath, 'users', 'source', clientUsername, 'order.json'),
                path.join(dataPath, 'users', 'source', '_open', 'order.json')
              ]
            : [path.join(dataPath, 'users', 'source', '_open', 'order.json')]

        for (const orderPath of orderCandidates) {
            if (fs.existsSync(orderPath)) {
                try {
                    orderData = JSON.parse(fs.readFileSync(orderPath, 'utf-8'))
                    if (orderData.length > 0) break
                } catch (e) { }
            }
        }

        if (orderData.length > 0) {
            const idToIndex = new Map(orderData.map((id, i) => [id, i]))
            candidates.sort((a: any, b: any) => {
                const ia = idToIndex.has(a.info.id) ? idToIndex.get(a.info.id)! : 999999
                const ib = idToIndex.has(b.info.id) ? idToIndex.get(b.info.id)! : 999999
                return ia - ib
            })
        }
    }
    // =========================================

    // === 运行时沉底：近期反复失败的音源排到队尾 ===
    // 不写 states.json、不禁用、不删源——只改变尝试顺序。
    // 目的是让「已知是坏的源」不再挡在前面白白吃掉几秒，而不是把它从池子里拿掉：
    // 手动取链是单首歌单次失败，无版权/已下架这类软失败占比很高，凭一次失败禁用会误伤一批。
    // 沉底只认「同一平台近期连续失败」，且该源任意一次成功即立刻恢复原位。
    if (candidates.length > 1 && playSinkEnabled()) {
        const { fresh, sunk } = partitionByPlaySink(candidates, source)
        if (sunk.length && fresh.length) {
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

    if (enableAutoSwitchApiSource === false && candidates.length > 1) {
        candidates = [candidates[0]]
    }

    supportedCount = candidates.length

    if (supportedCount === 0) {
        const hasExcluded = Array.isArray(excludeApiSources) && excludeApiSources.length > 0
        const errMsg = hasExcluded
            ? `支持 ${source} 平台的自定义源均已尝试且无法播放（已尝试 ${excludeApiSources.length} 个音源）`
            : `未找到支持 ${source} 平台的自定义源，请在设置中添加或启用相关源`
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
    // 本轮取链里失败的音源（用于轮末把硬故障证据交给巡检）
    const roundFailures: Array<{ api: any; message: string }> = []

    if (supportedCount === 1) {
        const api = candidates[0]
        const maxRetries = 3

        for (let i = 0; i < maxRetries; i++) {
            try {
                console.log(`[自定义源] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (第 ${i + 1}/${maxRetries} 次, 所属: ${api.info.owner})`)

                const rawUrl = await withTimeout(
                    api.callRequest('musicUrl', source, {
                        musicInfo: normalizedSongInfo,
                        quality: quality,
                        type: quality
                    }),
                    callTimeoutMs,
                    `音源 [${api.info.name}] 取链超时（超过 ${callTimeoutMs}ms 未返回）`
                )
                const url = validateReturnedMusicUrl(rawUrl, api.info.name)
                // 字符串校验挡不住「URL 正常但请求下来是 404」——实测某源对不存在的歌
                // 照样返回可解析的链接，宿主判成功后停止轮询，用户点开就是播放失败。
                const unplayable = await verifyUrlPlayable(url, api.info.name)
                if (unplayable) throw new Error(unplayable)

                console.log(`[自定义源] ✓ ${api.info.name} 成功返回链接 (所属: ${api.info.owner})`)
                clearPlayFailure(api, source)
                // 单源场景没有对照组（没人证明这首歌能播），只记账不处置
                reportPlayHardFailures(roundFailures, source, false)
                const att = { name: api.info.name, status: 'success', message: `第 ${i + 1} 次尝试成功` }
                attempts.push(att)
                if (onProgress) await onProgress(att)
                return { url, type: quality, sourceName: api.info.name, sourceId: api.info.id, attempts, hasMoreSources: false }
            } catch (error: any) {
                console.error(`[自定义源] ${api.info.name} 失败 (第 ${i + 1}/${maxRetries} 次):`, `音源日志：${error.message}`)
                lastError = error
                notePlayFailure(api, source)
                roundFailures.push({ api, message: String(error?.message || error) })
                const att = { name: api.info.name, status: 'fail', message: `第 ${i + 1} 次尝试失败,音源日志：${error.message}` }
                attempts.push(att)
                if (onProgress) await onProgress(att)
                // 如果不是最后一次尝试，等待一小会儿
                if (i < maxRetries - 1) {
                    await new Promise(r => setTimeout(r, 1000))
                }
            }
        }
    } else {
        // 多个源，轮流尝试
        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
            const api = candidates[candidateIndex]
            try {
                console.log(`[自定义源] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (所属: ${api.info.owner})`)

                const rawUrl = await withTimeout(
                    api.callRequest('musicUrl', source, {
                        musicInfo: normalizedSongInfo,
                        quality: quality,
                        type: quality
                    }),
                    callTimeoutMs,
                    `音源 [${api.info.name}] 取链超时（超过 ${callTimeoutMs}ms 未返回）`
                )
                const url = validateReturnedMusicUrl(rawUrl, api.info.name)
                // 同上：链接长得正常但请求下来是 404，必须判失败并继续试下一个源，
                // 否则「第一个源假成功」会把后面几十个真能播的源全挡住。
                const unplayable = await verifyUrlPlayable(url, api.info.name)
                if (unplayable) throw new Error(unplayable)

                console.log(`[自定义源] ✓ ${api.info.name} 成功返回链接 (所属: ${api.info.owner})`)
                clearPlayFailure(api, source)
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
                    hasMoreSources: candidateIndex < candidates.length - 1
                }
            } catch (error: any) {
                console.error(`[自定义源] ${api.info.name} 失败:`, `音源日志：${error.message}`)
                lastError = error
                notePlayFailure(api, source)
                roundFailures.push({ api, message: String(error?.message || error) })
                const att = { name: api.info.name, status: 'fail', message: `音源日志：${error.message}` }
                attempts.push(att)
                if (onProgress) await onProgress(att)
                continue
            }
        }
    }

    // 全部失败：没有任何音源证明这首歌能播，只把硬故障记进账本，不做任何处置
    reportPlayHardFailures(roundFailures, source, false)

    const detailMsg = supportedCount === 1
        ? `自定义源 [${candidates[0].info.name}] 解析失败`
        : `已尝试了 ${supportedCount} 个支持 ${source} 平台的源，但全部解析失败`

    const finalError: any = new Error(`${detailMsg} (音源日志: ${lastError?.message})`)
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
            apiStatus.set(apiKey, { status: 'failed', error: `已被自检护栏隔离（${guardDecision.reason}）` })
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
        return
    }
    const idx = apiKey.indexOf('_')
    if (idx > 0) resetActivity(apiKey.slice(0, idx), apiKey.slice(idx + 1))
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
    const dataPath = process.env.DATA_PATH || path.join(process.cwd(), 'data')
    let userStates: Record<string, any> = {}
    if (clientUsername && clientUsername !== 'default') {
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
        if (api.info.owner === 'open' && clientUsername && clientUsername !== 'default') {
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
