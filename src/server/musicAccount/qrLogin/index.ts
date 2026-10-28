/**
 * 扫码登录 —— 会话编排
 *
 * 前端只认两个动作：start 拿一张二维码，之后按间隔 poll 问「现在怎么样了」。
 * 二维码背后的私有状态（unikey / qrcode / cookie jar）全部留在服务端内存里，
 * 不下发到浏览器，也不落盘 —— 未完成的登录会话本来就不该持久化。
 *
 * 轮询到 success 时，这里负责把 Cookie 交给 store 加密保存，
 * 前端拿到 success 后刷新列表即可看到「已登录」。
 */

import * as netease from './netease'
import * as kugou from './kugou'
import * as bilibili from './bilibili'
import { qqDriver, wxDriver } from './qq'
import * as kgliteSolver from '../resolvers/kglite'
import { getPlatform } from '../platforms'
import { normalizeCookieInput } from '../cookieParse'
import * as store from '../store'
import type { QrDriver, QrStatus } from './types'

/** driverId → 实现。platforms.ts 里用同一套 id 声明「这个平台支持哪些扫码方式」 */
const DRIVERS: Record<string, QrDriver> = {
  wy: { ttlSec: netease.TTL_SEC, pollIntervalMs: netease.POLL_INTERVAL_MS, create: netease.create, check: netease.check },
  kg: { ttlSec: kugou.TTL_SEC, pollIntervalMs: kugou.POLL_INTERVAL_MS, create: kugou.create, check: kugou.check },
  // 概念版与标准版共用同一套扫码协议（二维码里本来就嵌的是 lite appid 3116），
  // 拿到的 Cookie 同时含 token/KugooID/mid，正好满足概念版取链需要的四个字段
  kglite: { ttlSec: kugou.TTL_SEC, pollIntervalMs: kugou.POLL_INTERVAL_MS, create: kugou.create, check: kugou.check },
  tx: qqDriver,
  txwx: wxDriver,
  bili: { ttlSec: bilibili.TTL_SEC, pollIntervalMs: bilibili.POLL_INTERVAL_MS, create: bilibili.create, check: bilibili.check },
}

interface Session {
  id: string
  platform: string
  driverId: string
  driver: QrDriver
  state: any
  createdAt: number
  expiresAt: number
  busy: boolean
  done: boolean
}

const sessions = new Map<string, Session>()
/** 会话最长保留 15 分钟，超时直接清掉，避免长期运行时内存慢慢涨 */
const SESSION_KEEP_MS = 15 * 60 * 1000

function sweep(): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_KEEP_MS) sessions.delete(id)
  }
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export interface QrStartPayload {
  ok: boolean
  sessionId?: string
  image?: string
  hint?: string
  expiresAt?: number
  pollIntervalMs?: number
  driverId?: string
  error?: string
}

/**
 * 开始一次扫码登录。
 * @param platform 平台 id（wy / tx / kg）
 * @param driverId 指定扫码方式，省略时用该平台声明的第一种
 */
export async function start(platform: string, driverId?: string): Promise<QrStartPayload> {
  sweep()
  const p = getPlatform(platform)
  if (!p) return { ok: false, error: `不支持的平台：${platform}` }
  const options = p.qrLogins || []
  if (!options.length) return { ok: false, error: `${p.name} 暂不支持扫码登录，请填写 Cookie` }

  const chosen = driverId
    ? options.find(o => o.driver === driverId)
    : options[0]
  if (!chosen) return { ok: false, error: `${p.name} 不支持这种扫码方式` }

  const driver = DRIVERS[chosen.driver]
  if (!driver) return { ok: false, error: `扫码驱动未实现：${chosen.driver}` }

  try {
    const created = await driver.create()
    const id = newId()
    const now = Date.now()
    sessions.set(id, {
      id,
      platform,
      driverId: chosen.driver,
      driver,
      state: created.state,
      createdAt: now,
      expiresAt: now + driver.ttlSec * 1000,
      busy: false,
      done: false,
    })
    return {
      ok: true,
      sessionId: id,
      image: created.image,
      hint: created.hint,
      expiresAt: now + driver.ttlSec * 1000,
      pollIntervalMs: driver.pollIntervalMs,
      driverId: chosen.driver,
    }
  } catch (e: any) {
    console.log(`[平台账号] ${p.name} 扫码二维码获取失败：${e?.message || e}`)
    return { ok: false, error: e?.message || String(e) }
  }
}

export interface QrPollPayload {
  ok: boolean
  status: QrStatus
  message?: string
  /** 成功后置 true，提示前端可以刷新列表 */
  saved?: boolean
  error?: string
}

/** 查询一次扫码结果 */
export async function poll(sessionId: string): Promise<QrPollPayload> {
  const s = sessions.get(String(sessionId || ''))
  if (!s) return { ok: false, status: 'expired', message: '登录会话不存在或已过期，请刷新二维码' }
  if (s.done) return { ok: true, status: 'success', message: '登录成功', saved: true }
  if (Date.now() > s.expiresAt) {
    sessions.delete(s.id)
    return { ok: true, status: 'expired', message: '二维码已过期，请刷新' }
  }
  // 同一次轮询还没返回时，别叠着再发一次上游请求（前端定时器偶尔会撞车）
  if (s.busy) return { ok: true, status: 'waiting', message: '等待扫码' }
  s.busy = true

  try {
    const result = await s.driver.check(s.state)
    if (result.status !== 'success') {
      return { ok: true, status: result.status, message: result.message }
    }

    const rawCookie = String(result.cookie || '').trim()
    if (!rawCookie) {
      s.done = true
      sessions.delete(s.id)
      return { ok: false, status: 'failed', message: '登录成功但 Cookie 为空，请重试' }
    }
    // 各家驱动拼出来的串格式不完全统一，落库前统一收敛成 k=v; k=v
    const parsed = normalizeCookieInput(rawCookie)
    const cookie = parsed.ok ? parsed.cookie : rawCookie
    const saved = store.setCookie(s.platform, cookie)
    s.done = true
    sessions.delete(s.id)
    if (!saved.success) {
      return { ok: false, status: 'failed', message: saved.error || 'Cookie 保存失败' }
    }
    const name = getPlatform(s.platform)?.name || s.platform
    console.log(`[平台账号] ${name} 扫码登录成功，Cookie 已加密保存（${cookie.length} 字符）`)
    return { ok: true, status: 'success', message: '登录成功，账号已保存', saved: true }
  } catch (e: any) {
    // 网络抖动不要直接判死，让前端继续轮询。
    // 错误细节只写日志，不往界面抛 —— 用户看到「socket hang up」只会更困惑。
    console.log(`[平台账号] 扫码轮询异常：${e?.message || e}`)
    return { ok: true, status: 'waiting', message: '等待扫码' }
  } finally {
    s.busy = false
  }
}

/** 主动结束会话（用户关掉弹窗时调用，及时释放内存） */
export function close(sessionId: string): void {
  sessions.delete(String(sessionId || ''))
}

/** 该平台是否支持扫码（供接口层快速判断） */
export function supports(platform: string): boolean {
  const p = getPlatform(platform)
  return !!p?.qrLogins?.length
}

// ---- 手机验证码登录（目前只有酷狗概念版） ----
//
// 为什么不把 mid / guid 直接下发前端再回传：
// 它们既是设备标识也是取链签名的输入，来回传容易在复制粘贴、刷新、多标签页之间错位，
// 一旦和发码时用的不是同一套，服务端会当成「换了台设备」，表现为收得到码却登录失败。
// 所以只在服务端内存里存一份，前端拿到的是一个不透明 sessionId。

interface SmsSession {
  platform: string
  mobile: string
  state: { guid: string; mid: string; device: string }
  createdAt: number
}
const smsSessions = new Map<string, SmsSession>()
const SMS_KEEP_MS = 10 * 60 * 1000

function sweepSms(): void {
  const now = Date.now()
  for (const [id, s] of smsSessions) {
    if (now - s.createdAt > SMS_KEEP_MS) smsSessions.delete(id)
  }
}

export interface SmsSendPayload {
  ok: boolean
  sessionId?: string
  message: string
}

/** 支持短信验证码登录的平台（目前只有酷狗概念版） */
const SMS_PLATFORMS = new Set(['kglite'])

/** 给指定平台发短信验证码 */
export async function sendSms(platform: string, mobile: string): Promise<SmsSendPayload> {
  sweepSms()
  const p = getPlatform(platform)
  if (!p) return { ok: false, message: `不支持的平台：${platform}` }
  // 白名单必须在发请求之前拦：否则会把别家平台的手机号拿去调酷狗的取码接口，
  // 既没用（对方不认），也可能真给用户发出一条莫名其妙的短信
  if (!SMS_PLATFORMS.has(platform)) {
    return { ok: false, message: `${p.name} 暂不支持短信验证码登录，请用扫码或填写 Cookie` }
  }
  const tel = String(mobile || '').replace(/[^\d]/g, '')
  if (!/^1\d{10}$/.test(tel)) return { ok: false, message: '请输入 11 位手机号' }

  const res = await kgliteSolver.sendSmsCode(tel)
  if (!res.ok || !res.state) return { ok: false, message: res.message }

  const id = newId()
  smsSessions.set(id, { platform, mobile: tel, state: res.state, createdAt: Date.now() })
  return { ok: true, sessionId: id, message: res.message }
}

export interface SmsLoginPayload {
  ok: boolean
  message: string
  saved?: boolean
}

/** 用验证码完成登录并落库 */
export async function loginSms(sessionId: string, code: string): Promise<SmsLoginPayload> {
  const s = smsSessions.get(String(sessionId || ''))
  if (!s) return { ok: false, message: '验证码会话已过期，请重新获取' }
  const c = String(code || '').replace(/[^\d]/g, '')
  if (c.length < 4) return { ok: false, message: '请输入短信里的验证码' }

  const res = await kgliteSolver.loginBySmsCode(s.mobile, c, s.state)
  if (!res.ok || !res.cookie) return { ok: false, message: res.message }

  const parsed = normalizeCookieInput(res.cookie)
  const cookie = parsed.ok ? parsed.cookie : res.cookie
  const saved = store.setCookie(s.platform, cookie)
  if (!saved.success) return { ok: false, message: saved.error || '账号保存失败' }

  smsSessions.delete(sessionId)
  const name = getPlatform(s.platform)?.name || s.platform
  console.log(`[平台账号] ${name} 短信登录成功，凭据已加密保存（${cookie.length} 字符）`)
  return { ok: true, message: '登录成功，账号已保存', saved: true }
}
