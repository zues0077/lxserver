/**
 * 咪咕音乐 —— 手机验证码登录（通行证 / passport）
 *
 * 为什么不做扫码：咪咕音乐 App 的「扫一扫」只认 TV 端码，扫通行证的网页码一律弹
 * 「TV扫码登录失败请重试」，且 qrcquery 全程停在 4074（App 本地就拒了，零上报）。
 * 三个渠道 sourceid（100001 / 220001 / 220029）实测都一样，qrcWebtype 固定 "1"。
 *
 * 走通行证的手机验证码登录则完全可行，链路（字段取自 MOPELotus/TuneWeave 的
 * crates/tuneweave-provider-migu，2026-10 仍在维护，比自摸靠得住）：
 *
 *   1. POST /password/publickey                      （form 空体！GET 会 302 到 /portal/error）
 *        → result.modulus / result.publicExponent（十六进制字符串，1024 位）
 *        同时 Set-Cookie 一串 mgnd_session_*，后面所有请求都要带
 *   2. POST /captcha/graph/risk?imgcodeType=2&showType=0&sourceid=220029
 *        → result.graphtype（"0" 算术题 / "1" 中文）+ result.captchaurl（内联 jpeg data URL）
 *   3. POST /captcha/graph/check  form: isAsync=true&captcha=<答案>&imgcodeType=2&sourceid=220029
 *   4. GET  /login/dynamicpassword?msisdn=<RSA(手机号)>&sourceID=220029&isAsync=true
 *            &captcha=<答案>&imgcodeType=2&fingerPrint=&fingerPrintDetail=     ← 发短信
 *   5. POST /authn/dynamicpassword  form: msisdn / dynamicPassword（都 RSA）
 *            + imgcodeType=2 / sourceID=220029 / appType=0 / relayState / securityCode
 *            / captcha / isAsync=true / fingerPrint / fingerPrintDetail        ← 校验，返回 result.token
 *   6. GET  https://c.musicapp.migu.cn/user/h5/token-validate/v3.0
 *            ?token=<token>&type=2&sourceId=220029&activityId=MUSIC-WWW
 *            带 deviceId（大写 UUID v4）→ 响应头 pacmtoken 或 Set-Cookie 里就是最终凭据
 *
 * 加密方式：标准 RSA PKCS#1 v1.5（块首 00 02，随机非零填充），明文按 UTF-8。
 * 官方 JS 是「逐 UTF-16 code unit 编 UTF-8」，BMP 字符与标准 UTF-8 完全一致，
 * 手机号 / 验证码 / 图形码全是 ASCII，所以这里直接用 utf8。
 */
import crypto from 'crypto'
import { request } from '../http'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const PASSPORT = 'https://passport.migu.cn'
const MUSIC_HOST = 'https://c.musicapp.migu.cn'
/** 220029 = 咪咕音乐 App 渠道（通行证网页版是 100001，那套在 App 侧会被判成 TV 码） */
const SOURCE_ID = '220029'
const TIMEOUT = 12000

const FORM_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json',
  Origin: PASSPORT,
  Referer: `${PASSPORT}/login?sourceid=${SOURCE_ID}&appType=0`,
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
}

/** 通行证会话：公钥 + cookie jar 都必须跨步骤复用，换一次就对不上 */
export interface MiguPassportSession {
  jar: Record<string, string>
  modulus: string
  exponent: string
  /** 图形码答案，发短信和校验短信都要带同一个 */
  captchaAnswer: string
  deviceId: string
}

export interface MiguCaptchaResult {
  ok: boolean
  image?: string
  graphtype?: string
  session?: MiguPassportSession
  message: string
}

function absorbCookies(jar: Record<string, string>, headers: Record<string, any>): void {
  const raw = headers['set-cookie'] ?? headers['Set-Cookie']
  const list: string[] = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []
  for (const line of list) {
    const first = String(line).split(';')[0]
    const idx = first.indexOf('=')
    if (idx <= 0) continue
    const k = first.slice(0, idx).trim()
    const v = first.slice(idx + 1).trim()
    if (k) jar[k] = v
  }
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .filter(([, v]) => String(v).length > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/** 大整数的 hex → base64url，给 JWK 用 */
function bigHexToB64Url(hex: string): string {
  let h = String(hex || '').replace(/^0+/, '')
  if (!h) h = '0'
  if (h.length % 2) h = `0${h}`
  return Buffer.from(h, 'hex').toString('base64url')
}

/**
 * RSA 加密，输出十六进制。
 * 官方 JS 的做法是「去掉前导零字节，再补成偶数长度的 hex」，这里照抄 ——
 * 少这一步服务端按定长解析会多出一截 00。
 */
function encrypt(session: Pick<MiguPassportSession, 'modulus' | 'exponent'>, text: string): string {
  const key = crypto.createPublicKey({
    key: { kty: 'RSA', n: bigHexToB64Url(session.modulus), e: bigHexToB64Url(session.exponent) },
    format: 'jwk',
  })
  const encrypted = crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(String(text), 'utf8'),
  )
  let hex = encrypted.toString('hex').replace(/^0+/, '')
  if (!hex) hex = '0'
  if (hex.length % 2) hex = `0${hex}`
  return hex
}

function statusOf(body: any): number {
  const n = Number(body?.status)
  return Number.isFinite(n) ? n : 0
}

/** 通行证状态码 → 人话 */
function explain(code: number, fallback: string): string {
  switch (code) {
    case 4002:
    case 4044:
    case 4045:
    case 6103:
    case 6119:
    case 6118:
    case 6123:
    case 4049:
      return '图形验证码不正确，请重新获取一张再填'
    case 4005:
      return '短信验证码不正确或已过期'
    case 4016:
      return '请求过于频繁，咪咕已经限流，请过几分钟再试'
    case 4074:
      return '咪咕没有受理这次请求，请重新获取图形验证码'
    default:
      return `${fallback}（咪咕返回 ${code || '无状态码'}）`
  }
}

/** 第一步：拿公钥 + 图形验证码，两者共用同一个 cookie jar */
export async function createSmsCaptcha(): Promise<MiguCaptchaResult> {
  const jar: Record<string, string> = {}
  try {
    const keyRes = await request<any>(`${PASSPORT}/password/publickey`, {
      method: 'post',
      form: '',
      headers: FORM_HEADERS,
      timeout: TIMEOUT,
      followMax: 0,
    })
    absorbCookies(jar, keyRes.headers)
    const modulus = String(keyRes.body?.result?.modulus || '')
    const exponent = String(keyRes.body?.result?.publicExponent || '')
    if (statusOf(keyRes.body) !== 2000 || !modulus || !exponent) {
      return { ok: false, message: explain(statusOf(keyRes.body), '咪咕公钥获取失败') }
    }

    const imgRes = await request<any>(
      `${PASSPORT}/captcha/graph/risk?imgcodeType=2&showType=0&sourceid=${SOURCE_ID}`,
      {
        method: 'post',
        headers: { ...FORM_HEADERS, Cookie: cookieHeader(jar) },
        timeout: TIMEOUT,
        followMax: 0,
      },
    )
    absorbCookies(jar, imgRes.headers)
    const result = imgRes.body?.result || {}
    const image = String(result.captchaurl || '')
    if (statusOf(imgRes.body) !== 2000 || !image.startsWith('data:image/')) {
      return { ok: false, message: explain(statusOf(imgRes.body), '咪咕图形验证码获取失败') }
    }

    return {
      ok: true,
      image,
      graphtype: String(result.graphtype ?? '0'),
      session: {
        jar,
        modulus,
        exponent,
        captchaAnswer: '',
        deviceId: crypto.randomUUID().toUpperCase(),
      },
      message: '请填手机号和图形验证码上的答案，然后点「发送验证码」',
    }
  } catch (e: any) {
    return { ok: false, message: `咪咕通行证连接失败：${e?.message || e}` }
  }
}

export interface MiguSendResult {
  ok: boolean
  message: string
}

/** 第二、三步：先校验图形码，再请求下发短信 */
export async function sendSmsCode(
  session: MiguPassportSession,
  mobile: string,
  captchaAnswer: string,
): Promise<MiguSendResult> {
  const answer = String(captchaAnswer || '').trim()
  if (!answer) return { ok: false, message: '请先填图形验证码' }
  const cookie = cookieHeader(session.jar)
  try {
    const checkRes = await request<any>(`${PASSPORT}/captcha/graph/check`, {
      method: 'post',
      form: `isAsync=true&captcha=${encodeURIComponent(answer)}&imgcodeType=2&sourceid=${SOURCE_ID}`,
      headers: { ...FORM_HEADERS, Cookie: cookie },
      timeout: TIMEOUT,
      followMax: 0,
    })
    absorbCookies(session.jar, checkRes.headers)
    if (statusOf(checkRes.body) !== 2000) {
      return { ok: false, message: explain(statusOf(checkRes.body), '图形验证码校验失败') }
    }

    const msisdn = encrypt(session, mobile)
    const url =
      `${PASSPORT}/login/dynamicpassword?msisdn=${msisdn}&sourceID=${SOURCE_ID}&isAsync=true` +
      `&captcha=${encodeURIComponent(answer)}&imgcodeType=2&fingerPrint=&fingerPrintDetail=`
    const res = await request<any>(url, {
      method: 'get',
      headers: { ...FORM_HEADERS, Cookie: cookieHeader(session.jar) },
      timeout: TIMEOUT,
      followMax: 0,
    })
    absorbCookies(session.jar, res.headers)
    if (statusOf(res.body) !== 2000) {
      return { ok: false, message: explain(statusOf(res.body), '短信验证码发送失败') }
    }
    session.captchaAnswer = answer
    return { ok: true, message: '验证码已发送，请查看手机短信' }
  } catch (e: any) {
    return { ok: false, message: `咪咕短信接口连接失败：${e?.message || e}` }
  }
}

export interface MiguLoginResult {
  ok: boolean
  cookie?: string
  uid?: string
  message: string
}

/** 从响应头 / Set-Cookie 里捞 pacmtoken */
function pickPacmtoken(headers: Record<string, any>): string {
  const direct = headers['pacmtoken'] ?? headers['Pacmtoken']
  const directList: string[] = Array.isArray(direct) ? direct.map(String) : direct ? [String(direct)] : []
  for (const v of directList) if (String(v).trim()) return String(v).trim()

  const raw = headers['set-cookie'] ?? headers['Set-Cookie']
  const list: string[] = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []
  for (const line of list) {
    const first = String(line).split(';')[0]
    const idx = first.indexOf('=')
    if (idx <= 0) continue
    if (first.slice(0, idx).trim().toLowerCase() === 'pacmtoken') return first.slice(idx + 1).trim()
  }
  return ''
}

/** 把 token-validate 下发的其它 Cookie（设备 id / 会话 id 之类）一并收进来，值非空才算 */
function pickExtraCookies(headers: Record<string, any>): Record<string, string> {
  const raw = headers['set-cookie'] ?? headers['Set-Cookie']
  const list: string[] = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []
  const keep = /^(cookieId|mgAppH5CookieId|migu-device-uuid|migu-utoken-sessionid|idmpauth|LTToken)$/i
  const out: Record<string, string> = {}
  for (const line of list) {
    const first = String(line).split(';')[0]
    const idx = first.indexOf('=')
    if (idx <= 0) continue
    const k = first.slice(0, idx).trim()
    const v = first.slice(idx + 1).trim()
    if (!v) continue
    if (!keep.test(k)) continue
    if (k.toLowerCase() === 'migu-device-uuid') continue // 用登录时的 deviceId，别被覆盖
    out[k] = v
  }
  return out
}

/**
 * 第四、五步：用 token 去音乐侧换登录态，拿到 pacmtoken。
 * 这一步必须带 deviceId（大写 UUID v4），否则咪咕会当成陌生设备拒绝。
 */
export async function exchangeToken(token: string, deviceId: string): Promise<MiguLoginResult> {
  try {
    const url =
      `${MUSIC_HOST}/user/h5/token-validate/v3.0?token=${encodeURIComponent(token)}` +
      `&type=2&sourceId=${SOURCE_ID}&activityId=MUSIC-WWW`
    const res = await request<any>(url, {
      method: 'get',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Origin: 'https://music.migu.cn',
        Referer: 'https://music.migu.cn/',
        deviceId,
        channel: '014X031',
      },
      timeout: TIMEOUT,
      followMax: 0,
    })
    const body = res.body || {}
    const code = String(body.code ?? '')
    if (code !== '000000') {
      return { ok: false, message: `咪咕登录态换取失败（${code || res.statusCode}）` }
    }
    const pacmtoken = pickPacmtoken(res.headers)
    if (!pacmtoken) {
      return { ok: false, message: '咪咕没有下发 pacmtoken，登录未生效' }
    }
    const uid = String(body?.data?.userId ?? '').trim()

    // 咪咕取链接口除了 pacmtoken 还认「设备 id」（请求头 By）。
    // 浏览器 Cookie 里本来就有 cookieId，所以插件推来的 Cookie 天然带设备；
    // 短信登录这条路拿到的 Set-Cookie 只有 pacmtoken，必须自己把登录用的 deviceId
    // 补进 Cookie，否则 resolvers 的 authHeaders() 取不到 By，
    // 会员档（SQ/ZQ/HQ）会被当成陌生设备软拒（表现为「没有会员」）。
    const extra = pickExtraCookies(res.headers)
    const parts = [`pacmtoken=${pacmtoken}`]
    if (uid) parts.push(`userid=${uid}`)
    parts.push(`migu-device-uuid=${deviceId}`)
    for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${v}`)

    // 记录返回了哪些 cookie 名 + data 里的字段名（值不落日志），
    // 下次再怀疑「登录了但权益没生效」时能直接对照，不用再猜。
    console.log(
      `[平台账号] 咪咕 token-validate 成功：cookies=[${Object.keys(extra).join(',') || '-'}] ` +
        `dataKeys=[${Object.keys(body?.data || {}).join(',') || '-'}] deviceId=${deviceId.slice(0, 8)}…`,
    )

    return { ok: true, cookie: parts.join('; '), uid: uid || undefined, message: '登录成功' }
  } catch (e: any) {
    return { ok: false, message: `咪咕登录态换取连接失败：${e?.message || e}` }
  }
}

/** 第五步：校验短信验证码，成功返回可用于换登录态的 token */
export async function verifySms(
  session: MiguPassportSession,
  mobile: string,
  code: string,
): Promise<{ ok: boolean; token?: string; message: string }> {
  try {
    const form = [
      `msisdn=${encrypt(session, mobile)}`,
      `dynamicPassword=${encrypt(session, code)}`,
      'imgcodeType=2',
      `sourceID=${SOURCE_ID}`,
      'appType=0',
      'relayState=',
      'securityCode=',
      `captcha=${encodeURIComponent(session.captchaAnswer || '')}`,
      'isAsync=true',
      'fingerPrint=',
      'fingerPrintDetail=',
    ].join('&')
    const res = await request<any>(`${PASSPORT}/authn/dynamicpassword`, {
      method: 'post',
      form,
      headers: { ...FORM_HEADERS, Cookie: cookieHeader(session.jar) },
      timeout: TIMEOUT,
      followMax: 0,
    })
    absorbCookies(session.jar, res.headers)
    if (statusOf(res.body) !== 2000) {
      return { ok: false, message: explain(statusOf(res.body), '短信验证码校验失败') }
    }
    const token = String(res.body?.result?.token || '')
    if (!token) return { ok: false, message: '咪咕没有返回登录票据，请重试' }
    return { ok: true, token, message: '验证码正确' }
  } catch (e: any) {
    return { ok: false, message: `咪咕验证接口连接失败：${e?.message || e}` }
  }
}
