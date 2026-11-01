/**
 * 自定义源出站请求的目标地址护栏。
 *
 * 背景：`lx.request` 直接调 `needle.request`，对目标地址没有任何限制。音源脚本
 * 跑在 vm2 沙箱里无法逃逸，但**不需要逃逸**就能把容器当成内网跳板：脚本可以请求
 * `http://127.0.0.1:<port>/`、`http://192.168.1.246:9527/health`、云环境的
 * `169.254.169.254`，把响应原样返回给前端。实测 246 上 `:9527/health` 无需鉴权
 * 就能拿到 31KB 内部诊断信息。
 *
 * 拦截点选在 `dns.lookup` 而不是「请求前检查 URL」：
 *  1. needle 会自己跟随 302（follow_max: 5），只查首跳的话，一个
 *     `Location: http://127.0.0.1:9527/` 就绕过去了；
 *  2. 域名可以先解析成公网地址通过检查，真正连接时再解析成内网地址（DNS rebinding）。
 * lookup 是 `http.request` 建连前必过的解析环节，每次实际连接都会调用，上面两种
 * 都挡住，且不需要改动 needle。
 *
 * 已知覆盖不到的路径：走 HTTP 代理时，域名由代理侧解析（tunnel agent 自己建 CONNECT），
 * 本 lookup 只校验了「代理是否本机/内网」。这一层风险由代理本身的出口策略承担。
 */

import * as dns from 'dns'
import * as net from 'net'
import { syncLog } from '../utils/log4js'

/** IPv4 保留/私有网段：[网络地址, 前缀位, 说明] */
const V4_RULES: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf-protocol'],
  ['192.0.2.0', 24, 'test-net'],
  ['192.88.99.0', 24, '6to4-relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'test-net'],
  ['203.0.113.0', 24, 'test-net'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
]

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out = (out * 256) + n
  }
  return out >>> 0
}

/**
 * 把 IPv6 展开成 8 个 16 位整数；非法返回 null。
 * 需要展开是因为 `0:0:0:0:0:0:0:1` 与 `::1` 是同一个地址。
 */
const expandIPv6 = (ip: string): number[] | null => {
  let s = ip.toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)

  // 末尾内嵌 IPv4（如 ::ffff:192.168.1.1）先换成两个 16 位组
  let tailGroups: number[] | null = null
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':')
    if (idx < 0) return null
    const v4 = ipv4ToInt(s.slice(idx + 1))
    if (v4 == null) return null
    tailGroups = [(v4 >>> 16) & 0xffff, v4 & 0xffff]
    s = s.slice(0, idx + 1) + '0:0'
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] => {
    if (!part) return []
    return part.split(':').map(g => {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return NaN
      return parseInt(g, 16)
    })
  }
  let head = parse(halves[0])
  let tail = halves.length === 2 ? parse(halves[1]) : []
  if (head.some(Number.isNaN) || tail.some(Number.isNaN)) return null

  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    const groups = [...head, ...new Array(fill).fill(0), ...tail]
    if (tailGroups) {
      groups[6] = tailGroups[0]
      groups[7] = tailGroups[1]
    }
    return groups
  }
  if (tailGroups) {
    head[6] = tailGroups[0]
    head[7] = tailGroups[1]
  }
  return head.length === 8 ? head : null
}

/** 判定单个 IP 是否属于内网/保留地址；命中返回区间名，未命中返回 null */
export function classifyAddress(ip: string): string | null {
  const raw = String(ip || '').trim()
  if (!raw) return null
  const family = net.isIP(raw)

  if (family === 4) {
    const value = ipv4ToInt(raw)
    if (value == null) return null
    for (const [base, bits, label] of V4_RULES) {
      const baseValue = ipv4ToInt(base)
      if (baseValue == null) continue
      // 前缀比较：把两端都右移 (32 - bits) 位再比
      const shift = 32 - bits
      if ((value >>> shift) === (baseValue >>> shift)) {
        return bits === 32 ? label : `${label} ${base}/${bits}`
      }
    }
    return null
  }

  if (family === 6) {
    const g = expandIPv6(raw)
    if (!g) return null
    // ::ffff:a.b.c.d 映射地址按 IPv4 判
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
      const v4 = `${(g[6] >>> 8) & 255}.${g[6] & 255}.${(g[7] >>> 8) & 255}.${g[7] & 255}`
      return classifyAddress(v4)
    }
    // 全 0 与 loopback
    if (g.every(x => x === 0)) return 'unspecified ::'
    if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return 'loopback ::1'
    // fc00::/7
    if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local fc00::/7'
    // fe80::/10
    if ((g[0] & 0xffc0) === 0xfe80) return 'link-local fe80::/10'
    // ff00::/8
    if ((g[0] & 0xff00) === 0xff00) return 'multicast ff00::/8'
    // 64:ff9b::/96 (NAT64) 内嵌 IPv4
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      const v4 = `${(g[6] >>> 8) & 255}.${g[6] & 255}.${(g[7] >>> 8) & 255}.${g[7] & 255}`
      return classifyAddress(v4)
    }
    return null
  }
  return null
}

/** 把 URL 里的 hostname 剥掉方括号（IPv6 字面量在 URL 里是 [::1] 形式） */
const stripBrackets = (host: string): string => {
  const h = String(host || '')
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
}

/**
 * 请求前的字面量校验：hostname 本身写成内网 IP 时直接拒。
 *
 * 为什么光有 lookup 不够：Node 的 net.connect 对 IP 字面量**根本不解析**，
 * lookup 不会被调用——`http://127.0.0.1:9527/` 一路畅通（实测确认）。
 * 域名那一路才交给 lookup 兜（它还能挡住域名解析到内网的情况）。
 *
 * URL 解析失败时不拦：交给 needle 自己报「非法 URL」，与改造前行为一致。
 */
export function checkLiteralTarget(rawUrl: string): { ok: true } | { ok: false, reason: string, host: string } {
  let host = ''
  try {
    host = stripBrackets(new URL(String(rawUrl)).hostname)
  } catch {
    return { ok: true }
  }
  if (!host || !net.isIP(host)) return { ok: true }
  const hit = classifyAddress(host)
  return hit ? { ok: false, reason: hit, host } : { ok: true }
}

/** 拦截日志去重：同一个目标 10 分钟内只记一条，避免脚本轮询把日志刷爆 */
const lastWarnAt = new Map<string, number>()
const WARN_INTERVAL_MS = 10 * 60 * 1000

export function logBlocked(hostname: string, address: string, range: string) {
  const key = `${hostname}->${address}`
  const now = Date.now()
  const prev = lastWarnAt.get(key)
  if (prev && now - prev < WARN_INTERVAL_MS) return
  lastWarnAt.set(key, now)
  if (lastWarnAt.size > 500) lastWarnAt.clear()
  syncLog.warn(`[自定义源] 已拦截内网请求：${hostname} 解析到 ${address}（${range}）。如确需访问请关闭 customSource.blockPrivateNetwork`)
}

/**
 * 构造给 needle 的 `lookup`（needle 会原样透传给 http.request）。
 *
 * @param isEnabled 每个请求实时读一次开关，改配置后无需重载音源即可生效
 */
export function createGuardedLookup(isEnabled: () => boolean) {
  return (hostname: string, options: any, callback: any) => {
    const opts = typeof options === 'object' && options ? options : {}
    const cb = typeof options === 'function' ? options : callback
    const done = (err: any, addresses?: any) => {
      if (err) return cb(err)
      if (opts.all) return cb(null, addresses)
      cb(null, addresses[0].address, addresses[0].family)
    }

    // 开关关掉：完全退回原生行为
    if (!isEnabled()) {
      return dns.lookup(hostname, opts, (err: any, address: any, family: any) => {
        if (err) return cb(err)
        if (opts.all) return cb(null, address)
        cb(null, address, family)
      })
    }

    // 字面量 IP 直接判，不用走 DNS（也覆盖 URL 里写死的内网 IP）
    const literal = stripBrackets(hostname)
    const literalHit = net.isIP(literal) ? classifyAddress(literal) : null
    if (literalHit) {
      logBlocked(hostname, literal, literalHit)
      return cb(Object.assign(new Error(`目标地址属于内网保留网段（${literalHit}），已被自定义源出站护栏拦截: ${hostname}`), { code: 'EBLOCKEDPRIVATE' }))
    }

    dns.lookup(hostname, { ...opts, all: true }, (err: any, list: any) => {
      if (err) return cb(err)
      const addresses: Array<{ address: string, family: number }> = Array.isArray(list) ? list : [list]
      if (!addresses.length) return cb(Object.assign(new Error(`解析不到地址: ${hostname}`), { code: 'ENOTFOUND' }))
      for (const item of addresses) {
        const hit = classifyAddress(item.address)
        if (hit) {
          logBlocked(hostname, item.address, hit)
          return cb(Object.assign(new Error(`目标地址属于内网保留网段（${hit}），已被自定义源出站护栏拦截: ${hostname} → ${item.address}`), { code: 'EBLOCKEDPRIVATE' }))
        }
      }
      done(null, addresses)
    })
  }
}
