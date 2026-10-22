/**
 * 音源活动账本与运行时降速（卡顿治理 L1 + L2）。
 *
 * 背景：音源脚本是第三方代码，跑在 VM2 沙箱里，宿主既不知道它什么时候发请求，
 * 也不知道它什么时候在加载。于是出现卡顿（主线程被同步阻塞数秒）时，
 * 已有的归因通道常常交白卷——慢定时器回调只覆盖「回调本身同步执行很久」的情形，
 * 而真正的阻塞往往来自：
 *
 *   - 一批网络响应**同时回来**，每个回调都要在沙箱边界做 decontextify（深度同步
 *     序列化）+ JSON.parse，单笔几毫秒、几十笔叠在一起就是数秒；
 *   - 脚本**加载/重载**本身要同步 eval 整个脚本（实测 61KB 脚本约 6 秒）。
 *
 * 这两种情况的共同点是：阻塞期间**一定有某个脚本在活动**。所以这里维护一份
 * 「活动账本」——谁在什么时候发了请求、谁的响应刚回来、谁正在加载。卡顿窗口内
 * 有活动的脚本即为嫌疑人。这是**行为级**证据，不依赖脚本内容的静态特征，
 * 因此混淆脚本、新加入的脚本天然被覆盖，不需要任何预先检测。
 *
 * L2 在此基础上做运行时降速：被归因反复命中的脚本，自动压低它的请求并发、
 * 给它的长周期定时器加随机抖动错峰、把它的重载排进串行队列。
 * 全程对脚本透明——脚本不需要配合，也不需要改一行代码。
 */

export interface SourceActivityMeta {
    owner: string
    id: string
    name: string
}

export const activityKey = (owner: string, id: string): string => `${owner}_${id}`

interface ScriptActivity {
    owner: string
    id: string
    name: string
    /** 在途请求数 */
    inflight: number
    /** 累计发起请求数 */
    requests: number
    /** 累计收到回调数 */
    callbacks: number
    lastRequestAt: number
    lastCallbackAt: number
    /** 正在加载/重载（同步 eval 期间事件循环被独占） */
    loading: boolean
    loadStartedAt: number
    /** 最近一次加载耗时（毫秒） */
    lastLoadCostMs: number
    lastLoadEndAt: number
    /** 被卡顿归因命中的累计次数 */
    stallHits: number
    /** 最近一次被归因的时刻 */
    lastStallHitAt: number
    /** 该脚本当前的请求并发上限，-1 表示不限 */
    requestLimit: number
    /** 请求被闸门拦下排队的总次数（用于判断降速是否真的在起作用） */
    throttledWaits: number
}

const activities = new Map<string, ScriptActivity>()

// ============================ 配置 ============================

const envNum = (name: string, fallback: number): number => {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    // 显式写 0 也要生效（例如用来关闭某项），因此判据是 >= 0 而不是 > 0
    return Number.isFinite(value) && value >= 0 ? value : fallback
}

const envBool = (name: string, fallback: boolean): boolean => {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return fallback
    return /^(1|true|yes|on)$/i.test(raw)
}

/** 同一脚本连续被归因几次后自动降速（0 = 关闭自动降速） */
const AUTO_THROTTLE_STREAK = envNum('CUSTOM_SOURCE_AUTO_THROTTLE_STREAK', 2)
/** 自动降速后的请求并发上限 */
const AUTO_THROTTLE_LIMIT = envNum('CUSTOM_SOURCE_AUTO_THROTTLE_LIMIT', 2)
/** 自动降速后维持多久（毫秒）再放开；期间不再被归因则视为已经安静 */
const AUTO_THROTTLE_RELEASE_MS = envNum('CUSTOM_SOURCE_AUTO_THROTTLE_RELEASE_MS', 30 * 60 * 1000)
/** 长周期定时器抖动：间隔达到该值才抖 */
const TIMER_JITTER_MIN_MS = envNum('CUSTOM_SOURCE_TIMER_JITTER_MIN_MS', 60 * 1000)
/** 抖动幅度（比例，0.15 = ±15%） */
const TIMER_JITTER_RATIO = envNum('CUSTOM_SOURCE_TIMER_JITTER_RATIO', 0.15)
/** 是否开启长周期定时器抖动 */
const TIMER_JITTER_ENABLED = envBool('CUSTOM_SOURCE_TIMER_JITTER_ENABLED', true)

// ============================ 账本读写 ============================

const touch = (meta: SourceActivityMeta): ScriptActivity => {
    const key = activityKey(meta.owner, meta.id)
    let item = activities.get(key)
    if (!item) {
        item = {
            owner: meta.owner,
            id: meta.id,
            name: meta.name,
            inflight: 0,
            requests: 0,
            callbacks: 0,
            lastRequestAt: 0,
            lastCallbackAt: 0,
            loading: false,
            loadStartedAt: 0,
            lastLoadCostMs: 0,
            lastLoadEndAt: 0,
            stallHits: 0,
            lastStallHitAt: 0,
            requestLimit: -1,
            throttledWaits: 0,
        }
        activities.set(key, item)
    } else if (meta.name && item.name !== meta.name) {
        item.name = meta.name
    }
    return item
}

/**
 * 请求发起埋点（宿主 lx.request 内调用）。
 * 返回 release 回调，必须在请求回调里调用，否则在途数会泄漏。
 */
export function noteRequest(owner: string, id: string, name: string): void {
    const item = touch({ owner, id, name })
    item.inflight++
    item.requests++
    item.lastRequestAt = Date.now()
}

/** 请求回调埋点：响应回来的时刻是卡顿归因的关键时间锚点 */
export function noteCallback(owner: string, id: string, name: string): void {
    const item = touch({ owner, id, name })
    if (item.inflight > 0) item.inflight--
    item.callbacks++
    item.lastCallbackAt = Date.now()
}

/** 脚本加载/重载开始：同步 eval 期间事件循环被独占，是卡顿的直接来源之一 */
export function noteLoadStart(owner: string, id: string, name: string): void {
    const item = touch({ owner, id, name })
    item.loading = true
    item.loadStartedAt = Date.now()
}

export function noteLoadEnd(owner: string, id: string, name: string): void {
    const item = touch({ owner, id, name })
    item.loading = false
    if (item.loadStartedAt > 0) {
        item.lastLoadCostMs = Date.now() - item.loadStartedAt
        item.lastLoadEndAt = Date.now()
        item.loadStartedAt = 0
    }
}

/** 音源被卸载/删除时清账，避免账本无界增长 */
export function resetActivity(owner: string, id: string): void {
    activities.delete(activityKey(owner, id))
    gates.delete(activityKey(owner, id))
}

// ============================ 卡顿窗口查询 ============================

export interface ActivitySample {
    owner: string
    id: string
    name: string
    /** 证据类型：正在加载 / 窗口内响应回来 / 窗口内发起请求 / 有在途请求 */
    kinds: Array<'loading' | 'callback' | 'request' | 'inflight'>
    /** 窗口内回来的响应数（可观测范围内） */
    callbacks: number
    inflight: number
    /** 加载耗时（仅 loading 时有效） */
    loadCostMs: number
    /** 最后一次活动距现在多久（毫秒） */
    agoMs: number
}

/**
 * 取出卡顿窗口内有活动的脚本。
 *
 * 排序规则：正在加载 > 窗口内响应回来 > 窗口内发起请求 > 仅有在途请求。
 * 加载是同步阻塞，权重最高；响应回来伴随 decontextify 的同步开销，是
 * 「一批请求同时回来」型卡顿的主因。
 */
export function getRecentActivity(windowMs: number, now = Date.now()): ActivitySample[] {
    const out: ActivitySample[] = []
    for (const item of activities.values()) {
        const kinds: ActivitySample['kinds'] = []
        let agoMs = Number.POSITIVE_INFINITY

        if (item.loading) {
            kinds.push('loading')
            agoMs = Math.min(agoMs, now - item.loadStartedAt)
        }
        if (item.lastCallbackAt > 0 && now - item.lastCallbackAt <= windowMs) {
            kinds.push('callback')
            agoMs = Math.min(agoMs, now - item.lastCallbackAt)
        }
        if (item.lastRequestAt > 0 && now - item.lastRequestAt <= windowMs) {
            kinds.push('request')
            agoMs = Math.min(agoMs, now - item.lastRequestAt)
        }
        if (item.inflight > 0) {
            kinds.push('inflight')
        }
        if (kinds.length === 0) continue

        out.push({
            owner: item.owner,
            id: item.id,
            name: item.name,
            kinds,
            callbacks: item.callbacks,
            inflight: item.inflight,
            loadCostMs: item.lastLoadCostMs,
            agoMs: Number.isFinite(agoMs) ? agoMs : now - item.lastCallbackAt,
        })
    }
    const rank = (s: ActivitySample): number =>
        s.kinds.includes('loading') ? 0 : s.kinds.includes('callback') ? 1 : s.kinds.includes('request') ? 2 : 3
    out.sort((a, b) => rank(a) - rank(b) || a.agoMs - b.agoMs)
    return out
}

/** /health 与诊断面板用：当前活动账本快照 */
export function getActivitySnapshot(): Array<{
    name: string
    inflight: number
    requests: number
    callbacks: number
    loading: boolean
    lastLoadCostMs: number
    stallHits: number
    requestLimit: number
    throttledWaits: number
}> {
    const now = Date.now()
    return Array.from(activities.values())
        .filter(a => now - Math.max(a.lastCallbackAt, a.lastRequestAt, a.lastLoadEndAt) < 10 * 60 * 1000 || a.loading || a.inflight > 0)
        .map(a => ({
            name: a.name,
            inflight: a.inflight,
            requests: a.requests,
            callbacks: a.callbacks,
            loading: a.loading,
            lastLoadCostMs: a.lastLoadCostMs,
            stallHits: a.stallHits,
            requestLimit: a.requestLimit,
            throttledWaits: a.throttledWaits,
        }))
}

// ============================ L2-a：请求并发闸门 ============================

interface Gate {
    limit: number
    inflight: number
    waiters: Array<() => void>
}

const gates = new Map<string, Gate>()

const ensureGate = (key: string): Gate => {
    let gate = gates.get(key)
    if (!gate) {
        gate = { limit: -1, inflight: 0, waiters: [] }
        gates.set(key, gate)
    }
    return gate
}

/**
 * 取一个请求槽位。不限流时同步返回；被限流且已占满时排队等待。
 *
 * 返回的 release 必须调用一次。槽位直接移交给队首等待者（而不是先减后加），
 * 避免交接瞬间被新来的请求插队导致实际并发超过上限。
 */
export async function acquireRequestSlot(owner: string, id: string): Promise<() => void> {
    const key = activityKey(owner, id)
    const gate = ensureGate(key)
    const item = activities.get(key)

    if (gate.limit >= 0 && gate.inflight >= gate.limit) {
        if (item) item.throttledWaits++
        await new Promise<void>(resolve => { gate.waiters.push(resolve) })
        // 被唤醒即意味着继承了上一个释放者的槽位，inflight 已经计在内
        return () => releaseSlot(key)
    }
    gate.inflight++
    return () => releaseSlot(key)
}

const releaseSlot = (key: string): void => {
    const gate = gates.get(key)
    if (!gate) return
    const next = gate.waiters.shift()
    if (next) {
        // 槽位直接移交，总数不变
        next()
        return
    }
    if (gate.inflight > 0) gate.inflight--
}

/** 设置脚本的请求并发上限，-1 为不限 */
export function setRequestLimit(owner: string, id: string, limit: number): void {
    const gate = ensureGate(activityKey(owner, id))
    gate.limit = limit < 0 ? -1 : Math.max(1, Math.round(limit))
    const item = activities.get(activityKey(owner, id))
    if (item) item.requestLimit = gate.limit
    // 放宽上限后要把已经排队的人放出来，否则它们会一直等到有释放才动
    if (gate.limit < 0) {
        const waiting = gate.waiters.splice(0)
        for (const w of waiting) w()
    } else {
        while (gate.waiters.length > 0 && gate.inflight < gate.limit) {
            const w = gate.waiters.shift()
            if (!w) break
            gate.inflight++
            w()
        }
    }
}

export const getRequestLimit = (owner: string, id: string): number => ensureGate(activityKey(owner, id)).limit

// ============================ L2-b：长周期定时器抖动 ============================

/**
 * 给长周期定时器加随机抖动，避免多个脚本的周期任务撞在同一刻。
 *
 * 单个脚本的自我调度循环（干完活再 setTimeout 下一个）抖动后周期会漂移，
 * 但对健康探测这类任务无害——它本来就不要求精确的 600 秒。
 */
export function jitterDelay(ms: number): number {
    if (!TIMER_JITTER_ENABLED) return ms
    if (!Number.isFinite(ms) || ms < TIMER_JITTER_MIN_MS) return ms
    const ratio = TIMER_JITTER_RATIO > 0 ? TIMER_JITTER_RATIO : 0.15
    const delta = ms * ratio
    return Math.round(ms + (Math.random() * 2 - 1) * delta)
}

// ============================ L2-c：重载串行化 ============================

let reloadChain: Promise<unknown> = Promise.resolve()

/**
 * 把脚本重载排进全局串行队列。
 *
 * 一次重载就是一次同步 eval（实测 2~6 秒），并发重载会直接叠加成十几秒的卡顿。
 * 串行后每次只堵一个脚本的时长。
 */
export function runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const run = reloadChain.then(task, task)
    // 无论成功失败都要把链条接回去，否则一次异常会让后续所有重载永久挂起
    reloadChain = run.then(() => undefined, () => undefined)
    return run
}

// ============================ 宿主活动标记 ============================

/**
 * 宿主自身发起的批量动作（典型是音源巡检）。
 *
 * 巡检会同时驱动几十个脚本发请求，此时卡顿的真凶是**巡检本身**而不是某个脚本，
 * 但账本上会有一堆脚本「响应刚回来」，直接归因必然误伤。这里给宿主活动也留痕，
 * 归因时据此把结论标成「宿主巡检期」，提醒别急着禁用无辜的音源。
 */
interface HostActivity {
    startedAt: number
    detail: string
}

const hostActivities = new Map<string, HostActivity>()

export function beginHostActivity(kind: string, detail = ''): void {
    hostActivities.set(kind, { startedAt: Date.now(), detail })
}

export function endHostActivity(kind: string): void {
    hostActivities.delete(kind)
}

export function getActiveHostActivities(now = Date.now()): Array<{ kind: string; detail: string; elapsedMs: number }> {
    return Array.from(hostActivities.entries()).map(([kind, v]) => ({
        kind,
        detail: v.detail,
        elapsedMs: now - v.startedAt,
    }))
}

// ============================ 归因联动 ============================

/**
 * 记录一次卡顿归因命中，并按策略自动降速。
 * 返回本次采取的动作描述（写日志 + 进归因记录）。
 */
export function registerStallHit(owner: string, id: string, name: string): string | null {
    const item = touch({ owner, id, name })
    const now = Date.now()
    // 长时间没再被归因 → 视为已经安静，重新开始观察
    if (item.lastStallHitAt > 0 && now - item.lastStallHitAt > AUTO_THROTTLE_RELEASE_MS) {
        item.stallHits = 0
        if (item.requestLimit >= 0) {
            setRequestLimit(owner, id, -1)
            console.log(`[音源活动] ${name} 已安静超过 ${Math.round(AUTO_THROTTLE_RELEASE_MS / 60000)} 分钟，解除请求限流`)
        }
    }
    item.stallHits++
    item.lastStallHitAt = now

    if (AUTO_THROTTLE_STREAK <= 0) return null
    if (item.stallHits < AUTO_THROTTLE_STREAK) return null
    if (getRequestLimit(owner, id) === AUTO_THROTTLE_LIMIT) return null

    setRequestLimit(owner, id, AUTO_THROTTLE_LIMIT)
    return `已自动降速：请求并发限制为 ${AUTO_THROTTLE_LIMIT}（第 ${item.stallHits} 次被归因）`
}
