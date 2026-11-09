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

import { markLedgerDirty } from './sourceLedgerDirty'

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
/**
 * 失败一次折算的额外成本（ms）：相当于多跑一个兜底源。
 *
 * 2026-11-08 由 1500 上调到 3000：3h soak 实测「收集の聚合接口(LX版)/落雪版」在 tx
 * 排在最前却连续失败两轮才让位——1500ms 的惩罚扛不住 300ms 级 EWMA 的诱惑
 * （300 + 0.5×1500 = 1050 仍小于健康源的 1200 中性分），排前失败的源降不下去。
 * 3000 后同例 = 300 + 0.5×3000 = 1800 > 1200，第一轮失败就落到健康源之后，
 * 不必等第二轮超时把它打进冷却。
 */
export const FAIL_PENALTY_MS = 3000
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
    try { markLedgerDirty() } catch { /* 落盘标记失败不影响排序 */ }
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
 * 单源取链超时的自适应上限（ms）。
 *
 * 为什么需要它：`budgetForSource()` 原来的下限是**硬编码 5000ms**。那个地板的初衷是
 * 「保证每个源都能上场」，但对**已知很快**的源是纯浪费 —— 墨澜 EWMA 146ms，它一旦挂死，
 * 用户就得干等 5 秒才轮到下一个源。实测 17950 全生命周期 344 次成功里夹着
 * **72 次 5 秒满超时（17%）**，每次白等 5 秒，这才是「首播卡」的主因，不是总预算 8s。
 *
 * 规则：`clamp(EWMA × 4, 3000, 5000)`
 *  - **×4 的余量**：源本身抖得厉害（实测裤佬同一首歌 0.8/1.0/3.6s 都出现过），
 *    给 2 倍会把偶发慢当成失败，4 倍才留得住；
 *  - **下限 3000**：已知快源（EWMA ≤ 750ms）才有机会被压到 3s，慢源根本摸不到这个下限；
 *  - **上限 5000**：与改动前完全一致 —— 裤佬 EWMA 1676ms → 6704 → 夹到 5000，行为不变；
 *  - **样本不足 / 从未成功 → 5000**：没证据就不猜，保持原样。
 *
 * 注意这是「预算」，不是「判定源坏了」：到点只是提前换下一个候选，失败照常记账。
 */
export const ADAPTIVE_TIMEOUT_MIN_MS = 3000
export const ADAPTIVE_TIMEOUT_MAX_MS = 5000
export const adaptiveTimeoutMs = (target: PlayRankTarget): number => {
    const rec = stats.get(playRankKey(target))
    if (!rec || rec.attempts < MIN_TRUST || rec.successes === 0 || rec.ewmaMs <= 0) {
        return ADAPTIVE_TIMEOUT_MAX_MS
    }
    const want = Math.round(rec.ewmaMs * 4)
    return Math.min(ADAPTIVE_TIMEOUT_MAX_MS, Math.max(ADAPTIVE_TIMEOUT_MIN_MS, want))
}

/** 同一源在「别的档 / 别的平台」上的最好成绩，本档没样本时当先验 */
export interface PlayRankPrior {
    /** 同源同平台的其它档位 */
    samePlatform?: number
    /** 同源任意平台 */
    anyKey?: number
}

/** 先验索引：`owner:id` → 各平台最好成绩 + 全局最好成绩 */
export interface PlayRankPriorIndex {
    byKey: Map<string, { byPlatform: Map<string, number>; anyKey: number }>
}

/**
 * 一次性算出每个源「别的键」上的最好成绩，供本档没样本时当先验。
 *
 * 为什么需要：2026-11-08 实测，容器重启后账本清零，`裤佬 wy:320k` 先攒到 9 次样本
 * （EWMA 1798ms）排在第一，`墨澜 wy:320k` 只被试了 1 次（160ms）——**样本不足
 * `MIN_TRUST` 一律给中性分 1200ms**，于是 1798ms 的源稳稳压在 160ms 的源前面：
 * 同一首歌 17952 要 728~2661ms、17950 只要 136~239ms。可墨澜在 mg 上早有 4 次样本
 * （426ms），这条证据本来就能说明「这个源整体不慢」。
 *
 * 所以本档没证据时先看同源别的键；**只用来提前、不用来惩罚**
 * （`playRankScore` 里取 `Math.min(NEUTRAL_MS, prior)`），
 * 本档攒到 2 次样本后自动失效，别的平台的快慢不会长期决定这里的顺序。
 */
export const buildPlayRankPriors = (): PlayRankPriorIndex => {
    const byKey = new Map<string, { byPlatform: Map<string, number>; anyKey: number }>()
    for (const [key, rec] of stats) {
        if (rec.successes === 0 || rec.ewmaMs <= 0) continue
        const parts = key.split(':')
        if (parts.length < 4) continue
        const platform = parts[parts.length - 2]
        const ownerId = parts.slice(0, parts.length - 2).join(':')
        let cur = byKey.get(ownerId)
        if (!cur) {
            cur = { byPlatform: new Map(), anyKey: Number.POSITIVE_INFINITY }
            byKey.set(ownerId, cur)
        }
        const prev = cur.byPlatform.get(platform)
        if (prev === undefined || rec.ewmaMs < prev) cur.byPlatform.set(platform, rec.ewmaMs)
        if (rec.ewmaMs < cur.anyKey) cur.anyKey = rec.ewmaMs
    }
    return { byKey }
}

/** 取某个源的先验（平台维度优先，回落到全局最好） */
const priorFor = (index: PlayRankPriorIndex | undefined, owner: string, id: string, platform: string): PlayRankPrior | undefined => {
    const entry = index?.byKey.get(`${owner}:${id}`)
    if (!entry) return undefined
    return {
        samePlatform: entry.byPlatform.get(platform),
        anyKey: Number.isFinite(entry.anyKey) ? entry.anyKey : undefined,
    }
}

/**
 * 排序分：越小越靠前。
 * 无样本 / 样本不足 → 跨档先验（若比中性分更好）→ 否则 `NEUTRAL_MS`；从未成功 → `Infinity`。
 *
 * 2026-11-09（Y.11 修复）：失败-only 记录原来在进程生命周期内**永久 Infinity** ——
 * `now` 参数在函数体内从未被使用，落盘的 6h TTL 只管导出、不管打分，实测 +1 年仍 Infinity。
 * 现在加「降级时钟」：最后一次失败超过 `STALE_FAIL_MS` 就退回中性分（只是"不再罚"，
 * 不会把它抬到有实测样本的源前面）；再失败一次刷新 lastAt，重新 Infinity。
 */
export const STALE_FAIL_MS = 30 * 60 * 1000

/**
 * 跨平台先验打折（Y.11 修复）：`anyKey` 是「别的平台的最好成绩」，证据强度天然弱于
 * 本平台实测 —— kw 上 1683ms 的源不该被当成"这个源整体慢"直接判死 tx（跨平台污染），
 * 反过来 mg 上 426ms 也不该全等于 wy 的 426ms。先验只作"弱证据"，乘一个折扣。
 */
export const ANYKEY_DISCOUNT = 1.3

export const playRankScore = (
    target: PlayRankTarget,
    now: number = Date.now(),
    prior?: PlayRankPrior,
): number => {
    const rec = stats.get(playRankKey(target))
    if (!rec || rec.attempts < MIN_TRUST) {
        // 有一次失败记录但从未成功：不给先验，别拿别的键把它抬上来
        if (rec && rec.successes === 0 && rec.attempts > 0) return NEUTRAL_MS
        const priorMs = prior?.samePlatform
            ?? (prior?.anyKey !== undefined ? prior.anyKey * ANYKEY_DISCOUNT : undefined)
        return priorMs !== undefined && priorMs > 0 ? Math.min(NEUTRAL_MS, priorMs) : NEUTRAL_MS
    }
    if (rec.successes === 0) {
        if (now - rec.lastAt >= STALE_FAIL_MS) return NEUTRAL_MS
        return Number.POSITIVE_INFINITY
    }
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
    // 先验一次算完：本档没样本的源用「同源别的键」的成绩提前，
    // 避免重启后「先被试过的慢源」靠样本数压住「没被试过的快源」
    const priors = buildPlayRankPriors()
    const scored = candidates.map((api: any) => {
        const info = api?.info || {}
        const owner = String(info.owner || '')
        const id = String(info.id || '')
        const score = playRankScore(
            { owner, id, platform, quality },
            now,
            priorFor(priors, owner, id, platform),
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

// ==================== ε-greedy 试探（Y.11-5 修复「账本锁定」）====================
// 排序/沉底/冷却都是「证据优先」：一个源在本平台没被证明过（或历史失败），
// 只要首选源持续成功，它就永远不会被尝试 —— 实测隔离实例里最快源（20ms）失败一次后
// 连点 10 首正常歌 0 次被试，每首白付 280ms；生产侧 tx 上 84ms 的西瓜聚合源全程 0 次尝试。
// 修复不改打分公式（惩罚本身可逆，缺的只是"被试一次"的机会），而是反向探索：
// 首选源被证明稳定成功后，周期性给一个「本平台未证明 + 有跨平台成功史」的源一次
// 低预算队首先手。成功 → 记录重置重新洗牌（见 noteProbeSuccessReset）；
// 失败 → 照常记账，代价被 PROBE_BUDGET_MS 兜住。

/** 试探只在「源多且差异大」的平台开，先观察 tx/kg，别的平台以后按数据决定 */
export const PROBE_PLATFORMS = ['tx', 'kg']
/** 同一「平台:档」两次试探的最小间隔：1 小时最多 6 次探索，代价可控 */
export const PROBE_INTERVAL_MS = 10 * 60 * 1000
/** 试探预算（ms）：挂了最多白吃 1.5s，均摊 ~150ms/首；好了省出 200ms+/首 */
export const PROBE_BUDGET_MS = 1500
/** 首选源至少成功这么多次才算「稳定」，才值得花一次探索 */
export const PROBE_MIN_TOP_SUCCESSES = 10
/** 首选源失败超过这个数就不试探（首选自己都不稳，先顾自己） */
export const PROBE_TOP_MAX_FAILS = 2

const lastProbeAt = new Map<string, number>()

/** 测试用：清空试探节流状态 */
export const resetProbeState = (): void => { lastProbeAt.clear() }

/**
 * 选出本次该试探的源（若有的话）。
 *
 * 资格（三条同时满足）：
 *  1. 平台在 `PROBE_PLATFORMS` 且距上次试探 ≥ `PROBE_INTERVAL_MS`；
 *  2. 队首（调用方排好序后的第一个）稳定成功：successes ≥ `PROBE_MIN_TOP_SUCCESSES`
 *     且失败 ≤ `PROBE_TOP_MAX_FAILS`；
 *  3. 候选里有「本平台未证明」的源（Y.11-6 放宽，2026-11-09 用户拍板）：
 *     - 本平台无记录 / 样本不足 MIN_TRUST（从没真正跑过），或
 *     - 失败-only 但已过降级时钟（旧失败证据过期，见 `STALE_FAIL_MS`）。
 *     刚失败不久的（新鲜 Infinity）**不**试探——最近证据是负的。
 *     原「必须有跨平台成功史」的门槛已移除：被锁源恰恰最缺证据（唯一记录可能已被
 *     TTL 清空），绑证据 = 永远 0 次试探机会——生产 tx 上 84ms 的西瓜聚合源整小时
 *     0 次资格就是这个原因。
 *
 * 多个候选时按先验择优：有证据的（samePlatform / anyKey×折扣）排在完全无证据的
 * （按 `NEUTRAL_MS` 计）前面。返回后由调用方把它插到队首，
 * 并用 `PROBE_BUDGET_MS` 收紧预算；返回 undefined 表示本轮不试探。
 */
export const planProbeCandidate = (
    candidates: any[],
    platform: string,
    quality: string,
    now: number = Date.now(),
    priors?: PlayRankPriorIndex,
): { api: any; priorMs: number } | undefined => {
    if (!quality || candidates.length < 3 || !PROBE_PLATFORMS.includes(platform)) return undefined
    const probeKey = `${platform}:${quality}`
    if (now - (lastProbeAt.get(probeKey) || 0) < PROBE_INTERVAL_MS) return undefined
    const top = candidates[0]
    const topRec = stats.get(playRankKey({
        owner: String(top?.info?.owner || ''),
        id: String(top?.info?.id || ''),
        platform,
        quality,
    }))
    if (!topRec
        || topRec.successes < PROBE_MIN_TOP_SUCCESSES
        || topRec.attempts - topRec.successes > PROBE_TOP_MAX_FAILS) return undefined
    const index = priors || buildPlayRankPriors()
    let best: { api: any; priorMs: number } | undefined
    for (let i = 1; i < candidates.length; i++) {
        const api = candidates[i]
        const owner = String(api?.info?.owner || '')
        const id = String(api?.info?.id || '')
        const rec = stats.get(playRankKey({ owner, id, platform, quality }))
        // 刚失败不久的（失败-only 且未过降级时钟）不试探，哪怕样本数还没到 MIN_TRUST
        // ——最近证据是负的，别把刚翻车的源又推上队首
        if (rec && rec.successes === 0 && now - rec.lastAt < STALE_FAIL_MS) continue
        const unproven = !rec || rec.attempts < MIN_TRUST
        const staleFailOnly = !!rec && rec.successes === 0 && now - rec.lastAt >= STALE_FAIL_MS
        if (!unproven && !staleFailOnly) continue
        const pf = priorFor(index, owner, id, platform)
        // 完全无证据的源按中性分参与择优：有实测先验的候选天然排它前面
        const priorMs = pf?.samePlatform
            ?? (pf?.anyKey !== undefined ? pf.anyKey * ANYKEY_DISCOUNT : NEUTRAL_MS)
        if (!best || priorMs < best.priorMs) best = { api, priorMs }
    }
    if (!best) return undefined
    lastProbeAt.set(probeKey, now)
    return best
}

/**
 * 试探成功 = 旧惩罚判错了（源其实健康）：把该键记录重置为这一次成功，从零重新竞争。
 * 若只照常记账（attempts=2/successes=1），50% 失败率 × FAIL_PENALTY_MS 会把它压回
 * 队尾，试探就永远白做 —— 生产 tx 实算要 17 次试探才能翻身，不可接受。
 * 试探失败不走这里，照常 notePlayResult 记失败。
 */
export const noteProbeSuccessReset = (
    target: PlayRankTarget,
    costMs: number,
    now: number = Date.now(),
): void => {
    if (!target || !target.quality) return
    const raw = Math.max(0, Number(costMs) || 0)
    // attempts 给到 MIN_TRUST：1 次样本会落进「样本不足 → 中性分」分支，
    // 等于没重置（1200 分照样排不进前列）；2 次 = 直接进实测分数分支
    stats.set(playRankKey(target), {
        attempts: MIN_TRUST,
        successes: MIN_TRUST,
        ewmaMs: Math.min(raw, 60000),
        lastAt: now,
    })
    try { markLedgerDirty() } catch { /* 落盘标记失败不影响排序 */ }
}

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

// ==================== 落盘（重启后不丢学习成果）====================
// 2026-11-08 实测：每次更新/重启容器，账本清零 → 第一次听歌又踩回 order.json 排第一的源。
// 17952 重启后首请求 5320ms（裤佬 5 秒超时→墨澜），之后才稳定在 111~201ms。
// 这里只导出「还新鲜」的记录，落盘/加载由 sourceLedgerStore 负责。
export interface PlayRankState {
    v: 1
    records: Array<[string, PlayRankRecord]>
}

/** 6 小时前的成绩不再可信：上游状态会变，别让昨天的慢拖住今天 */
export const PLAY_RANK_STATE_TTL_MS = 6 * 60 * 60 * 1000

export const exportPlayRankState = (now: number = Date.now()): PlayRankState => {
    const records: Array<[string, PlayRankRecord]> = []
    for (const [key, rec] of stats) {
        if (!rec || !(now - rec.lastAt < PLAY_RANK_STATE_TTL_MS)) continue
        records.push([key, { ...rec }])
    }
    return { v: 1, records }
}

/** 恢复。返回实际载入的条数；任何异常都不抛，账本是「锦上添花」，不能挡住启动 */
export const importPlayRankState = (state: any, now: number = Date.now()): number => {
    if (!state || !Array.isArray(state.records)) return 0
    let n = 0
    for (const item of state.records) {
        if (!Array.isArray(item) || item.length < 2) continue
        const [key, rec] = item
        if (typeof key !== 'string' || !key || !rec) continue
        const attempts = Number(rec.attempts) || 0
        const successes = Number(rec.successes) || 0
        const ewmaMs = Number(rec.ewmaMs) || 0
        const lastAt = Number(rec.lastAt) || 0
        if (!attempts || lastAt <= 0) continue
        if (!(now - lastAt < PLAY_RANK_STATE_TTL_MS)) continue
        if (stats.size >= MAX_ENTRIES) break
        stats.set(key, { attempts, successes, ewmaMs, lastAt })
        n += 1
    }
    return n
}
