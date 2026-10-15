import { CookieJar } from './cookieJar'

/**
 * 面向小米账号接口的 HTTP 封装。
 *
 * 不使用 fetch 的自动重定向：小米的 serviceToken 是在 302 重定向链的响应头里
 * 通过 set-cookie 下发的，必须逐跳收集 Cookie，因此这里手动跟随重定向。
 *
 * 请求走全局 fetch（Node 20+ 内置），可在 app 代理配置下正常工作——
 * 如果需要走代理，后续可在这里接 getProxyAgent，目前保持直连。
 */

export interface HttpRequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  jar?: CookieJar
  maxRedirects?: number
  timeoutMs?: number
  binary?: boolean
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  /** 最终一跳的 set-cookie 原始串（serviceToken 就藏在这里） */
  setCookie: string[]
  text: string
  binary?: Buffer
}

/** 读取 set-cookie（优先用 undici 的 getSetCookie，缺失时退化为字符串拆分） */
const readSetCookie = (headers: any): string[] => {
  if (headers && typeof headers.getSetCookie === 'function') {
    try {
      const list = headers.getSetCookie()
      if (Array.isArray(list) && list.length) return list
    } catch {
      /* 忽略，走退化分支 */
    }
  }
  const single = headers && typeof headers.get === 'function' ? headers.get('set-cookie') : ''
  if (!single) return []
  // 只在逗号后紧跟 "name=" 形态处拆分，避免把 Expires 里的逗号也拆开
  return String(single)
    .split(/,(?=[^;,=\s]+=)/g)
    .map(item => item.trim())
    .filter(Boolean)
}

const headerRecord = (headers: any): Record<string, string> => {
  const out: Record<string, string> = {}
  try {
    headers.forEach((value: string, key: string) => {
      out[String(key).toLowerCase()] = value
    })
  } catch {
    /* ignore */
  }
  return out
}

export class HttpTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`请求超时(${timeoutMs}ms): ${url}`)
    this.name = 'HttpTimeoutError'
  }
}

export const httpRequest = async (url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> => {
  const {
    method = 'GET',
    headers = {},
    body,
    jar,
    maxRedirects = 0,
    timeoutMs = 20000,
    binary = false,
  } = options

  let currentUrl = url
  let currentMethod = method
  let currentBody = body

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const reqHeaders: Record<string, string> = { ...headers }
    if (jar) {
      const cookieHeader = jar.getCookieHeader(currentUrl)
      if (cookieHeader) {
        reqHeaders.Cookie = reqHeaders.Cookie ? `${reqHeaders.Cookie}; ${cookieHeader}` : cookieHeader
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res: any
    try {
      res = await fetch(currentUrl, {
        method: currentMethod,
        headers: reqHeaders,
        body: currentBody,
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new HttpTimeoutError(currentUrl, timeoutMs)
      throw error
    } finally {
      clearTimeout(timer)
    }

    if (jar) jar.addFromHeaders(readSetCookie(res.headers), currentUrl)

    const status = Number(res.status) || 0
    const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : ''
    const isRedirect = [301, 302, 303, 307, 308].includes(status)
    const setCookie = readSetCookie(res.headers)

    if (isRedirect && location && hop < maxRedirects) {
      try {
        currentUrl = new URL(location, currentUrl).toString()
      } catch {
        // location 非法，直接返回当前响应
        return finish(res, binary, setCookie)
      }
      // 303 以及 301/302 对 POST 的常见处理：改为 GET 且不带 body
      if (status === 303 || (currentMethod === 'POST' && (status === 301 || status === 302))) {
        currentMethod = 'GET'
        currentBody = undefined
      }
      continue
    }

    return finish(res, binary, setCookie)
  }

  throw new Error(`重定向次数过多: ${url}`)
}

const finish = async (res: any, binary: boolean, setCookie: string[]): Promise<HttpResponse> => {
  const headers = headerRecord(res.headers)
  if (binary) {
    const buffer = Buffer.from(await res.arrayBuffer())
    return { status: Number(res.status) || 0, headers, setCookie, text: '', binary: buffer }
  }
  let text = ''
  try {
    text = await res.text()
  } catch {
    text = ''
  }
  return { status: Number(res.status) || 0, headers, setCookie, text }
}

/** 从 set-cookie 列表里取某个 cookie 的值 */
export const findSetCookieValue = (setCookie: string[], name: string): string => {
  for (const raw of setCookie || []) {
    const first = raw.split(';')[0] || ''
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    if (first.slice(0, eq).trim() === name) return first.slice(eq + 1).trim()
  }
  return ''
}

/** 去掉小米账号接口返回的 `&&&START&&&` 前缀 */
export const stripJsonPrefix = (body: string) => String(body || '').replace(/^&&&START&&&/, '').trim()

/** 安全解析 JSON（失败返回 null） */
export const parseJson = <T = any>(text: string): T | null => {
  try {
    return JSON.parse(stripJsonPrefix(text)) as T
  } catch {
    return null
  }
}

/**
 * 从原始 JSON 文本里按正则取大整数字段。
 * JSON.parse 会把 nonce 这类 19 位大整数四舍五入（JS Number 精度只有 2^53），
 * 导致 clientSign 计算错误、拿不到 serviceToken，所以必须原样取字符串。
 */
export const extractBigIntField = (text: string, field: string): string => {
  const match = String(text || '').match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`))
  return match ? match[1] : ''
}

/** 取字符串字段（兼容接口返回数字的情况） */
export const pickString = (obj: any, key: string, fallback = ''): string => {
  const value = obj?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string') return value
  return String(value)
}

/** URL 追加查询参数 */
export const appendQuery = (url: string, params: Record<string, string>) => {
  const sep = url.includes('?') ? '&' : '?'
  const body = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  return `${url}${sep}${body}`
}

/** 表单编码 */
export const encodeForm = (params: Record<string, string>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
