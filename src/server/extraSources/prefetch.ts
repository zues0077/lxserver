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
  const username = String(opts.username || '_open')
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
        // 直接按 source 分派，避免 import './index' 形成环（index 会 re-export prefetch）
        const resolver = item.source === 'bili' ? bilibili.getAudioUrl : soda.getAudioUrl
        const resolved = await resolver(item.song, quality, '')
        if (!resolved?.url) throw new Error('取链未返回地址')
        await fileCache.downloadAndCache(
          { ...item.song, quality },
          resolved.url,
          quality,
          username,
          undefined,
          false, // isOnlyDownload
          false, // shouldCacheLyric —— 汽水/B站都没有歌词接口，别让它去白试
          false, // embedLyric
        )
        pending.remove(item.key)
        ok++
        details.push({ key: item.key, name: item.song.name, ok: true })
        console.log(`[汽水待补] ✓ ${item.song.name} 已补入缓存（${resolved.via || '签名通道'}）`)
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
