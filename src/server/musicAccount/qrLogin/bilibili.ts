/**
 * Bilibili —— 扫码登录
 *
 * 官方就提供扫码换 Cookie 的接口，流程与网易云几乎一样轻：
 *   1. GET  /x/passport-login/web/qrcode/generate  → 返回 qrcode_key + 二维码内容 URL
 *   2. GET  /x/passport-login/web/qrcode/poll      → data.code 表示扫到哪一步
 *        86101 未扫码 / 86090 已扫码待确认 / 0 成功（响应头里带 SESSDATA 等 Cookie） / 86038 已过期
 * 实测（2026-10-25）：两个接口在服务器直连均 200，无需任何签名，二维码 180 秒有效。
 */

import { request } from '../http'
import { qrDataUrl, readSetCookies, joinCookies } from './util'
import type { QrCreateResult, QrCheckResult } from './types'

const GENERATE_API = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const POLL_API = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const BASE_HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }

/** 官方二维码有效期 180 秒 */
export const TTL_SEC = 180
export const POLL_INTERVAL_MS = 2000

export async function create(): Promise<QrCreateResult> {
  const resp = await request<any>(GENERATE_API, { headers: BASE_HEADERS, timeout: 12000 })
  const body: any = resp.body || {}
  const data: any = body.data || {}
  const key = String(data.qrcode_key || '').trim()
  const url = String(data.url || '').trim()
  if (Number(body.code) !== 0 || !key || !url) {
    throw new Error(`B站二维码获取失败（code=${body.code ?? '-'}，${body.message || '无返回'}）`)
  }
  return {
    state: { key },
    image: await qrDataUrl(url),
    hint: '打开哔哩哔哩 App → 右上角「扫一扫」',
  }
}

export async function check(state: any): Promise<QrCheckResult> {
  const key = String(state?.key || '').trim()
  if (!key) return { status: 'failed', message: '登录会话已失效，请刷新二维码' }

  const resp = await request<any>(`${POLL_API}?qrcode_key=${encodeURIComponent(key)}`, {
    headers: BASE_HEADERS,
    timeout: 12000,
  })
  const body: any = resp.body || {}
  const data: any = body.data || {}
  const code = Number(data.code)

  if (code === 86101) return { status: 'waiting', message: '等待扫码' }
  if (code === 86090) return { status: 'scanned', message: '已扫码，请在手机上确认登录' }
  if (code === 86038) return { status: 'expired', message: '二维码已过期，请刷新' }
  if (code !== 0) {
    return { status: 'failed', message: `B站扫码失败（code=${Number.isFinite(code) ? code : '-'}，${data.message || body.message || '无说明'}）` }
  }

  // 成功时 Cookie 只在响应头里（SESSDATA / bili_jct / DedeUserID / sid / DedeUserID__ckMd5）
  const cookie = joinCookies(readSetCookies(resp.headers))
  if (!/SESSDATA=/.test(cookie)) {
    return { status: 'failed', message: '登录成功但没有拿到 SESSDATA，请重试（多为风控拦截，换网络再试）' }
  }
  return { status: 'success', message: '登录成功', cookie }
}
