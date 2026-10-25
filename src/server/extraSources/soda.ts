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

/**
 * PC 客户端 UA。实测（2026-10-25）必须与官方客户端一致：
 *   UA = LunaPC/3.7.0(30080000)；query 里 app_name=luna_pc、device_platform=windows、version_code=30080000。
 * 用 Android 的 com.luna.music UA 或 3.3.0 版本号，即使签名正确上游也只回 0 字节。
 */
const PC_APP_UA = 'LunaPC/3.7.0(30080000)'

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
} | null> {
  if (!signer.isConfigured()) return null
  const st = await signer.status()
  if (!st.online) return null

  const dev = await signer.deviceConfig()
  const params = new URLSearchParams({
    track_id: trackId,
    media_type: 'track',
    aid: '386088',
    app_name: 'luna_pc',
    device_platform: 'windows',
    channel: 'official',
    version_code: '30080000',
    version_name: '3.7.0',
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
  const baseHeaders: Record<string, string> = { 'User-Agent': PC_APP_UA }
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
  const bodyAny: any = resp.body
  let parsed: any = null
  if (bodyAny && typeof bodyAny === 'object' && !Buffer.isBuffer(bodyAny)) parsed = bodyAny
  else {
    const raw = Buffer.isBuffer(bodyAny) ? bodyAny.toString('utf-8') : String(bodyAny || '')
    if (!raw.trim().startsWith('{')) return null
    try { parsed = JSON.parse(raw) } catch { return null }
  }

  let model: any = parsed?.track_player?.video_model
  if (typeof model === 'string') {
    try { model = model.trim() ? JSON.parse(model) : {} } catch { model = {} }
  }
  const list: SodaVideoItem[] = Array.isArray(model?.video_list) ? model.video_list : []
  const usable = list.filter(v => String(v?.main_url || '').startsWith('http'))
  if (!usable.length) return null

  // 签名 ≠ 有版权：受限曲照样只给 30/60 秒，这里必须拦住，否则播放器会播到一半静音
  const trackDur = toNumber(parsed?.track?.duration) / 1000
  const streamDur = toNumber(model?.video_duration)
  if (trackDur > 0 && streamDur > 0 && streamDur < trackDur * 0.85) return null

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

  console.log(`[汽水签名] ✓ 整曲（${chosen.v.video_meta?.quality} / ${Math.round(toNumber(chosen.v.video_meta?.bitrate) / 1000)}k）`)
  return {
    url: String(chosen.v.main_url || chosen.v.backup_url),
    quality: chosen.meta!.label,
    via: `signer:pc_track_v2:${chosen.v.video_meta?.quality || '?'}`,
    ext: String(chosen.v.video_meta?.vtype || 'm4a'),
  }
}

function toNumber(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 取音频直链。
 * @param cookie 账号 Cookie（可不传）。实测匿名即可拿到可播曲的直链；
 *               带 Cookie 时应能多解锁一部分（会员曲整曲仍需客户端签名，未验证）。
 */
export async function getAudioUrl(songInfo: any, quality: string, cookie = '', username = ''): Promise<{
  url: string
  quality: string
  via: string
  ext?: string
}> {
  const trackId = String(songInfo?.meta?.trackId || songInfo?.id || songInfo?.songmid || '').trim()
  if (!isSodaId(trackId)) throw new Error(`汽水歌曲 id 不合法（${trackId || '空'}）`)

  // ① 配了签名器就走签名通道：它能回到 6 档音质（lossless 852k / hi_res / spatial），
  //    h5 端点只给 medium/higher/highest 三档，且拿不到无损。
  const signedFirst = await trySignedStream(trackId, cookie, quality).catch(() => null)
  if (signedFirst) {
    pending.remove(`soda:${trackId}`)
    return signedFirst
  }

  const params = new URLSearchParams({
    track_id: trackId,
    media_type: 'track',
    aid: '386088',
    device_platform: 'web',
    channel: 'pc_web',
  })

  let parsed: any = {}
  try {
    const resp = await request<any>(`${H5_TRACK_API}?${params.toString()}`, {
      // 注意：不要带 Referer，douyinvod 见到 qishui 域来源会 403；取流接口本身也不挑 Referer
      headers: { 'User-Agent': WEB_UA, ...(cookie ? { Cookie: cookie } : {}) },
      timeout: 15000,
    })
    // needle 只在 content-type: application/json 时自动解析；汽水这个端点有时不带该头，
    // 所以对象 / 字符串 / Buffer 三种形态都要兼容，否则会误判成「非 JSON」。
    const bodyAny: any = resp.body
    if (bodyAny && typeof bodyAny === 'object' && !Buffer.isBuffer(bodyAny)) {
      parsed = bodyAny
    } else {
      const raw = Buffer.isBuffer(bodyAny) ? bodyAny.toString('utf-8') : String(bodyAny || '')
      if (!raw.trim().startsWith('{')) {
        throw new Error(`上游返回非 JSON（HTTP ${resp.statusCode}）`)
      }
      parsed = JSON.parse(raw)
    }
  } catch (e: any) {
    throw new Error(`汽水取流请求失败：${e?.message || e}`)
  }

  const track = parsed?.track || {}
  const player = parsed?.track_player || {}
  let model: any = player.video_model
  if (typeof model === 'string') {
    try { model = model.trim() ? JSON.parse(model) : {} } catch { model = {} }
  }
  model = model || {}

  const list: SodaVideoItem[] = Array.isArray(model.video_list) ? model.video_list : []
  const usable = list.filter(v => String(v?.main_url || '').startsWith('http'))
  if (!usable.length) {
    const signed = await trySignedStream(trackId, cookie).catch(() => null)
    if (signed) return signed
    const msg = '汽水未返回可用音频流（该曲可能已下架或仅支持客户端播放）'
    pending.add(songInfo, 'no-stream', msg, username)
    throw new Error(msg)
  }

  // 版权受限曲目会下发 30s / 60s 的试听片段：如实拦下来，别让播放器播到一半静音
  const trackDuration = toNumber(track.duration) / 1000
  const streamDuration = toNumber(model.video_duration)
  const isPreview = trackDuration > 0 && streamDuration > 0 && streamDuration < trackDuration * 0.85
  if (isPreview) {
    const signed = await trySignedStream(trackId, cookie).catch(() => null)
    if (signed) return signed
    const shown = Math.round(streamDuration)
    const msg = `汽水该曲仅有 ${shown} 秒试听（版权限制，完整 ${Math.round(trackDuration)} 秒需官方客户端签名），请换源或换平台播放`
    // 记待补：等签名器在线时自动补，不让用户凭记忆重新找歌
    pending.add(songInfo, 'preview-only', msg, username)
    throw new Error(msg)
  }

  const wantRank = QUALITY_RANK[quality] ?? 3
  usable.sort((a, b) => toNumber(b.video_meta?.bitrate) - toNumber(a.video_meta?.bitrate))
  const rankOf = (v: SodaVideoItem) => QUALITY_RANK[String(v.video_meta?.quality || '')] || 1
  const chosen = usable.find(v => rankOf(v) <= wantRank) || usable[usable.length - 1]

  pending.remove(`soda:${trackId}`)
  const bitrate = toNumber(chosen.video_meta?.bitrate)
  return {
    url: String(chosen.main_url || chosen.backup_url),
    quality: QUALITY_LABEL[String(chosen.video_meta?.quality || '')] || '320k',
    via: `h5:track_v2:${chosen.video_meta?.quality || '?'}(${Math.round(bitrate / 1000)}k)`,
    ext: String(chosen.video_meta?.vtype || 'm4a'),
  }
}

export function hasAccount(): boolean {
  return !!store.getCookie('soda')
}
