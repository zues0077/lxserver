/**
 * 拖动进度条时的「残留位置」判定（手册 P-1110）。
 *
 * 背景：切歌的瞬间前端可能还带着上一首的进度（例如上一首播到 131 秒），
 * 若直接拿它去切新歌，会跳到新歌的 131 秒。所以投送后极短窗口内，
 * 「请求位置明显超过实际已播时长」一律当成残留，打回开头。
 *
 * 但用户连续拖动两下时，第二次拖动同样满足「位置 > 已播 + 5 秒、且投送后不足 8 秒」。
 * 早期实现只看时间窗口，于是第二次拖动被误判成残留 → 音箱从 0 秒播，
 * 而前端按请求的位置设了偏移，进度条直接冲到曲尾并卡死（2026-11-05 实测）。
 *
 * 现在：距上一次「用户主动拖动」不足 cooldown 秒时，一律放行。
 */

export interface StaleSeekInput {
  /** 调用方声明了期望歌名（断点续播），此时位置一定是真实断点，不能拦 */
  hasExpectName: boolean
  /** 请求跳转到的秒数 */
  seekSec: number
  /** 距本次投送过了多少秒 */
  sincePushSec: number
  /** 距上一次用户拖动过了多少秒；从未拖过传 Infinity */
  sinceSeekSec: number
  /** 允许的超出量（秒）：已播 3 秒却要跳到 8 秒，还可以是正常的主动快进 */
  slackSec?: number
  /** 残留守卫只在这个投送窗口内生效（秒） */
  windowSec?: number
  /** 用户刚拖过多久之内不再当残留（秒） */
  seekCooldownSec?: number
}

export const DEFAULT_SEEK_STALE_SLACK_SEC = 5
export const DEFAULT_SEEK_STALE_WINDOW_SEC = 8
export const DEFAULT_SEEK_COOLDOWN_SEC = 10

export const isStaleSeekPosition = (input: StaleSeekInput): boolean => {
  const slack = Number.isFinite(Number(input.slackSec)) ? Number(input.slackSec) : DEFAULT_SEEK_STALE_SLACK_SEC
  const windowSec = Number(input.windowSec) > 0 ? Number(input.windowSec) : DEFAULT_SEEK_STALE_WINDOW_SEC
  const cooldown = Number(input.seekCooldownSec) > 0 ? Number(input.seekCooldownSec) : DEFAULT_SEEK_COOLDOWN_SEC
  if (input.hasExpectName) return false
  // 刚拖过：用户是在主动跳转，不是把上一首的位置带过来了
  if (Number(input.sinceSeekSec) <= cooldown) return false
  if (!(Number(input.sincePushSec) < windowSec)) return false
  return Number(input.seekSec) > Number(input.sincePushSec) + slack
}

/**
 * 前端拿到 /seek 响应后该把时间轴偏移设成多少。
 *
 * 服务端可能把目标改小（残留守卫打回开头、贴尾夹取到 duration-3），
 * 前端必须尊重它的结果。原写法 `Number(result.seekSec) || requestedSec`
 * 在服务端明确回 0 时会把 0 当成假值退回请求值，于是播放位置是 0 秒、
 * 页面进度却按 requestedSec 起算 —— 越播越超前，最后卡在曲尾。
 */
export const resolveSeekOffsetSec = (serverSeekSec: unknown, requestedSec: number): number => {
  // null / undefined / 空串都会被 Number() 变成 0，必须单独排除，
  // 否则「字段缺失」会被当成「服务端要求回到 0 秒」
  const missing = serverSeekSec === null || serverSeekSec === undefined || serverSeekSec === ''
  const raw = Number(serverSeekSec)
  if (!missing && Number.isFinite(raw) && raw >= 0) return raw
  const fallback = Number(requestedSec)
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0
}
