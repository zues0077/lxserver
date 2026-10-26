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

export type ExtraSourceId = 'bili' | 'soda'

const SEARCHERS: Record<string, (keyword: string, page: number, pageSize: number) => Promise<{ list: any[]; total: number; allPage: number }>> = {
  bili: bilibili.searchSongs,
  soda: soda.searchSongs,
}

const RESOLVERS: Record<string, (songInfo: any, quality: string, cookie: string, username?: string) => Promise<{ url: string; quality: string; via: string; ext?: string }>> = {
  bili: bilibili.getAudioUrl,
  soda: soda.getAudioUrl,
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
  const searcher = SEARCHERS[source]
  if (!searcher) throw new Error(`额外音源不支持：${source}`)
  return searcher(keyword, page, pageSize)
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
}> {
  const resolver = RESOLVERS[source]
  if (!resolver) throw new Error(`额外音源不支持：${source}`)

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
  }
}

// ---- 汽水待补 / 签名器（L2）：以命名空间形式导出，server.ts 直接用 extraSources.xxx ----
export * as signer from './signer'
export * as pending from './pending'
export * as prefetch from './prefetch'

/** 供 /health 或后台展示用的一行摘要 */
export function describe(): Array<{ id: string; name: string; playback: boolean }> {
  return [
    { id: 'bili', name: 'Bilibili', playback: true },
    { id: 'soda', name: '汽水音乐', playback: false },
  ]
}
