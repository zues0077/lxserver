/**
 * 酷狗音乐 —— 扫码登录
 *
 * 酷狗的两个登录接口都要求 signature：把参数按 key 排序拼成 k=v 串，
 * 前后各夹一个固定密钥再 MD5。appid 在「取二维码」和「查扫码结果」两步里不一样
 * （1001 / 3116），写错会直接返回 error_code，这点踩过坑。
 */

import * as crypto from 'node:crypto'
import { request } from '../http'
import { qrDataUrl } from './util'
import type { QrCreateResult, QrCheckResult } from './types'

const SIGN_KEY = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
const QR_APPID = '1001' // 取二维码用一个精简 appid
const LITE_APPID = '3116' // 查结果（以及后续取链）用 lite 版 appid
const CLIENT_VER = '11440'
const QR_API = 'https://login-user.kugou.com/v2/qrcode'
const CHECK_API = 'https://login-user.kugou.com/v2/get_userinfo_qrcode'
const UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi'

export const TTL_SEC = 300
export const POLL_INTERVAL_MS = 2000

function md5(text: string): string {
  return crypto.createHash('md5').update(text, 'utf-8').digest('hex')
}

/** 酷狗签名：md5(key + 排序后的 k=v 拼接 + key) */
function sign(params: Record<string, string>): string {
  const pairs = Object.keys(params).map(k => `${k}=${params[k]}`).sort()
  return md5(SIGN_KEY + pairs.join('') + SIGN_KEY)
}

/** 设备的 mid：md5 摘要当大整数转十进制（酷狗用它标识设备） */
function deviceMid(guid: string): string {
  return BigInt(`0x${md5(guid)}`).toString(10)
}

function randomGuid(): string {
  return crypto.randomUUID()
}

function buildQuery(params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString()
  return `${qs}&signature=${sign(params)}`
}

function headers(cookies: Record<string, string>, clienttime: string, mid: string): Record<string, string> {
  return {
    'User-Agent': UA,
    dfid: cookies.dfid || '-',
    clienttime,
    mid,
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    Cookie: Object.keys(cookies).map(k => `${k}=${cookies[k]}`).join('; '),
    // 国内 CDN 上部分节点会按来源 IP 限流，随机一次来源头能显著降低失败率
    'X-Forwarded-For': `${Math.floor(Math.random() * 200) + 20}.${Math.floor(Math.random() * 200) + 10}.${Math.floor(Math.random() * 200) + 10}.${Math.floor(Math.random() * 200) + 10}`,
  }
}

export async function create(): Promise<QrCreateResult> {
  const guid = randomGuid()
  const mid = deviceMid(guid)
  const clienttime = String(Date.now())
  const cookies: Record<string, string> = {
    KUGOU_API_GUID: guid,
    KUGOU_API_MID: mid,
    KUGOU_API_MAC: crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase(),
    KUGOU_API_DEV: crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase(),
    dfid: '-',
  }
  const params: Record<string, string> = {
    dfid: '-',
    mid,
    uuid: '-',
    appid: QR_APPID,
    clientver: CLIENT_VER,
    clienttime,
    type: '1',
    plat: '4',
    qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${LITE_APPID}&`,
    srcappid: '2919',
  }

  const resp = await request<any>(`${QR_API}?${buildQuery(params)}`, {
    headers: headers(cookies, clienttime, mid),
    timeout: 12000,
  })
  const body: any = resp.body || {}
  const key = String(body?.data?.qrcode || '').trim()
  if (!key) {
    throw new Error(`酷狗二维码获取失败（status=${body?.status ?? '-'}，error=${body?.error || body?.error_code || '未知'}）`)
  }

  return {
    state: { key, guid, mid },
    image: await qrDataUrl(`https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${encodeURIComponent(key)}`),
    hint: '打开酷狗音乐 App → 我的 → 扫一扫',
  }
}

export async function check(state: any): Promise<QrCheckResult> {
  const key = String(state?.key || '')
  if (!key) return { status: 'failed', message: '登录会话已失效，请刷新二维码' }

  const mid = String(state?.mid || '')
  const clienttime = String(Date.now())
  const cookies: Record<string, string> = {
    KUGOU_API_GUID: String(state?.guid || ''),
    KUGOU_API_MID: mid,
    dfid: '-',
  }
  const params: Record<string, string> = {
    dfid: '-',
    mid,
    uuid: '-',
    appid: LITE_APPID,
    clientver: CLIENT_VER,
    clienttime,
    plat: '4',
    srcappid: '2919',
    qrcode: key,
  }

  const resp = await request<any>(`${CHECK_API}?${buildQuery(params)}`, {
    headers: headers(cookies, clienttime, mid),
    timeout: 12000,
  })
  const body: any = resp.body || {}
  const data: any = body.data || {}
  const st = Number(data.status)

  // 0/1 等待，2/3 已扫码待确认，4 成功，-1/5/6 过期
  if (st === 4) {
    const token = String(data.token || '').trim()
    const userId = String(data.userid ?? '').trim()
    if (!token || !userId || userId === '0') {
      return { status: 'failed', message: '酷狗返回登录成功，但没有拿到 token，请重试' }
    }
    const cookie = [
      `token=${token}`,
      `t=${token}`,
      `userid=${userId}`,
      `KugooID=${userId}`,
      `mid=${mid}`,
      `dfid=-`,
    ].join('; ')
    return { status: 'success', message: '登录成功', cookie }
  }
  if (st === 2 || st === 3) return { status: 'scanned', message: '已扫码，请在手机上确认登录' }
  if (st === -1 || st === 5 || st === 6) return { status: 'expired', message: '二维码已过期，请刷新' }
  if (st === 0 || st === 1) return { status: 'waiting', message: '等待扫码' }
  return { status: 'failed', message: String(body.error || `酷狗返回异常状态（status=${st}）`) }
}
