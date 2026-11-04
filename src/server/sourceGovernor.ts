/**
 * 音源执行调度（Source Governor）——「慢但真能用」的音源不该被一刀切停掉。
 *
 * ## 为什么要这一层
 * 246 实测（2026-11-04）：「非常刀」单条响应 3.18MB，parse 0ms / 深拷贝 3ms /
 * **脚本回调 5182ms**；「西瓜聚合源」3.53MB / 0ms / 12ms / **5582ms**。
 * 拆开看很清楚：卡顿不是响应体大，是脚本自己的同步逻辑在**主线程**上跑了 5 秒。
 * 这类源往往真的能出链（可用性没问题），问题只是它一跑就把整条事件循环占住：
 * 巡检 6 路并发时几个慢源叠在一起，就是手册 P-1046 里那段 12.6 秒的卡顿。
 *
 * 之前的处置是「30 分钟内第 3 次超 2 秒 → 隔离停用」，本质是拿可用性换稳定。
 * 更合适的做法是把它关进单间，让它慢的是它自己那一次调用：
 *
 * 1) **慢源之间互斥**：全局只有 1 个慢源在执行。慢源的同步块不会再和另一个慢源
 *    的同步块叠成 10 秒；主线程最坏只被一个慢源卡一次（这一次无法避免，除非把脚本
 *    搬出主线程 —— 那是下一阶段的 worker 隔离，不在本层范围）。
 * 2) **同一慢源单飞**：同时只跑 1 个、最多再排 1 个，再多直接失败让上层换源。
 *    慢源被连点 3 次不会再叠成 15 秒。
 * 3) **巡检里排到队尾**：它不再堵住其它源的探测；30 分钟无新慢记录自动回到正常，
 *    偶发一次不算数。
 *
 * ## 判定依据是「同步块实测」，不是「总耗时」
 * 网络慢不等于脚本重。`callRequest` 里调用脚本 handler 时记一次时间戳差
 * （handler 同步执行到第一个 await 的耗时），只有这段超过阈值才算「脚本自身重活」。
 * 响应回来后的回调耗时由 `reportSlowTask` 的 callbackMs 走同一条记账入口。
 */

/** 单次同步块超过该值算一次「慢」，默认 800ms（正常源通常几十毫秒） */
const DEFAULT_SYNC_MS = 800
/** 窗口内累计几次才降速运行 */
const DEFAULT_MIN_HITS = 2
/** 降速状态有效期（分钟）：到期自动回到正常，避免一次偶发把源永久戴帽子 */
const DEFAULT_TTL_MINUTES = 30
/** 同一慢源允许排队的请求数（正在跑的那个不算） */
const MAX_QUEUE = 1

export interface GovernorConfig {
    enabled: boolean
    syncMs: number
    minHits: number
    ttlMs: number
}

export interface ThrottleState {
    owner: string
    id: string
    name: string
    /** 窗口内命中次数 */
    hits: number
    /** 窗口起点 */
    since: number
    /** 降速状态到期时间（0 = 还没升级到降速） */
    until: number
    /** 观测到的最坏同步块耗时 */
    worstSyncMs: number
    /** 最近一次命中时间 */
    lastAt: number
}

const states = new Map<string, ThrottleState>()

const keyOf = (owner: string, id: string) => `${owner || ''}_${id || ''}`

const num = (v: any, fallback: number, min: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= min ? n : fallback
}

export function getGovernorConfig(): GovernorConfig {
    const cfg: any = (global as any).lx?.config || {}
    return {
        enabled: cfg['customSource.governor.enabled'] !== false,
        syncMs: num(cfg['customSource.governor.syncMs'], DEFAULT_SYNC_MS, 100),
        minHits: Math.max(1, Math.round(num(cfg['customSource.governor.minHits'], DEFAULT_MIN_HITS, 1))),
        ttlMs: Math.round(num(cfg['customSource.governor.ttlMinutes'], DEFAULT_TTL_MINUTES, 1) * 60 * 1000),
    }
}

function activeState(owner: string, id: string): ThrottleState | undefined {
    const key = keyOf(owner, id)
    const st = states.get(key)
    if (!st) return undefined
    const now = Date.now()
    // 超过 TTL 没有任何新命中 → 自动回到正常
    if (now - st.lastAt > getGovernorConfig().ttlMs) {
        states.delete(key)
        return undefined
    }
    return st
}

/** 该源当前是否处于「降速运行」状态 */
export function isThrottled(owner: string, id: string): boolean {
    const st = activeState(owner, id)
    return !!st && st.until > Date.now()
}

/** 该源当前是否已经在观测（有慢记录但还没升级） */
export function getThrottle(owner: string, id: string): ThrottleState | undefined {
    return activeState(owner, id)
}

export interface NoteResult {
    /** 记录后是否处于降速状态 */
    throttled: boolean
    /** 本次是否刚刚升级到降速（用于打一次日志，不要每次刷屏） */
    justThrottled: boolean
    /** 当前窗口内累计命中次数 */
    hits: number
}

/**
 * 记一次「脚本同步块」实测耗时。
 *
 * @param syncMs 脚本 handler 同步执行（到第一个 await 之前）的耗时，或响应回调的 callbackMs
 * @returns 降速状态变化
 */
export function noteSyncBlock(owner: string, id: string, name: string, syncMs: number): NoteResult {
    const cfg = getGovernorConfig()
    const base: NoteResult = { throttled: false, justThrottled: false, hits: 0 }
    if (!cfg.enabled || !owner || !id) return base
    if (!Number.isFinite(syncMs) || syncMs < cfg.syncMs) {
        const st = activeState(owner, id)
        return { throttled: !!st && st.until > Date.now(), justThrottled: false, hits: st?.hits || 0 }
    }

    const key = keyOf(owner, id)
    const now = Date.now()
    let st = states.get(key)
    // 窗口过期（或从未记录）：重开一个窗口
    if (!st || now - st.lastAt > cfg.ttlMs) {
        st = { owner, id, name: name || id, hits: 0, since: now, until: 0, worstSyncMs: 0, lastAt: now }
        states.set(key, st)
    }

    st.hits++
    st.lastAt = now
    st.name = name || st.name
    st.worstSyncMs = Math.max(st.worstSyncMs, Math.round(syncMs))

    if (st.hits >= cfg.minHits && st.until <= now) {
        st.until = now + cfg.ttlMs
        return { throttled: true, justThrottled: true, hits: st.hits }
    }
    return { throttled: st.until > now, justThrottled: false, hits: st.hits }
}

/** 手动解除降速（界面上「恢复正常」用） */
export function clearThrottle(owner: string, id: string): boolean {
    return states.delete(keyOf(owner, id))
}

/** 供接口/前端展示：当前所有被降速的源 */
export function listThrottled(): Array<ThrottleState & { remainingMs: number }> {
    const now = Date.now()
    const out: Array<ThrottleState & { remainingMs: number }> = []
    for (const [key, st] of [...states.entries()]) {
        if (now - st.lastAt > getGovernorConfig().ttlMs) {
            states.delete(key)
            continue
        }
        if (st.until > now) out.push({ ...st, remainingMs: st.until - now })
    }
    return out
}

/** 测试用：清空全部状态与在途计数 */
export function resetGovernorForTest(): void {
    states.clear()
    locks.clear()
    slowRunning = 0
    slowWaiters.length = 0
}

// ---------------------------------------------------------------------------
// 慢源互斥闸：全局同时只允许 1 个慢源在执行脚本
// ---------------------------------------------------------------------------
let slowRunning = 0
const slowWaiters: Array<() => void> = []

async function acquireSlowSlot(): Promise<void> {
    if (slowRunning < 1) {
        slowRunning = 1
        return
    }
    await new Promise<void>(resolve => slowWaiters.push(resolve))
    // 被唤醒时槽位直接从上一个持有者转交过来，slowRunning 保持 1
}

function releaseSlowSlot(): void {
    const next = slowWaiters.shift()
    if (next) {
        next()
        return
    }
    slowRunning = 0
}

// ---------------------------------------------------------------------------
// 同源单飞：慢源同时只跑 1 个，最多再排 1 个，再多让上层换源
// ---------------------------------------------------------------------------
interface LockState {
    tail: Promise<void>
    /** 在途数（含正在跑的和排队的） */
    busy: number
}

const locks = new Map<string, LockState>()

async function withSourceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let st = locks.get(key)
    if (!st) {
        st = { tail: Promise.resolve(), busy: 0 }
        locks.set(key, st)
    }
    // busy 是在途数：1 个在跑 + MAX_QUEUE 个排队之后再来就直接失败
    if (st.busy >= 1 + MAX_QUEUE) {
        throw new Error('该音源正在降速运行（同一时刻只处理一个请求），请稍后重试或换源')
    }
    st.busy++
    const prev = st.tail
    let release!: () => void
    st.tail = new Promise<void>(resolve => { release = resolve })
    try {
        await prev
        return await fn()
    } finally {
        st.busy--
        release()
    }
}

/**
 * 在调度层执行一次脚本调用。
 *
 * - 正常源：原样直通，不引入任何排队或延迟（不能为了慢源牺牲快源）
 * - 降速源：先过「同源单飞」，再过「慢源互斥闸」，然后执行
 */
export async function runWithGovernor<T>(
    owner: string,
    id: string,
    name: string,
    fn: () => Promise<T>,
): Promise<T> {
    const cfg = getGovernorConfig()
    if (!cfg.enabled) return fn()
    if (!isThrottled(owner, id)) return fn()

    const key = keyOf(owner, id)
    return withSourceLock(key, async () => {
        await acquireSlowSlot()
        try {
            return await fn()
        } finally {
            releaseSlowSlot()
        }
    })
}

/** 该源当前的排队情况（诊断用） */
export function getGovernorQueueDepth(owner: string, id: string): number {
    return locks.get(keyOf(owner, id))?.busy || 0
}
