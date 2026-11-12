/**
 * 聚合搜索联想词（P2-1，对标上游「聚合搜索关键词联想」）。
 *
 * 本地事实（改动前盘点，勿套上游实现）：
 * - 八源聚合是「搜索」能力（aggregateSearch.ts 的 ALL_AGGREGATE_SOURCES =
 *   wy/tx/kw/kg/mg + bili/soda/kglite），联想词能力只来自 musicSdk 的
 *   tipSearch 接口，注册表里只有前五个官方源；
 * - bili / soda 在 extraSources 里只有 searchSongs，没有平台 autocomplete；
 * - kglite 与 kg 同酷狗曲库，server.ts 的 artistDetail / artistSongs /
 *   albumSongs 已有 `source === 'kglite' ? 'kg' : source` 的转调先例；
 * - 前端 public/music/app.js 已有完整的 initSearchTips / fetchSearchTips /
 *   renderSearchTips / 防抖 / 方向键 / AbortController 绑定，只认一个字符串数组。
 *   因此本模块只负责「归一源 → 并发取词 → 合并 → 缓存」，不新增前端 IIFE，
 *   也不改动既有键盘绑定（三套绑定抢同一个 input 会打架）。
 */

import { MUSIC_SDK_SOURCES } from './aggregateSearch'

/** 真正具备联想词能力的源，直接复用八源聚合里的 musicSdk 五源常量。 */
export const TIP_SOURCES: readonly string[] = MUSIC_SDK_SOURCES

/**
 * 把前端传来的 source 归一为真正有联想能力的源列表。
 * - `all`（默认「聚合」）→ 五个 musicSdk 源并发；
 * - `kglite` → 转调 `kg`（同曲库，联想词与音质/取链/账号无关）；
 * - 五源之一 → 只查该源；
 * - bili / soda / 未知 → 空数组，接口诚实返回 []，不伪造「8/8 全覆盖」。
 */
export const resolveTipProviders = (source: string): string[] => {
  const normalized = (source || 'kw').trim().toLowerCase()
  if (normalized === 'all') return [...TIP_SOURCES]
  if (normalized === 'kglite') return ['kg']
  return (TIP_SOURCES as readonly string[]).includes(normalized) ? [normalized] : []
}

const normalize = (text: string): string => text
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/\s*[-–—]\s*/g, ' - ')
  .replace(/\s+/g, ' ')

/**
 * 多源联想词合并：按「多少源都推了这个词 → 是否精确/前缀命中 → 原排名 → 平台序」
 * 的字典序排。不引入权重 / 覆盖度 / 阈值这类需要拍脑袋调参的评分
 * （用户 2026-11-10 定规：比较层要简单可解释）。
 */
export const mergeTipGroups = (groups: string[][], query: string, limit = 10): string[] => {
  const keyword = normalize(query)
  const words = new Map<string, { text: string, votes: number, rank: number, source: number, match: number }>()
  groups.forEach((group, sourceIndex) => {
    const seen = new Set<string>()
    group.forEach((text, rank) => {
      if (typeof text !== 'string' || !text.trim()) return
      const key = normalize(text)
      if (!key || seen.has(key)) return
      seen.add(key)
      const existing = words.get(key)
      if (existing) {
        existing.votes++
        existing.rank = Math.min(existing.rank, rank)
        return
      }
      words.set(key, {
        text: text.trim(),
        votes: 1,
        rank,
        source: sourceIndex,
        match: key === keyword ? 2 : key.startsWith(keyword) ? 1 : 0,
      })
    })
  })
  return [...words.values()]
    .sort((a, b) => b.votes - a.votes || b.match - a.match || a.rank - b.rank || a.source - b.source)
    .slice(0, limit)
    .map(w => w.text)
}

const TTL_MS = 60_000
const CAPACITY = 100
const cache = new Map<string, { tips: string[], expires: number }>()

const cacheKey = (provider: string, query: string) => `${provider}:${normalize(query)}`

export const getCachedTips = (provider: string, query: string, now: () => number = Date.now): string[] | null => {
  const key = cacheKey(provider, query)
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expires <= now()) {
    cache.delete(key)
    return null
  }
  return entry.tips
}

export const setCachedTips = (provider: string, query: string, tips: string[], now: () => number = Date.now): void => {
  // 空结果不缓存：可能只是上游暂时不可用，下次应重试（与上游 search_suggestions.js 同口径）
  if (!tips.length) return
  const key = cacheKey(provider, query)
  cache.delete(key)
  cache.set(key, { tips, expires: now() + TTL_MS })
  while (cache.size > CAPACITY) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 清缓存，供单测隔离用。 */
export const clearTipCache = (): void => { cache.clear() }

/**
 * 单源联想请求：超时兜底 + 只保留字符串、最多 30 条。
 * 注意：musicSdk 的 tipSearch 没有 abort 入口，超时只能放弃等待、无法取消底层请求；
 * 因此服务端必须自带超时与缓存，否则快速打字会在服务端堆积请求
 * （前端的 AbortController 只取消浏览器侧 fetch，传不到这里）。
 */
export const fetchProviderTips = async (
  provider: string,
  query: string,
  fetcher: (source: string, keyword: string) => Promise<unknown>,
  timeoutMs = 2000,
): Promise<string[]> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => fetcher(provider, query)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('tipSearch timeout')), timeoutMs)
      }),
    ])
    if (!Array.isArray(raw)) return []
    return raw.filter((t): t is string => typeof t === 'string' && !!t.trim()).slice(0, 30)
  } catch {
    return []
  } finally {
    if (timer) clearTimeout(timer)
  }
}
