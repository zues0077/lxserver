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
 * 不改入参。
 */
export const rankCandidatesByHistory = (
    candidates: any[],
    platform: string,
    quality: string,
    now: number = Date.now(),
): any[] => {
    if (!quality || candidates.length < 2) return candidates
    const scored = candidates.map((api: any, index: number) => {
        const info = api?.info || {}
        const score = playRankScore(
            { owner: String(info.owner || ''), id: String(info.id || ''), platform, quality },
            now,
        )
        return { api, index, score }
    })
    scored.sort((a, b) => (a.score === b.score ? a.index - b.index : a.score - b.score))
    return scored.map(x => x.api)
}

export const playRankSize = (): number => stats.size

export const resetPlayRank = (): void => { stats.clear() }
