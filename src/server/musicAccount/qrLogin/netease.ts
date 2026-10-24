/**
 * 网易云音乐 —— 扫码登录
 *
 * 流程很轻：接口直接给一个 unikey，二维码内容就是 https://music.163.com/login?codekey=<unikey>，
 * 手机扫码确认后轮询同一个 key，返回 code=803 时 Set-Cookie 里就带着 MUSIC_U。
 * 不需要 weapi/eapi 那套 AES+RSA 加密（那是「模拟客户端接口」才要的，扫码走的是登录专用接口）。
 */

import { request } from '../http'
import { qrDataUrl, readSetCookies, joinCookies } from './util'
import type { QrCreateResult, QrCheckResult } from './types'

const KEY_API = 'https://interface.music.163.com/api/login/qrcode/unikey'
const CHECK_API = 'https://interface.music.163.com/api/login/qrcode/client/login'
// 桌面客户端 UA：部分接口对浏览器 UA 会返回「操作频繁」
const UA = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152'
const BASE_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  'Content-Type': 'application/x-www-form-urlencoded',
}

export const TTL_SEC = 300
export const POLL_INTERVAL_MS = 2000

export async function create(): Promise<QrCreateResult> {
  const resp = await request<any>(KEY_API, {
    method: 'post',
    form: 'type=3',
    headers: BASE_HEADERS,
    timeout: 12000,
  })
  const body: any = resp.body || {}
  const unikey = String(body.unikey || '').trim()
  if (Number(body.code) !== 200 || !unikey) {
    throw new Error(`网易云二维码获取失败（code=${body.code ?? '-'}）`)
  }

  return {
    state: { unikey },
    image: await qrDataUrl(`https://music.163.com/login?codekey=${encodeURIComponent(unikey)}`),
    hint: '打开网易云音乐 App → 左上角「≡」→ 扫一扫',
  }
}

export async function check(state: any): Promise<QrCheckResult> {
  const unikey = String(state?.unikey || '')
  if (!unikey) return { status: 'failed', message: '登录会话已失效，请刷新二维码' }

  const resp = await request<any>(CHECK_API, {
    method: 'post',
    form: `key=${encodeURIComponent(unikey)}&type=3`,
    headers: BASE_HEADERS,
    timeout: 12000,
  })
  const body: any = resp.body || {}
  const code = Number(body.code)

  if (code === 801) return { status: 'waiting', message: '等待扫码' }
  if (code === 802) return { status: 'scanned', message: '已扫码，请在手机上确认登录' }
  if (code === 800) return { status: 'expired', message: '二维码已过期，请刷新' }
  if (code !== 803) return { status: 'failed', message: `登录失败（code=${Number.isFinite(code) ? code : '-'}）` }

  // 803 = 授权成功。Cookie 可能只在 Set-Cookie 里，也可能同时塞进 body.cookie。
  const fromHeader = readSetCookies(resp.headers)
  const cookie = String(body.cookie || '').trim() || joinCookies(fromHeader)
  if (!/MUSIC_U=/.test(cookie)) {
    return { status: 'failed', message: '登录成功但没有拿到 MUSIC_U，请重试' }
  }
  return { status: 'success', message: '登录成功', cookie }
}
