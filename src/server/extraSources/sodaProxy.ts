/**
 * 汽水取链代理（soda-proxy）—— 远程探活与取链
 *
 * 为什么需要它：汽水对**电脑端**不下发整曲（h5 / SEO / 签名器三条通道实测都只有
 * 60 秒试听，且没有 spade_a），而**手机端 App** 取到的 video_model 里每档都带
 * 52 字符的 `spade_a`，能解出整曲（见 sodaKey.ts 头部实测）。
 * 签名本身是 mssdk 逐请求生成、和设备指纹绑定，服务端复刻不了；
 * 所以这里不做签名，只让一台装着官方 App 的设备自己取链，服务端把结果
 * （`main_url` + `spade_a`）取回来 —— 解密仍走仓库现成的 sodaKey 管线，零改动。
 *
 * 配置（二选一，后台面板优先）：
 *
 *   qishui.proxyUrl   ← 后台「汽水签名器」卡片里填（与 signerUrl 同一处）
 *   QISHUI_PROXY_URL=http://192.168.1.246:18090
 *
 * 协议（对应 zues0077/lxserver-soda-proxy）：
 *   GET {base}/health                              → {ok:true, service:'soda-proxy'}
 *   GET {base}/track/{track_id}?name=&fast=1&timeout=N
 *        → {ok, trackId, name, duration, source:'queue-cache'|'search', streams:[…]}
 *
 * 两条路径的代价差得很大，所以拆成两段调用：
 *   fast=1  只查播放队列缓存（约 1~7 秒），覆盖「已经在队列里」的歌；
 *   慢路径   队列没有就走「冷启动 → 搜索 → 点歌 → 等 App 取链」，实测 60~90 秒。
 *
 * 慢路径绝不能放在取流主链路里同步等：用户点歌后干等一分半，体验比「不支持」更差。
 * 所以顺序是「快速档 → 签名器 → 明文通道 → 都拿不到整曲时再决定要不要等慢路径」。
 */

import http from 'node:http'
import https from 'node:https'

const HEALTH_TIMEOUT = 3000
/** 快速档只看队列，正常 1~7 秒；给到 9 秒是给「首次拉 db+wal」留余量 */
const FAST_TIMEOUT = 9000
/** 慢路径（搜索兜底）实测 60~90 秒，留到 150 秒 */
const SLOW_TIMEOUT = 150000
const STATUS_TTL = 60 * 1000

export interface ProxyStatus {
  configured: boolean
  online: boolean
  url: string
  message: string
}

export interface ProxyStream {
  quality: string
  bitrate: number
  size: number
  mainUrl: string
  spadeA: string
  encrypt: boolean
  kid: string
  /** 容器格式（`m4a` / `flac`），决定落地文件扩展名 */
  vtype: string
}

export interface ProxyResult {
  ok: boolean
  source: string
  name: string
  /** App 侧 video_duration（秒） */
  duration: number
  streams: ProxyStream[]
  error: string
}

let statusCache: { at: number; value: ProxyStatus } | null = null
/** 已经安排过后台预热的曲目，避免用户连点把设备挤爆 */
const warmPending = new Map<string, number>()
const WARM_DEDUP_MS = 3 * 60 * 1000

/**
 * 代理地址：后台页面保存的配置优先，其次环境变量。
 * 与签名器同一套路（普通用户不必改 compose，管理页填一次即可）。
 */
export function proxyUrl(): string {
  const cfg = String((global as any).lx?.config?.['qishui.proxyUrl'] || '').trim()
  const raw = cfg || String(process.env.QISHUI_PROXY_URL || '').trim()
  return raw.replace(/\/+$/, '')
}

/** 地址来源，便于界面提示「后台配置 / 环境变量」 */
export function proxySource(): 'config' | 'env' | 'none' {
  const cfg = String((global as any).lx?.config?.['qishui.proxyUrl'] || '').trim()
  if (cfg) return 'config'
  if (String(process.env.QISHUI_PROXY_URL || '').trim()) return 'env'
  return 'none'
}

export function isConfigured(): boolean {
  return proxyUrl().length > 0
}

/**
 * 慢路径（搜索兜底）是否允许**同步等待**。
 *
 * 默认关闭：一次 60~90 秒会把取流请求拖到超时。默认行为是「先快速档，
 * 拿不到就记待补 + 后台预热」，用户重试时命中缓存、秒出整曲。
 * 想在单次请求里死等就设 `qishui.proxy.search=1`（或 QISHUI_PROXY_SEARCH=1）。
 */
export function searchAllowed(): boolean {
  const cfg = String((global as any).lx?.config?.['qishui.proxySearch'] || '').trim()
  const raw = cfg || String(process.env.QISHUI_PROXY_SEARCH || '').trim()
  return raw === '1' || raw.toLowerCase() === 'true'
}

/**
 * 请求代理。这里**刻意不用** musicAccount/http 的 request：
 * 它会挂 `getProxyAgent(url, 'music')`，用户一旦配了音乐出网代理，
 * 打到局域网 192.168.x.x 的请求也会被送去代理出口，直接失败。
 */
function getJson(url: string, timeoutMs: number): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const mod = url.startsWith('https:') ? https : http
    const req = mod.request(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'lxserver-soda-proxy/1.0' },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: any = null
        try { body = text ? JSON.parse(text) : null } catch { body = null }
        done(() => resolve({ status: res.statusCode || 0, body }))
      })
      res.on('error', (e: any) => done(() => reject(e)))
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done(() => reject(new Error(`代理请求超时（${timeoutMs}ms）`)))
    })
    req.on('error', (e: any) => done(() => reject(e)))
    req.end()
  })
}

/** 探活（60 秒缓存，避免每首歌都打一次） */
export async function status(force = false): Promise<ProxyStatus> {
  const base = proxyUrl()
  if (!base) {
    return { configured: false, online: false, url: '', message: '未配置取链代理地址（qishui.proxyUrl）' }
  }
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL) {
    return statusCache.value
  }

  let value: ProxyStatus
  try {
    const resp = await getJson(`${base}/health`, HEALTH_TIMEOUT)
    const ok = resp.status >= 200 && resp.status < 300 && resp.body?.ok !== false
    value = {
      configured: true,
      online: ok,
      url: base,
      message: ok ? '取链代理在线' : `取链代理返回 HTTP ${resp.status}`,
    }
  } catch (e: any) {
    value = {
      configured: true,
      online: false,
      url: base,
      // 离线不是错误：整轮跳过即可，别把用户吓一跳
      message: `取链代理不可达：${e?.message || e}`,
    }
  }
  statusCache = { at: Date.now(), value }
  return value
}

function normalizeStreams(raw: any[]): ProxyStream[] {
  const out: ProxyStream[] = []
  for (const v of raw || []) {
    const url = String(v?.main_url || '')
    if (!url.startsWith('http')) continue
    out.push({
      quality: String(v?.quality || ''),
      bitrate: Number(v?.bitrate) || 0,
      size: Number(v?.size) || 0,
      mainUrl: url,
      spadeA: String(v?.spade_a || ''),
      encrypt: v?.encrypt === true,
      kid: String(v?.kid || ''),
      vtype: String(v?.vtype || 'm4a'),
    })
  }
  out.sort((a, b) => b.bitrate - a.bitrate)
  return out
}

/**
 * 取链。`fast=true` 只查队列缓存（秒级）；`fast=false` 允许走搜索兜底（60~90 秒）。
 *
 * 失败一律返回 `ok:false` + `error`，不抛错 —— 取链代理属于「加分通道」，
 * 挂了也只是退回明文通道，不该让整首歌失败。
 */
export async function resolveStreams(trackId: string, opts: {
  name?: string
  fast?: boolean
  timeoutMs?: number
} = {}): Promise<ProxyResult> {
  const empty: ProxyResult = { ok: false, source: '', name: '', duration: 0, streams: [], error: '' }
  const base = proxyUrl()
  if (!base) return { ...empty, error: '未配置取链代理地址（qishui.proxyUrl）' }

  const fast = opts.fast !== false
  const timeoutMs = opts.timeoutMs ?? (fast ? FAST_TIMEOUT : SLOW_TIMEOUT)
  const params = new URLSearchParams()
  if (opts.name) params.set('name', opts.name)
  if (fast) params.set('fast', '1')
  // 让代理侧也按同一个预算收手，避免它比自己停得更晚
  params.set('timeout', String(Math.max(5, Math.round(timeoutMs / 1000) - 5)))
  const url = `${base}/track/${encodeURIComponent(trackId)}?${params.toString()}`

  try {
    const resp = await getJson(url, timeoutMs)
    const body: any = resp.body || {}
    if (body.ok !== true) {
      return {
        ...empty,
        error: String(body.error || `代理返回 HTTP ${resp.status}`),
        source: String(body.source || ''),
      }
    }
    const streams = normalizeStreams(body.streams || [])
    return {
      ok: streams.length > 0,
      source: String(body.source || ''),
      name: String(body.name || ''),
      duration: Number(body.duration) || 0,
      streams,
      error: streams.length ? '' : '代理返回的 video_list 为空',
    }
  } catch (e: any) {
    return { ...empty, error: e?.message || String(e) }
  }
}

/**
 * 后台预热：把整首「冷启动 → 搜索 → 点歌 → 等取链」丢到后台跑，
 * 用户下次点同一首时快速档就能命中（约 1 秒出整曲）。
 *
 * 不 await、结果只写日志 —— 失败也不该影响当前这次请求的报错文案。
 */
export function warmUp(trackId: string, name: string): void {
  if (!isConfigured()) return
  const key = String(trackId)
  const now = Date.now()
  const at = warmPending.get(key)
  if (at && now - at < WARM_DEDUP_MS) return
  // 顺手清掉过期记录，避免长期运行时无界增长
  for (const [k, t] of warmPending) if (now - t > WARM_DEDUP_MS) warmPending.delete(k)
  warmPending.set(key, now)

  console.log(`[汽水取链] 后台预热开始：${key} ${name || ''}`)
  void resolveStreams(key, { name, fast: false })
    .then(r => {
      if (r.ok) console.log(`[汽水取链] 后台预热成功：${key} ${r.name || name || ''} ${r.streams.length} 档（${r.source}）`)
      else console.log(`[汽水取链] 后台预热失败：${key} ${r.error}`)
    })
    .catch((e: any) => console.log(`[汽水取链] 后台预热异常：${key} ${e?.message || e}`))
}

/** 后台预热的曲目是否还在跑（诊断用） */
export function isWarming(trackId: string): boolean {
  const at = warmPending.get(String(trackId))
  return !!at && Date.now() - at < WARM_DEDUP_MS
}

/** 测试用：清掉探活缓存与预热记录 */
export function resetStatusCache(): void {
  statusCache = null
  warmPending.clear()
}
