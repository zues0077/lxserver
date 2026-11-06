/**
 * 歌曲匹配打分（换源候选共用）。
 *
 * 2026-11-06 从 server.ts 抽出为可单测的纯函数，并新增「救援模式」：
 *
 * 现场案例（2026-11-06 20:09 实机，红昭愿 (DJ版) kw 坏条目）：
 *   target 元数据 00:28 本身就是占位残片（r66 的 judgePlaybackDuration 已能识别），
 *   但旧打分把它当正常基准，导致所有完整版都进不了换源候选：
 *     - 「红昭愿（氛围DJ版）153s」死在名字互不含——normalizeSongNameText 不剥括号，
 *       `红昭愿dj版` 与 `红昭愿氛围dj版` 互不包含，-1；
 *     - 「红昭愿 (DJ版) 04:15 完整版」死在时长差 227s > 8s 闸门，-1。
 *   换源候选只剩 1 条同名同时长未知的，最终只能投 29s + 提示。
 *
 * 救援模式（仅当 target 元数据时长落在 (0, 30s) 内——已知坏元数据才启用）：
 *   - 名字 containment 改用剥括号后的 normalizeSongMatchText（DJ 后缀差异不再一票否决）；
 *   - 时长差闸门跳过（基准本身不可信，时长分记 0）。
 *   放进来多出来的候选靠三层兜底把风险按住：名分排序（剥括号后相等才 20 分，仅互含 10 分
 *   垫底）、L1 探测实判音频时长、D2 保底投最长。正常路径（元数据 ≥30s）行为逐字节不变。
 */
import { PLAYBACK_MIN_PLAUSIBLE_SEC } from './audioGuard'

export const normalizeSongMatchText = (value: unknown): string => String(value || '')
  .toLowerCase()
  .replace(/[（(\[].*?[）)\]]/g, '')
  .replace(/[\s\p{P}\p{S}]/gu, '')

export const normalizeSongNameText = (value: unknown): string => String(value || '')
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]/gu, '')

export const splitSingerNames = (value: unknown): string[] => String(value || '')
  .toLowerCase()
  .split(/[、，,&；;|/+]/)
  .map(normalizeSongMatchText)
  .filter(Boolean)

export const isSingerMatch = (candidateSinger: unknown, targetSinger: unknown): boolean => {
  const candidateText = normalizeSongMatchText(candidateSinger)
  const targetText = normalizeSongMatchText(targetSinger)
  if (!targetText) return true
  if (!candidateText) return false
  if (candidateText.includes(targetText) || targetText.includes(candidateText)) return true

  const candidateParts = splitSingerNames(candidateSinger)
  const targetParts = splitSingerNames(targetSinger)
  return candidateParts.some(candidatePart => targetParts.some(targetPart => (
    candidatePart.includes(targetPart) || targetPart.includes(candidatePart)
  )))
}

export const getSongDurationSeconds = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10000 ? Math.round(value / 1000) : Math.round(value)
  }

  const text = String(value || '').trim()
  if (!text) return 0
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const parsed = Number(text)
    return parsed > 10000 ? Math.round(parsed / 1000) : Math.round(parsed)
  }

  const parts = text.split(':').map(Number)
  if (parts.some(part => !Number.isFinite(part))) return 0
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1])
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
  return 0
}

export const getSongMatchScore = (candidate: any, target: any): number => {
  const candidateDuration = getSongDurationSeconds(candidate?.interval)
  const targetDuration = getSongDurationSeconds(target?.interval)
  // 救援模式：target 元数据本身就是占位残片（<30s），时长与括号后缀都不可信
  const rescue = targetDuration > 0 && targetDuration < PLAYBACK_MIN_PLAUSIBLE_SEC

  const candidateName = rescue ? normalizeSongMatchText(candidate?.name) : normalizeSongNameText(candidate?.name)
  const targetName = rescue ? normalizeSongMatchText(target?.name) : normalizeSongNameText(target?.name)
  if (!candidateName || !targetName) return -1
  if (!candidateName.includes(targetName) && !targetName.includes(candidateName)) return -1
  if (!isSingerMatch(candidate?.singer, target?.singer)) return -1

  let durationScore = 0
  if (!rescue && candidateDuration > 0 && targetDuration > 0) {
    const durationDiff = Math.abs(candidateDuration - targetDuration)
    if (durationDiff > 8) return -1
    durationScore = 8 - durationDiff
  }

  const nameScore = candidateName === targetName ? 20 : 10
  const candidateAlbum = normalizeSongMatchText(candidate?.albumName)
  const targetAlbum = normalizeSongMatchText(target?.albumName)
  const albumScore = candidateAlbum && targetAlbum && candidateAlbum === targetAlbum ? 3 : 0
  return nameScore + durationScore + albumScore
}
