/**
 * 汽水「待补」清单
 *
 * 用途：会员/版权受限曲在没有签名器的时候必然失败，但这个失败**不是终点** ——
 * 用户可能过几天会开一次 Windows 签名器。把失败的曲目记下来，等签名器在线时批量补，
 * 比让用户凭记忆重新找歌现实得多。
 *
 * 落盘位置：`${DATA_PATH|dataPath}/qishui-pending.json`（与 music-accounts.json 同目录，
 * 这样 WebDAV 同步时它会跟着走；里面只有歌名/歌手/id，不含 Cookie）。
 */

import fs from 'node:fs'
import path from 'node:path'

export interface PendingItem {
  /** source:id，用于去重 */
  key: string
  source: string
  /** 精简后的歌曲信息，够重新取链即可 */
  song: {
    id: string
    source: string
    name: string
    singer: string
    albumName?: string
    interval?: string
    img?: string
    meta?: Record<string, any>
  }
  reason: string
  at: number
  tries: number
  lastError?: string
}

const MAX_ITEMS = 500

function dataDir(): string {
  return process.env.DATA_PATH || (global as any).lx?.dataPath || path.join(process.cwd(), 'data')
}

function filePath(): string {
  return path.join(dataDir(), 'qishui-pending.json')
}

function readAll(): PendingItem[] {
  try {
    const raw = fs.readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(items: PendingItem[]): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    // 先写临时文件再 rename，避免掉电时留下半截 JSON（同 store.ts 的做法）
    const tmp = `${filePath()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(items.slice(0, MAX_ITEMS), null, 2), 'utf-8')
    fs.renameSync(tmp, filePath())
  } catch (e: any) {
    console.log(`[汽水待补] 写入失败：${e?.message || e}`)
  }
}

export function list(): PendingItem[] {
  return readAll().sort((a, b) => b.at - a.at)
}

export function count(): number {
  return readAll().length
}

/** 记一首待补（同 id 只保留一条，tries 累加由 bump 负责） */
export function add(song: any, reason: string, lastError?: string): PendingItem | null {
  const source = String(song?.source || 'soda')
  const id = String(song?.id || song?.songmid || song?.meta?.trackId || '').trim()
  if (!id) return null
  const key = `${source}:${id}`
  const items = readAll()
  const existed = items.find(i => i.key === key)
  if (existed) {
    existed.reason = reason
    existed.lastError = lastError
    existed.at = Date.now()
    writeAll(items)
    return existed
  }
  const item: PendingItem = {
    key,
    source,
    song: {
      id,
      source,
      name: String(song?.name || ''),
      singer: String(song?.singer || ''),
      albumName: String(song?.albumName || ''),
      interval: String(song?.interval || ''),
      img: String(song?.img || ''),
      meta: { trackId: String(song?.meta?.trackId || id) },
    },
    reason,
    at: Date.now(),
    tries: 0,
    lastError,
  }
  items.unshift(item)
  writeAll(items)
  return item
}

export function remove(key: string): void {
  const items = readAll().filter(i => i.key !== key)
  writeAll(items)
}

/** 补传失败：累加次数并记下错误（超过 5 次就不再自动试，避免每轮都撞同一面墙） */
export function bump(key: string, lastError: string): void {
  const items = readAll()
  const hit = items.find(i => i.key === key)
  if (!hit) return
  hit.tries += 1
  hit.lastError = lastError
  hit.at = Date.now()
  writeAll(items)
}

export function clear(): number {
  const n = readAll().length
  writeAll([])
  return n
}

/** 超过 5 次失败不再自动重试 */
export function isExhausted(item: PendingItem): boolean {
  return item.tries >= 5
}
