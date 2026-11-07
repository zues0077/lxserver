/**
 * 「源 × 平台 × 音质档」失败账本 —— 按档位短路，而不是按源整体降权。
 *
 * 现状的沉底账本（`playFailSink`）只有「源 × 平台」两个维度：某个聚合源在
 * flac 档全军覆没（很常见：它的 flac 后端只是个会超时的壳），账本记的却是
 * 「这个源不行」，于是它**能用的 128k 档也被一起排到队尾**，每首新歌都要
 * 陪它多等几秒。反过来，只有单档失败的证据也永远攒不够，无法把必然失败的
 * 档位摘出去。
 *
 * 所以这里补上第三个维度：
 *
 *   - 同一「源 × 平台 × 档」累积到 `minSamples`（默认 3）次尝试、且**一次都没成功**，
 *     就短路该档 `blockMs`（默认 1 小时）；
 *   - 短路到期后自动放行一次「探路」：成功即永久恢复（`successes > 0` 不再短路），
 *     失败则重新短路 —— 这样即使源后来悄悄修好了，最多一小时内也能自己恢复，
 *     不会像「永久黑名单」那样把人锁死；
 *   - 成功过就没有短路资格（`successes === 0` 是硬条件），避免把偶然连败的
 *     正常档位误判成坏档；
 *   - 长时间没被触碰（默认 6 小时）的记录视为过期，下次重新从头计数，
 *     防止一个月前的一次集中失败永久压制某个档。
 *
 * 与沉底账本的共同点：**都只影响尝试顺序/是否白跑，不影响源的启停**，
 * 也不写 states.json。账本全在内存，进程重启即清零。
 */

export interface QualityTarget {
    owner: string
    id: string
    platform: string
    quality: string
}

export interface QualityLedgerOptions {
    /** 累计尝试多少次才允许短路 */
    minSamples: number
    /** 短路时长（到期后放行一次探路） */
    blockMs: number
    /** 多久没被触碰就把记录当过期，重新计数 */
    idleResetMs: number
}

export interface QualityRecord {
    attempts: number
    successes: number
    lastAttemptAt: number
    lastFailAt: number
    /** 0 = 未短路；> now = 短路中 */
    blockedUntil: number
    /** 累计被短路几次（探路失败会 +1），排障用 */
    blocks: number
}

const DEFAULTS: QualityLedgerOptions = {
    minSamples: 3,
    blockMs: 60 * 60 * 1000,
    idleResetMs: 6 * 60 * 60 * 1000,
}

let options: QualityLedgerOptions = { ...DEFAULTS }
const ledger = new Map<string, QualityRecord>()

/** 覆盖阈值（主要给单测与配置项用） */
export const setQualityLedgerOptions = (patch: Partial<QualityLedgerOptions>): void => {
    options = { ...options, ...patch }
}

export const getQualityLedgerOptions = (): QualityLedgerOptions => ({ ...options })

/** 清空账本并恢复默认阈值 */
export const resetQualityLedger = (): void => {
    ledger.clear()
    options = { ...DEFAULTS }
}

export const qualityLedgerKey = (t: QualityTarget): string =>
    `${t.owner || ''}:${t.id || ''}:${t.platform || ''}:${t.quality || ''}`

/**
 * 记一次「源 × 平台 × 档」的取链结果。
 *
 * 没有音质档（空串）时不记账：档位缺失的调用无从区分，记了也只会污染账本。
 */
export const noteQualityResult = (
    target: QualityTarget,
    ok: boolean,
    now: number = Date.now(),
): QualityRecord | undefined => {
    if (!target || !target.quality) return undefined
    const key = qualityLedgerKey(target)
    let rec = ledger.get(key)
    if (rec && now - rec.lastAttemptAt > options.idleResetMs) rec = undefined
    if (!rec) {
        rec = { attempts: 0, successes: 0, lastAttemptAt: 0, lastFailAt: 0, blockedUntil: 0, blocks: 0 }
    }
    rec.attempts += 1
    rec.lastAttemptAt = now
    if (ok) {
        rec.successes += 1
        rec.blockedUntil = 0
    } else {
        rec.lastFailAt = now
        // blockedUntil <= now 才允许再次短路：短路期内继续失败不重复计时，
        // 到期后那次「探路」失败会立刻重新短路一个小时。
        if (rec.successes === 0 && rec.attempts >= options.minSamples && rec.blockedUntil <= now) {
            rec.blockedUntil = now + options.blockMs
            rec.blocks += 1
        }
    }
    ledger.set(key, rec)
    return rec
}

export const isQualityBlocked = (target: QualityTarget, now: number = Date.now()): boolean => {
    if (!target || !target.quality) return false
    const rec = ledger.get(qualityLedgerKey(target))
    return !!rec && rec.blockedUntil > now
}

/**
 * 按账本把候选分成「可用」与「短路中」。
 *
 * 调用方必须处理「可用为空」的情形：全部短路时应当忽略账本放行，否则会出现
 * 「所有源都被自己记的账挡住」的死局 —— 账本只允许省掉白跑，不允许造成无源可用。
 */
export const filterByQualityLedger = (
    candidates: any[],
    platform: string,
    quality: string,
    now: number = Date.now(),
): { usable: any[]; blocked: any[] } => {
    const usable: any[] = []
    const blocked: any[] = []
    if (!quality) return { usable: [...candidates], blocked }
    for (const api of candidates) {
        const info = api?.info || {}
        const target = { owner: String(info.owner || ''), id: String(info.id || ''), platform, quality }
        ;(isQualityBlocked(target, now) ? blocked : usable).push(api)
    }
    return { usable, blocked }
}

/**
 * 把账本结论套用到候选列表上：**可用源在前，短路中的源排到最后兜底**。
 *
 * 为什么是「排到队尾」而不是「本次不发」：账本记的是「源 × 平台 × 档」，
 * 而能不能出链还要看**这一首歌**。跨歌曲攒出来的证据只能说明「这一档大概率不行」，
 * 不能说明「这一首一定不行」——把源直接丢掉，等于让一次误判直接变成播放失败。
 *
 * 排到队尾同时拿到两边的好处：
 *   - 前面有可用源成功 → 循环提前返回，那几段超时预算照样省掉了（收益不变）；
 *   - 可用源全败 → 兜底再试它们一次，把「误杀」从失败降级成慢一拍（不会更坏）。
 *
 * 调用方必须处理 `rescuedAll`（全部在短路期）：那是探路，也是防死锁兜底。
 */
export const applyQualityLedger = (
    candidates: any[],
    platform: string,
    quality: string,
    now: number = Date.now(),
): { candidates: any[]; blocked: any[]; rescuedAll: boolean; reserve: number } => {
    const { usable, blocked } = filterByQualityLedger(candidates, platform, quality, now)
    if (blocked.length === 0) return { candidates, blocked, rescuedAll: false, reserve: 0 }
    if (usable.length === 0) return { candidates, blocked, rescuedAll: true, reserve: 0 }
    return { candidates: [...usable, ...blocked], blocked, rescuedAll: false, reserve: blocked.length }
}

/**
 * 取链成功时清掉该源该平台的档位记录。
 *
 * ⚠️ 只在「脚本换新 / 源被重载」时调用（旧证据针对旧实现，必须作废）。
 * **不要**在单次取链成功时调用：成功的是那一档，平台下别的档的失败证据仍然有效，
 * 一起清掉会让坏档永远攒不够样本、永远短路不了。
 */
export const clearQualityLedger = (owner: string, id: string, platform?: string): number => {
    const prefix = `${owner || ''}:${id || ''}:${platform || ''}`
    let removed = 0
    for (const key of [...ledger.keys()]) {
        const matched = platform === undefined
            ? key.startsWith(`${owner || ''}:${id || ''}:`)
            : key.startsWith(prefix + ':')
        if (matched) {
            ledger.delete(key)
            removed += 1
        }
    }
    return removed
}

export const qualityLedgerSize = (): number => ledger.size

/** 诊断快照：/health 用，只暴露汇总与仍在短路的条目，避免把全量账本抖出去 */
export const qualityLedgerSnapshot = (now: number = Date.now()): {
    total: number
    blocked: Array<{ key: string; attempts: number; successes: number; blocks: number; until: string }>
} => {
    const blocked: Array<{ key: string; attempts: number; successes: number; blocks: number; until: string }> = []
    for (const [key, rec] of ledger) {
        if (rec.blockedUntil <= now) continue
        blocked.push({
            key,
            attempts: rec.attempts,
            successes: rec.successes,
            blocks: rec.blocks,
            until: new Date(rec.blockedUntil).toISOString(),
        })
    }
    return { total: ledger.size, blocked }
}
