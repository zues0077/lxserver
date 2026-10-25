/**
 * 汽水音乐 —— 扫码登录（抖音 App 扫码）
 *
 * 实测（2026-10-25，服务器直连均 200）：
 *   GET  api.qishui.com/passport/web/get_qrcode/   → token + 二维码 base64 + passport_csrf_token(PATH=/)
 *   POST api.qishui.com/passport/web/check_qrconnect/?…  → data.status = new / scanned / confirmed / expired
 *
 * 三个必须知道的限制（都会在界面上如实告知，别让用户以为是网速问题）：
 *   1. 二维码要用**抖音 App**扫，不是汽水 App —— 官方文案就是这么写的（page_title「身份验证」）。
 *   2. 新设备 / 异地登录大概率触发**短信二次验证**（响应 account_flow=verify、error_code=2046，
 *      带 encrypt_uid + verify_params）。那套 send_code / validate_code 流程上游写了 600 多行，
 *      这里不做：直接把用户引导去「粘贴 Cookie」，比给一个永远卡在「已扫码」的假流程诚实。
 *   3. 接口有节流：同一 token 连续请求过快会返回 error_code=7，要冷却 60 秒。
 *      这里在驱动层做最小间隔 + 退避，前端按 2 秒轮询即可。
 */

import { request } from '../http'
import { qrDataUrl, readSetCookies, joinCookies } from './util'
import type { QrCreateResult, QrCheckResult } from './types'

const QR_API = 'https://api.qishui.com/passport/web/get_qrcode/'
const CHECK_API = 'https://api.qishui.com/passport/web/check_qrconnect/'
// 必须用 PC 客户端 UA：用普通浏览器 UA 会走另一套风控
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.1.0 Chrome/136.0.7103.59 Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36'
const BASE_HEADERS = { 'User-Agent': UA, Accept: 'application/json, text/javascript' }

/** 官方二维码 5 分钟有效（expire_time 实测给的就是 300 秒后） */
export const TTL_SEC = 300
export const POLL_INTERVAL_MS = 2500

const MIN_POLL_MS = 2000
const RATE_LIMIT_BACKOFF_MS = 60000

interface SodaState {
  token: string
  did: string
  iid: string
  bizTraceId: string
  cookies: Record<string, string>
  lastPollAt: number
  backoffUntil: number
}

function buildQuery(state: Pick<SodaState, 'did' | 'iid' | 'bizTraceId'>): string {
  return new URLSearchParams({
    passport_jssdk_version: '2.4.13',
    passport_jssdk_type: 'normal',
    is_from_ttaccountsdk: '1',
    aid: '386088',
    language: 'zh',
    is_new_login: '1',
    is_from_iesaccountsaas: '1',
    device_id: state.did,
    install_id: state.iid,
    did: state.did,
    iid: state.iid,
    device_platform: 'PC',
    version_code: '3.3.0',
    biz_trace_id: state.bizTraceId,
    account_sdk_source: 'web',
    p_js_v: '2.4.13',
    p_js_t: 'pro',
    p_zt: '3.3.5',
    p_ver: '1.0.29',
    request_host: 'app%3A%2F%2Fresources',
    p_bd: '1.0.0.41',
  }).toString()
}

export async function create(): Promise<QrCreateResult> {
  const now = Date.now()
  const did = String(now)
  const iid = String(now + 1)
  const bizTraceId = (now ^ 0x5f3759df).toString(16).slice(-8)

  const query = `${buildQuery({ did, iid, bizTraceId })}`
    + '&next=https%3A%2F%2Fapi.qishui.com&need_logo=false&need_short_url=false&is_frontier=true'

  const resp = await request<any>(`${QR_API}?${query}`, { headers: BASE_HEADERS, timeout: 15000 })
  const body: any = resp.body || {}
  const data: any = body.data || {}
  const token = String(data.token || '').trim()
  if (!token) {
    throw new Error(`汽水二维码获取失败（${body.message || '上游未返回 token'}）`)
  }

  // get_qrcode 会下发 passport_csrf_token，check_qrconnect 必须带上，否则一律判失败
  const cookies = readSetCookies(resp.headers)
  const qrRaw = String(data.qrcode || '').trim()
  const image = qrRaw
    ? (qrRaw.startsWith('data:') ? qrRaw : `data:image/png;base64,${qrRaw}`)
    : await qrDataUrl(String(data.qrcode_index_url || '').trim())

  const state: SodaState = { token, did, iid, bizTraceId, cookies, lastPollAt: 0, backoffUntil: 0 }
  return {
    state,
    image,
    hint: '打开抖音 App → 扫一扫（是抖音，不是汽水 App）',
  }
}

export async function check(state: SodaState): Promise<QrCheckResult> {
  const current = state as SodaState
  if (!current?.token) return { status: 'failed', message: '登录会话已失效，请刷新二维码' }

  const now = Date.now()
  if (now < current.backoffUntil) {
    const left = Math.ceil((current.backoffUntil - now) / 1000)
    return { status: 'waiting', message: `汽水接口冷却中，约 ${left} 秒后继续（官方限流，属正常现象）` }
  }
  // 前端定时器偶尔会撞车，最小间隔自己兜一层，避免把 error_code=7 试出来
  if (now - current.lastPollAt < MIN_POLL_MS) {
    return { status: 'waiting', message: '等待扫码' }
  }
  current.lastPollAt = now

  const query = buildQuery(current)
  const form = new URLSearchParams({
    need_logo: 'false',
    need_short_url: 'false',
    is_frontier: 'true',
    token: current.token,
    is_new_login: '1',
    next: 'https://api.qishui.com',
  }).toString()

  const resp = await request<any>(`${CHECK_API}?${query}`, {
    method: 'post',
    form,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(Object.keys(current.cookies).length ? { Cookie: joinCookies(current.cookies) } : {}),
    },
    timeout: 15000,
  })

  const body: any = resp.body || {}
  const data: any = body.data || {}
  const newCookies = readSetCookies(resp.headers)
  current.cookies = { ...current.cookies, ...newCookies }

  // 限流：不是错误，退避后继续，别把用户的二维码判死
  if (Number(data.error_code) === 7) {
    current.backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS
    return { status: 'waiting', message: '汽水接口限流，冷却 60 秒后继续' }
  }

  // 登录成功：Cookie 里出现真实会话
  const cookie = joinCookies(current.cookies)
  if (/(^|;\s*)(sessionid|sessionid_ss|sid_tt|sid_guard)=/.test(cookie)) {
    return { status: 'success', message: '登录成功', cookie }
  }

  // 短信二次验证：如实告知，引导改用粘贴 Cookie
  const accountFlow = String(data.account_flow || '').toLowerCase()
  if (accountFlow === 'verify' || Number(data.error_code) === 2046) {
    return {
      status: 'failed',
      message: '该账号需要短信二次验证（抖音 App 扫码后还要收验证码），本服务未实现这一步。'
        + '请在浏览器登录 www.qishui.com 后，把 api.qishui.com 请求里的 Cookie 粘过来。',
    }
  }

  const status = String(data.status || '').toLowerCase()
  if (status === 'scanned' || status === 'confirmed') {
    return { status: 'scanned', message: status === 'confirmed' ? '已确认，正在下发登录态…' : '已扫码，请在手机上确认' }
  }
  if (status === 'expired') return { status: 'expired', message: '二维码已过期，请刷新' }
  if (status === 'error' || status === 'failed' || (Number(data.error_code) !== 0 && data.error_code !== undefined)) {
    return { status: 'failed', message: `汽水返回异常（error_code=${data.error_code ?? '-'}，${data.description || body.message || '无说明'}）` }
  }
  return { status: 'waiting', message: '等待扫码' }
}
