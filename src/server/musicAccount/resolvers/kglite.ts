/**
 * 酷狗概念版（kglite）—— 账号取链
 *
 * 为什么单独做一个平台，而不是塞进 kg：
 *   概念版是独立 appid（3116）的独立通道，登录态是「App token」而不是网页 Cookie，
 *   并且它有自己的免费会员体系（看广告领 VIP）。混进 kg 会导致两种凭据互相污染，
 *   也没法在界面上单独展示「概念版 VIP 还剩几小时」。
 *
 * ⚠️ 实测事实（2026-10-28，别再凭想象改）：
 *
 * 1) **取链三跳，缺一不可**：
 *      user_verify（拿用户 auth） → authorization（换音乐级 auth + open_time） → tracker/v5/url
 *    - user_verify / authorization 要 `x-router: trackercdngz.kugou.com`
 *    - get_res_privilege/lite 要 `x-router: media.store.kugou.com`
 *    - tracker/v5/url **不能带 x-router**（带了会 502）
 *    - 全部走 https 即可，不需要退回明文 http
 *
 * 2) **必须用「目标音质自己的 hash」去取链**。privilege 返回的 relate_goods 里每档各有一个 hash，
 *    拿 128 的 hash 去请求 320/flac，服务端**不报错**，静默返回同一个 128k 文件 ——
 *    这是最容易误判成「VIP 没生效」的坑。
 *
 * 3) **privilege 的 privilege/pay_type 字段不能当判据**：无论有没有 VIP、甚至匿名，
 *    受限曲一律返回 privilege=10 / pay_type=3，但取链照样能成功。
 *
 * 4) **登录态只需 Cookie 里的 4 个字段**：token / userid / mid / dfid。
 *    mid 必须保存 —— 请求签名和 v5/url 的 key 都依赖它，缺了就签不出正确请求。
 *    网页版 Cookie（t / KugooID）打 App 接口会返回 35005 token invalid，必须扫码或短信登录。
 */

import crypto from 'crypto'
import { request, withTimeout, extFromUrl, parseCookie } from '../http'
import type { AccountResolveResult, AccountInfo } from '../types'

// —— 概念版固定参数 ——
const APP_ID = 3116
const CLIENT_VER = 11440
/** 请求签名盐（与标准版完全不同，照抄别改） */
const SIGN_SALT = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA'
/** v5/url 的 key 盐 */
const KEY_SALT = '185672dd44712f60bb1736df5a377e82'
const ANDROID_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi'
const ROUTER_TRACKER = 'trackercdngz.kugou.com'
const ROUTER_MEDIA = 'media.store.kugou.com'

/** v5/url 的概念版专属参数 */
const PID = 411
const PAGE_ID = 967177915
const PPAGE_ID = '356753938,823673182,967485191'

/** 领 VIP 用的广告位 id（概念版客户端内置，一次 3 小时） */
const AD_ID = 12307537187
/** 听歌领 VIP 用的歌曲 id（概念版客户端的固定上报曲目） */
const LISTEN_MIXSONGID = 666075191
const LISTEN_CLIENT_VER = 10566
const LISTEN_UA = 'Android13-1070-10566-201-0-ReportPlaySongToServerProtocol-wifi'

const GATEWAY = 'https://gateway.kugou.com'

/** 今日领取额度上限（平台侧 fixed=8，一次 3 小时刚好覆盖一天） */
export const DAILY_CLAIM_LIMIT = 8
export const HOURS_PER_CLAIM = 3

function md5(s: string): string {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex')
}

interface LiteCreds {
  token: string
  userid: string
  mid: string
  dfid: string
}

/** 从 Cookie 提取概念版登录态。缺 token/userid 视为未登录，缺 mid 视为设备标识丢失 */
function extractCreds(cookie: string): LiteCreds {
  const c = parseCookie(cookie) as Record<string, string>
  return {
    token: String(c.token || c.Token || '').trim(),
    userid: String(c.userid || c.KugooID || '').trim(),
    mid: String(c.mid || c.KUGOU_API_MID || '').trim(),
    dfid: String(c.dfid || '-').trim() || '-',
  }
}

/** 是否是一份可用的概念版凭据 */
export function hasLiteCreds(cookie: string): boolean {
  const c = extractCreds(cookie)
  return !!c.token && !!c.userid && !!c.mid
}

interface LiteCallOpts {
  method?: 'GET' | 'POST'
  params?: Record<string, string | number>
  data?: any
  router?: string
  /** 目标网关，默认 gateway.kugou.com；会员查询在 kugouvip 域下 */
  host?: string
  /** 覆盖 UA：听歌上报那类接口按客户端版本校验 UA，认错了会静默返回 status=0 */
  ua?: string
  /** GET 时把参数拼进查询串；POST 时仍然拼（酷狗习惯参数与 body 并存） */
  timeout?: number
}

/**
 * 打一次概念版接口：统一签名（md5(盐 + 排序参数 + body + 盐)）+ 安卓客户端请求头。
 * 返回 { http, body }；网络层异常直接抛给调用方。
 */
async function liteCall(
  path: string,
  cookie: string,
  { method = 'GET', params = {}, data = null, router = '', host = GATEWAY, ua = '', timeout = 12000 }: LiteCallOpts = {},
): Promise<{ http: number; body: any }> {
  const c = extractCreds(cookie)
  const clienttime = Math.floor(Date.now() / 1000)

  const full: Record<string, string | number> = {
    dfid: c.dfid,
    mid: c.mid,
    uuid: '-',
    appid: APP_ID,
    clientver: CLIENT_VER,
    clienttime,
    ...params,
    token: c.token,
    userid: c.userid,
  }
  const bodyStr = data ? JSON.stringify(data) : ''
  // 签名覆盖「除 signature 自身外的全部参数」，按参数名排序拼接
  const digest = Object.keys(full).sort().map(k => `${k}=${full[k]}`).join('')
  full.signature = md5(`${SIGN_SALT}${digest}${bodyStr}${SIGN_SALT}`)

  const headers: Record<string, string> = {
    'User-Agent': ua || ANDROID_UA,
    dfid: c.dfid,
    clienttime: String(clienttime),
    mid: c.mid,
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    Cookie: cookie,
  }
  if (router) headers['x-router'] = router
  if (method === 'POST') headers['Content-Type'] = 'application/json'

  const qs = new URLSearchParams(full as any).toString()
  const resp = await request(`${host}${path}?${qs}`, {
    method: method === 'POST' ? 'post' : 'get',
    headers,
    body: method === 'POST' ? bodyStr : undefined,
    timeout,
  })
  return { http: resp.statusCode, body: resp.body }
}

// —— 各音质档位 ——

/** 概念版音质档（与 LX quality 不是一套） */
type LiteQuality = '128' | '320' | 'flac' | 'high'

interface LiteGoods {
  quality: LiteQuality
  hash: string
  size: number
}

/** 请求音质 → 概念版档位降级链（从高到低，第一个成功的就返回） */
const QUALITY_CHAIN: Record<string, LiteQuality[]> = {
  flac24bit: ['high', 'flac', '320', '128'],
  hires: ['high', 'flac', '320', '128'],
  master: ['high', 'flac', '320', '128'],
  atmos: ['high', 'flac', '320', '128'],
  atmos_plus: ['high', 'flac', '320', '128'],
  flac: ['flac', '320', '128'],
  '320k': ['320', '128'],
  '128k': ['128'],
}

/** 实际拿到的概念版档位 → 回给上层的 LX 音质名 */
const QUALITY_LABEL: Record<LiteQuality, string> = {
  high: 'flac24bit',
  flac: 'flac',
  '320': '320k',
  '128': '128k',
}

function chainFor(quality: string): LiteQuality[] {
  return QUALITY_CHAIN[String(quality || '320k')] || ['320', '128']
}

function pickHash(songInfo: any): string {
  return String(
    songInfo?.hash
    ?? songInfo?.meta?.hash
    ?? songInfo?.songmid
    ?? songInfo?.meta?.songId
    ?? '',
  ).trim()
}

function pickAlbumId(songInfo: any): number {
  const raw = songInfo?.albumId
    ?? songInfo?.album_id
    ?? songInfo?.meta?.albumId
    ?? songInfo?.meta?.album_id
    ?? 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** privilege 结果缓存：同一首歌连续播放（切音质、重试）不用反复打接口 */
interface PrivCacheEntry {
  at: number
  goods: LiteGoods[]
  albumAudioId: number
  name: string
}
const privCache = new Map<string, PrivCacheEntry>()
const PRIV_TTL_MS = 10 * 60 * 1000

async function fetchGoods(hash: string, albumId: number, cookie: string): Promise<PrivCacheEntry> {
  const cacheKey = `${hash.toLowerCase()}:${albumId}`
  const hit = privCache.get(cacheKey)
  if (hit && Date.now() - hit.at < PRIV_TTL_MS) return hit

  const resp = await liteCall('/v2/get_res_privilege/lite', cookie, {
    method: 'POST',
    router: ROUTER_MEDIA,
    data: {
      appid: APP_ID,
      area_code: 1,
      behavior: 'play',
      clientver: CLIENT_VER,
      need_hash_offset: 1,
      relate: 1,
      support_verify: 1,
      resource: [{ type: 'audio', page_id: 0, hash: hash.toLowerCase(), album_id: albumId }],
      qualities: ['128', '320', 'flac', 'high'],
    },
  })

  const row = (resp.body as any)?.data?.[0]
  if (!row) {
    throw new Error(`概念版未返回权限信息（HTTP ${resp.http}，status=${(resp.body as any)?.status ?? '-'}）`)
  }

  const goods: LiteGoods[] = []
  for (const g of (row.relate_goods || [])) {
    const q = String(g.quality)
    if (!['128', '320', 'flac', 'high'].includes(q)) continue
    const h = String(g.hash || '').toLowerCase()
    if (!h) continue
    goods.push({ quality: q as LiteQuality, hash: h, size: Number(g.info?.filesize) || 0 })
  }
  if (!goods.length) throw new Error('概念版没有返回任何可用音质，可能这首曲子没有版权')

  const entry: PrivCacheEntry = {
    at: Date.now(),
    goods,
    albumAudioId: Number(row.album_audio_id) || 0,
    name: String(row.name || ''),
  }
  privCache.set(cacheKey, entry)
  // 缓存别无限涨：超过 500 条时清掉最旧的一半
  if (privCache.size > 500) {
    const sorted = [...privCache.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [k] of sorted.slice(0, 250)) privCache.delete(k)
  }
  return entry
}

/** 拿用户级 auth（三跳第一跳） */
async function getUserAuth(cookie: string): Promise<string> {
  const resp = await liteCall('/v1/user_verify', cookie, {
    params: { module_id: 51 },
    router: ROUTER_TRACKER,
  })
  const b: any = resp.body || {}
  if (Number(b.status) !== 1) {
    const code = b.error_code ?? b.errcode
    // 35005 = token invalid：登录态过期，提示重新扫码；别和 35002（缺参数）混在一起
    if (String(code) === '35005') throw new Error('概念版登录态已失效（token invalid），请重新扫码或短信登录')
    throw new Error(`概念版账号校验失败（status=${b.status ?? '-'}${code ? `，error_code=${code}` : ''}）`)
  }
  const auth = String(b?.data?.auth || '').trim()
  if (!auth) throw new Error('概念版未返回用户授权串（auth 为空）')
  return auth
}

/** 三跳第 2、3 跳：单档取链 */
async function fetchUrlForGoods(
  goods: LiteGoods,
  ctx: { cookie: string; userAuth: string; albumId: number; albumAudioId: number; creds: LiteCreds },
): Promise<string> {
  const authResp = await liteCall('/v1/authorization', ctx.cookie, {
    params: {
      authorization: ctx.userAuth,
      module_id: 51,
      album_audio_id: ctx.albumAudioId || 0,
      clientver: 11561,
      hash: goods.hash,
    },
    router: ROUTER_TRACKER,
  })
  const ab: any = authResp.body || {}
  const musicAuth = String(ab?.data?.auth || '').trim()
  const openTime = Number(ab?.data?.open_time) || 0
  if (!musicAuth) {
    throw new Error(`概念版音乐授权失败（status=${ab.status ?? '-'}，error_code=${ab.error_code ?? '-'}）`)
  }

  const key = md5(`${goods.hash}${KEY_SALT}${APP_ID}${ctx.creds.mid}${ctx.creds.userid}`)
  const urlResp = await liteCall('/tracker/v5/url', ctx.cookie, {
    params: {
      album_id: ctx.albumId,
      area_code: 1,
      module: '',
      hash: goods.hash,
      need_m: 0,
      ssa_flag: 'is_fromtrack',
      version: 11430,
      open_time: openTime,
      ptype: 0,
      need_ogg: 1,
      page_id: PAGE_ID,
      auth: musicAuth,
      mtype: 0,
      quality: goods.quality,
      album_audio_id: ctx.albumAudioId || 0,
      behavior: 'play',
      pid: PID,
      module_id: 51,
      cmd: 26,
      ppage_id: PPAGE_ID,
      clientver: 11561,
      pidversion: 3001,
      cdnBackup: 1,
      key,
    },
  })
  const ub: any = urlResp.body || {}
  const urls = ub.url || ub?.data?.url
  if (typeof urls === 'string' && urls) return urls
  if (Array.isArray(urls)) {
    const first = urls.find((u: any) => typeof u === 'string' && u)
    if (first) return first
  }
  const code = ub.error_code ?? ub.errcode
  throw new Error(`概念版未返回播放地址（status=${ub.status ?? '-'}${code ? `，error_code=${code}` : ''}）`)
}

/** 该曲可用的最高档（供界面提示用） */
export async function availableQualities(songInfo: any, cookie: string): Promise<string[]> {
  const hash = pickHash(songInfo)
  if (!hash) return []
  try {
    const entry = await fetchGoods(hash, pickAlbumId(songInfo), cookie)
    return entry.goods.map(g => QUALITY_LABEL[g.quality])
  } catch {
    return []
  }
}

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const hash = pickHash(songInfo)
  if (!hash) return { ok: false, error: '歌曲缺少酷狗 hash，无法用概念版取链' }
  if (!hasLiteCreds(cookie)) {
    return { ok: false, error: '概念版账号凭据不完整（需要 token / userid / mid），请重新扫码或短信登录' }
  }

  const creds = extractCreds(cookie)
  const albumId = pickAlbumId(songInfo)

  let entry: PrivCacheEntry
  try {
    entry = await withTimeout(fetchGoods(hash, albumId, cookie), 12000, '概念版权限查询')
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }

  let userAuth: string
  try {
    userAuth = await withTimeout(getUserAuth(cookie), 12000, '概念版账号校验')
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }

  const chain = chainFor(quality)
  const tried: string[] = []
  let lastError = ''

  for (const want of chain) {
    const goods = entry.goods.find(g => g.quality === want)
    if (!goods) { tried.push(`${want}(无此档)`); continue }
    try {
      const url = await withTimeout(
        fetchUrlForGoods(goods, { cookie, userAuth, albumId, albumAudioId: entry.albumAudioId, creds }),
        12000,
        `概念版取链(${want})`,
      )
      if (url) {
        return {
          ok: true,
          url,
          quality: QUALITY_LABEL[goods.quality],
          // 只有 128k 是免费的；320 及以上都要概念版 VIP（无 VIP 时 320 会被静默降级成 128）
          isVip: goods.quality !== '128',
          via: `kglite:v5/url(${goods.quality})`,
          ext: extFromUrl(url) || 'mp3',
        }
      }
      tried.push(`${want}(空地址)`)
    } catch (e: any) {
      lastError = e?.message || String(e)
      tried.push(`${want}(失败)`)
    }
  }

  return {
    ok: false,
    error: `概念版取链失败${tried.length ? `（已尝试 ${tried.join('、')}）` : ''}${lastError ? `：${lastError}` : ''}`,
  }
}

// —— 会员状态 ——

/** 概念版会员信息（到期时间等） */
export interface LiteVipInfo {
  ok: boolean
  isVip: boolean
  /** 会员到期时间（毫秒时间戳），0 表示查不到 */
  expireAt: number
  /** 距到期还有几小时（可为负，表示已过期） */
  remainHours: number
  /** 平台返回的原始等级文案，如 svip */
  stage?: string
  error?: string
}

/**
 * 查概念版会员。
 *
 * 注意：`gateway.kugou.com/user/vip/detail` 走网关会 502（kws），别用它。
 * 这里用 `batch_union_vipinfo`（busi_type=concept），它返回的 vip_end_time 是
 * **累计未来到期时间**——正常，因为看广告是天数/小时数叠加的。
 */
export async function getVipInfo(cookie: string): Promise<LiteVipInfo> {
  const creds = extractCreds(cookie)
  if (!creds.userid) return { ok: false, isVip: false, expireAt: 0, remainHours: 0, error: '缺少 userid' }

  try {
    // 注意：这个接口同样要求概念版签名（不签名会返回 error_code=20006），
    // 所以必须走 liteCall，不能裸 POST。
    const resp = await liteCall('/v2/batch_union_vipinfo', cookie, {
      method: 'POST',
      host: 'https://kugouvip.kugou.com',
      data: {
        get_type: '2',
        busi_type: 'concept',
        useridlist: [Number(creds.userid)],
        clientappid: String(APP_ID),
      },
      timeout: 10000,
    })
    const b: any = resp.body || {}
    if (Number(b.status) !== 1) {
      return {
        ok: false, isVip: false, expireAt: 0, remainHours: 0,
        error: `概念版会员查询失败（status=${b.status ?? '-'}${b.error_code ? `，error_code=${b.error_code}` : ''}）`,
      }
    }
    const list = b?.data?.busi_vip?.[creds.userid] || []
    let expireAt = 0
    let stage = ''
    for (const item of list) {
      const t = String(item?.vip_end_time || '')
      const ms = Date.parse(t.includes('T') ? t : t.replace(' ', 'T') + '+08:00')
      if (Number.isFinite(ms) && ms > expireAt) {
        expireAt = ms
        stage = String(item?.vip_type || item?.busi_type || '')
      }
    }
    const remainHours = expireAt ? Math.round((expireAt - Date.now()) / 3600_000) : 0
    return { ok: true, isVip: remainHours > 0, expireAt, remainHours, stage }
  } catch (e: any) {
    return { ok: false, isVip: false, expireAt: 0, remainHours: 0, error: e?.message || String(e) }
  }
}

export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  const creds = extractCreds(cookie)
  if (!creds.token || !creds.userid) {
    return { ok: false, verified: 'structural', message: '缺少 token / userid，请用扫码或短信登录' }
  }
  if (!creds.mid) {
    return { ok: false, verified: 'structural', message: '缺少 mid（设备标识），取链签名会失败，请重新扫码或短信登录' }
  }

  // 用 user_verify 在线确认登录态（这是三跳第一跳，能真实反映 token 是否有效）
  try {
    await withTimeout(getUserAuth(cookie), 10000, '概念版账号校验')
  } catch (e: any) {
    return { ok: false, verified: 'online', message: e?.message || String(e) }
  }

  const vip = await getVipInfo(cookie)
  if (!vip.ok) {
    // 登录态是好的，只是会员查询失败：仍然算登录成功，避免误标失效
    return { ok: true, verified: 'online', isVip: false, nickname: `酷狗概念版 ${creds.userid}` }
  }
  return {
    ok: true,
    verified: 'online',
    isVip: vip.isVip,
    nickname: `酷狗概念版 ${creds.userid}`,
  }
}

// —— 领 VIP ——

export interface ClaimVipResult {
  ok: boolean
  /** 本次实际领到的总小时数 */
  gainedHours: number
  /** 每一步的明细，便于界面展示 */
  steps: Array<{ name: string; ok: boolean; message: string; hours?: number }>
  /**
   * 今天是否已领到过 VIP。
   * 不用「今日已领 N/8」——平台 month_vip_record 的 receive_vip 只是粗粒度标记（实测只增到 1），
   * 拿它算次数会显示成「1/8」，与实际额度（看广告接口返回的 done/total）对不上。
   */
  claimedToday?: boolean
  /** 领取后剩余 VIP 小时（已按「领取前 + 本次获得」校正，见 balanceDelayed） */
  remainHours?: number
  /** 领完后立刻查接口拿到的原始值（平台侧有缓存，通常比真实值小几小时） */
  remainHoursRaw?: number
  /**
   * 领完立刻查到的余额比预期少 —— 平台 `batch_union_vipinfo` 有秒级~分钟级缓存。
   * 实测（2026-10-30）：三个号领完立刻查都少 2~3 小时（正好是最后一条广告的量），
   * 过半小时再查就追平了。所以展示值用「领取前 + 本次获得」推算，实测值只做参考。
   */
  balanceDelayed?: boolean
  /**
   * 广告额度进度（来自 play_report 返回的 data.done / data.total，实测可信）。
   * 自动轮用它在「今天已领满」时直接跳过后续轮次，避免每 3 小时白打一次接口。
   */
  adDone?: number
  adTotal?: number
  error?: string
}

/**
 * 校正「领取后剩余时长」的展示值。
 *
 * 平台 `batch_union_vipinfo` 有缓存，领完立刻查会少 2~3 小时（正好是最后一条广告的量）。
 * 实测 2026-10-30：三个号分别报 +12/+12/+15，领完立刻查只涨了 9/9/12，
 * 半小时后再查全部追平 —— 时长没丢，是查询值滞后。
 *
 * 所以展示时用「领取前 + 本次获得」推算，与实测值取较大者；两者差异明显时标记
 * balanceDelayed，让界面说明「稍后刷新即追平」，而不是让用户以为没到账。
 */
export function reconcileRemain(
  beforeHours: number | null,
  gainedHours: number,
  measuredHours: number | null,
): { remainHours?: number; balanceDelayed: boolean } {
  const measured = measuredHours === null || measuredHours === undefined ? undefined : measuredHours
  // 领取前余额可能是负数（已过期），按 0 起算；null 才是「查不到」，不参与推算
  const expected = beforeHours !== null && beforeHours !== undefined && gainedHours > 0
    ? Math.max(0, beforeHours) + gainedHours
    : undefined
  if (expected === undefined) return { remainHours: measured, balanceDelayed: false }
  if (measured === undefined) return { remainHours: expected, balanceDelayed: false }
  return { remainHours: Math.max(measured, expected), balanceDelayed: measured < expected - 1 }
}

/** 领取选项：默认行为（什么都不传）= 手动点一次，只领 1 条广告 + 冷却保护 */
export interface ClaimVipOptions {
  /**
   * 自动连领模式（定时任务用）：
   * 跳过 90 秒手动冷却，并允许按 done/total 连领到额度用光。
   */
  internal?: boolean
  /** 本次最多领几次广告（1~8）。默认 1；自动轮传 8，由平台 done/total 决定何时停。 */
  maxAdTimes?: number
  /** 调用方已知「当天额度已领满」，直接跳过广告那条（不发请求） */
  adExhausted?: boolean
}

/** 今天是否已领过 VIP（month_vip_record 里是否有今天这条） */
export async function getTodayClaimCount(cookie: string): Promise<{ claimed: boolean } | null> {
  try {
    const resp = await liteCall('/youth/v1/activity/get_month_vip_record', cookie, {
      params: { latest_limit: 100 },
    })
    const b: any = resp.body || {}
    if (Number(b.status) !== 1) return null
    const list = Array.isArray(b?.data?.list) ? b.data.list : (Array.isArray(b?.data) ? b.data : [])
    // 接口按天聚合，取今天这条；字段名各版本略有差异，都兼容一下
    const today = new Date()
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    if (!list.length) return { claimed: false }
    let claimed = false
    for (const item of list) {
      const day = String(item?.day || item?.date || '')
      if (!day || !day.startsWith(key)) continue
      if (Number(item?.receive_vip ?? item?.count ?? 0) > 0) claimed = true
    }
    return { claimed }
  } catch {
    return null
  }
}

/**
 * 领 VIP 的错误码 → 人话。
 *
 * 130012 的口径纠正（2026-10-30）：上游 KGM-AUTO-CHECKIN（main.js:198）与 tgbot
 * （KuGouLogic.kt:252）都把 130012 当「今日已领取」的正常终态，这跟平台实际行为一致
 * （听歌任务一天只算一次）。早期这里误判成「平台侧限制」，导致每天刷 7 条假失败日志。
 */
export function claimErrorText(b: any): string {
  const code = Number(b?.error_code ?? b?.errcode) || 0
  const raw = String(b?.error_msg || b?.error || b?.msg || b?.message || '').trim()
  if (code === 30000) return '操作过于频繁，请等一两分钟再试（平台风控）'
  if (code === 130012) return '今日已领取（130012）'
  if (code === 30002) return '今日领取次数已用光（30002）'
  if (code === 20018) return '登录态已失效（20018），需要重新扫码或短信登录'
  if (code === 20006) return '请求被限流（20006），稍后再试'
  if (code === 20028) return '触发平台人机验证（20028），本次跳过'
  if (raw) return raw
  return `status=${b?.status ?? '-'}${code ? `，error_code=${code}` : ''}`
}

/**
 * 终态错误码：见到就停，不再继续连领。
 * 这些都不是「等一会儿就能好」的错误，继续打只会加重风控。
 */
const AD_TERMINAL_CODES = new Set([130012, 30002, 20018, 20028])

/**
 * 自动连领时两次广告上报之间的间隔。
 *
 * 不能比 30 秒短：上报体里 `play_start = now - 30000`、`play_end = now`，
 * 固定表示「刚看完一条 30 秒广告」，间隔短于 30 秒会让两段播放时间重叠，
 * 一眼就是脚本（主流实现取 30 秒 / 35 秒，这里取 32 秒留 2 秒余量）。
 */
export const AD_CLAIM_INTERVAL_MS = 32_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 本机日期串，用于「听歌任务今天已经报过」的去重 */
function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 听歌上报去重表（userid → 日期串）。
 *
 * 听歌任务平台侧一天只认一次，重复上报只会拿回 130012。放内存即可：
 * 即使重启后忘了，再报一次也是「今日已领取」，不会误判成失败。
 */
const listenDoneAt = new Map<string, string>()

/**
 * 两次领取之间的最小间隔。平台对连续领取有风控（实测隔几十秒就返回 30000 操作频繁），
 * 界面上按钮又很容易被连点，所以在这里统一挡一道。
 */
const CLAIM_COOLDOWN_MS = 90_000
/**
 * 冷却按账号记（key 用 userid），不能用全局时间戳：
 * 多账号轮流领时，全局冷却会把第二个号直接挡掉，看起来像「只有主账号能领」。
 */
const lastClaimAt = new Map<string, number>()

/**
 * 领概念版 VIP：听歌领一次 + 看广告领（按额度连领）。
 *
 * 实测口径（2026-10-30，在 246 主号实领验证）：
 *   - 看广告每次 +3 小时、每天 8 次额度，返回体带 `done/total/remain/award_vip_hour`；
 *     8 次合计 24 小时，刚好覆盖一天，所以漏一次就是净 -3 小时；
 *   - 听歌任务平台一天只认一次，重复上报返回 130012（今日已领取，不是失败）。
 *
 * 因此：听歌那条每天只报一次；广告在自动模式下连领到 `remain<=0 / 30002 / 满 8 次`。
 * 手动点按钮仍只领一次（maxAdTimes 默认 1），90 秒冷却也只管手动。
 */
export async function claimVip(cookie: string, opts: ClaimVipOptions = {}): Promise<ClaimVipResult> {
  if (!hasLiteCreds(cookie)) {
    return { ok: false, gainedHours: 0, steps: [], error: '概念版账号凭据不完整，请先登录' }
  }

  const claimsKey = extractCreds(cookie).userid || 'default'
  // 冷却只为挡手动连点；自动连领内部按 32 秒自己控间隔，不能被这道闸挡住。
  if (!opts.internal) {
    const since = Date.now() - (lastClaimAt.get(claimsKey) || 0)
    if (lastClaimAt.has(claimsKey) && since < CLAIM_COOLDOWN_MS) {
      const wait = Math.ceil((CLAIM_COOLDOWN_MS - since) / 1000)
      return {
        ok: false, gainedHours: 0, steps: [],
        error: `刚领过，请等 ${wait} 秒再试（平台对连续领取有频率限制）`,
      }
    }
  }
  lastClaimAt.set(claimsKey, Date.now())

  const steps: ClaimVipResult['steps'] = []
  let gained = 0
  const day = todayKey()

  // 先记一次领取前余额，用于最后校正展示值。
  // 平台 batch_union_vipinfo 有缓存：领完立刻查会比真实值少 2~3 小时（正好是最后一条
  // 广告的量），用户看到「获得 12 小时、剩余只涨 9」就会以为时长没到账（2026-10-30 实测）。
  const before = await getVipInfo(cookie)

  // 1) 听歌领（加分项，失败不阻断；一天只报一次）
  if (listenDoneAt.get(claimsKey) === day) {
    steps.push({ name: '听歌领 VIP', ok: true, hours: 0, message: '今日已领取，不再重复上报' })
  } else {
    try {
      const r = await liteCall('/youth/v2/report/listen_song', cookie, {
        method: 'POST',
        params: { clientver: LISTEN_CLIENT_VER },
        data: { mixsongid: LISTEN_MIXSONGID },
        ua: LISTEN_UA,
        timeout: 15000,
      })
      const b: any = r.body || {}
      const ok = Number(b.status) === 1
      const code = Number(b?.error_code) || 0
      const hours = Number(b?.data?.award_vip_hour) || (ok ? HOURS_PER_CLAIM : 0)
      if (ok) gained += hours
      // 130012 = 今日已领取，同样说明「这条今天不用再报了」
      if (ok || code === 130012) listenDoneAt.set(claimsKey, day)
      steps.push({
        name: '听歌领 VIP',
        ok: ok || code === 130012,
        hours: ok ? hours : 0,
        message: ok ? `+${hours} 小时` : claimErrorText(b),
      })
    } catch (e: any) {
      steps.push({ name: '听歌领 VIP', ok: false, message: e?.message || String(e) })
    }
  }

  // 2) 看广告领（主通道，可连领）
  let adDone: number | undefined
  let adTotal: number | undefined
  if (opts.adExhausted) {
    steps.push({ name: '看广告领 VIP', ok: true, hours: 0, message: '今日额度已领满，本轮跳过' })
  } else {
    const limit = Math.min(Math.max(1, Math.floor(opts.maxAdTimes ?? 1)), DAILY_CLAIM_LIMIT)
    let lastMessage = ''
    let okCount = 0
    let totalHours = 0
    for (let i = 0; i < limit; i++) {
      // 第一次立刻发，之后每次隔 32 秒（必须 ≥30 秒，见 AD_CLAIM_INTERVAL_MS 注释）
      if (i > 0) await sleep(AD_CLAIM_INTERVAL_MS)
      const now = Date.now()
      let b: any = {}
      try {
        const r = await liteCall('/youth/v1/ad/play_report', cookie, {
          method: 'POST',
          data: { ad_id: AD_ID, play_start: now - 30000, play_end: now },
          timeout: 15000,
        })
        b = r.body || {}
      } catch (e: any) {
        lastMessage = e?.message || String(e)
        break
      }
      const ok = Number(b.status) === 1
      if (!ok) {
        const code = Number(b?.error_code) || 0
        lastMessage = claimErrorText(b)
        // 30002（次数用光）/ 130012（今日已领）都是正常终态，不算失败，直接停
        break
      }
      const data = b?.data || {}
      const hours = Number(data.award_vip_hour) || HOURS_PER_CLAIM
      gained += hours
      totalHours += hours
      okCount += 1
      if (Number.isFinite(Number(data.done))) adDone = Number(data.done)
      if (Number.isFinite(Number(data.total))) adTotal = Number(data.total)
      // 额度用光就停，别再打第 9 次
      const remain = Number(data.remain)
      if (Number.isFinite(remain) && remain <= 0) break
    }
    const quotaText = adDone !== undefined ? `（今日 ${adDone}/${adTotal ?? DAILY_CLAIM_LIMIT}）` : ''
    if (okCount > 0) {
      steps.push({
        name: '看广告领 VIP',
        ok: true,
        hours: totalHours,
        message: `+${totalHours} 小时${quotaText}${okCount > 1 ? `，连领 ${okCount} 次` : ''}`,
      })
    } else {
      steps.push({ name: '看广告领 VIP', ok: false, message: lastMessage || '未获得 VIP' })
    }
  }

  const today = await getTodayClaimCount(cookie)
  const vip = await getVipInfo(cookie)

  // 展示口径：以「领取前 + 本次获得」为准，实测值只取较大者。
  // 原因见上面 before 的注释 —— 实测值有缓存延迟，直接展示会看起来像没加上。
  const measured = vip.ok ? vip.remainHours : null
  const reconciled = reconcileRemain(before.ok ? before.remainHours : null, gained, measured)
  const { remainHours } = reconciled
  if (reconciled.balanceDelayed) {
    console.log(
      `[平台账号] 概念版余额查询有延迟（${extractCreds(cookie).userid || 'default'}）：`
      + `实测 ${measured} 小时 < 预期 ${remainHours} 小时，本次按预期展示，稍后刷新即追平`,
    )
  }

  const allSettled = steps.every(s => s.ok)
  return {
    ok: gained > 0,
    gainedHours: gained,
    steps,
    claimedToday: today?.claimed,
    remainHours,
    remainHoursRaw: measured ?? undefined,
    balanceDelayed: reconciled.balanceDelayed,
    adDone,
    adTotal,
    error: gained > 0 || allSettled ? undefined : '本次没有领到 VIP（多为今日额度已用完或触发频率限制）',
  }
}

// —— 手机验证码登录 ——

const SMS_SIGN_KEY = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
const LOGIN_API = 'https://login-user.kugou.com'

/** 短信接口的 web 签名：md5(盐 + 排序 k=v + 盐) */
function webSign(params: Record<string, string>): string {
  const pairs = Object.keys(params).map(k => `${k}=${params[k]}`).sort()
  return md5(SMS_SIGN_KEY + pairs.join('') + SMS_SIGN_KEY)
}

/** 登录请求头（扫码/短信同一套设备标识，缺一个就会「设备漂移」） */
function loginHeaders(dev: { guid: string; mid: string; device: string }, clienttime: string): Record<string, string> {
  return {
    'User-Agent': ANDROID_UA,
    dfid: '-',
    clienttime,
    mid: dev.mid,
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    Cookie: [
      `KUGOU_API_GUID=${dev.guid}`,
      `KUGOU_API_MID=${dev.mid}`,
      `KUGOU_API_DEV=${dev.device}`,
      'dfid=-',
    ].join('; '),
  }
}

export interface SmsSentResult {
  ok: boolean
  /** 后续登录必须复用这组设备标识，否则服务端会当成换设备 */
  state?: { guid: string; mid: string; device: string }
  message: string
}

/** 发送短信验证码 */
export async function sendSmsCode(mobile: string): Promise<SmsSentResult> {
  const guid = crypto.randomUUID()
  const mid = BigInt(`0x${md5(guid)}`).toString(10)
  const device = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const clienttime = String(Date.now())
  const params: Record<string, string> = {
    dfid: '-',
    mid,
    uuid: '-',
    appid: String(APP_ID),
    clientver: String(CLIENT_VER),
    clienttime,
    mobile,
    plat: '4',
  }
  const query = new URLSearchParams(params).toString() + `&signature=${webSign(params)}`

  try {
    const resp = await request(`${LOGIN_API}/captcha/sent?${query}`, {
      headers: loginHeaders({ guid, mid, device }, clienttime),
      timeout: 12000,
    })
    const b: any = resp.body || {}
    const ok = Number(b.status) === 1
    return {
      ok,
      state: ok ? { guid, mid, device } : undefined,
      message: ok ? '验证码已发送' : String(b.error || b.msg || `发送失败（status=${b.status ?? '-'}）`),
    }
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) }
  }
}

export interface SmsLoginResult {
  ok: boolean
  /** 成功后可直接落库的 Cookie（token/userid/mid/dfid） */
  cookie?: string
  message: string
}

/** 用验证码登录，成功后返回可直接保存的 Cookie */
export async function loginBySmsCode(
  mobile: string,
  code: string,
  state: { guid: string; mid: string; device: string },
): Promise<SmsLoginResult> {
  const clienttime = String(Date.now())
  const params: Record<string, string> = {
    dfid: '-',
    mid: state.mid,
    uuid: '-',
    appid: String(APP_ID),
    clientver: String(CLIENT_VER),
    clienttime,
    mobile,
    code,
    plat: '4',
  }
  const query = new URLSearchParams(params).toString() + `&signature=${webSign(params)}`

  try {
    const resp = await request(`${LOGIN_API}/login/cellphone?${query}`, {
      headers: loginHeaders(state, clienttime),
      timeout: 15000,
    })
    const b: any = resp.body || {}
    const data: any = b.data || {}
    const token = String(data.token || '').trim()
    const userid = String(data.userid ?? '').trim()
    if (Number(b.status) !== 1 || !token || !userid || userid === '0') {
      return { ok: false, message: String(b.error || b.msg || `登录失败（status=${b.status ?? '-'}）`) }
    }
    return {
      ok: true,
      // 只留取链真正需要的 4 个字段，减少落库体积与敏感面
      cookie: `token=${token}; userid=${userid}; mid=${state.mid}; dfid=-`,
      message: '登录成功',
    }
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) }
  }
}

// —— 搜索 ——

/** 把 kugou 搜索结果里常带的 HTML 转义字符还原（歌名/歌手偶发 &#39; &amp; 等） */
function decodeHtmlEntities(s: string): string {
  if (!s) return ''
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

export interface LiteSong {
  id: string
  source: string
  name: string
  singer: string
  album: string
  albumId: number
  hash: string
  songmid: string
  interval: number
  img: string
  quality: string
}

export interface LiteSearchResult {
  list: LiteSong[]
  total: number
  allPage: number
  fetchedPages?: number
}

/**
 * 概念版歌曲搜索。
 *
 * 复用取链那套安卓签名（liteCall），只是换路由头 `complexsearch.kugou.com` + `clientver=201`
 * （概念版/Young 的 versionCode，区别于 App 级的 11440）。
 *
 * 不需要登录 token 也能出结果（平台对匿名搜索放行），但传入已配置的账号 Cookie 会带上真实
 * mid/dfid，与取链同口径、曲库更完整。若没传凭据则造一个最小设备标识，避免签名缺 mid 被拒。
 *
 * 返回的 hash / album_id 与取链同源，直接喂给 resolve 即可。
 */
export async function searchSongs(
  keyword: string,
  page = 1,
  pageSize = 20,
  cookie = '',
): Promise<LiteSearchResult> {
  const useCookie = (cookie && hasLiteCreds(cookie))
    ? cookie
    : (() => {
        const mid = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
        return `mid=${mid}; dfid=-`
      })()

  const resp = await liteCall('/v2/search/song', useCookie, {
    method: 'GET',
    router: 'complexsearch.kugou.com',
    params: {
      keyword: keyword,
      page: Math.max(1, page),
      pagesize: Math.min(50, Math.max(1, pageSize)),
      clientver: 201, // 概念版(Young) versionCode
      platform: 'AndroidFilter',
      iscorrection: 1,
      area_code: 1,
      dopicfull: 1,
    },
    timeout: 12000,
  })

  const b: any = resp.body || {}
  if (Number(b.status) !== 1) {
    const code = b.error_code ?? b.errcode
    throw new Error(`概念版搜索失败（status=${b.status ?? '-'}${code ? `，error_code=${code}` : ''}）`)
  }

  // complexsearch /v2/search/song 实测返回 data.lists（大驼峰字段），兼容旧 info/小写结构
  const info: any[] = b?.data?.lists || b?.data?.info || []
  const list: LiteSong[] = info.map((it: any) => {
    const hash = String(it.FileHash || it.hash || '').toLowerCase()
    const albumId = Number(it.AlbumID || it.Audioid || it.album_id || it.album_audio_id) || 0
    const dur = Number(it.Duration || it.duration || it.timelength) || 0
    return {
      id: `kglite_${hash}`,
      source: 'kglite',
      name: decodeHtmlEntities(it.SongName || it.songname || it.filename || ''),
      singer: decodeHtmlEntities(it.SingerName || it.singername || ''),
      album: decodeHtmlEntities(it.AlbumName || it.album_name || ''),
      albumId,
      hash,
      songmid: hash,
      interval: dur,
      img: '',
      quality: '128k',
    }
  })

  const total = Number(b?.data?.total) || Number(b?.data?.songcount) || list.length
  const allPage = Number(b?.data?.all_page) || (pageSize ? Math.ceil(total / pageSize) : 1)
  return { list, total, allPage }
}

/**
 * 搜索界面用：串行翻几页拼成一个较全的列表（与 extraSources.searchAll 同思路，
 * 平台对快速连发会返回重复页，故串行）。
 */
export async function searchKgliteAll(keyword: string, cookie = ''): Promise<LiteSearchResult> {
  const seen = new Set<string>()
  const list: LiteSong[] = []
  let total = 0
  let allPage = 1
  const maxPages = 3
  for (let p = 1; p <= maxPages; p++) {
    const d = await searchSongs(keyword, p, 20, cookie)
    total = Math.max(total, d.total)
    allPage = d.allPage || p
    let fresh = 0
    for (const it of d.list) {
      if (seen.has(it.id)) continue
      seen.add(it.id)
      list.push(it)
      fresh++
    }
    if (fresh === 0) break
    if (p >= allPage) break
  }
  return { list, total: total || list.length, allPage, fetchedPages: list.length ? Math.min(maxPages, allPage) : 0 }
}

/* ---------- 歌手 / 专辑搜索（complexsearch，与歌曲搜索同签名体系） ---------- */

export interface LiteSinger {
  id: number
  name: string
  picUrl: string
  alias: string[]
  albumSize: number
  musicSize: number
  source: string
}

export interface LiteAlbum {
  id: number
  name: string
  picUrl: string
  artistName: string
  size: number
  publishTime: string
  source: string
}

async function liteMetaSearch(
  path: '/v1/search/author' | '/v1/search/album',
  params: Record<string, string | number>,
  cookie: string,
): Promise<{ lists: any[]; total: number }> {
  const useCookie = (cookie && hasLiteCreds(cookie))
    ? cookie
    : (() => {
        const mid = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
        return `mid=${mid}; dfid=-`
      })()
  const resp = await liteCall(path, useCookie, {
    method: 'GET',
    router: 'complexsearch.kugou.com',
    params,
    timeout: 12000,
  })
  const b: any = resp.body || {}
  if (Number(b.status) !== 1) {
    const code = b.error_code ?? b.errcode
    throw new Error(`概念版搜索失败（status=${b.status ?? '-'}${code ? `，error_code=${code}` : ''}）`)
  }
  const lists: any[] = b?.data?.lists || b?.data?.info || []
  return { lists, total: Number(b?.data?.total) || lists.length }
}

/**
 * 概念版歌手搜索。实测响应字段为大驼峰：AuthorId/AuthorName/Avatar/AlbumCount/AudioCount。
 * 注意 author 端点不带 clientver=201（带了大反而 error_code=20028），参数集与歌曲搜索不同。
 */
export async function searchSinger(
  keyword: string,
  page = 1,
  pageSize = 20,
  cookie = '',
): Promise<{ list: LiteSinger[]; total: number; allPage: number }> {
  const { lists, total } = await liteMetaSearch('/v1/search/author', {
    keyword,
    page: Math.max(1, page),
    pagesize: Math.min(50, Math.max(1, pageSize)),
    platform: 'AndroidFilter',
    iscorrection: 1,
    albumhide: 0,
    nocollect: 0,
  }, cookie)
  const list: LiteSinger[] = lists.map((it: any) => ({
    id: Number(it.AuthorId) || 0,
    name: decodeHtmlEntities(it.AuthorName || ''),
    picUrl: String(it.Avatar || '').replace('/{size}/', '/240/'),
    alias: it.Auxiliary ? [String(it.Auxiliary)] : [],
    albumSize: Number(it.AlbumCount) || 0,
    musicSize: Number(it.AudioCount) || 0,
    source: 'kglite',
  }))
  const size = Math.min(50, Math.max(1, pageSize))
  return { list, total, allPage: Math.ceil(total / size) || 1 }
}

/**
 * 概念版专辑搜索。实测响应字段为小驼峰：albumid/albumname/singer/img/songcount/publish_time。
 * 该端点不能带 area_code/privilegefilter（会 error_code=20028）；clientver=201 可带可不带。
 */
export async function searchAlbum(
  keyword: string,
  page = 1,
  pageSize = 20,
  cookie = '',
): Promise<{ list: LiteAlbum[]; total: number; allPage: number }> {
  const { lists, total } = await liteMetaSearch('/v1/search/album', {
    keyword,
    page: Math.max(1, page),
    pagesize: Math.min(50, Math.max(1, pageSize)),
    platform: 'AndroidFilter',
    iscorrection: 1,
    category: '1',
    sorttype: 0,
    searchsong: 0,
    clientver: 201,
  }, cookie)
  const list: LiteAlbum[] = lists.map((it: any) => ({
    id: Number(it.albumid) || 0,
    name: decodeHtmlEntities(it.albumname || ''),
    picUrl: String(it.img || ''),
    artistName: decodeHtmlEntities(it.singer || ''),
    size: Number(it.songcount) || 0,
    publishTime: String(it.publish_time || ''),
    source: 'kglite',
  }))
  const size = Math.min(50, Math.max(1, pageSize))
  return { list, total, allPage: Math.ceil(total / size) || 1 }
}
