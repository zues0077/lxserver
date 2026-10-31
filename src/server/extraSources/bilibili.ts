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

// ---- UP 主投稿 / 合集 / 系列（B站「歌手 / 专辑」维度的真实数据源） ----
//
// 背景（2026-10-31 实测，用户反馈「B站搜歌手点开没有列表」）：
// 早先的实现是「拿 UP 主名当关键词搜视频、再按 mid 过滤」，名字越通用越惨 ——
// 「全球热门音乐推荐」（258 个投稿）、「热门音乐秀」（196 个）前 3 页一条都匹配不上，
// 用户点开歌手就是空列表。而且「专辑」tab 直接返回空列表，永远没有内容。
//
// 现在按可靠度排三层取数，任何一层拿到东西就不会是空列表：
//   1) 官方投稿接口 x/space/arc/search —— 最准（真实分页 + 总数），但风控极严：
//      匿名请求 412、连刷几次就 -799「请求过于频繁」（同一个出口 IP 会长时间被限）。
//      所以：必须带账号 Cookie、加熔断（连续失败冷却 30 分钟）和 10 分钟缓存，失败静默降级。
//   2) 名搜兜底：搜 3 页（150 条）按 mid 过滤，即原来的做法。
//   3) 合集兜底：UP 主的「合集(season) / 系列(series)」里的稿件并进来 —— 这两条接口实测
//      匿名稳定 200，是最保底的内容来源，也正好是「专辑」维度的数据源。
//
// 专辑维度：B站没有专辑实体，但 UP 主确实有「合集/系列」，那就是他的一张专辑，
// 直接把合集/系列当专辑返回（id 编成 bili-season|<mid>|<id> / bili-series|<mid>|<id>）。

const SPACE_ARC_API = 'https://api.bilibili.com/x/space/arc/search'
const SEASONS_API = 'https://api.bilibili.com/x/polymer/web-space/seasons_series_list'
const SEASON_ARCHIVES_API = 'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list'
const SERIES_ARCHIVES_API = 'https://api.bilibili.com/x/series/archives'
const SEASON_ID_PREFIX = 'bili-season|'
const SERIES_ID_PREFIX = 'bili-series|'

/** 投稿接口熔断：连续失败就冷却，避免每次点歌手白等一次 412/-799 */
let arcFailStreak = 0
let arcBlockedUntil = 0
const ARC_COOLDOWN_MS = 30 * 60 * 1000

const videoCache = new Map<string, { at: number; list: any[]; total: number }>()
const VIDEO_TTL = 10 * 60 * 1000

/** 合集/系列列表缓存（按 mid） */
const collectionCache = new Map<string, { at: number; seasons: any[]; series: any[] }>()
const COLLECTION_TTL = 10 * 60 * 1000

export function parseBiliVideoId(id: string): { kind: 'season' | 'series'; mid: string; cid: string } | null {
  const text = String(id || '')
  for (const [prefix, kind] of [[SEASON_ID_PREFIX, 'season'], [SERIES_ID_PREFIX, 'series']] as const) {
    if (!text.startsWith(prefix)) continue
    const rest = text.slice(prefix.length)
    const idx = rest.indexOf('|')
    if (idx <= 0) return null
    const mid = rest.slice(0, idx)
    const cid = rest.slice(idx + 1)
    if (!/^\d+$/.test(mid) || !/^\d+$/.test(cid)) return null
    return { kind, mid, cid }
  }
  return null
}

/** 统一的「稿件 → 歌曲」结构，字段与 searchSongs 的返回保持一致 */
function toBiliSong(o: {
  bvid?: string
  title?: string
  author?: string
  pic?: string
  duration?: number | string
}): any | null {
  const bvid = String(o.bvid || '').trim()
  if (!bvid) return null
  // 两个接口的时长格式不一样：投稿列表给 "MM:SS"/"H:MM:SS" 字符串，合集给秒数
  let sec = 0
  const raw = o.duration
  if (typeof raw === 'string' && raw.includes(':')) {
    sec = raw.split(':').map(Number).reduce((acc, n) => acc * 60 + (Number.isFinite(n) ? n : 0), 0)
  } else {
    sec = Number(raw) || 0
  }
  return {
    source: 'bili',
    id: bvid,
    songmid: bvid,
    name: decodeEntities(String(o.title || '')) || bvid,
    singer: decodeEntities(String(o.author || '')),
    albumName: '',
    albumId: '',
    interval: secToInterval(sec),
    img: normalizeCover(String(o.pic || '')),
    types: [{ type: '128k' }, { type: '320k' }, { type: 'flac' }, { type: 'flac24bit' }],
    _types: {},
    typeUrl: {},
    meta: { bvid },
  }
}

/** 官方 UP 主投稿接口（一页）。失败时抛错，由调用方决定降级 */
async function spaceArcPage(
  mid: string,
  pn: number,
  ps: number,
  order: 'click' | 'pubdate',
): Promise<{ list: any[]; total: number }> {
  if (Date.now() < arcBlockedUntil) throw new Error('B站投稿接口冷却中')
  const account = store.getCookie('bili') || ''
  const resp = await request<any>(
    `${SPACE_ARC_API}?mid=${encodeURIComponent(mid)}&pn=${pn}&ps=${ps}&order=${order}`,
    { headers: await headersWithCookie(account), timeout: 12000 },
  )
  const body: any = resp.body || {}
  if (resp.statusCode === 412) {
    arcFailStreak += 1
    if (arcFailStreak >= 2) arcBlockedUntil = Date.now() + ARC_COOLDOWN_MS
    throw new Error('B站投稿接口被风控（HTTP 412）')
  }
  const code = Number(body.code)
  if (code !== 0) {
    // -799 请求过于频繁 / -352 风控：都算接口不可用，直接熔断免得每次点都白等
    if (code === -799 || code === -352 || code === -412) {
      arcFailStreak += 1
      if (arcFailStreak >= 2) arcBlockedUntil = Date.now() + ARC_COOLDOWN_MS
    }
    throw new Error(`B站投稿接口失败（code=${code}，${body.message || '无返回'}）`)
  }
  arcFailStreak = 0
  const vlist: any[] = Array.isArray(body.data?.list?.vlist) ? body.data.list.vlist : []
  const total = Number(body.data?.page?.count) || 0
  const list = vlist
    .map(item => toBiliSong({
      bvid: item?.bvid,
      title: item?.title,
      author: item?.author,
      pic: item?.pic,
      duration: item?.length,
    }))
    .filter(Boolean) as any[]
  return { list, total }
}

/** UP 主的合集(season) + 系列(series)。匿名可用的稳定接口 */
async function listCollections(mid: string): Promise<{ seasons: any[]; series: any[] }> {
  const cached = collectionCache.get(mid)
  if (cached && Date.now() - cached.at < COLLECTION_TTL) return { seasons: cached.seasons, series: cached.series }
  const resp = await request<any>(
    `${SEASONS_API}?mid=${encodeURIComponent(mid)}&page_num=1&page_size=10`,
    { headers: await headersWithCookie(''), timeout: 12000 },
  )
  const body: any = resp.body || {}
  if (Number(body.code) !== 0) {
    const empty = { seasons: [] as any[], series: [] as any[] }
    collectionCache.set(mid, { at: Date.now(), ...empty })
    return empty
  }
  const lists: any = body.data?.items_lists || {}
  const seasons: any[] = Array.isArray(lists.seasons_list) ? lists.seasons_list : []
  const series: any[] = Array.isArray(lists.series_list) ? lists.series_list : []
  collectionCache.set(mid, { at: Date.now(), seasons, series })
  return { seasons, series }
}

/** 合集 / 系列 里的稿件（一页） */
async function listCollectionArchives(
  kind: 'season' | 'series',
  mid: string,
  cid: string,
  pageNum = 1,
  pageSize = 50,
): Promise<{ list: any[]; total: number }> {
  const url = kind === 'season'
    ? `${SEASON_ARCHIVES_API}?mid=${encodeURIComponent(mid)}&season_id=${encodeURIComponent(cid)}&page_num=${pageNum}&page_size=${pageSize}`
    : `${SERIES_ARCHIVES_API}?mid=${encodeURIComponent(mid)}&series_id=${encodeURIComponent(cid)}&only_normal=true&sort=desc&pn=${pageNum}&ps=${pageSize}`
  const resp = await request<any>(url, { headers: await headersWithCookie(''), timeout: 12000 })
  const body: any = resp.body || {}
  if (Number(body.code) !== 0) return { list: [], total: 0 }
  const archives: any[] = Array.isArray(body.data?.archives) ? body.data.archives : []
  const total = Number(body.data?.page?.total) || archives.length
  const list = archives
    .map(item => toBiliSong({
      bvid: item?.bvid,
      title: item?.title,
      pic: item?.pic,
      duration: item?.duration,
    }))
    .filter(Boolean) as any[]
  return { list, total }
}

/** 把合集/系列里的稿件摊平成歌单（用于「点开歌手但没有投稿列表」的兜底） */
async function collectFromCollections(mid: string): Promise<any[]> {
  let cols: { seasons: any[]; series: any[] }
  try {
    cols = await listCollections(mid)
  } catch {
    return []
  }
  const out: any[] = []
  const tasks: Array<Promise<{ list: any[]; total: number }>> = []
  for (const s of cols.seasons.slice(0, 3)) {
    const sid = String(s?.meta?.season_id || '')
    if (sid) tasks.push(listCollectionArchives('season', mid, sid, 1, 50))
  }
  for (const s of cols.series.slice(0, 3)) {
    const sid = String(s?.meta?.series_id || '')
    if (sid) tasks.push(listCollectionArchives('series', mid, sid, 1, 50))
  }
  const results = await Promise.all(tasks.map(t => t.catch(() => ({ list: [], total: 0 }))))
  const seen = new Set<string>()
  for (const r of results) {
    for (const item of r.list) {
      const key = String(item.id)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}


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
 * 三层取数（见上方注释）：官方投稿 → 名搜过滤 → 合集兜底。
 * 只返回一页：服务端 artistSongs 会按页循环拉；这里第一页给满 100 条，
 * 后续页返回空让循环立刻收敛（否则一个接口要打十几次上游，必被风控）。
 */
export async function getUserVideos(mid: string, uname: string, page = 1, pageSize = 100): Promise<{
  source: string
  list: any[]
  total: number
}> {
  const id = String(mid || '').trim()
  const name = String(uname || '').trim()
  if (!/^\d+$/.test(id)) return { source: 'bili', list: [], total: 0 }
  if (Math.max(1, page) > 1) return { source: 'bili', list: [], total: 0 }

  const cached = videoCache.get(id)
  if (cached && Date.now() - cached.at < VIDEO_TTL) {
    return { source: 'bili', list: cached.list, total: cached.total }
  }

  const collected: any[] = []
  const seen = new Set<string>()
  const push = (items: any[]): void => {
    for (const item of items) {
      const key = String(item?.id || '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      collected.push(item)
    }
  }

  let total = 0
  // 1) 官方投稿接口（最准）。风控失败就静默降级，不打扰用户
  try {
    for (const pn of [1, 2]) {
      const r = await spaceArcPage(id, pn, 50, 'pubdate')
      total = r.total || total
      push(r.list)
      if (r.list.length < 50) break
    }
  } catch {
    /* 落第 2 层 */
  }

  // 2) 名搜兜底：名字越通用命中越差，所以多扫几页
  if (collected.length === 0 && name) {
    for (let p = 1; p <= 3; p++) {
      let data: { list: any[] }
      try {
        data = await searchSongs(name, p, 50)
      } catch {
        break
      }
      for (const item of data.list) {
        const itemMid = String(item?.meta?.mid || '')
        const sameAuthor = itemMid ? itemMid === id : String(item.singer || '').trim() === name
        if (sameAuthor) push([item])
      }
      if (data.list.length < 50) break
    }
  }

  // 3) 合集兜底：名搜只捞到零星几条（通用名 UP 主常见）或一条没有时，
  //    把合集/系列里的稿件并进来 —— 保证「点开歌手」看到的是他那批歌，而不是三五条
  if (collected.length < 20) {
    push(await collectFromCollections(id))
  }

  const list = collected.slice(0, Math.max(1, pageSize))
  videoCache.set(id, { at: Date.now(), list, total: total || collected.length })
  return { source: 'bili', list, total: total || collected.length }
}

/**
 * 歌手 → 专辑列表：用 UP 主的「合集(season) / 系列(series)」当专辑。
 * 以前这里恒返回空数组，界面上点「专辑」永远是空白。
 */
export async function getArtistAlbums(mid: string, page = 1, upName = ''): Promise<{
  source: string
  list: any[]
  total: number
}> {
  const id = String(mid || '').trim()
  if (!/^\d+$/.test(id) || Math.max(1, page) > 1) return { source: 'bili', list: [], total: 0 }
  let cols: { seasons: any[]; series: any[] }
  try {
    cols = await listCollections(id)
  } catch {
    return { source: 'bili', list: [], total: 0 }
  }
  const name = upName || (await getUserCard(id).catch(() => null))?.name || ''
  const list: any[] = []
  for (const s of cols.seasons) {
    const meta = s?.meta || {}
    const sid = String(meta.season_id || '')
    if (!sid) continue
    list.push({
      source: 'bili',
      id: `${SEASON_ID_PREFIX}${id}|${sid}`,
      name: decodeEntities(meta.name) || '合集',
      picUrl: normalizeCover(meta.cover),
      singer: name,
      songCount: Number(meta.total) || (Array.isArray(s.archives) ? s.archives.length : 0),
      publishTime: '',
      meta: { mid: id, kind: 'season', collectionId: sid },
    })
  }
  for (const s of cols.series) {
    const meta = s?.meta || {}
    const sid = String(meta.series_id || '')
    if (!sid) continue
    list.push({
      source: 'bili',
      id: `${SERIES_ID_PREFIX}${id}|${sid}`,
      name: decodeEntities(meta.name) || '系列',
      picUrl: normalizeCover(meta.cover),
      singer: name,
      songCount: Number(meta.total) || (Array.isArray(s.archives) ? s.archives.length : 0),
      publishTime: '',
      meta: { mid: id, kind: 'series', collectionId: sid },
    })
  }
  return { source: 'bili', list, total: list.length }
}

/** 虚拟专辑的歌曲列表 / 合集与系列的歌曲列表 */
export async function getAlbumSongs(id: string): Promise<{ source: string, list: any[], total: number }> {
  const parsed = parseBiliVideoId(id)
  if (parsed) {
    const first = await listCollectionArchives(parsed.kind, parsed.mid, parsed.cid, 1, 50)
    let list = first.list
    let total = first.total
    if (list.length >= 50 && total > list.length) {
      const second = await listCollectionArchives(parsed.kind, parsed.mid, parsed.cid, 2, 50)
        .catch(() => ({ list: [] as any[], total: 0 }))
      list = list.concat(second.list)
    }
    return { source: 'bili', list, total }
  }
  const keyword = decodeKeywordId(id)
  if (!keyword) throw new Error('B站没有专辑实体；这里只支持「UP 主合集/系列」或「关键词视频合集」')
  const data = await searchSongs(keyword, 1, 50)
  return { source: 'bili', list: data.list, total: data.list.length }
}

/**
 * 专辑维度：关键词包装成一条「视频合集」。
 * 门槛放到 1 条：B站本来就没有专辑实体，之前要求「至少 3 条视频」才给结果，
 * 导致搜冷门专辑名时「专辑」tab 常常整页空白（用户反馈的「搜专辑点开没有列表」）。
 */
export async function searchAlbums(keyword: string, page = 1, _pageSize = 20): Promise<{
  list: any[]
  total: number
  allPage: number
}> {
  if (Math.max(1, page) > 1) return { list: [], total: 0, allPage: 1 }
  const data = await searchSongs(keyword, 1, 50).catch(() => ({ list: [] as any[], total: 0 }))
  const hits = data.list || []
  if (!hits.length) return { list: [], total: 0, allPage: 1 }
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
