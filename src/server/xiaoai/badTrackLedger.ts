/**
 * 坏曲账本（曲目级负缓存，r73 方案 2）
 *
 * 背景：转码 + 换源都失败的曲目（源侧文件本身损坏，如汽水 AAC 参数集坏的 m4a），
 * 按设计走「原格式投送」兜底，但原格式文件会留在 fileCache 标准路径——
 * 同曲下次投送又命中缓存 → 再转码失败 → 删缓存换源重取 → 再失败 → 再原格式投送。
 * 每次投送都重复付「下载 ×2 + 转码尝试 ×4」的成本（实测 ~20s+），坏源被反复撞。
 *
 * 本账本在「转码与换源都失败」时记下 (platform:songId:quality) + 原格式文件路径，
 * TTL 15 分钟内同曲投送直接复用该文件直投（行为与原格式投送完全一致，只是不再重复劳动）。
 * 文件被 LRU 清理后条目自动失效，重走全链路重新学习。
 */

import * as fs from 'fs'

export interface BadTrackEntry {
  /** 原格式投送文件的绝对路径 */
  filePath: string
  /** 上次投送的 via（复用时拼接「坏源原格式复用」） */
  via: string
  /** 记账时间戳 */
  at: number
}

const BAD_TRACK_TTL = 15 * 60 * 1000
const ledger = new Map<string, BadTrackEntry>()

/** 账本键：平台 + 曲目唯一标识 + 音质。ID 优先，退化到名字（上游 songInfo 字段不齐时仍可记账） */
export const badTrackKey = (songInfo: any, quality: string): string => {
  const platform = String(songInfo?.source || '').trim().toLowerCase()
  if (!platform) return ''
  const id = String(
    songInfo?.songmid || songInfo?.hash || songInfo?.id || songInfo?.songId || songInfo?.copyrightId || '',
  ).trim()
  const name = String(songInfo?.name || songInfo?.title || '').trim()
  if (!id && !name) return ''
  return `${platform}:${id || `name:${name}`}:${quality}`
}

/** 转码与换源都失败时记账（resolveXiaoAiTrack 末尾失败分支调用） */
export const noteBadTrack = (songInfo: any, quality: string, filePath: string, via: string): void => {
  const key = badTrackKey(songInfo, quality)
  if (!key || !filePath) return
  ledger.set(key, { filePath, via, at: Date.now() })
}

/**
 * 查账：命中且原格式文件仍在盘上 → 返回条目（供直投复用）；
 * 超时或文件已被 LRU 清理 → 清账返回 null（重走全链路重新学习）。
 */
export const peekBadTrack = (songInfo: any, quality: string): BadTrackEntry | null => {
  const key = badTrackKey(songInfo, quality)
  if (!key) return null
  const entry = ledger.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > BAD_TRACK_TTL) {
    ledger.delete(key)
    return null
  }
  let exists = false
  try {
    exists = fs.existsSync(entry.filePath)
  } catch {
    exists = false
  }
  if (!exists) {
    ledger.delete(key)
    return null
  }
  return entry
}

/** 换源重取成功（拿到能转码的新文件）时清账，避免旧条目挡住正常路径 */
export const clearBadTrack = (songInfo: any, quality: string): void => {
  ledger.delete(badTrackKey(songInfo, quality))
}

/** 观测用（单测/运维） */
export const badTrackLedgerSize = (): number => ledger.size
