/**
 * 源「历史成绩」排序 —— 给候选源做**正向**排序，而不只是把失败源沉底。
 *
 * 现状：`playSink`（失败沉底）和 `qualityLedger`（按档短路）都只做减法 ——
 * 坏源往后排、必败档直接不发。好源之间的先后始终由 order.json / 加载顺序决定，
 * 与真实快慢无关。实测同一平台的源，快的 110ms、慢的 1.9s（17 倍），
 * 而排序完全靠运气。
 *
 * 这里补上加法：按「源 × 平台 × 档」记成功耗时（EWMA）与成功率，
 * 下次请求把快的排在前面。三条克制的设计：
 *
 *  - **样本不足不动手**：见 `MIN_TRUST`。新装/新源没有证据时给中性分，
 *    保持原有相对顺序，不能凭一次偶然快慢就重排全场；
 *  - **从没成功过 = 无穷大**：排到最后（真正的处置交给沉底账本，这里只排序）；
 *  - **失败按「多花一次兜底时间」折算**：`ewma + 失败率 × FAIL_PENALTY_MS`。
 *    失败一次不是 0 成本 —— 它意味着要把后面那个源再跑一遍，所以用加法不用乘法：
 *    300ms 但一半失败 ≈ 300 + 750 = 1050ms，会排在 700ms 全成功的源后面，符合预期。
 *
 * 账本全在内存，进程重启即清零；单条记录 40 字节级，条目数有上限。
 */

export interface PlayRankTarget {
    owner: string
    id: string
    platform: string
    quality: string
}

export interface PlayRankRecord {
    /** 总尝试次数（含失败） */
    attempts: number
    /** 成功次数 */
    successes: number
    /** 成功耗时的指数加权均值（ms），0 表示还没有成功样本 */
    ewmaMs: number
    lastAt: number
}

/** 没有足够证据时的中性分：不鼓励也不惩罚，靠原有顺序决定 */
export const NEUTRAL_MS = 1200
/** 至少这么多次尝试才参与重排 */
export const MIN_TRUST = 2
/** EWMA 平滑系数：偏小更稳，偏大更快跟上变化 */
const ALPHA = 0.35
/** 失败一次折算的额外成本（ms）：相当于多跑一个兜底源 */
export const FAIL_PENALTY_MS = 1500
/** 条目上限，防止长时间运行无限增长 */
const MAX_ENTRIES = 2000

const stats = new Map<string, PlayRankRecord>()

export const playRankKey = (t: PlayRankTarget): string =>
    `${t.owner || ''}:${t.id || ''}:${t.platform || ''}:${t.quality || ''}`

/** 记一次取链结果。没有音质档时不记（无从区分档位，记了只会互相污染） */
export const notePlayResult = (
    target: PlayRankTarget,
    ok: boolean,
    costMs: number = 0,
    now: number = Date.now(),
): void => {
    if (!target || !target.quality) return
    const key = playRankKey(target)
    let rec = stats.get(key)
    if (!rec) {
        if (stats.size >= MAX_ENTRIES) stats.clear()
        rec = { attempts: 0, successes: 0, ewmaMs: 0, lastAt: 0 }
    }
    rec.attempts += 1
    rec.lastAt = now
    if (ok) {
        rec.successes += 1
        // 单次异常值不能把均值带飞：上限跟着当前均值走（最多 4 倍），
        // 没有历史时才用 60s 的绝对上限。
        const raw = Math.max(0, Number(costMs) || 0)
        const cap = rec.ewmaMs > 0 ? Math.max(rec.ewmaMs * 4, 1000) : 60000
        const ms = Math.min(raw, cap)
        if (rec.ewmaMs > 0) rec.ewmaMs = rec.ewmaMs * (1 - ALPHA) + ms * ALPHA
        else rec.ewmaMs = ms
    }
    stats.set(key, rec)
}

export const getPlayRankRecord = (target: PlayRankTarget): PlayRankRecord | undefined => {
    const rec = stats.get(playRankKey(target))
    return rec ? { ...rec } : undefined
}

/**
 * 排序分：越小越靠前。
 * 无样本 / 样本不足 → `NEUTRAL_MS`；从未成功 → `Infinity`（垫底）。
 */
export const playRankScore = (target: PlayRankTarget, now: number = Date.now()): number => {
    const rec = stats.get(playRankKey(target))
    if (!rec || rec.attempts < MIN_TRUST) return NEUTRAL_MS
    if (rec.successes === 0) return Number.POSITIVE_INFINITY
    const failRate = 1 - rec.successes / rec.attempts
    return rec.ewmaMs + failRate * FAIL_PENALTY_MS
}

/**
 * 按历史成绩重排候选源；分数相同保持原相对顺序（稳定排序）。
 *
 * **换位要过门槛**（`clearlyBetter`）：2026-11-08 的实机对照实验里，同一份「慢源置顶」
 * 布置，两轮结果互相矛盾（一轮 17952 快 464ms，另一轮反而慢 1268ms）。原因不是算法错，
 * 而是**源的表现本身在抖**：某首歌上慢一次的源，EWMA 立刻被抬高，下一次就被降级；
 * 等它恢复又升回来 —— 排序在两套顺序之间来回摆，用户感到的是「有时快有时慢」。
 *
 * 所以排序改成「有把握才动」：只有当更优源的分数比当前源**既低 300ms 以上、
 * 又低 25% 以上**时才换位。判据越保守，顺序越稳；真正必败的源由沉底账本处理，
 * 这里只负责「明显更快的往前挪一点」。
 */
export const SWAP_MIN_ABS_MS = 300
export const SWAP_MIN_REL = 0.25

/** `better` 比 `worse` 好得足够明显吗（不够明显就不换位，保持原顺序） */
const clearlyBetter = (better: number, worse: number): boolean => {
    if (better === worse) return false
    if (!Number.isFinite(worse)) return true
    if (!Number.isFinite(better)) return false
    const gain = worse - better
    return gain >= SWAP_MIN_ABS_MS && gain >= worse * SWAP_MIN_REL
}

export const rankCandidatesByHistory = (
    candidates: any[],
    platform: string,
    quality: string,
    now: number = Date.now(),
): any[] => {
    if (!quality || candidates.length < 2) return candidates
    const scored = candidates.map((api: any) => {
        const info = api?.info || {}
        const score = playRankScore(
            { owner: String(info.owner || ''), id: String(info.id || ''), platform, quality },
            now,
        )
        return { api, score }
    })
    const rest = [...scored]
    const out: any[] = []
    while (rest.length > 0) {
        let bestIdx = 0
        for (let i = 1; i < rest.length; i++) {
            if (rest[i].score < rest[bestIdx].score) bestIdx = i
        }
        // 队首就是最优（或优势不够明显）时保持原位，避免为一点点差距反复改顺序
        if (bestIdx === 0 || !clearlyBetter(rest[bestIdx].score, rest[0].score)) {
            out.push(rest.shift()!.api)
        } else {
            out.push(rest.splice(bestIdx, 1)[0].api)
        }
    }
    return out
}

export const playRankSize = (): number => stats.size

/** 与 playRankScore 同口径，但直接吃记录（快照里已经拿到记录，不必再查一次表） */
const scoreOf = (rec: PlayRankRecord): number => {
    if (rec.attempts < MIN_TRUST) return NEUTRAL_MS
    if (rec.successes === 0) return Number.POSITIVE_INFINITY
    const failRate = 1 - rec.successes / rec.attempts
    return rec.ewmaMs + failRate * FAIL_PENALTY_MS
}

/**
 * 诊断快照（/health 用）：按排序分升序给出最能影响顺序的前 N 条。
 *
 * 为什么只给「有成功样本」的条目：从未成功的源分数是 Infinity，一律垫底，
 * 列出来只会淹没真正有用的数据（它们的情况看沉底账本更准）。
 * 带上 score 而不是只给 ewma，是为了让「为什么它被排到前面」一眼可核对：
 * score = ewmaMs + 失败率 × FAIL_PENALTY_MS。
 */
export const playRankSnapshot = (limit: number = 12): {
    total: number
    top: Array<{ key: string; attempts: number; successes: number; ewmaMs: number; score: number }>
} => {
    const rows: Array<{ key: string; attempts: number; successes: number; ewmaMs: number; score: number }> = []
    for (const [key, rec] of stats) {
        if (rec.successes === 0) continue
        rows.push({
            key,
            attempts: rec.attempts,
            successes: rec.successes,
            ewmaMs: Math.round(rec.ewmaMs),
            score: Math.round(scoreOf(rec)),
        })
    }
    rows.sort((a, b) => a.score - b.score)
    return { total: stats.size, top: rows.slice(0, Math.max(0, limit)) }
}

export const resetPlayRank = (): void => { stats.clear() }
