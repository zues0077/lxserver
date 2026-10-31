/**
 * 平台账号取链的 HTTP 与 Cookie 工具
 *
 * 统一走项目的 getProxyAgent(url, 'music')，这样「细分代理 → 音乐平台」的配置
 * 对账号取链同样生效，不会出现「自定义源走了代理、账号取链没走」的割裂。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import needle from 'needle'
import { getProxyAgent } from '@/modules/utils/proxy.js'
import { encodeRequestUrl } from '@/utils/urlEncode'

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 把 Cookie 字符串解析成键值对，容忍多余的空格与分号 */
export function parseCookie(cookie: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of String(cookie || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

/**
 * 判断 Cookie 是否含某平台的登录特征字段
 *
 * 匹配规则要精确：早先实现是「键名相同或以 key 开头」，结果单字母键
 * （酷狗的 `t`）会把 theme / traceid 这类无关 Cookie 也算命中，
 * 于是游客 Cookie 也能通过结构校验 —— 假绿灯比红灯更害人。
 *
 * 现在只认两种写法：
 *   - `kw_token`    精确匹配（区分大小写，Cookie 名本来大小写敏感）
 *   - `*token*`     通配，`*` 代表任意串（用于「名字不确定但一定含 token」的平台，
 *                   比如咪咕换了新版登录后字段名可能是 mg_auth_utoken 之类）
 */
export function hasLoginKey(cookie: string, loginKeys: string[]): boolean {
  const keys = Object.keys(parseCookie(cookie))
  return loginKeys.some(raw => {
    const k = String(raw || '').trim()
    if (!k) return false
    if (k.includes('*')) {
      const pattern = k
        .split('*')
        .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')
      const re = new RegExp(`^${pattern}$`)
      return keys.some(key => re.test(key))
    }
    return keys.includes(k)
  })
}

// ---- 平台轮换 Cookie 的「被动保活」 ----
//
// 用户 2026-10-31 提出「除了咪咕是否还有平台需要保活」。逐个平台核过：
//   咪咕 mg    —— pacmtoken 仅约 2 小时，且平台**每次响应都下发新票** → 必须主动心跳（见 index.ts）。
//   网易 wy    —— MUSIC_U 是长效登录态（月级），平台不换票；
//   QQ tx      —— qm_keyst 长效；酷我 kw —— kw_token 长效；
//   酷狗 kg / 概念版 kglite —— App token 长效，无换票接口；
//   汽水 soda  —— 客户端 Cookie 长效；B站 bili —— SESSDATA 半年。
// 后七个平台都**没有换票接口**，主动打接口不会延长寿命，只会白白增加风控暴露，所以不排心跳。
// 但有一类风险是共通的：平台若在响应里 Set-Cookie 下发了新值（会话/设备标识轮换），
// 我们只存导入那一刻的快照，轮换一次就永久落后。这里统一接住，零额外请求。
//
// 收的口子很紧，宁可漏接也不写坏账号：
//   ① 只认与平台**同一注册域**的响应（防第三方/CDN 的 Set-Cookie 混进来）；
//   ② 只更新存储里**已经存在**的同名字段（平台新加的埋点/AB 标记不进 Cookie 串）；
//   ③ 忽略删除语义（Max-Age=0）与空值；
//   ④ 编排层**只在这次请求成功时**才落库（见 index.ts），失败时不写回，
//      避免把「降级成游客」的 Cookie 覆盖掉还能用的账号。

interface CookieRotationCtx {
  /** 平台注册域，用于同源判断 */
  domain: string
  /** 当前 Cookie 的键值快照 */
  current: Record<string, string>
  /** 本轮收到的轮换字段 */
  updates: Record<string, string>
}

const cookieRotationCtx = new AsyncLocalStorage<CookieRotationCtx>()

/** 注册域（最后两段），music.163.com 与 interface.music.163.com 视为同域 */
function regDomainOf(host: string): string {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('.') : parts.join('.')
}

/**
 * 从一条 set-cookie（或数组）里挑出「存储里已有同名字段」的新值。
 * 纯函数，便于单测。
 */
export function pickRotatedFromSetCookie(raw: any, current: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  const list = Array.isArray(raw) ? raw : [raw]
  for (const item of list) {
    const text = String(item || '')
    if (!text) continue
    // 删除语义（Max-Age=0 / Expires 过去）不是新值，接了等于把账号清空
    if (/max-age\s*=\s*0\b/i.test(text)) continue
    const first = text.split(';')[0]
    const idx = first.indexOf('=')
    if (idx <= 0) continue
    const k = first.slice(0, idx).trim()
    const v = first.slice(idx + 1).trim()
    if (!k || !v) continue
    if (!(k in current)) continue
    out[k] = v
  }
  return out
}

/** 把轮换后的字段并回 Cookie 串：只替换值，顺序与其余字段原样保留 */
export function mergeRotatedCookie(cookie: string, updates: Record<string, string>): string {
  if (!Object.keys(updates).length) return cookie
  let changed = false
  const parts = String(cookie || '').split(';').map(part => {
    const idx = part.indexOf('=')
    if (idx <= 0) return part
    const k = part.slice(0, idx).trim()
    if (!(k in updates)) return part
    const keepSpace = part.slice(idx + 1).startsWith(' ') ? ' ' : ''
    if (part.slice(idx + 1).trim() === updates[k]) return part
    changed = true
    return `${part.slice(0, idx)}=${keepSpace}${updates[k]}`
  })
  return changed ? parts.join(';') : cookie
}

export interface CookieRotation<T> {
  result: T
  /** 本次调用期间平台轮换字段后的 Cookie；没轮换时原样返回 */
  cookie: string
  /** 被轮换的字段名（只报字段名，绝不带值） */
  changed: string[]
}

/**
 * 在 fn 执行期间开启「轮换 Cookie 采集」。
 * fn 内部所有走 request() 的请求都会被检查响应头，命中就收进上下文。
 */
export async function withCookieRotation<T>(
  cookie: string,
  domain: string,
  fn: () => Promise<T>,
): Promise<CookieRotation<T>> {
  const ctx: CookieRotationCtx = { domain, current: parseCookie(cookie), updates: {} }
  const result = await cookieRotationCtx.run(ctx, fn)
  const changed = Object.keys(ctx.updates)
  if (!changed.length) return { result, cookie, changed: [] }
  return { result, cookie: mergeRotatedCookie(cookie, ctx.updates), changed }
}

/** 每个响应都过一遍；不在采集上下文里（如手动校验之外）直接返回 */
function absorbSetCookie(url: string, headers: Record<string, any>): void {
  const ctx = cookieRotationCtx.getStore()
  if (!ctx) return
  try {
    const host = new URL(url).hostname
    if (ctx.domain && regDomainOf(host) !== regDomainOf(ctx.domain)) return
  } catch {
    return
  }
  const raw = headers?.['set-cookie'] ?? headers?.['Set-Cookie']
  const picked = pickRotatedFromSetCookie(raw, ctx.current)
  for (const k of Object.keys(picked)) {
    ctx.updates[k] = picked[k]
  }
}

export interface RequestOpts {
  method?: 'get' | 'post' | 'head'
  headers?: Record<string, string>
  /** 表单字符串（application/x-www-form-urlencoded） */
  form?: string
  /** JSON 对象，设置后以 application/json 发送 */
  json?: any
  /** 原始 body 字符串 */
  body?: string
  timeout?: number
  /** 返回原始文本而不尝试解析 JSON */
  raw?: boolean
  /**
   * 最多跟随几次重定向。默认 5。
   * 扫码登录（QQ）需要自己读 302 的 Location 才能拿到 code，这里必须能设成 0。
   */
  followMax?: number
}

export interface RequestResult<T = any> {
  statusCode: number
  headers: Record<string, any>
  body: T
}

/**
 * 发起请求。失败时抛出异常，调用方按「该解析器本次不可用」处理。
 * 分类固定为 'music'，因为请求目标都是音乐平台域名。
 */
export async function request<T = any>(url: string, opts: RequestOpts = {}): Promise<RequestResult<T>> {
  const method = opts.method || 'get'
  const headers: Record<string, string> = {
    'User-Agent': UA_PC,
    ...(opts.headers || {}),
  }

  const options: any = {
    headers,
    follow_max: opts.followMax ?? 5,
    response_timeout: opts.timeout ?? 12000,
    read_timeout: opts.timeout ?? 12000,
    agent: await getProxyAgent(url, 'music'),
  }
  if (opts.json !== undefined) options.json = true

  let payload: any = null
  if (opts.json !== undefined) payload = opts.json
  else if (opts.form !== undefined) payload = opts.form
  else if (opts.body !== undefined) payload = opts.body

  // 平台接口 URL 基本是纯 ASCII，但咪咕/酷我 会把昵称或 UA 片段拼进查询串，
  // 统一在这里编码，避免 needle（url.parse）抛 unescaped characters。
  const resp = await needle(method, encodeRequestUrl(url), payload, options)

  // 平台若在响应里下发了轮换后的 Cookie 字段，就地收下（见上方 withCookieRotation）
  absorbSetCookie(url, resp.headers || {})

  let body: any = resp.body
  // 不少音乐平台的接口用 text/html 返回 JSON（实测酷狗 getSongInfo 就是），
  // needle 只在 Content-Type 是 application/json 时才自动解析，
  // 这里补一层兜底，否则 body 会是字符串，调用方取 body.xxx 全是 undefined。
  if (!opts.raw && typeof body === 'string') {
    const text = body.trim()
    if (text.startsWith('{') || text.startsWith('[')) {
      try { body = JSON.parse(text) } catch { /* 不是合法 JSON，保留原文 */ }
    }
  }

  return {
    statusCode: resp.statusCode ?? 0,
    headers: resp.headers || {},
    body: body as T,
  }
}

/**
 * 带超时保护的 Promise。取链是播放链路上的同步阻塞点，
 * 单个平台卡住不能拖垮整首歌的取链，所以统一包一层超时。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    promise.then(v => { clearTimeout(timer); resolve(v) })
      .catch(e => { clearTimeout(timer); reject(e) })
  })
}

/** 从 URL 里取扩展名，用于音质标注（不含点号，失败返回空串） */
export function extFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname
    const m = p.match(/\.([a-z0-9]{2,5})$/i)
    return m ? m[1].toLowerCase() : ''
  } catch {
    return ''
  }
}
