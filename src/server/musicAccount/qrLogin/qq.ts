/**
 * QQ 音乐 —— 扫码登录（QQ 扫码 + 微信扫码）
 *
 * 这是五个平台里链路最长的一条，原因是 QQ 音乐没有「扫码换 cookie」的直连接口，
 * 必须走一遍腾讯自己的 OAuth：
 *
 *   QQ 扫码：
 *     xlogin（种 cookie）→ ptqrshow（拿二维码 PNG + qrsig）
 *     → 轮询 ptqrlogin 拿 ptuiCB 里的跳转地址
 *     → 跟随跳转拿到 p_skey
 *     → graph.qq.com/oauth2.0/authorize 换 code
 *     → u.y.qq.com musicu.fcg 换 musickey
 *
 *   微信扫码（短很多）：
 *     open.weixin.qq.com/connect/qrconnect 页面里取 uuid
 *     → 轮询 lp.open.weixin.qq.com 拿 wx_code
 *     → musicu.fcg（music.login.LoginServer）换 musickey
 *
 * 全程靠 CookieJar 按域名携带 cookie，任何一步丢 cookie 都会在拿 p_skey 时失败。
 */

import * as crypto from 'node:crypto'
import { request } from '../http'
import { CookieJar, pngDataUrl, readSetCookies, queryValue, resolveUrl } from './util'
import type { QrCreateResult, QrCheckResult, QrDriver } from './types'

const LOGIN_PAGE_API = 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin'
const QR_SHOW_API = 'https://xui.ptlogin2.qq.com/ssl/ptqrshow'
const QR_CHECK_API = 'https://xui.ptlogin2.qq.com/ssl/ptqrlogin'
const OAUTH_JUMP = 'https://graph.qq.com/oauth2.0/login_jump'
const OAUTH_AUTHORIZE = 'https://graph.qq.com/oauth2.0/authorize'
const MUSIC_LOGIN_API = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const MUSIC_LOGIN_APIS = [
  MUSIC_LOGIN_API,
  'https://szu.y.qq.com/cgi-bin/musicu.fcg',
  'https://shu.y.qq.com/cgi-bin/musicu.fcg',
]
const WX_QR_CONNECT = 'https://open.weixin.qq.com/connect/qrconnect'
const WX_QR_CHECK = 'https://lp.open.weixin.qq.com/connect/l/qrconnect'
const WX_APPID = 'wx48db31d50e334801'
const WX_REDIRECT_URI = 'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/'
const CLIENT_ID = '100497308'
const SCOPE = 'get_user_info,get_app_friends'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'

export const TTL_SEC = 300
export const POLL_INTERVAL_MS = 2500

/** 腾讯那套 hash33：h = (h<<5) + h + c，最后取低 31 位 */
function hash33(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h += (h << 5) + text.charCodeAt(i)
    h &= 0x7fffffff
  }
  return h
}

function gtk33(text: string): number {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h += (h << 5) + text.charCodeAt(i)
    h &= 0x7fffffff
  }
  return h
}

function uuid(): string {
  return crypto.randomUUID()
}

/** 带 jar 的 GET/POST。followMax=0 表示不让 needle 自动跳，方便自己读 Location */
async function jarRequest(
  jar: CookieJar,
  url: string,
  opts: {
    method?: 'get' | 'post'
    body?: string
    referer?: string
    contentType?: string
    followMax?: number
    timeout?: number
  } = {},
): Promise<{ statusCode: number; headers: any; body: any }> {
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: '*/*' }
  if (opts.referer) headers.Referer = opts.referer
  if (opts.contentType) headers['Content-Type'] = opts.contentType
  const cookie = jar.header(url)
  if (cookie) headers.Cookie = cookie

  const resp = await request<any>(url, {
    method: opts.method || 'get',
    headers,
    body: opts.body,
    followMax: opts.followMax ?? 0,
    timeout: opts.timeout ?? 12000,
  })
  jar.setFromHeaders(url, resp.headers)
  return { statusCode: resp.statusCode, headers: resp.headers, body: resp.body }
}

/** 跟随 3xx，返回最终停留的 URL（拿 OAuth code 必须这么做） */
async function followRedirects(jar: CookieJar, startUrl: string, referer = ''): Promise<string> {
  let current = String(startUrl || '').trim()
  let ref = referer
  for (let i = 0; i < 10 && current; i++) {
    const resp = await jarRequest(jar, current, { referer: ref })
    const location = String(resp.headers?.location || '').trim()
    if (!location || resp.statusCode < 300 || resp.statusCode >= 400) return current
    ref = current
    current = resolveUrl(current, location)
  }
  return current
}

/** ptuiCB('0','0','<url>','0','登录成功','xxx') → 各段 */
function parsePtuiCB(raw: string): { code: string; message: string; redirect: string; raw: string } {
  const matches = Array.from(String(raw || '').matchAll(/'([^']*)'/g)).map(m => m[1])
  if (matches.length >= 5) {
    return { code: matches[0], message: matches[4], redirect: matches[2], raw }
  }
  return { code: '', message: raw, redirect: '', raw }
}

/** 把 musicu.fcg 返回里的 data 字段补成 Cookie（各字段名历史上换过好几版，全都兜） */
function cookiesFromLoginData(data: any): Record<string, string> {
  const out: Record<string, string> = {}
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = data?.[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
      if (typeof v === 'number' && v > 0) return String(v)
    }
    return ''
  }
  const musicId = pick('musicid', 'musicId', 'userid', 'user_id', 'uin')
  if (musicId) out.musicid = musicId
  const musicKey = pick('musickey', 'music_key', 'qqmusic_key', 'qm_keyst', 'strMusicKey')
  if (musicKey) {
    out.musickey = musicKey
    out.qqmusic_key = musicKey
    out.qm_keyst = musicKey
  }
  const openId = pick('openid', 'openId', 'wxopenid', 'strOpenid')
  if (openId) {
    out.openid = openId
    out.wxopenid = openId
  }
  const unionId = pick('unionid', 'unionId', 'wxunionid', 'strUnionid')
  if (unionId) {
    out.unionid = unionId
    out.wxunionid = unionId
  }
  const refreshKey = pick('refresh_key', 'refreshKey')
  if (refreshKey) out.refresh_key = refreshKey
  const accessToken = pick('access_token', 'accessToken', 'wxaccess_token')
  if (accessToken) out.wxaccess_token = accessToken
  return out
}

/** 统一补全 uin / qm_keyst：下游解析器只认这两个名字 */
function normalize(finalCookies: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(finalCookies)) {
    if (String(finalCookies[k] ?? '').trim() !== '') out[k] = finalCookies[k]
  }
  const pick = (...keys: string[]) => keys.map(k => out[k]).find(v => v && v.trim()) || ''
  if (!out.uin) {
    const u = pick('ptui_loginuin', 'luin', 'pt2gguin', 'superuin', 'p_uin', 'musicid', 'userid', 'wxuin')
    // QQ 的 uin 可能带 o 前缀（uin=o0123...），下游只要数字
    if (u) out.uin = u.replace(/^[oO]/, '')
  }
  const key = pick('qm_keyst', 'qqmusic_key', 'musickey', 'music_key', 'p_skey', 'skey')
  if (key) {
    out.qm_keyst = key
    out.qqmusic_key = out.qqmusic_key || key
  }
  return out
}

function cookieString(map: Record<string, string>): string {
  return Object.keys(map).map(k => `${k}=${map[k]}`).join('; ')
}

// ============================ QQ 扫码 ============================

export async function createQQ(): Promise<QrCreateResult> {
  const jar = new CookieJar()

  // 1) 预热登录页，种下 pt_login_sig 等基础 cookie
  const pageParams = new URLSearchParams({
    appid: '716027609',
    daid: '383',
    style: '33',
    login_text: '登录',
    hide_title_bar: '1',
    hide_border: '1',
    target: 'self',
    s_url: OAUTH_JUMP,
    pt_3rd_aid: CLIENT_ID,
    pt_feedback_link: `https://support.qq.com/products/77942?customInfo=.appid${CLIENT_ID}`,
    theme: '2',
    verify_theme: '',
  })
  await jarRequest(jar, `${LOGIN_PAGE_API}?${pageParams.toString()}`, { referer: 'https://y.qq.com/' })

  // 2) 取二维码图片
  const showParams = new URLSearchParams({
    appid: '716027609',
    e: '2',
    l: 'M',
    s: '3',
    d: '72',
    v: '4',
    t: (Date.now() / 1000).toFixed(6),
    daid: '383',
    pt_3rd_aid: CLIENT_ID,
    u1: OAUTH_JUMP,
  })
  const showResp = await jarRequest(jar, `${QR_SHOW_API}?${showParams.toString()}`, {
    referer: 'https://xui.ptlogin2.qq.com/',
  })
  const body = showResp.body
  const image = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : '', 'latin1')
  // 认 PNG 魔数而不是长度：QQ 这个二维码只有 111x111，压缩后 400 多字节，
  // 用「长度 > 500」这种阈值判断会把正常二维码误判成错误页。
  if (image.length < 8 || image[0] !== 0x89 || image[1] !== 0x50 || image[2] !== 0x4e || image[3] !== 0x47) {
    throw new Error('QQ 二维码获取失败：返回内容不是图片')
  }
  const qrsig = jar.get(QR_SHOW_API, 'qrsig') || readSetCookies(showResp.headers).qrsig || ''
  if (!qrsig) throw new Error('QQ 二维码获取失败：没有拿到 qrsig')

  return {
    state: { jar, qrsig, loginSig: jar.get(LOGIN_PAGE_API, 'pt_login_sig') || '' },
    image: pngDataUrl(image),
    hint: '打开手机 QQ → 右上角「+」→ 扫一扫',
  }
}

export async function checkQQ(state: any): Promise<QrCheckResult> {
  const jar: CookieJar = state?.jar
  const qrsig = String(state?.qrsig || '')
  if (!jar || !qrsig) return { status: 'failed', message: '登录会话已失效，请刷新二维码' }
  const loginSig = String(state?.loginSig || '')

  const params = new URLSearchParams({
    u1: OAUTH_JUMP,
    ptqrtoken: String(hash33(qrsig)),
    ptredirect: '0',
    h: '1',
    t: '1',
    g: '1',
    from_ui: '1',
    ptlang: '2052',
    action: `0-0-${Date.now()}`,
    js_ver: '26071711',
    js_type: '1',
    login_sig: loginSig,
    pt_uistyle: '40',
    aid: '716027609',
    daid: '383',
    pt_3rd_aid: CLIENT_ID,
    pt_js_version: 'c1987b96',
  })
  const resp = await jarRequest(jar, `${QR_CHECK_API}?${params.toString()}`, {
    referer: 'https://xui.ptlogin2.qq.com/',
  })
  const { code, message, redirect } = parsePtuiCB(String(resp.body ?? ''))

  // 0 成功 / 65 过期 / 66 未扫 / 67 已扫待确认
  if (code === '66') return { status: 'waiting', message: '等待扫码' }
  if (code === '67') return { status: 'scanned', message: '已扫码，请在手机上确认登录' }
  if (code === '65') return { status: 'expired', message: '二维码已过期，请刷新' }
  if (code !== '0') return { status: 'failed', message: message || '登录失败，请刷新二维码重试' }
  if (!redirect) return { status: 'failed', message: 'QQ 未返回跳转地址，请重试' }

  return completeQQLogin(jar, redirect)
}

/** 扫码确认后：跳转链 → p_skey → OAuth code → musickey */
async function completeQQLogin(jar: CookieJar, redirectUrl: string): Promise<QrCheckResult> {
  const loginUrl = await followRedirects(jar, redirectUrl, 'https://xui.ptlogin2.qq.com/')
  const pSkey = jar.get(loginUrl, 'p_skey') || jar.get(OAUTH_JUMP, 'p_skey') || jar.get('https://graph.qq.com/', 'p_skey')
  if (!pSkey) {
    return { status: 'failed', message: 'QQ 登录失败：没有拿到 p_skey（多为跳转链被中断，请重试）' }
  }

  const redirectUri = `https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=${encodeURIComponent('https://y.qq.com/')}`
  const form = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state: 'state',
    switch: '',
    from_ptlogin: '1',
    src: '1',
    update_auth: '1',
    openapi: '1010_1030',
    g_tk: String(gtk33(pSkey)),
    auth_time: String(Date.now()),
    ui: uuid(),
  })

  const authorizeResp = await jarRequest(jar, OAUTH_AUTHORIZE, {
    method: 'post',
    body: form.toString(),
    referer: OAUTH_JUMP,
    contentType: 'application/x-www-form-urlencoded',
  })
  let finalUrl = OAUTH_AUTHORIZE
  const location = String(authorizeResp.headers?.location || '').trim()
  if (location) finalUrl = await followRedirects(jar, resolveUrl(OAUTH_AUTHORIZE, location), OAUTH_AUTHORIZE)
  const code = queryValue(finalUrl, 'code')
  if (!code) return { status: 'failed', message: 'QQ 授权失败：没有拿到 code，请重试' }

  const payload = {
    comm: { g_tk: 5381, platform: 'yqq', ct: 24, cv: 0 },
    req: { module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code } },
  }
  const musicResp = await jarRequest(jar, MUSIC_LOGIN_API, {
    method: 'post',
    body: JSON.stringify(payload),
    referer: 'https://y.qq.com/',
    contentType: 'application/json',
  })
  const parsed: any = musicResp.body || {}
  if (Number(parsed.code ?? 0) !== 0 || Number(parsed?.req?.code ?? 0) !== 0) {
    const msg = parsed?.req?.message || parsed?.req?.msg || parsed?.message || parsed?.msg || '未知错误'
    return { status: 'failed', message: `QQ 音乐登录接口报错：${msg}` }
  }

  const finalCookies: Record<string, string> = { ...jar.toMap(), ...readSetCookies(musicResp.headers) }
  Object.assign(finalCookies, cookiesFromLoginData(parsed?.req?.data))
  const merged = normalize(finalCookies)
  if (!merged.qm_keyst) return { status: 'failed', message: 'QQ 登录成功但没有拿到 qm_keyst，请重试' }
  return { status: 'success', message: '登录成功', cookie: cookieString(merged) }
}

// ============================ 微信扫码 ============================

function parseWxUuid(html: string): string {
  const patterns = [
    /connect\/l\/qrconnect\?uuid=([A-Za-z0-9_-]+)/,
    /window\.QRLogin\.uuid\s*=\s*"([^"]+)"/,
    /\/connect\/qrcode\/([A-Za-z0-9_-]+)/,
  ]
  for (const re of patterns) {
    const m = String(html || '').match(re)
    if (m && m[1]) return m[1]
  }
  return ''
}

export async function createWx(): Promise<QrCreateResult> {
  const state = `lxmusic-${Date.now()}`
  const params = new URLSearchParams({
    appid: WX_APPID,
    redirect_uri: WX_REDIRECT_URI,
    response_type: 'code',
    scope: 'snsapi_login',
    state,
    href: 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect',
  })
  const loginUrl = `${WX_QR_CONNECT}?${params.toString()}`
  const resp = await request<any>(loginUrl, {
    headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' },
    timeout: 12000,
  })
  const wxUuid = parseWxUuid(String(resp.body ?? ''))
  if (!wxUuid) throw new Error('微信二维码获取失败：页面里没有 uuid')

  return {
    state: { uuid: wxUuid, state },
    // 微信官方二维码图片，这里在后端直接抓成 data URL，避免浏览器跨域/被墙
    image: await fetchWxQrImage(wxUuid),
    hint: '打开微信 → 扫一扫',
  }
}

async function fetchWxQrImage(wxUuid: string): Promise<string> {
  const url = `https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(wxUuid)}`
  try {
    const resp = await request<any>(url, {
      headers: { 'User-Agent': UA, Referer: WX_QR_CONNECT },
      timeout: 12000,
    })
    const mime = String(resp.headers?.['content-type'] || '').split(';')[0].trim()
    // 微信这张图是 JPEG（不是 PNG），所以按 content-type 判断而不是看文件头
    if (Buffer.isBuffer(resp.body) && resp.body.length > 1000 && mime.startsWith('image/')) {
      return `data:${mime};base64,${resp.body.toString('base64')}`
    }
  } catch { /* 抓不到就走前端直链 */ }
  return url
}

export async function checkWx(state: any): Promise<QrCheckResult> {
  const wxUuid = String(state?.uuid || '')
  if (!wxUuid) return { status: 'failed', message: '登录会话已失效，请刷新二维码' }

  const resp = await request<any>(`${WX_QR_CHECK}?uuid=${encodeURIComponent(wxUuid)}&_=${Date.now()}`, {
    headers: { 'User-Agent': UA, Referer: WX_QR_CONNECT },
    timeout: 12000,
  })
  const raw = String(resp.body ?? '')
  const codeMatch = raw.match(/wx_errcode\s*=\s*'?([0-9]+)'?/)
  const code = codeMatch ? codeMatch[1] : ''
  const cdMatch = raw.match(/wx_code\s*=\s*["']([^"']*)["']/)
  const wxCode = cdMatch ? cdMatch[1] : ''

  // 408 等待 / 404 已扫待确认 / 402 过期 / 405 成功
  if (code === '408') return { status: 'waiting', message: '等待扫码' }
  if (code === '404') return { status: 'scanned', message: '已扫码，请在微信中确认登录' }
  if (code === '402') return { status: 'expired', message: '二维码已过期，请刷新' }
  if (code !== '405') return { status: 'failed', message: raw.trim() || `微信返回异常状态（${code || '-'}）` }
  if (!wxCode) return { status: 'failed', message: '微信授权成功但没有拿到 code，请重试' }

  const payload = {
    comm: { tmeAppID: 'qqmusic', tmeLoginType: '1', g_tk: 5381, platform: 'yqq', ct: 24, cv: 0 },
    req: { module: 'music.login.LoginServer', method: 'Login', param: { strAppid: WX_APPID, code: wxCode } },
  }

  let lastError = ''
  for (const apiUrl of MUSIC_LOGIN_APIS) {
    try {
      const r = await request<any>(apiUrl, {
        method: 'post',
        body: JSON.stringify(payload),
        headers: {
          'User-Agent': UA,
          Referer: WX_REDIRECT_URI,
          Origin: 'https://y.qq.com',
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: 'login_type=2',
        },
        timeout: 15000,
      })
      const parsed: any = r.body || {}
      if (Number(parsed.code ?? 0) !== 0 || Number(parsed?.req?.code ?? 0) !== 0) {
        lastError = parsed?.req?.message || parsed?.req?.msg || parsed?.message || parsed?.msg || '未知错误'
        continue
      }
      const finalCookies: Record<string, string> = {}
      Object.assign(finalCookies, cookiesFromLoginData(parsed?.req?.data))
      Object.assign(finalCookies, readSetCookies(r.headers))
      const merged = normalize(finalCookies)
      if (!merged.qm_keyst) { lastError = '没有拿到 musickey'; continue }
      return { status: 'success', message: '登录成功', cookie: cookieString(merged) }
    } catch (e: any) {
      lastError = e?.message || String(e)
    }
  }
  return { status: 'failed', message: `微信登录兑换失败：${lastError || '未知错误'}` }
}

export const qqDriver: QrDriver = {
  ttlSec: TTL_SEC,
  pollIntervalMs: POLL_INTERVAL_MS,
  create: createQQ,
  check: checkQQ,
}

export const wxDriver: QrDriver = {
  ttlSec: TTL_SEC,
  pollIntervalMs: 2000,
  create: createWx,
  check: checkWx,
}
