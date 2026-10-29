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
import {
  createSmsCaptcha,
  sendSmsCode as miguSendSmsCode,
  verifySms as miguVerifySms,
  exchangeToken as miguExchangeToken,
  type MiguPassportSession,
} from '../smsLogin/migu'
import { normalizeCookieInput } from '../cookieParse'
import * as store from '../store'
import { extractAccountIdentity } from '../identity'
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
  // 咪咕不做扫码：通行证 qrcWeb 能出码，但咪咕音乐 App 的扫一扫只认 TV 端码，
  // 扫网页码直接提示「TV扫码登录失败」，且服务端 qrcquery 全程停在「未扫码」（零上报）。
  // 2026-10-29 两次真机实测确认，别再重做这条路，咪咕走插件推 Cookie。
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
  /** 追加为新账号（多账号平台），false 则覆盖主账号 */
  append?: boolean
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

// ---- 登录成功后落库：先认号，再决定「更新 / 新增 / 覆盖主账号」 ----

export type LoginAction = 'updated' | 'created' | 'replaced'

interface PersistResult {
  ok: boolean
  error?: string
  /** updated = 同一个号，更新了原有条目；created = 新号，追加为冷备；replaced = 覆盖主账号 */
  action: LoginAction
  /** updated 时是命中条目的显示名 */
  label?: string
  total?: number
}

/**
 * 把一个刚拿到的登录态存进去。
 *
 * 判断顺序（这就是「老账号覆盖、新账号增加」的实现）：
 *   1. Cookie 里的稳定 uid 命中已有条目 → 只更新那一条（重扫同一个号，列表不会变长）
 *   2. 同一份 Cookie（指纹相同）命中 → 同样只更新
 *   3. 有 uid 但没命中 = 一个没见过的新号 → **直接追加为冷备**，不动主账号
 *      （以前要用户先点「添加账号」才算追加，等于把「这是不是我存过的号」这个判断推给用户）
 *   4. 平台没有稳定 uid（网易 MUSIC_U、汽水 sessionid 每次登录都变）→ 只能沿用老语义：
 *      用户点了「添加账号」就追加，否则覆盖主账号
 */
export function persistLoginCookie(platform: string, cookie: string, append: boolean): PersistResult {
  const ident = extractAccountIdentity(platform, cookie)
  const matched = store.findItemByIdentity(platform, ident)

  if (matched) {
    const r = store.addCookie(platform, cookie, {
      itemId: matched.id,
      uid: ident.uid,
      cookieHash: ident.cookieHash,
    })
    return { ok: r.success, error: r.error, action: 'updated', label: matched.label, total: r.total }
  }

  if (ident.uid || append) {
    const r = store.addCookie(platform, cookie, { ...ident })
    return { ok: r.success, error: r.error, action: 'created', total: r.total }
  }

  const r = store.setCookie(platform, cookie, ident)
  return { ok: r.success, error: r.error, action: 'replaced' }
}

/** 登录成功后的提示文案：直接说清「更新了哪个号 / 新增了冷备」 */
function loginSuccessMessage(r: PersistResult): string {
  if (r.action === 'updated') return `登录成功，已更新账号「${r.label || '主账号'}」`
  if (r.action === 'created') return `登录成功，已添加为新账号（冷备，共 ${r.total ?? 1} 个；需要用它取链请点「设为主账号」）`
  return '登录成功，主账号已更新'
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
 * @param opts.append 扫码成功后追加为新账号（酷狗概念版多开小号用），默认覆盖主账号
 */
export async function start(platform: string, driverId?: string, opts: { append?: boolean } = {}): Promise<QrStartPayload> {
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
      append: !!opts.append,
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
  /** 落库方式：updated 更新已有号 / created 新增冷备 / replaced 覆盖主账号 */
  action?: LoginAction
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
    const saved = persistLoginCookie(s.platform, cookie, !!s.append)
    s.done = true
    sessions.delete(s.id)
    if (!saved.ok) {
      return { ok: false, status: 'failed', message: saved.error || 'Cookie 保存失败' }
    }
    const name = getPlatform(s.platform)?.name || s.platform
    const desc = saved.action === 'updated' ? `更新已有账号「${saved.label || ''}」`
      : saved.action === 'created' ? `新增账号（共 ${saved.total ?? 1} 个）`
        : '更新主账号'
    console.log(`[平台账号] ${name} 扫码登录成功，Cookie 已加密保存，${desc}（${cookie.length} 字符）`)
    return { ok: true, status: 'success', message: loginSuccessMessage(saved), saved: true, action: saved.action }
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
  /** 登录成功后追加为新账号（多账号平台） */
  append?: boolean
  /**
   * 咪咕走通行证：公钥、cookie jar、图形码答案、设备 id 必须跨步骤复用，
   * 换一次就对不上（服务端会当成换了台设备，表现为收得到码却登录失败）。
   */
  migu?: MiguPassportSession
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

/**
 * 支持短信验证码登录的平台。
 * - kglite：酷狗概念版，一步发码一步登录
 * - mg：咪咕，通行证每次都要先答一道图形验证码（算术题），所以多一步「取码」
 */
const SMS_PLATFORMS = new Set(['kglite', 'mg'])

/** 需要先取图形验证码的平台 */
const CAPTCHA_PLATFORMS = new Set(['mg'])

export interface SmsCaptchaPayload {
  ok: boolean
  sessionId?: string
  /** 图形验证码图片（data:image/jpeg;base64,...），前端直接塞 img.src */
  image?: string
  /** "0" = 算术题（填结果） / "1" = 中文（抄汉字） */
  graphtype?: string
  message: string
}

/**
 * 取一张图形验证码并建会话（只有 CAPTCHA_PLATFORMS 需要）。
 * 咪咕通行证每次发短信前都要先答一道算术题，这一屏躲不掉，
 * 只能把图交给前端、用户填答案时一起提交。
 */
export async function smsCaptcha(platform: string, opts: { append?: boolean } = {}): Promise<SmsCaptchaPayload> {
  sweepSms()
  const p = getPlatform(platform)
  if (!p) return { ok: false, message: `不支持的平台：${platform}` }
  if (!CAPTCHA_PLATFORMS.has(platform)) {
    return { ok: false, message: `${p.name} 的短信登录不需要图形验证码` }
  }
  const res = await createSmsCaptcha()
  if (!res.ok || !res.session) return { ok: false, message: res.message }
  const id = newId()
  smsSessions.set(id, {
    platform,
    mobile: '',
    state: { guid: '', mid: '', device: '' },
    createdAt: Date.now(),
    append: !!opts.append,
    migu: res.session,
  })
  return { ok: true, sessionId: id, image: res.image, graphtype: res.graphtype, message: res.message }
}

/** 给指定平台发短信验证码 */
export async function sendSms(
  platform: string,
  mobile: string,
  opts: { append?: boolean; captcha?: string; sessionId?: string } = {},
): Promise<SmsSendPayload> {
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

  if (platform === 'mg') {
    // 咪咕：会话在「取图形码」那一步就建好了，这里只补手机号
    const s = smsSessions.get(String(opts.sessionId || ''))
    if (!s?.migu) return { ok: false, message: '图形验证码已过期，请重新获取一张' }
    const res = await miguSendSmsCode(s.migu, tel, String(opts.captcha || ''))
    if (!res.ok) return { ok: false, sessionId: opts.sessionId, message: res.message }
    s.mobile = tel
    s.createdAt = Date.now()
    return { ok: true, sessionId: opts.sessionId, message: res.message }
  }

  const res = await kgliteSolver.sendSmsCode(tel)
  if (!res.ok || !res.state) return { ok: false, message: res.message }

  const id = newId()
  smsSessions.set(id, { platform, mobile: tel, state: res.state, createdAt: Date.now(), append: !!opts.append })
  return { ok: true, sessionId: id, message: res.message }
}

export interface SmsLoginPayload {
  ok: boolean
  message: string
  saved?: boolean
  action?: LoginAction
}

/** 用验证码完成登录并落库 */
export async function loginSms(sessionId: string, code: string): Promise<SmsLoginPayload> {
  const s = smsSessions.get(String(sessionId || ''))
  if (!s) return { ok: false, message: '验证码会话已过期，请重新获取' }
  const c = String(code || '').replace(/[^\d]/g, '')
  if (c.length < 4) return { ok: false, message: '请输入短信里的验证码' }

  if (s.platform === 'mg') {
    if (!s.migu) return { ok: false, message: '会话已失效，请重新获取图形验证码' }
    if (!s.mobile) return { ok: false, message: '请先获取短信验证码' }
    const verify = await miguVerifySms(s.migu, s.mobile, c)
    if (!verify.ok || !verify.token) return { ok: false, message: verify.message }
    const exchange = await miguExchangeToken(verify.token, s.migu.deviceId)
    if (!exchange.ok || !exchange.cookie) return { ok: false, message: exchange.message }
    const savedMg = persistLoginCookie(s.platform, exchange.cookie, !!s.append)
    if (!savedMg.ok) return { ok: false, message: savedMg.error || '账号保存失败' }
    smsSessions.delete(sessionId)
    const nameMg = getPlatform(s.platform)?.name || s.platform
    console.log(
      `[平台账号] ${nameMg} 短信登录成功，凭据已加密保存（${savedMg.action}，${exchange.cookie.length} 字符）`,
    )
    return { ok: true, message: loginSuccessMessage(savedMg), saved: true, action: savedMg.action }
  }

  const res = await kgliteSolver.loginBySmsCode(s.mobile, c, s.state)
  if (!res.ok || !res.cookie) return { ok: false, message: res.message }

  const parsed = normalizeCookieInput(res.cookie)
  const cookie = parsed.ok ? parsed.cookie : res.cookie
  const saved = persistLoginCookie(s.platform, cookie, !!s.append)
  if (!saved.ok) return { ok: false, message: saved.error || '账号保存失败' }

  smsSessions.delete(sessionId)
  const name = getPlatform(s.platform)?.name || s.platform
  console.log(`[平台账号] ${name} 短信登录成功，凭据已加密保存（${saved.action}，${cookie.length} 字符）`)
  return { ok: true, message: loginSuccessMessage(saved), saved: true, action: saved.action }
}
