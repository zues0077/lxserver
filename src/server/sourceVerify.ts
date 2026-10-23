/**
 * 源侧来源核验：拿「音源自己搜到的曲目」当第三方裁判。
 *
 * 触发场景：缓存落盘前、缓存命中后的旁路核验、存量缓存体检。
 * 判据本身是纯函数（`@/utils/audioGuard` 的 judgeOriginMismatch），这里只负责：
 *   1. 把搜索请求打出去（带缓存与超时预算，避免把投送/命中的延迟拖长）
 *   2. 搜索失败一律 fail-open（返回 unknown），绝不因为音源抽风就删掉用户正常缓存
 *
 * 为什么只查「同源」：请求里的 source/songmid 决定了音源脚本用哪个平台解析，
 * 兜底行为也发生在同一个平台上（它按歌名在这个平台重新搜了一遍）。
 * 跨平台搜索虽然能补充信息，但曲目库差异太大，容易把翻唱/译名差异算成不匹配。
 */
// @ts-ignore
import musicSdkRaw from '@/modules/utils/musicSdk/index.js'
import { judgeOriginMismatch, parseIntervalSec, type OriginCandidate, type OriginVerdict } from '@/utils/audioGuard'
import { syncLog } from '@/utils/log4js'

const musicSdk = musicSdkRaw as any

/** 单次搜索最多取多少条候选（20 条足够覆盖同名同歌手的多版本） */
const SEARCH_LIMIT = 20
/** 单次搜索的硬预算：超时就当没查到，不阻塞落盘 */
const SEARCH_TIMEOUT_MS = 3000
/** 搜索缓存有效期：同一首歌短时间内的核验不重复请求音源 */
const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_MAX_ENTRIES = 300

interface SearchEntry {
    at: number
    items: OriginCandidate[]
    failed: boolean
}

const searchCache = new Map<string, SearchEntry>()

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> => {
    let timer: NodeJS.Timeout | undefined
    return Promise.race([
        promise.catch(() => null),
        new Promise<null>(resolve => {
            timer = setTimeout(() => resolve(null), ms)
        }),
    ]).finally(() => {
        if (timer) clearTimeout(timer)
    }) as Promise<T | null>
}

const pruneCache = (now: number) => {
    for (const [key, entry] of searchCache) {
        if (now - entry.at >= CACHE_TTL_MS) searchCache.delete(key)
    }
    while (searchCache.size > CACHE_MAX_ENTRIES) {
        const oldest = searchCache.keys().next()
        if (oldest.done) break
        searchCache.delete(oldest.value)
    }
}

/**
 * 搜索某个平台上的曲目，返回归一化后的候选列表。
 * 返回 null 表示「没查到/查不了」，调用方必须按 fail-open 处理。
 */
const searchCandidates = async (
    source: string,
    name: string,
    singer: string,
): Promise<OriginCandidate[] | null> => {
    const api = musicSdk?.[source]?.musicSearch
    if (!api?.search) return null

    const key = `${source}|${name}|${singer}`.toLowerCase()
    const now = Date.now()
    const hit = searchCache.get(key)
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.failed ? null : hit.items

    const query = [name, singer].filter(Boolean).join(' ')
    const raw = await withTimeout(
        Promise.resolve().then(() => api.search(query, 1, SEARCH_LIMIT)),
        SEARCH_TIMEOUT_MS,
    )
    const list: any[] | null = Array.isArray(raw?.list) ? raw.list : null

    pruneCache(now)
    if (!list) {
        searchCache.set(key, { at: now, items: [], failed: true })
        return null
    }

    const items: OriginCandidate[] = list.slice(0, SEARCH_LIMIT).map(item => ({
        name: item?.name ?? item?.title,
        singer: item?.singer ?? item?.artist,
        interval: item?.interval,
        songmid: item?.songmid ?? item?.id ?? item?.hash,
    }))
    searchCache.set(key, { at: now, items, failed: false })
    return items
}

export interface OriginCheckResult extends OriginVerdict {
    /** 是否真的向音源发起了查询（短路或缓存命中时为 false） */
    searched: boolean
    /** 实际参与判定的候选条数 */
    candidateCount: number
}

/**
 * 这个来源能不能回查音源。
 *
 * `local`（本地音乐/直链下载）没有对应的音源脚本，谈不上「音源兜底返回别曲」——
 * 体检时这类条目必须直接放过，否则报告里会堆满「无法判定」，把真正可疑的几条埋掉。
 */
export const canVerifyOrigin = (source: string | undefined | null): boolean => {
    const key = String(source || '').trim()
    if (!key) return false
    return !!musicSdk?.[key]?.musicSearch?.search
}

/**
 * 核验一份音频的来源是否与请求的曲目一致。
 *
 * @param songInfo 至少包含 name / source，url 解析来源同源
 * @param actualSec 音频文件真实时长（秒），必须由调用方解码得出，不接受「索引里登记的时长」
 */
export const verifyTrackOrigin = async (
    songInfo: {
        name?: string
        title?: string
        singer?: string
        source?: string
        interval?: string
        meta?: any
    },
    actualSec: number,
    options: { expectedSec?: number } = {},
): Promise<OriginCheckResult> => {
    const name = String(songInfo?.name || songInfo?.title || '').trim()
    const singer = String(songInfo?.singer || '').trim()
    const source = String(songInfo?.source || '').trim()
    const actual = Math.max(0, Math.round(Number(actualSec) || 0))
    const expected = options.expectedSec ?? parseIntervalSec(songInfo?.interval ?? songInfo?.meta?.interval)

    if (!name || !source || actual <= 0) {
        return { verdict: 'unknown', searched: false, candidateCount: 0 }
    }

    const items = await searchCandidates(source, name, singer)
    if (!items || !items.length) {
        return { verdict: 'unknown', searched: true, candidateCount: 0 }
    }

    const verdict = judgeOriginMismatch({
        requestName: name,
        requestSinger: singer,
        expectedSec: expected,
        actualSec: actual,
        candidates: items,
    })
    if (verdict.verdict === 'suspect') {
        // 只在这里记一条 WARN，调用方按需再补上下文（文件名/用户），避免同一事实写两遍
        syncLog.warn(`[文件缓存] 源侧核验不通过（${source}）：${name}${singer ? ` - ${singer}` : ''}｜${verdict.reason}`)
    }
    return { ...verdict, searched: true, candidateCount: items.length }
}

/** 供体检使用：清空搜索缓存，强制重新问音源 */
export const clearOriginSearchCache = () => {
    searchCache.clear()
}
