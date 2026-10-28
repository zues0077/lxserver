/**
 * 汽水音乐（LX source id：soda）
 *
 * 实测事实（2026-10-25，两次实测，第二次修正了第一次的错误结论）：
 *
 * 1) **搜索可用，且不需要登录。**
 *    Android 端 `api.qishui.com/luna/search/track` 带固定设备指纹即可，
 *    返回 `result_groups[].entity.track`，实测「周杰伦 / 民谣」均能出 20 条。
 *
 * 2) **播放：可播，但分两种曲目（这是第二次实测的关键发现）。**
 *    - 正确端点是 `/luna/h5/track_v2`（device_platform=web），它返回 `track_player.video_model`，
 *      里面 `video_list` 给出 medium(65k) / higher(129k) / highest(257k) 三条 m4a 直链；
 *    - **可免费播的曲目（cover / UGC / 部分授权曲）下发完整时长** —— 实测 20 首里 12 首是全长
 *      （例：搁浅(Cover) 曲长 244.8s、流长 244.758s、highest 7.87MB，直链 206 audio/mp4 可拉）；
 *    - **版权受限曲目只下发 30s / 60s 试听**（布拉格广场 / 兰亭序 / 屋顶 / 因为爱情），
 *      这种要整曲就必须走官方 Windows 客户端的签名（x-helios / x-medusa），NAS 做不到；
 *    - 直链 `*.douyinvod.com` 只带 UA 就能拉，**带 Referer: qishui.com 反而 403**。
 *
 * 3) 所以「账号」对汽水的意义：能拿到登录态（Cookie/扫码都支持），
 *    但**会员无损整曲依然卡在签名**上；免费可播曲匿名就能放。
 *    对外文案必须说清「版权试听」与「未实现签名器」两件事，不要让用户以为是网速问题。
 */

import { request } from '../musicAccount/http'
import * as store from '../musicAccount/store'
import * as pending from './pending'
import * as signer from './signer'
import { registerSodaKey, sodaTrackIdOf } from '../utils/sodaDecrypt'
import { isEncryptedRemoteStream } from '../utils/streamEncryption'
import { extractSodaKey } from './sodaKey'

const SEARCH_UA = 'com.luna.music/100198030 (Linux; U; Android 15; zh_CN_#Hans; ABR-AL80; Build/V417IR;tt-ok/3.12.13.19)'
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

/**
 * 固定设备指纹：上游 go-music-dl 实测可用的一套（换成随机值会被风控软拒）。
 * 只是搜索用，不涉及登录态，所以不需要跟 Cookie 对齐。
 */
const DEVICE_FINGERPRINT: Record<string, string> = {
  device_platform: 'android',
  os: 'android',
  ssmix: 'a',
  cdid: '46556f98-1720-4248-83da-62b74b60b46a',
  channel: 'xiaomi_8478_64',
  aid: '8478',
  app_name: 'luna',
  version_code: '100198030',
  version_name: '19.8.0',
  manifest_version_code: '100198030',
  update_version_code: '100198030',
  resolution: '1080*1920',
  dpi: '480',
  device_type: 'ABR-AL80',
  device_brand: 'HUAWEI',
  language: 'zh',
  os_api: '35',
  os_version: '15',
  ac: 'wifi',
  device_model: 'ABR-AL80',
  save_power: '0',
  font_size: '1.00',
  luna_first_launch_apk_type: 'normal_apk',
  diversion_channel_name: 'xiaomi_8478_64',
  is_car_play: '0',
  battery: '0.99',
  network_speed: '10156',
  hybrid_version_code: '100198030',
  tz_name: 'Asia/Shanghai',
  tz_offset: '28800',
  luna_register_time: '1784311292',
  package: 'com.luna.music',
  charge: '0',
  luna_apk_type: 'normal_apk',
  output_device_type: 'Phone',
  volume: '1.00',
  brightness: '0.08',
  need_personal_recommend: '1',
  is_teen_mode: '0',
  sim_region: 'cn',
  android_device_type: 'default',
  iid: '2204957404569386',
  device_id: '2204957404565290',
}

const IMAGE_BASE = 'https://p3-luna.douyinpic.com/img/'
/** h5 端点：唯一实测能正常下发 video_list 的取流入口（pc 端恒 200+0 字节） */
const H5_TRACK_API = 'https://api.qishui.com/luna/h5/track_v2'
/**
 * SEO / 分享页端点：与 h5 **不同域名**（beta-luna vs api），免签名、明文。
 *
 * 参考实现：`jiuhunwl/music_jx` 的 `qsmusic.php`、`libresoda` 的 `fetch_seo_track_data`。
 * libresoda 的 `fetch_web_track_v2` 就是 track_v2 一挂（HTTP 失败或解析失败）就退到它，
 * 我们照抄这条兜底链：`api.qishui.com` 抽风/被风控时，这里往往还能取到流。
 */
const SEO_TRACK_API = 'https://beta-luna.douyin.com/luna/h5/seo_track'
/** SEO 端点跟 h5 一样只认「朴素」UA；移动端 UA 实测最稳 */
const SEO_UA = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36'
/** 账号信息（带 Cookie 可读，无需签名） */
const ME_API = 'https://api.qishui.com/luna/pc/me'

function pickImage(node: any): string {
  const urls: string[] = Array.isArray(node?.urls) ? node.urls : []
  const uri = String(node?.uri || '')
  if (!urls.length || !uri) return ''
  return `${urls[0]}${uri}`
}

function pickArtists(track: any): string {
  const list: any[] = Array.isArray(track?.artists) ? track.artists : []
  const names = list.map(a => String(a?.name || '').trim()).filter(Boolean)
  return names.join(' / ')
}

function secToInterval(ms: number): string {
  const sec = Math.max(0, Math.round(Number(ms || 0) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function isSodaId(id: string): boolean {
  return /^\d{10,}$/.test(String(id || '').trim())
}

/** 搜索歌曲。匿名可用，不需要 Cookie。 */
export async function searchSongs(keyword: string, page = 1, pageSize = 20): Promise<{
  list: any[]
  total: number
  allPage: number
}> {
  const params = new URLSearchParams({
    ...DEVICE_FINGERPRINT,
    q: keyword,
    cursor: String(Math.max(0, (page - 1) * pageSize)),
    count: String(pageSize),
    _rticket: String(Date.now()),
    aid: '386088',
  })
  const resp = await request<any>(`https://api.qishui.com/luna/search/track?${params.toString()}`, {
    headers: { 'User-Agent': SEARCH_UA, 'content-type': 'application/json; charset=UTF-8' },
    timeout: 15000,
  })
  const body: any = resp.body || {}
  const groups: any[] = Array.isArray(body.result_groups) ? body.result_groups : []
  const list: any[] = []
  let hasMore = false
  for (const group of groups) {
    if (group?.has_more) hasMore = true
    for (const item of (group?.data || [])) {
      const track = item?.entity?.track
      if (!track?.id) continue
      const id = String(track.id)
      list.push({
        source: 'soda',
        id,
        songmid: id,
        name: String(track.name || id).trim(),
        singer: pickArtists(track),
        albumName: String(track.album?.name || ''),
        albumId: String(track.album?.id || ''),
        interval: secToInterval(track.duration),
        img: pickImage(track.album?.url_cover),
        types: [
          { type: '128k' },
          { type: '320k' },
          { type: 'flac' },
          { type: 'flac24bit' },
        ],
        _types: {},
        typeUrl: {},
        meta: { trackId: id },
      })
    }
  }

  // 汽水不给总条数，只给 has_more；用「本页是否满 + has_more」推一个够用的 allPage
  const allPage = hasMore ? page + 1 : page
  return { list, total: list.length + (hasMore ? pageSize : 0), allPage }
}

/**
 * 账号信息：`/luna/pc/me` 带 Cookie 就能读，**不需要签名**（2026-10-25 用真实客户端 Cookie 实测）。
 * 返回 my_info 里有 `id / nickname / is_vip / vip_stage`，所以汽水可以做到「在线校验」，
 * 不用像酷我那样只做结构校验。
 *
 * 注意 `is_vip` 只代表会员身份；即使 is_vip=true，受限曲整曲仍要签名器 —— 这是两回事。
 */
export async function getAccountInfo(cookie: string): Promise<{
  ok: boolean
  isVip?: boolean
  nickname?: string
  message?: string
  verified?: 'online' | 'structural'
}> {
  if (!cookie) return { ok: false, verified: 'online', message: '未配置 Cookie' }
  try {
    const resp = await request<any>(`${ME_API}?aid=386088&device_platform=web`, {
      headers: { 'User-Agent': WEB_UA, Cookie: cookie },
      timeout: 12000,
    })
    const body: any = resp.body || {}
    const info: any = body.my_info || {}
    if (!info.id) {
      return { ok: false, verified: 'online', message: 'Cookie 已失效（/luna/pc/me 没有返回账号信息），请重新登录' }
    }
    const isVip = info.is_vip === true
    const stage = String(info.vip_stage || (isVip ? 'vip' : 'free'))
    return {
      ok: true,
      isVip,
      nickname: String(info.nickname || ''),
      verified: 'online',
      message: isVip
        ? `已登录（${stage}），会员身份有效；受限曲整曲仍需签名器`
        : `已登录（${stage}），非会员：受限曲只有 30/60 秒试听`,
    }
  } catch (e: any) {
    return { ok: false, verified: 'structural', message: `登录态校验失败：${e?.message || e}` }
  }
}

/**
 * 取音频直链（实测可用，2026-10-25 修正）。
 *
 * ⚠️ 上一版结论「汽水纯服务端完全取不到流」是**错的**，错在两点：
 *   1) 只测了 6 首恰好都是版权受限的曲子（原版大牌），它们本来就只有试听；
 *   2) 用错了端点 —— `/luna/pc/track_v2` 恒返回 200 + 0 字节，
 *      而 `/luna/h5/track_v2`（device_platform=web）会正常下发 `track_player.video_model`。
 *
 * 现在的事实（实测 20 首「周杰伦」）：
 *   - 可免费播的曲目（cover / UGC / 部分授权曲）→ 下发**完整时长**，
 *     video_list 里按 medium(65k) / higher(129k) / highest(257k) 给三条 m4a 直链；
 *     例：搁浅(Cover) 曲长 244.8s、流长 244.758s、highest 7.87MB。
 *   - 版权受限曲目（布拉格广场 / 兰亭序 / 屋顶 / 因为爱情）→ video_duration 只有 30s 或 60s。
 *   - 直链（v26-luna.douyinvod.com）实测**只带 UA 就能拉**（206 audio/mp4），
 *     反而带 `Referer: qishui.com` 会 403 —— 所以这里不要加 Referer。
 *
 * 也就是说：汽水**不需要签名器也能播一部分**，签名器只影响「会员无损/受限曲整曲」。
 * 因此本函数把「能否播」如实分级，播不了就说清楚是版权试听，而不是报「不支持」。
 */

/** video_list 的 quality → 档位权重 */
const QUALITY_RANK: Record<string, number> = {
  medium: 1,
  higher: 2,
  highest: 3,
  lossless: 4,
}

/** 签名通道返回的 6 档 → LX 音质标签 + 档位权重（实测：lossless 852kbps / hi_res 324kbps） */
const SIGNED_QUALITY: Record<string, { label: string; rank: number }> = {
  medium: { label: '128k', rank: 2 },
  higher: { label: '320k', rank: 3 },
  highest: { label: '320k', rank: 3 },
  spatial: { label: 'atmos', rank: 4 },
  lossless: { label: 'flac', rank: 5 },
  hi_res: { label: 'flac24bit', rank: 6 },
}

/** 请求音质 → 可接受的档位权重 */
const REQUEST_RANK: Record<string, number> = {
  '128k': 2,
  '320k': 3,
  flac: 5,
  flac24bit: 6,
  atmos: 4,
}

/** 发给 LX 的音质标签（LX 只有 128k/320k/flac/flac24bit 四档） */
const QUALITY_LABEL: Record<string, string> = {
  medium: '128k',
  higher: '320k',
  highest: '320k',
  lossless: 'flac',
}

interface SodaVideoItem {
  main_url?: string
  backup_url?: string
  video_meta?: {
    quality?: string
    vtype?: string
    bitrate?: number
    size?: number
    codec_type?: string
  }
}

/** 一条取流通道取回来的东西：原始响应 + 候选流 + 时长信息 */
export interface PlainFetch {
  tag: string
  parsed: any
  items: SodaVideoItem[]
  /** 实际下发的流时长（秒） */
  streamDuration: number
  /** 元数据里的整曲时长（秒） */
  trackDuration: number
  /** 元数据里平台声明的试听时长（秒） */
  previewDuration: number
  /** 平台若下发了 play_auth.spade_a，这里给出解出的十六进制密钥 */
  key?: string
}

/**
 * PC 客户端 UA 的**回退值**。实测（2026-10-25）3.7.0 这一套是可用的：
 *   UA = LunaPC/3.7.0(30080000)；query 里 app_name=luna_pc、device_platform=windows、
 *   version_code=30080000、version_name=3.7.0。
 * 用 Android 的 com.luna.music UA 或 3.3.0 版本号，即使签名正确上游也只回 0 字节。
 *
 * 注意：真正发请求时优先用签名器上报的版本（见 resolveAppProfile），
 * 这里只是「签名器没上报 / 老版本签名器」时的兜底。
 */
const DEFAULT_APP_VERSION = '3.7.0'
const DEFAULT_BUILD_ID = '30080000'

/**
 * 解析「这次请求该用哪套版本号」。
 * 优先级：签名器上报的显式字段 → 从签名器上报的 UA 里解析 → 代码内置默认值。
 * 这样客户端大版本升级后，只需签名器更新上报值，服务端无需改代码或重建镜像。
 */
function resolveAppProfile(dev: {
  userAgent?: string
  appVersion?: string
  buildId?: string
} | null): { appVersion: string; buildId: string; userAgent: string } {
  let appVersion = String(dev?.appVersion || '').trim()
  let buildId = String(dev?.buildId || '').trim()
  const reportedUa = String(dev?.userAgent || '').trim()
  const m = reportedUa.match(/LunaPC\/([\d.]+)\((\d+)\)/i)
  if (m) {
    if (!appVersion) appVersion = m[1]
    if (!buildId) buildId = m[2]
  }
  if (!/^\d+\.\d+\.\d+$/.test(appVersion)) appVersion = DEFAULT_APP_VERSION
  if (!/^\d+$/.test(buildId)) buildId = DEFAULT_BUILD_ID
  const userAgent = /^LunaPC\//i.test(reportedUa) ? reportedUa : `LunaPC/${appVersion}(${buildId})`
  return { appVersion, buildId, userAgent }
}

/**
 * 走签名器取「受限曲整曲」。
 *
 * 这条路只有签名器在线时才会被调用：签名器（Windows 侧官方客户端）负责生成
 * x-helios / x-medusa，我们只负责把请求发出去并解析。任何一步不满足就返回 null，
 * 由调用方记进待补清单 —— 绝不让签名器故障变成「播放报错还看不出原因」。
 */
async function trySignedStream(trackId: string, cookie: string, quality = '320k'): Promise<{
  url: string
  quality: string
  via: string
  ext?: string
  key?: string
} | null> {
  if (!signer.isConfigured()) return null
  const st = await signer.status()
  if (!st.online) return null

  const dev = await signer.deviceConfig()
  const profile = resolveAppProfile(dev)
  const params = new URLSearchParams({
    track_id: trackId,
    media_type: 'track',
    aid: '386088',
    app_name: 'luna_pc',
    device_platform: 'windows',
    channel: 'official',
    version_code: profile.buildId,
    version_name: profile.appVersion,
  })
  if (dev?.deviceId) {
    params.set('device_id', dev.deviceId)
    params.set('did', dev.deviceId)
  }
  if (dev?.iid) {
    params.set('iid', dev.iid)
    params.set('install_id', dev.iid)
  }
  if (dev?.fp) params.set('fp', dev.fp)

  const url = `https://api.qishui.com/luna/pc/track_v2?${params.toString()}`
  const baseHeaders: Record<string, string> = { 'User-Agent': profile.userAgent }
  if (cookie) baseHeaders.Cookie = cookie

  let signedHeaders: Record<string, string>
  try {
    signedHeaders = await signer.sign({ url, method: 'GET', headers: baseHeaders })
  } catch (e: any) {
    console.log(`[汽水签名] 签名失败：${e?.message || e}`)
    return null
  }

  const resp = await request<any>(url, {
    headers: { ...baseHeaders, ...signedHeaders },
    timeout: 15000,
  })
  const parsed = parseJsonBody(resp)
  if (!parsed) return null

  const model = parseVideoModel(parsed?.track_player?.video_model)
  const usable = videoItems(model)
  if (!usable.length) return null

  // [汽水解密] 版权曲直链是 CENC 加密流，密钥按参考实现应随 play_auth.spade_a 下发。
  // 实测（2026-10-28，246）track_v2 与 media-player 都不下发密钥，详见 sodaKey.ts 头部注释。
  // 这里保留抓取：一旦平台重新下发，下面这套登记 + fileCache 解密分支就直接可用。
  const hexKey = extractSodaKey(parsed)
  if (hexKey) registerSodaKey(trackId, hexKey)

  // 签名 ≠ 有版权：受限曲照样只给 30/60 秒，这里必须拦住，否则播放器会播到一半静音
  if (isPreviewStream({
    tag: 'pc',
    parsed,
    items: usable,
    streamDuration: toNumber(model?.video_duration),
    trackDuration: normalizeDurationSec(parsed?.track?.duration),
    previewDuration: normalizeDurationSec(parsed?.track?.preview?.duration),
  })) return null

  const wantRank = REQUEST_RANK[quality] ?? 3
  // 同权重（higher/highest 都映射到 320k）要按真实码率再排一次，
  // 否则会稳定选中 132k 的 higher，而不是 260k 的 highest —— 这个坑实测踩过。
  const bitrate = (v: SodaVideoItem) => toNumber(v.video_meta?.bitrate)
  const ranked = usable
    .map(v => ({ v, meta: SIGNED_QUALITY[String(v.video_meta?.quality || '')] }))
    .filter(x => x.meta)
    .sort((a, b) => (b.meta!.rank - a.meta!.rank) || (bitrate(b.v) - bitrate(a.v)))
  if (!ranked.length) return null
  const chosen = ranked.find(x => x.meta!.rank <= wantRank) || ranked[ranked.length - 1]

  console.log(`[汽水签名] ✓ 整曲（${chosen.v.video_meta?.quality} / ${Math.round(toNumber(chosen.v.video_meta?.bitrate) / 1000)}k）${hexKey ? ' [已捕获解密密钥]' : ''}`)
  return {
    url: String(chosen.v.main_url || chosen.v.backup_url),
    quality: chosen.meta!.label,
    via: `signer:pc_track_v2:${chosen.v.video_meta?.quality || '?'}`,
    ext: String(chosen.v.video_meta?.vtype || 'm4a'),
    key: hexKey || undefined,
  }
}

function toNumber(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 汽水这几个端点的响应体形态不固定：needle 只在 `content-type: application/json`
 * 时自动解析，而汽水时灵时不灵，于是拿到的可能是对象 / 字符串 / Buffer 三种之一。
 * 三种都得兼容，否则会误判成「上游返回非 JSON」。
 */
export function parseJsonBody(resp: any): any {
  const body: any = resp?.body
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body
  const raw = Buffer.isBuffer(body) ? body.toString('utf-8') : String(body || '')
  if (!raw.trim().startsWith('{')) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** `video_model` 可能是对象、也可能是 JSON 字符串，还有 `"null"` 这种字面量 */
export function parseVideoModel(raw: any): any {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  const text = String(raw).trim()
  if (!text.startsWith('{')) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** 汽水的时长字段毫秒 / 秒混着用，>1000 一律按毫秒折算 */
function normalizeDurationSec(value: any): number {
  const n = toNumber(value)
  if (n <= 0) return 0
  return n > 1000 ? n / 1000 : n
}

/** 从 video_model 里挑出真正能用的候选流 */
export function videoItems(model: any): SodaVideoItem[] {
  const list: SodaVideoItem[] = Array.isArray(model?.video_list) ? model.video_list : []
  return list.filter(v => String(v?.main_url || '').startsWith('http') || String(v?.backup_url || '').startsWith('http'))
}

/**
 * 解析分支②：`url_player_info` 是火山 VOD `GetPlayInfo` 的**已签名地址**，
 * 要再 GET 一次才能拿到 `Result.Data.PlayInfoList[]`（字段名是 PascalCase，
 * 与 `video_list` 的 snake_case 完全不同，所以必须单独映射一次）。
 *
 * 这条分支是原实现的盲区：上游只给 `url_player_info` 的曲目会被误报成
 * 「未返回可用音频流」。
 */
async function fetchPlayerInfo(player: any, cookie: string): Promise<{ items: SodaVideoItem[]; duration: number }> {
  const infoUrl = String(player?.url_player_info || '').trim()
  if (!infoUrl.startsWith('http')) return { items: [], duration: 0 }

  const info = parseJsonBody(await request<any>(infoUrl, {
    headers: { 'User-Agent': SEO_UA, ...(cookie ? { Cookie: cookie } : {}) },
    timeout: 15000,
  }))
  const list: any[] = info?.Result?.Data?.PlayInfoList ?? info?.result?.data?.play_info_list ?? []
  const withDuration = list.find((it: any) => toNumber(it?.Duration) > 0)
  return {
    items: mapPlayerInfoItems(list),
    duration: withDuration ? normalizeDurationSec(withDuration.Duration) : 0,
  }
}

/**
 * 映射火山 VOD 的 `PlayInfoList[]` → 统一的 `SodaVideoItem[]`。
 *
 * 字段是 **PascalCase**（`MainPlayUrl` / `Quality` / `Bitrate` …），
 * 与 `video_list` 的 snake_case 完全对不上，所以只能单独映射一次。
 * 大小写两种写法都认：平台不同版本返回风格不一致，只认一种会随机漏流。
 */
export function mapPlayerInfoItems(list: any[]): SodaVideoItem[] {
  return (Array.isArray(list) ? list : [])
    .map((it: any) => ({
      main_url: String(it?.MainPlayUrl ?? it?.main_play_url ?? ''),
      backup_url: String(it?.BackupPlayUrl ?? it?.backup_play_url ?? ''),
      video_meta: {
        quality: String(it?.Quality ?? it?.quality ?? ''),
        vtype: String(it?.Format ?? it?.format ?? 'm4a'),
        bitrate: toNumber(it?.Bitrate ?? it?.bitrate),
        size: toNumber(it?.Size ?? it?.size),
        codec_type: String(it?.Codec ?? it?.codec ?? ''),
      },
    }))
    .filter(v => String(v.main_url || v.backup_url).startsWith('http'))
}

/**
 * 流是否只是试听片段。
 *
 * 判据两条（口径同 libresoda 的 `sodaDownloadInfoIsPreview`，再加一条平台声明）：
 *   - 平台在 `track.preview.duration` 里**明确给了试听时长** → 流时长与它吻合即试听（最准）；
 *   - 否则退回「流时长明显短于整曲（差 5 秒以上）」。
 */
export function isPreviewStream(fetch: PlainFetch): boolean {
  const { streamDuration, trackDuration, previewDuration } = fetch
  if (streamDuration <= 0) return false
  if (previewDuration > 0 && Math.abs(streamDuration - previewDuration) <= 1.5) return true
  if (trackDuration <= 0) return false
  return streamDuration + 5 < trackDuration
}

/** 请求音质 → 明文通道可接受的最高档位权重（原实现恒为 3，等于无视用户选的音质） */
const PLAIN_REQUEST_RANK: Record<string, number> = {
  '128k': 1,
  '320k': 3,
  atmos: 3,
  flac: 4,
  flac24bit: 4,
}

/** 明文通道：从候选流里挑一条最合适的（按请求音质封顶，再按真实码率排序） */
export function chooseStream(items: SodaVideoItem[], quality: string): SodaVideoItem | null {
  if (!items.length) return null
  const wantRank = PLAIN_REQUEST_RANK[quality] ?? 3
  const rankOf = (v: SodaVideoItem) => QUALITY_RANK[String(v?.video_meta?.quality || '')] || 1
  const sorted = [...items].sort((a, b) => toNumber(b?.video_meta?.bitrate) - toNumber(a?.video_meta?.bitrate))
  return sorted.find(v => rankOf(v) <= wantRank) || sorted[sorted.length - 1]
}

/** 明文通道①：`api.qishui.com/luna/h5/track_v2`（原主路径） */
async function fetchH5Track(trackId: string, cookie: string): Promise<PlainFetch | null> {
  const params = new URLSearchParams({
    track_id: trackId,
    media_type: 'track',
    aid: '386088',
    device_platform: 'web',
    channel: 'pc_web',
  })
  // 注意：不要带 Referer，douyinvod 见到 qishui 域来源会 403；取流接口本身也不挑 Referer
  const parsed = parseJsonBody(await request<any>(`${H5_TRACK_API}?${params.toString()}`, {
    headers: { 'User-Agent': WEB_UA, ...(cookie ? { Cookie: cookie } : {}) },
    timeout: 15000,
  }))
  if (!parsed) return null
  return completePlainFetch(shapePlainFetch('h5', parsed), cookie, trackId)
}

/**
 * 明文通道②：`beta-luna.douyin.com/luna/h5/seo_track`（新增兜底）。
 *
 * 价值在两处，缺一不可：
 *   - **换域名**：`api.qishui.com` 抽风 / 被风控时，这里往往还能取到流；
 *   - **换解析分支**：SEO 端点除了 `video_model`，还会给 `url_player_info`
 *     （火山 VOD 的 GetPlayInfo 已签名地址），而 h5 端点基本只给 `video_model`。
 *
 * 需要签名器才能播的会员曲，这里拿到的同样是试听片段 —— 所以它解决的是
 * 「取不到流」，不是「拿不到无损」。
 */
async function fetchSeoTrack(trackId: string, cookie: string): Promise<PlainFetch | null> {
  const url = `${SEO_TRACK_API}?${new URLSearchParams({ track_id: trackId, device_platform: 'web' }).toString()}`
  const parsed = parseJsonBody(await request<any>(url, {
    headers: {
      'User-Agent': SEO_UA,
      'X-Requested-With': 'XMLHttpRequest',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    timeout: 15000,
  }))
  if (!parsed) return null
  return completePlainFetch(shapePlainFetch('seo', parsed), cookie, trackId)
}

/**
 * 把一条通道的原始响应整理成统一结构（**纯函数，不联网**）。
 *
 * 曲目元数据的挂载点两个端点不一样：h5 在 `track` 下，SEO 在 `seo_track.track` 下，
 * 所以两个都要认 —— 只认一个的话，另一条通道取回来的时长全是 0，
 * 试听判定就直接失效了。
 */
export function shapePlainFetch(tag: string, parsed: any): PlainFetch {
  const player: any = parsed?.track_player || {}
  const track: any = parsed?.track?.id ? parsed.track : (parsed?.seo_track?.track || parsed?.track || {})
  const model = parseVideoModel(player.video_model)
  const hexKey = extractSodaKey(parsed)

  return {
    tag,
    parsed,
    items: videoItems(model),
    streamDuration: normalizeDurationSec(model.video_duration),
    trackDuration: normalizeDurationSec(track?.duration),
    previewDuration: normalizeDurationSec(track?.preview?.duration),
    key: hexKey || undefined,
  }
}

/** 补齐火山 VOD 分支（需要联网）+ 把密钥登记进进程内登记表 */
async function completePlainFetch(fetch: PlainFetch, cookie: string, trackId: string): Promise<PlainFetch> {
  if (!fetch.items.length) {
    const got = await fetchPlayerInfo(fetch.parsed?.track_player, cookie)
    fetch.items = got.items
    if (!fetch.streamDuration) fetch.streamDuration = got.duration
  }
  // [汽水解密] 平台一旦重新下发 play_auth.spade_a，这里就登记，
  // fileCache 的解密分支随即生效（见 sodaKey.ts 头部的实测结论）。
  if (fetch.key) registerSodaKey(trackId, fetch.key)
  return fetch
}

type PlainOutcome =
  | { ok: true; url: string; quality: string; via: string; ext: string; key?: string }
  | { ok: false; reason: 'preview'; seconds: number; full: number }
  | { ok: false; reason: 'no-stream' }

/**
 * 免签名明文取流：h5 优先，SEO 兜底。
 *
 * 两条通道不是「谁更好」的关系，而是**互为备份** —— 域名不同、解析分支互补，
 * 一条挂了另一条大概率还在。所以 h5 取不到流 / 只拿到试听时，
 * **必须再试一次 SEO**，而不是直接抛错（原实现就在这里直接报错了）。
 */
async function resolvePlainStream(trackId: string, cookie: string, quality: string): Promise<PlainOutcome> {
  const fetchers: Array<() => Promise<PlainFetch | null>> = [
    () => fetchH5Track(trackId, cookie),
    () => fetchSeoTrack(trackId, cookie),
  ]
  let preview: { seconds: number; full: number } | null = null

  for (const run of fetchers) {
    const got = await run().catch(() => null)
    if (!got) continue
    const chosen = chooseStream(got.items, quality)
    if (!chosen) continue
    if (isPreviewStream(got)) {
      // 记住第一条通道看到的试听信息：两条都只给试听时，用它给出准确提示
      if (!preview) preview = { seconds: Math.round(got.streamDuration), full: Math.round(got.trackDuration) }
      continue
    }
    const bitrate = toNumber(chosen.video_meta?.bitrate)
    return {
      ok: true,
      url: String(chosen.main_url || chosen.backup_url),
      quality: QUALITY_LABEL[String(chosen.video_meta?.quality || '')] || '320k',
      via: `${got.tag}:${chosen.video_meta?.quality || '?'}(${Math.round(bitrate / 1000)}k)`,
      ext: String(chosen.video_meta?.vtype || 'm4a'),
      key: got.key,
    }
  }

  if (preview) return { ok: false, reason: 'preview', seconds: preview.seconds, full: preview.full }
  return { ok: false, reason: 'no-stream' }
}

/**
 * 取音频直链（对外入口）。
 *
 * 通道优先级：**签名器（App，可达无损）→ h5（明文）→ SEO（明文兜底）**。
 * 前两级任一拿到**非试听**流即返回；都只给试听时，抛出的错误里带上诊断提示，
 * 让用户知道「是签名器没配 / 没开」还是「这曲本来就没整曲权益」。
 *
 * @param cookie 账号 Cookie（可不传）。实测匿名即可拿到可播曲的直链；
 *               带 Cookie 时应能多解锁一部分（会员曲整曲仍需客户端签名）。
 */
export async function getAudioUrl(songInfo: any, quality: string, cookie = '', username = ''): Promise<{
  url: string
  quality: string
  via: string
  ext?: string
  key?: string
}> {
  // 从缓存/本地列表点进来的歌，id 会被规范化成 `soda_<纯数字>`（fileCache 索引口径），
  // 而汽水接口只认纯数字。不剥前缀就会稳定报「id 不合法」，表现为
  // 「本地列表里的汽水歌一点就提示搜索音源」。
  const trackId = sodaTrackIdOf(songInfo)
  if (!isSodaId(trackId)) throw new Error(`汽水歌曲 id 不合法（${trackId || '空'}）`)

  // ① 签名器在线 → App 端点：6 档音质（lossless 852k / hi_res / spatial）。
  //
  // ⚠️ 关键：PC 端点对**版权曲**下发的就是 CENC 加密流，而我们实测平台并不下发
  // `spade_a`（见 sodaKey.ts 头部），也就是拿到手也解不开。以前的做法是「签名通道
  // 成功就直接返回」，结果加密流一路走到 `<audio>` 才炸，表现为「缓存显示成功但没声音」。
  // 现在先探一下：确认加密且无密钥 → **不采纳**，继续走下面的明文通道。
  // 这一条对 UGC / cover 曲尤其有效——它们在明文通道本来就是完整可播的。
  const signed = await trySignedStream(trackId, cookie, quality).catch(() => null)
  if (signed?.key) {
    pending.remove(`soda:${trackId}`)
    return signed
  }
  if (signed) {
    const encrypted = await isEncryptedRemoteStream(signed.url).catch(() => false)
    if (!encrypted) {
      pending.remove(`soda:${trackId}`)
      return signed
    }
    console.log('[汽水取流] 签名通道返回 CENC 加密流且无密钥 → 退回明文通道')
  }

  // ② 免签名明文通道：h5 优先，SEO 兜底
  const plain = await resolvePlainStream(trackId, cookie, quality)
  if (plain.ok) {
    pending.remove(`soda:${trackId}`)
    return {
      url: plain.url,
      quality: plain.quality,
      via: plain.via,
      ext: plain.ext,
      key: plain.key,
    }
  }

  const reason = plain.reason === 'preview' ? 'preview-only' : 'no-stream'
  const msg = plain.reason === 'preview'
    ? `汽水该曲仅有 ${plain.seconds} 秒试听（版权限制，完整 ${plain.full} 秒需官方客户端签名），${await hintForMissing(cookie)}`
    : '汽水未返回可用音频流（该曲可能已下架或仅支持客户端播放）'
  // 记待补：等签名器在线时自动补，不让用户凭记忆重新找歌
  pending.add(songInfo, reason, msg, username)
  throw new Error(msg)
}

export function hasAccount(): boolean {
  return !!store.getCookie('soda')
}

/** 曲目在平台侧是否属「仅会员可播」 */
function trackRequiresVip(track: any): boolean {
  const info: any = track?.label_info || {}
  return info.only_vip_playable === true || info.only_vip_download === true
}

/** 拿不到整曲时，告诉用户「还差什么」—— 签名器缺了就直说缺签名器 */
async function hintForMissing(cookie: string): Promise<string> {
  const hasSigner = signer.isConfigured()
  if (!hasSigner) return '如需整曲请在管理后台「平台账号 → 汽水签名器」填入签名器地址'
  let online = false
  let message = ''
  try {
    const st = await signer.status(true)
    online = !!st?.online
    message = String(st?.message || '')
  } catch (e: any) {
    message = e?.message || String(e)
  }
  if (online) return '签名器在线但仍只有试听，请确认签名器设备指纹与账号权益'
  return `签名器已配置但离线（${message || '无法连接'}），请检查 Windows 侧签名器是否启动`
}

/**
 * 取流诊断（口径借 libresoda 的 `check_stream_access`）。
 *
 * 原实现的失败提示只有一句「未返回可用音频流」，用户和排障的人都看不出
 * 到底是**没配签名器 / 签名器离线 / 账号没权益 / 曲子下架**。这里把一次取流
 * 看到的全部信息摊开：拿到的是整曲还是试听、走的是哪条通道、签名链路缺哪一环。
 */
export interface SodaStreamDiagnosis {
  trackId: string
  /** 元数据里的整曲时长（秒） */
  trackDurationSeconds: number
  /** 实际拿到流的时长（秒） */
  streamDurationSeconds: number
  /** 选中流来自哪条通道：`signer` / `h5` / `seo`；一条都没有时为 '' */
  source: string
  /** LX 音质标签 */
  quality: string
  url: string
  isPreview: boolean
  isLossless: boolean
  requiresVip: boolean
  hasCookie: boolean
  /** 是否配置了签名器地址 */
  hasSigner: boolean
  /** 签名器是否在线 */
  signerOnline: boolean
  /** 签名通道不可用时的具体原因 */
  signerError: string
  /** 两条明文通道各自的探测结果 */
  channels: Array<{ tag: string; ok: boolean; items: number; streamDuration: number; error: string }>
  /** 人话结论，可直接展示给终端用户 */
  hint: string
}

export async function diagnoseStream(songInfo: any, quality = '320k', cookie = ''): Promise<SodaStreamDiagnosis> {
  const trackId = sodaTrackIdOf(songInfo)
  const report: SodaStreamDiagnosis = {
    trackId,
    trackDurationSeconds: 0,
    streamDurationSeconds: 0,
    source: '',
    quality: '',
    url: '',
    isPreview: false,
    isLossless: false,
    requiresVip: false,
    hasCookie: !!cookie,
    hasSigner: false,
    signerOnline: false,
    signerError: '',
    channels: [],
    hint: '',
  }
  if (!isSodaId(trackId)) {
    report.hint = `汽水歌曲 id 不合法（${trackId || '空'}）`
    return report
  }

  // ① 签名链路状态
  report.hasSigner = signer.isConfigured()
  if (!report.hasSigner) {
    report.signerError = '未配置签名器地址（qishui.signerUrl）'
  } else {
    try {
      const st = await signer.status(true)
      report.signerOnline = !!st?.online
      if (!report.signerOnline) report.signerError = String(st?.message || '签名器离线')
    } catch (e: any) {
      report.signerError = `签名器状态查询失败：${e?.message || e}`
    }
  }

  // ② 逐个探明文通道，挑最优（诊断看的是「天花板」，所以不按请求音质封顶）
  const fetchers: Array<{ tag: string; run: () => Promise<PlainFetch | null> }> = [
    { tag: 'h5', run: () => fetchH5Track(trackId, cookie) },
    { tag: 'seo', run: () => fetchSeoTrack(trackId, cookie) },
  ]
  let best: { got: PlainFetch; item: SodaVideoItem } | null = null

  for (const { tag, run } of fetchers) {
    let got: PlainFetch | null = null
    let error = ''
    try {
      got = await run()
    } catch (e: any) {
      error = e?.message || String(e)
    }
    report.channels.push({
      tag,
      ok: !!(got && got.items.length),
      items: got?.items.length ?? 0,
      streamDuration: Math.round(got?.streamDuration ?? 0),
      error: error || (got && got.items.length ? '' : '未解析到候选流'),
    })
    if (!got || !got.items.length) continue
    const item = chooseStream(got.items, 'flac24bit')
    if (!item) continue
    // 整曲优先：只要有一条通道不是试听，就用它
    if (!best || (isPreviewStream(best.got) && !isPreviewStream(got))) best = { got, item }
  }

  // ③ 签名器在线就再探一次 App 端点，确认整曲是否真的拿得到。
  //    但 App 端点对版权曲下发的是 CENC 加密流、且平台不下发密钥（见 sodaKey.ts），
  //    这种「拿到也播不了」。诊断口径必须和 getAudioUrl 一致：判成无效、退回明文通道，
  //    否则 hint 会写「已拿到整曲流（通道 signer）」把用户骗了。
  const signed = report.signerOnline
    ? await trySignedStream(trackId, cookie, quality).catch((e: any) => {
        report.signerError = `App 端点取流失败：${e?.message || e}`
        return null
      })
    : null

  let signedUsable: typeof signed = null
  if (signed?.key) {
    signedUsable = signed
  } else if (signed) {
    const encrypted = await isEncryptedRemoteStream(signed.url).catch(() => false)
    if (!encrypted) signedUsable = signed
    else report.signerError = 'App 端点返回的是 CENC 加密流且无密钥，浏览器无法播放，已退回明文通道'
  }

  if (signedUsable) {
    report.source = 'signer'
    report.quality = signedUsable.quality
    report.url = signedUsable.url
    report.isPreview = false
    report.isLossless = String(signedUsable.quality).startsWith('flac') || signedUsable.ext === 'flac'
    report.trackDurationSeconds = Math.round(best?.got.trackDuration || 0)
    report.streamDurationSeconds = 0
  } else if (best) {
    report.source = best.got.tag
    report.quality = QUALITY_LABEL[String(best.item.video_meta?.quality || '')] || '320k'
    report.url = String(best.item.main_url || best.item.backup_url)
    report.trackDurationSeconds = Math.round(best.got.trackDuration)
    report.streamDurationSeconds = Math.round(best.got.streamDuration)
    report.isPreview = isPreviewStream(best.got)
    report.isLossless = String(best.item.video_meta?.quality) === 'lossless' || String(best.item.video_meta?.vtype) === 'flac'
  }

  const trackNode = best?.got?.parsed?.track?.id
    ? best.got.parsed.track
    : (best?.got?.parsed?.seo_track?.track || {})
  report.requiresVip = trackRequiresVip(trackNode)

  report.hint = buildHint(report)
  return report
}

/** 诊断结论的人话版（口径同 libresoda `build_hint`） */
export function buildHint(r: SodaStreamDiagnosis): string {
  if (!r.url) {
    return r.hasSigner && !r.signerOnline
      ? `汽水两条免签名通道都没解析到播放流，且签名器离线（${r.signerError || '未知原因'}）`
      : '汽水两条免签名通道都没解析到播放流，请检查曲目 ID 与网络连通性'
  }
  if (!r.isPreview) {
    if (r.isLossless) return `已拿到整曲无损流（通道 ${r.source}）`
    return `已拿到整曲流（通道 ${r.source}）`
  }
  // 试听片段
  const shown = r.streamDurationSeconds || 0
  if (r.requiresVip && !r.signerOnline) {
    return `该曲整曲仅限会员播放：明文通道只有 ${shown} 秒试听，需「设备指纹 + 签名器」后走 App 端点；${r.signerError || '未配置签名器'}`
  }
  if (r.requiresVip && r.signerOnline) {
    return `签名器在线但仍只拿到 ${shown} 秒试听，通常是签名器与设备指纹不匹配，或该账号对此曲没有整曲权益；App 端点返回：${r.signerError || '（无错误信息）'}`
  }
  return `只拿到 ${shown} 秒试听片段（整曲 ${r.trackDurationSeconds} 秒），该曲在汽水侧受版权限制`
}
