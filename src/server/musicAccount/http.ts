/**
 * 平台账号取链的 HTTP 与 Cookie 工具
 *
 * 统一走项目的 getProxyAgent(url, 'music')，这样「细分代理 → 音乐平台」的配置
 * 对账号取链同样生效，不会出现「自定义源走了代理、账号取链没走」的割裂。
 */

import needle from 'needle'
import { getProxyAgent } from '@/modules/utils/proxy.js'

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
 * 现在只在写成 `前缀*` 时才按前缀匹配。
 */
export function hasLoginKey(cookie: string, loginKeys: string[]): boolean {
  const keys = Object.keys(parseCookie(cookie))
  return loginKeys.some(raw => {
    const k = String(raw || '').trim()
    if (!k) return false
    if (k.endsWith('*')) {
      const prefix = k.slice(0, -1)
      return prefix.length > 0 && keys.some(key => key.startsWith(prefix))
    }
    return keys.includes(k)
  })
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

  const resp = await needle(method, url, payload, options)

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
