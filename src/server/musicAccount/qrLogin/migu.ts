/**
 * 咪咕音乐 —— 扫码登录（实验）
 *
 * 网页版登录弹窗只给了「短信 / 密码 / SIM」，没有扫码 tab，但登录页 DOM 里
 * 留着完整的扫码区块（`.qr-code-container` + `cmcc-qrcajax`），说明通行证这套接口是活的：
 *
 *   1. GET https://passport.migu.cn/api/qrcWeb/qrcLogin?sourceid=100001
 *        → { status: 2000, result: { qrcUrl: 'data:image/jpeg;base64,...', qrc_sessionid: '<32 hex>' } }
 *      （参数名必须是小写 sourceid，写成 sourceID 会返回「必选字段sourceid为空」）
 *   2. GET https://passport.migu.cn/api/qrcWeb/qrcquery?sourceid=100001&qrc_sessionid=<sid>
 *        → 未扫码 { status: 4074, message: '未扫码' }、超时 { status: 4072, message: '二维码超时' }
 *
 * 缺口：扫码确认之后 qrcquery 返回什么、怎么换成 pacmtoken，没有官方文档，
 * 只能真扫一次才知道。所以这里的做法是「能拿到 Cookie 就当成功，拿不到就把原始响应
 * 记进日志」—— 状态一变就打一条，方便按真实响应补齐最后一段，而不是靠猜。
 */

import { request } from '../http'
import { readSetCookies, joinCookies } from './util'
import type { QrCreateResult, QrCheckResult } from './types'

const LOGIN_API = 'https://passport.migu.cn/api/qrcWeb/qrcLogin'
const QUERY_API = 'https://passport.migu.cn/api/qrcWeb/qrcquery'
/** 100001 = 咪咕音乐网页版（登录页 qrcLogin 的 sourceID） */
const SOURCE_ID = '100001'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE_HEADERS = {
  'User-Agent': UA,
  Referer: `https://passport.migu.cn/login?sourceid=${SOURCE_ID}`,
}

/** 通行证没有公开的二维码有效期，按页面的倒计时保守取 180 秒 */
export const TTL_SEC = 180
export const POLL_INTERVAL_MS = 2000

/** 真正代表「登录态」的字段：有任意一个就认为拿到了可用于取链的 Cookie */
const LOGIN_COOKIE_HINT = /pacmtoken|migu-utoken|idmpauth|LTToken|userid/i

export async function create(): Promise<QrCreateResult> {
  const resp = await request<any>(`${LOGIN_API}?sourceid=${SOURCE_ID}`, {
    headers: BASE_HEADERS,
    timeout: 15000,
  })
  const body: any = resp.body || {}
  const result: any = body.result || {}
  const image = String(result.qrcUrl || '').trim()
  const sid = String(result.qrc_sessionid || '').trim()
  if (Number(body.status) !== 2000 || !image || !sid) {
    throw new Error(`咪咕二维码获取失败（status=${body.status ?? '-'}，${body.message || '无返回'}）`)
  }
  return {
    state: { sid, last: 0 },
    // 通行证直接给的就是 jpeg data URL，不用自己画
    image,
    hint: '打开咪咕音乐 App → 我的 → 右上角「扫一扫」',
  }
}

export async function check(state: any): Promise<QrCheckResult> {
  const sid = String(state?.sid || '')
  if (!sid) return { status: 'failed', message: '登录会话已失效，请刷新二维码' }

  const resp = await request<any>(`${QUERY_API}?sourceid=${SOURCE_ID}&qrc_sessionid=${encodeURIComponent(sid)}`, {
    headers: BASE_HEADERS,
    timeout: 12000,
  })
  const body: any = resp.body || {}
  const st = Number(body.status)
  const result: any = body.result || {}

  if (st === 4074) return { status: 'waiting', message: '等待扫码' }
  if (st === 4072) return { status: 'expired', message: '二维码已过期，请刷新' }

  // 走到这里说明状态变了（已扫码 / 确认 / 未知码）。Cookie 可能在响应头，也可能在 body 里。
  const fromHeader = readSetCookies(resp.headers)
  const cookie = joinCookies(fromHeader)
  const bodyCookie = String(result.cookie || body.cookie || '').trim()
  const finalCookie = LOGIN_COOKIE_HINT.test(bodyCookie) ? bodyCookie : cookie

  if (LOGIN_COOKIE_HINT.test(finalCookie)) {
    return { status: 'success', message: '登录成功', cookie: finalCookie }
  }

  // 状态变了但还没拿到 Cookie：把原始响应记一次日志（同一状态只打一遍，别每 2 秒刷屏）
  if (state.last !== st) {
    state.last = st
    let raw = ''
    try { raw = JSON.stringify(body).slice(0, 400) } catch { raw = String(body).slice(0, 400) }
    console.log(`[平台账号] 咪咕扫码状态 ${st}（${body.message || '无 message'}），原始响应：${raw}`)
    const setCookieNames = Object.keys(fromHeader)
    if (setCookieNames.length) console.log(`[平台账号] 咪咕扫码响应头 Cookie 字段：${setCookieNames.join(', ')}`)
  }

  // 已扫码但还没确认，或者返回了没见过的结构 —— 都继续轮询，别把用户挡在错误页上
  return { status: 'scanned', message: `已扫码，请在手机上确认登录（状态 ${Number.isFinite(st) ? st : '-'}）` }
}
