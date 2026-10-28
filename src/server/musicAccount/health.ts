/**
 * 平台账号健康度 —— 把「上次校验结果」翻译成一眼能懂的状态。
 *
 * 为什么需要这一层：
 *   Cookie 失效是**静默**的。用户配置当天下发过一次绿色「已登录」，之后就不再点校验了；
 *   等 Cookie 过期，表现是「某些歌突然只能试听」——看起来像音源坏了，实际重导一次 Cookie 就好。
 *   所以要把「时间」也纳入判据，把久未复查的绿灯降级成「待复查」。
 *
 * 本文件刻意做成**纯函数、零内部依赖**：store.ts 要用它派生列表字段，
 * index.ts 要用它做巡检摘要。若它反过来 import store/index 就会形成循环依赖。
 */

/** 账号健康状态 */
export type AccountHealth =
  /** 没配置 Cookie */
  | 'none'
  /** 配了但从来没校验过 */
  | 'unchecked'
  /** 在线校验通过，且在新鲜期内 */
  | 'ok'
  /** 在线校验通过，但已经太久没复查，权益可能已变 */
  | 'stale'
  /** 在线校验明确失败（登录态没了） */
  | 'expired'
  /** 只做了结构校验，或结构校验就没过——属于「配置问题」不是「过期」 */
  | 'structural'

export interface VerifySnapshot {
  at: number
  ok: boolean
  verified?: 'online' | 'structural'
}

/**
 * 在线校验结果超过这个天数就降级成「待复查」。
 * 取 7 天：多数平台的 sessionid 有效期在数天到数周量级，7 天是个既不会频繁误报、
 * 又能在真正过期前给出预警的折中值。
 */
export const STALE_AFTER_DAYS = 7

export interface HealthInfo {
  health: AccountHealth
  /** 中文状态，前端可直接展示 */
  text: string
  /** 距上次校验多少小时（无记录为 null） */
  ageHours: number | null
}

export function classifyHealth(
  configured: boolean,
  last: VerifySnapshot | null | undefined,
  now = Date.now(),
): HealthInfo {
  if (!configured) return { health: 'none', text: '未配置', ageHours: null }
  if (!last || !last.at) return { health: 'unchecked', text: '未校验', ageHours: null }

  const ageHours = Math.max(0, Math.round((now - last.at) / 3600_000))

  if (!last.ok) {
    // 结构校验没过 ≠ Cookie 过期：多半是平台换了字段名或压根没登录。
    // 标成「待确认」而不是「已失效」，避免用红色吓人（口径同前端原来的处理）。
    if (last.verified === 'structural') return { health: 'structural', text: '待确认', ageHours }
    return { health: 'expired', text: '已失效', ageHours }
  }

  if (ageHours >= STALE_AFTER_DAYS * 24) return { health: 'stale', text: '待复查', ageHours }
  return { health: 'ok', text: last.verified === 'structural' ? '结构校验通过' : '正常', ageHours }
}

export interface HealthSummary {
  /** 已配置账号的平台数 */
  configured: number
  healthy: number
  expired: number
  stale: number
  unchecked: number
  structural: number
  /** 失效平台的中文名，便于直接拼提示语 */
  expiredNames: string[]
  /** 一句话总结（无可提示内容时为空串） */
  message: string
}

export function summarize(
  rows: Array<{ name: string; configured: boolean; health: AccountHealth }>,
): HealthSummary {
  const out: HealthSummary = {
    configured: 0,
    healthy: 0,
    expired: 0,
    stale: 0,
    unchecked: 0,
    structural: 0,
    expiredNames: [],
    message: '',
  }
  for (const r of rows) {
    if (!r.configured) continue
    out.configured += 1
    switch (r.health) {
      case 'expired': out.expired += 1; out.expiredNames.push(r.name); break
      case 'stale': out.stale += 1; break
      case 'unchecked': out.unchecked += 1; break
      case 'structural': out.structural += 1; break
      default: out.healthy += 1
    }
  }

  const parts: string[] = []
  if (out.expired) parts.push(`${out.expiredNames.join('、')} 的 Cookie 已失效`)
  if (out.stale) parts.push(`${out.stale} 个账号超过 ${STALE_AFTER_DAYS} 天未复查`)
  if (out.structural) parts.push(`${out.structural} 个账号的 Cookie 字段对不上`)
  out.message = parts.length ? `${parts.join('；')}，高音质会退回试听或匿名通道` : ''
  return out
}
