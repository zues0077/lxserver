/**
 * 1–5 星虚拟评分歌单（P2-4，对标上游「Subsonic 评分歌单与联动补数据 /
 * 1–5 星虚拟评分歌单」）。
 *
 * 本地事实（改动前盘点，勿套上游实现）：
 * - 评分**已经存在**：subsonic-meta.json 的 `meta.ratings`，
 *   key 就是 Subsonic 歌曲 id（= LX.Music.MusicInfo.id，见 musicToSongFlat
 *   的 `const id = music.id` 与 `userRatingsCache.get(username)?.[id]`），
 *   handleSetRating 用 withMetaLock 串行写。本轮不新增存储、不新增打分 UI。
 * - 上游 v2.2.0 把评分服务/快照集中到 src/server/rating/；本仓库**没有歌曲快照**，
 *   所以虚拟歌单只能从本地已有歌曲（收藏/默认列表/自建歌单/收藏专辑）反查，
 *   未落进本地列表的在线歌曲无法回填 —— 这是本地能力边界，注释里如实写明。
 * - `subsonic.hideDisliked` 默认 true，1 星（低分=不喜欢）歌单会被
 *   filterDislikedSongs 剔空，因此评分歌单必须跳过该过滤。
 * - 只读保护对齐本地已有的 `lb_` / `pl_` 分支，update 与 delete 都要拦。
 */

export const RATING_PLAYLIST_PREFIX = 'rating_'

export const parseRatingPlaylistId = (id: string): number | null => {
  const m = /^rating_([1-5])$/.exec(String(id || ''))
  return m ? Number(m[1]) : null
}

export const isRatingPlaylistId = (id: string): boolean => parseRatingPlaylistId(id) !== null

export const ratingPlaylistName = (star: number): string => `评分 ${star} 星`

/**
 * 按星级把本地歌曲分桶。评分 key 直接是歌曲 id，无需再拼
 * `${source}_${songmid}`；重复 id 只保留第一次**通过星级校验**的对象
 * （seen 在星级校验之后才写入，注释与实现保持一致）。
 */
export const groupSongsByRating = <T extends { id: string }>(
  songs: T[],
  ratings: Record<string, number>,
): Map<number, T[]> => {
  const groups = new Map<number, T[]>()
  for (let star = 1; star <= 5; star++) groups.set(star, [])
  const seen = new Set<string>()
  for (const song of songs || []) {
    if (!song || !song.id || seen.has(song.id)) continue
    const star = ratings[song.id]
    if (!Number.isInteger(star) || star < 1 || star > 5) continue
    seen.add(song.id)
    groups.get(star)!.push(song)
  }
  return groups
}
