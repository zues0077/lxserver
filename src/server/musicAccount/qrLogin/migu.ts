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
 *        → 未扫码 { status: 4074 }、超时 { status: 4072 }
 *        → 手机确认后 { status: 2000, message: '登陆成功',
 *                       result: { redirectURL: 'https://passport.migu.cn/portal/sso/authn',
 *                                 token: '<票据>' } }
 *
 * **2000 不是「待确认」，是「已确认 + 发了票据」**（2026-10-29 真机实测）。
 * 票据要拿去 authn 换最终 Cookie（pacmtoken）；换的姿势没有文档，所以这里
 * 一次把几种常见组合都试一遍，哪个拿到登录态 Cookie 就用哪个，并把每一步的结果
 * 打进日志，方便按真实响应收敛到唯一解。
 *
 * 二维码实测有效期约 115 秒（不是页面倒计时的 180），超时就返 4072。
 */

import { request, parseCookie } from '../http'
import { readSetCookies, joinCookies } from './util'
import type { QrCreateResult, QrCheckResult } from './types'

const LOGIN_API = 'https://passport.migu.cn/api/qrcWeb/qrcLogin'
const QUERY_API = 'https://passport.migu.cn/api/qrcWeb/qrcquery'
const AUTHN_API = 'https://passport.migu.cn/portal/sso/authn'
/** 100001 = 咪咕音乐网页版（登录页 qrcLogin 的 sourceID） */
const SOURCE_ID = '100001'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE_HEADERS = {
  'User-Agent': UA,
  Referer: `https://passport.migu.cn/login?sourceid=${SOURCE_ID}`,
}

/** 通行证没有公开的二维码有效期，实测（2026-10-29）约 115 秒就返 4072，取 110 留余量 */
export const TTL_SEC = 110
export const POLL_INTERVAL_MS = 2000

/** 真正代表「登录态」的字段：有任意一个就认为拿到了可用于取链的 Cookie */
const LOGIN_COOKIE_HINT = /pacmtoken|migu-utoken|idmpauth|LTToken|userid/i
/** authn 失败页，302 到这儿说明这次换票组合不对 */
const AUTHN_FAIL = /authn_fail/i

/**
 * 用扫码票据换最终 Cookie
 *
 * 票据（SAML 断言 / 通行证加密串）拿到后要交给 authn 才能落地成 pacmtoken。
 * 没有文档，也没法靠假票据试探（假票据无论参数名对错都 302 到 authn_fail），
 * 所以这里按常见组合依次试，命中就停：任何一步的 Set-Cookie 里出现登录态字段即成功。
 * 每步结果拼进 debug，日志里能看出哪条路真的通了 —— 后续可以据此砍掉多余分支。
 */
async function exchangeToken(token: string, redirectURL: string): Promise<{ cookie: string, debug: string }> {
  const base = redirectURL || AUTHN_API
  const enc = encodeURIComponent(token)
  const attempts: Array<{ name: string, run: () => Promise<any> }> = [
    { name: 'GET?token', run: () => request(`${base}${base.includes('?') ? '&' : '?'}token=${enc}`, { headers: BASE_HEADERS, timeout: 12000, followMax: 0 }) },
    { name: 'GET?SAMLResponse', run: () => request(`${base}${base.includes('?') ? '&' : '?'}SAMLResponse=${enc}`, { headers: BASE_HEADERS, timeout: 12000, followMax: 0 }) },
    { name: 'GET?SAMLResponse+RelayState', run: () => request(`${base}${base.includes('?') ? '&' : '?'}SAMLResponse=${enc}&RelayState=`, { headers: BASE_HEADERS, timeout: 12000, followMax: 0 }) },
    { name: 'GET?callbackURL+SAMLResponse', run: () => request(`${base}${base.includes('?') ? '&' : '?'}callbackURL=${encodeURIComponent('https://music.migu.cn/')}&SAMLResponse=${enc}`, { headers: BASE_HEADERS, timeout: 12000, followMax: 0 }) },
    { name: 'POST-token', run: () => request(base, { method: 'post', headers: BASE_HEADERS, form: `token=${enc}`, timeout: 12000, followMax: 0 }) },
    { name: 'POST-SAMLResponse', run: () => request(base, { method: 'post', headers: BASE_HEADERS, form: `SAMLResponse=${enc}`, timeout: 12000, followMax: 0 }) },
    { name: 'POST-SAMLResponse+RelayState', run: () => request(base, { method: 'post', headers: BASE_HEADERS, form: `SAMLResponse=${enc}&RelayState=`, timeout: 12000, followMax: 0 }) },
  ]

  const jar: Record<string, string> = {}
  const notes: string[] = []
  for (const a of attempts) {
    try {
      const resp = await a.run()
      const sc = readSetCookies(resp.headers)
      Object.assign(jar, sc)
      const loc = String(resp.headers?.location || '')
      notes.push(`${a.name}→${resp.statusCode}${loc ? ` loc=${loc.slice(0, 100)}` : ''}${Object.keys(sc).length ? ` cookie=${Object.keys(sc).join(',')}` : ''}`)
      if (LOGIN_COOKIE_HINT.test(joinCookies(jar))) return { cookie: joinCookies(jar), debug: notes.join(' | ') }

      // 302 到非失败页：跟一次，Cookie 通常落在跳转后的响应上
      if (resp.statusCode >= 300 && resp.statusCode < 400 && loc && !AUTHN_FAIL.test(loc)) {
        const follow = await request(loc, { headers: BASE_HEADERS, timeout: 12000, followMax: 3 })
        const sc2 = readSetCookies(follow.headers)
        Object.assign(jar, sc2)
        notes.push(`  ↳follow→${follow.statusCode}${Object.keys(sc2).length ? ` cookie=${Object.keys(sc2).join(',')}` : ''}`)
        if (LOGIN_COOKIE_HINT.test(joinCookies(jar))) return { cookie: joinCookies(jar), debug: notes.join(' | ') }
      }
    } catch (e: any) {
      notes.push(`${a.name} ERR ${e?.message || String(e)}`)
    }
  }
  return { cookie: '', debug: notes.join(' | ') }
}

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

  // 2000 = 手机已确认 + 发了票据，还差最后一步换 Cookie
  if (st === 2000) {
    const token = String(result.token || '').trim()
    const redirect = String(result.redirectURL || '').trim() || AUTHN_API
    // 响应头里的 Cookie 也先收着，有的平台会顺手塞登录态
    const headerCookie = joinCookies(readSetCookies(resp.headers))
    if (LOGIN_COOKIE_HINT.test(headerCookie)) {
      return { status: 'success', message: '登录成功', cookie: headerCookie }
    }
    if (!token) {
      return { status: 'failed', message: `咪咕已确认登录但未返回票据（${body.message || '无 message'}）` }
    }

    // 换票要连发 7 个请求，别每次轮询都重试，6 秒一次足够
    const now = Date.now()
    const wait = Number(state.lastExchangeAt || 0)
    if (!state.exchangedOk && (!wait || now - wait > 6000)) {
      state.lastExchangeAt = now
      if (state.last !== st) {
        state.last = st
        console.log(`[平台账号] 咪咕扫码已确认（${body.message || '登陆成功'}），票据长度 ${token.length}，开始换取登录态`)
        console.log(`[平台账号] 咪咕票据原文：${token}`)
      }
      const ex = await exchangeToken(token, redirect)
      if (ex.cookie) {
        state.exchangedOk = true
        console.log(`[平台账号] 咪咕票据换取成功，Cookie 字段：${Object.keys(parseCookie(ex.cookie)).join(', ')}`)
        return { status: 'success', message: '登录成功', cookie: ex.cookie }
      }
      console.log(`[平台账号] 咪咕票据换取未命中：${ex.debug}`)
      state.exchangeDebug = ex.debug
    }

    return { status: 'scanned', message: '手机上已确认，正在换取登录态…' }
  }
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
