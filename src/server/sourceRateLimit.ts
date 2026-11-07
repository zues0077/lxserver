/**
 * 限流（429）的独立通道 —— 限流不是「源坏了」，不能当成失败来记账。
 *
 * 现状：`notePlayFailure` 只记次数、不看原因；`isHardFailure` 也不含 429
 * （那是对的，429 确实是平台侧临时状态）。于是限流撞在什么地方就产生什么后果：
 *
 *   - 进沉底账本 → 一个健康源被限流几秒就被排到队尾十几分钟；
 *   - 进巡检账本（有对照组时）→ 更糟，可能被降权甚至关平台，
 *     而它只是刚才请求密了一点；
 *   - 进「源 × 档」账本 → 会把一个能用的档位判成必败档。
 *
 * 所以限流单独走一条通道：只记一个很短的退避（默认 30 秒），期间该源排到
 * 队尾（避免立刻再撞一次），**不进任何失败账本、不参与成功率分母、不触发熔断**。
 * 30 秒后自动恢复，不需要任何人工介入。
 *
 * 判定只看错误文案里的明确特征词。宁少不多：误把普通失败当成限流会让真正的
 * 坏源得不到降权，代价比多等 30 秒大得多。
 */

/** 限流后的短退避（毫秒）。比回源超时冷却（90s）短得多——限流恢复得很快 */
export const RATE_LIMIT_BACKOFF_MS = 30 * 1000

/**
 * 限流特征。
 *
 * 刻意不收单独的「频繁」二字：日志里「切换频繁」「请求频繁」都可能出现，
 * 单字词会把正常失败误判成限流。
 */
const RATE_LIMIT_PATTERN = new RegExp([
    '\\b429\\b',
    'too many requests',
    'rate[\\s_-]?limit',
    'throttl',
    '限流',
    '请求过于频繁',
    '访问过于频繁',
    '操作过于频繁',
    '请求频率',
    '频率限制',
    '接口调用超限',
    '调用超限',
].join('|'), 'i')

/** 失败文案是否属于平台限流 */
export const isRateLimitFailure = (message: unknown): boolean => {
    if (typeof message !== 'string' || !message) return false
    return RATE_LIMIT_PATTERN.test(message)
}

const backoff = new Map<string, number>()
const keyOf = (owner: string, id: string, platform: string): string =>
    `${owner || ''}:${id || ''}:${platform || ''}`

/** 记一次限流：该源在该平台进入 30 秒短退避 */
export const noteRateLimit = (owner: string, id: string, platform: string, now: number = Date.now()): void => {
    backoff.set(keyOf(owner, id, platform), now + RATE_LIMIT_BACKOFF_MS)
    if (backoff.size > 2000) {
        for (const [k, until] of backoff) if (until <= now) backoff.delete(k)
    }
}

export const isRateLimited = (owner: string, id: string, platform: string, now: number = Date.now()): boolean => {
    const until = backoff.get(keyOf(owner, id, platform)) || 0
    return until > now
}

export const clearRateLimit = (owner: string, id: string, platform: string): void => {
    backoff.delete(keyOf(owner, id, platform))
}

/** 诊断快照 */
export const rateLimitSnapshot = (now: number = Date.now()): Array<{ key: string; until: string }> => {
    const out: Array<{ key: string; until: string }> = []
    for (const [key, until] of backoff) {
        if (until > now) out.push({ key, until: new Date(until).toISOString() })
    }
    return out
}

export const resetRateLimit = (): void => backoff.clear()
