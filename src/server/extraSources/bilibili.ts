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
        meta: { bvid },
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
