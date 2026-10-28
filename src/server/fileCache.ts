

import fs from 'fs'
import type { Stats } from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import crypto from 'crypto'
import { PassThrough } from 'stream'
const { MusicTagger, MetaPicture } = require('music-tag-native')
import { buildLyrics, parseLyrics } from '../utils/lrcTool'
import { formatPlayTime } from '../utils/common'
import { judgeAudioMismatch, judgeMetadataMismatch } from '@/utils/audioGuard'
import { verifyTrackOrigin, canVerifyOrigin } from './sourceVerify'
import { buildStreamHeaders } from './utils/streamHeaders'
import { syncLog } from '@/utils/log4js'
import { getUserSpace } from '../user'
import { decryptAudioBuffer, decryptAudioBufferAsync, isCencEncryptedBuffer, getSodaKey, sodaTrackIdOf, type DecryptResult } from './utils/sodaDecrypt'

/**
 * 匿名用户的目录名必须统一成 `_open`（P-0806）。
 * 上游把匿名写成 undefined / '' / default / open / _open 五种样子都见过，
 * 少归一一个就会在 cache/ 下留出 `open/` 这种**统计、配额、清理、播放命中全都看不见**的幽灵目录。
 * 所有按用户区分的目录/索引/配额计算必须走这里，不要再手写三元表达式。
 */
export const ANONYMOUS_USER_ALIASES = ['', 'open', '_open', 'default']

export const normalizeUsername = (username?: string | null): string => {
    const name = typeof username === 'string' ? username.trim() : ''
    if (!name) return '_open'
    return ANONYMOUS_USER_ALIASES.includes(name) ? '_open' : name
}

// --- Cache Naming Patterns ---
export const CACHE_NAMING_PATTERNS = {
    STANDARD: 'standard',       // {Name}_-_{Singer}_-_{Source}_-_{ID}_-_{Quality}
    SIMPLE: 'simple',            // {Name} - {Singer} - {Quality} - {Album}
    SINGER_NAME_QUALITY_ALBUM: 'singer_name_quality_album', // {Singer} - {Name} - {Quality} - {Album}
    SINGER_NAME: 'singer_name', // {Singer} - {Name}
    NAME_SINGER: 'name_singer'  // {Name} - {Singer}
}

let currentNamingPattern = CACHE_NAMING_PATTERNS.SIMPLE
const userNamingPatternMap = new Map<string, string>()

export const normalizeNamingPattern = (pattern: unknown) => {
    if (Object.values(CACHE_NAMING_PATTERNS).includes(pattern as string)) {
        return pattern as string
    }
    return CACHE_NAMING_PATTERNS.SIMPLE
}

export const setNamingPattern = (pattern: unknown) => {
    currentNamingPattern = normalizeNamingPattern(pattern)
    // 仅更新全局回退值，清空缓存映射以使未自定义用户继承新全局值，绝不覆盖用户已保存的个性化设置
    userNamingPatternMap.clear()
    return currentNamingPattern
}

export const getNamingPattern = () => currentNamingPattern

export const getUserNamingPattern = (username?: string): string => {
    const normalizedUsername = normalizeUsername(username)
    if (userNamingPatternMap.has(normalizedUsername)) {
        return userNamingPatternMap.get(normalizedUsername)!
    }
    try {
        const userSpace = getUserSpace(normalizedUsername)
        const settingsPath = path.join(userSpace.dataManage.userDir, 'settings.json')
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
            if (settings && settings.serverCacheNamingPattern) {
                const pat = normalizeNamingPattern(settings.serverCacheNamingPattern)
                userNamingPatternMap.set(normalizedUsername, pat)
                return pat
            }
        }
    } catch (e) { }

    const fallback = normalizeNamingPattern(global.lx?.config?.['cache.namingPattern'] || currentNamingPattern)
    userNamingPatternMap.set(normalizedUsername, fallback)
    return fallback
}

export const setUserNamingPattern = (username: string | undefined, pattern: unknown): string => {
    const normalizedUsername = normalizeUsername(username)
    const normalizedPattern = normalizeNamingPattern(pattern)
    userNamingPatternMap.set(normalizedUsername, normalizedPattern)
    if (normalizedUsername === '_open') {
        currentNamingPattern = normalizedPattern
    }
    return normalizedPattern
}

// Define the two possible cache roots
export const CACHE_ROOTS = {
    DATA: 'data', // inside global.lx.dataPath (synced)
    ROOT: 'root'  // relative to process.cwd() (not synced)
}

let currentCacheLocation = CACHE_ROOTS.ROOT
const userCacheLocationMap = new Map<string, string>()
const CACHE_LIST_SYNC_TTL = 30 * 1000
const cacheListSyncState: Map<string, { lastSync: number, pending?: Promise<void> }> = new Map()

export const getUserCacheLocation = (username?: string): string => {
    const normalizedUsername = normalizeUsername(username)
    if (userCacheLocationMap.has(normalizedUsername)) {
        return userCacheLocationMap.get(normalizedUsername)!
    }
    try {
        const userSpace = getUserSpace(normalizedUsername)
        const settingsPath = path.join(userSpace.dataManage.userDir, 'settings.json')
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
            if (settings && (settings.serverCacheLocation === CACHE_ROOTS.DATA || settings.serverCacheLocation === CACHE_ROOTS.ROOT)) {
                userCacheLocationMap.set(normalizedUsername, settings.serverCacheLocation)
                return settings.serverCacheLocation
            }
        }
    } catch (e) { }

    const fallback = global.lx?.config?.serverCacheLocation || currentCacheLocation
    userCacheLocationMap.set(normalizedUsername, fallback)
    return fallback
}

export const invalidateUserCacheLocations = (): void => {
    userCacheLocationMap.clear()
    userNamingPatternMap.clear()
    currentCacheLocation = global.lx?.config?.serverCacheLocation || CACHE_ROOTS.ROOT
    currentNamingPattern = normalizeNamingPattern(global.lx?.config?.['cache.namingPattern'] || CACHE_NAMING_PATTERNS.SIMPLE)
}

export const setUserCacheLocation = (username: string | undefined, location: unknown): string => {
    const normalizedUsername = normalizeUsername(username)
    if (location === CACHE_ROOTS.DATA || location === CACHE_ROOTS.ROOT) {
        userCacheLocationMap.set(normalizedUsername, location)
        if (normalizedUsername === '_open') {
            currentCacheLocation = location
        }
        return location
    }
    return getUserCacheLocation(normalizedUsername)
}

// Helper to get actual directory path
// [Unified Enhancement] Cache Progress Tracker
export const cacheProgress: Map<string, { progress: number; status: string; total?: number; received?: number; speed?: number; updatedAt?: number; errorMsg?: string }> = new Map()

// [New] Active Cache Tasks Tracker: username -> [ { songKey, controller } ]
export const activeTasks: Map<string, Array<{ songKey: string, controller: AbortController }>> = new Map()

/**
 * 同一 songKey 正在进行中的下载任务。
 *
 * 存在的理由：原来命中「任务已在下载队列中」时直接 `Promise.resolve()`，调用方会
 * 以为下载已经完成，紧接着 `checkCache` 却查不到文件 → 抛「汽水加密曲下载/解密失败」，
 * 一秒后同一个任务下完，同一首歌又突然能播。
 * 现在后来者直接 await 同一个 Promise，拿到的是「真的下完了」。
 */
const inFlightDownloads: Map<string, Promise<void>> = new Map()

/** 等待在飞任务的上限，避免原任务卡死时把调用方一起挂住 */
const WAIT_IN_FLIGHT_TIMEOUT_MS = 10 * 60 * 1000

function waitForInFlightDownload(songKey: string, task: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`等待同曲下载超时（${Math.round(WAIT_IN_FLIGHT_TIMEOUT_MS / 60000)} 分钟）: ${songKey}`)),
            WAIT_IN_FLIGHT_TIMEOUT_MS,
        )
        if (typeof timer === 'object' && timer && typeof (timer as any).unref === 'function') (timer as any).unref()
    })
    return Promise.race([task, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
    })
}

// [新增] 歌词获取钩子：由 server.ts 在启动时注入，避免 fileCache 直接依赖 musicSdk
// 调用时会通过 /api/music/lyric 接口逻辑（先查本地 .lrc 缓存，再去源站）获取歌词文本
type LyricFetcher = (songInfo: any) => Promise<string | null>
let _lyricFetcher: LyricFetcher | null = null
export const setLyricFetcher = (fn: LyricFetcher) => { _lyricFetcher = fn }

export const getCacheDir = (username?: string, isOnlyDownload?: boolean, location?: string) => {
    const userDirName = normalizeUsername(username)

    const folderName = isOnlyDownload ? 'music' : 'cache'
    const loc = location || getUserCacheLocation(userDirName)
    let baseDir = ''
    if (loc === CACHE_ROOTS.DATA) {
        baseDir = path.join(global.lx.dataPath, folderName)
    } else {
        baseDir = path.join(process.cwd(), folderName)
    }

    const fullPath = path.join(baseDir, userDirName)
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true })
    }
    return fullPath
}

export const getCoverCacheDir = (username: string) => {
    const baseDir = path.join(process.cwd(), 'cover_cache')
    const userDirName = normalizeUsername(username)
    const fullPath = path.join(baseDir, userDirName)
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true })
    }
    return fullPath
}

// --- Cache Index Manager ---
export interface CacheItem {
    id: string
    songmid?: string
    name: string
    singer: string
    album: string
    albumId?: string
    img?: string
    interval?: string
    source: string
    requestedSource?: string
    downloadSource?: string
    sourceName?: string
    quality: string
    filename: string
    folder: string // 'cache' or 'music'
    subPath?: string // [New] Relative path within the folder (e.g. 'Pop/2024')
    mtime: number
    size: number
    lyricFilename?: string
    ext: string
    hasCover?: boolean
    coverType?: 'embedded' | 'cached' | 'remote' | 'none'
    hasLyric?: boolean
    hasEmbedLyric?: boolean
    audioContainer?: string
    metadataWritable?: boolean
    metadataError?: string
    embedLyricError?: string
    coverCheckedVersion?: number
    coverCheckedMtime?: number
    /** 源侧核验通过的时间戳（毫秒）。缺这个字段说明是 1.5.27 之前写入的老条目，尚未核验过 */
    originVerifiedAt?: number
    coverCheckedSize?: number
    bitrate?: number
    sampleRate?: number
    bitDepth?: number
    // 各平台原生标识（tx 的 mid/strMediaMid、kg 的 hash、wy 的 songId 等），
    // 规范化 ID 无法反推它们，缺了就没法从缓存条目还原出可解析的歌曲对象
    nativeIds?: Record<string, string>
    // 汽水版权曲 CENC 加密流的解密密钥（32 位十六进制）。落盘时记下，
    // 这样已缓存的加密文件在容器重启后仍能被就地解密（见 checkCache / downloadAndCache）。
    decryptKey?: string
}

export type CacheFolder = 'cache' | 'music'

export interface RemoveCacheFileResult {
    deleted: boolean
    folder?: CacheFolder
}

export interface DownloadProvenance {
    requestedSource?: string
    downloadSource?: string
    sourceName?: string
    /** 汽水版权曲 CENC 加密流的解密密钥（32 位十六进制）。取链时拿到、下载时就地解密用。 */
    decryptKey?: string
}

class CacheIndexManager {
    private indexes: Map<string, Map<string, CacheItem>> = new Map() // "location:username:folder" -> (songId -> CacheItem)

    private getIndexFile(username: string, folder: 'cache' | 'music', location?: string) {
        const userDir = getCacheDir(username, folder === 'music', location)
        const fileName = folder === 'music' ? 'music_index.json' : 'cache_index.json'
        return path.join(userDir, fileName)
    }

    private getKey(username: string, folder: 'cache' | 'music', location?: string) {
        const loc = location || getUserCacheLocation(username)
        return `${loc}:${username}:${folder}`
    }

    load(username: string, folder: 'cache' | 'music', location?: string) {
        const loc = location || getUserCacheLocation(username)
        const key = this.getKey(username, folder, loc)
        const file = this.getIndexFile(username, folder, loc)
        if (fs.existsSync(file)) {
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
                this.indexes.set(key, new Map(Object.entries(data)))
            } catch (e) {
                this.indexes.set(key, new Map())
            }
        } else {
            this.indexes.set(key, new Map())
        }
        return this.indexes.get(key)!
    }

    save(username: string, folder: 'cache' | 'music', location?: string) {
        const loc = location || getUserCacheLocation(username)
        const key = this.getKey(username, folder, loc)
        const index = this.indexes.get(key)
        if (!index) return

        const file = this.getIndexFile(username, folder, loc)
        try {
            const data = Object.fromEntries(index)
            fs.writeFileSync(file, JSON.stringify(data, null, 2))
        } catch (e) {
            console.error(`[缓存索引] 保存索引文件失败 (${key}):`, e)
        }
    }

    get(username: string, songId: string, folder: 'cache' | 'music', quality?: string, exact: boolean = false, location?: string) {
        const key = this.getKey(username, folder, location)
        const index = this.indexes.get(key) || this.load(username, folder, location)
        if (quality) {
            const item = index.get(`${songId}_${quality}`)
            if (item) return item
            // exact 模式：精确匹配失败则不 fallback，直接返回 undefined
            if (exact) return undefined
        }
        // Fallback: 非精确模式下扫描同 ID 的任意质量
        const prefix = `${songId}_`
        for (const [k, item] of index.entries()) {
            if (k === songId || k.startsWith(prefix)) return item
        }
        return undefined
    }

    update(username: string, item: CacheItem, folder: 'cache' | 'music', location?: string) {
        const key = this.getKey(username, folder, location)
        const index = this.indexes.get(key) || this.load(username, folder, location)
        // Use composite key id_quality
        const itemKey = `${item.id}_${item.quality || 'unknown'}`
        index.set(itemKey, item)
        this.save(username, folder, location)
    }

    remove(username: string, songId: string, folder: 'cache' | 'music', quality?: string, location?: string) {
        const key = this.getKey(username, folder, location)
        const index = this.indexes.get(key) || this.load(username, folder, location)
        if (quality) {
            if (index.delete(`${songId}_${quality}`)) {
                this.save(username, folder, location)
                return true
            }
        }
        // Legacy or bulk remove by ID
        let deleted = false
        const prefix = `${songId}_`
        for (const k of Array.from(index.keys())) {
            if (k === songId || k.startsWith(prefix)) {
                index.delete(k)
                deleted = true
            }
        }
        if (deleted) this.save(username, folder, location)
        return deleted
    }

    getAll(username: string, folder: 'cache' | 'music', location?: string) {
        return Array.from((this.indexes.get(this.getKey(username, folder, location)) || this.load(username, folder, location)).values())
    }

    discard(username: string, folder: 'cache' | 'music', location?: string) {
        this.indexes.delete(this.getKey(username, folder, location))
    }
}

export const indexManager = new CacheIndexManager()

const COVER_CHECK_VERSION = 4

const getCoverCacheHash = (filename: string, stats?: Stats) => {
    const version = stats ? `${stats.size}:${stats.mtimeMs}` : ''
    return crypto.createHash('md5').update(`${filename}:${version}`).digest('hex')
}

const getCoverCachePaths = (filename: string, username: string, stats?: Stats) => {
    const hash = getCoverCacheHash(filename, stats)
    const coverCacheDir = getCoverCacheDir(username)
    return {
        binPath: path.join(coverCacheDir, `${hash}.bin`),
        mimePath: path.join(coverCacheDir, `${hash}.mime`),
    }
}

const getLegacyCoverCachePaths = (filename: string, username: string, stats?: Stats) => {
    const hash = getCoverCacheHash(filename, stats)
    const userDirName = normalizeUsername(username)
    const coverCacheDir = path.join(global.lx.dataPath, 'cover_cache', userDirName)
    return {
        binPath: path.join(coverCacheDir, `${hash}.bin`),
        mimePath: path.join(coverCacheDir, `${hash}.mime`),
    }
}

const detectImageMime = (data: Buffer | Uint8Array) => {
    const buffer = Buffer.from(data)
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
    if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif'
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
    return null
}

const readCoverCache = (filename: string, username: string, stats?: Stats) => {
    const candidates = [getCoverCachePaths(filename, username, stats), getLegacyCoverCachePaths(filename, username, stats)]
    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate.binPath) || !fs.existsSync(candidate.mimePath)) continue
            const data = fs.readFileSync(candidate.binPath)
            const detectedMime = detectImageMime(data)
            if (!detectedMime) continue
            const storedMime = fs.readFileSync(candidate.mimePath, 'utf8').trim()
            const persistent = getCoverCachePaths(filename, username, stats)
            if (candidate.binPath !== persistent.binPath) {
                fs.copyFileSync(candidate.binPath, persistent.binPath)
                fs.writeFileSync(persistent.mimePath, detectedMime || storedMime || 'image/jpeg')
            }
            return { data, mime: detectedMime || storedMime || 'image/jpeg' }
        } catch (e) { }
    }
    return null
}

const hasCachedCover = (filename: string, username: string, stats?: Stats) => {
    return !!readCoverCache(filename, username, stats)
}

const writeCoverCache = (filename: string, username: string, data: Buffer | Uint8Array, mime: string, stats?: Stats) => {
    const coverData = Buffer.from(data)
    const detectedMime = detectImageMime(coverData)
    if (!detectedMime) return false
    const { binPath, mimePath } = getCoverCachePaths(filename, username, stats)
    fs.writeFileSync(binPath, coverData)
    fs.writeFileSync(mimePath, detectedMime || mime || 'image/jpeg')
    return true
}

const resolveCacheRelativePath = (dir: string, filename: string) => {
    const root = path.resolve(dir)
    const resolved = path.resolve(root, filename)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return null
    }
    return resolved
}

const hasValidPictureData = (picture: any) => {
    if (!picture || !picture.data) return false
    try {
        return !!detectImageMime(Buffer.from(picture.data))
    } catch (e) {
        return false
    }
}

const hasValidEmbeddedCover = (pictures: any) => {
    return Array.isArray(pictures) && pictures.some(hasValidPictureData)
}

const isPlaceholderCoverUrl = (url: any) => {
    return typeof url === 'string' && /\/T002R\d+x\d+M000\.jpg(?:$|\?)/.test(url)
}

const hasUsableRemoteCover = (url: any) => typeof url === 'string' && /^https?:\/\//i.test(url) && !isPlaceholderCoverUrl(url)

/**
 * 小爱音箱起播前只缓冲约 2.1MB，必须在这个窗口内找到首个 MPEG 音频帧才会起播。
 * 内嵌封面（APIC）一旦把 ID3v2 标签撑过这个窗（实测 2.4MB 封面 → 流冻结在 2228224B，
 * 封面显示但永远不出声；同文件浏览器播放正常），必须把封面剥掉。
 * 阈值留了余量：1.5MB（浏览器/电脑播放器不受影响，UI 封面走外置封面缓存或远端 URL 兜底）。
 */
const EMBED_TAG_SAFE_BYTES = 1536 * 1024

/** 读 ID3v2 标签总长度；v2.4 帧长/总长为 syncsafe，v2.3 为大端 uint32 */
const readId3v2TotalSize = (head: Buffer): number => {
    if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return 0
    if (head[3] === 4) {
        const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
        return 10 + size + ((head[5] & 0x10) !== 0 ? 10 : 0)
    }
    if (head[3] === 3) return 10 + head.readUInt32BE(6)
    return 0
}

/**
 * 若音频文件的 ID3v2 标签超过小爱起播缓冲窗，重写标签并剥离全部封面帧（APIC/PIC），
 * 其余帧（标题/歌手/专辑/USLT 歌词等）原样保留。成功剥离返回 true。
 * 写临时文件后原子替换，避免并发读取（小爱本地直发流）拿到半截文件。
 */
const stripOversizedEmbeddedCover = (audioPath: string): boolean => {
    try {
        const head = Buffer.alloc(10)
        const fd = fs.openSync(audioPath, 'r')
        try {
            fs.readSync(fd, head, 0, 10, 0)
        } finally {
            fs.closeSync(fd)
        }
        if (head[5] & 0x80) return false // unsync 标签重组有风险，不动
        const totalSize = readId3v2TotalSize(head)
        if (totalSize <= EMBED_TAG_SAFE_BYTES) return false

        const ver = head[3]
        const fileStat = fs.statSync(audioPath)
        const audioLen = Math.max(0, fileStat.size - totalSize)
        const tagBuf = Buffer.alloc(totalSize)
        const audio = Buffer.alloc(audioLen)
        const rfd = fs.openSync(audioPath, 'r')
        try {
            fs.readSync(rfd, tagBuf, 0, totalSize, 0)
            if (audioLen > 0) fs.readSync(rfd, audio, 0, audioLen, totalSize)
        } finally {
            fs.closeSync(rfd)
        }

        const ss4 = (b: Buffer, o: number) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f)
        const encSS = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
        const frameSize = (b: Buffer, o: number) => (ver === 4 ? ss4(b, o) : b.readUInt32BE(o))
        const encSize = (n: number) => (ver === 4 ? encSS(n) : (() => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b })())

        let off = 10
        const keep: Buffer[] = []
        let dropped = false
        while (off + 10 <= totalSize) {
            const fid = tagBuf.toString('latin1', off, off + 4)
            if (!/^[A-Z0-9]{4}$/.test(fid)) break // padding 或扩展区，直接停止
            const fsz = frameSize(tagBuf, off)
            if (fsz <= 0 || off + 10 + fsz > totalSize) break
            if (fid === 'APIC' || fid === 'PIC') {
                dropped = true
            } else {
                keep.push(tagBuf.subarray(off, off + 10 + fsz))
            }
            off += 10 + fsz
        }
        if (!dropped) return false // 超大标签不是封面撑的（少见），交由人工排查

        const frames = Buffer.concat(keep)
        const newHeader = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([ver, head[4], 0]), encSize(frames.length)])
        const tmpPath = audioPath + '.stripping'
        fs.writeFileSync(tmpPath, Buffer.concat([newHeader, frames, audio]))
        fs.renameSync(tmpPath, audioPath)
        console.warn(`[文件缓存] ID3 标签 ${(totalSize / 1024 / 1024).toFixed(2)}MB 超出小爱起播缓冲窗，已剥离内嵌封面: ${path.basename(audioPath)}`)
        return true
    } catch (e) {
        try { console.warn('[文件缓存] 剥离超大内嵌封面失败（不影响缓存可用性）:', (e as Error)?.message) } catch (e2) { }
        return false
    }
}

const detectAudioContainer = (filePath: string) => {
    try {
        const fd = fs.openSync(filePath, 'r')
        const buffer = Buffer.alloc(16)
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
        fs.closeSync(fd)
        const head = buffer.subarray(0, bytesRead)
        if (head.subarray(0, 3).toString('ascii') === 'ID3' || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'mp3'
        if (head.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac'
        if (head.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg'
        if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav'
        if (head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4'
        if (head.subarray(0, 4).toString('ascii') === 'MAC ') return 'ape'
        if (head[0] === 0x7b) return 'encrypted'
        return 'unknown'
    } catch (e) {
        return 'unknown'
    }
}

/**
 * 判断本地音频文件是不是 CENC 加密容器。
 *
 * 汽水的**正式版权曲**（不是 UGC 翻唱）下发的直链本身就是加密流：MP4 的 stsd 里
 * 是 `enca` 而不是 `mp4a`，并带 `senc`/`saiz`/`tenc` 样本加密表。
 * 这种文件浏览器 `<audio>` 一律解码失败，而它又能通过「时长/码率」校验（元数据是明文的），
 * 于是被当成命中缓存返回 → 播放失败 → 换源 → 又命中同一个文件 → 无限换源循环。
 * 实测 246 上 7 个汽水缓存里 4 个是这种残骸。
 */
const encryptedAudioCache = new Map<string, { key: string; encrypted: boolean }>()

export const isEncryptedAudioFile = (filePath: string, probeBytes = 512 * 1024): boolean => {
    try {
        const st = fs.statSync(filePath)
        const key = `${st.size}:${st.mtimeMs}`
        const hit = encryptedAudioCache.get(filePath)
        if (hit && hit.key === key) return hit.encrypted
        const len = Math.min(probeBytes, Math.max(0, st.size))
        if (len < 32) return false
        const buf = Buffer.alloc(len)
        const fd = fs.openSync(filePath, 'r')
        let read = 0
        try { read = fs.readSync(fd, buf, 0, len, 0) } finally { fs.closeSync(fd) }
        const head = buf.subarray(0, read)
        const encrypted = head.includes('enca') && (head.includes('senc') || head.includes('saiz') || head.includes('tenc'))
        encryptedAudioCache.set(filePath, { key, encrypted })
        return encrypted
    } catch {
        return false
    }
}

const getMetadataUnsupportedMessage = (container: string) => (
    container === 'encrypted'
        ? '音频为加密或非标准容器，无法写入封面和歌词标签'
        : '当前音频容器不支持写入封面和歌词标签'
)

export const getAudioMetadataUnsupportedStatus = (filePath: string) => {
    const audioContainer = detectAudioContainer(filePath)
    return {
        audioContainer,
        metadataWritable: false,
        error: getMetadataUnsupportedMessage(audioContainer),
    }
}

const readEmbeddedCoverState = (filePath: string) => {
    let tagger: any
    try {
        tagger = new MusicTagger()
        tagger.loadPath(filePath)
        return hasValidEmbeddedCover(tagger.pictures)
    } catch (e) {
        return false
    } finally {
        try { if (tagger) tagger.dispose() } catch (e) { }
    }
}

export const embedLyricsIntoFile = (filePath: string, lyricText: string) => {
    const audioContainer = detectAudioContainer(filePath)
    let tagger: any
    try {
        tagger = new MusicTagger()
        tagger.loadPath(filePath)
        tagger.lyrics = lyricText
        tagger.save()
    } catch (e: any) {
        return {
            success: false,
            hasEmbedLyric: false,
            audioContainer,
            metadataWritable: false,
            error: getMetadataUnsupportedMessage(audioContainer),
        }
    } finally {
        try { if (tagger) tagger.dispose() } catch (e) { }
    }

    let verifyTagger: any
    try {
        verifyTagger = new MusicTagger()
        verifyTagger.loadPath(filePath)
        const embeddedLyrics = verifyTagger.lyrics
        const hasEmbedLyric = !!(embeddedLyrics && embeddedLyrics.trim().length > 10)
        return {
            success: hasEmbedLyric,
            hasEmbedLyric,
            audioContainer,
            metadataWritable: true,
            error: hasEmbedLyric ? undefined : '歌词标签写入后校验失败，已保留外置歌词文件',
        }
    } catch (e: any) {
        return {
            success: false,
            hasEmbedLyric: false,
            audioContainer,
            metadataWritable: false,
            error: getMetadataUnsupportedMessage(audioContainer),
        }
    } finally {
        try { if (verifyTagger) verifyTagger.dispose() } catch (e) { }
    }
}

// Ensure directory exists
const ensureDir = (username?: string, isOnlyDownload?: boolean) => {
    const dir = getCacheDir(username, isOnlyDownload)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }
    return dir
}

// Safe rename: try rename, fall back to copy+unlink if rename fails (cross-device, permissions, etc.)
const safeRenameSync = (src: string, dst: string) => {
    try {
        fs.renameSync(src, dst)
        return true
    } catch (err) {
        try {
            fs.copyFileSync(src, dst)
            fs.unlinkSync(src)
            return true
        } catch (err2) {
            throw err // keep original error context
        }
    }
}

/**
 * 规范化歌曲 ID：确保带上 source 前缀，与索引中的 Key 保持一致
 */
export const normalizeSongId = (songInfo: any): string => {
    let id = String(songInfo.songmid || songInfo.songId || songInfo.id || '')
    const source = songInfo.source || 'unknown'
    if (id && !id.includes('_') && source !== 'unknown') {
        id = `${source}_${id}`
    }
    return id
}

/**
 * Extract rich metadata from Lx songInfo object
 */
// 各平台解析音源时要用的原生标识字段；normalizeSongId 会把它们统一成 "source_原生ID"，
// 反向拆不出来，所以缓存/下载条目落索引时必须原样留一份
const NATIVE_ID_KEYS = ['hash', 'hashMid', 'mid', 'strMediaMid', 'songId', 'songmid', 'sid',
    'copyrightId', 'mediaMid', 'albumMid', 'albumId', 'singerId', 'otherSource']

export const extractNativeIds = (songInfo: any): Record<string, string> | undefined => {
    if (!songInfo) return undefined
    const meta = songInfo.meta || {}
    const out: Record<string, string> = {}
    for (const key of NATIVE_ID_KEYS) {
        const value = songInfo[key] !== undefined && songInfo[key] !== null && songInfo[key] !== ''
            ? songInfo[key]
            : (meta[key] !== undefined && meta[key] !== null && meta[key] !== '' ? meta[key] : null)
        if (value !== null) out[key] = String(value)
    }
    return Object.keys(out).length > 0 ? out : undefined
}

export const extractSongMetadata = (songInfo: any) => {
    const meta = songInfo.meta || {}
    const id = normalizeSongId(songInfo)
    return {
        id: id,
        name: songInfo.name || meta.songName || 'Unknown',
        singer: songInfo.singer || meta.singerName || 'Unknown',
        album: songInfo.albumName || meta.albumName ||
            (typeof songInfo.album === 'string' ? songInfo.album : songInfo.album?.name) || '',
        albumId: String(songInfo.albumId || meta.albumId || ''),
        img: songInfo.img || meta.picUrl || '',
        interval: songInfo.interval || meta.interval || '',
        source: songInfo.source || 'unknown'
    }
}

/**
 * Detect quality tag from bitrate and file metadata
 */
const detectQualityFromBitrate = (bitrate: number | undefined, ext: string, tagger?: any): LX.Quality => {
    const nativeQuality = String(tagger?.quality || '').toLowerCase()
    const isLossless = ext === '.flac' || ext === '.wav' || ext === '.ape' || nativeQuality === 'sq' || nativeQuality === 'hires'
    const br = bitrate || 0 // Already in kbps from music-tag-native

    if (isLossless) {
        const bitDepth = tagger?.bitDepth || 16
        const sampleRate = tagger?.sampleRate || 44100

        if (br > 4500 || sampleRate > 96000) return 'master' as LX.Quality
        if (br > 1000 || bitDepth > 16 || sampleRate > 48000) return 'flac24bit'
        return 'flac'
    }

    // Lossy formats (mp3, m4a, etc.)
    if (br >= 240) return '320k'
    if (br >= 170) return '192k'
    return '128k'
}

const losslessQualitySet = new Set(['flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master', 'ape', 'wav'])

const isClearlyLossyAudio = (container: string, tagger?: any) => {
    const nativeQuality = String(tagger?.quality || '').toLowerCase()
    return nativeQuality === 'hq' || container === 'mp3' || container === 'ogg'
}

const resolveInspectedQuality = (requestedQuality: string | undefined, detectedQuality: string, container: string, tagger?: any) => {
    if (isClearlyLossyAudio(container, tagger)) return detectedQuality
    if (requestedQuality && losslessQualitySet.has(requestedQuality)) return requestedQuality
    return detectedQuality
}

const needsQualityCorrection = (quality: string | undefined, container: string) => (
    !!quality && losslessQualitySet.has(quality) && (container === 'mp3' || container === 'ogg')
)

export const parseDurationSeconds = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 10000 ? Math.round(value / 1000) : Math.round(value)
    }
    const text = String(value || '').trim()
    if (!text) return 0
    if (/^\d+(?:\.\d+)?$/.test(text)) {
        const parsed = Number(text)
        return parsed > 10000 ? Math.round(parsed / 1000) : Math.round(parsed)
    }
    const parts = text.split(':').map(Number)
    if (parts.some(p => !Number.isFinite(p))) return 0
    if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1])
    if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
    return 0
}

const inspectAudioFile = (filePath: string, requestedQuality?: string) => {
    const audioContainer = detectAudioContainer(filePath)
    const ext = audioContainer === 'unknown' || audioContainer === 'encrypted'
        ? path.extname(filePath).toLowerCase()
        : `.${audioContainer === 'mp4' ? 'm4a' : audioContainer}`
    let tagger: any
    try {
        tagger = new MusicTagger()
        tagger.loadPath(filePath)
        const bitrate = Number(tagger.bitRate) || undefined
        const detectedQuality = detectQualityFromBitrate(bitrate, ext, tagger)
        const duration = Number(tagger.duration) || undefined
        return {
            audioContainer,
            extension: ext,
            quality: resolveInspectedQuality(requestedQuality, detectedQuality, audioContainer, tagger),
            bitrate,
            sampleRate: Number(tagger.sampleRate) || undefined,
            bitDepth: Number(tagger.bitDepth) || undefined,
            duration,
            // 源文件自带的标签（写标签前读取），用来判断「音源是不是给了别的歌」
            title: tagger.title ? String(tagger.title) : undefined,
            artist: tagger.artist ? String(tagger.artist) : undefined,
        }
    } catch (e) {
        const detectedQuality = detectQualityFromBitrate(undefined, ext)
        return {
            audioContainer,
            extension: ext,
            quality: needsQualityCorrection(requestedQuality, audioContainer) ? detectedQuality : (requestedQuality || detectedQuality),
            bitrate: undefined,
            sampleRate: undefined,
            bitDepth: undefined,
            duration: undefined,
            title: undefined,
            artist: undefined,
        }
    } finally {
        try { if (tagger) tagger.dispose() } catch (e) { }
    }
}

export const detectDownloadSource = (rawUrl: string, fallbackSource?: string) => {
    let value = String(rawUrl || '').toLowerCase()
    try { value = decodeURIComponent(value) } catch (e) { }

    const sourcePatterns: Array<[string, RegExp]> = [
        ['kw', /(?:^|[./])(?:kuwo\.cn|kuwo\.com)(?:[/:?]|$)/],
        ['wy', /(?:^|[./])(?:music\.126\.net|music\.163\.com|163yun\.com)(?:[/:?]|$)/],
        ['tx', /(?:^|[./])(?:qqmusic\.qq\.com|music\.tc\.qq\.com|stream\.qqmusic\.qq\.com)(?:[/:?]|$)/],
        ['kg', /(?:^|[./])(?:kugou\.com|kugou\.net)(?:[/:?]|$)/],
        ['mg', /(?:^|[./])(?:migu\.cn|miguvideo\.com|cmvideo\.cn)(?:[/:?]|$)/],
    ]
    for (const [source, pattern] of sourcePatterns) {
        if (pattern.test(value)) return source
    }
    return fallbackSource || undefined
}

// Generate consistent filename based on pattern with collision handling
export const getFileName = (songInfo: any, quality?: string, isOnlyDownload?: boolean, username?: string, namingPattern?: string) => {
    const sanitizeFilename = (str: any) => String(str || '').replace(/[\\/:*?"<>|]/g, '_')

    const id = normalizeSongId(songInfo)
    const source = songInfo.source || 'unknown'
    const q = quality || songInfo.quality || 'unknown'
    const nameStr = sanitizeFilename(songInfo.name || 'Unknown')
    const singerStr = sanitizeFilename(songInfo.singer || 'Unknown')
    const albumValue = songInfo.albumName || songInfo.meta?.albumName ||
        (typeof songInfo.album === 'string' ? songInfo.album : songInfo.album?.name) ||
        'Unknown Album'
    const albumStr = sanitizeFilename(albumValue)

    const pattern = namingPattern ? normalizeNamingPattern(namingPattern) : getUserNamingPattern(username)

    let baseName = ''
    if (pattern === CACHE_NAMING_PATTERNS.SIMPLE) {
        baseName = `${nameStr} - ${singerStr} - ${sanitizeFilename(q)} - ${albumStr}`
    } else if (pattern === CACHE_NAMING_PATTERNS.SINGER_NAME_QUALITY_ALBUM) {
        baseName = `${singerStr} - ${nameStr} - ${sanitizeFilename(q)} - ${albumStr}`
    } else if (pattern === CACHE_NAMING_PATTERNS.SINGER_NAME) {
        baseName = `${singerStr} - ${nameStr}`
    } else if (pattern === CACHE_NAMING_PATTERNS.NAME_SINGER) {
        baseName = `${nameStr} - ${singerStr}`
    } else {
        // Default/Standard: {Name}_-_{Singer}_-_{Source}_-_{ID}_-_{Quality}
        baseName = `${nameStr}_-_${singerStr}_-_${sanitizeFilename(source)}_-_${sanitizeFilename(id)}_-_${sanitizeFilename(q)}`
    }

    // --- Collision Handling ---
    // Only apply suffix logic if we have a username and it's not the standard pattern (which is already unique)
    if (username && pattern !== CACHE_NAMING_PATTERNS.STANDARD) {
        const folder: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'
        const normalizedUsername = normalizeUsername(username)
        const existingItems = indexManager.getAll(normalizedUsername, folder)

        const normalizedName = nameStr.toLowerCase()
        const normalizedSinger = singerStr.toLowerCase()
        const normalizedQuality = sanitizeFilename(q).toLowerCase()
        const normalizedAlbum = albumStr.toLowerCase()

        // The album is part of the simple filename, so different album editions do not collide.
        const conflict = existingItems.find(item => {
            // 只要不是同一个文件（ID 不同，或者 ID 相同但音质不同），就有可能冲突
            const isDifferentFile = normalizeSongId(item) !== id || item.quality !== q
            if (!isDifferentFile) return false

            const itemNormalizedName = sanitizeFilename(item.name || 'Unknown').toLowerCase()
            const itemNormalizedSinger = sanitizeFilename(item.singer || 'Unknown').toLowerCase()

            if (pattern === CACHE_NAMING_PATTERNS.SINGER_NAME || pattern === CACHE_NAMING_PATTERNS.NAME_SINGER) {
                // 对于仅包含“歌手-歌名”的模式，只要歌手和歌名一样，必定产生同名文件冲突
                return itemNormalizedName === normalizedName && itemNormalizedSinger === normalizedSinger
            } else {
                // 对于包含音质和专辑的模式，还要判断这些字段是否也完全相同
                const itemNormalizedQuality = sanitizeFilename(item.quality || 'unknown').toLowerCase()
                const itemNormalizedAlbum = sanitizeFilename(item.album || 'Unknown Album').toLowerCase()
                return itemNormalizedName === normalizedName &&
                    itemNormalizedSinger === normalizedSinger &&
                    itemNormalizedQuality === normalizedQuality &&
                    itemNormalizedAlbum === normalizedAlbum
            }
        })

        if (conflict) {
            // The normalized ID already includes the source prefix when needed.
            baseName += ` (${sanitizeFilename(id || source || 'duplicate')})`
        }
    }

    if (baseName.length > 200) baseName = baseName.substring(0, 200)
    return baseName
}

// Helper to sanitize for URL/Path
const sanitize = (str: any) => String(str || '').replace(/[\\/:*?"<>|]/g, '_')

// --- Public APIs ---

/**
 * Sync disk files with index database
 */
export const syncCacheIndex = async (username?: string, roots: Array<'cache' | 'music'> = ['cache', 'music']) => {
    const normalizedUsername = normalizeUsername(username)
    void cleanupStaleTempFiles(normalizedUsername)
    const extensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav']

    for (const folder of roots) {
        const index = indexManager.load(normalizedUsername, folder)

        let updated = false
        const existingKeysInIndex = new Set(index.keys())
        const foundKeysOnDisk = new Set<string>()

        // Pre-build a filename to Item map within this folder for fast lookup
        const filenameToItemMap = new Map<string, { key: string, item: CacheItem }>()
        for (const [key, item] of index.entries()) {
            filenameToItemMap.set(item.filename, { key, item })
        }
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue

        // [Unified Enhancement] Recursive file walker (asynchronous)
        const getAllFilesAsync = async (dirPath: string, base: string = dirPath): Promise<string[]> => {
            const acc: string[] = []
            try {
                const exists = await fs.promises.access(dirPath).then(() => true).catch(() => false)
                if (!exists) return acc
                const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
                for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name)
                    if (entry.isDirectory()) {
                        const subFiles = await getAllFilesAsync(fullPath, base)
                        acc.push(...subFiles)
                    } else {
                        acc.push(path.relative(base, fullPath).replace(/\\/g, '/'))
                    }
                }
            } catch (e) {
                console.error(`[文件缓存] 遍历目录失败 (${dirPath}):`, e)
            }
            return acc
        }

        const files = await getAllFilesAsync(dir)
        for (const file of files) {
            if (file === 'cache_index.json' || file === 'music_index.json') continue
            const ext = path.extname(file).toLowerCase()
            if (!extensions.includes(ext)) continue

            const filePath = path.join(dir, file)
            const stats = await fs.promises.stat(filePath)

            // Try to find if this file is already known in index by its filename
            let existingEntry = filenameToItemMap.get(file)
            let existing = existingEntry?.item
            let oldKey = existingEntry?.key

            let songId = existing?.id || ''
            let songName = existing?.name || ''
            let singer = existing?.singer || ''
            let source = existing?.source || ''
            let quality = existing?.quality || ''
            let album = existing?.album || ''
            let hasCover = existing?.hasCover || false

            // subPath calculation: the directory part of the relative path
            const subPath = path.dirname(file) === '.' ? '' : path.dirname(file).replace(/\\/g, '/')
            const fileNameOnly = path.basename(file)

            const nameWithoutExt = path.basename(fileNameOnly, ext)

            if (!existing) {
                // 先尝试从标准防碰撞命名格式解析 (Name_-_Singer_-_Source_-_ID_-_Quality)
                const segments = nameWithoutExt.split('_-_')
                if (segments.length >= 5) {
                    songName = segments[0]
                    singer = segments[1]
                    source = segments[2]
                    songId = segments[3]
                    quality = segments[4]
                } else {
                    // 非标准格式（如未关联本地文件 / 简单命名），默认先标记为 local
                    source = 'local'
                    songId = nameWithoutExt
                }
            }

            if (!songId) continue
            // Normalize ID
            const normalizedId = songId.includes('_') ? songId : `${source || 'local'}_${songId}`

            // Always check for companion lyric file
            const lrcFile = file.substring(0, file.length - ext.length) + '.lrc'
            const hasLyricOnDisk = await fs.promises.access(path.join(dir, lrcFile)).then(() => true).catch(() => false)

            let finalQuality = quality || 'unknown'

            const needsCoverCheck = !existing ||
                existing.coverCheckedVersion !== COVER_CHECK_VERSION ||
                existing.coverCheckedMtime !== stats.mtimeMs ||
                existing.coverCheckedSize !== stats.size ||
                existing.hasCover === undefined ||
                (existing.coverType === 'cached' && !hasCachedCover(file, normalizedUsername, stats))
            const currentAudioContainer = existing?.audioContainer || detectAudioContainer(filePath)
            const qualityCorrectionNeeded = !!existing && needsQualityCorrection(existing.quality, currentAudioContainer)

            // Update or add to index if anything changed (size, mtime, lyric status, or cover status)
            if (!existing || existing.size !== stats.size || existing.hasLyric !== hasLyricOnDisk || needsCoverCheck || !existing.interval || existing.quality === 'unknown' || !existing.bitrate || qualityCorrectionNeeded) {
                if (existing) {
                    existing.size = stats.size
                    existing.mtime = stats.mtimeMs
                    existing.hasLyric = hasLyricOnDisk
                    existing.lyricFilename = hasLyricOnDisk ? lrcFile : undefined

                    if (existing.subPath !== subPath) {
                        existing.subPath = subPath
                        updated = true
                    }

                    if (needsCoverCheck) {
                        const hasEmbeddedCover = readEmbeddedCoverState(filePath)
                        const hasExternalCover = !hasEmbeddedCover && hasCachedCover(file, normalizedUsername, stats)
                        const coverType: CacheItem['coverType'] = hasEmbeddedCover
                            ? 'embedded'
                            : hasExternalCover
                                ? 'cached'
                                : hasUsableRemoteCover(existing.img)
                                    ? 'remote'
                                    : 'none'
                        const actualHasCover = coverType !== 'none'
                        if (existing.hasCover !== actualHasCover) updated = true
                        existing.hasCover = actualHasCover
                        existing.coverType = coverType
                        existing.coverCheckedVersion = COVER_CHECK_VERSION
                        existing.coverCheckedMtime = stats.mtimeMs
                        existing.coverCheckedSize = stats.size
                    }

                    // If interval or quality/bitrate is missing/unknown, or hasEmbedLyric not yet detected, try to extract it
                    if (!existing.interval || existing.quality === 'unknown' || !existing.bitrate || existing.hasEmbedLyric === undefined || existing.metadataWritable === undefined || qualityCorrectionNeeded) {
                        let tagger: any
                        try {
                            tagger = new MusicTagger()
                            tagger.loadPath(filePath)
                            // 若为 local 未关联文件，元数据优先校准歌名歌手
                            if (existing.source === 'local' || !existing.source) {
                                if (tagger.title) existing.name = tagger.title
                                if (tagger.artist) existing.singer = tagger.artist
                                if (tagger.album) existing.album = tagger.album
                            }
                            const dur = tagger.duration
                            if (dur && !existing.interval) existing.interval = formatPlayTime(dur / 1000)
                            existing.bitrate = tagger.bitRate
                            existing.sampleRate = tagger.sampleRate
                            existing.bitDepth = tagger.bitDepth
                            if (!existing.quality || existing.quality === 'unknown' || qualityCorrectionNeeded) {
                                const detectedQuality = detectQualityFromBitrate(tagger.bitRate, ext, tagger)
                                existing.quality = resolveInspectedQuality(existing.quality, detectedQuality, currentAudioContainer, tagger)
                            }
                            // [新增] 检测是否已嵌入歌词 USLT 标签
                            if (existing.hasEmbedLyric === undefined) {
                                const lyricsInTag = tagger.lyrics
                                existing.hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
                            }
                            existing.audioContainer = currentAudioContainer
                            existing.metadataWritable = true
                            existing.metadataError = undefined
                        } catch (e: any) {
                            existing.audioContainer = currentAudioContainer
                            existing.metadataWritable = false
                            existing.metadataError = getMetadataUnsupportedMessage(existing.audioContainer)
                            existing.hasEmbedLyric = false
                        } finally {
                            try { if (tagger) tagger.dispose() } catch (e) { }
                        }
                        updated = true
                    }
                    if (existing.size !== stats.size || existing.hasLyric !== hasLyricOnDisk) updated = true
                    finalQuality = existing.quality
                } else {
                    // (New file logic remains same but uses hasLyricOnDisk)
                    let interval = ''
                    let bitrate: number | undefined
                    let sampleRate: number | undefined
                    let bitDepth: number | undefined
                    let hasEmbedLyric = false
                    let metadataWritable = false
                    let metadataError: string | undefined
                    const audioContainer = detectAudioContainer(filePath)

                    try {
                        const tagger = new MusicTagger()
                        tagger.loadPath(filePath)
                        // ① 优先从 ID3 读取元数据
                        if (tagger.title) songName = tagger.title
                        if (tagger.artist) singer = tagger.artist
                        if (tagger.album) album = tagger.album
                        if (hasValidEmbeddedCover(tagger.pictures)) hasCover = true

                        const dur = tagger.duration
                        interval = dur ? formatPlayTime(dur / 1000) : ''

                        bitrate = tagger.bitRate
                        sampleRate = tagger.sampleRate
                        bitDepth = tagger.bitDepth
                        finalQuality = detectQualityFromBitrate(tagger.bitRate, ext, tagger)

                        // [新增] 检测是否已嵌入歌词 USLT 标签
                        const lyricsInTag = tagger.lyrics
                        hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
                        metadataWritable = true

                        tagger.dispose()
                    } catch (e: any) {
                        metadataError = getMetadataUnsupportedMessage(audioContainer)
                    }

                    // ② 若 ID3 元数据缺失，尝试从文件名解析兜底
                    if (!songName || !singer) {
                        const segmentsShort = nameWithoutExt.split(' - ')
                        if (segmentsShort.length >= 2) {
                            if (!songName) songName = segmentsShort[0]
                            if (!singer) singer = segmentsShort[1]
                            if (!album && segmentsShort.length > 3) album = segmentsShort.slice(3).join(' - ')
                        }
                    }

                    const hasExternalCover = !hasCover && hasCachedCover(file, normalizedUsername, stats)
                    if (hasExternalCover) hasCover = true
                    const coverType: CacheItem['coverType'] = hasCover && !hasExternalCover
                        ? 'embedded'
                        : hasExternalCover
                            ? 'cached'
                            : 'none'
                    hasCover = coverType !== 'none'

                    const item: CacheItem = {
                        id: normalizedId,
                        songmid: normalizedId,
                        name: songName || nameWithoutExt || 'Unknown',
                        singer: singer || 'Unknown',
                        album: album || '',
                        albumId: '',
                        img: '',
                        interval: interval,
                        source: source || 'local',
                        quality: finalQuality as any,
                        filename: file,
                        folder: folder as any,
                        subPath,
                        mtime: stats.mtimeMs,
                        size: stats.size,
                        lyricFilename: hasLyricOnDisk ? lrcFile : undefined,
                        ext: ext.replace('.', ''),
                        hasCover: hasCover,
                        coverType,
                        hasLyric: hasLyricOnDisk,
                        hasEmbedLyric,
                        audioContainer,
                        metadataWritable,
                        metadataError,
                        coverCheckedVersion: COVER_CHECK_VERSION,
                        coverCheckedMtime: stats.mtimeMs,
                        coverCheckedSize: stats.size,
                        bitrate: bitrate,
                        sampleRate: sampleRate,
                        bitDepth: bitDepth
                    }
                    existing = item
                }
                updated = true
            }

            const compositeKey = `${normalizedId}_${finalQuality || 'unknown'}`
            foundKeysOnDisk.add(compositeKey)

            if (oldKey && oldKey !== compositeKey) {
                index.delete(oldKey)
                index.set(compositeKey, existing!)
                updated = true
            } else if (!oldKey) {
                index.set(compositeKey, existing!)
            }

            // Yield control back to Node.js event loop
            await new Promise(resolve => setImmediate(resolve))
        }

        // Remove deleted files from index
        for (const key of existingKeysInIndex) {
            if (!foundKeysOnDisk.has(key)) {
                index.delete(key)
                updated = true
            }
        }

        if (updated) {
            indexManager.save(normalizedUsername, folder)
        }
    }

    const userLoc = getUserCacheLocation(normalizedUsername)
    const syncKey = `${userLoc}:${normalizedUsername}`
    const syncState = cacheListSyncState.get(syncKey) || { lastSync: 0 }
    syncState.lastSync = Date.now()
    cacheListSyncState.set(syncKey, syncState)
}

/**
 * Get detailed cache list for a user (indexed)
 */
export const getCacheList = async (username?: string) => {
    const normalizedUsername = normalizeUsername(username)

    // Keep indexed metadata aligned with disk. This also repairs stale hasCover values
    // from older indexes where the cover endpoint may already return 404.
    const cacheDir = getCacheDir(normalizedUsername, false)
    const musicDir = getCacheDir(normalizedUsername, true)
    const hasCacheIndex = fs.existsSync(path.join(cacheDir, 'cache_index.json'))
    const hasMusicIndex = fs.existsSync(path.join(musicDir, 'music_index.json'))

    const userLoc = getUserCacheLocation(normalizedUsername)
    const syncKey = `${userLoc}:${normalizedUsername}`
    const syncState = cacheListSyncState.get(syncKey) || { lastSync: 0 }
    const mustSync = !hasCacheIndex || !hasMusicIndex
    const shouldSync = mustSync || Date.now() - syncState.lastSync > CACHE_LIST_SYNC_TTL

    if (shouldSync) {
        if (!syncState.pending) {
            syncState.pending = syncCacheIndex(normalizedUsername)
                .then(() => { syncState.lastSync = Date.now() })
                .finally(() => { syncState.pending = undefined })
            cacheListSyncState.set(syncKey, syncState)
        }
        await syncState.pending
    }

    const cacheItems = indexManager.getAll(normalizedUsername, 'cache')
    const musicItems = indexManager.getAll(normalizedUsername, 'music')
    const items = [...cacheItems, ...musicItems]

    return items.map(item => ({
        ...item,
        songInfo: {
            id: item.id,
            songmid: item.songmid || item.id,
            name: item.name,
            singer: item.singer,
            source: item.source,
            quality: item.quality,
            albumName: item.album,
            albumId: item.albumId,
            img: item.img,
            interval: item.interval,
            type: item.quality, // Compatibility
            types: {} // To be filled if needed
        },
        hasLyric: item.hasLyric || !!item.lyricFilename
    }))
}

/**
 * Batch rename existing files to the user's configured naming pattern
 */
export const batchRenameCacheFiles = async (username: string | undefined) => {
    const normalizedUsername = normalizeUsername(username)
    const folders: Array<'cache' | 'music'> = ['cache', 'music']

    let successCount = 0
    let failCount = 0
    let skipCount = 0

    for (const folder of folders) {
        const index = indexManager.load(normalizedUsername, folder)
        const items = Array.from(index.values())
        let folderUpdated = false

        for (const item of items) {
            const songInfo = {
                id: item.id,
                songmid: item.songmid || item.id,
                name: item.name,
                singer: item.singer,
                source: item.source,
                quality: item.quality,
                albumName: item.album,
                albumId: item.albumId,
                img: item.img,
                interval: item.interval
            }

            const newBaseName = getFileName(songInfo, item.quality, folder === 'music', normalizedUsername)
            const subPath = item.subPath || ''
            const newFilename = subPath ? path.join(subPath, `${newBaseName}.${item.ext}`).replace(/\\/g, '/') : `${newBaseName}.${item.ext}`

            if (newFilename === item.filename) {
                skipCount++
                continue
            }

            const dir = getCacheDir(normalizedUsername, folder === 'music')
            const oldPath = path.join(dir, item.filename)
            const newPath = path.join(dir, newFilename)

            try {
                if (fs.existsSync(oldPath)) {
                    if (!fs.existsSync(newPath)) {
                        const targetDir = path.dirname(newPath)
                        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
                        const oldStats = fs.statSync(oldPath)
                        const externalCover = readCoverCache(item.filename, normalizedUsername, oldStats)
                        fs.renameSync(oldPath, newPath)

                        if (item.lyricFilename) {
                            const oldLrcPath = path.join(dir, item.lyricFilename)
                            const newLrcFilename = subPath ? path.join(subPath, `${newBaseName}.lrc`).replace(/\\/g, '/') : `${newBaseName}.lrc`
                            const newLrcPath = path.join(dir, newLrcFilename)
                            if (fs.existsSync(oldLrcPath)) {
                                fs.renameSync(oldLrcPath, newLrcPath)
                                item.lyricFilename = newLrcFilename
                            }
                        }

                        item.filename = newFilename
                        if (externalCover) {
                            writeCoverCache(newFilename, normalizedUsername, externalCover.data, externalCover.mime, fs.statSync(newPath))
                            item.coverType = 'cached'
                            item.hasCover = true
                        }
                        successCount++
                        folderUpdated = true
                    } else {
                        failCount++
                    }
                } else {
                    failCount++
                }
            } catch (e) {
                console.error(`[文件缓存] 批量重命名文件失败 (${folder}/${item.filename}):`, e)
                failCount++
            }
        }

        if (folderUpdated) {
            indexManager.save(normalizedUsername, folder)
        }
    }

    return { success: true, successCount, failCount, skipCount }
}

/**
 * Batch update ID3 metadata (title, artist, album, cover) from index to physical files
 */
export const batchUpdateMetadata = async (filenames: string[], username: string | undefined) => {
    const normalizedUsername = normalizeUsername(username)
    let successCount = 0
    let failCount = 0

    const allItems = [
        ...indexManager.getAll(normalizedUsername, 'cache'),
        ...indexManager.getAll(normalizedUsername, 'music')
    ]

    for (const filename of filenames) {
        const item = allItems.find(i => i.filename === filename)
        if (!item) {
            failCount++
            continue
        }

        const dir = getCacheDir(normalizedUsername, item.folder === 'music')
        const filePath = path.join(dir, item.filename)

        if (!fs.existsSync(filePath)) {
            failCount++
            continue
        }

        try {
            let imageBuffer: Buffer | undefined
            let imageMime = 'image/jpeg'
            const imageUrl = item.img
            if (imageUrl && imageUrl.startsWith('http') && !isPlaceholderCoverUrl(imageUrl)) {
                const chunks: Buffer[] = []
                const p = imageUrl.startsWith('https') ? https : http
                imageBuffer = await new Promise<Buffer>((resolveI, rejectI) => {
                    const req = p.get(imageUrl, ires => {
                        if ((ires.statusCode || 500) >= 400) {
                            ires.resume()
                            rejectI(new Error(`Cover status: ${ires.statusCode}`))
                            return
                        }
                        imageMime = String(ires.headers['content-type'] || 'image/jpeg').split(';')[0]
                        ires.on('data', c => chunks.push(c))
                        ires.on('end', () => resolveI(Buffer.concat(chunks)))
                        ires.on('error', rejectI)
                    })
                    req.on('error', rejectI)
                    setTimeout(() => { req.destroy(); rejectI(new Error('Timeout')) }, 8000)
                }).catch(() => undefined)
            }

            let tagger: any
            let taggerError: any
            try {
                tagger = new MusicTagger()
                tagger.loadPath(filePath)
                tagger.title = item.name || 'Unknown'
                tagger.artist = item.singer || 'Unknown'
                if (item.album) tagger.album = item.album
                if (imageBuffer && imageBuffer.length > 0) {
                    tagger.pictures = [new MetaPicture(imageMime, new Uint8Array(imageBuffer), 'Cover')]
                }
                tagger.save()
            } catch (e) {
                taggerError = e
            } finally {
                try { if (tagger) tagger.dispose() } catch (e) { }
            }
            stripOversizedEmbeddedCover(filePath)

            const stats = fs.statSync(filePath)
            const hasEmbeddedCover = readEmbeddedCoverState(filePath)
            let hasCover = hasEmbeddedCover || hasCachedCover(item.filename, normalizedUsername, stats)
            if (!hasCover && imageBuffer?.length) {
                hasCover = writeCoverCache(item.filename, normalizedUsername, imageBuffer, imageMime, stats)
                if (taggerError) {
                    console.warn(`[文件缓存] 无法向音频写入标签信息 (${filename})，已转存为外置封面缓存`)
                }
            }
            if (taggerError && !hasCover) throw taggerError
            item.hasCover = hasCover
            item.coverType = hasEmbeddedCover ? 'embedded' : hasCover ? 'cached' : hasUsableRemoteCover(item.img) ? 'remote' : 'none'
            item.metadataWritable = !taggerError
            item.audioContainer = detectAudioContainer(filePath)
            item.metadataError = taggerError ? getMetadataUnsupportedMessage(item.audioContainer) : undefined
            item.coverCheckedVersion = COVER_CHECK_VERSION
            item.coverCheckedMtime = stats.mtimeMs
            item.coverCheckedSize = stats.size
            item.mtime = stats.mtimeMs
            item.size = stats.size

            indexManager.update(normalizedUsername, item, item.folder as 'cache' | 'music')
            successCount++
        } catch (e) {
            console.error(`[文件缓存] 更新元数据标签失败 (${filename}):`, e)
            failCount++
        }
    }

    return { successCount, failCount }
}

/**
 * Link an unindexed local file to a specific online song identity
 */
export const linkLocalFile = async (oldFilename: string, songInfo: any, username: string | undefined) => {
    const normalizedUsername = normalizeUsername(username)

    // Find the item in all possible folders
    const allItems = [
        ...indexManager.getAll(normalizedUsername, 'cache'),
        ...indexManager.getAll(normalizedUsername, 'music')
    ]
    const item = allItems.find(i => i.filename === oldFilename)
    if (!item) throw new Error('File not found in index')

    const folder = item.folder as 'cache' | 'music'
    const dir = getCacheDir(normalizedUsername, folder === 'music')
    const oldPath = path.join(dir, item.filename)
    if (!fs.existsSync(oldPath)) throw new Error('Physical file not found')

    // Prepare new metadata from songInfo
    const metadata = extractSongMetadata(songInfo)
    const newId = metadata.id
    const quality = item.quality || 'unknown'
    const ext = item.ext ? `.${item.ext}` : path.extname(oldFilename)

    // Generate new filename based on pattern (preserving subPath)
    const newBaseName = getFileName(songInfo, quality, folder === 'music', normalizedUsername)
    const subPath = item.subPath || ''
    const newFilename = subPath ? path.join(subPath, newBaseName + ext).replace(/\\/g, '/') : newBaseName + ext
    const newPath = path.join(dir, newFilename)

    // Check collision
    if (newFilename !== oldFilename && fs.existsSync(newPath)) {
        throw new Error('Target filename already exists on disk')
    }

    // 1. Rename physical file
    if (newFilename !== oldFilename) {
        fs.renameSync(oldPath, newPath)
        // Also rename lyrics if exists
        if (item.lyricFilename) {
            const oldLrcPath = path.join(dir, item.lyricFilename)
            const newLrcFilename = subPath ? path.join(subPath, newBaseName + '.lrc').replace(/\\/g, '/') : newBaseName + '.lrc'
            const newLrcPath = path.join(dir, newLrcFilename)
            if (fs.existsSync(oldLrcPath)) {
                fs.renameSync(oldLrcPath, newLrcPath)
                item.lyricFilename = newLrcFilename
            }
        }
    }

    // 2. Update Index
    // Remove old entry (keyed by old ID and quality)
    indexManager.remove(normalizedUsername, item.id, folder, item.quality)

    // Update item properties
    item.id = newId
    item.songmid = newId
    item.name = metadata.name
    item.singer = metadata.singer
    item.album = metadata.album
    item.albumId = metadata.albumId
    item.img = metadata.img
    item.source = metadata.source
    item.filename = newFilename
    item.mtime = Date.now()

    // Add back to index with new identity
    indexManager.update(normalizedUsername, item, folder)

    // 3. Post-link processing: Update ID3 tags and cover
    await batchUpdateMetadata([newFilename], normalizedUsername)

    return {
        success: true,
        filename: newFilename,
        id: newId,
        metadata
    }
}


const downloadCoverImage = async (imageUrl: string, redirects = 0): Promise<{ data: Buffer; mime: string } | null> => {
    if (!hasUsableRemoteCover(imageUrl) || redirects > 3) return null
    return await new Promise((resolve) => {
        const client = imageUrl.startsWith('https:') ? https : http
        const req = client.get(imageUrl, response => {
            const statusCode = response.statusCode || 500
            if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
                response.resume()
                const redirectedUrl = new URL(response.headers.location, imageUrl).toString()
                void downloadCoverImage(redirectedUrl, redirects + 1).then(resolve)
                return
            }
            if (statusCode >= 400) {
                response.resume()
                resolve(null)
                return
            }
            const chunks: Buffer[] = []
            let received = 0
            response.on('data', chunk => {
                const buffer = Buffer.from(chunk)
                received += buffer.length
                if (received <= 20 * 1024 * 1024) chunks.push(buffer)
            })
            response.on('end', () => {
                if (received > 20 * 1024 * 1024) {
                    resolve(null)
                    return
                }
                const data = Buffer.concat(chunks)
                const mime = detectImageMime(data)
                resolve(mime ? { data, mime } : null)
            })
            response.on('error', () => resolve(null))
        })
        req.on('error', () => resolve(null))
        req.setTimeout(10000, () => {
            req.destroy()
            resolve(null)
        })
    })
}

const setIndexCoverState = (filename: string, username: string, coverType: CacheItem['coverType'], stats?: Stats, location?: string) => {
    for (const folder of ['cache', 'music'] as const) {
        const item = indexManager.getAll(username, folder, location).find(candidate => candidate.filename === filename)
        if (!item) continue
        item.coverType = coverType
        item.hasCover = coverType !== 'none'
        item.coverCheckedVersion = COVER_CHECK_VERSION
        if (stats) {
            item.coverCheckedMtime = stats.mtimeMs
            item.coverCheckedSize = stats.size
        }
        indexManager.save(username, folder, location)
        return item
    }
    return null
}

/**
 * Get cover image for a cached file
 */
export const getCacheCover = async (filename: string, username?: string) => {
    const normalizedUsername = normalizeUsername(username)
    const userLoc = getUserCacheLocation(normalizedUsername)

    const locations = [
        userLoc,
        userLoc === CACHE_ROOTS.DATA ? CACHE_ROOTS.ROOT : CACHE_ROOTS.DATA
    ]
    const roots: Array<'cache' | 'music'> = ['cache', 'music']

    for (const loc of locations) {
        for (const folder of roots) {
            const dir = getCacheDir(normalizedUsername, folder === 'music', loc)
            const filePath = resolveCacheRelativePath(dir, filename) // [Fix] Allow subfolders safely

            if (filePath && fs.existsSync(filePath)) {
                let stats: Stats | undefined
                try {
                    stats = fs.statSync(filePath)
                    const cachedCover = readCoverCache(filename, normalizedUsername, stats)
                    if (cachedCover) {
                        setIndexCoverState(filename, normalizedUsername, 'cached', stats, loc)
                        return cachedCover
                    }
                } catch (e) {
                    console.error(`[文件缓存] 读取封面缓存失败 (${filename}):`, e)
                }

                let tagger: any
                try {
                    tagger = new MusicTagger()
                    tagger.loadPath(filePath)
                    const pics = tagger.pictures
                    const pic = Array.isArray(pics) ? pics.find(hasValidPictureData) : null
                    if (pic) {
                        const mime = pic.mimeType || 'image/jpeg'
                        const data = Buffer.from(pic.data)
                        writeCoverCache(filename, normalizedUsername, data, mime, stats)
                        setIndexCoverState(filename, normalizedUsername, 'embedded', stats, loc)
                        return { data, mime: detectImageMime(data) || mime }
                    }
                } catch (e) {
                    // console.error(`[文件缓存] 读取音频内嵌封面标签失败 (${filename}):`, e)
                } finally {
                    try { if (tagger) tagger.dispose() } catch (e) { }
                }

                const item = [...indexManager.getAll(normalizedUsername, 'cache', loc), ...indexManager.getAll(normalizedUsername, 'music', loc)]
                    .find(candidate => candidate.filename === filename)
                if (item && hasUsableRemoteCover(item.img)) {
                    const remoteCover = await downloadCoverImage(item.img!)
                    if (remoteCover && writeCoverCache(filename, normalizedUsername, remoteCover.data, remoteCover.mime, stats)) {
                        setIndexCoverState(filename, normalizedUsername, 'cached', stats, loc)
                        return remoteCover
                    }
                }

                setIndexCoverState(filename, normalizedUsername, 'none', stats, loc)
            }
        }
    }
    return null
}

/**
 * 递归安全清理空文件夹（不会删除根目录 baseDir）
 */
export const cleanEmptyParentDirs = (filePath: string, baseDir: string) => {
    try {
        const resolvedBase = path.resolve(baseDir)
        let currentDir = path.resolve(path.dirname(filePath))

        while (currentDir !== resolvedBase && currentDir.startsWith(resolvedBase + path.sep)) {
            if (fs.existsSync(currentDir)) {
                const entries = fs.readdirSync(currentDir)
                if (entries.length === 0) {
                    try {
                        fs.rmdirSync(currentDir)
                        if (global.lx?.config?.['debug.enabled']) {
                            console.log(`[文件缓存] [Debug] 已清理空歌单目录: ${currentDir}`)
                        }
                    } catch (rmErr) {
                        break
                    }
                } else {
                    // 当前目录非空，无需继续向上清理
                    break
                }
            } else {
                break
            }
            currentDir = path.dirname(currentDir)
        }
    } catch (e) {
        if (global.lx?.config?.['debug.enabled']) {
            console.warn(`[文件缓存] [Debug] 清理空目录失败:`, e)
        }
    }
}

/**
 * Remove a specific cache file
 */
export const removeCacheFile = (filename: string, username?: string, requestedFolder?: CacheFolder): RemoveCacheFileResult => {
    if (!filename || typeof filename !== 'string') throw new Error('Invalid filename')
    if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') throw new Error('Invalid folder')

    const normalizedUsername = normalizeUsername(username)
    const candidateFolders: CacheFolder[] = requestedFolder ? [requestedFolder] : ['cache', 'music']
    const matches = candidateFolders.map(folder => {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        const filePath = resolveCacheRelativePath(dir, filename)
        return filePath && fs.existsSync(filePath) ? { folder, dir, filePath } : null
    }).filter((entry): entry is { folder: CacheFolder; dir: string; filePath: string } => entry !== null)

    // Older clients only sent a filename. Keep that format safe when the file has
    // a unique location, but never guess if cache and download both contain it.
    if (!requestedFolder && matches.length > 1) {
        throw new Error(`Ambiguous file location for ${filename}; folder is required`)
    }
    if (matches.length === 0) return { deleted: false }

    const { folder, dir, filePath } = matches[0]
    let coverCacheHash = ''
    try {
        coverCacheHash = getCoverCacheHash(filename, fs.statSync(filePath))
    } catch (e) { }

    try {
        fs.unlinkSync(filePath)
    } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e
    }
    const folderName = folder === 'music' ? '下载目录(music)' : '缓存目录(cache)'
    console.log(`[文件缓存] 已从 ${folderName} 删除: ${filename}`)

    const ext = path.extname(filename)
    if (ext !== '.lrc') {
        const baseWithoutExt = filename.substring(0, filename.length - ext.length)
        const lrcPath = resolveCacheRelativePath(dir, baseWithoutExt + '.lrc')
        if (lrcPath && fs.existsSync(lrcPath)) {
            try {
                fs.unlinkSync(lrcPath)
            } catch (e: any) {
                if (e?.code !== 'ENOENT') throw e
            }
        }
    }

    // 删除音频与歌词后，清理可能变空的父级歌单分类目录
    cleanEmptyParentDirs(filePath, dir)

    const items = indexManager.getAll(normalizedUsername, folder)
    const item = items.find(i => i.filename === filename)
    if (item) indexManager.remove(normalizedUsername, item.id, folder, item.quality)

    // Cover cache is shared by filename. Preserve it while the same relative file
    // still exists in the other root so deleting cache does not affect downloads.
    const otherFolder: CacheFolder = folder === 'cache' ? 'music' : 'cache'
    const otherDir = getCacheDir(normalizedUsername, otherFolder === 'music')
    const otherPath = resolveCacheRelativePath(otherDir, filename)
    const hasCounterpart = !!otherPath && fs.existsSync(otherPath)
    if (!hasCounterpart) {
        try {
            const coverCacheDir = getCoverCacheDir(normalizedUsername)
            const hashes = [coverCacheHash, crypto.createHash('md5').update(filename).digest('hex')].filter(Boolean)
            for (const hash of hashes) {
                const binPath = path.join(coverCacheDir, `${hash}.bin`)
                const mimePath = path.join(coverCacheDir, `${hash}.mime`)
                if (fs.existsSync(binPath)) fs.unlinkSync(binPath)
                if (fs.existsSync(mimePath)) fs.unlinkSync(mimePath)
            }
        } catch (e) { }
    }

    return { deleted: true, folder }
}

export const setCacheLocation = (location: string) => {
    if (location === CACHE_ROOTS.DATA || location === CACHE_ROOTS.ROOT) {
        currentCacheLocation = location
        console.log(`[文件缓存] 基础缓存根路径设置为: ${location}`)
    }
}

export const getCacheLocation = () => currentCacheLocation

/** 缓存体检结论 */
export interface CacheAuditFinding {
    verdict: 'dirty' | 'clean' | 'unverified'
    reason?: string
    id: string
    name: string
    singer: string
    filename: string
    quality: string
    /** 文件真实时长（秒） */
    actualSec: number
    /** 索引/请求声明的时长（秒） */
    expectedSec: number
    bitrate?: number
    /** 来源没有对应音源脚本（local/直链），不具备回查条件，按通过处理 */
    skipped?: boolean
}

/**
 * 体检单条缓存：解码真实时长 → 跑三道判据（时长/码率、ID3 标签、源侧登记）。
 *
 * 为什么不能只看索引里的 `interval`：脏缓存的 `interval` 本身就是被污染过的
 * （现场那条记录 interval=03:53，正好等于兜底音频的长度），用索引值自比一定会「一致」。
 * 所以必须重新解码文件，拿真实时长去和源侧登记比对。
 */
export const auditCacheItem = async (
    item: CacheItem,
    username: string,
    folder: 'cache' | 'music' = 'cache',
): Promise<CacheAuditFinding> => {
    const dir = getCacheDir(username, folder === 'music')
    const filePath = path.join(dir, item.filename || '')
    const base: CacheAuditFinding = {
        verdict: 'unverified',
        id: item.id,
        name: item.name,
        singer: item.singer,
        filename: item.filename,
        quality: item.quality,
        actualSec: 0,
        expectedSec: parseDurationSeconds(item.interval),
        bitrate: item.bitrate,
    }
    if (!item.filename || !fs.existsSync(filePath)) {
        return { ...base, verdict: 'dirty', reason: '文件不存在（索引残留）' }
    }

    let inspection: ReturnType<typeof inspectAudioFile> | null = null
    try {
        inspection = inspectAudioFile(filePath, item.quality)
    } catch {
        inspection = null
    }
    const actualSec = inspection?.duration ? Math.round(inspection.duration / 1000) : 0
    const bitrate = Number(inspection?.bitrate) || Number(item.bitrate) || 0
    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : item.size
    base.actualSec = actualSec
    base.bitrate = bitrate

    const local = judgeAudioMismatch({ expectedSec: base.expectedSec, actualSec, bitrate, sizeBytes: size })
        || judgeMetadataMismatch(item.name, item.singer, inspection?.title, inspection?.artist)
    if (local) return { ...base, verdict: 'dirty', reason: local }

    if (actualSec <= 0) return { ...base, verdict: 'unverified', reason: '无法解码出时长' }

    // local / 直链来源没有音源脚本，不存在「音源兜底返回别曲」这回事。
    // 直接在本地判据通过后放行，否则体检报告会被这类条目占满「无法判定」。
    if (!canVerifyOrigin(item.source)) {
        return { ...base, verdict: 'clean', skipped: true, reason: '本地/直链来源，无音源可回查' }
    }

    const origin = await verifyTrackOrigin(item, actualSec, { expectedSec: base.expectedSec })
    if (origin.verdict === 'suspect') return { ...base, verdict: 'dirty', reason: origin.reason }
    if (origin.verdict === 'ok') return { ...base, verdict: 'clean' }
    return { ...base, verdict: 'unverified', reason: origin.searched ? '源侧信息不足，无法判定' : '缺少音源标识，无法回查' }
}

/** 命中路径的核验去重：同一份文件在飞行中只核验一次 */
const originVerifyInflight = new Set<string>()

/**
 * 命中缓存后的旁路核验（fire-and-forget）。
 *
 * `checkCache` 是同步函数、被投送链路直接调用，不能在这里等网络。
 * 所以先照常返回缓存，后台再核验；核验不通过就删文件 + 移出索引，
 * 下一次请求自然会重新解析。代价是「最多多放错一次」，换来投送延迟零增加。
 */
const scheduleOriginVerify = (
    username: string,
    folder: 'cache' | 'music',
    songId: string,
    cached: CacheItem,
    filePath: string,
    songInfo: any,
) => {
    const key = `${username}|${folder}|${songId}|${cached.quality}`
    if (originVerifyInflight.has(key)) return
    originVerifyInflight.add(key)

    void (async () => {
        try {
            const finding = await auditCacheItem(cached, username, folder)
            if (finding.verdict === 'dirty') {
                const line = `[文件缓存] 命中后核验为脏缓存 (${cached.filename})：${finding.reason}，予以剔除`
                console.warn(line)
                syncLog.warn(line)
                indexManager.remove(username, songId, folder, cached.quality)
                try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) } catch { }
            } else if (finding.verdict === 'clean') {
                // 核验通过就打标记，之后命中不再重复回查音源
                indexManager.update(username, { ...cached, originVerifiedAt: Date.now() }, folder)
            }
        } catch {
            /* 核验是增强项，任何异常都不影响播放 */
        } finally {
            originVerifyInflight.delete(key)
        }
    })()
}

export const checkCache = (songInfo: any, username?: string, isLyricCheck: boolean = false) => {
    try {
        const id = normalizeSongId(songInfo)
        const quality = songInfo.quality || 'unknown'
        const normalizedUsername = normalizeUsername(username)

        // 1. Search by exact ID and Quality (Primary Check)
        // exactQuality=true 时：精确匹配，不允许 fallback 到不同音质
        const useExact = !!songInfo.exactQuality
        // 同一音质的下载文件优先于缓存副本；任意音质的兜底仍保持缓存目录优先，避免高音质被降级
        const lookupOrder: Array<{ folder: 'cache' | 'music'; anyQuality: boolean }> = [
            { folder: 'music', anyQuality: false },
            { folder: 'cache', anyQuality: false },
            { folder: 'cache', anyQuality: true },
            { folder: 'music', anyQuality: true }
        ]
        for (const { folder, anyQuality } of lookupOrder) {
            const cached = indexManager.get(normalizedUsername, id, folder, quality, !anyQuality || useExact)
            if (cached) {
                // 二次校验：exactQuality 模式下确保音质匹配
                if (useExact && quality && cached.quality !== quality) continue
                const dir = getCacheDir(normalizedUsername, folder === 'music')
                const fileName = isLyricCheck ? cached.lyricFilename : cached.filename
                if (!fileName) continue
                const filePath = path.join(dir, fileName)
                if (fs.existsSync(filePath)) {
                    // [防投毒] 缓存记录的时长/码率与请求明显不符时（试听片段、静音占位、串成整张专辑），
                    // 忽略并剔除脏缓存，让它重新走一次解析。
                    // 这里不依赖「期望时长 > 60s」：调用方没给 interval 时（/play 的兜底路径）原来会整段跳过，
                    // 结果就是占位音落盘后长期被命中，用户点歌听到静音还查不出原因。
                    if (!isLyricCheck) {
                        const reason = judgeAudioMismatch({
                            expectedSec: parseDurationSeconds(songInfo.interval || songInfo.meta?.interval),
                            actualSec: parseDurationSeconds(cached.interval),
                            bitrate: cached.bitrate,
                            sizeBytes: cached.size,
                        })
                        if (reason) {
                            const line = `[文件缓存] 命中与曲目不符的缓存 (${cached.filename})：${reason}，予以忽略并剔除`
                            console.warn(line)
                            syncLog.warn(line)
                            indexManager.remove(normalizedUsername, id, folder, cached.quality)
                            try { fs.unlinkSync(filePath) } catch { }
                            continue
                        }
                    }
                    // [汽水解密] CENC 加密流（汽水正式版权曲）浏览器解不开。若缓存条目带解密密钥，
                    // 就地解密成明文再继续播放；否则维持旧行为：改名隔离，不进索引、不再被命中。
                    if (!isLyricCheck && isEncryptedAudioFile(filePath)) {
                        const cachedKey = cached?.decryptKey
                        let decrypted = false
                        if (cachedKey) {
                            try {
                                const buf = fs.readFileSync(filePath)
                                // 这条路径在同步的 checkCache 里，且只在「旧版本留下的带密钥缓存条目」
                                // 上触发一次（解完就删 decryptKey），保持同步版即可。
                                // 每次播放都会走的热路径（下载完成后解密）用的是异步版。
                                const dec = decryptAudioBuffer(buf, cachedKey)
                                fs.writeFileSync(filePath, dec.buffer)
                                cached.ext = dec.extension.replace(/^\./, '')
                                cached.audioContainer = dec.codec
                                cached.size = dec.buffer.length
                                delete cached.decryptKey
                                indexManager.update(normalizedUsername, cached, folder)
                                indexManager.save(normalizedUsername, folder)
                                decrypted = true
                                console.log(`[文件缓存] 已就地解密缓存的 CENC 音频: ${cached.filename} (${dec.codec})`)
                            } catch (e: any) {
                                console.warn(`[文件缓存] 缓存 CENC 解密失败，回退隔离: ${cached.filename} - ${e?.message || e}`)
                            }
                        }
                        if (!decrypted) {
                            const archived = `${filePath}.encrypted`
                            const line = `[文件缓存] 命中 CENC 加密音频，浏览器无法播放，已隔离: ${cached.filename}`
                            console.warn(line)
                            syncLog.warn(line)
                            indexManager.remove(normalizedUsername, id, folder, cached.quality)
                            try { if (!fs.existsSync(archived)) fs.renameSync(filePath, archived) } catch { }
                            continue
                        }
                    }
                    // 老条目（1.5.27 之前写入）没有源侧核验标记：命中时挂一个后台核验。
                    // 本地两条判据在这类条目上常常同时失效（标签缺失 + 时长接近），
                    // 只有问过音源才知道音频到底是不是这首。
                    if (!isLyricCheck && !cached.originVerifiedAt) {
                        scheduleOriginVerify(normalizedUsername, folder, id, cached, filePath, songInfo)
                    }
                    return {
                        exists: true,
                        path: filePath,
                        filename: fileName,
                        foundIn: normalizedUsername,
                        quality: cached.quality,
                        folder: folder,
                        url: `/api/music/cache/file/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(fileName)}?folder=${folder}`
                    }                } else {
                    // Stale index entry, cleanup
                    if (!isLyricCheck) indexManager.remove(normalizedUsername, id, folder, cached.quality)
                }
            }
        }

        // 2. Search for Naming Collisions (Same Name + Singer + Quality, but different ID)
        const allItems = [
            ...indexManager.getAll(normalizedUsername, 'cache'),
            ...indexManager.getAll(normalizedUsername, 'music')
        ]

        const collision = allItems.find(item =>
            item.id !== id && // 排除当前正在查询的 ID 本身
            item.name.toLowerCase() === String(songInfo.name || '').toLowerCase() &&
            item.singer.toLowerCase() === String(songInfo.singer || '').toLowerCase() &&
            item.quality === quality &&
            (!isLyricCheck || item.hasLyric)
        )

        if (collision) {
            return {
                exists: true,
                isCollision: true,
                collisionSource: collision.source,
                collisionSongmid: collision.songmid,
                filename: isLyricCheck ? collision.lyricFilename : collision.filename,
                quality: collision.quality,
                foundIn: normalizedUsername,
                folder: collision.folder
            }
        }

        // 3. Fallback for non-exact (only if requested)
        if (!songInfo.exactQuality && !isLyricCheck) {
            const folderTypes: Array<'cache' | 'music'> = ['cache', 'music']
            for (const folder of folderTypes) {
                const cachedAny = indexManager.get(normalizedUsername, id, folder)
                if (cachedAny) {
                    const dir = getCacheDir(normalizedUsername, folder === 'music')
                    const fileName = cachedAny.filename
                    const filePath = path.join(dir, fileName)
                    if (fs.existsSync(filePath)) {
                        const expectedSec = parseDurationSeconds(songInfo.interval || songInfo.meta?.interval)
                        if (expectedSec > 60) {
                            const cachedDurSec = parseDurationSeconds(cachedAny.interval)
                            const isCachedTeaser = (cachedDurSec > 0 && (cachedDurSec < 60 || cachedDurSec < expectedSec * 0.5)) ||
                                (cachedAny.size && cachedAny.size < 750 * 1024 && expectedSec > 120 && cachedAny.quality === '128k')
                            if (isCachedTeaser) {
                                console.warn(`[文件缓存] 命中损坏的试听片段缓存 (${cachedAny.filename})，予以忽略并剔除`)
                                indexManager.remove(normalizedUsername, id, folder, cachedAny.quality)
                                try { fs.unlinkSync(filePath) } catch { }
                                continue
                            }
                        }
                        return {
                            exists: true,
                            path: filePath,
                            filename: fileName,
                            foundIn: normalizedUsername,
                            quality: cachedAny.quality,
                            folder: folder,
                            url: `/api/music/cache/file/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(fileName)}?folder=${folder}`
                        }
                    }
                }
            }
        }

    } catch (e) {
        console.error('[文件缓存] 检查缓存状态异常:', e)
    }

    return { exists: false }
}

export const checkLyricCache = (songInfo: any, username?: string) => {
    const id = normalizeSongId(songInfo)
    const normalizedUsername = normalizeUsername(username)

    // Check index first
    const folderTypes: Array<'cache' | 'music'> = ['cache', 'music']
    for (const folder of folderTypes) {
        const cached = indexManager.get(normalizedUsername, id, folder, songInfo.quality)
        if (cached && cached.hasLyric && cached.lyricFilename) {
            const dir = getCacheDir(normalizedUsername, folder === 'music')
            const lrcPath = path.join(dir, cached.lyricFilename)
            if (fs.existsSync(lrcPath)) {
                return {
                    exists: true,
                    path: lrcPath,
                    content: parseLyrics(fs.readFileSync(lrcPath, 'utf-8')),
                    filename: cached.lyricFilename
                }
            }
        }
    }

    // [Fix] Index-based name+singer fallback for the simple naming pattern
    // When the lrc filename does not contain a song ID, match by name + singer from the index
    if (songInfo.name && songInfo.singer) {
        const targetName = String(songInfo.name).toLowerCase()
        const targetSinger = String(songInfo.singer).toLowerCase()
        for (const folder of folderTypes) {
            const allItems = indexManager.getAll(normalizedUsername, folder)
            const matched = allItems.find(item =>
                item.hasLyric &&
                item.lyricFilename &&
                item.name.toLowerCase() === targetName &&
                item.singer.toLowerCase() === targetSinger
            )
            if (matched && matched.lyricFilename) {
                const dir = getCacheDir(normalizedUsername, folder === 'music')
                const lrcPath = path.join(dir, matched.lyricFilename)
                if (fs.existsSync(lrcPath)) {
                    return {
                        exists: true,
                        path: lrcPath,
                        content: parseLyrics(fs.readFileSync(lrcPath, 'utf-8')),
                        filename: matched.lyricFilename
                    }
                }
            }
        }
    }

    // Physical scan fallback (for standard naming pattern: Name_-_Singer_-_Source_-_ID_-_Quality)
    const roots = ['cache', 'music']
    const basePaths = roots.map(folder => getCacheDir(normalizedUsername, folder === 'music'))

    // [Fix] Recursively search for lyrics if not in index
    const getAllLrcFiles = (dirPath: string, acc: string[] = []) => {
        if (!fs.existsSync(dirPath)) return acc
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name)
            if (entry.isDirectory()) {
                getAllLrcFiles(fullPath, acc)
            } else if (entry.name.endsWith('.lrc')) {
                acc.push(fullPath)
            }
        }
        return acc
    }

    const cleanId = (sid: string) => String(sid || '').replace(/^(tx|mg|wy|kg|kw|bd|mg)_/, '')
    const targetCleanId = cleanId(id)

    for (const dirPath of basePaths) {
        const lrcFiles = getAllLrcFiles(dirPath)
        for (const filePath of lrcFiles) {
            const file = path.basename(filePath)
            const fileNameWithoutExt = file.substring(0, file.lastIndexOf('.'))
            const segments = fileNameWithoutExt.split('_-_')
            if (segments.length >= 2) {
                const fileId = segments[segments.length - 2]
                const fileCleanId = cleanId(fileId)
                if (fileId === id || fileCleanId === id || fileId === targetCleanId || fileCleanId === targetCleanId) {
                    return {
                        exists: true,
                        path: filePath,
                        content: parseLyrics(fs.readFileSync(filePath, 'utf-8')),
                        filename: path.relative(dirPath, filePath).replace(/\\/g, '/')
                    }
                }
            }
        }
    }

    return { exists: false }
}

export const saveLyricCache = (songInfo: any, lyricsObj: any, username?: string, isOnlyDownload?: boolean) => {
    try {
        let baseName: string
        let quality = songInfo.quality || 'unknown'
        let dir: string

        const normalizedUsername = normalizeUsername(username)
        const id = normalizeSongId(songInfo)
        const preferredFolders: Array<'cache' | 'music'> = isOnlyDownload ? ['music', 'cache'] : ['cache', 'music']
        let audioResult: any = { exists: false }
        for (const folder of preferredFolders) {
            const cached = indexManager.get(normalizedUsername, id, folder, songInfo.quality, false)
            if (!cached?.filename) continue
            const root = getCacheDir(normalizedUsername, folder === 'music')
            const filePath = path.join(root, cached.filename)
            if (fs.existsSync(filePath)) {
                audioResult = {
                    exists: true,
                    path: filePath,
                    quality: cached.quality,
                    folder,
                    filename: cached.filename
                }
                break
            }
        }

        if (audioResult.exists && audioResult.path) {
            // If audio exists, save lyric in the same folder
            dir = path.dirname(audioResult.path)
            quality = audioResult.quality || quality
            baseName = path.basename(audioResult.path, path.extname(audioResult.path))
        } else {
            // 音质尚未确定且本地无同名音频：此时写出的文件名只能兜底成 unknown，
            // 而索引配对按同名 basename 进行，这份文件永远无人引用（孤儿），故不落盘
            if (!songInfo.quality) {
                console.log(`[文件缓存] 音质未确定且音频未缓存，跳过歌词落盘: ${id}`)
                return false
            }
            dir = ensureDir(username, isOnlyDownload)
            baseName = getFileName(songInfo, songInfo.quality, isOnlyDownload, username)
        }

        const lyricFile = baseName + '.lrc'
        const finalPath = path.join(dir, lyricFile)

        const formattedLrc = buildLyrics(lyricsObj)
        if (!formattedLrc) {
            console.log(`[文件缓存] 歌词内容为空 (${baseName})，跳过保存`)
            return false
        }

        // 同一首歌在投送/缓存/重试中会被反复调用，内容没变就不要重复写盘与刷日志
        let lyricChanged = true
        try {
            if (fs.existsSync(finalPath)) {
                lyricChanged = fs.readFileSync(finalPath, 'utf-8') !== formattedLrc
            }
        } catch {
            lyricChanged = true
        }
        if (lyricChanged) {
            fs.writeFileSync(finalPath, formattedLrc, { encoding: 'utf-8' })
            console.log(`[文件缓存] 歌词已成功保存至: ${finalPath}`)
        }

        // Update index — use normalizeSongId to ensure the ID has source prefix, matching index keys
        const foldersToUpdate: Array<'cache' | 'music'> = isOnlyDownload ? ['music', 'cache'] : ['cache', 'music']
        for (const folder of foldersToUpdate) {
            const existing = indexManager.get(normalizedUsername, id, folder, quality)
            if (existing) {
                const root = getCacheDir(normalizedUsername, folder === 'music')
                existing.lyricFilename = path.relative(root, finalPath).replace(/\\/g, '/')
                existing.hasLyric = true
                indexManager.save(normalizedUsername, folder)
                break
            }
        }
        void checkAndCleanupCache(username)
        return true
    } catch (err: any) {
        console.error(`[文件缓存] 保存歌词缓存失败: ${err.message}`)
        return false
    }
}

const QUALITY_TOKENS = ['flac24bit', 'atmos_plus', 'atmos', 'hires', 'master', 'ape', 'wav', 'flac', 'unknown', '192k', '320k', '128k']

// 只把文件名里的音质段换成目标音质；其余段（歌名/歌手/源/ID/专辑）必须原本就一致
const qualitySegmentOf = (baseName: string) => {
    const sep = baseName.includes('_-_') ? '_-_' : ' - '
    const found = baseName.split(sep).find(s => QUALITY_TOKENS.includes(s.trim().toLowerCase()))
    return found ? found.trim().toLowerCase() : null
}

const swapQualitySegment = (baseName: string, targetQuality: string): string | null => {
    const sep = baseName.includes('_-_') ? '_-_' : ' - '
    const segments = baseName.split(sep)
    const index = segments.findIndex(s => QUALITY_TOKENS.includes(s.trim().toLowerCase()))
    if (index === -1) return null
    if (segments[index].trim().toLowerCase() === targetQuality.toLowerCase()) return null
    segments[index] = targetQuality
    return segments.join(sep)
}

const collectLyricFiles = (dirPath: string, baseDir: string, acc: string[] = []) => {
    if (!fs.existsSync(dirPath)) return acc
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
            collectLyricFiles(fullPath, baseDir, acc)
        } else if (entry.name.toLowerCase().endsWith('.lrc')) {
            acc.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'))
        }
    }
    return acc
}

/**
 * 音频落盘后，把"除音质段外与音频同名且未被任何索引引用"的孤儿 .lrc 改名对齐到音频，并登记进索引。
 * 只在音频所在同一子目录内查找，避免把分类子目录里的歌词搬到根目录。
 */
export const alignOrphanLyric = (username: string | undefined, songId: string, quality: string | undefined, folder: CacheFolder) => {
    if (!songId || !quality) return false
    const normalizedUsername = normalizeUsername(username)
    const item = indexManager.get(normalizedUsername, songId, folder, quality, true)
    if (!item?.filename) return false
    const dir = getCacheDir(normalizedUsername, folder === 'music')
    const audioPath = resolveCacheRelativePath(dir, item.filename)
    if (!audioPath || !fs.existsSync(audioPath)) return false
    const targetLrcPath = path.join(path.dirname(audioPath), path.basename(audioPath, path.extname(audioPath)) + '.lrc')
    if (fs.existsSync(targetLrcPath)) {
        // 歌词先落盘、名字已对上的常见情况：这里只补登记，不做改名
        const targetRel = path.relative(dir, targetLrcPath).replace(/\\/g, '/')
        if (item.lyricFilename === targetRel && item.hasLyric) return false
        item.lyricFilename = targetRel
        item.hasLyric = true
        indexManager.save(normalizedUsername, folder)
        console.log(`[文件缓存] 已登记与音频同名的歌词: ${targetRel}`)
        return true
    }

    const referenced = new Set(indexManager.getAll(normalizedUsername, folder).map(i => i.lyricFilename).filter(Boolean))
    const waitingQualities = new Set(indexManager.getAll(normalizedUsername, folder)
        .filter(i => i.id === item.id && i.quality && i.quality !== quality && !i.lyricFilename)
        .map(i => String(i.quality).toLowerCase()))
    for (const relative of collectLyricFiles(dir, dir)) {
        if (referenced.has(relative)) continue
        const candidatePath = resolveCacheRelativePath(dir, relative)
        if (!candidatePath || path.dirname(candidatePath) !== path.dirname(targetLrcPath)) continue
        const candidateQuality = qualitySegmentOf(path.basename(candidatePath, '.lrc'))
        // 同一首歌的另一音质已在该目录里且还没歌词时，那份 .lrc 归它，不抢
        if (candidateQuality && waitingQualities.has(candidateQuality)) continue
        if (swapQualitySegment(path.basename(candidatePath, '.lrc'), quality) !== path.basename(targetLrcPath, '.lrc')) continue
        try {
            fs.renameSync(candidatePath, targetLrcPath)
        } catch (e) {
            continue
        }
        item.lyricFilename = path.relative(dir, targetLrcPath).replace(/\\/g, '/')
        item.hasLyric = true
        indexManager.save(normalizedUsername, folder)
        console.log(`[文件缓存] 未引用歌词已对齐至音频: ${relative} -> ${item.lyricFilename}`)
        return true
    }
    return false
}

const ensureCachedLyrics = async (
    songInfo: any,
    quality: string | undefined,
    username: string | undefined,
    isOnlyDownload: boolean | undefined,
    audioPath: string,
    folder: 'cache' | 'music',
    shouldCacheLyric: boolean,
    shouldEmbedLyric: boolean,
) => {
    if ((!shouldCacheLyric && !shouldEmbedLyric) || !_lyricFetcher || !fs.existsSync(audioPath)) return

    const normalizedUsername = normalizeUsername(username)
    const id = normalizeSongId(songInfo)
    const resolvedQuality = quality || 'unknown'
    const relativeAudioPath = path.relative(getCacheDir(normalizedUsername, folder === 'music'), audioPath).replace(/\\/g, '/')
    const item = indexManager.get(normalizedUsername, id, folder, resolvedQuality, true)
        || indexManager.getAll(normalizedUsername, folder).find(candidate => candidate.filename === relativeAudioPath)
    const lyricPath = audioPath.substring(0, audioPath.length - path.extname(audioPath).length) + '.lrc'
    let hasCachedLyric = fs.existsSync(lyricPath)
    let hasEmbedLyric = item?.hasEmbedLyric === true
    let metadataWritable = item?.metadataWritable !== false
    let metadataError = item?.metadataError
    let embedLyricError = item?.embedLyricError
    const audioContainer = item?.audioContainer || detectAudioContainer(audioPath)

    if (shouldEmbedLyric && !hasEmbedLyric && metadataWritable) {
        let tagger: any
        try {
            tagger = new MusicTagger()
            tagger.loadPath(audioPath)
            const lyricsInTag = tagger.lyrics
            hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
        } catch (e: any) {
            metadataWritable = false
            metadataError = getMetadataUnsupportedMessage(audioContainer)
            embedLyricError = metadataError
        } finally {
            try { if (tagger) tagger.dispose() } catch (e) { }
        }
    }

    const embedRequirementHandled = !shouldEmbedLyric || hasEmbedLyric || !metadataWritable
    if ((!shouldCacheLyric || hasCachedLyric) && embedRequirementHandled) {
        if (item && (item.hasLyric !== hasCachedLyric || item.hasEmbedLyric !== hasEmbedLyric || item.metadataWritable !== metadataWritable || item.embedLyricError !== embedLyricError)) {
            item.hasLyric = hasCachedLyric
            item.lyricFilename = hasCachedLyric
                ? path.relative(getCacheDir(normalizedUsername, folder === 'music'), lyricPath).replace(/\\/g, '/')
                : undefined
            item.hasEmbedLyric = hasEmbedLyric
            item.audioContainer = audioContainer
            item.metadataWritable = metadataWritable
            item.metadataError = metadataError
            item.embedLyricError = embedLyricError
            indexManager.save(normalizedUsername, folder)
        }
        return
    }

    try {
        const lyricText = await _lyricFetcher({ ...songInfo, quality: resolvedQuality })
        if (!lyricText) return

        if (shouldCacheLyric && !hasCachedLyric) {
            const lyricsObj = parseLyrics(lyricText)
            hasCachedLyric = saveLyricCache(
                { ...songInfo, quality: resolvedQuality },
                lyricsObj,
                username,
                isOnlyDownload,
            ) || fs.existsSync(lyricPath)
        }

        if (shouldEmbedLyric && !hasEmbedLyric && metadataWritable) {
            const embedResult = embedLyricsIntoFile(audioPath, lyricText)
            hasEmbedLyric = embedResult.hasEmbedLyric
            metadataWritable = embedResult.metadataWritable
            metadataError = embedResult.metadataWritable ? undefined : embedResult.error
            embedLyricError = embedResult.error
            if (embedResult.success) {
                console.log(`[文件缓存] 已成功嵌入 USLT 歌词标签: ${songInfo.name || songInfo.title || path.basename(audioPath)}`)
            } else {
                console.warn(`[文件缓存] 无法写入歌词标签 (${path.basename(audioPath)}): ${embedResult.error}`)
            }
        }

        const finalItem = indexManager.get(normalizedUsername, id, folder, resolvedQuality, true) || item
        if (finalItem) {
            if (shouldCacheLyric && hasCachedLyric) {
                finalItem.hasLyric = true
                finalItem.lyricFilename = path.relative(getCacheDir(normalizedUsername, folder === 'music'), lyricPath).replace(/\\/g, '/')
            }
            if (shouldEmbedLyric) {
                finalItem.hasEmbedLyric = hasEmbedLyric
                finalItem.audioContainer = audioContainer
                finalItem.metadataWritable = metadataWritable
                finalItem.metadataError = metadataError
                finalItem.embedLyricError = embedLyricError
            }
            indexManager.save(normalizedUsername, folder)
        }
    } catch (err: any) {
        console.warn(`[文件缓存] 补全歌词缓存失败 (${path.basename(audioPath)}): ${err?.message || err}`)
    }
}

export interface DownloadProvenance {
    requestedSource?: string
    downloadSource?: string
    sourceName?: string
    customTargetDir?: string
}

export const downloadAndCache = async (songInfo: any, url: string, quality?: string, username?: string, signal?: AbortSignal, isOnlyDownload?: boolean, shouldCacheLyric: boolean = true, shouldEmbedLyric: boolean = true, provenance: DownloadProvenance = {}) => {
    const dir = provenance.customTargetDir || ensureDir(username, isOnlyDownload)
    const baseName = getFileName(songInfo, quality, isOnlyDownload, username)
    const tempPath = path.join(dir, baseName + '.tmp')
    const songKey = normalizeSongId(songInfo) + '_' + (quality || 'unknown')
    const requestedSource = provenance.requestedSource || songInfo.requestedSource || songInfo.source || 'unknown'
    const downloadSource = detectDownloadSource(url, provenance.downloadSource || songInfo.downloadSource || songInfo.source)
    const sourceName = provenance.sourceName
    // [汽水解密] 取链时登记的密钥（或本次显式传入的）用来在落盘前就地解密 CENC 加密流。
    const audioDecryptKey = provenance.decryptKey || getSodaKey(sodaTrackIdOf(songInfo)) || songInfo.sourceName

    const result = checkCache({ ...songInfo, quality, exactQuality: true }, username, false)
    if (result.exists && !result.isCollision) {
        const targetFolder: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'
        if (result.folder === targetFolder && result.path) {
            alignOrphanLyric(username, normalizeSongId(songInfo), quality || result.quality, targetFolder)
            await ensureCachedLyrics(songInfo, quality || result.quality, username, isOnlyDownload, result.path, targetFolder, shouldCacheLyric, shouldEmbedLyric)
            console.log(`[文件缓存] 歌曲已存在于 ${targetFolder}，跳过下载: ${result.filename}`)
            // 通知前端轮询：目标目录文件已存在，视为立即完成
            cacheProgress.set(songKey, { progress: 100, status: 'exists' })
            setTimeout(() => cacheProgress.delete(songKey), 30000)
            return Promise.resolve()
        }

        if (isOnlyDownload && result.folder === 'cache' && result.path) {
            const requestedOrCachedQuality = quality || result.quality || 'unknown'
            const inspection = inspectAudioFile(result.path, requestedOrCachedQuality)
            const actualQuality = inspection.quality || requestedOrCachedQuality
            const sourceExt = path.extname(result.filename || result.path) || '.mp3'
            const ext = inspection.extension || sourceExt
            const finalBaseName = getFileName(songInfo, actualQuality, isOnlyDownload, username)
            const finalPath = path.join(dir, finalBaseName + ext)
            if (!fs.existsSync(finalPath)) {
                fs.copyFileSync(result.path, finalPath)
            }

            const metadata = extractSongMetadata(songInfo)
            const id = metadata.id || String(songInfo.id || songInfo.songmid)
            const normalizedUsername = normalizeUsername(username)
            const cachedItem = getIndexItemByFilename(result.filename, normalizedUsername)
            const actualDownloadSource = cachedItem?.downloadSource || downloadSource
            const actualSourceName = cachedItem?.sourceName || sourceName
            const stat = fs.statSync(finalPath)
            let hasCover = false
            let hasEmbedLyric = false
            let metadataWritable = false
            const audioContainer = inspection.audioContainer
            try {
                const tagger = new MusicTagger()
                tagger.loadPath(finalPath)
                hasCover = hasValidEmbeddedCover(tagger.pictures)
                const lyricsInTag = tagger.lyrics
                hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
                metadataWritable = true
                tagger.dispose()
            } catch (e) { }

            let coverType: CacheItem['coverType'] = hasCover ? 'embedded' : 'none'
            if (!hasCover) {
                const sourceCover = await getCacheCover(result.filename, normalizedUsername)
                if (sourceCover?.data?.length && writeCoverCache(path.basename(finalPath), normalizedUsername, sourceCover.data, sourceCover.mime, stat)) {
                    hasCover = true
                    coverType = 'cached'
                } else if (hasUsableRemoteCover(metadata.img)) {
                    hasCover = true
                    coverType = 'remote'
                }
            }

            let lyricFilename: string | undefined
            const sourceLyricPath = result.path.substring(0, result.path.length - sourceExt.length) + '.lrc'
            if (shouldCacheLyric && fs.existsSync(sourceLyricPath)) {
                const targetLyricPath = path.join(dir, finalBaseName + '.lrc')
                fs.copyFileSync(sourceLyricPath, targetLyricPath)
                lyricFilename = path.basename(targetLyricPath)
            }

            indexManager.update(normalizedUsername, {
                id, songmid: id, name: metadata.name, singer: metadata.singer,
                album: metadata.album, albumId: metadata.albumId, img: metadata.img,
                interval: metadata.interval, source: metadata.source, requestedSource,
                downloadSource: actualDownloadSource, sourceName: actualSourceName,
                quality: actualQuality, filename: path.basename(finalPath),
                folder: 'music', mtime: Date.now(), size: stat.size,
                lyricFilename,
                ext: ext.replace('.', ''),
                hasCover,
                coverType,
                hasLyric: !!lyricFilename,
                hasEmbedLyric,
                audioContainer,
                bitrate: inspection.bitrate,
                sampleRate: inspection.sampleRate,
                bitDepth: inspection.bitDepth,
                metadataWritable,
                metadataError: metadataWritable ? undefined : getMetadataUnsupportedMessage(audioContainer),
                nativeIds: cachedItem?.nativeIds || extractNativeIds(songInfo),
                decryptKey: cachedItem?.decryptKey || audioDecryptKey || undefined
            }, 'music')

            await ensureCachedLyrics(songInfo, actualQuality, username, true, finalPath, 'music', shouldCacheLyric, shouldEmbedLyric)
            alignOrphanLyric(username, id, actualQuality, 'music')

            // 音频/歌词/封面都已迁到下载目录，删除缓存副本，避免双份占盘且播放继续命中缓存
            try {
                removeCacheFile(result.filename, normalizedUsername, 'cache')
                console.log(`[文件缓存] 已删除缓存副本: ${result.filename}`)
            } catch (e) {
                console.warn(`[文件缓存] 删除缓存副本失败: ${result.filename}`, e)
            }

            console.log(`[文件缓存] 已复制缓存歌曲至下载目录: ${path.basename(finalPath)}`)
            cacheProgress.set(songKey, { progress: 100, status: 'finished', total: stat.size, received: stat.size })
            setTimeout(() => cacheProgress.delete(songKey), 30000)
            return Promise.resolve()
        }

        console.log(`[文件缓存] 歌曲已存在于 ${result.folder}，跳过下载: ${result.filename}`)
        cacheProgress.set(songKey, { progress: 100, status: 'exists' })
        setTimeout(() => cacheProgress.delete(songKey), 30000)
        return Promise.resolve()
    }

    // [去重] 同一 songKey 正在下载/写标签时，等待同一个任务，而不是假装已完成
    // (如 Subsonic 客户端反复请求 stream、或音流并行触发原生缓存)
    const inFlight = cacheProgress.get(songKey)
    if (inFlight && (inFlight.status === 'downloading' || inFlight.status === 'tagging')) {
        const age = Date.now() - (inFlight.updatedAt || 0)
        // 超过 10 分钟仍无进展视为卡死，允许本次重新下载（避免永久阻塞该歌曲，
        // 尤其 fire-and-forget 的 Subsonic 缓存触发没有 abort 信号）
        if (age < 10 * 60 * 1000) {
            const running = inFlightDownloads.get(songKey)
            if (running) {
                // 关键：调用方要的是「文件真的落地了」，直接 resolve 会让它 checkCache 落空
                console.log(`[文件缓存] 任务已在下载队列中 (${songKey})，等待其完成`)
                return waitForInFlightDownload(songKey, running)
            }
            console.log(`[文件缓存] 任务已在下载队列中 (${songKey})，跳过重复请求`)
            return Promise.resolve()
        }
    }
    if (signal?.aborted) return
    // 立即同步占坑标记下载中，关闭“拿到 200 响应前”的并发竞态窗口；
    // 后续到达的相同 songKey 请求会被上面的守卫跳过，不再重复下载。
    cacheProgress.set(songKey, { progress: 0, status: 'downloading', total: 0, received: 0, speed: 0, updatedAt: Date.now() })
    console.log(`[文件缓存] 开始下载歌曲: ${baseName}`)

    const task = new Promise<void>((resolve, reject) => {
        let req: http.ClientRequest
        let fileStream: fs.WriteStream | undefined
        let settled = false
        let redirectCount = 0
        const MAX_REDIRECTS = 10

        const safeUnlink = (stream?: fs.WriteStream, filePath?: string) => {
            if (!filePath) return
            try {
                if (stream && !stream.destroyed) {
                    stream.destroy()
                }
            } catch { }
            setTimeout(() => {
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlink(filePath, () => { })
                    }
                } catch { }
            }, 50)
        }

        const fail = (err: Error) => {
            if (settled) return
            const message = err.message || 'Download failed'
            cacheProgress.set(songKey, { progress: 0, status: 'error', errorMsg: message })
            settle(() => reject(err))
        }

        const settle = (fn: () => void) => {
            if (settled) return
            settled = true
            if (signal) signal.removeEventListener('abort', abortHandler)
            fn()
        }

        const abortHandler = () => {
            if (req) req.destroy()
            safeUnlink(fileStream, tempPath)
            cacheProgress.delete(songKey)
            settle(() => reject(new Error('Aborted')))
        }

        if (signal) signal.addEventListener('abort', abortHandler)

        // 递归下载，自动跟随 3xx 重定向（浏览器会自动跟随，但 http.get 不会）
        const downloadFrom = (currentUrl: string) => {
            if (signal?.aborted) {
                fail(new Error('Aborted'))
                return
            }
            const protocol = currentUrl.startsWith('https') ? https : http
            // 必须带 UA/Referer 回源：B站 CDN 没有 bilibili 来源会直接 403（见 utils/streamHeaders）。
            // 以前这里是裸 get（半个头都不带），所以 B站的歌「取链成功、下载必然 403」。
            req = protocol.get(currentUrl, { headers: buildStreamHeaders(currentUrl) }, (res) => {
                const status = res.statusCode || 0
                // 处理重定向：301/302/303/307/308
                if ([301, 302, 303, 307, 308].includes(status)) {
                    const location = res.headers['location']
                    res.resume() // 消费响应体，避免连接挂起
                    if (!location) {
                        safeUnlink(fileStream, tempPath)
                        fail(new Error(`Status: ${status} (missing Location header)`))
                        return
                    }
                    if (redirectCount >= MAX_REDIRECTS) {
                        safeUnlink(fileStream, tempPath)
                        fail(new Error(`Too many redirects (${MAX_REDIRECTS})`))
                        return
                    }
                    redirectCount++
                    let nextUrl = ''
                    try {
                        nextUrl = new URL(location, currentUrl).toString()
                    } catch {
                        try {
                            nextUrl = new URL(encodeURI(location), currentUrl).toString()
                        } catch (err: any) {
                            safeUnlink(fileStream, tempPath)
                            fail(new Error(`Invalid redirect Location URL: ${location}`))
                            return
                        }
                    }
                    console.log(`[文件缓存] 触发重定向 ${status} -> ${nextUrl} (${redirectCount}/${MAX_REDIRECTS})`)
                    downloadFrom(nextUrl)
                    return
                }
                if (status !== 200) {
                    safeUnlink(fileStream, tempPath)
                    fail(new Error(`Status: ${status}`))
                    return
                }


            cacheProgress.set(songKey, { progress: 0, status: 'downloading', total: 0, received: 0, speed: 0, updatedAt: Date.now() })
            const total = parseInt(res.headers['content-length'] || '0', 10)
            let received = 0
            let lastSpeedAt = Date.now()
            let lastSpeedBytes = 0
            let currentSpeed = 0
            const contentType = res.headers['content-type'] || ''
            let headerExt = '.mp3'
            if (contentType.includes('audio/flac')) headerExt = '.flac'
            else if (contentType.includes('audio/ogg')) headerExt = '.ogg'
            else if (contentType.includes('audio/x-m4a') || contentType.includes('audio/mp4')) headerExt = '.m4a'
            else if (contentType.includes('audio/wav')) headerExt = '.wav'

            fileStream = fs.createWriteStream(tempPath)
            let writeFinished = false
            res.on('data', (chunk) => {
                received += chunk.length
                const now = Date.now()
                if (now - lastSpeedAt >= 1000) {
                    currentSpeed = Math.max(0, (received - lastSpeedBytes) / ((now - lastSpeedAt) / 1000))
                    lastSpeedAt = now
                    lastSpeedBytes = received
                }
                const progress = total > 0 ? Math.round((received / total) * 100) : 0
                cacheProgress.set(songKey, { progress, status: 'downloading', total, received, speed: currentSpeed, updatedAt: now })
            })

            res.pipe(fileStream)
            fileStream.on('finish', () => { writeFinished = true })
            fileStream.on('close', async () => {
                if (settled) return
                if (!writeFinished) {
                    safeUnlink(fileStream, tempPath)
                    fail(new Error('Download stream closed before write finished'))
                    return
                }
                if (total > 0 && received < total) {
                    safeUnlink(fileStream, tempPath)
                    fail(new Error(`Download incomplete: ${received}/${total}`))
                    return
                }
                cacheProgress.set(songKey, { progress: 100, status: 'tagging', total, received, speed: 0, updatedAt: Date.now() })

                // [汽水解密] 汽水版权曲直链是 CENC 加密流，浏览器解不开会被隔离。
                // 若取链时拿到了 spade_a 推导的密钥，在落盘前就地解密成明文 m4a/flac，
                // 这样缓存下来的就是可播文件。无密钥时不解密（沿用下方隔离兜底，不报错）。
                let decryptResult: DecryptResult | null = null
                if (audioDecryptKey && fs.existsSync(tempPath)) {
                    try {
                        const probe = fs.readFileSync(tempPath)
                        if (isCencEncryptedBuffer(probe)) {
                            decryptResult = await decryptAudioBufferAsync(probe, audioDecryptKey)
                            fs.writeFileSync(tempPath, decryptResult.buffer)
                            console.log(`[文件缓存] 已解密汽水 CENC 音频 (${decryptResult.codec}, ${(decryptResult.buffer.length / 1024 / 1024).toFixed(1)}MB)`)
                        }
                    } catch (e: any) {
                        console.warn(`[文件缓存] 汽水 CENC 解密失败，按原样落盘（后续由隔离逻辑兜底）: ${e?.message || e}`)
                    }
                }

                let ext = headerExt
                if (fs.existsSync(tempPath)) {
                    try {
                        const { fileTypeFromFile } = await import('file-type')
                        const type = await fileTypeFromFile(tempPath)
                        if (type) ext = `.${type.ext}`
                    } catch (e) { }
                }

                const inspection = inspectAudioFile(tempPath, quality)
                ext = inspection.extension || ext
                // 解密成功的，强制用解密结果声明的扩展名（.m4a / .flac），避免被识别成 .mp4
                if (decryptResult) ext = decryptResult.extension
                const actualQuality = inspection.quality || quality || 'unknown'

                // 试听片段 / 占位音 / 残缺音频防御检查：
                // 期望时长来自调用方给的 interval；它缺失时（/play 的兜底路径）走绝对阈值分支，
                // 否则占位音会直接落盘，之后每次点这首都命中它。
                const expectedDurationSec = parseDurationSeconds(songInfo.interval || songInfo.meta?.interval)
                const actualDurationSec = inspection.duration ? Math.round(inspection.duration / 1000) : 0
                const tempSize = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0
                let mismatch = judgeAudioMismatch({
                    expectedSec: expectedDurationSec,
                    actualSec: actualDurationSec,
                    bitrate: inspection.bitrate,
                    sizeBytes: tempSize,
                }) || judgeMetadataMismatch(songInfo.name, songInfo.singer, inspection.title, inspection.artist)
                if (!mismatch) {
                    // 两条本地判据都放行时，还有两种「它们根本判不了」的情形：
                    //   ① 源文件没有 ID3 标签 → judgeMetadataMismatch 无从比对；
                    //   ② 时长接近（现场样本 3:53 vs 请求 4:04，差 11s 卡在阈值内）→ 时长判据不触发。
                    // 两者叠加就是 1.5.27 漏掉的那条脏缓存。这时改用音源自己的搜索结果当裁判，
                    // 正常曲目（有标签且时长吻合）不会走到这里，不产生额外网络开销。
                    const tagMissing = !String(inspection.title || '').trim() && !String(inspection.artist || '').trim()
                    const driftSec = expectedDurationSec > 0 ? Math.abs(actualDurationSec - expectedDurationSec) : 0
                    if (actualDurationSec > 0 && (tagMissing || driftSec > 8)) {
                        try {
                            const origin = await verifyTrackOrigin(songInfo, actualDurationSec, { expectedSec: expectedDurationSec })
                            if (origin.verdict === 'suspect') mismatch = origin.reason || '源侧核验不通过'
                        } catch {
                            /* 核验是增强项，异常时按原有判据放行 */
                        }
                    }
                }
                if (mismatch) {
                    const line = `[文件缓存] ${mismatch}，拒绝写入缓存: ${songInfo.name || getFileName(songInfo, actualQuality, isOnlyDownload, username)}`
                    console.warn(line)
                    // console 只进容器 stdout，容器外看不到；排障必须双写文件日志
                    syncLog.warn(line)
                    safeUnlink(fileStream, tempPath)
                    fail(new Error(`${mismatch}，已拒绝写入缓存`))
                    return
                }

                const finalBaseName = getFileName(songInfo, actualQuality, isOnlyDownload, username)
                const finalPath = path.join(dir, finalBaseName + ext)
                fs.rename(tempPath, finalPath, async (err) => {
                    if (err) {
                        safeUnlink(fileStream, tempPath)
                        fail(err)
                        return
                    }

                    let imageBuffer: Buffer | undefined
                    let imageMime = 'image/jpeg'
                    try {
                        const imageUrl = songInfo.img || (songInfo.meta && songInfo.meta.picUrl)
                        if (imageUrl && imageUrl.startsWith('http') && !isPlaceholderCoverUrl(imageUrl)) {
                            const chunks: Buffer[] = []
                            const p = imageUrl.startsWith('https') ? https : http
                            imageBuffer = await new Promise((resolveI, rejectI) => {
                                const imgReq = p.get(imageUrl, ires => {
                                    if (ires.statusCode && ires.statusCode >= 400) {
                                        ires.resume()
                                        rejectI(new Error(`Cover status: ${ires.statusCode}`))
                                        return
                                    }
                                    imageMime = String(ires.headers['content-type'] || 'image/jpeg').split(';')[0]
                                    ires.on('data', c => chunks.push(c))
                                    ires.on('end', () => resolveI(Buffer.concat(chunks)))
                                    ires.on('error', rejectI)
                                })
                                imgReq.on('error', rejectI)
                                imgReq.setTimeout(10000, () => {
                                    imgReq.destroy(new Error('Cover download timeout'))
                                })
                            })
                        }
                    } catch (e) { }

                    const metadata = extractSongMetadata(songInfo)
                    const id = metadata.id || String(songInfo.id || songInfo.songmid)
                    const normalizedUsername = normalizeUsername(username)
                    const folderType: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'

                    indexManager.update(normalizedUsername, {
                        id, songmid: id, name: metadata.name, singer: metadata.singer,
                        album: metadata.album, albumId: metadata.albumId, img: metadata.img,
                        interval: metadata.interval, source: metadata.source, requestedSource,
                        downloadSource, sourceName,
                        quality: actualQuality, filename: finalBaseName + ext,
                        folder: folderType, mtime: Date.now(), size: received,
                        ext: ext.replace('.', ''), hasCover: false, hasLyric: false,
                        audioContainer: inspection.audioContainer,
                        bitrate: inspection.bitrate,
                        sampleRate: inspection.sampleRate,
                        bitDepth: inspection.bitDepth,
                        nativeIds: extractNativeIds(songInfo),
                        decryptKey: audioDecryptKey || undefined
                    }, folderType)

                    let tagger: any
                    let metadataWritable = false
                    try {
                        tagger = new MusicTagger()
                        tagger.loadPath(finalPath)
                        tagger.title = metadata.name
                        tagger.artist = metadata.singer
                        tagger.album = metadata.album
                        if (imageBuffer && imageBuffer.length > 0) tagger.pictures = [new MetaPicture(imageMime, new Uint8Array(imageBuffer), 'Cover')]
                        tagger.save()
                        metadataWritable = true
                    } catch (e) {
                    } finally {
                        try { if (tagger) tagger.dispose() } catch (e) { }
                    }
                    stripOversizedEmbeddedCover(finalPath)

                    const taggedStats = fs.statSync(finalPath)
                    let finalHasCover = readEmbeddedCoverState(finalPath)
                    if (!finalHasCover && imageBuffer?.length) {
                        finalHasCover = writeCoverCache(finalBaseName + ext, normalizedUsername, imageBuffer, imageMime, taggedStats)
                    }
                    const taggedItem = indexManager.get(normalizedUsername, id, folderType, actualQuality)
                    if (taggedItem) {
                        taggedItem.coverType = readEmbeddedCoverState(finalPath)
                            ? 'embedded'
                            : finalHasCover
                                ? 'cached'
                                : hasUsableRemoteCover(metadata.img)
                                    ? 'remote'
                                    : 'none'
                        taggedItem.hasCover = taggedItem.coverType !== 'none'
                        taggedItem.audioContainer = inspection.audioContainer
                        taggedItem.metadataWritable = metadataWritable
                        taggedItem.metadataError = metadataWritable ? undefined : getMetadataUnsupportedMessage(taggedItem.audioContainer)
                        taggedItem.coverCheckedVersion = COVER_CHECK_VERSION
                        taggedItem.coverCheckedMtime = taggedStats.mtimeMs
                        taggedItem.coverCheckedSize = taggedStats.size
                        taggedItem.mtime = taggedStats.mtimeMs
                        taggedItem.size = taggedStats.size
                        indexManager.save(normalizedUsername, folderType)
                    }

                    await ensureCachedLyrics(songInfo, actualQuality, username, isOnlyDownload, finalPath, folderType, shouldCacheLyric, shouldEmbedLyric)
                    alignOrphanLyric(username, id, actualQuality, folderType)

                    cacheProgress.set(songKey, { progress: 100, status: 'finished', total: total || received, received, speed: 0, updatedAt: Date.now() })
                    setTimeout(() => cacheProgress.delete(songKey), 30000)
                    settle(() => { resolve(); void checkAndCleanupCache(username) })
                })
            })
            fileStream.on('error', (err) => { safeUnlink(fileStream, tempPath); fail(err) })
        })
        req.on('error', (err) => { safeUnlink(fileStream, tempPath); fail(err) })
        req.setTimeout(30000, () => {
            safeUnlink(fileStream, tempPath)
            req.destroy(new Error('Download request timeout'))
        })
        }

        downloadFrom(url)
    })

    // 登记在飞任务：后来者 await 同一个 Promise，拿到"真下完"而不是"以为下完"
    inFlightDownloads.set(songKey, task)
    void task
        .catch(() => { })
        .then(() => {
            // 只在仍是自己时清理（10 分钟卡死重下时 map 可能已被新任务覆盖）
            if (inFlightDownloads.get(songKey) === task) inFlightDownloads.delete(songKey)
        })
    return task
}

const resolveMusicPath = (root: string, relativePath: string) => {
    const resolvedRoot = path.resolve(root)
    const resolvedPath = path.resolve(root, relativePath)
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + path.sep)) {
        throw new Error('Invalid music file path')
    }
    return resolvedPath
}

const getAvailableRemasterTarget = (
    root: string,
    subPath: string,
    preferredBaseName: string,
    extension: string,
    oldAudioPath: string,
    oldLyricPath: string,
    needsLyric: boolean,
) => {
    for (let index = 0; index < 10000; index++) {
        const suffix = index === 0 ? '' : ` (${index + 1})`
        const baseName = preferredBaseName.substring(0, Math.max(1, 200 - suffix.length)) + suffix
        const audioFilename = path.join(subPath, baseName + extension).replace(/\\/g, '/').replace(/^\.\//, '')
        const lyricFilename = path.join(subPath, baseName + '.lrc').replace(/\\/g, '/').replace(/^\.\//, '')
        const audioPath = resolveMusicPath(root, audioFilename)
        const lyricPath = resolveMusicPath(root, lyricFilename)
        const audioConflict = audioPath !== oldAudioPath && fs.existsSync(audioPath)
        const lyricConflict = needsLyric && lyricPath !== oldLyricPath && fs.existsSync(lyricPath)
        if (!audioConflict && !lyricConflict) {
            return { audioFilename, lyricFilename, audioPath, lyricPath }
        }
    }
    throw new Error('无法生成不冲突的目标文件名')
}

export const getDownloadedMusicItems = async (username?: string) => {
    const normalizedUsername = normalizeUsername(username)
    await syncCacheIndex(normalizedUsername, ['music'])
    return indexManager.getAll(normalizedUsername, 'music').map(item => ({ ...item }))
}

export const replaceDownloadedMusicItem = async (
    username: string,
    originalItem: CacheItem,
    songInfo: any,
    url: string,
    quality: string,
    signal?: AbortSignal,
) => {
    const normalizedUsername = normalizeUsername(username)
    const root = getCacheDir(normalizedUsername, true)
    const currentItem = indexManager.get(normalizedUsername, originalItem.id, 'music', originalItem.quality, true)
    if (!currentItem || currentItem.filename !== originalItem.filename) {
        throw new Error('原文件已发生变化或已不存在')
    }
    if (quality === currentItem.quality) throw new Error('实际音质与原音质相同，无需替换')

    const oldAudioPath = resolveMusicPath(root, currentItem.filename)
    if (!fs.existsSync(oldAudioPath)) throw new Error('原文件已不存在')
    const oldAudioSize = fs.statSync(oldAudioPath).size

    const stageId = crypto.randomBytes(12).toString('hex')
    const stageUsername = `.remaster-staging/${stageId}`
    const stageRoot = getCacheDir(stageUsername, true)
    const stageCoverRoot = getCoverCacheDir(stageUsername)
    const backupSuffix = `.remaster-${crypto.randomBytes(6).toString('hex')}.bak`
    const oldAudioBackup = oldAudioPath + backupSuffix
    let oldLyricPath = ''
    let oldLyricBackup = ''
    let targetAudioPath = ''
    let targetLyricPath = ''
    let replacementItem: CacheItem | null = null
    let backedUpOldAudio = false
    let backedUpOldLyric = false
    let installedNewAudio = false
    let installedNewLyric = false
    let updatedNewIndex = false
    let removedOldIndex = false

    try {
        await downloadAndCache(songInfo, url, quality, stageUsername, signal, true, true, true)
        if (signal?.aborted) throw new Error('Aborted')

        const stagedItems = indexManager.getAll(stageUsername, 'music')
        const targetId = normalizeSongId(songInfo)
        const downloadedItem = stagedItems.find(item => item.id === targetId) || stagedItems[0]
        if (!downloadedItem) throw new Error('新音质文件未写入暂存索引')

        const sourceAudioPath = resolveMusicPath(stageRoot, downloadedItem.filename)
        const sourceStats = fs.existsSync(sourceAudioPath) ? fs.statSync(sourceAudioPath) : null
        if (!sourceStats?.isFile() || sourceStats.size <= 0) throw new Error('新音质文件无效或为空')
        if (sourceStats.size < oldAudioSize) {
            throw new Error(`新文件（${sourceStats.size} 字节）小于原文件（${oldAudioSize} 字节），音源可能返回了低质量文件，已拒绝替换`)
        }
        const stagedHasCover = readEmbeddedCoverState(sourceAudioPath)
        const originalCover = stagedHasCover
            ? null
            : ((await getCacheCover(downloadedItem.filename, stageUsername)) || (await getCacheCover(currentItem.filename, normalizedUsername)))

        oldLyricPath = currentItem.lyricFilename ? resolveMusicPath(root, currentItem.lyricFilename) : ''
        oldLyricBackup = oldLyricPath ? oldLyricPath + backupSuffix : ''
        const sourceLyricPath = downloadedItem.lyricFilename
            ? resolveMusicPath(stageRoot, downloadedItem.lyricFilename)
            : ''
        const targetSubPath = currentItem.subPath || ''
        const downloadedExtension = path.extname(downloadedItem.filename) || `.${downloadedItem.ext || 'mp3'}`
        const preferredBaseName = getFileName(songInfo, quality, true, normalizedUsername)
        const target = getAvailableRemasterTarget(
            root,
            targetSubPath,
            preferredBaseName,
            downloadedExtension,
            oldAudioPath,
            oldLyricPath,
            !!((sourceLyricPath && fs.existsSync(sourceLyricPath)) || (oldLyricPath && fs.existsSync(oldLyricPath))),
        )
        const targetFilename = target.audioFilename
        const targetLyricFilename = target.lyricFilename
        targetAudioPath = target.audioPath
        targetLyricPath = target.lyricPath

        fs.renameSync(oldAudioPath, oldAudioBackup)
        backedUpOldAudio = true
        if (oldLyricPath && fs.existsSync(oldLyricPath)) {
            fs.renameSync(oldLyricPath, oldLyricBackup)
            backedUpOldLyric = true
        }

        fs.mkdirSync(path.dirname(targetAudioPath), { recursive: true })
        safeRenameSync(sourceAudioPath, targetAudioPath)
        installedNewAudio = true

        let finalHasCover = readEmbeddedCoverState(targetAudioPath)
        if (!finalHasCover && originalCover?.data?.length) {
            let tagger: any
            try {
                tagger = new MusicTagger()
                tagger.loadPath(targetAudioPath)
                tagger.pictures = [
                    new MetaPicture(originalCover.mime || 'image/jpeg', new Uint8Array(originalCover.data), 'Cover'),
                ]
                tagger.save()
            } catch (e) {
                console.warn(`[文件缓存] 无法嵌入原封面 (${targetFilename})，转存为外置封面缓存`)
            } finally {
                try { if (tagger) tagger.dispose() } catch (e) { }
            }
            stripOversizedEmbeddedCover(targetAudioPath)
            finalHasCover = readEmbeddedCoverState(targetAudioPath)
        }

        let finalLyricFilename: string | undefined
        if (sourceLyricPath && fs.existsSync(sourceLyricPath)) {
            fs.mkdirSync(path.dirname(targetLyricPath), { recursive: true })
            if (sourceLyricPath !== targetLyricPath) {
                safeRenameSync(sourceLyricPath, targetLyricPath)
                installedNewLyric = true
            }
            finalLyricFilename = targetLyricFilename
        } else if (backedUpOldLyric && fs.existsSync(oldLyricBackup)) {
            fs.mkdirSync(path.dirname(targetLyricPath), { recursive: true })
            fs.copyFileSync(oldLyricBackup, targetLyricPath)
            installedNewLyric = true
            finalLyricFilename = targetLyricFilename
        }

        const finalStats = fs.statSync(targetAudioPath)
        if (!finalHasCover && originalCover?.data?.length) {
            finalHasCover = writeCoverCache(
                targetFilename,
                normalizedUsername,
                originalCover.data,
                originalCover.mime || 'image/jpeg',
                finalStats,
            )
        }
        replacementItem = {
            ...downloadedItem,
            id: currentItem.id,
            songmid: currentItem.songmid || currentItem.id,
            source: currentItem.source,
            filename: targetFilename,
            folder: 'music',
            subPath: targetSubPath,
            lyricFilename: finalLyricFilename,
            hasLyric: !!finalLyricFilename,
            hasCover: finalHasCover,
            coverType: readEmbeddedCoverState(targetAudioPath) ? 'embedded' : finalHasCover ? 'cached' : hasUsableRemoteCover(downloadedItem.img) ? 'remote' : 'none',
            coverCheckedVersion: COVER_CHECK_VERSION,
            coverCheckedMtime: finalStats.mtimeMs,
            coverCheckedSize: finalStats.size,
            mtime: finalStats.mtimeMs,
            size: finalStats.size,
        }
        replacementItem.hasCover = replacementItem.coverType !== 'none'
        indexManager.update(normalizedUsername, replacementItem, 'music')
        updatedNewIndex = true
        indexManager.remove(normalizedUsername, currentItem.id, 'music', currentItem.quality)
        removedOldIndex = true

        try {
            if (backedUpOldAudio && fs.existsSync(oldAudioBackup)) fs.unlinkSync(oldAudioBackup)
        } catch (cleanupError) {
            console.warn('[文件缓存] 清理重制音频备份失败:', cleanupError)
        }
        try {
            if (backedUpOldLyric && fs.existsSync(oldLyricBackup)) fs.unlinkSync(oldLyricBackup)
        } catch (cleanupError) {
            console.warn('[文件缓存] 清理重制歌词备份失败:', cleanupError)
        }
        return { ...replacementItem }
    } catch (err) {
        try {
            if (updatedNewIndex && replacementItem) {
                indexManager.remove(normalizedUsername, replacementItem.id, 'music', replacementItem.quality)
            }
            if (installedNewLyric && targetLyricPath && fs.existsSync(targetLyricPath)) fs.unlinkSync(targetLyricPath)
            if (installedNewAudio && targetAudioPath && fs.existsSync(targetAudioPath)) fs.unlinkSync(targetAudioPath)
            if (backedUpOldAudio && fs.existsSync(oldAudioBackup) && !fs.existsSync(oldAudioPath)) {
                fs.renameSync(oldAudioBackup, oldAudioPath)
            }
            if (backedUpOldLyric && fs.existsSync(oldLyricBackup) && !fs.existsSync(oldLyricPath)) {
                fs.renameSync(oldLyricBackup, oldLyricPath)
            }
            if (removedOldIndex || updatedNewIndex) {
                indexManager.update(normalizedUsername, currentItem, 'music')
            }
        } catch (rollbackError) {
            console.error('[文件缓存] 回滚重制替换操作失败:', rollbackError)
        }
        throw err
    } finally {
        indexManager.discard(stageUsername, 'music')
        try {
            if (fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true })
        } catch (cleanupError) {
            console.warn('[文件缓存] 清理重制暂存目录失败:', cleanupError)
        }
        try {
            if (fs.existsSync(stageCoverRoot)) fs.rmSync(stageCoverRoot, { recursive: true, force: true })
        } catch (cleanupError) {
            console.warn('[文件缓存] 清理重制封面暂存目录失败:', cleanupError)
        }
    }
}

export const stopUserTasks = (username: string, songKey?: string) => {
    const tasks = activeTasks.get(username)
    if (!tasks) return
    if (songKey) {
        const idx = tasks.findIndex(t => t.songKey === songKey)
        if (idx !== -1) { tasks[idx].controller.abort(); tasks.splice(idx, 1) }
    } else {
        tasks.forEach(t => t.controller.abort())
        activeTasks.delete(username)
    }
}

// [新增] 根据文件名从索引中查找对应条目（跨 cache/music 两个目录）
export const getIndexItemByFilename = (filename: string, username: string) => {
    const normalizedUsername = normalizeUsername(username)
    for (const folder of ['cache', 'music'] as const) {
        const items = indexManager.getAll(normalizedUsername, folder)
        const found = items.find((i: any) => i.filename === filename)
        if (found) return { ...found, folder }
    }
    return null
}

// [新增] 暴露 lyricFetcher 引用，供外部接口（如 embedLyric）使用
export const getLyricFetcher = () => _lyricFetcher

// [新增] 更新索引中指定文件的 hasEmbedLyric 状态（由 embedLyric 接口成功写入后调用）
export const setIndexEmbedLyric = (
    filename: string,
    username: string,
    value: boolean,
    metadata?: Pick<CacheItem, 'audioContainer' | 'metadataWritable' | 'metadataError' | 'embedLyricError'>,
) => {
    const normalizedUsername = normalizeUsername(username)
    for (const folder of ['cache', 'music'] as const) {
        const items = indexManager.getAll(normalizedUsername, folder)
        const found = items.find((i: any) => i.filename === filename)
        if (found) {
            (found as any).hasEmbedLyric = value
            if (metadata) Object.assign(found, metadata)
            indexManager.save(normalizedUsername, folder)
            return true
        }
    }
    return false
}

export const serveCacheFile = (req: http.IncomingMessage, res: http.ServerResponse, filename: string, username?: string, folder?: CacheFolder) => {
    const normalizedUsername = normalizeUsername(username)
    const userLoc = getUserCacheLocation(normalizedUsername)
    const locations = [
        userLoc,
        userLoc === CACHE_ROOTS.DATA ? CACHE_ROOTS.ROOT : CACHE_ROOTS.DATA
    ]
    const roots: CacheFolder[] = folder ? [folder] : ['cache', 'music']
    let filePath = ''
    for (const loc of locations) {
        for (const folder of roots) {
            const dir = getCacheDir(normalizedUsername, folder === 'music', loc)
            // 允许子目录，但只读取当前缓存目录内的普通文件（包括目录内的符号链接）。
            const checkPath = path.resolve(dir, filename)
            const relativePath = path.relative(path.resolve(dir), checkPath)
            if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) continue
            try {
                const realDir = fs.realpathSync(dir)
                const realPath = fs.realpathSync(checkPath)
                const realRelativePath = path.relative(realDir, realPath)
                if (!realRelativePath || realRelativePath === '..' || realRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(realRelativePath)) continue
                if (fs.statSync(realPath).isFile()) { filePath = realPath; break }
            } catch { /* 文件被删除或目录不可用时继续查找备用位置。 */ }
        }
        if (filePath) break
    }
    if (!filePath) { res.writeHead(404); res.end('Not Found'); return }
    let stat: Stats
    try { stat = fs.statSync(filePath) }
    catch { res.writeHead(404); res.end('Not Found'); return }
    const ext = path.extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
        '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav'
    }
    const contentType = mimeTypes[ext] || 'application/octet-stream'
    // HEAD 不发送响应体；Range 只适用于 GET。
    if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' })
        res.end()
        return
    }
    const range = req.headers.range && /^bytes=/i.test(req.headers.range) ? req.headers.range : undefined
    let stream: fs.ReadStream
    if (range) {
        const parts = /^bytes=(\d*)-(\d*)$/i.exec(range)
        let start = 0
        let end = stat.size - 1
        let valid = !!parts && !!(parts[1] || parts[2]) && stat.size > 0
        if (valid && parts) {
            if (!parts[1]) {
                const suffixLength = Number(parts[2])
                valid = Number.isSafeInteger(suffixLength) && suffixLength > 0
                start = Math.max(0, stat.size - suffixLength)
            } else {
                start = Number(parts[1])
                const requestedEnd = parts[2] ? Number(parts[2]) : end
                valid = Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd) && start < stat.size && requestedEnd >= start
                end = Math.min(requestedEnd, end)
            }
        }
        if (!valid) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': 0 })
            res.end()
            return
        }
        const chunksize = (end - start) + 1
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': contentType,
        })
        stream = fs.createReadStream(filePath, { start, end })
    } else {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' })
        stream = fs.createReadStream(filePath)
    }
    // 读取失败时关闭响应，并在客户端中断/离开时释放文件描述符。
    stream.once('error', () => res.destroy())
    res.once('close', () => stream.destroy())
    stream.pipe(res)
}

/**
 * 递归收集目录下的音频文件（浅层目录直接用 readdir 就够，这里只给子目录用）。
 * depth 限制 2 层：缓存目录结构固定（<user>/xiaoai/*.mp3），不需要无界递归。
 */
const collectAudioFiles = (
    dir: string,
    out: Array<{ path: string; size: number; mtime: number }>,
    depth = 2,
) => {
    if (depth <= 0) return
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            collectAudioFiles(full, out, depth - 1)
            continue
        }
        try {
            const stats = fs.statSync(full)
            out.push({ path: full, size: stats.size, mtime: stats.mtime.getTime() })
        } catch {
            /* 单个文件不可读时跳过 */
        }
    }
}

export const getCacheStats = (username?: string) => {
    const roots = ['cache', 'music']
    const result: any = {
        cache: { totalSize: 0, fileCount: 0 },
        music: { totalSize: 0, fileCount: 0 },
        // 小爱投播的 mp3 转码产物单独统计（物理上在 cache/<用户>/xiaoai/，计入 cache 总量）
        xiaoai: { totalSize: 0, fileCount: 0 },
        totalSize: 0,
        fileCount: 0,
    }
    const normalizedUsername = normalizeUsername(username)
    const extensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.lrc']
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir)
        for (const file of files) {
            const ext = path.extname(file).toLowerCase()
            if (extensions.includes(ext)) {
                try {
                    const stats = fs.statSync(path.join(dir, file))
                    result[folder].totalSize += stats.size
                    result.totalSize += stats.size
                    if (ext !== '.lrc') { result[folder].fileCount++; result.fileCount++ }
                } catch (e) { }
            }
        }
    }

    // 小爱 mp3 子目录：递归统计，否则「权限与缓存限制」管不到它
    const xiaoaiDir = path.join(getCacheDir(normalizedUsername), 'xiaoai')
    if (fs.existsSync(xiaoaiDir)) {
        const collected: Array<{ path: string; size: number; mtime: number }> = []
        collectAudioFiles(xiaoaiDir, collected)
        for (const item of collected) {
            if (path.extname(item.path).toLowerCase() === '.lrc') continue
            result.xiaoai.totalSize += item.size
            result.xiaoai.fileCount += 1
            result.cache.totalSize += item.size
            result.cache.fileCount += 1
            result.totalSize += item.size
            result.fileCount += 1
        }
    }
    return result
}

export const clearAllCache = (username?: string) => {
    const roots = ['cache', 'music']
    let deletedCount = 0
    let freedSize = 0
    const normalizedUsername = normalizeUsername(username)
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir)
        for (const file of files) {
            try {
                const fullPath = path.join(dir, file)
                const stats = fs.statSync(fullPath)
                if (stats.isDirectory()) {
                    // 子目录（小爱 mp3 转码产物）整体清掉，保留空目录本身
                    const nested: Array<{ path: string; size: number; mtime: number }> = []
                    collectAudioFiles(fullPath, nested)
                    for (const item of nested) {
                        try {
                            fs.unlinkSync(item.path)
                            deletedCount++; freedSize += item.size
                        } catch (e) { }
                    }
                    continue
                }
                fs.unlinkSync(fullPath)
                deletedCount++; freedSize += stats.size
            } catch (e) { }
        }
        indexManager.load(normalizedUsername, folder as any).clear()
        indexManager.save(normalizedUsername, folder as any)
    }
    return { deletedCount, freedSize }
}

export interface OrphanLyricItem {
    filename: string
    folder: CacheFolder
    size: number
    mtime: number
}

/**
 * 扫描磁盘上存在、但没有被任何索引条目引用的 .lrc（音质未定时写下的兜底名、改名残留等）
 */
export const listOrphanLyrics = (username?: string): OrphanLyricItem[] => {
    const normalizedUsername = normalizeUsername(username)
    const orphans: OrphanLyricItem[] = []
    for (const folder of ['cache', 'music'] as CacheFolder[]) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        const referenced = new Set(indexManager.getAll(normalizedUsername, folder).map(i => i.lyricFilename).filter(Boolean))
        for (const relative of collectLyricFiles(dir, dir)) {
            if (referenced.has(relative)) continue
            const fullPath = resolveCacheRelativePath(dir, relative)
            if (!fullPath || !fs.existsSync(fullPath)) continue
            const stats = fs.statSync(fullPath)
            orphans.push({ filename: relative, folder, size: stats.size, mtime: stats.mtimeMs })
        }
    }
    return orphans
}

export const deleteOrphanLyrics = (items: Array<{ filename: string; folder?: CacheFolder }>, username?: string) => {
    const normalizedUsername = normalizeUsername(username)
    let deletedCount = 0
    let freedSize = 0
    const failures: Array<{ filename: string; message: string }> = []

    for (const item of items) {
        const filename = item.filename
        try {
            if (!filename || typeof filename !== 'string') throw new Error('Invalid filename')
            if (!filename.toLowerCase().endsWith('.lrc')) throw new Error('只允许删除 .lrc 文件')
            const folders = item.folder ? [item.folder] : (['cache', 'music'] as CacheFolder[])
            let removed = false
            for (const folder of folders) {
                const dir = getCacheDir(normalizedUsername, folder === 'music')
                const fullPath = resolveCacheRelativePath(dir, filename)
                if (!fullPath || !fs.existsSync(fullPath)) continue
                const referenced = indexManager.getAll(normalizedUsername, folder).some(i => i.lyricFilename === filename)
                if (referenced) throw new Error(`${filename} 仍被索引引用，请先用缓存列表删除`)
                const size = fs.statSync(fullPath).size
                fs.unlinkSync(fullPath)
                cleanEmptyParentDirs(fullPath, dir)
                freedSize += size
                removed = true
            }
            if (!removed) throw new Error('File not found')
            deletedCount++
            console.log(`[文件缓存] 已删除未引用歌词: ${filename}`)
        } catch (e: any) {
            failures.push({ filename, message: e?.message || 'Delete failed' })
        }
    }
    return { deletedCount, freedSize, failures }
}

export const clearLyricCache = (username?: string) => {
    const roots: Array<'cache' | 'music'> = ['cache', 'music']
    let deletedCount = 0
    let freedSize = 0
    const normalizedUsername = normalizeUsername(username)
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir)
        for (const file of files) {
            if (file.endsWith('.lrc')) {
                try {
                    const stats = fs.statSync(path.join(dir, file))
                    fs.unlinkSync(path.join(dir, file))
                    deletedCount++; freedSize += stats.size
                } catch (e) { }
            }
        }
        const items = indexManager.getAll(normalizedUsername, folder)
        items.forEach(item => { if (item.hasLyric) { item.hasLyric = false; item.lyricFilename = undefined } })
        indexManager.save(normalizedUsername, folder)
    }
    return { deletedCount, freedSize }
}

/**
 * 清理过期的 .tmp 临时下载文件
 * @param username 用户名（可选）
 * @param maxAgeMs 最大存活时间（默认 10 分钟）
 */
export const cleanupStaleTempFiles = async (username?: string, maxAgeMs: number = 10 * 60 * 1000) => {
    const normalizedUsername = normalizeUsername(username)
    const roots: Array<'cache' | 'music'> = ['cache', 'music']
    const now = Date.now()
    let cleanedCount = 0

    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        try {
            const scanAndClean = (currentDir: string) => {
                if (!fs.existsSync(currentDir)) return
                const entries = fs.readdirSync(currentDir, { withFileTypes: true })
                for (const entry of entries) {
                    const fullPath = path.join(currentDir, entry.name)
                    if (entry.isDirectory()) {
                        scanAndClean(fullPath)
                    } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
                        try {
                            const stat = fs.statSync(fullPath)
                            if (now - stat.mtimeMs > maxAgeMs) {
                                fs.unlinkSync(fullPath)
                                cleanedCount++
                            }
                        } catch { }
                    }
                }
            }
            scanAndClean(dir)
        } catch (e) {
            console.warn(`[文件缓存] 清理临时文件失败 (${dir}):`, e)
        }
    }
    if (cleanedCount > 0) {
        console.log(`[文件缓存] [${normalizedUsername}] 已清理 ${cleanedCount} 个遗留 .tmp 临时文件`)
    }
    return cleanedCount
}

export const checkAndCleanupCache = async (username?: string) => {
    void cleanupStaleTempFiles(username)
    const config = (global as any).lx.config
    if (!config || !config['user.enableCacheSizeLimit']) return
    const { totalSize } = getCacheStats(username)
    const limitBytes = (config['user.cacheSizeLimit'] || 2000) * 1024 * 1024
    if (totalSize <= limitBytes) return
    const roots: Array<'cache' | 'music'> = ['cache', 'music']
    const allFiles: Array<{ path: string, size: number, mtime: number }> = []
    const normalizedUsername = normalizeUsername(username)
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir)
        for (const file of files) {
            try {
                const filePath = path.join(dir, file)
                const stats = fs.statSync(filePath)
                // 子目录（如小爱的 xiaoai/）也要收进来，否则限额清理永远动不到它们
                if (stats.isDirectory()) {
                    collectAudioFiles(filePath, allFiles)
                    continue
                }
                allFiles.push({ path: filePath, size: stats.size, mtime: stats.mtime.getTime() })
            } catch (e) { }
        }
    }
    allFiles.sort((a, b) => a.mtime - b.mtime)
    let currentSize = totalSize
    const targetSize = limitBytes * 0.95
    let deletedCount = 0
    for (const file of allFiles) {
        if (currentSize <= targetSize) break
        try { fs.unlinkSync(file.path); currentSize -= file.size; deletedCount++ } catch (e) { }
    }
    console.log(`[文件缓存] 用户 ${normalizedUsername} 缓存空间清理完成，已删除 ${deletedCount} 个过期文件`)
}

// 启动 5 秒后自动扫描并清理系统遗留的过期 .tmp 文件
setTimeout(() => {
    try {
        void cleanupStaleTempFiles()
    } catch { }
}, 5000)
/**
 * Switch files between 'cache' and 'music' folders
 */
export const switchFolder = async (filenames: string[], username: string | undefined) => {
    const normalizedUsername = normalizeUsername(username)
    let successCount = 0
    let failCount = 0
    // 目标已存在属于「无需移动」，不是失败——之前算进 failCount，导致前端弹
    // 「成功 0 项，失败 1 项」，让用户以为移动出错。单独计数后如实报「跳过」。
    let skipCount = 0

    const cacheIndex = indexManager.load(normalizedUsername, 'cache')
    const musicIndex = indexManager.load(normalizedUsername, 'music')

    const cacheDir = getCacheDir(normalizedUsername, false)
    const musicDir = getCacheDir(normalizedUsername, true)

    for (const filename of filenames) {
        let sourceFolder: 'cache' | 'music' | null = null
        let item: CacheItem | null = null
        let inMusic: CacheItem | undefined = undefined

        // Find which folder it belongs to
        const inCache = Array.from(cacheIndex.values()).find(i => i.filename === filename)
        if (inCache) {
            sourceFolder = 'cache'
            item = inCache
        } else {
            inMusic = Array.from(musicIndex.values()).find(i => i.filename === filename)
            if (inMusic) {
                sourceFolder = 'music'
                item = inMusic
            }
        }

        if (!sourceFolder || !item) {
            console.log(`[文件缓存][调试] 目录切换: 索引中未找到文件`, { filename, inCache: !!inCache, inMusic: !!inMusic })
            failCount++
            continue
        }

        const targetFolder: 'cache' | 'music' = sourceFolder === 'cache' ? 'music' : 'cache'

        // [Constraint] Cannot move from music subfolder to cache
        if (sourceFolder === 'music' && item.subPath && item.subPath !== '') {
            console.log(`[文件缓存] 移动已被拦截: ${filename} 位于分类子目录中，不支持直接移入缓存目录`)
            failCount++
            continue
        }

        const sourceDir = sourceFolder === 'music' ? musicDir : cacheDir
        const targetDir = targetFolder === 'music' ? musicDir : cacheDir

        const sourcePath = path.join(sourceDir, filename)
        const targetPath = path.join(targetDir, filename)

        try {
            console.log(`[文件缓存][调试] 开始切换目录`, { filename, sourceFolder, targetFolder, sourcePath, targetPath })
            const srcExists = fs.existsSync(sourcePath)
            const tgtExists = fs.existsSync(targetPath)
            console.log(`[文件缓存][调试] 文件存在性校验`, { filename, srcExists, tgtExists })

            if (srcExists) {
                // Ensure target directory exists (including any nested subfolders)
                const targetPathDir = path.dirname(targetPath)
                if (!fs.existsSync(targetPathDir)) fs.mkdirSync(targetPathDir, { recursive: true })

                // Check collision in target folder
                if (fs.existsSync(targetPath)) {
                    console.log(`[文件缓存] 移动冲突: ${filename} 已存在于 ${targetFolder}，跳过`)
                    skipCount++
                    continue
                }

                // Move audio file
                try {
                    safeRenameSync(sourcePath, targetPath)
                    console.log(`[文件缓存][调试] 音频文件已移动`, { filename, sourcePath, targetPath })
                } catch (moveErr) {
                    const errMsg = moveErr instanceof Error ? moveErr.stack : String(moveErr)
                    console.error(`[文件缓存][错误] 移动音频文件失败 (${filename}):`, errMsg)
                    failCount++
                    continue
                }

                // Move lyric file if exists
                if (item.lyricFilename) {
                    const sourceLrcPath = path.join(sourceDir, item.lyricFilename)
                    const targetLrcPath = path.join(targetDir, item.lyricFilename)
                    const targetLrcDir = path.dirname(targetLrcPath)
                    if (fs.existsSync(sourceLrcPath)) {
                        if (!fs.existsSync(targetLrcDir)) fs.mkdirSync(targetLrcDir, { recursive: true })
                        if (fs.existsSync(targetLrcPath)) fs.unlinkSync(targetLrcPath)
                        try {
                            safeRenameSync(sourceLrcPath, targetLrcPath)
                            console.log(`[文件缓存][调试] 歌词文件已移动`, { filename, sourceLrcPath, targetLrcPath })
                        } catch (lrErr) {
                            const errMsg = lrErr instanceof Error ? lrErr.stack : String(lrErr)
                            console.error(`[文件缓存][错误] 移动歌词文件失败 (${filename}):`, errMsg)
                        }
                    } else {
                        console.log(`[文件缓存][调试] 未找到关联歌词文件`, { filename, sourceLrcPath })
                    }
                }

                // Update Index
                const removed = indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality)
                console.log(`[文件缓存][调试] 索引移除结果`, { filename, removed })
                item.folder = targetFolder
                indexManager.update(normalizedUsername, item, targetFolder)

                // 清理源位置可能变空的歌单/分类目录
                cleanEmptyParentDirs(sourcePath, sourceDir)

                successCount++
            } else {
                console.log(`[文件缓存][调试] 源文件不存在`, { filename, sourcePath })
                failCount++
            }
        } catch (e) {
            const errMsg = e instanceof Error ? e.stack : String(e)
            console.error(`[文件缓存] 移动文件失败 (${filename}):`, errMsg)
            failCount++
        }
    }

    return { successCount, failCount, skipCount }
}

export const switchBaseLocation = async (filenames: string[], username: string | undefined) => {
    const normalizedUsername = normalizeUsername(username)
    let successCount = 0
    let failCount = 0
    const sourceLoc = getUserCacheLocation(normalizedUsername)
    const targetLoc = sourceLoc === CACHE_ROOTS.DATA ? CACHE_ROOTS.ROOT : CACHE_ROOTS.DATA

    const folders: Array<'cache' | 'music'> = ['cache', 'music']

    // Helper to get dir for a specific location
    const getLocalDir = (folder: string, loc: string) => {
        const folderName = folder === 'music' ? 'music' : 'cache'
        const base = loc === CACHE_ROOTS.DATA ? global.lx.dataPath : process.cwd()
        const userDir = normalizeUsername(username)
        return path.join(base, folderName, userDir)
    }

    for (const filename of filenames) {
        let sourceFolder: 'cache' | 'music' | null = null
        let item: CacheItem | null = null

        // Find folder in SOURCE location
        for (const folder of folders) {
            const items = indexManager.getAll(normalizedUsername, folder, sourceLoc)
            const found = items.find(i => i.filename === filename)
            if (found) {
                sourceFolder = folder
                item = found
                break
            }
        }

        if (!sourceFolder || !item) {
            failCount++
            continue
        }

        const sourceDir = getLocalDir(sourceFolder, sourceLoc)
        const targetDir = getLocalDir(sourceFolder, targetLoc)

        const sourcePath = path.join(sourceDir, filename)
        const targetPath = path.join(targetDir, filename)

        try {
            if (fs.existsSync(sourcePath)) {
                const targetPathDir = path.dirname(targetPath)
                if (!fs.existsSync(targetPathDir)) fs.mkdirSync(targetPathDir, { recursive: true })

                // Check collision in target location
                if (fs.existsSync(targetPath)) {
                    console.log(`[文件缓存] 根路径迁移冲突: ${filename} 已存在于目标位置 ${targetLoc}，跳过`)
                    failCount++
                    continue
                }

                // Move audio file
                safeRenameSync(sourcePath, targetPath)

                // Move lyrics
                if (item.lyricFilename) {
                    const sourceLrcPath = path.join(sourceDir, item.lyricFilename)
                    const targetLrcPath = path.join(targetDir, item.lyricFilename)
                    const targetLrcDir = path.dirname(targetLrcPath)
                    if (fs.existsSync(sourceLrcPath)) {
                        if (!fs.existsSync(targetLrcDir)) fs.mkdirSync(targetLrcDir, { recursive: true })
                        if (fs.existsSync(targetLrcPath)) fs.unlinkSync(targetLrcPath)
                        safeRenameSync(sourceLrcPath, targetLrcPath)
                    }
                }

                // Update Indices
                indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality, sourceLoc)
                // item is now in the other location's index
                indexManager.update(normalizedUsername, item, sourceFolder, targetLoc)

                // 清理源位置可能变空的歌单/分类目录
                cleanEmptyParentDirs(sourcePath, sourceDir)

                successCount++
            } else {
                failCount++
            }
        } catch (e) {
            console.error(`[文件缓存] 迁移文件失败 (${filename} 从 ${sourceLoc} 到 ${targetLoc}):`, e)
            failCount++
        }
    }

    return { successCount, failCount, targetLoc }
}

/**
 * [New] Get all subdirectories in the music/cache folders
 */
export const getSubDirectories = (username: string | undefined, folder: 'cache' | 'music') => {
    const normalizedUsername = normalizeUsername(username)
    const root = getCacheDir(normalizedUsername, folder === 'music')
    if (!fs.existsSync(root)) return []

    const dirs = new Set<string>()

    // 1. Get from index
    const items = indexManager.getAll(normalizedUsername, folder)
    items.forEach(item => { if (item.subPath) dirs.add(item.subPath) })

    // 2. Scan physical tree (to include empty folders)
    const scanDirs = (dirPath: string, base: string) => {
        if (!fs.existsSync(dirPath)) return
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const fullPath = path.join(dirPath, entry.name)
                dirs.add(path.relative(base, fullPath).replace(/\\/g, '/'))
                scanDirs(fullPath, base)
            }
        }
    }
    scanDirs(root, root)

    return Array.from(dirs).sort()
}

/**
 * [New] Create a subdirectory
 */
export const createSubDirectory = (username: string | undefined, folder: 'cache' | 'music', subPath: string) => {
    const root = getCacheDir(username, folder === 'music')
    const target = path.join(root, subPath)
    if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true })
        return true
    }
    return false
}

/**
 * [New] Categorize multiple files into a subdirectory
 */
export const categorizeFiles = async (filenames: string[], targetSubPath: string, username: string | undefined) => {
    const normalizedUsername = normalizeUsername(username)
    const folder = 'music' // Categorization is primarily for music folder
    const root = getCacheDir(normalizedUsername, true)
    const targetDir = path.join(root, targetSubPath)

    if (targetSubPath && !fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
    }

    const allItems = indexManager.getAll(normalizedUsername, folder)
    let successCount = 0
    let failCount = 0

    for (const filename of filenames) {
        const item = allItems.find(i => i.filename === filename)
        if (!item) {
            console.warn(`[文件缓存] 分类归档: 未在索引中找到歌曲 ${filename}`)
            failCount++;
            continue
        }

        const oldPath = path.join(root, filename)
        const newFilename = targetSubPath ? path.join(targetSubPath, path.basename(filename)).replace(/\\/g, '/') : path.basename(filename)
        const newPath = path.join(root, newFilename)

        if (oldPath === newPath) { successCount++; continue }

        try {
            // Physically move file
            if (fs.existsSync(oldPath)) {
                safeRenameSync(oldPath, newPath)

                // Move lyrics if exist
                const ext = path.extname(filename)
                const oldLrcPath = oldPath.substring(0, oldPath.length - ext.length) + '.lrc'
                const newLrcPath = newPath.substring(0, newPath.length - ext.length) + '.lrc'
                if (fs.existsSync(oldLrcPath)) {
                    safeRenameSync(oldLrcPath, newLrcPath)
                }

                // Update index
                item.filename = newFilename
                item.subPath = targetSubPath
                if (item.lyricFilename) {
                    const musicExt = path.extname(newFilename)
                    const lrcExt = path.extname(item.lyricFilename) || '.lrc'
                    item.lyricFilename = newFilename.substring(0, newFilename.length - musicExt.length) + lrcExt
                }

                // 清理原分类目录如果已变空
                cleanEmptyParentDirs(oldPath, root)
            } else {
                failCount++
                continue
            }

            successCount++
        } catch (e: any) {
            console.error('[文件缓存] 分类归档操作失败 (' + filename + '):', e)
            failCount++
        }
    }

    indexManager.save(normalizedUsername, folder)
    return { successCount, failCount }
}

/**
 * [New] Rename a subdirectory and update index entries
 */
export const renameSubDirectory = (username: string | undefined, folder: 'cache' | 'music', oldSubPath: string, newSubPath: string) => {
    const normalizedUsername = normalizeUsername(username)
    const root = getCacheDir(normalizedUsername, folder === 'music')
    const oldDir = path.join(root, oldSubPath)
    const newDir = path.join(root, newSubPath)

    if (!fs.existsSync(oldDir)) return { success: false, message: '原分类目录不存在' }
    if (fs.existsSync(newDir)) return { success: false, message: '目标分类目录名称已存在' }

    try {
        safeRenameSync(oldDir, newDir)
    } catch (e: any) {
        console.error('[文件缓存] 重命名目录失败:', e)
        return { success: false, message: e?.message || '重命名目录失败' }
    }

    // Update indexes
    const allItems = indexManager.getAll(normalizedUsername, folder)
    let updatedCount = 0
    for (const item of allItems) {
        if (item.subPath === oldSubPath || item.subPath?.startsWith(oldSubPath + '/')) {
            const relSub = item.subPath === oldSubPath ? '' : item.subPath.slice(oldSubPath.length + 1)
            const updatedSub = relSub ? `${newSubPath}/${relSub}` : newSubPath
            item.subPath = updatedSub

            if (item.filename) {
                const baseName = path.basename(item.filename)
                item.filename = `${updatedSub}/${baseName}`
            }
            if (item.lyricFilename) {
                const baseLrc = path.basename(item.lyricFilename)
                item.lyricFilename = `${updatedSub}/${baseLrc}`
            }
            updatedCount++
        }
    }
    indexManager.save(normalizedUsername, folder)
    return { success: true, updatedCount }
}

/**
 * [New] Delete a subdirectory. If deleteSongs is true, physically remove files and index. If false, move songs to root directory.
 */
export const deleteSubDirectory = (username: string | undefined, folder: 'cache' | 'music', subPath: string, deleteSongs: boolean) => {
    const normalizedUsername = normalizeUsername(username)
    const root = getCacheDir(normalizedUsername, folder === 'music')
    const targetDir = path.join(root, subPath)

    if (!fs.existsSync(targetDir)) return { success: false, message: '分类目录不存在' }

    const allItems = indexManager.getAll(normalizedUsername, folder)
    const affectedItems = allItems.filter(item => item.subPath === subPath || item.subPath?.startsWith(subPath + '/'))

    if (deleteSongs) {
        // Remove from index
        for (const item of affectedItems) {
            indexManager.remove(normalizedUsername, item.id, folder, item.quality)
        }
        indexManager.save(normalizedUsername, folder)

        // Remove physically
        try {
            fs.rmSync(targetDir, { recursive: true, force: true })
        } catch (e: any) {
            console.error('[文件缓存] 物理删除分类目录失败:', e)
            return { success: false, message: e?.message || '删除物理目录失败' }
        }
        return { success: true, affectedCount: affectedItems.length, action: 'deleted' }
    } else {
        // Move songs and lyrics to root
        let movedCount = 0
        for (const item of affectedItems) {
            const oldAudioPath = path.join(root, item.filename)
            const newFilename = path.basename(item.filename)
            const newAudioPath = path.join(root, newFilename)

            try {
                if (fs.existsSync(oldAudioPath)) {
                    if (oldAudioPath !== newAudioPath) {
                        safeRenameSync(oldAudioPath, newAudioPath)
                    }
                }
                if (item.lyricFilename) {
                    const oldLrcPath = path.join(root, item.lyricFilename)
                    const newLrcFilename = path.basename(item.lyricFilename)
                    const newLrcPath = path.join(root, newLrcFilename)
                    if (fs.existsSync(oldLrcPath) && oldLrcPath !== newLrcPath) {
                        safeRenameSync(oldLrcPath, newLrcPath)
                    }
                    item.lyricFilename = newLrcFilename
                }

                item.filename = newFilename
                item.subPath = ''
                movedCount++
            } catch (e: any) {
                console.error('[文件缓存] 移动歌曲至根目录失败 (' + item.filename + '):', e)
            }
        }
        indexManager.save(normalizedUsername, folder)

        // Remove empty directory (or with leftover unknown files)
        try {
            fs.rmSync(targetDir, { recursive: true, force: true })
        } catch (e: any) {
            console.warn('[文件缓存] 删除已清空分类目录警告:', e)
        }
        return { success: true, affectedCount: movedCount, action: 'moved_to_root' }
    }
}


/** 单次体检的汇总结果 */
export interface CacheAuditReport {
    total: number
    checked: number
    clean: number
    dirty: number
    unverified: number
    /** 本地/直链来源、不具备回查条件的条目数（计入 clean，单独统计便于读报告） */
    skipped: number
    removed: number
    applied: boolean
    items: CacheAuditFinding[]
    startedAt: number
    finishedAt: number
}

/**
 * 存量缓存体检：逐条解码真实时长，用「时长/码率 + ID3 标签 + 源侧登记」三道判据核验来源。
 *
 * `apply=false`（默认）只出报告不动文件——误删用户缓存是不可逆的，
 * 所以删除必须由调用方显式确认。核验通过（clean）的条目会写 `originVerifiedAt`，
 * 之后的命中路径不再重复回查音源。
 *
 * 只扫 cache 目录：music 目录是用户主动下载的资产，不属于缓存治理范围。
 */
export const auditCache = async (options: {
    username?: string
    limit?: number
    intervalMs?: number
    apply?: boolean
    onProgress?: (done: number, total: number) => void
} = {}): Promise<CacheAuditReport> => {
    const normalizedUsername = normalizeUsername(options.username)
    const limit = Math.max(0, Number(options.limit) || 0)
    const intervalMs = Math.max(0, Number(options.intervalMs ?? 200) || 0)
    const apply = !!options.apply

    const all = indexManager.getAll(normalizedUsername, 'cache')
    const targets = limit > 0 ? all.slice(0, limit) : all
    const findings: CacheAuditFinding[] = []
    let removed = 0

    for (const item of targets) {
        const finding = await auditCacheItem(item, normalizedUsername, 'cache')
        findings.push(finding)

        if (finding.verdict === 'clean') {
            indexManager.update(normalizedUsername, { ...item, originVerifiedAt: Date.now() }, 'cache')
        } else if (finding.verdict === 'dirty' && apply) {
            const dir = getCacheDir(normalizedUsername, false)
            const filePath = path.join(dir, item.filename || '')
            indexManager.remove(normalizedUsername, item.id, 'cache', item.quality)
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) } catch { }
            removed++
            const line = `[文件缓存] 体检剔除脏缓存 (${item.filename})：${finding.reason}`
            console.warn(line)
            syncLog.warn(line)
        }
        options.onProgress?.(findings.length, targets.length)
        if (intervalMs > 0 && findings.length < targets.length) {
            await new Promise(resolve => setTimeout(resolve, intervalMs))
        }
    }

    const count = (verdict: CacheAuditFinding['verdict']) => findings.filter(item => item.verdict === verdict).length
    const skipped = findings.filter(item => item.skipped).length
    return {
        total: targets.length,
        checked: findings.length,
        clean: count('clean') - skipped,
        dirty: count('dirty'),
        unverified: count('unverified'),
        skipped,
        removed,
        applied: apply,
        items: findings,
        startedAt: Date.now(),
        finishedAt: Date.now(),
    }
}
