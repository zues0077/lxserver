/**
 * 歌词兜底链路（2026-11-01）
 *
 * 背景：各平台官方歌词接口都有各自的「隐形门槛」——
 *   - 咪咕要 lrcUrl/mrcUrl（歌单/专辑进来的歌往往没有，旧代码还把它判成「有了」就不查）；
 *   - 酷狗概念版（kglite）根本没有歌词接口，歌曲 hash 却是酷狗主站的，白放着；
 *   - 汽水（soda）曲目详情里明明带逐字歌词，之前完全没用；
 *   - 酷我/QQ 个别曲目（演唱会版、已下架、纯伴奏）接口直接报错。
 * 结果就是「有歌没词」。这里补一条统一兜底：
 *
 *   1. 同族映射：kglite → 酷狗主站歌词；soda → 曲目详情内嵌歌词
 *   2. 跨平台匹配：按「歌名 + 歌手 + 时长」去别人家搜同一首歌再取词
 *      （这正是 Lyricify / Lyrics Helper 的做法，只是我们复用已有的 musicSdk）
 *   3. LRCLIB（lrclib.net，开源免费无需 key）—— 外网，慢且偶发 503，
 *      只作最后一步，带超时 + 熔断，失败不拖累体验
 *
 * 所有结果都有内存缓存（命中 12h / 未命中 30min），并对同 key 请求做去重，
 * 避免一首歌没词时被反复重试把上游打爆。
 */
import musicSdkRaw from '@/modules/utils/musicSdk/index.js'
import * as store from './musicAccount/store'
import { getTrackLyric as getSodaTrackLyric } from './extraSources/soda'
import { durationSeconds, cleanTitle, pickBest, plainToLrc, scoreCandidate } from '@/utils/lyricMatch'
import { resolveMatchTarget } from './xiaoai/musicMatch'

const musicSdk: any = musicSdkRaw as any

export interface LyricTarget {
  source: string
  songmid: string
  name: string
  singer: string
  interval?: string
  hash?: string
  albumId?: string
  copyrightId?: string
  lrcUrl?: string
  mrcUrl?: string
  trcUrl?: string
}

export interface LyricPayload {
  lyric: string
  tlyric?: string
  rlyric?: string
  lxlyric?: string
  /** 命中的兜底通道，仅用于日志/排查，前端可忽略 */
  _fallbackFrom?: string
}

const CACHE_MAX = 800
const TTL_HIT = 12 * 60 * 60 * 1000
const TTL_MISS = 30 * 60 * 1000
/** 跨平台逐个尝试的上限，超出就放弃（歌词不值得让用户等太久） */
const CROSS_BUDGET_MS = 9000
const PER_SOURCE_MS = 5000
const LRCLIB_MS = 3500

const cache = new Map<string, { value: LyricPayload | null; exp: number }>()
const inflight = new Map<string, Promise<LyricPayload | null>>()
/** LRCLIB 熔断：外网在这台 NAS 上偶发 503 / 握手超时，连不上就安静 10 分钟 */
let lrclibDownUntil = 0

export function resetLyricFallbackCache() {
  cache.clear()
  inflight.clear()
  lrclibDownUntil = 0
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(null)
    }, ms)
    Promise.resolve(p).then(
      v => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(v as T)
      },
      () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

/** 能不能当歌词用（空串、纯空白都算没有） */
export function hasLyric(x: any): boolean {
  if (!x) return false
  const text = typeof x === 'string' ? x : (x.lyric ?? x.lrc)
  return typeof text === 'string' && text.trim().length > 0
}

/** 把各种来源的返回统一成前端认识的字段 */
function toPayload(data: any): LyricPayload | null {
  if (!data) return null
  const lyric = String(data.lyric ?? data.lrc ?? '')
  if (!lyric.trim()) return null
  return {
    lyric,
    tlyric: String(data.tlyric ?? ''),
    rlyric: String(data.rlyric ?? ''),
    lxlyric: String(data.lxlyric ?? data.klyric ?? ''),
  }
}

function sdkSearch(source: string, keyword: string, limit = 8): Promise<any[]> {
  const sdk = musicSdk[source]
  if (!sdk?.musicSearch?.search) return Promise.resolve([])
  return Promise.resolve(sdk.musicSearch.search(keyword, 1, limit))
    .then((res: any) => (Array.isArray(res?.list) ? res.list : []))
    .catch(() => [])
}

/** 各平台 getLyric 的参数形态不一样，这里统一包一层 */
function callSdkLyric(source: string, song: any): Promise<any> {
  const sdk = musicSdk[source]
  if (!sdk?.getLyric) return Promise.resolve(null)
  let arg: any = song
  if (source === 'wy') arg = song.songmid
  else if (source === 'kw') arg = { songmid: song.songmid }
  try {
    const req = sdk.getLyric(arg)
    if (req && req.promise) return Promise.resolve(req.promise)
    return Promise.resolve(req)
  } catch {
    return Promise.resolve(null)
  }
}

/**
 * 跨平台找同一首歌取词。
 *
 * 关键：**并发搜、全局挑最高分**，不是「哪个平台先返回就用哪个」。
 * 早先按 wy→tx→kg→kw 顺序取第一个可接受候选，会把「晴天 (原唱 周杰伦) / 某翻唱」
 * 这种标题完全一致的翻唱当成原曲（标题分 1.0 但歌手分 0）；并发后可以和要求
 * 「歌名+歌手+时长」三项都像的那条（酷我原曲 1.0 分）胜出。
 */
async function crossSourceLyric(target: LyricTarget): Promise<LyricPayload | null> {
  const keyword = `${target.name} ${target.singer}`.trim()
  const deadline = Date.now() + CROSS_BUDGET_MS
  const sources = ['wy', 'tx', 'kg', 'kw', 'mg']
    .filter(id => id !== target.source && musicSdk[id]?.getLyric)

  const found = await Promise.all(sources.map(async source => {
    const list = await withTimeout(sdkSearch(source, keyword), PER_SOURCE_MS)
    const usable = (list || []).filter((x: any) => x && x.songmid)
    if (!usable.length) return null
    const best = pickBest(target, usable)
    if (!best) return null
    return { source, song: best, score: scoreCandidate(target, best).score }
  }))

  const ranked = found.filter(Boolean).sort((a: any, b: any) => b.score - a.score) as Array<{ source: string; song: any; score: number }>
  if (process.env.LX_LYRIC_DEBUG) {
    console.log('[歌词兜底] 候选:', ranked.map(r => `${r.source}:${r.song.name}/${r.song.singer}@${r.song.interval}(${r.score.toFixed(2)})`).join(' ; ') || '无')
  }
  for (const item of ranked.slice(0, 3)) {
    if (Date.now() > deadline) break
    const remain = Math.max(1500, deadline - Date.now())
    const data = await withTimeout(
      callSdkLyric(item.source, { ...item.song, interval: item.song.interval || target.interval }),
      Math.min(PER_SOURCE_MS, remain),
    )
    const payload = toPayload(data)
    if (!payload) continue
    payload._fallbackFrom = `cross:${item.source}`
    return payload
  }
  return null
}

/** 酷狗概念版的 songmid 就是酷狗主站的 hash，直接拿去查主站歌词 */
async function kgliteLyric(target: LyricTarget): Promise<LyricPayload | null> {
  const hash = String(target.hash || target.songmid || '').trim()
  if (!hash) return null
  const data = await withTimeout(
    callSdkLyric('kg', {
      name: target.name,
      hash,
      interval: target.interval || '',
      songmid: hash,
    }),
    PER_SOURCE_MS,
  )
  const payload = toPayload(data)
  if (payload) payload._fallbackFrom = 'kglite->kg'
  return payload
}

/** 汽水：曲目详情自带逐字歌词 */
async function sodaLyric(target: LyricTarget): Promise<LyricPayload | null> {
  const id = String(target.songmid || '').trim()
  if (!id) return null
  let cookie = ''
  try {
    const accounts = (store.getCookies('soda') || []) as Array<{ primary?: boolean; cookie?: string }>
    const primary = accounts.find(a => a.primary) || accounts[0]
    cookie = primary?.cookie || ''
  } catch { /* 匿名也能取到公开曲目的歌词 */ }
  const hit = await withTimeout(getSodaTrackLyric(id.replace(/^soda_/i, ''), cookie), 8000)
  if (!hit || !hit.lyric) return null
  return { lyric: hit.lyric, lxlyric: hit.lxlyric, tlyric: '', rlyric: '', _fallbackFrom: 'soda:detail' }
}

/**
 * LRCLIB：开源公共歌词库，无需 key。
 *   - /api/get 按 歌名+歌手(+时长) 精确匹配，时长差 ±2s 内才算命中；
 *   - /api/search 只给 20 条，作为次选自己挑最像的一条。
 */
async function lrclibLyric(target: LyricTarget): Promise<LyricPayload | null> {
  if (process.env.LX_LYRIC_LRCLIB === '0') return null
  if (Date.now() < lrclibDownUntil) return null
  if (!String(target.name || '').trim()) return null
  const base = process.env.LX_LYRIC_LRCLIB_BASE || 'https://lrclib.net'
  const ua = 'lxserver/1.5.50 (https://github.com/zues0077/lxserver)'
  const fetchJson = async (url: string) => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), LRCLIB_MS)
    try {
      const res = await fetch(url, { headers: { 'User-Agent': ua, 'Lrclib-Client': ua }, signal: ctl.signal })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }
  const toLrc = (rec: any): LyricPayload | null => {
    if (!rec || rec.instrumental) return null
    const synced = String(rec.syncedLyrics || '')
    if (synced.trim()) return { lyric: synced, tlyric: '', rlyric: '', lxlyric: '' }
    const plain = String(rec.plainLyrics || '')
    if (plain.trim()) return { lyric: plainToLrc(plain), tlyric: '', rlyric: '', lxlyric: '' }
    return null
  }
  try {
    const dur = durationSeconds(target.interval)
    const params = new URLSearchParams({ track_name: target.name })
    if (target.singer) params.set('artist_name', target.singer)
    if (dur) params.set('duration', String(dur))
    const exact = toLrc(await fetchJson(`${base}/api/get?${params.toString()}`))
    if (exact) {
      exact._fallbackFrom = 'lrclib:get'
      return exact
    }
    const searchParams = new URLSearchParams({ track_name: target.name })
    if (target.singer) searchParams.set('artist_name', target.singer)
    const list = await fetchJson(`${base}/api/search?${searchParams.toString()}`)
    if (Array.isArray(list) && list.length) {
      const best = pickBest(target, list.map((x: any) => ({
        songmid: String(x.id),
        name: x.trackName,
        singer: x.artistName,
        interval: x.duration,
        raw: x,
      })))
      if (best) {
        const hit = toLrc(best.raw)
        if (hit) {
          hit._fallbackFrom = 'lrclib:search'
          return hit
        }
      }
    }
    return null
  } catch {
    // 外网不通 / 503 / 超时：安静 10 分钟，别让每首歌都白等 3.5 秒
    lrclibDownUntil = Date.now() + 10 * 60 * 1000
    return null
  }
}

function cacheKey(t: LyricTarget): string {
  return [t.source, cleanTitle(t.name), cleanTitle(t.singer), durationSeconds(t.interval)].join('|')
}

function readCache(key: string): LyricPayload | null | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (hit.exp < Date.now()) {
    cache.delete(key)
    return undefined
  }
  return hit.value
}

function writeCache(key: string, value: LyricPayload | null) {
  if (cache.size >= CACHE_MAX) {
    // 简单 FIFO 淘汰，够用且不引依赖
    const first = cache.keys().next()
    if (!first.done) cache.delete(first.value)
  }
  cache.set(key, { value, exp: Date.now() + (value ? TTL_HIT : TTL_MISS) })
}

/**
 * 兜底取词。命中缓存直接返回；同一首歌并发请求只打一次上游。
 * 返回 null 表示「确实没有可用歌词」，调用方按「暂无歌词」处理即可。
 */
export async function getFallbackLyric(target: LyricTarget): Promise<LyricPayload | null> {
  if (!target || !String(target.name || '').trim()) return null

  // 视频站/翻唱源的「歌名」其实是一整条标题：
  //   【无损音质】《起风了》-买辣椒也用券  “起风了，也让我想起了那年夏天” / 歌手=西伯利亚麻雀(UP主)
  // 原样拿去跨源搜必然 0 命中（真机实测 2026-11-02：原文 _noOnlineLyric，清洗后同一个 B站曲目
  // 直接返回完整 LRC）。所以进来先收敛成「真歌名 + 真歌手」，匹配基准也跟着换。
  const match = resolveMatchTarget(String(target.name || ''), String(target.singer || ''))
  const normalized: LyricTarget = {
    ...target,
    name: String(match.title || target.name || '').trim(),
    singer: String(match.artist || '').trim(),
  }
  if (normalized.name !== target.name || normalized.singer !== target.singer) {
    console.log(`[歌词兜底] 标题归一：${target.name} / ${target.singer} → ${normalized.name} / ${normalized.singer}`)
  }
  const key = cacheKey(normalized)
  const cached = readCache(key)
  if (cached !== undefined) return cached
  const running = inflight.get(key)
  if (running) return running

  const task = (async (): Promise<LyricPayload | null> => {
    const source = String(normalized.source || '').toLowerCase()
    let hit: LyricPayload | null = null
    if (source === 'soda') hit = await sodaLyric(normalized)
    else if (source === 'kglite') hit = await kgliteLyric(normalized)
    if (!hit) hit = await crossSourceLyric(normalized)
    if (!hit) hit = await lrclibLyric(normalized)
    return hit
  })()
    .catch(() => null)
    .then(res => {
      writeCache(key, res)
      inflight.delete(key)
      return res
    })

  inflight.set(key, task)
  return task
}
