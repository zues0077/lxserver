/**
 * 扫码登录的公共工具
 *
 * 三个平台拿二维码的方式不一样：
 *   - 网易云 / 酷狗只给「二维码里该放的字符串」，图片要我们自己画；
 *   - QQ 直接给一张 PNG，转 base64 就能用。
 * 所以统一约定：驱动层只负责产出 data URL，前端永远只认一个 img.src。
 */

import QRCode from 'qrcode'

/** 把文本画成 SVG 二维码（data URL）。不落盘、不外发，二维码内容只在内存里。 */
export async function qrDataUrl(text: string): Promise<string> {
  const svg = await QRCode.toString(text, {
    type: 'svg',
    margin: 1,
    width: 232,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  })
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`
}

/** Buffer → PNG data URL */
export function pngDataUrl(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString('base64')}`
}

/**
 * 从响应头里取 Set-Cookie。
 * needle 会把多个 Set-Cookie 聚成数组，单条时是字符串，这里两种都兼容。
 */
export function readSetCookies(headers: any): Record<string, string> {
  const raw = headers?.['set-cookie']
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const out: Record<string, string> = {}
  for (const line of list) {
    const pair = String(line).split(';')[0]
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const k = pair.slice(0, idx).trim()
    const v = pair.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

/** 键值对 → Cookie 请求头 */
export function joinCookies(map: Record<string, string>): string {
  return Object.keys(map)
    .filter(k => k && String(map[k] ?? '').trim() !== '')
    .map(k => `${k}=${map[k]}`)
    .join('; ')
}

interface JarEntry {
  domain: string
  name: string
  value: string
}

/**
 * 极简 CookieJar。
 *
 * 为什么不用第三方库：QQ 扫码要走「ptlogin → graph.qq.com → y.qq.com」这一长串跳转，
 * 每一步的 Cookie 都要按域名带对（尤其是 p_skey 只在 ptlogin 域下）。
 * 我们只需要「按域名存取 + 同名取最长匹配」这几个能力，自己写 20 行比引依赖更好维护。
 */
export class CookieJar {
  private entries: JarEntry[] = []

  /** 记录一次响应里的 Set-Cookie。domain 属性缺失时按请求域名归属。 */
  setFromHeaders(url: string, headers: any): void {
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch { return }
    const raw = headers?.['set-cookie']
    const list: string[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
    for (const line of list) {
      const parts = String(line).split(';')
      const pair = parts.shift() || ''
      const idx = pair.indexOf('=')
      if (idx <= 0) continue
      const name = pair.slice(0, idx).trim()
      const value = pair.slice(idx + 1).trim()
      if (!name) continue
      let domain = host
      for (const attr of parts) {
        const i = attr.indexOf('=')
        const key = (i > 0 ? attr.slice(0, i) : attr).trim().toLowerCase()
        if (key === 'domain' && i > 0) {
          domain = attr.slice(i + 1).trim().toLowerCase().replace(/^\./, '')
        }
      }
      this.entries = this.entries.filter(e => !(e.domain === domain && e.name === name))
      this.entries.push({ domain, name, value })
    }
  }

  /** 取某个域名下最匹配的 Cookie 值（同名时取域名更具体的） */
  get(url: string, name: string): string {
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch { return '' }
    let hit: JarEntry | undefined
    for (const e of this.entries) {
      if (e.name !== name) continue
      if (host !== e.domain && !host.endsWith(`.${e.domain}`)) continue
      if (!hit || e.domain.length > hit.domain.length) hit = e
    }
    return hit?.value || ''
  }

  /** 生成该 URL 该带的 Cookie 请求头 */
  header(url: string): string {
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch { return '' }
    const best = new Map<string, JarEntry>()
    for (const e of this.entries) {
      if (host !== e.domain && !host.endsWith(`.${e.domain}`)) continue
      const cur = best.get(e.name)
      if (!cur || e.domain.length > cur.domain.length) best.set(e.name, e)
    }
    return Array.from(best.values()).map(e => `${e.name}=${e.value}`).join('; ')
  }

  /** 导出全部键值（登录成功时汇总成最终的 Cookie 字符串） */
  toMap(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const e of this.entries) {
      if (e.value !== '') out[e.name] = e.value
    }
    return out
  }
}

/** 取 URL 查询参数 */
export function queryValue(rawUrl: string, key: string): string {
  try {
    return new URL(rawUrl).searchParams.get(key) || ''
  } catch {
    const m = String(rawUrl || '').match(new RegExp(`[?&]${key}=([^&#]*)`))
    return m ? decodeURIComponent(m[1]) : ''
  }
}

/** 相对地址补全 */
export function resolveUrl(base: string, ref: string): string {
  try { return new URL(ref, base).toString() } catch { return ref }
}
