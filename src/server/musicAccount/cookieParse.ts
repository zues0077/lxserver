/**
 * Cookie 输入归一化
 *
 * 为什么需要这一层：
 * 各家「怎么把 Cookie 交给我」的默认姿势完全不同 ——
 *   · 从 F12「网络」面板复制的是 `Cookie:` 请求头；
 *   · 右键 Copy as cURL 复制的是整条 curl 命令；
 *   · Cookie-Editor / EditThisCookie 这类插件导出的是 Netscape 文本或 JSON；
 *   · go-music-dl 的输入框本身就接受 Netscape 文件（`# Netscape HTTP Cookie File`）。
 * 这些内容直接塞进 `Cookie:` 请求头全是非法值 —— 服务端只会当成一个超长的无名 Cookie。
 *
 * 所以这里统一认 5 种格式，全部归一化成 `k=v; k=v`。
 * 纯函数、无 IO，便于单测。
 */

export type CookieFormat =
  | 'cookie-header'
  | 'curl'
  | 'netscape'
  | 'json'
  | 'kv'
  | 'empty'

export interface CookieParseResult {
  /** 是否解析出至少一个可用的 Cookie */
  ok: boolean
  /** 识别到的格式，用于给用户回显「我认出了什么」 */
  format: CookieFormat
  /** 归一化后的 Cookie 头，可直接放进请求 */
  cookie: string
  /** 有效 Cookie 条数 */
  count: number
  /** 键名列表（用于检查关键字段是否齐全） */
  keys: string[]
  /** 被丢弃的项及原因，给用户提示 */
  dropped: string[]
}

const FORMAT_LABEL: Record<CookieFormat, string> = {
  'cookie-header': 'Cookie 请求头',
  curl: 'cURL 命令',
  netscape: 'Netscape Cookie 文件',
  json: 'JSON 导出',
  kv: '键值对文本',
  empty: '空内容',
}

export function formatLabel(f: CookieFormat): string {
  return FORMAT_LABEL[f] || f
}

/** 去掉首尾引号与空白 */
function unquote(v: string): string {
  let s = String(v ?? '').trim()
  if (s.length >= 2) {
    const a = s[0]
    const b = s[s.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) s = s.slice(1, -1).trim()
  }
  return s
}

/** 过期时间（秒）是否已经不可用。留 1 天宽限，避免时区/时钟误差误杀 */
function isExpired(expSeconds: number): boolean {
  if (!expSeconds || !Number.isFinite(expSeconds) || expSeconds <= 0) return false
  return expSeconds * 1000 < Date.now() - 86400_000
}

interface Pair {
  name: string
  value: string
  /** 过期被丢弃时的原始说明 */
  dropped?: string
}

/** 把键值对收敛成 Cookie 头：同名后者覆盖前者，丢弃空名 */
function buildCookie(pairs: Pair[]): { cookie: string; keys: string[]; dropped: string[] } {
  const map = new Map<string, string>()
  const dropped: string[] = []
  for (const p of pairs) {
    const name = String(p.name || '').trim()
    if (!name) continue
    if (p.dropped) {
      dropped.push(`${name}（${p.dropped}）`)
      continue
    }
    map.set(name, String(p.value ?? '').replace(/[\r\n]/g, ''))
  }
  const keys = [...map.keys()]
  return {
    cookie: keys.map(k => `${k}=${map.get(k)}`).join('; '),
    keys,
    dropped,
  }
}

/** `a=1; b=2` / 每行一个 `a=1` */
function parseKvText(text: string): Pair[] {
  const pairs: Pair[] = []
  const chunks = text
    .replace(/[\r\n]+/g, ';')
    .split(';')
  for (const chunk of chunks) {
    const raw = chunk.trim()
    if (!raw) continue
    const idx = raw.indexOf('=')
    if (idx <= 0) continue
    pairs.push({
      name: unquote(raw.slice(0, idx)),
      value: unquote(raw.slice(idx + 1)),
    })
  }
  return pairs
}

/** Netscape 文本（Chrome/Firefox 插件、curl -c 导出的都是这个格式） */
function parseNetscape(text: string): Pair[] | null {
  const lines = text.split(/\r?\n/)
  const pairs: Pair[] = []
  let hit = 0

  for (const original of lines) {
    const line = original.replace(/^\uFEFF/, '')
    if (!line.trim()) continue
    // #HttpOnly_ 是 Netscape 格式表达 HttpOnly 的方式，属于有效数据行
    const isHttpOnly = /^#HttpOnly_/i.test(line)
    if (line.startsWith('#') && !isHttpOnly) continue

    const body = isHttpOnly ? line.replace(/^#HttpOnly_/i, '') : line
    // 制表符分隔为主，兼容空格对齐的导出
    let cols = body.split('\t')
    if (cols.length < 7) {
      const m = body.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/)
      if (!m) continue
      cols = [m[1], m[2], m[3], m[4], m[5], m[6], m[7]]
    }
    if (cols.length < 7) continue

    const [, , , , expRaw, name, ...rest] = cols
    const value = rest.join('\t')
    if (!String(name || '').trim()) continue
    hit++

    const exp = Number(String(expRaw).trim())
    pairs.push({
      name: name.trim(),
      value: unquote(value),
      dropped: isExpired(exp) ? '已过期' : undefined,
    })
  }

  // 至少要像 Netscape 才认，否则交给别的解析器
  if (!hit) return null
  return pairs
}

/** `curl 'https://...' -H 'cookie: a=1; b=2'` */
function parseCurl(text: string): Pair[] | null {
  if (!/\bcurl\b/i.test(text)) return null

  const candidates: string[] = []
  // -H 'cookie: ...' / --header "Cookie: ..."
  const headerRe = /(?:-H|--header)\s+(['"])\s*cookie\s*:\s*([\s\S]*?)\1/gi
  for (const m of text.matchAll(headerRe)) candidates.push(m[2])

  // -b '...' / --cookie '...'
  const cookieRe = /(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/g
  for (const m of text.matchAll(cookieRe)) {
    const v = m[2]
    // -b 也可能给的是文件名，只有含 = 才当 Cookie 值
    if (v.includes('=')) candidates.push(v)
  }

  if (!candidates.length) return null
  return parseKvText(candidates.join('; '))
}

/** Cookie-Editor / EditThisCookie 的 JSON 导出 */
function parseJson(text: string): Pair[] | null {
  const s = text.trim()
  if (!s.startsWith('[') && !s.startsWith('{')) return null
  let data: any
  try {
    data = JSON.parse(s)
  } catch {
    return null
  }

  const list: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.cookies)
      ? data.cookies
      : null
  if (list) {
    const pairs: Pair[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const name = item.name ?? item.key ?? item.Name
      const value = item.value ?? item.Value ?? ''
      if (!name) continue
      const exp = Number(item.expirationDate ?? item.expires ?? 0)
      pairs.push({
        name: String(name),
        value: String(value),
        dropped: isExpired(exp) ? '已过期' : undefined,
      })
    }
    return pairs.length ? pairs : null
  }

  if (data && typeof data === 'object') {
    const pairs: Pair[] = []
    for (const [k, v] of Object.entries(data)) {
      if (k === 'url' || k === 'domain' || typeof v === 'object') continue
      pairs.push({ name: k, value: String(v) })
    }
    return pairs.length ? pairs : null
  }
  return null
}

/**
 * 主入口：把用户粘贴的任意内容归一化成 Cookie 头
 *
 * 识别顺序有讲究：Netscape 与 cURL 的结构特征最强，先认它们，
 * 避免被后面的「按 ; 切」误判成键值对。
 */
export function normalizeCookieInput(input: unknown): CookieParseResult {
  const raw = String(input ?? '').replace(/^\uFEFF/, '').trim()
  if (!raw) {
    return { ok: false, format: 'empty', cookie: '', count: 0, keys: [], dropped: [] }
  }

  const tryFormats: Array<{ format: CookieFormat; pairs: Pair[] | null }> = []

  // ① Netscape：有注释头或明显的 7 列结构
  const looksNetscape =
    /#\s*Netscape\s+HTTP\s+Cookie\s+File/i.test(raw) ||
    raw.split(/\r?\n/).some(l => /^#HttpOnly_/.test(l)) ||
    raw.split(/\r?\n/).filter(l => (l.match(/\t/g) || []).length >= 6).length >= 1
  if (looksNetscape) tryFormats.push({ format: 'netscape', pairs: parseNetscape(raw) })

  // ② cURL
  tryFormats.push({ format: 'curl', pairs: parseCurl(raw) })

  // ③ JSON
  tryFormats.push({ format: 'json', pairs: parseJson(raw) })

  // ④ Cookie 请求头 / 普通键值对
  const headerBody = raw
    .replace(/^\s*cookie\s*:\s*/i, '')
    .replace(/^[\s;]+|[\s;]+$/g, '')
  // 每行一个 k=v、又没有分号，回显成「键值对文本」比说成请求头更贴切
  const kvLike = raw.includes('\n') && !raw.includes(';')
  tryFormats.push({ format: kvLike ? 'kv' : 'cookie-header', pairs: parseKvText(headerBody) })

  for (const { format, pairs } of tryFormats) {
    if (!pairs || !pairs.length) continue
    const built = buildCookie(pairs)
    if (!built.cookie) continue
    return {
      ok: true,
      format,
      cookie: built.cookie,
      count: built.keys.length,
      keys: built.keys,
      dropped: built.dropped,
    }
  }

  return {
    ok: false,
    format: 'kv',
    cookie: '',
    count: 0,
    keys: [],
    dropped: [],
  }
}
