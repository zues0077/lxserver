/**
 * 酷狗音乐 —— 带账号 Cookie 取链
 *
 * ⚠️ 必须记住的实测事实（2026-10-24，别再凭想象改）：
 *
 * 1) **取链必须走网关 `gateway.kugou.com/v5/url`，不是 `album_audio` 也不是 `getSongInfo.php`。**
 *    旧实现走 `v5/album_audio/audio`（现已 404/502）和公开 `getSongInfo.php`（已不返 url），
 *    两条都失效 → 酷狗全灭。能跑通的真实做法是：直接用网页 Cookie 里的 `t`（令牌）+
 *    `KugooID`（用户 id），配**安卓客户端** UA、`x-router: trackercdn.kugou.com`、
 *    以及 `key` / `signature` 双签名去打 `v5/url`。
 *    （参考 Xbaiyz12/MusicUID，这是个活着的实现。所谓「需要 login_by_token 换证」是误判——
 *     该实现根本没用 login_by_token，网页 t 令牌配正确签名即可。）
 *
 * 2) **签名盐值固定，照抄别改**：
 *    - `key`      = md5(`{hash小写}{KEY_SALT}{APP_ID}{mid}{KugooID}`)
 *    - `signature`= md5(`{SIGN_SALT}` + 排序后的 `k=v` 拼接 + `{SIGN_SALT}`)，覆盖除
 *      signature 自身外的全部参数（含 key）。
 *
 * 3) **设备指纹 mid 必须与登录态解耦**：直接沿用 Cookie 里的 mid / dfid 会被服务端判 20018。
 *    mid 用固定种子 `MusicUID` 的 md5 转十进制大整数派生（128 位，JS 必须 BigInt，否则精度失真）；
 *    dfid 每次随机 24 位即可。
 *
 * 4) **token / userid 从 Cookie 正则提取**：缺 `t` 或 `KugooID` 直接判「凭据不完整」回退匿名。
 */

import crypto from 'crypto'
import { request, withTimeout, extFromUrl } from '../http'
import type { AccountResolveResult, AccountInfo } from '../types'

const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const VIP_INFO_API = 'https://vip.kugou.com/recharge/roleinfo'

// —— 登录取流：网关 v5/url ——
const GATEWAY_URL = 'https://gateway.kugou.com/v5/url'
const GATEWAY_ROUTER = 'trackercdn.kugou.com'
const KEY_SALT = '57ae12eb6890223e355ccfcb74edf70d'
const SIGN_SALT = 'OIlwieks28dk2k092lksi2UIkp'
const APP_ID = 1005
const CLIENT_VER = 11430
const PAGE_ID = 151369488
const PPAGE_ID = '463467626,350369493,788954147'
const MID_SEED = 'MusicUID'
const DFID_CHARS = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'
// 网关按安卓客户端校验请求头
const ANDROID_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi'
const EXTRA_HEADERS: Record<string, string> = {
  'kg-rc': '1',
  'kg-thash': '5d816a0',
  'kg-rec': '1',
  'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
}

// —— 匿名兜底：旧版 CDN（只校验 md5(hash+盐)，不登录也能拿免费曲，但常被风控）——
const CDN_URL = 'https://trackercdn.kugou.com/i/v2/'
const CDN_SALT = 'kgcloudv2'

function md5(s: string): string {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex')
}

/**
 * mid 用固定种子派生：Python 侧是 str(int(md5_hex, 16))，结果是个 128 位十进制大整数。
 * JS 的 Number 装不下（最大安全整数仅 2^53），必须用 BigInt 精确转换，否则 mid 失真会被判 20018。
 */
function deriveMid(): string {
  return BigInt('0x' + md5(MID_SEED)).toString()
}

function randomDfid(len = 24): string {
  let s = ''
  for (let i = 0; i < len; i++) s += DFID_CHARS[Math.floor(Math.random() * DFID_CHARS.length)]
  return s
}

function pickHash(songInfo: any): string {
  return String(songInfo?.hash ?? songInfo?.meta?.hash ?? songInfo?.songmid ?? songInfo?.meta?.songId ?? '')
}

/** 从 Cookie 正则提取 t（令牌）与 KugooID（用户 id） */
function extractCreds(cookie: string): { token: string; userid: string } {
  const t = (cookie.match(/(?:^|;\s*)t=([^;]*)/) || [])[1] || ''
  const uid = (cookie.match(/(?:^|;\s*)KugooID=([^;]*)/) || [])[1] || ''
  return { token: t, userid: uid }
}

/**
 * 登录取流：网关 v5/url（带登录态 + 安卓客户端签名）。
 * 按指定 quality 打一次；返回第一个非空 url，无结果返回空串。
 */
async function tryGatewayOnce(
  fileHash: string,
  cookie: string,
  ctx: { mid: string; dfid: string; clienttime: number; key: string },
  quality: number,
): Promise<string> {
  const { mid, dfid, clienttime, key } = ctx
  const { token, userid } = extractCreds(cookie)

  const params: Record<string, string | number> = {
    album_id: 0,
    area_code: 1,
    hash: fileHash,
    ssa_flag: 'is_fromtrack',
    version: CLIENT_VER,
    page_id: PAGE_ID,
    quality,
    album_audio_id: 0,
    behavior: 'play',
    pid: 2,
    cmd: 26,
    pidversion: 3001,
    IsFreePart: 0,
    ppage_id: PPAGE_ID,
    cdnBackup: 1,
    module: '',
    clientver: CLIENT_VER,
    dfid,
    mid,
    uuid: '-',
    appid: APP_ID,
    clienttime,
    token,
    userid,
    key,
  }

  // signature 覆盖除自身外的全部参数，按参数名排序拼接（含 key）
  const digest = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('')
  const signature = md5(`${SIGN_SALT}${digest}${SIGN_SALT}`)
  params.signature = signature

  // 手工拼裸查询串（不 URL-encode），与签名计算的原文完全一致，否则服务端判 err signature
  const query = Object.keys(params).map(k => `${k}=${params[k]}`).join('&')

  const resp = await request(`${GATEWAY_URL}?${query}`, {
    headers: {
      'User-Agent': ANDROID_UA,
      'x-router': GATEWAY_ROUTER,
      dfid,
      mid,
      clienttime: String(clienttime),
      Cookie: cookie,
      ...EXTRA_HEADERS,
    },
  })

  const body: any = resp.body || {}
  const urls: any = body?.url
  if (typeof urls === 'string' && urls) return urls
  if (Array.isArray(urls)) {
    for (const u of urls) if (typeof u === 'string' && u) return u
  }
  return ''
}

/** 匿名兜底：旧版 CDN（不登录，只校验 md5(hash+盐)）。常被风控，仅作最后保底 */
async function fetchByAnonymousCdn(hash: string): Promise<string> {
  const fileHash = hash.toLowerCase()
  const key = md5(`${fileHash}${CDN_SALT}`)
  const query = `key=${key}&hash=${fileHash}&br=hq&appid=1005&pid=2&cmd=25&behavior=play`
  const resp = await request(`${CDN_URL}?${query}`, {
    headers: { 'User-Agent': ANDROID_UA, Referer: 'https://www.kugou.com/' },
  })
  const body: any = resp.body || {}
  const urls: any = body?.url
  if (typeof urls === 'string' && urls) return urls
  if (Array.isArray(urls)) {
    for (const u of urls) if (typeof u === 'string' && u) return u
  }
  return ''
}

export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  try {
    const resp = await withTimeout(request(VIP_INFO_API, {
      headers: {
        'User-Agent': PC_UA,
        Accept: '*/*',
        Host: 'vip.kugou.com',
        Connection: 'keep-alive',
        Cookie: cookie,
      },
    }), 10000, '酷狗会员校验')

    const b: any = resp.body || {}
    // errno / error_code 非 0 表示令牌无效（实测无效 token 返回 errno=105、error_code=20017）。
    // 这一步必须做：否则任何胡填的 Cookie 都会被显示成「已登录」。
    if (Number(b?.errno) !== 0 || Number(b?.error_code) !== 0) {
      return {
        ok: false,
        verified: 'online',
        message: `Cookie 无效或已过期（errno=${b?.errno}，error_code=${b?.error_code}），请重新登录酷狗后复制`,
      }
    }
    const isVip = Number(b?.vipRemains) > 0 &&
      Number(b?.isExpiredMember) === 0 &&
      Number(b?.role) !== 0
    return { ok: true, verified: 'online', isVip, nickname: String(b?.nickname || '酷狗账号') }
  } catch (e: any) {
    return { ok: false, message: `酷狗会员校验失败：${e.message}` }
  }
}

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const hash = pickHash(songInfo)
  if (!hash) return { ok: false, error: '歌曲缺少酷狗 hash，无法用账号取链' }

  // 1) 登录取流（网关 v5/url，带登录态 + 安卓客户端签名）
  try {
    // 按请求音质从高到低尝试；默认 128 保证免费曲出链
    const chain = quality === '128k' ? [128] : [320, 128]
    const fileHash = hash.toLowerCase()
    const mid = deriveMid()
    const dfid = randomDfid()
    const clienttime = Math.floor(Date.now() / 1000)
    const { userid } = extractCreds(cookie)
    const key = md5(`${fileHash}${KEY_SALT}${APP_ID}${mid}${userid}`)
    let url = ''
    for (const q of chain) {
      url = await tryGatewayOnce(fileHash, cookie, { mid, dfid, clienttime, key }, q)
      if (url) break
    }
    if (url) {
      return { ok: true, url, quality, isVip: true, via: 'gateway:v5/url', ext: extFromUrl(url) }
    }
  } catch { /* 登录取流不可用，继续兜底 */ }

  // 2) 匿名兜底
  try {
    const url = await withTimeout(fetchByAnonymousCdn(hash), 12000, '酷狗匿名取流')
    if (url) {
      return { ok: true, url, quality: '128k', isVip: false, via: 'cdn:i/v2', ext: extFromUrl(url) }
    }
  } catch (e: any) {
    return { ok: false, error: `酷狗取链失败：${e.message}` }
  }

  return { ok: false, error: '酷狗未返回可用链接（多为付费曲目，或 Cookie 缺 t/KugooID、已过期）' }
}
