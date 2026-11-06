/**
 * 额外音源（Bilibili / 汽水音乐）
 *
 * 与 musicAccount 的分工：
 *   - musicAccount 管「账号」：Cookie 加密存储、扫码登录、结构/在线校验、取链优先级；
 *   - 本目录管「这两个平台本身怎么搜、怎么取流」，匿名也能用。
 *   - musicAccount/resolvers/* 只做一层薄封装，把 Cookie 传进来复用这里的实现，
 *     避免同一套接口逻辑写两遍（写两遍必然出现「账号通道能播、匿名通道播不了」这种分裂）。
 *
 * 在取链编排中的角色（2026-11-06 定稿）：
 *   本模块的 getMusicUrl 就是汽水/B站的「服务端通道」（等价于五大平台的 musicAccount
 *   账号通道）：脚本声明了 qs/bili 平台时优先走脚本（与五大平台同一条 callUserApiGetMusicUrl
 *   路径）；脚本不可用/失败时由本模块兜底。优先级跟随「首选自己的账号」开关；
 *   名单（使用权限）只控制带不带 Cookie（音质），不封通道 —— 匿名流本就是公开音源。
 *
 * 之所以不放进 musicSdk：那个目录会被上游 lx-music 整体覆盖（见 musicSDK1.md）。
 */

import * as bilibili from './bilibili'
import * as soda from './soda'
import * as store from '../musicAccount/store'
import { isUserAllowed } from '../musicAccount/permission'
import { isEnabled as accountEnabled } from '../musicAccount'

export type ExtraSourceId = 'bili' | 'soda'

/**
 * 脚本生态里的平台 key 别名归一。
 * 社区脚本声明汽水/B站平台时 key 写法不一（qs / qishui / soda…），服务端统一 id 是
 * soda / bili —— 巡检目标、探测曲搜索、脚本候选匹配都按脚本声明的原始 key 走，
 * 只有落回本模块时才归一，避免任何一层写死单一写法。
 */
const SOURCE_ALIASES: Record<string, ExtraSourceId> = {
  soda: 'soda', qs: 'soda', qishui: 'soda', qsmusic: 'soda',
  bili: 'bili', bilibili: 'bili', bilivideo: 'bili',
}

export function normalizeExtraSourceId(source: string): ExtraSourceId | null {
  return SOURCE_ALIASES[String(source || '').trim().toLowerCase()] || null
}

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
  const fn = COMMENTS[String(source || '')]
  if (!fn) return null
  return fn(songInfo, page, limit, hot)
}

const DISPLAY_NAME: Record<string, string> = {
  bili: 'Bilibili',
  soda: '汽水音乐',
}

/** 该 source 是否由本模块接管（接受脚本生态的别名写法：qs / qishui / bilibili…） */
export function isExtraSource(source: string): boolean {
  return normalizeExtraSourceId(source) !== null
}

export function displayName(source: string): string {
  return DISPLAY_NAME[normalizeExtraSourceId(source) || source] || source
}

export async function searchSongs(source: string, keyword: string, page = 1, pageSize = 20) {
  const id = normalizeExtraSourceId(source)
  const searcher = id ? SEARCHERS[id] : undefined
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
  if (source === 'soda') return soda.searchSingers(keyword, page, pageSize)
  if (source === 'bili') return bilibili.searchUsers(keyword, page, pageSize)
  return unsupported(source, '歌手搜索')
}

export async function searchAlbums(source: string, keyword: string, page = 1, pageSize = 20) {
  if (source === 'soda') return soda.searchAlbums(keyword, page, pageSize)
  if (source === 'bili') return bilibili.searchAlbums(keyword, page, pageSize)
  return unsupported(source, '专辑搜索')
}

export async function getArtistDetail(source: string, artistId: string) {
  if (source === 'soda') return soda.getArtistDetail(artistId)
  if (source === 'bili') return bilibili.getUserCard(artistId)
  return unsupported(source, '歌手详情')
}

/**
 * 歌手歌曲列表。B站这里多一个 `name`：它没有艺人 id 索引，
 * 必须靠「UP 主名」当关键词去搜视频，再按 mid 过滤。
 */
export async function getArtistSongs(source: string, artistId: string, page = 1, pageSize = 50, name = '') {
  if (source === 'soda') return soda.getArtistSongs(artistId, page, pageSize)
  if (source === 'bili') return bilibili.getUserVideos(artistId, name, page, pageSize)
  return unsupported(source, '歌手歌曲列表')
}

export async function getArtistAlbums(source: string, artistId: string, page = 1, pageSize = 30, name = '') {
  if (source === 'soda') return soda.getArtistAlbums(artistId, page, pageSize)
  // B站 UP 主没有「专辑」，但有「合集(season)/系列(series)」，当专辑返回
  if (source === 'bili') return bilibili.getArtistAlbums(artistId, page, name)
  return unsupported(source, '歌手专辑列表')
}

export async function getAlbumSongs(source: string, albumId: string) {
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
  if (source === 'soda') return soda.getPlaylistTags()
  if (source === 'bili') return bilibili.getSongListTags()
  throw new Error(`${displayName(source)} 暂不支持歌单分类`)
}

export async function getSongListList(source: string, tagId: string, page = 1) {
  if (source === 'soda') return soda.getPlaylistList(tagId, page)
  if (source === 'bili') return bilibili.getSongListList(tagId, page)
  throw new Error(`${displayName(source)} 暂不支持歌单列表`)
}

export async function getSongListDetail(source: string, id: string) {
  if (source === 'soda') return soda.getPlaylistDetail(id)
  if (source === 'bili') return bilibili.getSongListDetail(id)
  throw new Error(`${displayName(source)} 暂不支持歌单详情`)
}

export async function searchSongList(source: string, text: string, page = 1) {
  if (source === 'soda') return soda.searchPlaylists(text, page)
  if (source === 'bili') return bilibili.searchPlaylists(text, page)
  throw new Error(`${displayName(source)} 暂不支持歌单搜索`)
}

export async function getLeaderboardBoards(source: string) {
  if (source === 'soda') return soda.getBoards()
  if (source === 'bili') return bilibili.getLeaderboardBoards()
  throw new Error(`${displayName(source)} 暂不支持排行榜`)
}

export async function getLeaderboardList(source: string, bangid: string) {
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
  const id = normalizeExtraSourceId(source)
  if (!id) throw new Error(`额外音源不支持：${source}`)
  const resolver = RESOLVERS[id]

  // 使用权限：名单外的用户不带账号 Cookie（B站/汽水匿名流本身就是公开音源，
  // 不该把权限做成「整块封掉」，只收回「用管理员的会员 Cookie 换更高音质」这部分）。
  // 「启用账号取链」总开关关闭时同样退回匿名 —— 开关只管 Cookie，不封公开通道。
  const cookie = (isUserAllowed(username) && accountEnabled()) ? (store.getCookie(id) || '') : ''
  // username 只用于「取链失败时记待补」，让补传能落回播放者自己的缓存目录
  const result = await resolver(songInfo, quality, cookie, username)
  if (!result?.url) throw new Error(`${displayName(id)} 未返回可用链接`)

  return {
    url: result.url,
    type: result.quality || quality,
    sourceName: `${displayName(id)}${cookie ? '（账号）' : '（免登录）'}`,
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
  if (source === 'soda') return soda.diagnoseStream(songInfo, quality, store.getCookie('soda') || '')
  throw new Error(`${displayName(source)} 暂不支持取流诊断`)
}
