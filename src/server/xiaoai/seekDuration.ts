/**
 * seek 的整曲时长三档兜底 + 粘性锁定。
 *
 * 抽成纯函数：这里的值错了会喂出「时长死亡螺旋」——整条拖动链路瘫痪，
 * 必须能被单测按住（2026-11-07 01:28 实测：远端中转投送 totalDurationMs=0，
 * 首次 seek 拿设备上报兜底，此后音箱播切片流、上报跟着变短 261→33→4→0s，
 * 每次拖动按更短的「总时长」切出更碎的尾巴直到无声）。
 */

export interface SeekDurationInput {
  /** 投送时锁定的整首时长（0 = 投送时不知道，如远端中转） */
  lockedTotalMs: number
  /** track.durationMs：会被兜底路径写残的时长，比锁定值弱一档 */
  trackDurationMs: number
  /** 本地整曲文件探测结果（0 = 失败 / 无本地文件，如远端中转） */
  probedMs: number
  /** 音箱上报的曲目时长 */
  deviceDurationMs: number
  /** 音箱是否还播着完整流：本流没 seek 过（seekSec=0）且没有被完整重拉过（replay=false） */
  deviceOnFullStream: boolean
}

export interface SeekDurationResult {
  /** 本次 seek 使用的整首时长 */
  knownMs: number
  /** 该时长是否可信（可信且更大时才允许粘性锁定） */
  trusted: boolean
  /** 回写后的锁定值：只放大不缩小 */
  lockedTotalMs: number
}

export const resolveSeekKnownMs = (input: SeekDurationInput): SeekDurationResult => {
  const locked = Number(input.lockedTotalMs) > 0 ? Number(input.lockedTotalMs) : 0

  // 第一档：投送时锁定的整曲时长（最可信，直接用）
  let knownMs = locked
  let trusted = locked > 0
  // 第二档：track.durationMs（可能被兜底路径写残，但至少曾是整曲值）
  if (knownMs <= 0 && Number(input.trackDurationMs) > 0) {
    knownMs = Number(input.trackDurationMs)
    trusted = true
  }
  // 第三档：现场对本地整曲文件补探一次（探测偶发失败时补回来）
  if (knownMs <= 0 && Number(input.probedMs) > 0) {
    knownMs = Number(input.probedMs)
    trusted = true
  }
  // 第四档：设备上报——只有「音箱还播着完整流」时才是整曲时长。
  // seek 之后音箱播的是切片流，上报跟着变短，那就是死亡螺旋的入口。
  if (knownMs <= 0 && Number(input.deviceDurationMs) > 0) {
    knownMs = Number(input.deviceDurationMs)
    trusted = input.deviceOnFullStream
  }
  // 上界校正：knownMs 掉成「切片剩余」（实测 259s 的歌报 34s）时，用明显更大的
  // 设备上报整曲拉回——能超过已知值 1.5 倍且 >60s 的上报只可能是整曲，可信。
  if (
    Number(input.deviceDurationMs) > 60000
    && knownMs > 0
    && Number(input.deviceDurationMs) > knownMs * 1.5
  ) {
    knownMs = Number(input.deviceDurationMs)
    trusted = true
  }
  // 粘性锁定：可信且比现锁定值大才写回——锁住之后，就算音箱随后播的是切片流、
  // 上报时长越拖越短，seek 也不再退回去信它，死亡螺旋从根上断掉。
  const lockedTotalMs = trusted && knownMs > locked ? knownMs : locked
  return { knownMs, trusted, lockedTotalMs }
}
