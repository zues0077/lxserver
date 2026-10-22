import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as fileCache from '../fileCache'

/**
 * 小爱投播专用的 mp3 转码缓存。
 *
 * 位置：沿用普通歌曲缓存体系 —— `<缓存根>/cache/<用户名>/xiaoai/`
 *  - 哪个用户名登录就落到哪个用户的缓存目录（和普通歌曲缓存同一套目录规则）
 *  - 因此后台「系统配置 → 权限与缓存限制」里的单用户缓存上限对它同样生效
 *  - 单独一个 xiaoai 子目录，不会污染用户的歌单缓存列表，删用户时整目录一起带走
 */

/** mp3 缓存目录（不存在则创建） */
export const mp3CacheDir = (username?: string): string => {
  const dir = path.join(fileCache.getCacheDir(username), 'xiaoai')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录创建失败时交给上层报错 */
  }
  return dir
}

/** 文件名安全的短标识：source_id 清洗后拼 8 位哈希，避免不同歌曲同名互相覆盖 */
export const mp3CacheKey = (songInfo: Record<string, any>, quality = ''): string => {
  const raw = `${fileCache.normalizeSongId(songInfo)}|${quality || ''}`
  const safe = fileCache
    .normalizeSongId(songInfo)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 60) || 'track'
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)
  return `${safe}_${hash}`
}

/** 某首歌对应的 mp3 缓存文件路径（是否已存在由调用方判断） */
export const mp3CachePath = (username: string | undefined, songInfo: Record<string, any>, quality = ''): string =>
  path.join(mp3CacheDir(username), `${mp3CacheKey(songInfo, quality)}.mp3`)

/** 清掉某首歌的 mp3 缓存（转码产物损坏时用） */
export const removeMp3Cache = (filePath: string) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    /* 忽略 */
  }
}
