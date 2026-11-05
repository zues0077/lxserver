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
  /** 投送前解析到的真实音频时长（毫秒，0 表示没解析出来）；自动续播靠它算切歌时机 */
  durationMs: number
  /** 首次写入时间：命中续期不会改它，靠它做硬上限 */
  createdAt: number
  /** 最近一次命中时间：LRU 淘汰用 */
  at: number
}

/** 缓存有效期：音源直链一般几分钟内有效，取 10 分钟足够覆盖一个歌单的相邻曲目 */
const CACHE_TTL = 10 * 60 * 1000
/**
 * 硬上限：不管被命中多少次，超过这个时间一律作废。
 *
 * 旧逻辑只有「命中即续期」，于是一个解析错的坏地址只要被反复点击就永远不会过期——
 * 用户连点两次都命中同一个坏地址，看到的就是「两次都放不出来」（P-1137）。
 */
const CACHE_HARD_TTL = 30 * 60 * 1000
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

export const getCachedTrack = (key: string): { url: string; durationMs: number } => {
  if (!key) return { url: '', durationMs: 0 }
  const item = cache.get(key)
  if (!item) return { url: '', durationMs: 0 }
  const now = Date.now()
  if (now - item.at > CACHE_TTL || now - item.createdAt > CACHE_HARD_TTL) {
    cache.delete(key)
    return { url: '', durationMs: 0 }
  }
  // 命中即续期，避免长歌单播放到后段时前面的预解析被提前淘汰（但仍受硬上限约束）
  item.at = now
  return { url: item.url, durationMs: item.durationMs || 0 }
}

export const getCachedTrackUrl = (key: string): string => getCachedTrack(key).url

export const setCachedTrackUrl = (key: string, url: string, durationMs = 0): void => {
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
  const now = Date.now()
  cache.set(key, { url, durationMs: Number(durationMs) || 0, createdAt: now, at: now })
}

/**
 * 删除单曲缓存（坏地址止损）。
 *
 * 解析出错、转码 0B、地址探测不通时必须调用它：否则下一次投送还会命中同一个坏地址，
 * 用户反复点也永远放不出来。
 */
export const deleteCachedTrack = (key: string): boolean => {
  if (!key) return false
  return cache.delete(key)
}

/** 按「歌曲 + 音质」删除缓存，调用方不必自己拼 key */
export const deleteCachedTrackBySong = (song: Record<string, any> | null | undefined, quality: string): boolean =>
  deleteCachedTrack(buildTrackKey(song, quality))

export const clearTrackCache = (): void => {
  cache.clear()
}

export const getTrackCacheSize = (): number => cache.size
