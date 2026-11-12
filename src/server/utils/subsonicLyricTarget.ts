/**
 * Subsonic getLyrics → 在线歌词兜底链的入参适配（2026-11-12）。
 *
 * 背景（14:00 报告第 9 节）：客户端 Amcfy Music 通过 17950 播放 8 首歌，
 * 只有 1 首出歌词。根因是 7 首的 id 前缀为 soda_ / bili_ / kglite_，
 * 这些源不在 musicSdk 里，handleGetLyricsBySongId 直接返回 error 70
 * 「Song or source not supported」。
 *
 * 本地已有完整兜底链 lyricFallback.getFallbackLyric（soda 详情 / kglite→kg /
 * 跨源 / LRCLIB / B站字幕，带缓存、单飞、超时预算），/api/music/lyric 已在用。
 * 缺的只是把 Subsonic 的 id / artist / title 适配成它的 LyricTarget。
 *
 * 这里刻意做成**纯函数、零运行时依赖**（只 import type），便于用那 8 首真实 id
 * 做回归单测，不用拉起整个 Subsonic 类与 musicSdk。
 */

import type { LyricTarget } from '../lyricFallback'

export const SUBSONIC_LYRIC_ID_SEP = '_'

/** 拆 id 的 source / songmid。无下划线（或以下划线开头）时 source 为空、songmid 为整个 id。 */
export const splitSubsonicLyricId = (id: string): { source: string, songmid: string } => {
  const raw = String(id || '')
  const idx = raw.indexOf(SUBSONIC_LYRIC_ID_SEP)
  if (idx <= 0) return { source: '', songmid: raw }
  return { source: raw.slice(0, idx), songmid: raw.slice(idx + 1) }
}

export interface SubsonicLyricMeta {
  name?: string
  singer?: string
  interval?: string
  hash?: string
  albumId?: string
  copyrightId?: string
  lrcUrl?: string
  mrcUrl?: string
  trcUrl?: string
  meta?: Record<string, any>
}

/**
 * 构造 LyricTarget。
 * - name 优先用 findMusicById 补到的真实歌名，其次用 Subsonic 请求的 title；
 * - singer 同理；
 * - 后 3 源即使不在 musicSdk 里，也能靠 name + singer 走跨源 / LRCLIB / 字幕兜底；
 * - getFallbackLyric 内部还会做标题归一（把 B站整条视频标题收敛成真歌名）。
 */
export const buildSubsonicLyricTarget = (
  id: string,
  artist: string,
  title: string,
  musicMeta?: SubsonicLyricMeta | null,
): LyricTarget => {
  const { source, songmid } = splitSubsonicLyricId(id)
  const m: any = musicMeta || {}
  const nested = m.meta || {}
  return {
    source,
    songmid,
    name: String(m.name || title || '').trim(),
    singer: String(m.singer || artist || '').trim(),
    interval: String(m.interval || ''),
    hash: String(m.hash || nested.hash || ''),
    albumId: String(m.albumId || nested.albumId || ''),
    copyrightId: String(m.copyrightId || nested.copyrightId || ''),
    lrcUrl: String(m.lrcUrl || nested.lrcUrl || ''),
    mrcUrl: String(m.mrcUrl || nested.mrcUrl || ''),
    trcUrl: String(m.trcUrl || nested.trcUrl || ''),
  }
}
