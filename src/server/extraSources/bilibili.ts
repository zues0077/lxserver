/**
 * Bilibili 音频源（LX source id：bili）
 *
 * 为什么单独放在 extraSources 而不是 musicSdk：
 *   musicSdk 会被上游 lx-music 的新版本整体覆盖（见 src/modules/utils/musicSDK1.md），
 *   所以「额外平台」一律走本目录，只在 server.ts 的路由口插入一次分发。
 *
 * 实测结论（2026-10-25，本机直连 api.bilibili.com 全部 200）：
 *   - 搜索不需要 Cookie：/x/web-interface/search/type 匿名可搜。
 *   - 取流用 /x/player/playurl：普通 6 档 fnval=80，大会员 fnval=4048（含 Hi-Res / 杜比）。
 *   - 音频地址实测**不带 Referer 也能拉**（mcdn 节点返回 200，2.7MB），
 *     但仍统一带 Referer + UA，避免换到会校验来源的 CDN 节点时突然 403。
 *   - 音质档位与 LX 的对应（B站按 audio id 区分，不是按码率）：
 *       30251 = Hi-Res FLAC → flac24bit
 *       30250 = 杜比全景声   → flac（LX 没有 dolby 档，用 flac 承载，via 里写明）
 *       30280 = 192k         → 320k（LX 无 192k 档，就近归入 320k，via 里标明真实码率）
 *       30232 = 132k         → 128k
 *       30216 = 64k          → 128k
 *
 * 账号（Cookie）带来的增益：大会员解锁 Hi-Res FLAC / 杜比；非会员只有 192k 及以下。
 */

import { request, extFromUrl } from '../musicAccount/http'
import * as store from '../musicAccount/store'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const BASE_HEADERS = { 'User-Agent': UA, Referer: REFERER }

const SEARCH_API = 'https://api.bilibili.com/x/web-interface/search/type'
const PAGELIST_API = 'https://api.bilibili.com/x/player/pagelist'
const PLAYURL_API = 'https://api.bilibili.com/x/player/playurl'
const NAV_API = 'https://api.bilibili.com/x/web-interface/nav'
const FINGER_API = 'https://api.bilibili.com/x/frontend/finger/spi'

/**
 * 匿名 buvid3 / buvid4。
 *
 * 实测（2026-10-25）：不带它请求搜索接口一律 **HTTP 412 风控页**（HTML），
 * 只带 UA+Referer 也不够 —— 这是 B 站对「无指纹客户端」的硬拦截。
 * 从官方 finger/spi 接口取一对匿名指纹缓存起来即可，无需用户登录。
 */
let anonFingerprint: { at: number; cookie: string } | null = null
const FINGER_TTL = 12 * 60 * 60 * 1000

async function anonymousCookie(): Promise<string> {
  if (anonFingerprint && Date.now() - anonFingerprint.at < FINGER_TTL) return anonFingerprint.cookie
  try {
    const resp = await request<any>(FINGER_API, { headers: BASE_HEADERS, timeout: 10000 })
    const b3 = String(resp.body?.data?.b_3 || '')
    const b4 = String(resp.body?.data?.b_4 || '')
    const cookie = b3 ? `buvid3=${b3}${b4 ? `; buvid4=${b4}` : ''}` : ''
    if (cookie) anonFingerprint = { at: Date.now(), cookie }
    return cookie
  } catch {
    return ''
  }
}

/** 合并「匿名指纹 + 账号 Cookie」，账号同名项优先 */
function mergeCookie(anon: string, account: string): string {
  const map: Record<string, string> = {}
  for (const part of `${anon}; ${account}`.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k && v) map[k] = v
  }
  return Object.keys(map).map(k => `${k}=${map[k]}`).join('; ')
}

async function headersWithCookie(account: string): Promise<Record<string, string>> {
  const anon = await anonymousCookie()
  const cookie = mergeCookie(anon, account)
  return cookie ? { ...BASE_HEADERS, Cookie: cookie } : { ...BASE_HEADERS }
}

/** LX 音质 → 可接受的 B 站音频档位（rank 越大越好） */
const QUALITY_RANK: Record<string, number> = {
  '128k': 2,
  '320k': 3,
  flac: 4,
  flac24bit: 5,
  atmos: 5,
}

interface AudioTier {
  id: number
  rank: number
  /** 回报给 LX 的音质标签 */
  quality: string
  /** 真实档位说明，写进 via 便于排查 */
  label: string
}

const TIERS: AudioTier[] = [
  { id: 30216, rank: 1, quality: '128k', label: '64k' },
  { id: 30232, rank: 2, quality: '128k', label: '132k' },
  { id: 30280, rank: 3, quality: '320k', label: '192k' },
  { id: 30250, rank: 4, quality: 'flac', label: 'dolby' },
  { id: 30251, rank: 5, quality: 'flac24bit', label: 'hires' },
]

/** 大会员状态缓存，避免每首歌都打一次 nav */
let vipCache: { at: number; isVip: boolean; nickname: string } | null = null
const VIP_TTL = 10 * 60 * 1000

function decodeEntities(text: string): string {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function normalizeCover(pic: string): string {
  const raw = String(pic || '').trim()
  if (!raw) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  return raw
}

/** mm:ss → 秒 */
function durationToSec(raw: any): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw)
  const text = String(raw || '').trim()
  const parts = text.split(':').map(n => Number(n))
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

function secToInterval(sec: number): string {
  if (!sec || sec < 0) return '00:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 从 songInfo 里取 bvid / cid（id 形如 `BV1xx|12345` 或纯 bvid） */
function pickIds(songInfo: any): { bvid: string; cid: string } {
  const rawId = String(songInfo?.meta?.bvid && !songInfo?.cid
    ? songInfo?.meta?.bvid
    : songInfo?.id ?? songInfo?.songmid ?? songInfo?.meta?.bvid ?? '')
  const fromMeta = String(songInfo?.meta?.bvid || '')
  const idText = String(songInfo?.id ?? songInfo?.songmid ?? '')
  const source = `${fromMeta || idText}`
  const [bvidPart, cidPart] = source.split('|')
  return {
    bvid: bvidPart.trim() || rawId.trim(),
    cid: String(cidPart || songInfo?.meta?.cid || '').trim(),
  }
}

export function isBilibiliId(id: string): boolean {
  return /^BV[0-9A-Za-z]{8,}$/.test(String(id || '').trim())
}

/** 搜索歌曲（视频）。不需要 Cookie，匿名即可。 */
export async function searchSongs(keyword: string, page = 1, pageSize = 20): Promise<{
  list: any[]
  total: number
  allPage: number
}> {
  const params = new URLSearchParams({
    search_type: 'video',
    keyword,
    page: String(page),
    page_size: String(pageSize),
  })
  const resp = await request<any>(`${SEARCH_API}?${params.toString()}`, {
    headers: await headersWithCookie(''),
    timeout: 15000,
  })
  if (resp.statusCode === 412) {
    throw new Error('B站搜索被风控拦截（HTTP 412）：匿名指纹获取失败或 IP 被限，请稍后重试或配置服务器代理')
  }
  const body: any = resp.body || {}
  if (Number(body.code) !== 0) {
    throw new Error(`B站搜索失败（code=${body.code ?? '-'}，${body.message || '无返回'}）`)
  }
  const rawList: any[] = Array.isArray(body.data?.result) ? body.data.result : []
  const list = rawList
    .filter(item => item && item.bvid)
    .map(item => {
      const bvid = String(item.bvid)
      const sec = durationToSec(item.duration)
      const title = decodeEntities(item.title)
      return {
        source: 'bili',
        // 播放时 cid 再查 pagelist 补，搜索阶段不多打 20 个请求（否则一次搜索要 20 秒）
        id: bvid,
        songmid: bvid,
        name: title || bvid,
        singer: decodeEntities(item.author),
        albumName: '',
        albumId: '',
        interval: secToInterval(sec),
        img: normalizeCover(item.pic),
        types: [
          { type: '128k' },
          { type: '320k' },
          { type: 'flac' },
          { type: 'flac24bit' },
        ],
        _types: {},
        typeUrl: {},
        // mid 留着给「UP 主作品列表」按作者过滤（B站没有歌手实体，UP 主是最接近的语义）
        meta: { bvid, mid: String(item.mid || '') },
      }
    })

  const total = Number(body.data?.numResults || list.length)
  const allPage = Number(body.data?.numPages || Math.max(1, Math.ceil(total / pageSize)))
  return { list, total, allPage }
}

/** 查大会员状态（失败按非会员处理，不影响取链） */
export async function getAccountInfo(cookie: string): Promise<{
  ok: boolean
  isVip?: boolean
  nickname?: string
  message?: string
  verified?: 'online' | 'structural'
}> {
  if (!cookie) return { ok: false, verified: 'online', message: '未配置 Cookie' }
  try {
    const resp = await request<any>(NAV_API, { headers: { ...BASE_HEADERS, Cookie: cookie }, timeout: 12000 })
    const body: any = resp.body || {}
    const data: any = body.data || {}
    if (Number(body.code) === -101 || data.isLogin !== true) {
      return { ok: false, verified: 'online', message: 'B站 Cookie 已失效（接口返回未登录），请重新扫码或重新复制' }
    }
    const isVip = Number(data.vipStatus) === 1 && Number(data.vipType) > 0
    return {
      ok: true,
      isVip,
      nickname: String(data.uname || ''),
      verified: 'online',
      message: isVip ? '已登录，大会员生效（可解锁 Hi-Res / 杜比）' : '已登录，当前不是大会员（最高 192k）',
    }
  } catch (e: any) {
    return { ok: false, verified: 'structural', message: `B站登录态校验失败：${e?.message || e}` }
  }
}

/** 取当前 Cookie 对应的大会员状态（带缓存） */
async function isVipAccount(cookie: string): Promise<boolean> {
  if (!cookie) return false
  if (vipCache && Date.now() - vipCache.at < VIP_TTL) return vipCache.isVip
  const info = await getAccountInfo(cookie)
  if (info.ok) {
    vipCache = { at: Date.now(), isVip: !!info.isVip, nickname: info.nickname || '' }
    return !!info.isVip
  }
  return false
}

/** bvid → 第一个分P的 cid */
async function fetchCid(bvid: string, cookie: string): Promise<string> {
  const resp = await request<any>(`${PAGELIST_API}?bvid=${encodeURIComponent(bvid)}`, {
    headers: await headersWithCookie(cookie),
    timeout: 12000,
  })
  const pages: any[] = resp.body?.data || []
  const cid = pages.length ? String(pages[0].cid || '') : ''
  if (!cid) throw new Error('B站视频没有可用的分P（cid），无法取音频')
  return cid
}

interface DashAudio {
  id?: number
  baseUrl?: string
  base_url?: string
  bandwidth?: number
}

export interface BilibiliStream {
  url: string
  quality: string
  via: string
  ext?: string
}

/**
 * 取音频直链。
 * @param cookie 可为空：匿名也能取（最高 192k）
 */
export async function getAudioUrl(songInfo: any, quality: string, cookie = ''): Promise<BilibiliStream> {
  // 音频（MAID）优先：歌单/排行榜里的音频走 music-service-c/web/url
  const audioId = String(songInfo?.meta?.audioId || '').trim()
  if (audioId) {
    const auid = auidOf(audioId)
    if (auid) {
      try {
        return await fetchAudioStream(auid, quality, cookie)
      } catch (e: any) {
        // ⚠️ 排行榜（copyright-music-publicity/toplist/music_list）的 music_id 不是音频区 sid，
        // 直连 web/url 全报 4511001「音频未找到或已下架」（2026-10-30 实测 5/5）。
        // 官方页面用关联稿件播放，azusa-player 也走 creation_bvid —— 有 bvid 就回落视频取流。
        const fbBvid = String(songInfo?.meta?.bvid || '')
        if (fbBvid && isBilibiliId(fbBvid)) {
          console.warn(`[bili] 音频 sid=${auid} 取流失败（${String(e?.message || e).slice(0, 60)}），回落 bvid=${fbBvid}`)
        } else {
          throw e
        }
      }
    }
  }
  // 否则按视频（bvid→cid→playurl）处理
  const { bvid, cid: rawCid } = pickIds(songInfo)
  if (!isBilibiliId(bvid)) throw new Error(`B站歌曲 id 不合法（${bvid || '空'}），无法取链`)

  const cid = rawCid || await fetchCid(bvid, cookie)
  const vip = await isVipAccount(cookie)

  // fnval=4048 只在大会员时请求 Hi-Res / 杜比，非会员请求了也拿不到，反而多一趟
  const fnval = vip ? 4048 : 80
  const params = new URLSearchParams({
    fnval: String(fnval),
    qn: '127',
    bvid,
    cid,
  })
  const resp = await request<any>(`${PLAYURL_API}?${params.toString()}`, {
    headers: await headersWithCookie(cookie),
    timeout: 15000,
  })
  const body: any = resp.body || {}
  if (Number(body.code) !== 0) {
    throw new Error(`B站取流失败（code=${body.code ?? '-'}，${body.message || '无返回'}）`)
  }

  const dash = body.data?.dash || {}
  const candidates: Array<{ tier: AudioTier; url: string }> = []
  const pushTier = (tierId: number, url: string): void => {
    const tier = TIERS.find(t => t.id === tierId)
    if (tier && url) candidates.push({ tier, url })
  }

  const flac: DashAudio | undefined = dash.flac?.audio
  if (flac?.baseUrl || flac?.base_url) pushTier(30251, String(flac.baseUrl || flac.base_url))
  for (const item of (dash.dolby?.audio || []) as DashAudio[]) {
    if (item?.baseUrl || item?.base_url) pushTier(30250, String(item.baseUrl || item.base_url))
  }
  for (const item of (dash.audio || []) as DashAudio[]) {
    const id = Number(item?.id)
    const url = String(item?.baseUrl || item?.base_url || '')
    if (url) pushTier(id, url)
  }

  if (!candidates.length) {
    // 部分老视频只有 durl（单文件 mp4），没有 dash 音频轨
    const durl: any[] = body.data?.durl || []
    const url = String(durl[0]?.url || '')
    if (!url) throw new Error('B站未返回音频流（可能是互动视频或版权受限）')
    return { url, quality: '128k', via: 'playurl:durl', ext: extFromUrl(url) || 'mp4' }
  }

  const wantRank = QUALITY_RANK[quality] ?? 3
  candidates.sort((a, b) => b.tier.rank - a.tier.rank)
  const exact = candidates.find(c => c.tier.rank <= wantRank)
  // 请求档以下没有可用档（例如非会员要 flac）→ 退回该账号能拿到的最高档
  const chosen = exact || candidates[candidates.length - 1]

  return {
    url: chosen.url,
    quality: chosen.tier.quality,
    via: `playurl:${chosen.tier.id}(${chosen.tier.label})${vip ? '+vip' : ''}`,
    ext: extFromUrl(chosen.url) || 'm4a',
  }
}

/** 当前是否配置了 B站 账号（供上层判断是否需要把 VIP 档列进音质选择） */
export function hasAccount(): boolean {
  return !!store.getCookie('bili')
}

// ---- 歌单 / 排行榜（B站音频区，独立于视频投稿体系） ----
//
// 与视频投稿（bv）是两套接口：
//   - 排行榜：api.bilibili.com/x/copyright-music-publicity/toplist/{all_period,music_list}
//   - 歌单  ：www.bilibili.com/audio/music-service-c/web/{menu/rank,menu/info,song/of-menu}
// 实测均不需要 WBI 签名，匿名即可（带匿名指纹 buvid3）。
// 音频流用 web/url（sid=MA音频id），与视频取流（playurl）是两条独立路径。

const RANK_API = 'https://api.bilibili.com/x/copyright-music-publicity/toplist'
const MENU_API = 'https://www.bilibili.com/audio/music-service-c/web'

const BILI_BOARDS: Array<{ bangid: string; name: string; list_type: number }> = [
  { bangid: 'hot', name: 'B站热歌榜', list_type: 1 },
  { bangid: 'original', name: 'B站原创榜', list_type: 2 },
]

let periodCache: { at: number; ids: Record<number, number> } | null = null
const PERIOD_TTL = 60 * 60 * 1000

/** MA音频id → 纯数字 auid（music-service-c/web/url 用） */
function auidOf(raw: any): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  return s.replace(/^MA/i, '')
}

/** 音频条目 → LX songInfo（meta.audioId 保留给 getAudioUrl 取流用） */
function mapAudioSong(raw: any): any {
  const auidRaw = String(raw?.id ?? raw?.music_id ?? '')
  const auid = auidRaw.replace(/^MA/i, '')
  const maId = raw?.music_id ? String(raw.music_id) : `MA${auid}`
  const cover = normalizeCover(raw?.cover ?? raw?.mv_cover ?? raw?.creation_cover ?? '')
  const title = decodeEntities(raw?.music_title ?? raw?.title ?? '')
  const singer = decodeEntities(raw?.singer ?? raw?.author ?? '')
  const duration = Number(raw?.duration ?? raw?.creation_duration ?? 0)
  return {
    source: 'bili',
    id: `bili_${auid}`,
    songmid: auid,
    name: title || `音频 ${auid}`,
    singer,
    albumName: decodeEntities(raw?.album ?? ''),
    albumId: '',
    interval: secToInterval(duration),
    img: cover,
    types: [
      { type: '128k' },
      { type: '192k' },
    ],
    _types: {},
    typeUrl: {},
    meta: {
      audioId: maId,
      bvid: String(raw?.creation_bvid ?? raw?.bvid ?? ''),
      source: 'bili',
    },
  }
}

function mapMenuCard(m: any): any {
  const cover = normalizeCover(m?.cover)
  return {
    id: String(m?.menuId ?? m?.id ?? ''),
    name: decodeEntities(m?.title ?? ''),
    img: cover,
    picUrl: cover,
    author: decodeEntities(m?.uname ?? ''),
    total: Number(m?.snum ?? 0),
    desc: decodeEntities(m?.intro ?? ''),
    source: 'bili',
  }
}

/** 取某榜单类型当前最新一期的 list_id（按 publish_time 取最大） */
async function latestPeriodId(listType: number): Promise<number> {
  const now = Date.now()
  if (periodCache && now - periodCache.at < PERIOD_TTL && periodCache.ids[listType]) {
    return periodCache.ids[listType]
  }
  const resp = await request<any>(`${RANK_API}/all_period?list_type=${listType}`, {
    headers: await headersWithCookie(''),
    timeout: 12000,
  })
  const body: any = resp.body || {}
  if (Number(body.code) !== 0) throw new Error(`B站榜单列表获取失败（code=${body.code}）`)
  const yearMap: any = body.data?.list || {}
  let maxTime = 0
  let id = 0
  for (const year of Object.keys(yearMap)) {
    for (const period of (yearMap[year] || [])) {
      const t = Number(period?.publish_time || 0)
      if (t > maxTime) { maxTime = t; id = Number(period?.ID || 0) }
    }
  }
  if (!id) throw new Error('B站榜单暂无可用期数')
  if (!periodCache) periodCache = { at: now, ids: {} }
  periodCache.ids[listType] = id
  periodCache.at = now
  return id
}

export async function getLeaderboardBoards(): Promise<{ list: any[] }> {
  return { list: BILI_BOARDS.map(b => ({ bangid: b.bangid, name: b.name })) }
}

export async function getLeaderboardList(bangid: string): Promise<any> {
  const board = BILI_BOARDS.find(b => b.bangid === String(bangid || '').trim())
  if (!board) throw new Error(`未知 B站榜单：${bangid}`)
  const listId = await latestPeriodId(board.list_type)
  const resp = await request<any>(`${RANK_API}/music_list?list_id=${listId}`, {
    headers: await headersWithCookie(''),
    timeout: 15000,
  })
  const body: any = resp.body || {}
  if (Number(body.code) !== 0) throw new Error(`B站榜单内容获取失败（code=${body.code}）`)
  const rawList: any[] = Array.isArray(body.data?.list) ? body.data.list : []
  const list = rawList.map(mapAudioSong)
  return { list, total: list.length, boardName: board.name }
}

export async function getSongListTags(): Promise<any> {
  // B站音频无官方分类目录，用「官方推荐歌单」一个分类承载 menu/rank
  return {
    tags: [{ name: '官方推荐', list: [{ id: 'rank', name: '官方推荐歌单' }] }],
    hotTag: { id: 'rank', name: '官方推荐歌单' },
  }
}

export async function getSongListList(tagId: string, page = 1, pageSize = 20): Promise<any> {
  // 目前只实现官方推荐（menu/rank），tagId 暂忽略
  const resp = await request<any>(`${MENU_API}/menu/rank?pn=${page}&ps=${pageSize}`, {
    headers: await headersWithCookie(''),
    timeout: 15000,
  })
  const body: any = resp.body || {}
  if (Number(body.code) !== 0) throw new Error(`B站歌单列表获取失败（code=${body.code}）`)
  const menus: any[] = Array.isArray(body.data?.data) ? body.data.data : []
  const list = menus.map(mapMenuCard)
  const total = Number(body.data?.totalSize || list.length)
  const allPage = Number(body.data?.pageCount || page)
  return { list, total, allPage }
}

export async function getSongListDetail(id: string): Promise<any> {
  const sid = String(id || '').trim()
  if (!sid) throw new Error('缺少歌单 ID')
  const infoResp = await request<any>(`${MENU_API}/menu/info?sid=${sid}`, {
    headers: await headersWithCookie(''),
    timeout: 12000,
  })
  const infoBody: any = infoResp.body || {}
  if (Number(infoBody.code) !== 0 || !infoBody.data?.menuId) throw new Error('B站歌单不存在或已下架')
  const infoData: any = infoBody.data
  const cover = normalizeCover(infoData.cover)
  const songs: any[] = []
  for (let pn = 1; pn <= 5; pn++) {
    const resp = await request<any>(`${MENU_API}/song/of-menu?sid=${sid}&pn=${pn}&ps=100`, {
      headers: await headersWithCookie(''),
      timeout: 15000,
    })
    const b: any = resp.body || {}
    if (Number(b.code) !== 0) break
    const arr: any[] = Array.isArray(b.data?.data) ? b.data.data : []
    for (const s of arr) songs.push(mapAudioSong(s))
    if (pn >= Number(b.data?.pageCount || 1) || !arr.length) break
  }
  return {
    info: {
      id: String(infoData.menuId),
      name: decodeEntities(infoData.title),
      img: cover,
      picUrl: cover,
      desc: decodeEntities(infoData.intro),
      author: decodeEntities(infoData.uname),
      total: songs.length,
      source: 'bili',
    },
    list: songs,
    total: songs.length,
  }
}

export async function searchPlaylists(keyword: string, page = 1): Promise<any> {
  // B站音频无歌单搜索接口，退回按「官方推荐歌单」标题/简介过滤
  const text = String(keyword || '').trim().toLowerCase()
  const resp = await request<any>(`${MENU_API}/menu/rank?pn=1&ps=50`, {
    headers: await headersWithCookie(''),
    timeout: 15000,
  })
  const body: any = resp.body || {}
  let menus: any[] = Array.isArray(body.data?.data) ? body.data.data : []
  if (text) {
    menus = menus.filter(m => `${m?.title || ''} ${m?.intro || ''}`.toLowerCase().includes(text))
  }
  const pageSize = 20
  const start = (page - 1) * pageSize
  const list = menus.slice(start, start + pageSize).map(mapMenuCard)
  const total = menus.length
  const allPage = Math.max(1, Math.ceil(total / pageSize))
  return { list, total, allPage }
}

/** 音频流（MAID）→ 直链，优先级高于视频（bvid）路径 */
async function fetchAudioStream(auid: string, quality: string, cookie: string): Promise<BilibiliStream> {
  // ⚠️ 2026-10-30 实测（手册 P-0959）：music-service-c/web/url 的 quality 参数（0=128K/1=192K/2=320K/3=FLAC，
  // 见 wood3n/biu 项目的注释）**服务端实际忽略**——0/1/2/3 四档返回同一个文件。
  // B站音频区每首歌只有官方上传的一档流，实测 112s/2.73MB ≈ 195kbps ≈ 192k AAC。
  // 所以请求值只按档位给个建议值，返回时如实标 192k 上限，不虚标 320k/flac。
  const qMap: Record<string, number> = { '128k': 0, '192k': 1, '320k': 2, flac: 3, flac24bit: 3, atmos: 3, master: 3 }
  const qn = qMap[quality] ?? 2
  const params = new URLSearchParams({ sid: auid, privilege: '2', quality: String(qn) })
  const resp = await request<any>(`${MENU_API}/url?${params.toString()}`, {
    headers: await headersWithCookie(cookie),
    timeout: 15000,
  })
  const body: any = resp.body || {}
  if (Number(body.code) !== 0) throw new Error(`B站音频取流失败（code=${body.code} ${body.msg || ''}）`)
  const cdns: string[] = Array.isArray(body.data?.cdns) ? body.data.cdns : []
  if (!cdns.length) throw new Error('B站音频未返回可用 cdns（可能无版权或需登录）')
  const isPreview = Number(body.data?.type) === -1
  // 服务端忽略 quality：B站音频区实际最高 192k，高于此的请求如实降标
  const actualQuality = (QUALITY_RANK[quality] ?? 3) > (QUALITY_RANK['192k'] ?? 3) ? '192k' : quality
  return {
    url: cdns[0],
    quality: actualQuality,
    via: `audio:q${qn}${isPreview ? '(试听)' : ''}`,
    ext: extFromUrl(cdns[0]) || 'm4a',
  }
}

// ---------------------------------------------------------------------------
// 歌手 / 专辑维度
//
// B站没有「歌手」「专辑」实体，这里给两层映射，都在界面上标了来源，不会伪装成别的平台：
//   歌手 → UP 主（search_type=bili_user）。点进去用「UP 主名」搜视频、再按 mid 过滤，
//          拿到的是该 UP 主的投稿，不需要 WBI 签名（space/wbi 那套很容易 412）。
//   专辑 → 「视频合集」：把关键词包装成一条虚拟专辑（id 里带 `kw|` 前缀 + base64 关键词），
//          点进去就是该关键词的视频列表。B站确实没有专辑，这是能给出的最接近的东西。
// ---------------------------------------------------------------------------

const CARD_API = 'https://api.bilibili.com/x/web-interface/card'

/** 虚拟专辑 id：`bili-kw|<base64url(关键词)>` */
const KW_ALBUM_PREFIX = 'bili-kw|'

const encodeKeywordId = (keyword: string): string =>
  KW_ALBUM_PREFIX + Buffer.from(String(keyword || ''), 'utf8').toString('base64url')

/** 解析虚拟专辑 id；不是虚拟专辑就返回空串 */
export const decodeKeywordId = (id: string): string => {
  const text = String(id || '')
  if (!text.startsWith(KW_ALBUM_PREFIX)) return ''
  try {
    return Buffer.from(text.slice(KW_ALBUM_PREFIX.length), 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

export const isKeywordAlbumId = (id: string): boolean => String(id || '').startsWith(KW_ALBUM_PREFIX)

/** 搜 UP 主（= 歌手维度）。返回结构与其它平台的 extendSearch.searchSinger 对齐 */
export async function searchUsers(keyword: string, page = 1, pageSize = 20): Promise<{
  list: any[]
  total: number
  allPage: number
}> {
  const params = new URLSearchParams({
    search_type: 'bili_user',
    keyword,
    page: String(page),
    page_size: String(pageSize),
  })
  const resp = await request<any>(`${SEARCH_API}?${params.toString()}`, {
    headers: await headersWithCookie(''),
    timeout: 15000,
  })
  if (resp.statusCode === 412) {
    throw new Error('B站 UP 主搜索被风控拦截（HTTP 412）：请稍后重试或配置服务器代理')
  }
  const body: any = resp.body || {}
  if (Number(body.code) !== 0) {
    throw new Error(`B站 UP 主搜索失败（code=${body.code ?? '-'}，${body.message || '无返回'}）`)
  }
  const rawList: any[] = Array.isArray(body.data?.result) ? body.data.result : []
  const list = rawList
    .filter(item => item && item.mid)
    .map(item => {
      const mid = String(item.mid)
      const videos = Number(item.videos) || 0
      return {
        source: 'bili',
        // 歌手 id 直接用 mid，artistDetail / artistSongs 都按它查
        id: mid,
        name: decodeEntities(item.uname) || `UP主${mid}`,
        picUrl: normalizeCover(item.upic),
        // 简介放 alias，卡片上显示一行，和别的平台一致
        alias: item.usign ? [decodeEntities(item.usign)] : [],
        musicSize: videos,
        albumSize: 0,
        meta: { mid, fans: Number(item.fans) || 0, isUp: true },
      }
    })

  const total = Number(body.data?.numResults || list.length)
  const allPage = Number(body.data?.numPages || Math.max(1, Math.ceil(total / pageSize)))
  return { list, total, allPage }
}

/** UP 主名片 → 歌手详情。card 接口免签，实测 mid=2 直接 200 */
export async function getUserCard(mid: string): Promise<any> {
  const id = String(mid || '').trim()
  if (!/^\d+$/.test(id)) throw new Error('B站 UP 主 id 不合法')
  const resp = await request<any>(`${CARD_API}?mid=${encodeURIComponent(id)}`, {
    headers: await headersWithCookie(''),
    timeout: 12000,
  })
  const body: any = resp.body || {}
  if (Number(body.code) !== 0) {
    throw new Error(`B站 UP 主信息获取失败（code=${body.code ?? '-'}，${body.message || '无返回'}）`)
  }
  const card: any = body.data?.card || {}
  return {
    source: 'bili',
    id,
    name: decodeEntities(card.name) || id,
    avatar: normalizeCover(card.face),
    picUrl: normalizeCover(card.face),
    desc: decodeEntities(card.sign) || '',
    musicSize: Number(body.data?.archive_count) || 0,
    albumSize: 0,
    // 粉丝数借 alias 透出，卡片上不额外占位
    alias: Number(card.fans) ? [`${Number(card.fans)} 粉丝`] : [],
  }
}

/**
 * UP 主作品列表（= 歌手歌曲维度）。
 *
 * 说明：B站「按 UP 主取投稿」的官方接口要 WBI 签名（w_rid + img_key），服务端没实现，
 * 硬上很容易 412。这里用「UP 主名搜视频 + 按 mid 过滤」，结果同样只包含该 UP 主的投稿。
 * 代价是受搜索分页限制（最多前 3 页），不是全量投稿；对「听这个 UP 主发的歌」足够。
 */
export async function getUserVideos(mid: string, uname: string, page = 1, pageSize = 50): Promise<{
  source: string
  list: any[]
  total: number
}> {
  const id = String(mid || '').trim()
  const name = String(uname || '').trim()
  if (!name) return { source: 'bili', list: [], total: 0 }
  // 服务端 artistSongs 会按页循环拉全量；这里一次把前 3 页搜完、只在第 1 页返回，
  // 后续页返回空让循环尽快收敛（否则每页都重搜一遍，一轮下来十几个请求）。
  if (Math.max(1, page) > 1) return { source: 'bili', list: [], total: 0 }

  const collected: any[] = []
  const seen = new Set<string>()
  for (let p = 1; p <= 3; p++) {
    let data: { list: any[] }
    try {
      data = await searchSongs(name, p, 50)
    } catch {
      break
    }
    for (const item of data.list) {
      const itemMid = String(item?.meta?.mid || '')
      // 只留这个 UP 主自己的投稿；个别条目没有 mid 时退化为「作者名字相同」
      const sameAuthor = itemMid ? itemMid === id : String(item.singer || '').trim() === name
      if (!sameAuthor) continue
      const key = String(item.id)
      if (seen.has(key)) continue
      seen.add(key)
      collected.push(item)
    }
    if (data.list.length < 50) break
  }

  return { source: 'bili', list: collected.slice(0, pageSize), total: collected.length }
}

/**
 * 专辑维度：包装成一条「视频合集」。
 * 只有命中足够多的视频才给这条，避免搜「VIP曲2」这种给出一个空合集。
 */
export async function searchAlbums(keyword: string, page = 1, _pageSize = 20): Promise<{
  list: any[]
  total: number
  allPage: number
}> {
  if (Math.max(1, page) > 1) return { list: [], total: 0, allPage: 1 }
  const data = await searchSongs(keyword, 1, 50).catch(() => ({ list: [] as any[], total: 0 }))
  const hits = data.list || []
  if (hits.length < 3) return { list: [], total: 0, allPage: 1 }
  const first = hits[0]
  return {
    list: [{
      source: 'bili',
      id: encodeKeywordId(keyword),
      name: `${keyword}（B站视频合集）`,
      picUrl: first?.img || '',
      singer: 'B站',
      // 这里放视频数，专辑卡片会显示成「N 首」
      songCount: hits.length,
      publishTime: '',
      meta: { keyword, virtual: true },
    }],
    total: 1,
    allPage: 1,
  }
}

/** 虚拟专辑的歌曲列表 */
export async function getAlbumSongs(id: string): Promise<{ source: string, list: any[], total: number }> {
  const keyword = decodeKeywordId(id)
  if (!keyword) throw new Error('B站没有专辑实体；这里只支持「关键词视频合集」')
  const data = await searchSongs(keyword, 1, 50)
  return { source: 'bili', list: data.list, total: data.list.length }
}
