/**
 * 八源聚合（source=all）的搜索路由 + 结果归一化。
 *
 * ## 背景（T9 八平台聚合）
 * 此前 `fetchOnlineSearchSongs` 只循环 `musicSdk` 的五个官方源
 * （wy/tx/kw/kg/mg），bilibili / 汽水 / 概念版（kglite）虽有现成的
 * `searchSongs`，却没接进聚合循环——`source=all` 实际只搜到 5 源。
 *
 * 这里把「非 musicSdk 的三家」抽成一个统一入口：
 *   1. `EXTRA_SEARCH_SOURCES` / `ALL_AGGREGATE_SOURCES` —— 8 源清单；
 *   2. `searchExtraSource(source, kw, page, pageSize)` —— 路由到对应 searchSongs；
 *   3. `adaptExtraSearchItem(raw, source)` —— 把三家返回结构补齐 / 统一成
 *      `LX.Music.MusicInfo` 期望的字段，避免改动五行 musicSdk 的既有映射。
 *
 * 设计要点：
 * - kglite 与 kg 同源（都是酷狗曲库），但用户明确要求「独立搜」，所以当作
 *   独立源接入（id 带 `kglite_` 前缀，保证跨源 id 不撞）。
 *   注意：`fetchOnlineSearchSongs` 之后还有一层跨源同名去重
 *   （key = 歌名@主歌手，priority 里 kg 排在 kglite 之前），因此 source=all
 *   的输出里 kglite 的同曲通常被折叠进 kg —— **歌曲不丢，只是不单独显名**；
 *   单源 `kglite:` 搜索不受影响。
 * - kglite 搜索**匿名即可**（searchSongs 无凭据时造最小设备指纹），
 *   不必依赖已配置的账号 Cookie，聚合搜索不会因缺账号而缺席。
 * - bilibili 匿名可搜，但会抛 412 风控 / 非 0 code；soda 匿名可用。
 *   这些失败由 `fetchOnlineSearchSongs` 的逐源 try/catch 静默吞掉，
 *   不影响其它源。
 */

import { searchSongs as biliSearchSongs } from '@/server/extraSources/bilibili'
import { searchSongs as sodaSearchSongs } from '@/server/extraSources/soda'
import { searchSongs as kgliteSearchSongs } from '@/server/musicAccount/resolvers/kglite'

/** musicSdk 的五个官方源（取链走官方 SDK）。 */
export const MUSIC_SDK_SOURCES = ['wy', 'tx', 'kw', 'kg', 'mg'] as const

/** 走各自 searchSongs 的三家服务端源。 */
export const EXTRA_SEARCH_SOURCES = ['bili', 'soda', 'kglite'] as const

/** 八平台聚合的完整清单（source=all / all: 前缀展开用）。 */
export const ALL_AGGREGATE_SOURCES = [...MUSIC_SDK_SOURCES, ...EXTRA_SEARCH_SOURCES] as const

/** 概念版/汽水/bili 都能给的「可用音质」占位（搜索阶段没有真 URL，播放时再解析）。 */
const FULL_QUALITY_TYPES = [
  { type: '128k' },
  { type: '320k' },
  { type: 'flac' },
  { type: 'flac24bit' },
] as const

/** 秒数 → "mm:ss"（kglite 的 interval 是数字秒，需要标准化成 LX 约定的字符串）。 */
export function secToInterval(sec: number): string {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 判断某源是不是「非 musicSdk 的服务端源」。 */
export function isExtraSearchSource(source: string): boolean {
  return (EXTRA_SEARCH_SOURCES as readonly string[]).includes(source)
}

/**
 * 路由到三家各自的 searchSongs。返回结构统一为 `{ list }`，
 * 与 musicSdk 的 `musicSearch.search` 返回形态一致，方便上层统一取 `.list`。
 *
 * kglite 传空 Cookie → 匿名搜索（造最小设备指纹），不依赖账号配置。
 */
export async function searchExtraSource(
  source: string,
  keyword: string,
  page: number,
  pageSize: number,
): Promise<{ list: any[] }> {
  if (source === 'bili') return biliSearchSongs(keyword, page, pageSize)
  if (source === 'soda') return sodaSearchSongs(keyword, page, pageSize)
  if (source === 'kglite') return kgliteSearchSongs(keyword, page, pageSize) // 匿名也能搜
  return { list: [] }
}

/**
 * 把三家 searchSongs 的原始返回项补齐 / 统一成映射层需要的字段。
 * 仅处理 bili/soda/kglite（musicSdk 五源不进这里，保持原映射零变更）。
 *
 * 主要补齐：
 * - kglite 没有 `types` 数组（只有 `quality`）→ 给一组占位音质，否则前端不显示可播放音质；
 * - kglite 的专辑叫 `album` 而非 `albumName` → 归一；
 * - kglite 的 `interval` 是数字秒 → 标准化成 "mm:ss"；
 * - 统一补 `hash` / `meta` 结构（picUrl / albumName / albumId），与五行源对齐。
 */
export function adaptExtraSearchItem(raw: any, source: string): any {
  if (!isExtraSearchSource(source)) return raw

  const interval =
    typeof raw?.interval === 'number' ? secToInterval(raw.interval) : (raw?.interval || '0')
  const albumName = raw?.albumName || raw?.album || ''
  const albumId = raw?.albumId ?? ''
  const types =
    Array.isArray(raw?.types) && raw.types.length
      ? raw.types
      : source === 'kglite'
        ? [...FULL_QUALITY_TYPES]
        : (raw?.types || [])
  const hash = raw?.hash || ''

  return {
    ...raw,
    interval,
    _interval: raw?._interval || interval,
    albumName,
    albumId,
    types,
    _types: raw?._types || {},
    hash,
    meta: {
      ...(raw?.meta || {}),
      hash,
      picUrl: raw?.img || '',
      albumName,
      albumId,
    },
  }
}
