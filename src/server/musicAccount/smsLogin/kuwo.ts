/**
 * 酷我音乐 —— 手机验证码登录（网页侧真实接口，2026-10-29 从 kuwo.cn 前端代码逆向 + 本机实跑确认）
 *
 * 为什么走短信而不是扫码：酷我网页（kuwo.cn）登录页只有 微信/QQ/微博/手机验证码/账号密码，
 * 没有「扫酷我 App」的二维码——那个二维码只活在 Windows/Mac 桌面客户端里（需代理客户端流量才能拿端点）。
 * 所以酷我走手机号 + 图形验证码 + 短信验证码登录，端点全部在 wapi.kuwo.cn，无需抓包。
 *
 * 链路（域名 https://wapi.kuwo.cn）：
 *   1. GET  /api/common/captcha/getcode
 *        → data.img（base64 PNG 图形码）+ data.token（图形码 token，后面发短信要用）
 *   2. POST /api/sms/mobileLoginCode  { verifyCode, verifyCodeToken, mobile, userIp }
 *        → data.tm（登录要的时间戳）
 *   3. POST /api/www/login/loginByMobile  { mobile, verifyCode, smsCode, tm }
 *        → data.cookies（登录态 Cookie 映射，含 kw_token / userid / websid 等）
 *
 * 浏览器实跑时这些请求会带 Set-Cookie，这里把每一步的 cookie 串起来透传，尽量贴近真实客户端。
 */

import { request } from '../http'

const WAPI = 'https://wapi.kuwo.cn'
const WWW = 'https://www.kuwo.cn'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TIMEOUT = 12000

const JSON_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Origin: WWW,
  Referer: `${WWW}/`,
}

/** 把响应里的 Set-Cookie 收进 jar（值非空才收） */
function absorbCookies(jar: Record<string, string>, headers: Record<string, any>): void {
  const raw = headers['set-cookie'] ?? headers['Set-Cookie']
  const list: string[] = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []
  for (const line of list) {
    const first = String(line).split(';')[0]
    const idx = first.indexOf('=')
    if (idx <= 0) continue
    const k = first.slice(0, idx).trim()
    const v = first.slice(idx + 1).trim()
    if (k && v) jar[k] = v
  }
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .filter(([, v]) => String(v).length > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/** 酷我短信登录会话：图形码 token 与后续步骤的 cookie 都要跨请求复用 */
export interface KuwoSmsSession {
  captchaToken: string
  verifyCode: string
  tm: string
  jar: Record<string, string>
}

export interface KuwoCaptchaResult {
  ok: boolean
  image?: string
  token?: string
  /** 收拢的 cookie，发短信 / 登录时一起带回去 */
  jar?: Record<string, string>
  message: string
}

/** 第一步：拿图形验证码（base64 PNG 图 + token） */
export async function getCaptcha(): Promise<KuwoCaptchaResult> {
  const jar: Record<string, string> = {}
  try {
    const res = await request<any>(`${WAPI}/api/common/captcha/getcode`, {
      method: 'get',
      headers: JSON_HEADERS,
      timeout: TIMEOUT,
      followMax: 0,
    })
    absorbCookies(jar, res.headers)
    const body = res.body || {}
    if (Number(body.code) !== 200 || !body.data?.img || !body.data?.token) {
      return { ok: false, message: '酷我图形验证码获取失败，请重试' }
    }
    return {
      ok: true,
      image: String(body.data.img),
      token: String(body.data.token),
      jar,
      message: '请填图形验证码，然后点「发送验证码」',
    }
  } catch (e: any) {
    return { ok: false, message: `酷我验证码接口连接失败：${e?.message || e}` }
  }
}

export interface KuwoSendResult {
  ok: boolean
  tm?: string
  message: string
}

/** 第二步：校验图形码 + 下发短信，成功回 tm */
export async function sendSmsCode(
  session: KuwoSmsSession,
  mobile: string,
  userIp = '127.0.0.1',
): Promise<KuwoSendResult> {
  const code = String(session.verifyCode || '').trim()
  if (!code) return { ok: false, message: '请先填图形验证码' }
  try {
    const res = await request<any>(`${WAPI}/api/sms/mobileLoginCode`, {
      method: 'post',
      json: {
        verifyCode: code,
        verifyCodeToken: session.captchaToken,
        mobile,
        userIp,
      },
      headers: { ...JSON_HEADERS, Cookie: cookieHeader(session.jar) },
      timeout: TIMEOUT,
      followMax: 0,
    })
    absorbCookies(session.jar, res.headers)
    const body = res.body || {}
    if (Number(body.code) !== 200 || !body.data?.tm) {
      const msg =
        Number(body.code) === -102
          ? '图形验证码错误，请重新获取一张'
          : String(body.msg || '短信验证码发送失败')
      return { ok: false, message: msg }
    }
    session.tm = String(body.data.tm)
    return { ok: true, tm: session.tm, message: '验证码已发送，请查看手机短信' }
  } catch (e: any) {
    return { ok: false, message: `酷我短信接口连接失败：${e?.message || e}` }
  }
}

export interface KuwoLoginResult {
  ok: boolean
  cookie?: string
  message: string
}

/** 第三步：短信验证码登录，成功回登录态 Cookie 串 */
export async function loginBySmsCode(
  session: KuwoSmsSession,
  mobile: string,
  smsCode: string,
): Promise<KuwoLoginResult> {
  try {
    const res = await request<any>(`${WAPI}/api/www/login/loginByMobile`, {
      method: 'post',
      json: {
        mobile,
        verifyCode: session.verifyCode,
        smsCode: String(smsCode || ''),
        tm: session.tm,
      },
      headers: { ...JSON_HEADERS, Cookie: cookieHeader(session.jar) },
      timeout: TIMEOUT,
      followMax: 0,
    })
    absorbCookies(session.jar, res.headers)
    const body = res.body || {}
    if (Number(body.code) !== 200 || !body.data?.cookies) {
      const map: Record<number, string> = {
        1108: '短信验证码不正确，请重新输入',
        1107: '短信验证码已过期，请重新输入',
        1100: '请输入符合中国大陆的手机号',
      }
      return { ok: false, message: map[Number(body.code)] || String(body.msg || '酷我登录失败') }
    }
    const cookies = body.data.cookies as Record<string, string>
    const cookie = Object.entries(cookies)
      .filter(([, v]) => String(v).length > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
    if (!cookie) return { ok: false, message: '酷我没有返回登录凭据' }
    return { ok: true, cookie, message: '登录成功' }
  } catch (e: any) {
    return { ok: false, message: `酷我登录接口连接失败：${e?.message || e}` }
  }
}
