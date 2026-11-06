/**
 * 额外音源（Bilibili / 汽水音乐）
 *
 * 与 musicAccount 的分工：
 *   - musicAccount 管「账号」：Cookie 加密存储、扫码登录、结构/在线校验、取链优先级；
 *   - 本目录管「这两个平台本身怎么搜、怎么取流」，匿名也能用。
 *   - musicAccount/resolvers/* 只做一层薄封装，把 Cookie 传进来复用这里的实现，
 *     避免同一套接口逻辑写两遍（写两遍必然出现「账号通道能播、匿名通道播不了」这种分裂）。
 *
 * 之所以不放进 musicSdk：那个目录会被上游 lx-music 整体覆盖（见 musicSDK1.md）。
 */

import * as bilibili from './bilibili'
import * as soda from './soda'
import * as store from '../musicAccount/store'
import { isUserAllowed } from '../musicAccount/permission'
import { isExtraSourceActive } from './state'

export type ExtraSourceId = 'bili' | 'soda'

const SEARCHERS: Record<string, (keyword: string, page: number, pageSize: number) => Promise<{ list: any[]; total: number; allPage: number }>> = {
  bili: bilibili.searchSongs,
  soda: soda.searchSongs,
}

const RESOLVERS: Record<string, (songInfo: any, quality: string, cookie: string, username?: string) => Promise<{ url: string; quality: string; via: string; ext?: string }>> = {
  bili: bilibili.getAudioUrl,
  soda: soda.getAudioUrl,
}

/** 评论：目前只有 B站有可用的公开接口（musicSdk 里没有 bili，所以走这里分发） */
const COMMENTS: Record<string, (songInfo: any, page: number, limit: number, hot: boolean) => Promise<any>> = {
  bili: bilibili.getComments,
}

/**
 * 取「额外音源」的评论。返回 null 表示这个源没有评论实现（交回原有 500 逻辑）。
 */
export async function getComments(
  source: string,
  songInfo: any,
  page = 1,
  limit = 20,
  hot = false,
): Promise<any | null> {
  if (!isExtraSourceActive(String(source || ''))) return null
  const fn = COMMENTS[String(source || '')]
  if (!fn) return null
  return fn(songInfo, page, limit, hot)
}

const DISPLAY_NAME: Record<string, string> = {
  bili: 'Bilibili',
  soda: '汽水音乐',
}

/** 该 source 是否由本模块接管 */
export function isExtraSource(source: string): boolean {
  return Object.prototype.hasOwnProperty.call(SEARCHERS, String(source || ''))
}

export function displayName(source: string): string {
  return DISPLAY_NAME[source] || source
}

export async function searchSongs(source: string, keyword: string, page = 1, pageSize = 20) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  const searcher = SEARCHERS[source]
  if (!searcher) throw new Error(`额外音源不支持：${source}`)
  return searcher(keyword, page, pageSize)
}

// ---- 歌手 / 专辑维度 ----
// 汽水：真艺人/专辑实体。
// B站：没有这两个实体，做了语义映射（见 bilibili.ts 里那段注释）——
//      歌手 = UP 主，专辑 = 关键词视频合集。界面上都带 BILI 来源标，不伪装。

function unsupported(source: string, what: string): never {
  throw new Error(`${displayName(source)} 暂不支持${what}`)
}

export async function searchSingers(source: string, keyword: string, page = 1, pageSize = 20) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.searchSingers(keyword, page, pageSize)
  if (source === 'bili') return bilibili.searchUsers(keyword, page, pageSize)
  return unsupported(source, '歌手搜索')
}

export async function searchAlbums(source: string, keyword: string, page = 1, pageSize = 20) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.searchAlbums(keyword, page, pageSize)
  if (source === 'bili') return bilibili.searchAlbums(keyword, page, pageSize)
  return unsupported(source, '专辑搜索')
}

export async function getArtistDetail(source: string, artistId: string) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.getArtistDetail(artistId)
  if (source === 'bili') return bilibili.getUserCard(artistId)
  return unsupported(source, '歌手详情')
}

/**
 * 歌手歌曲列表。B站这里多一个 `name`：它没有艺人 id 索引，
 * 必须靠「UP 主名」当关键词去搜视频，再按 mid 过滤。
 */
export async function getArtistSongs(source: string, artistId: string, page = 1, pageSize = 50, name = '') {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.getArtistSongs(artistId, page, pageSize)
  if (source === 'bili') return bilibili.getUserVideos(artistId, name, page, pageSize)
  return unsupported(source, '歌手歌曲列表')
}

export async function getArtistAlbums(source: string, artistId: string, page = 1, pageSize = 30, name = '') {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.getArtistAlbums(artistId, page, pageSize)
  // B站 UP 主没有「专辑」，但有「合集(season)/系列(series)」，当专辑返回
  if (source === 'bili') return bilibili.getArtistAlbums(artistId, page, name)
  return unsupported(source, '歌手专辑列表')
}

export async function getAlbumSongs(source: string, albumId: string) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.getAlbumSongs(albumId)
  if (source === 'bili') return bilibili.getAlbumSongs(albumId)
  return unsupported(source, '专辑歌曲列表')
}

// ---- 歌单 / 排行榜 ----
// 汽水（soda）与 B站（bili）都实现了这两个维度：
//   - soda：用关键词搜索歌单 + 歌单详情兜底（官方 charts/discover 已 404）；
//   - bili ：走独立音频区 API（排行榜 all_period/music_list、歌单 menu/info+song/of-menu）。

export function hasSongList(source: string): boolean {
  return source === 'soda' || source === 'bili'
}

export async function getSongListTags(source: string) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.getPlaylistTags()
  if (source === 'bili') return bilibili.getSongListTags()
  throw new Error(`${displayName(source)} 暂不支持歌单分类`)
}

export async function getSongListList(source: string, tagId: string, page = 1) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.getPlaylistList(tagId, page)
  if (source === 'bili') return bilibili.getSongListList(tagId, page)
  throw new Error(`${displayName(source)} 暂不支持歌单列表`)
}

export async function getSongListDetail(source: string, id: string) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.getPlaylistDetail(id)
  if (source === 'bili') return bilibili.getSongListDetail(id)
  throw new Error(`${displayName(source)} 暂不支持歌单详情`)
}

export async function searchSongList(source: string, text: string, page = 1) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.searchPlaylists(text, page)
  if (source === 'bili') return bilibili.searchPlaylists(text, page)
  throw new Error(`${displayName(source)} 暂不支持歌单搜索`)
}

export async function getLeaderboardBoards(source: string) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.getBoards()
  if (source === 'bili') return bilibili.getLeaderboardBoards()
  throw new Error(`${displayName(source)} 暂不支持排行榜`)
}

export async function getLeaderboardList(source: string, bangid: string) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.getBoardSongs(bangid)
  if (source === 'bili') return bilibili.getLeaderboardList(bangid)
  throw new Error(`${displayName(source)} 暂不支持排行榜歌曲`)
}

/**
 * 搜索界面用：串行翻几页拼成一个列表。
 *
 * 为什么不在前端翻页：LX 的歌曲搜索是「一次取全量、前端本地分页」的模型，
 * 只返回 20 条会让用户以为这个平台就只有 20 首歌。这里串行取（不并发，
 * 平台对快速连发会返回重复页），并用时间预算兜住总耗时。
 */
export async function searchAll(source: string, keyword: string, maxPages = 3, budgetMs = 8000) {
  const started = Date.now()
  const seen = new Set<string>()
  const list: any[] = []
  let total = 0
  let allPage = 1
  let fetchedPages = 0

  for (let page = 1; page <= maxPages; page++) {
    if (Date.now() - started > budgetMs) break
    const data = await searchSongs(source, keyword, page, 20)
    fetchedPages = page
    total = Math.max(total, data.total || 0)
    allPage = data.allPage || page
    let fresh = 0
    for (const item of data.list || []) {
      const key = String(item?.id ?? '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      list.push(item)
      fresh++
    }
    if (!fresh || (data.list || []).length === 0) break
    if (page >= allPage) break
  }

  return { list, total: total || list.length, allPage, fetchedPages }
}

/**
 * 取播放链接（自动带上已配置的账号 Cookie）。
 * 返回结构与 /api/music/url 的既有字段对齐：url / type / sourceName。
 */
export async function getMusicUrl(source: string, songInfo: any, quality: string, username?: string): Promise<{
  url: string
  type: string
  sourceName: string
  accountUsed: boolean
  /**
   * 实际命中的取链通道（如 `signer:pc_track_v2:320k` / `h5:320k(...)` / `seo:...`）。
   * 汽水要靠它区分「真的用上了账号签名器」还是「匿名明文通道」——
   * 后者说明账号没起作用（歌本来免费，或账号已过期），需要顺手复核登录态。
   */
  via?: string
  /** 汽水加密曲随取链下发的 AES 解密密钥（32 位十六进制）；非加密曲为空 */
  key?: string
}> {
  const resolver = RESOLVERS[source]
  if (!resolver) throw new Error(`额外音源不支持：${source}`)
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)

  // 使用权限：名单外的用户不带账号 Cookie（B站/汽水匿名流本身就是公开音源，
  // 不该把权限做成「整块封掉」，只收回「用管理员的会员 Cookie 换更高音质」这部分）。
  const cookie = isUserAllowed(username) ? (store.getCookie(source) || '') : ''
  // username 只用于「取链失败时记待补」，让补传能落回播放者自己的缓存目录
  const result = await resolver(songInfo, quality, cookie, username)
  if (!result?.url) throw new Error(`${displayName(source)} 未返回可用链接`)

  return {
    url: result.url,
    type: result.quality || quality,
    sourceName: `${displayName(source)}${cookie ? '（账号）' : '（免登录）'}`,
    accountUsed: !!cookie,
    via: (result as any).via,
    key: (result as any).key,
  }
}

// ---- 汽水待补 / 签名器（L2）：以命名空间形式导出，server.ts 直接用 extraSources.xxx ----
export * as signer from './signer'
export * as sodaProxy from './sodaProxy'
export * as pending from './pending'
export * as prefetch from './prefetch'

/**
 * 额外音源的歌词（目前只有汽水有：`/luna/h5/track_v2` 的 `lyric.content`，逐字 QRC）。
 *
 * 缓存注入 USLT / 播放页歌词都走 musicSdk，而 extraSources 不在 musicSdk 里 ——
 * 不补这个分发，汽水歌曲永远打一行「不支持的音源 "soda"」然后没有歌词。
 * B站视频没有 LRC，返回 null 让上层照旧跳过。
 */
export async function getLyric(source: string, songInfo: any): Promise<{ lyric: string; lxlyric: string } | null> {
  if (!isExtraSourceActive(String(source || ''))) return null
  if (String(source || '') !== 'soda') return null
  let id: any = songInfo?.songmid ?? songInfo?.id ?? songInfo?.meta?.trackId ?? ''
  if (id && typeof id === 'object') id = id.songmid ?? id.id ?? ''
  const trackId = String(id || '').replace(/^soda_/, '').trim()
  if (!trackId) return null
  return soda.getTrackLyric(trackId, store.getCookie('soda') || '')
}

/**
 * 汽水账号体检结论（最近一次「只有试听」的判定）。
 * 纯读，供 `/api/music/accounts` 展示，不做任何请求。
 */
export function sodaEntitlementVerdict() {
  return soda.getSodaEntitlementVerdict()
}

/** 取流诊断：一次说清「拿到的是整曲还是试听、走的哪条通道、还缺什么」 */
export async function diagnoseStream(source: string, songInfo: any, quality: string) {
  if (!isExtraSourceActive(source)) throw new Error(`额外音源已停用：${source}`)
  if (source === 'soda') return soda.diagnoseStream(songInfo, quality, store.getCookie('soda') || '')
  throw new Error(`${displayName(source)} 暂不支持取流诊断`)
}

/** 供 /health 或后台展示用的一行摘要 */
export function describe(): Array<{ id: string; name: string; playback: boolean }> {
  return [
    { id: 'bili', name: 'Bilibili', playback: true },
    { id: 'soda', name: '汽水音乐', playback: true },
  ]
}

const EXTRA_SOURCE_IDS: ExtraSourceId[] = ['bili', 'soda']

/**
 * 供 getProbeTargets() 追加额外音源的巡检目标。
 * 与社区脚本源对等：每个额外音源是一条独立 target，callRequest 把 musicUrl 转发到本模块的
 * getMusicUrl，并返回纯 URL 字符串（与社区脚本的 musicUrl 返回形态一致，probePlatform 用
 * normalizeProbeUrl 校验）。不特殊化 —— 新增/移除平台只改这份枚举，不写死任一。
 */
export function getProbeTargets(): Array<{
  owner: string
  id: string
  name: string
  platforms: string[]
  qualities: Record<string, string[]>
  callRequest: (action: string, source: string, info: any) => Promise<any>
}> {
  return EXTRA_SOURCE_IDS.map((id) => ({
    owner: 'extra',
    id,
    name: displayName(id),
    platforms: [id],
    qualities: {},
    callRequest: async (action: string, source: string, info: any) => {
      if (action === 'musicUrl') {
        const r = await getMusicUrl(source, info?.musicInfo, info?.quality || '320k', info?.username)
        return r?.url
      }
      throw new Error(`额外音源不支持的操作：${action}`)
    },
  }))
}
