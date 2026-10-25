/**
 * 待补清单 → 缓存池 的补传器（L2 骨架）
 *
 * 只做一件事：签名器在线时，把 `qishui-pending.json` 里的受限曲重新取链、下载进 NAS 缓存。
 * 缓存、队列、播放全用现成实现（fileCache.downloadAndCache + preferServerCache），这里不碰。
 *
 * 之所以「先做骨架」：签名器协议与设备指纹还没实测，先把
 * 「探活 → 取链 → 落盘 → 移出清单 / 记失败」这条控制流跑通，接真签名器时只换 signer 模块。
 */

import * as fileCache from '../fileCache'
import * as store from '../musicAccount/store'
import * as soda from './soda'
import * as bilibili from './bilibili'
import * as pending from './pending'
import * as signer from './signer'

export interface FlushOptions {
  username?: string
  quality?: string
  /** 单轮最多补几首（默认 10） */
  limit?: number
  /** true = 即使探活失败也尝试（仅用于排查/测试） */
  force?: boolean
}

export interface FlushResult {
  started: boolean
  reason?: string
  message: string
  total: number
  ok: number
  failed: number
  skipped: number
  items?: Array<{ key: string; name: string; ok: boolean; message?: string }>
}

let running = false
let lastRun: { at: number; result: FlushResult } | null = null

export function isRunning(): boolean {
  return running
}

export function lastResult(): { at: number; result: FlushResult } | null {
  return lastRun
}

/**
 * 执行一轮补传。
 * 串行执行：受限曲本来就要走签名器，并发只会让签名器排队更难排查。
 */
export async function flush(opts: FlushOptions = {}): Promise<FlushResult> {
  if (running) {
    return { started: false, reason: 'already-running', message: '已有补传任务在进行中', total: 0, ok: 0, failed: 0, skipped: 0 }
  }

  const items = pending.list()
  if (!items.length) {
    return { started: false, reason: 'empty', message: '待补清单为空', total: 0, ok: 0, failed: 0, skipped: 0 }
  }

  const st = await signer.status()
  if (!st.configured) {
    return {
      started: false,
      reason: 'signer-not-configured',
      message: `未配置签名器（QISHUI_SIGNER_URL），${items.length} 首待补曲已记录，等签名器接上后会自动补`,
      total: items.length,
      ok: 0,
      failed: 0,
      skipped: items.length,
    }
  }
  if (!st.online && !opts.force) {
    return {
      started: false,
      reason: 'signer-offline',
      message: `${st.message}，本轮跳过（不影响已缓存内容）`,
      total: items.length,
      ok: 0,
      failed: 0,
      skipped: items.length,
    }
  }

  running = true
  const quality = String(opts.quality || '320k')
  const fallbackUser = String(opts.username || '_open')
  const limit = Math.max(1, Math.min(Number(opts.limit) || 10, 50))
  const details: NonNullable<FlushResult['items']> = []
  let ok = 0
  let failed = 0
  let skipped = 0

  try {
    for (const item of items.slice(0, limit)) {
      if (pending.isExhausted(item)) {
        skipped++
        details.push({ key: item.key, name: item.song.name, ok: false, message: `已失败 ${item.tries} 次，跳过` })
        continue
      }
      try {
        // 落回「当时是谁在播」的目录：优先用清单里记的用户，其次才是调用方指定的。
        // 以前固定 _open，导致登录用户的配额/统计/清理都算不到他头上。
        const owner = String(item.username || fallbackUser || '_open')
        // 必须带账号 Cookie：受限曲是「签名器解接口 + 会员账号解版权」两件事，
        // 早期骨架这里传空串，补传对受限曲只会反复拿到 30s 试听而一直失败。
        const cookie = store.getCookie(item.source) || ''
        // 直接按 source 分派，避免 import './index' 形成环（index 会 re-export prefetch）
        const resolved = item.source === 'bili'
          ? await bilibili.getAudioUrl(item.song, quality, cookie)
          : await soda.getAudioUrl(item.song, quality, cookie, owner)
        if (!resolved?.url) throw new Error('取链未返回地址')
        await fileCache.downloadAndCache(
          { ...item.song, quality },
          resolved.url,
          quality,
          owner,
          undefined,
          false, // isOnlyDownload
          false, // shouldCacheLyric —— 汽水/B站都没有歌词接口，别让它去白试
          false, // embedLyric
        )
        pending.remove(item.key)
        ok++
        details.push({ key: item.key, name: item.song.name, ok: true })
        console.log(`[汽水待补] ✓ ${item.song.name} 已补入缓存（${resolved.via || '签名通道'} → ${owner}）`)
      } catch (e: any) {
        const msg = String(e?.message || e)
        pending.bump(item.key, msg)
        failed++
        details.push({ key: item.key, name: item.song.name, ok: false, message: msg })
        console.log(`[汽水待补] ✗ ${item.song.name}：${msg}`)
      }
    }
  } finally {
    running = false
  }

  const result: FlushResult = {
    started: true,
    message: `本轮补传完成：成功 ${ok}，失败 ${failed}${skipped ? `，跳过 ${skipped}` : ''}`,
    total: items.length,
    ok,
    failed,
    skipped,
    items: details,
  }
  lastRun = { at: Date.now(), result }
  return result
}

// ---------- 自动补传：签名器一上线就自己补，不用去后台点按钮 ----------

const DEFAULT_AUTO_INTERVAL_MS = 3 * 60 * 1000

export interface AutoState {
  enabled: boolean
  intervalMs: number
  startedAt: number
  /** 最近一次检查时间（不管有没有动手） */
  lastTickAt: number
  /** 最近一次没动手的原因，空串 = 上次真的在补 */
  lastSkip: string
  rounds: number
}

let autoTimer: ReturnType<typeof setInterval> | null = null
let autoKickTimer: ReturnType<typeof setTimeout> | null = null
const autoState: AutoState = {
  enabled: false,
  intervalMs: DEFAULT_AUTO_INTERVAL_MS,
  startedAt: 0,
  lastTickAt: 0,
  lastSkip: '',
  rounds: 0,
}

export function autoStatus(): AutoState {
  return { ...autoState }
}

/** 后台可关：config['qishui.prefetch.auto'] = false（缺省视为开） */
function autoDisabledByConfig(): boolean {
  const v = (global as any).lx?.config?.['qishui.prefetch.auto']
  return v === false || v === 'false' || v === 0 || v === '0'
}

/** 跑一次检查（定时器内部用；导出是为了能单测 / 手动触发） */
export async function runAutoOnce(): Promise<void> {
  autoState.lastTickAt = Date.now()
  if (running) { autoState.lastSkip = 'already-running'; return }
  if (autoDisabledByConfig()) { autoState.lastSkip = 'disabled-by-config'; return }
  const items = pending.list()
  if (!items.length) { autoState.lastSkip = 'empty'; return }
  // 探活失败不是错误：签名器没开/没配本来就是常态，等它上线
  const st = await signer.status().catch(() => null)
  if (!st?.configured) { autoState.lastSkip = 'signer-not-configured'; return }
  if (!st.online) { autoState.lastSkip = 'signer-offline'; return }

  autoState.lastSkip = ''
  autoState.rounds += 1
  // 每轮最多 3 首：补传和正在播放的请求共用同一个签名器，大批量会把播放拖慢
  const r = await flush({ limit: 3 }).catch((e: any) => {
    console.log(`[汽水待补] 自动补传异常：${e?.message || e}`)
    return null
  })
  if (r?.started) console.log(`[汽水待补] 自动补传第 ${autoState.rounds} 轮：${r.message}`)
}

/**
 * 开启定时补传。幂等：重复调用不会叠加定时器。
 * 默认每 3 分钟检查一次，启动后 45 秒先试一轮（等唱针/网络就绪）。
 */
export function startAuto(intervalMs?: number): void {
  if (autoTimer) return
  const ms = Math.max(
    60_000,
    Number(intervalMs) || Number(process.env.QISHUI_PREFETCH_INTERVAL_MS) || DEFAULT_AUTO_INTERVAL_MS,
  )
  autoState.enabled = true
  autoState.intervalMs = ms
  autoState.startedAt = Date.now()
  autoTimer = setInterval(() => { void runAutoOnce() }, ms)
  autoTimer.unref?.()
  autoKickTimer = setTimeout(() => { void runAutoOnce() }, 45_000)
  autoKickTimer.unref?.()
  console.log(`[汽水待补] 自动补传已开启：每 ${Math.round(ms / 60000)} 分钟检查一次（签名器在线且有清单才动手）`)
}

export function stopAuto(): void {
  if (autoTimer) clearInterval(autoTimer)
  if (autoKickTimer) clearTimeout(autoKickTimer)
  autoTimer = null
  autoKickTimer = null
  autoState.enabled = false
}

