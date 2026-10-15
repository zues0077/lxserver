/**
 * 投送地址的短时缓存。
 *
 * 用途：自动续播时前端会提前请求下一首的播放地址（/prefetch），
 * 真正切歌（/play）时直接命中缓存，从而把「解析音源 + 校验链接」的耗时
 * 从切歌链路上挪走，减小两首歌之间的空档。
 *
 * 只缓存内存、不落盘：音源直链通常带时效或与登录态绑定，重启即失效。
 */

interface CachedTrack {
  url: string
  at: number
}

/** 缓存有效期：音源直链一般几分钟内有效，取 10 分钟足够覆盖一个歌单的相邻曲目 */
const CACHE_TTL = 10 * 60 * 1000
const MAX_ENTRIES = 64

const cache = new Map<string, CachedTrack>()

/** 用「音源 + 歌曲标识 + 音质」作为 key，避免同曲不同音源互相覆盖 */
export const buildTrackKey = (song: Record<string, any> | null | undefined, quality: string): string => {
  if (!song) return ''
  const source = String(song.source || '')
  const id = String(song.songmid || song.songId || song.id || song.hash || '')
  const name = String(song.name || song.title || '')
  if (!id && !name) return ''
  return `${source}|${id || name}|${quality}`
}

export const getCachedTrackUrl = (key: string): string => {
  if (!key) return ''
  const item = cache.get(key)
  if (!item) return ''
  if (Date.now() - item.at > CACHE_TTL) {
    cache.delete(key)
    return ''
  }
  // 命中即续期，避免长歌单播放到后段时前面的预解析被提前淘汰
  item.at = Date.now()
  return item.url
}

export const setCachedTrackUrl = (key: string, url: string): void => {
  if (!key || !url) return
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    // 超出上限时淘汰最久未使用的一条，防止长时间运行后内存无界增长
    let oldestKey = ''
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [k, v] of cache) {
      if (v.at < oldestAt) {
        oldestAt = v.at
        oldestKey = k
      }
    }
    if (oldestKey) cache.delete(oldestKey)
  }
  cache.set(key, { url, at: Date.now() })
}

export const clearTrackCache = (): void => {
  cache.clear()
}

export const getTrackCacheSize = (): number => cache.size
