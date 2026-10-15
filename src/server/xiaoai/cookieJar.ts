/**
 * 极简 CookieJar。
 *
 * 小米账号体系（account.xiaomi.com）与 Mina 接口（api2.mina.mi.com）都依赖 Cookie
 * 在多次请求间传递登录态，服务端需要自己维护一份。
 *
 * 只做两件事：
 *  1. 记录 set-cookie（按归属域区分，避免不同域同名 cookie 互相覆盖）
 *  2. 请求时按 host 拼接 Cookie 请求头
 */

/** 取 host 的末尾两级作为归属域（如 account.xiaomi.com -> xiaomi.com） */
const baseDomainOf = (host: string) => {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  return parts.slice(-2).join('.')
}

export class CookieJar {
  /** key = `${domain}|${name}` */
  private store = new Map<string, { value: string; domain: string }>()

  /** 记录一条 set-cookie 原始串 */
  addFromHeader(rawCookie: string, requestUrl: string) {
    const segments = String(rawCookie || '').split(';')
    const first = segments.shift() || ''
    const eq = first.indexOf('=')
    if (eq <= 0) return
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!name) return

    let domain = ''
    for (const seg of segments) {
      const idx = seg.indexOf('=')
      const key = (idx >= 0 ? seg.slice(0, idx) : seg).trim().toLowerCase()
      if (key === 'domain') domain = (idx >= 0 ? seg.slice(idx + 1) : '').trim().replace(/^\./, '')
    }

    let host = ''
    try {
      host = new URL(requestUrl).hostname
    } catch {
      host = ''
    }
    const scope = domain || baseDomainOf(host)
    this.store.set(`${scope}|${name}`, { value, domain: scope })
  }

  addFromHeaders(rawCookies: string[], requestUrl: string) {
    for (const raw of rawCookies || []) this.addFromHeader(raw, requestUrl)
  }

  /** 生成某个 URL 对应的 Cookie 请求头 */
  getCookieHeader(requestUrl: string): string {
    let host = ''
    try {
      host = new URL(requestUrl).hostname
    } catch {
      host = ''
    }
    const parts: string[] = []
    for (const [key, entry] of this.store) {
      const name = key.slice(entry.domain.length + 1)
      if (entry.domain && host && !host.endsWith(entry.domain)) continue
      if (!entry.value) continue
      parts.push(`${name}=${entry.value}`)
    }
    return parts.join('; ')
  }

  getValue(name: string): string {
    for (const [key, entry] of this.store) {
      if (key.slice(entry.domain.length + 1) === name) return entry.value
    }
    return ''
  }

  /** 手工注入（例如用户直接粘贴的 cUserId / passToken） */
  setValue(name: string, value: string, domain = 'xiaomi.com') {
    this.store.set(`${domain}|${name}`, { value: String(value || ''), domain })
  }

  names(): string[] {
    return Array.from(this.store.keys()).map(key => key.split('|').slice(1).join('|'))
  }

  clear() {
    this.store.clear()
  }
}
