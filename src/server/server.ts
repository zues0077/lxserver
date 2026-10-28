import http, { type IncomingMessage } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { registerLocalSyncEvent, callObj, sync } from './sync'
import { authCode, authConnect } from './auth'
import { getAddress, sendStatus, decryptMsg, encryptMsg, getIP } from '@/utils/tools'
import { accessLog, startupLog, syncLog, loginLog, tokenLog } from '@/utils/log4js'
import {
  File,
  SYNC_CODE,
  SYNC_CLOSE_CODE,
} from '@/constants'
import { getUserSpace, releaseUserSpace, getUserName, getServerId, getUserDirname, getUserConfig, migrateUserData, renameUserSpace, finishRenameUserSpace, updateAllUserSnapshotDirs } from '@/user'
import { parseDislikeRules, splitSingers } from '@/modules/dislike/match'
import { encodeAlbumRule } from '@/modules/dislike/utils'
import { normalizeText } from '@/server/utils/songVersion'
import { buildStreamHeaders } from './utils/streamHeaders'
import { isEncryptedRemoteStream } from './utils/streamEncryption'
import { invalidateDislikeCache } from '@/server/utils/dislikeCache'
import { createMsg2call } from 'message2call'
import { ElFinderConnector, getSystemRoot } from './elfinderConnector'
import formidable from 'formidable'
// @ts-ignore
import musicSdkRaw from '@/modules/utils/musicSdk/index.js'
const musicSdk = musicSdkRaw as any
import { initUserApis, callUserApiGetMusicUrl, isSourceSupported, getLoadedApis, getLoadedApisCount, getLastReloadDurationMs, getActiveResourceSummary, getTrackedTimerCount, getTrackedTimerDetails, getSourceActivitySnapshot } from './userApi'
import { loadPersistedSessions, persistSessions } from './sessionStore'
import { getSourceGuardStatus, trustSource, untrustSource, isolateManually, clearIsolation } from './sourceGuard'
import { getSourceProbeStatus } from './sourceProbe'
import { getEventLoopStats } from '@/utils/eventLoopMonitor'
import { getActiveLongTimers } from '@/utils/stdoutBridge'
import { getAppVersion } from '@/utils/version'
import { getActiveHostActivities } from './sourceActivity'
import { setUserAuthVerifier } from './userAuth'
import * as customSourceHandlers from './customSourceHandlers'
import * as fileCache from './fileCache'
import { checkPersistentVolumes } from './volumeCheck'
import * as customMusicManager from './customMusicManager'
import * as serverDownloadQueue from './serverDownloadQueue'
import * as remasterQueue from './remasterQueue'
import * as scheduler from './scheduler'
import { getUpdatedListIds, removeUpdatedListId } from './task/networkListTask'
import { setSongResolver, getSyncDownloadData, saveSyncDownloadData, getUserSyncProgress, triggerUserSync, cancelUserSync, getUserSyncStorageLocation, isUserSyncRunning, migrateSyncStorage } from './task/syncDownloadTask'
import { getDownloadQualityCandidates } from './downloadQuality'
import crypto from 'node:crypto'
import needle from 'needle'
import { getProxyAgent } from '../modules/utils/proxy.js'
import * as musicAccount from './musicAccount'
import { isUserAllowed, getAllowedUsers } from './musicAccount/permission'
import * as extraSources from './extraSources'
import {
  xiaoAiService,
  buildStreamUrl,
  parseStreamToken,
  serveXiaoAiStream,
  probeAudioSource,
  getStreamRounds,
  detectAudioFormat,
  detectAudioDurationMs,
  id3v2Size,
  loadXiaoAiConfig,
  buildTrackKey,
  getCachedTrack,
  getCachedTrackUrl,
  setCachedTrackUrl,
  retireStreams,
  markDrainOnly,
  sleepTimer,
  mp3CachePath,
  isMp3File,
  transcodeFileToMp3,
  isFfmpegAvailable,
  seekSlicePath,
  sliceMp3FromFile,
  pruneSeekSlices,
} from './xiaoai'
const { MusicTagger, MetaPicture } = require('music-tag-native')

/** 当前生效的 dislike 匹配选项，下发给前端保证前后端判定一致 */
const dislikeMatchOptions = () => ({
  crossSource: global.lx.config['subsonic.dislikeCrossSource'] === true,
  duetMode: (global.lx.config['subsonic.dislikeDuetMode'] || 'any') as 'any' | 'all' | 'primary',
  normalizeName: global.lx.config['subsonic.dislikeNormalizeName'] !== false,
  requireSinger: global.lx.config['subsonic.dislikeRequireSinger'] !== false,
})

/** 把 dislike 规则集转成可 JSON 序列化的结构（Set/Map → Array，同时聚合 dislike/library 下的 albums 和 artists） */
const serializeDislikeRules = (rules: string, username?: string) => {
  const parsed = parseDislikeRules(rules)
  if (username) {
    try {
      const uDir = getUserDirname(username)
      const dLibDir = path.join(global.lx.userPath, uDir, 'dislike', 'library')
      // Merge disliked albums from library/albums.json
      const albumsFile = path.join(dLibDir, 'albums.json')
      if (fs.existsSync(albumsFile)) {
        const albumsArr = JSON.parse(fs.readFileSync(albumsFile, 'utf8'))
        if (Array.isArray(albumsArr)) {
          for (const x of albumsArr) {
            const albumName = normalizeText(String(x.name || ''))
            if (!albumName) continue
            let sSet = parsed.albums.get(albumName)
            if (!sSet) {
              sSet = new Set<string>()
              parsed.albums.set(albumName, sSet)
            }
            const singers = splitSingers(x.artistName)
            for (const s of singers) sSet.add(s)
          }
        }
      }
      // Merge disliked artists from library/artists.json
      const artistsFile = path.join(dLibDir, 'artists.json')
      if (fs.existsSync(artistsFile)) {
        const artistsArr = JSON.parse(fs.readFileSync(artistsFile, 'utf8'))
        if (Array.isArray(artistsArr)) {
          for (const x of artistsArr) {
            const singerName = normalizeText(String(x.name || ''))
            if (singerName) parsed.singerNames.add(singerName)
          }
        }
      }
    } catch (e: any) {
      console.warn('[黑名单] 合并黑名单规则失败:', e.message)
    }
  }
  return {
    exact: Array.from(parsed.exact),
    musicNames: Array.from(parsed.musicNames),
    singerNames: Array.from(parsed.singerNames),
    albums: Array.from(parsed.albums.entries()).map(([albumName, singers]) => ({
      albumName,
      singers: Array.from(singers),
    })),
  }
}

// ===== Player Session Store =====
const playerSessions = new Map<string, { createdAt: number, user?: string | null }>()
const SESSION_TTL = 24 * 60 * 60 * 1000 // 24小时
const SESSION_COOKIE_NAME = 'lx_player_session'

// 收藏歌手列表头像补全：内存缓存（避免每次刷新重复请求音源）
const artistPicCache = new Map<string, string>()
const artistPicInFlight = new Map<string, Promise<string | null>>()
function extractArtistPic(d: any): string | null {
  if (!d || typeof d !== 'object') return null
  return d.avatar || d.img || d.pic || d.picUrl || d.picture || d.image || d.cover || null
}

// 收藏专辑列表封面补全：内存缓存（best-effort：取专辑歌曲列表首曲 img）
const albumPicCache = new Map<string, string>()
const albumPicInFlight = new Map<string, Promise<string | null>>()
function extractAlbumPic(d: any): string | null {
  const first = d?.list?.[0]
  const candidates = [first?.img, first?.meta?.img, d?.info?.img, d?.img, d?.pic, d?.cover, d?.coverUrl]
  for (const v of candidates) if (typeof v === 'string' && v) return v
  return null
}

// 进程级共享信号量：限制整个服务同时向音源回源拉取专辑/歌手详情的并发数，防止限流
const MEDIA_METADATA_FETCH_MAX_CONCURRENCY = 5
let activeMediaMetadataFetches = 0
const mediaMetadataWaiters: Array<() => void> = []

function acquireMediaMetadataSlot(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (activeMediaMetadataFetches < MEDIA_METADATA_FETCH_MAX_CONCURRENCY) {
      activeMediaMetadataFetches++
      resolve()
    } else {
      mediaMetadataWaiters.push(resolve)
    }
  })
}

function releaseMediaMetadataSlot() {
  activeMediaMetadataFetches = Math.max(0, activeMediaMetadataFetches - 1)
  const next = mediaMetadataWaiters.shift()
  if (next) {
    activeMediaMetadataFetches++
    next()
  }
}

/** 进程级共享的专辑封面拉取：带全局并发限制与 In-flight Promise 复用 */
async function fetchAlbumPicShared(source: string, id: string | number): Promise<string | null> {
  const key = `${source}::${id}`
  const cached = albumPicCache.get(key)
  if (cached) return cached

  if (albumPicInFlight.has(key)) {
    return albumPicInFlight.get(key)!
  }

  const promise = (async () => {
    await acquireMediaMetadataSlot()
    try {
      if (albumPicCache.has(key)) return albumPicCache.get(key) || null
      const detail = await musicSdk[source]?.extendDetail?.getAlbumSongs?.(String(id))
      const pic = extractAlbumPic(detail) || null
      if (pic) albumPicCache.set(key, pic)
      return pic
    } catch {
      return null
    } finally {
      releaseMediaMetadataSlot()
      albumPicInFlight.delete(key)
    }
  })()

  albumPicInFlight.set(key, promise)
  return promise
}

/** 进程级共享的歌手头像拉取：带全局并发限制与 In-flight Promise 复用 */
async function fetchArtistPicShared(source: string, id: string | number): Promise<string | null> {
  const key = `${source}::${id}`
  const cached = artistPicCache.get(key)
  if (cached) return cached

  if (artistPicInFlight.has(key)) {
    return artistPicInFlight.get(key)!
  }

  const promise = (async () => {
    await acquireMediaMetadataSlot()
    try {
      if (artistPicCache.has(key)) return artistPicCache.get(key) || null
      const detail = await musicSdk[source]?.extendDetail?.getArtistDetail?.(String(id))
      const pic = extractArtistPic(detail) || null
      if (pic) artistPicCache.set(key, pic)
      return pic
    } catch {
      return null
    } finally {
      releaseMediaMetadataSlot()
      artistPicInFlight.delete(key)
    }
  })()

  artistPicInFlight.set(key, promise)
  return promise
}

/** 生成随机 sessionId */
const generateSessionId = () => crypto.randomBytes(32).toString('hex')

/** 判断请求是否处于 HTTPS 安全上下文 (直接 TLS 或经过反向代理 TLS) */
const isHttpsRequest = (req: IncomingMessage): boolean => {
  if ((req.socket as any)?.encrypted || (req.connection as any)?.encrypted) return true
  const fwdProto = req.headers['x-forwarded-proto']
  if (fwdProto) {
    const protoStr = Array.isArray(fwdProto) ? fwdProto[0] : fwdProto
    if (protoStr.split(',')[0].trim().toLowerCase() === 'https') return true
  }
  return false
}

/** 生成 Player Session Cookie 响应头 (仅在 HTTPS 下附加 Secure 标记，避免 HTTP 环境下 Cookie 被现代浏览器丢弃) */
const buildSessionCookieHeader = (req: IncomingMessage, sessionId: string, maxAge: number): string => {
  const secureAttr = isHttpsRequest(req) ? '; Secure' : ''
  return `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Path=/; SameSite=Lax${secureAttr}; Max-Age=${maxAge}`
}

/** 解析 Cookie 字符串 */
const parseCookies = (cookieHeader: string | undefined): Record<string, string> => {
  if (!cookieHeader) return {}
  return Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [k, ...v] = c.trim().split('=')
      return [k.trim(), decodeURIComponent(v.join('='))]
    })
  )
}

/** 检查请求是否携带有效的 Player Session Cookie 或有效的用户凭证 */
const checkPlayerAuth = (req: IncomingMessage): boolean => {
  if (!global.lx.config['player.enableAuth']) return true // 未开启认证，直接放行
  const cookies = parseCookies(req.headers['cookie'])
  const sessionId = cookies[SESSION_COOKIE_NAME]
  if (sessionId) {
    const session = playerSessions.get(sessionId)
    if (session && Date.now() - session.createdAt <= SESSION_TTL) {
      return true
    }
    if (session) playerSessions.delete(sessionId)
  }
  // Safari / Token 备选鉴权: 若 Cookie 丢失但请求中携带了有效的用户 Token
  const user = verifyUserAuth(req)
  if (user) return true
  return false
}

/** 推断本次请求对应的服务对外地址（用于给小爱音箱下发可访问的播放链接） */
const getRequestOrigin = (req: IncomingMessage): string => {
  const proto = isHttpsRequest(req) ? 'https' : 'http'
  const fwdHost = req.headers['x-forwarded-host']
  const host = (Array.isArray(fwdHost) ? fwdHost[0] : fwdHost) || req.headers.host || ''
  return host ? `${proto}://${host}` : ''
}

/**
 * 投播时使用的对外地址。
 *
 * 配置里的「服务地址」优先，但把 127.0.0.1/localhost 当地址是常见误填——
 * 音箱会照着这个地址请求它自己，表现为能收到指令却拉不到音频，
 * 所以这类值直接忽略，退回浏览器访问本服务时的来源地址。
 */
const LOOPBACK_BASE_URL = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[?::1\])/i
const resolvePlayBaseUrl = (req: IncomingMessage, configured: string): string => {
  const value = String(configured || '').trim().replace(/\/+$/, '')
  if (value && !LOOPBACK_BASE_URL.test(value)) return value
  return getRequestOrigin(req)
}

/**
 * 小爱投播接口的身份校验：返回 null 表示校验不通过，调用方应回 401。
 *
 * 匿名用户统一成 `_open`（不是 `open`）：
 *  - 普通歌曲缓存的匿名目录叫 `_open`（fileCache.getCacheDir 的约定）
 *  - 返回 `open` 会让小爱去 `cache/open/` 找缓存，**永远命中不了**播放器已经缓存好的歌，
 *    每次投送都要重新下载；同时 `cache/open/xiaoai/` 的转码产物也不在
 *    「权限与缓存限制」的统计范围内（统计/清理只看 `_open`），等于永远不受限额约束。
 */
const resolveXiaoAiUser = (req: IncomingMessage): string | null => {
  const clientUsername = req.headers['x-user-name'] as string | undefined
  if (!clientUsername || clientUsername === 'default' || clientUsername === 'open' || clientUsername === '_open') {
    return '_open'
  }
  const verified = verifyUserAuth(req)
  if (!verified || verified !== clientUsername) return null
  return verified
}

/** 音源可用性探测结果的短时缓存，避免自动续播/重复投送时反复回源 */
const audioProbeCache = new Map<
  string,
  { ok: boolean; detail: string; contentType: string; durationMs: number; at: number }
>()
const AUDIO_PROBE_TTL_MS = 5 * 60 * 1000
/** 最近一次投送使用的流标识（/status 用它回报「这一路被拉了几遍」） */
let lastXiaoAiStreamSid = ''
/** 最近一次投送完成的时刻：和「音箱真的来拉流」的时刻一减，就是投送到起播的真实延迟 */
let lastXiaoAiPushAt = 0
/** 本次这一路流「第一次被音箱请求」的时刻 */
let lastXiaoAiStreamAt = 0
/**
 * 最近一次 /play 解析好的音源与时长（拖动进度条时复用）。
 *
 * 小爱没有 seek 指令，跳转只能「产出一条从第 N 秒开头的流 + 重新投送一次」。
 * 重新投送必须复用这里存下的 target：重走 resolvePlayableAudio 要遍历几十个源、
 * 每个候选做音频探测，实测 2~8 秒，拖完进度条等这么久等于不可用。
 * 注意：seek 不会覆盖它（否则连续拖两次会基于切片再切片，位置叠加错乱）。
 */
let lastXiaoAiTrack: {
  songInfo: Record<string, any>
  quality: string
  username: string
  deviceIds: string[]
  target: XiaoAiTrackTarget
  /** 整首时长（毫秒），seek 时用它算剩余时长 */
  durationMs: number
} | null = null
/** 当前这一路流从第几秒开始：前端据此把设备上报的「流内位置」换算成「曲内位置」 */
let lastXiaoAiSeekSec = 0
/**
 * 音箱/云端上报的曲目时长（毫秒），从 /status 的 play_song_detail 里捞。
 *
 * 兜底用：本地文件时长探测偶发失败（比如 ID3 里塞了超大封面）时，
 * seek 至少要有个量级正确的时长来夹取位置，否则会退化成「从头重播」。
 */
let lastXiaoAiDeviceDurationMs = 0

const probeAudioCached = async (url: string) => {
  const hit = audioProbeCache.get(url)
  if (hit && Date.now() - hit.at < AUDIO_PROBE_TTL_MS) return hit
  const result = await probeAudioSource(url)
  const entry = {
    ok: result.ok,
    detail: result.ok ? `ok/${result.format || result.contentType}` : result.detail,
    contentType: result.ok ? result.contentType : '',
    // 真实音频时长：投送给音箱后，前端靠它判断「还剩几秒」，不再依赖不可靠的元数据
    durationMs: result.ok ? result.durationMs || 0 : 0,
    at: Date.now(),
  }
  if (audioProbeCache.size > 300) audioProbeCache.clear()
  audioProbeCache.set(url, entry)
  return entry
}

/**
 * 带预算的探测：超时就当「没探到」，不阻塞投送。
 *
 * 直链投送原本是零等待的，不能因为一个慢音源把投送卡住几秒——
 * 用户点下播放却没反应，比切歌时机差两秒难受得多。
 */
const DIRECT_PROBE_BUDGET_MS = 2500

const probeWithBudget = async (url: string) => {
  const probe = probeAudioCached(url).catch(() => null)
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), DIRECT_PROBE_BUDGET_MS))
  return Promise.race([probe, timeout])
}

/** 本地缓存文件：读前 8KB 解析真实时长（自动续播切歌时机用） */
const probeLocalFileDuration = (filePath: string): number => {
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const totalBytes = fs.statSync(filePath).size
    const buffer = Buffer.alloc(8192)
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    let head = buffer.subarray(0, read)
    let sizeForCalc = totalBytes
    let format = detectAudioFormat(head)

    // ID3v2 里经常内嵌整张封面（实测有 300KB 的），此时前 8KB 全是标签，
    // 第一个音频帧还在标签后面 → 帧扫描一上来就跳出循环，时长算成 0。
    // 按标签长度把读窗口挪到音频数据起点再读一次（同时把体积也扣掉标签）。
    const tagSize = id3v2Size(head)
    if (tagSize > 0 && tagSize + 64 < totalBytes && (format === '' || format === 'mp3')) {
      const shifted = Buffer.alloc(8192)
      const got = fs.readSync(fd, shifted, 0, shifted.length, tagSize)
      if (got > 16) {
        head = shifted.subarray(0, got)
        sizeForCalc = totalBytes - tagSize
        format = detectAudioFormat(head)
      }
    }
    if (!format) return 0
    return detectAudioDurationMs(head, format, sizeForCalc)
  } catch {
    return 0
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 忽略 */
      }
    }
  }
}

interface ResolvedPlayableAudio {
  url: string
  sourceName: string
  quality: string
  /** 探测到的真实 Content-Type（上游常给 octet-stream，投送时要纠正） */
  contentType: string
  /** 探测到的真实音频时长（毫秒），0 表示算不出 */
  durationMs: number
  failures: string[]
}

/**
 * 这个平台此刻有没有能力取到播放地址。
 * 两条独立通道：自定义源脚本，或者管理员在「平台账号」里配了自己的 Cookie
 * （账号通道即使一个自定义源都没装也应当可用，判定与 /api/music/url 主流程保持一致）。
 */
const canResolveSource = (source: string, username: string): boolean => {
  if (isSourceSupported(source, username)) return true
  try {
    return musicAccount.isEnabled() &&
      musicAccount.isSupportedSource(source) &&
      musicAccount.hasAccount(source) &&
      isUserAllowed(username)
  } catch {
    return false
  }
}

/**
 * 解析出「确认真的能出音频」的播放地址。
 *
 * 音源脚本只要拼出一个字符串就算成功，它不会验证对方是否还活着
 * （典型现象：同一平台的 30 多个源共用同一个上游，上游一挂，逐个试都拿到 404）。
 * 所以这里每拿到一个地址都先探 64 字节：不是音频就把它记进 exclude 换下一个源，
 * 直到某个源真的能出音频，或所有源都试完。
 */
const resolvePlayableAudio = async (
  songInfo: any,
  requestedQuality: string,
  username: string,
): Promise<ResolvedPlayableAudio> => {
  const failures: string[] = []
  const tried = new Set<string>()
  // 逐源重试要有个上限：某个平台真整体挂掉时，30 多个源全试一遍会让用户干等，
  // 这里给 20 秒总预算 + 最多 8 次探测，超了就带着已有失败原因返回。
  const deadline = Date.now() + 20000
  let probes = 0
  const qualities = [requestedQuality, ...getDownloadQualityCandidates(requestedQuality)]
    .filter((q, i, arr) => !!q && arr.indexOf(q) === i)
    .slice(0, 2)

  /** 对同一个候选，逐源尝试：探测失败就把该源加入 exclude 再问下一个 */
  const attempt = async (candidate: any, quality: string) => {
    const source = String(candidate?.source || '')
    if (!source) return null

    // 额外音源（Bilibili / 汽水）自带取流，不经过 musicSdk、也不在任何自定义源表里。
    // 以前这里只看 isSourceSupported()，导致汽水/B 站的投送在入口就被判「没有可用音源」，
    // 而且失败原因是空的（一个源都没试过，failures 里什么都没有）。
    const isExtra = extraSources.isExtraSource(source)
    if (!isExtra && !canResolveSource(source, username)) {
      failures.push(`${source}: 没有支持该平台的自定义源，平台账号也不可用`)
      return null
    }

    const id = String(candidate.songmid || candidate.id || candidate.hash || candidate.name || '')
    const key = `${source}|${id}|${quality}`
    if (tried.has(key)) return null
    tried.add(key)

    // 额外音源：单源直取（自带账号 Cookie），没有「同平台多源轮换」的概念
    if (isExtra) {
      if (Date.now() >= deadline || probes >= 8) return null
      try {
        const extra = await extraSources.getMusicUrl(source, candidate, quality, username)
        const extraUrl = String(extra?.url || '').trim()
        const extraLabel = String(extra?.sourceName || extraSources.displayName(source))
        if (!extraUrl) {
          failures.push(`${extraLabel}: 未返回播放地址`)
          return null
        }
        probes++
        const extraProbe = await probeAudioCached(extraUrl)
        if (extraProbe.ok) {
          return {
            url: extraUrl,
            sourceName: extraLabel,
            quality: String(extra?.type || quality),
            contentType: extraProbe.contentType || '',
            durationMs: extraProbe.durationMs || 0,
          }
        }
        failures.push(`${extraLabel}: 地址不可播（${extraProbe.detail}）`)
      } catch (error: any) {
        failures.push(`${extraSources.displayName(source)}: ${error?.message || error}`)
      }
      return null
    }

    const exclude: string[] = []
    for (let round = 0; round < 5; round++) {
      if (Date.now() >= deadline || probes >= 8) return null
      let result: any
      try {
        result = await callUserApiGetMusicUrl(source, candidate, quality, username, undefined, true, exclude)
      } catch (error: any) {
        failures.push(`${source}: ${error?.message || error}`)
        return null
      }
      const url = String(result?.url || '').trim()
      if (!url) {
        failures.push(`${result?.sourceName || source}: 未返回播放地址`)
        return null
      }
      const label = String(result?.sourceName || source)
      probes++
      const probe = await probeAudioCached(url)
      if (probe.ok) {
        return {
          url,
          sourceName: label,
          quality: String(result?.type || quality),
          contentType: probe.contentType || '',
          durationMs: probe.durationMs || 0,
        }
      }
      failures.push(`${label}: 地址不可播（${probe.detail}）`)

      // 把这个坏源排除掉再来一轮；拿不到标识或已经没有更多源就收手
      const marker = String(result?.sourceId || result?.sourceName || '').trim()
      if (!marker || exclude.includes(marker)) return null
      exclude.push(marker)
      if (result?.hasMoreSources === false) return null
    }
    return null
  }

  for (const quality of qualities) {
    const direct = await attempt(songInfo, quality)
    if (direct) return { ...direct, failures }

    // 同平台源全挂时，换到别的平台/别的曲库 ID 再试
    let matches: any[] = []
    try {
      matches = await findServerSourceMatches(songInfo, username)
    } catch {
      matches = []
    }
    for (const match of matches.slice(0, 3)) {
      const hit = await attempt(match, quality)
      if (hit) return { ...hit, failures }
    }
  }

  return { url: '', sourceName: '', quality: requestedQuality, contentType: '', durationMs: 0, failures }
}

/**
 * 等本地缓存出现（含等待播放器自己那一路下载完成）。
 * 超时返回 null，由调用方决定是否回落到远端中转。
 */
const waitForCachedFile = async (
  songInfo: Record<string, any>,
  quality: string,
  username: string,
  timeoutMs: number,
) => {
  const songKey = `${fileCache.normalizeSongId(songInfo)}_${quality}`
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    const cached = fileCache.checkCache({ ...songInfo, quality }, username)
    if (cached?.exists && cached.path) return cached
    const progress = fileCache.cacheProgress.get(songKey)
    if (!progress || progress.status === 'error') return null
    if (Date.now() >= deadline) return null
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}

interface XiaoAiTrackTarget {
  /** 本地文件绝对路径（命中缓存时使用，音箱直接读本机文件） */
  path?: string
  /** 远端音频地址（服务端中转） */
  url?: string
  filename: string
  cached: boolean
  /** 真实音频 Content-Type，用于纠正上游的 octet-stream 与 URL 后缀 */
  contentType?: string
  /** 解析来源，写进日志与接口返回，方便排查 */
  via: string
  /** 真实音频时长（毫秒）；前端自动续播用它算切歌时机，0 表示没解析出来 */
  durationMs?: number
  /** 要求中转统一转 mp3（源不是 mp3 时设置） */
  format?: 'mp3'
  /** 转码时的尾部淡出秒数 */
  fadeOutSec?: number
  /** 转码产物的预期落盘路径（中转 tee 到这里，第二次拉流直接命中） */
  mp3Path?: string
  /** 从第 N 秒开始投送（拖动进度条后重新投送用） */
  seekSec?: number
}

/** 扩展名 → Content-Type（本地缓存文件按真实格式命名过，可以直接推） */
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ape': 'audio/x-ape',
}

/**
 * 给一次「换源解析」套总预算。
 *
 * 换源内部虽然已有 deadline，但它只在每次调用「之前」检查，单次 callUserApiGetMusicUrl
 * 或探测挂住时不受约束；再叠加「首轮 + 重试」两趟，实测一首查无此歌的曲子能拖到 121 秒，
 * 前端表现就是「点了投送没反应」。这里加外层硬预算兜住最坏情况。
 */
const withResolveBudget = async <T>(p: Promise<T>, ms: number, fallback: T, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>(resolve => {
        timer = setTimeout(() => {
          console.warn(`[XiaoAi] ${label}超预算 ${Math.round(ms / 1000)}s，先按失败处理`)
          resolve(fallback)
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * `/api/music/url` 单次取链的总预算。
 *
 * callUserApiGetMusicUrl 内部会「按源轮换重试」，每个自定义源脚本自身还有 10~20 秒超时，
 * 一首真的查无此歌的曲子实测能把 30 多个源串行问完（45~90 秒）。前端等不到结果就会
 * 「换源 / 缓冲卡死 / 自动跳歌」反复重来，实测 7 分钟内打出 196 次取链（峰值 22 请求/秒）。
 * 这里套一层硬预算：到点按失败返回，让前端拿到明确结论而不是一直等。
 */
const MUSIC_URL_BUDGET_MS = (() => {
  const raw = Number(process.env.MUSIC_URL_BUDGET_MS)
  return Number.isFinite(raw) && raw >= 3000 ? Math.round(raw) : 9000
})()

/**
 * 首次请求（同一首歌 90 秒内没有失败过）用的宽预算。
 *
 * 9 秒总闸对「已经失败过一次、正在被狂重试」的歌是对的，但对首次点播太紧：
 * 自定义源是串行问的，排在前面的慢源（HYWmusic 这类单源就要 20 秒）可能把
 * 本来能播的歌误杀。所以首次给 25 秒，只有进入「失败重试态」才收紧到 9 秒。
 */
const MUSIC_URL_FIRST_BUDGET_MS = (() => {
  const raw = Number(process.env.MUSIC_URL_FIRST_BUDGET_MS)
  return Number.isFinite(raw) && raw >= 5000 ? Math.round(raw) : 25000
})()
/** 多久内算「同一首歌处于失败重试态」（用宽预算还是紧预算的判据） */
const MUSIC_URL_RETRY_WINDOW_MS = 90000

/**
 * 取链失败短缓存：同一首歌在 TTL 内再问，直接复用上一次的失败结论。
 *
 * 失败后前端往往立刻再问同一首（换源失败 → 自动重试），一次真实全网搜索要 9 秒，
 * 缓存 10 秒能把这种风暴从「每次都真搜」降到「一次查表」。成功不写缓存（地址有时效），
 * 失败结论也只记很短时间，避免音源真的恢复后还被挡住。
 */
const MUSIC_URL_FAIL_TTL_MS = (() => {
  const raw = Number(process.env.MUSIC_URL_FAIL_TTL_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : 10000
})()
const musicUrlFailures = new Map<string, { at: number; message: string; attempts: any[] }>()
/** key → 最近一次失败时刻：决定这一首用紧预算还是宽预算 */
const musicUrlRecentFails = new Map<string, number>()
/** 全站最近的取链失败时刻（熔断用：音源整体挂了就别再让每一首都死等 25 秒） */
const musicUrlFailStamps: number[] = []
const MUSIC_URL_STRESS_FAILS = 3
const MUSIC_URL_STRESS_WINDOW_MS = 60000

const isMusicUrlStressed = (): boolean => {
  const cutoff = Date.now() - MUSIC_URL_STRESS_WINDOW_MS
  while (musicUrlFailStamps.length && musicUrlFailStamps[0] < cutoff) musicUrlFailStamps.shift()
  return musicUrlFailStamps.length >= MUSIC_URL_STRESS_FAILS
}

/**
 * 这一首此刻该给多长的取链预算。
 * 单曲重试态（90 秒内失败过）或整体熔断态（1 分钟内失败 ≥3 次）都收紧到 9 秒；
 * 其余情况给 25 秒宽预算，避免把「只是排在慢源后面的好歌」误杀。
 */
const pickMusicUrlBudget = (key: string): number => {
  const last = musicUrlRecentFails.get(key) || 0
  const retrying = Date.now() - last < MUSIC_URL_RETRY_WINDOW_MS || isMusicUrlStressed()
  return retrying ? MUSIC_URL_BUDGET_MS : MUSIC_URL_FIRST_BUDGET_MS
}

// 远端流加密探测见 `utils/streamEncryption.ts`（server.ts 与 extraSources/soda.ts 共用）
const buildMusicUrlFailKey = (songInfo: any, quality: string, username: string): string => {
  const id = String(songInfo?.songmid || songInfo?.id || songInfo?.hash || songInfo?.name || '')
  // 必须带用户名：不同用户的可用音源/平台账号不一样，A 取不到不代表 B 取不到
  return `${username || ''}|${String(songInfo?.source || '')}|${id}|${quality || ''}`
}

const readMusicUrlFailure = (key: string) => {
  const hit = musicUrlFailures.get(key)
  if (!hit) return null
  const age = Date.now() - hit.at
  if (age >= MUSIC_URL_FAIL_TTL_MS) {
    musicUrlFailures.delete(key)
    return null
  }
  return { ...hit, retryAfterMs: MUSIC_URL_FAIL_TTL_MS - age }
}

const rememberMusicUrlFailure = (key: string, message: string, attempts: any[] = []) => {
  if (!MUSIC_URL_FAIL_TTL_MS) return
  // 只留最近的 200 条：长跑之后不让它变成内存泄漏
  if (musicUrlFailures.size >= 200) {
    const cutoff = Date.now() - MUSIC_URL_FAIL_TTL_MS
    for (const [k, v] of musicUrlFailures) if (v.at <= cutoff) musicUrlFailures.delete(k)
    if (musicUrlFailures.size >= 200) musicUrlFailures.clear()
  }
  musicUrlFailures.set(key, { at: Date.now(), message, attempts })
  musicUrlRecentFails.set(key, Date.now())
  musicUrlFailStamps.push(Date.now())
  if (musicUrlFailStamps.length > 20) musicUrlFailStamps.splice(0, musicUrlFailStamps.length - 20)
  // 这个表只用来判「是不是在重试态」，顺手限制一下规模
  if (musicUrlRecentFails.size > 500) {
    const cutoff = Date.now() - MUSIC_URL_RETRY_WINDOW_MS
    for (const [k, at] of musicUrlRecentFails) if (at <= cutoff) musicUrlRecentFails.delete(k)
    if (musicUrlRecentFails.size > 500) musicUrlRecentFails.clear()
  }
}

/**
 * 给一个 Promise 套硬预算：到点返回 null。
 * 同时给原 Promise 挂一个 catch —— 预算之后它才 reject 的话会变成
 * unhandledRejection，能直接把 Node 进程干掉。
 */
const withHardBudget = async <T>(p: Promise<T>, ms: number, label: string): Promise<T | null> => {
  p.catch(() => { /* 预算之后迟到的失败直接丢弃 */ })
  let timer: NodeJS.Timeout | undefined
  const raced = await Promise.race<T | null>([
    p,
    new Promise<null>(resolve => {
      timer = setTimeout(() => {
        console.warn(`[歌曲播放] ${label}超出 ${Math.round(ms / 1000)} 秒预算，按失败返回`)
        resolve(null)
      }, ms)
    }),
  ])
  if (timer) clearTimeout(timer)
  return raced
}

/**
 * 投送前确定音频来源，优先级：
 *   本地缓存 → 客户端直链 → 预解析地址（需探测） → 现解析（换源 + 探测）
 * 开了「先缓存再投送」且缓存未命中时，会先把整首下载到本地再投送。
 */
const resolveXiaoAiTrackRaw = async (
  req: IncomingMessage,
  songInfo: Record<string, any>,
  quality: string,
  verifiedUsername: string,
  directStreamUrl = '',
): Promise<XiaoAiTrackTarget> => {
  const songName = String(songInfo.name || songInfo.title || 'track')
  const singer = String(songInfo.singer || '')
  const filename = `${singer ? `${singer} - ` : ''}${songName}.mp3`.replace(/[\\/:*?"<>|]/g, '_')

  // 1. 本地缓存命中：音源死活都不影响，首字节几乎为零
  try {
    const cached = fileCache.checkCache({ ...songInfo, quality }, verifiedUsername)
    if (cached?.exists && cached.path) {
      console.log(`[XiaoAi] 命中本地缓存，直接投送：${filename}`)
      return {
        path: cached.path,
        filename,
        cached: true,
        contentType: AUDIO_MIME_BY_EXT[path.extname(cached.path).toLowerCase()],
        via: '本地缓存',
        durationMs: probeLocalFileDuration(cached.path),
      }
    }
  } catch {
    /* 缓存索引异常时继续走远端解析 */
  }

  const directUrl = String(directStreamUrl || '').trim()
  const rawSongUrl = String(songInfo.url || songInfo.streamUrl || songInfo.meta?.url || '').trim()
  const httpUrl = /^https?:\/\//i.test(directUrl) ? directUrl : /^https?:\/\//i.test(rawSongUrl) ? rawSongUrl : ''

  // 2. 已经是绝对可播放地址，直接用
  if (httpUrl) {
    // 直链不经音源解析，但「真实时长」还是要测一下：自动续播全靠它决定什么时候切歌。
    // 给一个很短的预算（不达标就当没有），投送本身不能被探测拖慢。
    const probe = await probeWithBudget(httpUrl)
    return {
      url: httpUrl,
      filename,
      cached: false,
      contentType: probe?.contentType || '',
      via: '客户端直链',
      durationMs: probe?.durationMs || 0,
    }
  }

  // 3. 站内相对地址：补全成绝对地址，并把播放器 token 带进查询串
  if (rawSongUrl) {
    const userToken = String(req.headers['x-user-token'] || '')
    const absolute = `${getRequestOrigin(req)}${rawSongUrl.startsWith('/') ? '' : '/'}${rawSongUrl}`
    const withToken = userToken && !absolute.includes('token=')
      ? `${absolute}${absolute.includes('?') ? '&' : '?'}token=${encodeURIComponent(userToken)}`
      : absolute
    const probe = await probeWithBudget(withToken)
    return {
      url: withToken,
      filename,
      cached: false,
      contentType: probe?.contentType || '',
      via: '站内地址',
      durationMs: probe?.durationMs || 0,
    }
  }

  // 4. 预解析缓存：自动续播切歌时走这条，省掉音源解析耗时；但地址可能已失效，要探测
  const cacheKey = buildTrackKey(songInfo, quality)
  const cachedTrack = getCachedTrack(cacheKey)
  if (cachedTrack.url) {
    const probe = await probeAudioCached(cachedTrack.url)
    if (probe.ok) {
      return {
        url: cachedTrack.url,
        filename,
        cached: true,
        contentType: probe.contentType,
        via: '预解析地址',
        durationMs: probe.durationMs || cachedTrack.durationMs,
      }
    }
    console.warn(`[XiaoAi] 预解析地址已失效，重新解析：${filename}（${probe.detail}）`)
  }

  if (!songInfo.source) throw new Error('缺少可投送的歌曲信息（需要 source 或可播放地址）')

  const existingDownload = !!fileCache.cacheProgress.get(
    `${fileCache.normalizeSongId(songInfo)}_${quality}`,
  )

  // 4.5 「播放即缓存」的落盘竞态：前端点播会同时触发 /cache/download，
  //     投送到这里的缓存检查往往比下载完成早 1 秒左右 → 缓存明明成功，
  //     推给音箱的却是别的平台换源版本。只有这首歌确实还在下载时才等
  //     （waitForCachedFile 没有下载任务会立即返回），最多 12 秒。
  if (existingDownload) {
    const arrived = await waitForCachedFile(songInfo, quality, verifiedUsername, 12000)
    if (arrived?.path) {
      console.log(`[XiaoAi] 等到本地缓存落盘，直接投送：${filename}`)
      return {
        path: arrived.path,
        filename,
        cached: true,
        contentType: AUDIO_MIME_BY_EXT[path.extname(arrived.path).toLowerCase()],
        via: '本地缓存（等待下载完成）',
        durationMs: probeLocalFileDuration(arrived.path),
      }
    }
    console.warn(`[XiaoAi] 缓存仍在下载中，先按换源投送：${filename}`)
  }

  // 5. 现解析：原源 → 换源 → 音质降级，每个候选都做音频探测
  //    两趟都套硬预算（首轮 15s + 重试 10s），最坏 25s 左右给结论，不再让用户干等两分钟。
  const emptyResolved: ResolvedPlayableAudio = {
    url: '',
    sourceName: '',
    quality,
    contentType: '',
    durationMs: 0,
    failures: ['解析超时'],
  }
  let resolved = await withResolveBudget(
    resolvePlayableAudio(songInfo, quality, verifiedUsername),
    15000,
    emptyResolved,
    '首轮换源',
  )
  // 偶发音源抖动（kg 平台尤甚）：首轮全失败时再给一次机会，避免无谓的 400 投送失败
  if (!resolved.url) {
    await new Promise(r => setTimeout(r, 500))
    const retried = await withResolveBudget(
      resolvePlayableAudio(songInfo, quality, verifiedUsername),
      10000,
      { ...emptyResolved, failures: ['重试解析超时'] },
      '重试换源',
    )
    if (retried.url) {
      console.log(`[XiaoAi] 音源首轮失败，重试解析成功：${filename}`)
      resolved = retried
    } else {
      // 两轮都失败：把重试的失败原因并进来，日志里能看到完整线索
      resolved = { ...resolved, failures: [...resolved.failures, ...retried.failures].slice(0, 6) }
    }
  }
  if (!resolved.url) {
    const detail = resolved.failures.slice(0, 3).join('；') || '没有可用音源'
    console.warn(`[XiaoAi] 音源全部不可播：${filename} → ${detail}`)
    throw new Error(`没有可用音源（已自动换源）：${detail}`)
  }
  console.log(`[XiaoAi] 音源可用：${filename} ← ${resolved.sourceName} (${resolved.quality})`)

  // 6. 先缓存再投送：整首落盘后推本地文件，彻底避开音箱拉流超时与中途断流
  //    默认关闭（cacheBeforePlay=false），即音箱直接按远端地址拉流；需要时可在页面打开。
  const config = loadXiaoAiConfig()
  if (config.cacheBeforePlay) {
    const effectiveQuality = resolved.quality || quality
    // 播放器自己在播这首歌时也会触发缓存下载；两边同时下会抢同一个 .tmp 文件，
    // 所以先等它下完，只有确实没人下才自己发起。
    const cached = await waitForCachedFile(songInfo, effectiveQuality, verifiedUsername, existingDownload ? 30000 : 0)
    if (cached) {
      console.log(`[XiaoAi] 先缓存后投送：${filename}`)
      setCachedTrackUrl(cacheKey, resolved.url, resolved.durationMs)
      return {
        path: cached.path,
        filename,
        cached: true,
        contentType: AUDIO_MIME_BY_EXT[path.extname(cached.path).toLowerCase()],
        via: `先缓存后投送（${resolved.sourceName}）`,
        durationMs: probeLocalFileDuration(cached.path) || resolved.durationMs,
      }
    }
    try {
      await Promise.race([
        fileCache.downloadAndCache(songInfo, resolved.url, effectiveQuality, verifiedUsername),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('缓存超时 60s')), 60000)),
      ])
    } catch (error: any) {
      console.warn(`[XiaoAi] 预缓存失败，回落到远端中转：${error?.message || error}`)
    }
    const afterDownload = await waitForCachedFile(songInfo, effectiveQuality, verifiedUsername, 15000)
    if (afterDownload) {
      console.log(`[XiaoAi] 先缓存后投送：${filename}`)
      setCachedTrackUrl(cacheKey, resolved.url, resolved.durationMs)
      return {
        path: afterDownload.path,
        filename,
        cached: true,
        contentType: AUDIO_MIME_BY_EXT[path.extname(afterDownload.path).toLowerCase()],
        via: `先缓存后投送（${resolved.sourceName}）`,
        durationMs: probeLocalFileDuration(afterDownload.path) || resolved.durationMs,
      }
    }
    console.warn(`[XiaoAi] 预缓存未命中，回落到远端中转：${filename}`)
  }

  setCachedTrackUrl(cacheKey, resolved.url, resolved.durationMs)
  return {
    url: resolved.url,
    filename,
    cached: false,
    contentType: resolved.contentType,
    via: `音源 ${resolved.sourceName}`,
    durationMs: resolved.durationMs,
  }
}

/**
 * 统一 mp3：在原始解析结果上再套一层格式归一。
 *
 *  - 源是本地文件且不是 mp3 → 转码落到 `cache/<用户>/xiaoai/<key>.mp3`（进缓存体系、受限额管）
 *  - 源是远端地址 → 给流 token 打上 format=mp3，中转时边转边发并把产物 tee 到磁盘
 *  - 已是 mp3 或 ffmpeg 不可用 → 原样返回（只降级格式，不影响能播）
 *
 * 尾部淡出只在「真的需要转码」时生效：对已是 mp3 的源强制重编码会二次损失音质，
 * 这里宁可不淡出。
 */
const applyMp3Unification = async (
  target: XiaoAiTrackTarget,
  songInfo: Record<string, any>,
  quality: string,
  username: string,
): Promise<XiaoAiTrackTarget> => {
  const config = loadXiaoAiConfig()
  if (config.unifyMp3 === false) return target
  const fadeOutSec = Number(config.fadeOutSec) || 0

  if (target.path) {
    if (isMp3File(target.path)) return target
    const dest = mp3CachePath(username, songInfo, quality)
    const result = await transcodeFileToMp3(target.path, dest, {
      fadeOutSec,
      durationMs: Number(target.durationMs) || 0,
    })
    if (!result.ok || !result.path) {
      console.warn(
        `[XiaoAi] 统一 mp3 失败，按原格式投送：${target.filename}（${result.error || '未知原因'}）`,
      )
      return target
    }
    return {
      ...target,
      path: result.path,
      contentType: 'audio/mpeg',
      via: `${target.via}｜转 mp3`,
      durationMs: target.durationMs || probeLocalFileDuration(result.path),
    }
  }

  if (target.url) {
    // 源本身就是 mp3：不必转码（省 CPU，也避免 320k 再编码带来的音质损失）。
    // 判据用探测到的 Content-Type 与 URL 后缀，任一命中即视为 mp3 直投。
    const mime = String(target.contentType || '').toLowerCase()
    const looksMp3 =
      mime.includes('audio/mpeg') || mime.includes('audio/mp3') || /\.mp3(\?|#|$)/i.test(target.url)
    if (looksMp3) return { ...target, contentType: 'audio/mpeg' }
    if (!(await isFfmpegAvailable())) return target
    return {
      ...target,
      format: 'mp3',
      fadeOutSec,
      mp3Path: mp3CachePath(username, songInfo, quality),
    }
  }
  return target
}

/**
 * 小爱音箱不兼容无损封装：flac/ape/wav 在部分固件上「能拉流但不出声」，且部分曲库会把无损曲
 * 判成 VIP 版权闸门（unplayableCode=2）直接不拉流。所以无论用户选什么音质，投送一律降为最高有损
 * 320k，再走 unifyMp3 统一转 mp3。
 */
const LOSSLESS_QUALITIES = new Set([
  'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master', 'ape', 'wav',
])

/**
 * 投送前确定音频来源（对外入口），在原始解析结果上再叠加 mp3 统一。
 */
const resolveXiaoAiTrack = async (
  req: IncomingMessage,
  songInfo: Record<string, any>,
  quality: string,
  verifiedUsername: string,
  directStreamUrl = '',
): Promise<XiaoAiTrackTarget> => {
  // 无损音质对小爱无意义：直接降为 320k，避免「投出去不响 / 被版权闸门拦掉」
  if (LOSSLESS_QUALITIES.has(quality)) {
    console.log(`[XiaoAi] 无损音质 ${quality} 对小爱无意义，统一降为 320k 转码投送`)
    syncLog.info(`[XiaoAi] 无损音质 ${quality} 对小爱无意义，统一降为 320k 转码投送`)
    quality = '320k'
  }

  const target = await resolveXiaoAiTrackRaw(req, songInfo, quality, verifiedUsername, directStreamUrl)
  try {
    return await applyMp3Unification(target, songInfo, quality, verifiedUsername)
  } catch (error: any) {
    console.warn(`[XiaoAi] mp3 统一异常，按原格式投送：${error?.message || error}`)
    return target
  }
}

// 定时关机到点时统一停掉当前选中的全部设备（只做停止播放，不承诺断电）
sleepTimer.setStopHandler(() => xiaoAiService.stop())

// 播放自检用：本次投送之后音箱是否真的来拉过我们这一路流。
// 曲库把某些 audioID 标成「试听资源」，但音箱只要拉了本机流就是在放我们推的音频，
// 不能仅凭元数据就告警「正在播试听片段」把用户引去关歌词开关。
xiaoAiService.setStreamPulledProbe(() => lastXiaoAiStreamAt > lastXiaoAiPushAt)

/** 小爱相关接口的鉴权：管理员口令，或已通过认证的播放器会话 */
const isXiaoAiRequestAuthorized = (req: IncomingMessage): boolean => {
  const auth = req.headers['x-frontend-auth']
  if (auth && auth === global.lx.config['admin.password']) return true
  return checkPlayerAuth(req)
}

/** 定期清理过期 Session（每小时） */
setInterval(() => {
  const now = Date.now()
  for (const [id, session] of playerSessions) {
    if (now - session.createdAt > SESSION_TTL) playerSessions.delete(id)
  }
}, 60 * 60 * 1000)
// ===== End Player Session Store =====

// ===== User Session Token Store =====
interface UserToken {
  token: string
  name: string
  createdAt: number
  expiresAt: number | null
  lastUsed?: number
  disabled?: boolean
}

interface UserTokenConfig {
  enabled: boolean
  tokens: UserToken[]
}

/** 用户 Token 存储：token → { username, createdAt } */
const userSessions = new Map<string, { username: string; createdAt: number }>()
const USER_SESSION_TTL = 7 * 24 * 60 * 60 * 1000 // 7天

/**
 * 会话落盘（防抖 800ms）。
 * 以前这里是纯内存 Map，进程/容器一重启就全部失效，而前端手上的旧 token 不会自动换新，
 * 结果所有鉴权接口 401：缓存查不到、缓存文件加载失败、取链失败 → 前端一路「智能换源」自动跳歌。
 * 现在落盘到 data/sessions.json，重启后原 token 继续有效。
 */
let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null
const scheduleSessionSave = () => {
  if (sessionSaveTimer) return
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null
    persistSessions(userSessions)
  }, 800)
  sessionSaveTimer.unref?.()
}
const addUserSession = (token: string, username: string) => {
  userSessions.set(token, { username, createdAt: Date.now() })
  scheduleSessionSave()
}
const removeUserSession = (token: string) => {
  if (userSessions.delete(token)) scheduleSessionSave()
}

/** 持久化 Token 快速查找缓存：token → username */
const persistentTokens = new Map<string, string>()

/** 持久化 Token 元数据缓存：token → token 对象（含 disabled/expiresAt/lastUsed）*/
const persistentTokenMeta = new Map<string, { name: string; token: string; disabled?: boolean; expiresAt?: number; lastUsed?: number }>()

/** lastUsed 防抖写盘队列：username → debounce timer */
const persistentTokenSaveQueue = new Map<string, ReturnType<typeof setTimeout>>()

/** 触发防抖写盘，10s 内的高频更新只写一次 */
const scheduleSaveTokenConfig = (username: string) => {
  if (persistentTokenSaveQueue.has(username)) clearTimeout(persistentTokenSaveQueue.get(username)!)
  const timer = setTimeout(() => {
    persistentTokenSaveQueue.delete(username)
    // 从内存重建完整 config 并写盘
    const tokens: any[] = []
    for (const [, meta] of persistentTokenMeta) {
      if (persistentTokens.get(meta.token) === username) {
        tokens.push({ ...meta })
      }
    }
    // 同时保留已过期/禁用的 token（从文件读取合并）
    const existing = getUserTokenConfig(username)
    const existingNonActive = existing.tokens.filter(t => !persistentTokenMeta.has(t.token))
    const merged = [...existingNonActive, ...tokens]
    const config = { ...existing, tokens: merged }
    const userDirname = getUserDirname(username)
    const userPath = path.join(global.lx.userPath, userDirname)
    const tokenPath = path.join(userPath, File.userTokensJSON)
    if (!fs.existsSync(userPath)) fs.mkdirSync(userPath, { recursive: true })
    fs.writeFile(tokenPath, JSON.stringify(config, null, 2), 'utf8', (err) => {
      if (err) console.error('[凭证管理] 写盘失败:', err)
    })
  }, 10_000)
  persistentTokenSaveQueue.set(username, timer)
}

const getUserTokenConfig = (username: string): UserTokenConfig => {
  const userDirname = getUserDirname(username)
  const userPath = path.join(global.lx.userPath, userDirname)
  const tokenPath = path.join(userPath, File.userTokensJSON)

  if (fs.existsSync(tokenPath)) {
    try {
      return JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
    } catch (e) {
      return { enabled: false, tokens: [] }
    }
  }
  return { enabled: false, tokens: [] }
}

const saveUserTokenConfig = (username: string, config: UserTokenConfig) => {
  const userDirname = getUserDirname(username)
  const userPath = path.join(global.lx.userPath, userDirname)
  const tokenPath = path.join(userPath, File.userTokensJSON)
  if (!fs.existsSync(userPath)) fs.mkdirSync(userPath, { recursive: true })
  fs.writeFileSync(tokenPath, JSON.stringify(config, null, 2), 'utf8')

  // 更新内存缓存（清理该用户旧条目）
  for (const [tk, name] of persistentTokens.entries()) {
    if (name === username) {
      persistentTokens.delete(tk)
      persistentTokenMeta.delete(tk)
    }
  }
  // 写入新的有效 token
  if (config.enabled) {
    for (const t of config.tokens) {
      if (!t.expiresAt || t.expiresAt > Date.now()) {
        persistentTokens.set(t.token, username)
        persistentTokenMeta.set(t.token, {
          name: t.name,
          token: t.token,
          disabled: t.disabled ?? false,
          expiresAt: t.expiresAt ?? undefined,
          lastUsed: t.lastUsed,
        })
      }
    }
  }
}

// 初始化加载所有用户的持久化 Token
setTimeout(() => {
  if (global.lx.config && global.lx.config.users) {
    global.lx.config.users.forEach((u: any) => saveUserTokenConfig(u.name, getUserTokenConfig(u.name)))
  }
}, 5000)

/**
 * 验证请求中的用户 Token（x-user-token header）。
 * 1. 优先验证内存 Session Token（网页登陆产生）
 * 2. 其次验证持久化 API Token（管理面板产生，需开启账户 Token 功能）
 * 返回已验证的用户名，或 null 表示未认证。
 */
export const verifyUserAuth = (req: IncomingMessage): string | null => {
  const token = req.headers['x-user-token'] as string
  if (token) {
    // 1. Session Token 验证
    const session = userSessions.get(token)
    if (session && Date.now() - session.createdAt <= USER_SESSION_TTL) {
      return session.username
    }

    // 2. 持久化 API Token 验证（全程走内存，不读磁盘）
    const persistentUsername = persistentTokens.get(token)
    if (persistentUsername) {
      const meta = persistentTokenMeta.get(token)
      if (meta) {
        // 检查是否被禁用
        if (meta.disabled) {
          tokenLog.warn(`User ${persistentUsername} attempted to use DISABLED token: ${meta.name}`)
          return null
        }
        // 检查有效期
        if (!meta.expiresAt || meta.expiresAt > Date.now()) {
          // 仅更新内存中的 lastUsed，通过防抖延迟批量写盘
          meta.lastUsed = Date.now()
          scheduleSaveTokenConfig(persistentUsername)

          // 记录 Token 日志
          const ip = getIP(req)
          const masked = `${meta.token.slice(0, 6)}...${meta.token.slice(-4)}`
          tokenLog.info(`API Token [${meta.name}] (${masked}) used by ${persistentUsername} from ${ip} to access ${req.url}`)

          return persistentUsername
        } else {
          // 已过期，从内存缓存移除
          persistentTokens.delete(token)
          persistentTokenMeta.delete(token)
        }
      }
    }

    return null // Token 存在但无效/过期
  }

  // 后端所有用户名密码明文校验逻辑
  /*
  const username = req.headers['x-user-name'] as string
  const password = req.headers['x-user-password'] as string
  if (username && password) {
    const user = global.lx.config.users.find((u: any) => u.name === username && u.password === password)
    if (user) return username
  }
  */

  return null
}

// 把校验能力交给需要它的模块（customSourceHandlers 等），
// 避免它们反向 import 本文件形成循环依赖
setUserAuthVerifier(verifyUserAuth)

const getCacheRequestUsername = (req: IncomingMessage): string | null => {
  const requested = (req.headers['x-user-name'] as string) || ''
  if (!requested || requested === 'default' || requested === 'open' || requested === '_open') return '_open'
  return verifyUserAuth(req)
}

/** 最近一次全量体检结果（dry-run），供 /api/music/cache/audit 复用，避免每次刷新都重新解码 */
let lastCacheAudit: { at: number; report: any } | null = null
/** 同一时间只跑一个体检：全量体检要逐条解码文件，并发会把 IO 打满 */
let cacheAuditRunning = false

/**
 * 启动后台体检（dry-run，只出清单不删文件）。
 *
 * 1.5.27 之前写入的缓存没有来源核验标记，里面可能混着「音源对失效 ID 兜底返回的别曲」——
 * 现场样本是一条 3:53 / 320kbps 的完整歌，时长和码率都正常，本地两条判据同时失效。
 * 只有回查音源自己登记的曲目信息才能识别，所以这里在启动后跑一次并写日志。
 * 删除动作不在启动流程里做：误删用户缓存不可逆，必须由人通过 POST confirm 触发。
 */
const scheduleCacheAuditOnStartup = () => {
  if ((global.lx?.config as any)?.['cache.originAuditOnStart'] === false) return
  const timer = setTimeout(() => {
    void (async () => {
      if (cacheAuditRunning) return
      cacheAuditRunning = true
      try {
        const report = await fileCache.auditCache({ username: '_open', apply: false, intervalMs: 200 })
        lastCacheAudit = { at: Date.now(), report }
        syncLog.info(
          `[文件缓存] 启动体检完成：共 ${report.total} 条，干净 ${report.clean}，可疑 ${report.dirty}，无法判定 ${report.unverified}，本地来源跳过 ${report.skipped}`,
        )
        for (const item of report.items.filter(entry => entry.verdict === 'dirty').slice(0, 20)) {
          syncLog.warn(`[文件缓存] 启动体检发现可疑缓存 (${item.filename})：${item.reason}`)
        }
      } catch (error: any) {
        syncLog.warn(`[文件缓存] 启动体检失败（不影响服务）：${error?.message || error}`)
      } finally {
        cacheAuditRunning = false
      }
    })()
  }, 120000)
  // 不要因为这个定时器拖住进程退出
  timer.unref?.()
}

/** 定期清理过期用户 Token（每小时） */
setInterval(() => {
  const now = Date.now()
  // 清理内存 Session
  let expiredSessionCount = 0
  for (const [token, session] of userSessions) {
    if (now - session.createdAt > USER_SESSION_TTL) {
      userSessions.delete(token)
      expiredSessionCount++
    }
  }
  if (expiredSessionCount > 0) scheduleSessionSave()
  // 清理加载到内存的过期 API Token（直接走内存 meta，不读磁盘）
  for (const [token, meta] of persistentTokenMeta) {
    if (meta.expiresAt && meta.expiresAt <= now) {
      persistentTokens.delete(token)
      persistentTokenMeta.delete(token)
    }
  }
}, 60 * 60 * 1000)
// ===== End User Session Token Store =====


const getMime = (filename: string) => {
  const ext = path.extname(filename).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.html': 'text/html',
    '.css': 'text/css',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

/**
 * 规范化歌曲信息，确保收藏列表中的 meta 属性在根节点也可用
 * 解决 SDK 无法识别收藏歌曲音质的问题
 */
const normalizeSongInfo = (songInfo: any) => {
  if (!songInfo) return songInfo
  const meta = songInfo.meta || {}

  // 1. 处理音质信息 (types / _types)
  if (!songInfo.types && meta) {
    songInfo.types = meta.qualitys || meta.types
  }
  if (!songInfo._types && meta) {
    songInfo._types = meta._qualitys || meta._types
  }

  // 2. 处理基础字段备用根节点映射
  if (!songInfo.albumName && meta.albumName) songInfo.albumName = meta.albumName
  if (!songInfo.albumId && meta.albumId) songInfo.albumId = meta.albumId
  if (!songInfo.img && meta.picUrl) songInfo.img = meta.picUrl
  if (!songInfo.name && meta.name) songInfo.name = meta.name
  if (!songInfo.singer && meta.singer) songInfo.singer = meta.singer
  if (!songInfo.source && meta.source) songInfo.source = meta.source
  if (!songInfo.interval && meta.interval) songInfo.interval = meta.interval

  // 3. 处理通用 ID 转换 (id -> songmid)
  if (!songInfo.songmid) {
    if (meta.songId) {
      songInfo.songmid = meta.songId
    } else if (songInfo.id) {
      const sourcePrefix = `${songInfo.source}_`
      if (typeof songInfo.id === 'string' && songInfo.id.startsWith(sourcePrefix)) {
        songInfo.songmid = songInfo.id.slice(sourcePrefix.length)
      } else {
        songInfo.songmid = songInfo.id
      }
    }
  }

  // 4. 针对各平台 SDK 所需的特定字段进行补全
  switch (songInfo.source) {
    case 'wy': // 网易
      if (!songInfo.id && meta.songId) songInfo.id = Number(meta.songId)
      if (!songInfo.songmid && songInfo.id) songInfo.songmid = String(songInfo.id)
      break

    case 'kg': // 酷狗
      if (!songInfo.hash && meta.hash) songInfo.hash = meta.hash
      // 兼容某些 SDK 可能需要的 songmid 格式 (数字_哈希 或 仅哈Hash)
      break

    case 'tx': // 腾讯
      if (!songInfo.strMediaMid && meta.strMediaMid) songInfo.strMediaMid = meta.strMediaMid
      if (!songInfo.albumMid && meta.albumMid) songInfo.albumMid = meta.albumMid
      // 只有当 meta 中的 songId 是纯数字时才回填至 root.songId，否则保持 undefined 触发 SDK 自动获取
      const metaSongId = String(meta.songId || '')
      if (/^\d+$/.test(metaSongId)) {
        songInfo.songId = metaSongId
      }
      break

    case 'mg': // 咪咕
      if (!songInfo.copyrightId && meta.copyrightId) songInfo.copyrightId = meta.copyrightId
      if (!songInfo.lrcUrl && meta.lrcUrl) songInfo.lrcUrl = meta.lrcUrl
      if (!songInfo.songId) songInfo.songId = songInfo.songmid
      break

    case 'kw': // 酷我
      // 已在步骤 3 中通用处理
      break
  }

  return songInfo
}

let status: LX.Sync.Status = {
  status: false,
  message: '',
  address: [],
  // code: '',
  devices: [],
}

let host = 'http://localhost'
const sseClients = new Set<http.ServerResponse>()
// 音乐解析进度 SSE 专属通道: requestId -> response
const musicProgressClients = new Map<string, http.ServerResponse>()

// const codeTools: {
//   timeout: NodeJS.Timer | null
//   start: () => void
//   stop: () => void
// } = {
//   timeout: null,
//   start() {
//     this.stop()
//     this.timeout = setInterval(() => {
//       void generateCode()
//     }, 60 * 3 * 1000)
//   },
//   stop() {
//     if (!this.timeout) return
//     clearInterval(this.timeout)
//     this.timeout = null
//   },
// }

const checkDuplicateClient = (newSocket: LX.Socket) => {
  for (const client of [...wss!.clients]) {
    if (client === newSocket || client.keyInfo.clientId != newSocket.keyInfo.clientId) continue
    syncLog.info('duplicate client', client.userInfo.name, client.keyInfo.deviceName)
    client.isReady = false
    for (const name of Object.keys(client.moduleReadys) as Array<keyof LX.Socket['moduleReadys']>) {
      client.moduleReadys[name] = false
    }
    client.close(SYNC_CLOSE_CODE.normal)
  }
}

const handleConnection = async (socket: LX.Socket, request: IncomingMessage) => {
  const queryData = new URL(request.url as string, host).searchParams
  const clientId = queryData.get('i')

  //   // if (typeof socket.handshake.query.i != 'string') return socket.disconnect(true)
  const userName = getUserName(clientId)
  if (!userName) {
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  const userSpace = getUserSpace(userName)
  const keyInfo = userSpace.dataManage.getClientKeyInfo(clientId)
  if (!keyInfo) {
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  const user = global.lx.config.users.find(u => u.name == userName)
  if (!user) {
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  keyInfo.lastConnectDate = Date.now()
  userSpace.dataManage.saveClientKeyInfo(keyInfo)
  //   // socket.lx_keyInfo = keyInfo
  socket.keyInfo = keyInfo
  socket.userInfo = user

  checkDuplicateClient(socket)

  try {
    await sync(socket)
  } catch (err) {
    // console.log(err)
    syncLog.warn(err)
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  status.devices.push(keyInfo)
  // handleConnection(io, socket)
  sendStatus(status)
  socket.onClose(() => {
    status.devices.splice(status.devices.findIndex(k => k.clientId == keyInfo.clientId), 1)
    sendStatus(status)
  })

  // console.log('connection', keyInfo.deviceName)
  accessLog.info('connection', user.name, keyInfo.deviceName)
  // console.log(socket.handshake.query)

  socket.isReady = true
}

const handleUnconnection = (userName: string) => {
  // console.log('unconnection')
  releaseUserSpace(userName)
}

const authConnection = (req: http.IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void) => {
  // console.log(req.headers)
  // // console.log(req.auth)
  // console.log(req._query.authCode)
  authConnect(req).then(() => {
    callback(null, true)
  }).catch(err => {
    // console.log('WebSocket auth failed:', err.message)
    callback(null, false) // <--- 修改为传递 null, false
  })
}

let wss: LX.SocketServer | null

function noop() { }
function onSocketError(err: Error) {
  console.error(err)
}

const saveUsers = () => {
  const usersJsonPath = path.join(global.lx.dataPath, 'users.json')
  try {
    fs.writeFileSync(usersJsonPath, JSON.stringify(global.lx.config.users.map(u => ({
      name: u.name,
      password: u.password,
      maxSnapshotNum: u.maxSnapshotNum,
      'list.addMusicLocationType': u['list.addMusicLocationType'],
      enableCustomMusicDir: u.enableCustomMusicDir,
      customMusicDir: u.customMusicDir,
      allowOperateCustomMusicDir: u.allowOperateCustomMusicDir,
      allowWriteCustomMusicDir: u.allowWriteCustomMusicDir,
      enableAutoDownload: u.enableAutoDownload,
    })), null, 2))
    if (typeof global.lx.saveConfig === 'function') {
      global.lx.saveConfig()
    }
    return true
  } catch (err) {
    console.error('[用户管理] 保存 users.json 失败:', err)
    return false
  }
}

/** [新增] 服务器内部热重载数据 */
const reloadServerData = async () => {
  startupLog.info('Hot-reloading server data (users and config)...')

  // 1. 重新加载配置文件 (必须先加载基础配置)
  const configPath = global.lx.configPath || process.env.CONFIG_PATH || path.join(global.lx.dataPath, 'config.js')
  if (fs.existsSync(configPath)) {
    try {
      delete require.cache[require.resolve(configPath)]
      const rootConfig = require(configPath)

      // 合并除 users 以外的配置项
      for (const key of Object.keys(rootConfig)) {
        if (key !== 'users') {
          (global.lx.config as any)[key] = rootConfig[key]
        }
      }

      // 如果有 WebDAV 同步实例，手动同步其配置
      if (global.lx.webdavSync) {
        global.lx.webdavSync.updateConfig({
          url: global.lx.config['webdav.url'],
          username: global.lx.config['webdav.username'],
          password: global.lx.config['webdav.password'],
          syncPath: global.lx.config['webdav.syncPath'],
          backupPath: global.lx.config['webdav.backupPath'],
          interval: global.lx.config['sync.interval'],
          backupInterval: global.lx.config['sync.backupInterval'],
        })
      }
      // 刷新缓存位置映射，使 _open 等未自定义位置的用户回退到最新的全局 serverCacheLocation
      fileCache.invalidateUserCacheLocations()
      startupLog.info(`Config re-loaded and merged from ${configPath}.`)
    } catch (err: any) {
      startupLog.error('Failed to reload config file:', err.message)
    }
  }

  // 2. 重新加载 users.json (users.json 权重更高，会覆盖 config.js 中的 users)
  const usersJsonPath = path.join(global.lx.dataPath, 'users.json')
  if (fs.existsSync(usersJsonPath)) {
    try {
      const usersRaw = fs.readFileSync(usersJsonPath, 'utf-8')
      const users = JSON.parse(usersRaw)
      if (Array.isArray(users)) {
        global.lx.config.users = users.map(u => ({
          ...u,
          dataPath: path.join(global.lx.userPath, getUserDirname(u.name))
        }))

        // 确保新加载的所有用户目录存在
        for (const user of global.lx.config.users) {
          if (!fs.existsSync(user.dataPath)) {
            fs.mkdirSync(user.dataPath, { recursive: true })
          }
        }
        startupLog.info(`Reloaded ${global.lx.config.users.length} users from users.json`)
      }
    } catch (err: any) {
      startupLog.error('Failed to reload users.json:', err.message)
    }
  }

  // 3. 重新初始化 User APIs (解决脚本源实时生效问题)
  try {
    await initUserApis()
    startupLog.info('User APIs re-initialized.')
  } catch (err: any) {
    startupLog.error('Failed to re-init user APIs:', err.message)
  }

  return true
}

const checkAndCreateDir = (p: string) => {
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true })
    }
  } catch (e: any) {
    if (e.code !== 'EEXIST') {
      console.error(`[系统] 创建目录失败 (${p}):`, e.message)
    }
  }
}

const readBody = async (req: IncomingMessage) => await new Promise<string>((resolve, reject) => {
  const chunks: any[] = []
  req.on('data', chunk => { chunks.push(chunk) })
  req.on('end', () => {
    resolve(Buffer.concat(chunks).toString('utf-8'))
  })
  req.on('error', reject)
})

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, index)).toFixed(2)} ${units[index]}`
}

const getHeaderValue = (headers: Record<string, any>, key: string): string | undefined => {
  const value = headers[key] ?? headers[key.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value == null ? undefined : String(value)
}

const parseContentLength = (headers: Record<string, any>): number | null => {
  const range = getHeaderValue(headers, 'content-range')
  const total = range?.match(/\/(\d+)$/)?.[1]
  if (total) {
    const parsed = Number(total)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }

  const length = Number(getHeaderValue(headers, 'content-length'))
  if (Number.isFinite(length) && length > 0) return length

  return null
}

const getAudioRemoteSize = async (audioUrl: string): Promise<number | null> => {
  if (!/^https?:\/\//i.test(audioUrl)) return null

  const urlObj = new URL(audioUrl)
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': urlObj.origin,
  }
  const options = {
    follow_max: 5,
    response_timeout: 8000,
    read_timeout: 8000,
    headers,
    // 音质探测抓的是音乐平台的音频地址，归 music 分类
    agent: await getProxyAgent(audioUrl, 'music'),
  }

  try {
    const resp = await needle('head', audioUrl, null, options)
    const size = parseContentLength(resp.headers || {})
    if (size) return size
  } catch (e: any) {
    console.warn(`[音质探测] HEAD 请求探测文件大小失败: ${e.message}`)
  }

  try {
    const resp = await needle('get', audioUrl, null, {
      ...options,
      headers: {
        ...headers,
        Range: 'bytes=0-0',
      },
    })
    return parseContentLength(resp.headers || {})
  } catch (e: any) {
    console.warn(`[音质探测] Range 分段探测文件大小失败: ${e.message}`)
  }

  return null
}

const AUTO_SOURCE_ORDER = ['wy', 'tx', 'kw', 'kg', 'mg']
const SOURCE_MATCH_CACHE_TTL = 60_000
const sourceMatchCache = new Map<string, { expiresAt: number, promise: Promise<any[]> }>()

const normalizeSongMatchText = (value: unknown) => String(value || '')
  .toLowerCase()
  .replace(/[（(\[].*?[）)\]]/g, '')
  .replace(/[\s\p{P}\p{S}]/gu, '')

const normalizeSongNameText = (value: unknown) => String(value || '')
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]/gu, '')

const splitSingerNames = (value: unknown) => String(value || '')
  .toLowerCase()
  .split(/[、，,&；;|/+]/)
  .map(normalizeSongMatchText)
  .filter(Boolean)

const isSingerMatch = (candidateSinger: unknown, targetSinger: unknown) => {
  const candidateText = normalizeSongMatchText(candidateSinger)
  const targetText = normalizeSongMatchText(targetSinger)
  if (!targetText) return true
  if (!candidateText) return false
  if (candidateText.includes(targetText) || targetText.includes(candidateText)) return true

  const candidateParts = splitSingerNames(candidateSinger)
  const targetParts = splitSingerNames(targetSinger)
  return candidateParts.some(candidatePart => targetParts.some(targetPart => (
    candidatePart.includes(targetPart) || targetPart.includes(candidatePart)
  )))
}

const getSongDurationSeconds = (value: unknown) => {
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
  if (parts.some(part => !Number.isFinite(part))) return 0
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1])
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
  return 0
}

const getSongMatchScore = (candidate: any, target: any) => {
  const candidateName = normalizeSongNameText(candidate?.name)
  const targetName = normalizeSongNameText(target?.name)
  if (!candidateName || !targetName) return -1
  if (!candidateName.includes(targetName) && !targetName.includes(candidateName)) return -1
  if (!isSingerMatch(candidate?.singer, target?.singer)) return -1

  const candidateDuration = getSongDurationSeconds(candidate?.interval)
  const targetDuration = getSongDurationSeconds(target?.interval)
  let durationScore = 0
  if (candidateDuration > 0 && targetDuration > 0) {
    const durationDiff = Math.abs(candidateDuration - targetDuration)
    if (durationDiff > 8) return -1
    durationScore = 8 - durationDiff
  }

  const nameScore = candidateName === targetName ? 20 : 10
  const candidateAlbum = normalizeSongMatchText(candidate?.albumName)
  const targetAlbum = normalizeSongMatchText(target?.albumName)
  const albumScore = candidateAlbum && targetAlbum && candidateAlbum === targetAlbum ? 3 : 0
  return nameScore + durationScore + albumScore
}

const findServerSourceMatches = async (songInfo: any, username: string) => {
  if (!songInfo?.name || !songInfo?.singer) return []

  const cacheKey = [
    username,
    songInfo.source,
    normalizeSongMatchText(songInfo.name),
    normalizeSongMatchText(songInfo.singer),
    getSongDurationSeconds(songInfo.interval),
  ].join(':')
  const now = Date.now()
  const cached = sourceMatchCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.promise

  for (const [key, value] of sourceMatchCache) {
    if (value.expiresAt <= now) sourceMatchCache.delete(key)
  }

  const searchSources = AUTO_SOURCE_ORDER.filter(source => (
    source !== songInfo.source && isSourceSupported(source, username) && musicSdk[source]?.musicSearch?.search
  ))
  const query = `${songInfo.name} ${songInfo.singer}`
  const promise = Promise.all(searchSources.map(async source => {
    try {
      const searchData = await musicSdk[source].musicSearch.search(query, 1, 20)
      const list = Array.isArray(searchData?.list) ? searchData.list : []
      return list.map((item: any) => ({ ...item, source }))
    } catch (err: any) {
      console.warn(`[自动换源] 搜索 ${source} 失败: ${err?.message || err}`)
      return []
    }
  })).then(resultGroups => resultGroups.flat()
    .map(candidate => ({ candidate, score: getSongMatchScore(candidate, songInfo) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.candidate))

  sourceMatchCache.set(cacheKey, { expiresAt: now + SOURCE_MATCH_CACHE_TTL, promise })
  return promise
}

interface ServerSongResolveResult {
  url: string
  quality: string
  songInfo: any
  requestedSource?: string
  downloadSource?: string
  sourceName?: string
}

const resolveServerSong = async (
  rawSongInfo: any,
  requestedQuality: string,
  username: string,
  allowQualityFallback: boolean,
): Promise<ServerSongResolveResult> => {
  const originalSong = normalizeSongInfo({ ...rawSongInfo })
  if (!originalSong?.source) throw new Error('Missing song source')

  // 额外音源（Bilibili / 汽水）直接取链：让缓存、下载、音质探测也能走通这条链路
  if (extraSources.isExtraSource(originalSong.source)) {
    const extra = await extraSources.getMusicUrl(originalSong.source, originalSong, requestedQuality, username)
    return {
      url: extra.url,
      quality: extra.type,
      songInfo: originalSong,
      requestedSource: originalSong.source,
      downloadSource: fileCache.detectDownloadSource(extra.url, originalSong.source),
      sourceName: extra.sourceName,
    }
  }

  const qualities = allowQualityFallback
    ? getDownloadQualityCandidates(requestedQuality)
    : [requestedQuality]
  const errors: string[] = []

  const tryCandidates = async (quality: string, rawCandidates: any[]) => {
    for (const rawCandidate of rawCandidates) {
      const candidate = normalizeSongInfo({ ...rawCandidate })
      const source = candidate?.source
      if (!source || !isSourceSupported(source, username)) continue

      try {
        const result = await callUserApiGetMusicUrl(source, candidate, quality, username, undefined, true)
        if (!result?.url) throw new Error('audio source returned no URL')
        return {
          url: result.url,
          quality: result.type || quality,
          songInfo: candidate,
          requestedSource: originalSong.source,
          downloadSource: fileCache.detectDownloadSource(result.url, source),
          sourceName: result.sourceName,
        }
      } catch (err: any) {
        errors.push(`${source}/${quality}: ${err?.message || 'resolve failed'}`)
      }
    }
    return null
  }

  const originalResult = await tryCandidates(requestedQuality, [originalSong])
  if (originalResult) return originalResult

  const matches = await findServerSourceMatches(originalSong, username)
  const switchedResult = await tryCandidates(requestedQuality, matches)
  if (switchedResult) return switchedResult

  for (const quality of qualities.slice(1)) {
    const fallbackResult = await tryCandidates(quality, [originalSong, ...matches])
    if (fallbackResult) return fallbackResult
  }

  throw new Error(`No downloadable source found (${errors.join('; ')})`)
}

const isPathInside = (child: string, parent: string): boolean => {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  if (resolvedChild === resolvedParent) return true
  const withSep = resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep
  return resolvedChild.startsWith(withSep)
}

const serveStatic = (req: IncomingMessage, res: http.ServerResponse, filePath: string) => {
  // Prevent path traversal: ensure the resolved file path stays within staticPath
  if (!isPathInside(filePath, global.lx.staticPath)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  const contentType = getMime(filePath)

  try {
    const stats = fs.statSync(filePath)
    const mtime = stats.mtime.getTime()
    const etag = `W/"${stats.size}-${mtime}"`
    const lastModified = stats.mtime.toUTCString()

    // Check Cache Validity (Conditional Requests)
    if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304)
      res.end()
      return
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404)
          res.end('Not Found')
        } else {
          res.writeHead(500)
          res.end('Server Error')
        }
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'ETag': etag,
          'Last-Modified': lastModified,
          'Cache-Control': 'no-cache, must-revalidate', // Force browser to revalidate every time
          'Pragma': 'no-cache',
          'Expires': '0',
        })
        res.end(content, 'utf-8')
      }
    })
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.writeHead(404)
      res.end('Not Found')
    } else {
      res.writeHead(500)
      res.end('Server Error')
    }
  }
}

const handleStartServer = async (port = 9527, ip = '0.0.0.0') => await new Promise((resolve, reject) => {
  const httpServer = http.createServer(async (req, res) => {
    // CORS 跨域处理
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const ip = getIP(req)
    accessLog.info(`${req.method} ${req.url} from ${ip}`)
    // console.log(req.url)
    const urlObj = new URL(req.url ?? '', `http://${req.headers.host}`)
    const pathname = urlObj.pathname

    // 轻量健康检查端点：Docker healthcheck 使用该路径，不经过播放器认证和静态资源路由。
    // 加 ?probeDetail=1 时额外返回逐平台巡检明细（默认不返回，避免常规轮询被撑大）。
    if (req.method === 'GET' && pathname === '/health') {
      const probeDetail = urlObj.searchParams.get('probeDetail') === '1'
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({
        status: 'ok',
        version: getAppVersion(),
        uptimeSeconds: Math.floor(process.uptime()),
        customSourceCount: getLoadedApisCount(),
        lastReloadDurationMs: getLastReloadDurationMs(),
        trackedSourceResources: getTrackedTimerCount(),
        // 存活中的音源沙箱定时器明细：长间隔定时器（如 10 分钟）往往是周期性 CPU 尖峰的来源
        trackedTimers: getTrackedTimerDetails(),
        activeResources: getActiveResourceSummary(),
        // 全进程登记到的长定时器（>=5min，含注册栈）：周期性卡顿的头号嫌疑
        activeLongTimers: getActiveLongTimers(),
        sourceGuard: getSourceGuardStatus(),
        sourceProbe: getSourceProbeStatus(probeDetail),
        // 事件循环/内存/GC 诊断：卡顿归因三要素（配合 app.log 里的 [GC] 与慢定时器日志）
        diagnostics: getEventLoopStats(),
        // 音源活动账本：谁在发请求、谁刚回来响应、谁在加载、谁已被自动降速
        sourceActivity: getSourceActivitySnapshot(),
        // 宿主正在进行的批量动作（音源巡检等）：这类卡顿的真凶是宿主自己
        hostActivity: getActiveHostActivities()
      }))
      return
    }

    // 读取路径配置（每次请求都重新读取，保存后立刻生效）
    const normalizePath = (p: string) => (p || '').replace(/\/+$/, '')
    const playerPath = global.lx.config['player.path'] ?? '/'
    const adminPath = global.lx.config['admin.path'] ?? '/admin'
    // [修复] Subsonic 访问路径可配置；此前这里只排除写死的 /rest/，
    // 而本段判断先于下方的 Subsonic 路由执行，导致自定义 subsonic.path 会被当成播放器请求、后端接口整个失效。
    const subsonicPath = normalizePath(global.lx.config['subsonic.path'] || '/rest') || '/rest'
    const isSubsonicRequest = pathname === subsonicPath || pathname.startsWith(subsonicPath + '/')

    // [修复] 判断是否为 LX 同步客户端协议路由 (如 /hello, /id, /ah 以及 /<username>/hello, /<username>/ah 等)
    const isSyncProtocolRequest = /^\/([^/]+\/)?(hello|id|ah)$/.test(pathname)

    // 映射播放器逻辑 (无论是自定义路径还是前端硬编码的 /music/)
    const isPlayerRequest = (playerPath === '/' || playerPath === '')
      ? (pathname === '/' || (!pathname.startsWith('/api/') && !isSyncProtocolRequest && pathname !== '/js/config.js' && !isSubsonicRequest && (adminPath === '' || (pathname !== adminPath && !pathname.startsWith(adminPath + '/')))))
      : (pathname.startsWith(playerPath + '/') || pathname === playerPath)

    // [新增] 根静态资源 (icon.svg / favicon.ico / manifest.json)
    if (pathname === '/icon.svg' || pathname === '/favicon.ico' || pathname === '/manifest.json') {
      const filePath = path.join(global.lx.staticPath, pathname.slice(1))
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        serveStatic(req, res, filePath)
        return
      }
    }

    // [新增] 映射管理后台逻辑
    const isAdminRequest = adminPath && (pathname.startsWith(adminPath + '/') || pathname === adminPath)

    if (isAdminRequest) {
      if (pathname === adminPath) {
        res.writeHead(301, { 'Location': pathname + '/' })
        res.end()
        return
      }
      const subPath = pathname.slice(adminPath.length)
      let targetPath = ''
      if (subPath === '/' || subPath === '') {
        targetPath = 'index.html'
      } else {
        targetPath = subPath.startsWith('/') ? subPath.slice(1) : subPath
      }
      const filePath = path.join(global.lx.staticPath, targetPath)
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        serveStatic(req, res, filePath)
        return
      }
    }

    const isLegacyPlayerAsset = playerPath !== '/music' && (
      pathname.startsWith('/music/assets/') ||
      pathname.startsWith('/music/css/') ||
      pathname.startsWith('/music/js/') ||
      pathname.startsWith('/music/fonts/') ||
      pathname.startsWith('/music/img/') ||
      pathname === '/music/manifest.json' ||
      pathname === '/music/sw.js'
    )

    if (isPlayerRequest || isLegacyPlayerAsset) {
      const activePrefix = isPlayerRequest ? playerPath : '/music'
      const normalizedPrefix = (activePrefix === '/' || activePrefix === '') ? '' : activePrefix.replace(/\/+$/, '')
      // 白名单：登录页、静态资源无需认证
      const isLoginPage = pathname === `${normalizedPrefix}/login` || pathname === `${normalizedPrefix}/login.html`
      const isPublicAsset = pathname.startsWith(`${normalizedPrefix}/assets/`) ||
        pathname.startsWith(`${normalizedPrefix}/css/`) ||
        pathname.startsWith(`${normalizedPrefix}/js/`) ||
        pathname.startsWith(`${normalizedPrefix}/fonts/`) ||
        pathname.startsWith(`${normalizedPrefix}/img/`) ||
        pathname === `${normalizedPrefix}/manifest.json` ||
        pathname === `${normalizedPrefix}/sw.js` ||
        // 版本更新通知配置：前端 notification-engine 的本地优先源，需匿名可读
        pathname === '/notice/notification.json' ||
        isLegacyPlayerAsset

      // 认证检查
      if (!isLoginPage && !isPublicAsset && global.lx.config['player.enableAuth']) {
        if (!checkPlayerAuth(req)) {
          res.writeHead(302, { 'Location': `${normalizedPrefix}/login` })
          res.end()
          return
        }
      }

      // 规范化物理路径
      let targetPath = pathname
      // 将请求路径中的前缀映射到真实的 /music 物理目录
      if (pathname === activePrefix && activePrefix !== '/') {
        res.writeHead(301, { 'Location': pathname + '/' })
        res.end()
        return
      }

      // [PWA 适配] 动态生成播放器的 manifest.json，自动匹配当前 playerPath
      if (pathname === `${normalizedPrefix}/manifest.json` || (isLegacyPlayerAsset && pathname === '/music/manifest.json')) {
        const manifestFilePath = path.join(global.lx.staticPath, 'music', 'manifest.json')
        try {
          const raw = fs.readFileSync(manifestFilePath, 'utf-8')
          const manifest = JSON.parse(raw)
          // 规范化当前播放器的 base URL（必须以 / 结尾）
          const effectivePlayerBase = (playerPath === '/' || playerPath === '') ? '/' : `${playerPath.replace(/\/+$/, '')}/`
          manifest.start_url = effectivePlayerBase
          manifest.scope = effectivePlayerBase
          // 图标使用相对于当前有效根路径或者播放器物理路径的地址
          if (Array.isArray(manifest.icons)) {
            manifest.icons = manifest.icons.map((icon: any) => ({
              ...icon,
              src: icon.src ? (icon.src.startsWith('http') ? icon.src : `${effectivePlayerBase}${icon.src.replace(/^\.\//, '')}`) : icon.src
            }))
          }
          res.writeHead(200, {
            'Content-Type': 'application/manifest+json; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          })
          res.end(JSON.stringify(manifest, null, 2))
          return
        } catch { }
      }

      const subPath = pathname.slice(normalizedPrefix.length)
      if (subPath === '/' || subPath === '') {
        targetPath = 'music/index.html'
      } else if (isLoginPage) {
        targetPath = 'music/login.html'
      } else {
        // [优化] 如果根路径是播放器，且请求已经包含 /music/ 前缀，则不再重复叠加
        if ((activePrefix === '/' || activePrefix === '') && subPath.startsWith('/music/')) {
          targetPath = subPath.slice(1)
        } else {
          targetPath = path.posix.join('music', subPath.startsWith('/') ? subPath.slice(1) : subPath)
        }
      }

      const filePath = path.join(global.lx.staticPath, targetPath)
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        serveStatic(req, res, filePath)
        return
      }
    }

    // [动态配置注入] 优先拦截 /js/config.js 请求，确保后端配置能注入到前端 window.CONFIG
    if (pathname === '/js/config.js') {
      // 从静态文件读取版本号和构建哈希
      const staticConfigPath = path.join(global.lx.staticPath, 'js', 'config.js')
      let version = 'v1.0.0'
      let buildHash = 'unknown'
      try {
        const content = fs.readFileSync(staticConfigPath, 'utf-8')
        const matchVersion = content.match(/version:\s*['"]([^'"]+)['"]/)
        if (matchVersion) version = matchVersion[1]
        const matchHash = content.match(/buildHash:\s*['"]([^'"]+)['"]/)
        if (matchHash) buildHash = matchHash[1]
      } catch { }

      // 构造前端配置 暴露给前端
      const frontendConfig = {
        version,
        buildHash,
        serverName: global.lx.config.serverName,
        disableTelemetry: global.lx.config.disableTelemetry || false,
        'proxy.enabled': global.lx.config['proxy.enabled'],
        'user.enablePath': global.lx.config['user.enablePath'],
        'user.enableRoot': global.lx.config['user.enableRoot'],
        'user.enablePublicRestriction': global.lx.config['user.enablePublicRestriction'] || false,
        'user.enablePublicNonAdminBrowserDownload': global.lx.config['user.enablePublicNonAdminBrowserDownload'] ?? true,
        'user.enablePublicNonAdminServerCache': global.lx.config['user.enablePublicNonAdminServerCache'] ?? false,
        'user.enableLoginCacheRestriction': global.lx.config['user.enableLoginCacheRestriction'] || false,
        'user.enableCacheSizeLimit': global.lx.config['user.enableCacheSizeLimit'] || false,
        'user.cacheSizeLimit': global.lx.config['user.cacheSizeLimit'] || 2000,
        maxSnapshotNum: global.lx.config.maxSnapshotNum,
        'list.addMusicLocationType': global.lx.config['list.addMusicLocationType'],
        'player.name': global.lx.config['player.name'] || 'LX Music Web',
        'player.enableAuth': global.lx.config['player.enableAuth'] || false,
        port: global.lx.config.port,
        bindIP: global.lx.config.bindIP,
        'admin.path': global.lx.config['admin.path'] ?? '/admin',
        'player.path': global.lx.config['player.path'] ?? '/',
      }

      const configJs = `window.CONFIG = ${JSON.stringify(frontendConfig, null, 2)};`
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      })
      res.end(configJs)
      return
    }

    // [管理界面]
    const effectiveAdminPath = adminPath || '/'
    const isAdminPath = (pathname === effectiveAdminPath || pathname === effectiveAdminPath + '/' || pathname === effectiveAdminPath + '/index.html')

    if (isAdminPath) {
      const rootHtmlPath = path.join(global.lx.staticPath, 'index.html')
      if (fs.existsSync(rootHtmlPath)) {
        serveStatic(req, res, rootHtmlPath)
        return
      }
    }

    // 注意：如果设置了 adminPath，则不允许通过 / 直接访问后台资源文件，除非它是公共资源
    if (!pathname.startsWith('/api/')) {
      const generalFilePath = path.join(global.lx.staticPath, pathname)
      // 禁止绕过 adminPath 直接访问后台 index.html
      if (pathname === '/' || pathname === '/index.html') {
        if (adminPath !== '' && playerPath !== '/') {
          res.writeHead(404)
          res.end('Not Found')
          return
        }
      }

      if (fs.existsSync(generalFilePath) && fs.statSync(generalFilePath).isFile()) {
        serveStatic(req, res, generalFilePath)
        return
      }
    }

    // [Subsonic API]
    const subsonicEnable = global.lx.config['subsonic.enable']
    if (subsonicEnable && isSubsonicRequest) {
      const { subsonicHandler } = require('./subsonic')
      return subsonicHandler.handleRequest(req, res, urlObj)
    }


    if (pathname.startsWith('/api/')) {


      if (pathname === '/api/login' && req.method === 'POST') {
        void readBody(req).then(body => {
          try {
            const { password } = JSON.parse(body)
            if (password === global.lx.config['admin.password']) {
              loginLog.info(`Admin login success from ${ip}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } else {
              loginLog.warn(`Admin login failed from ${ip}`)
              res.writeHead(401, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false }))
            }
          } catch (e) {
            res.writeHead(400)
            res.end('Bad Request')
          }
        })
        return
      }



      // [新增] 获取服务器状态
      if (pathname === '/api/status' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const totalMem = os.totalmem()
        const freeMem = os.freemem()

        // 重新实现更准确的 CPU 使用率计算（支持 Windows）
        const getSystemCpuUsage = () => {
          const cpus = os.cpus()
          let idle = 0; let total = 0
          cpus.forEach(cpu => {
            for (const type in cpu.times) { total += (cpu.times as any)[type] }
            idle += cpu.times.idle
          })
          const last = global.lx.lastCpuSample || { idle: 0, total: 0 }
          const deltaIdle = idle - last.idle
          const deltaTotal = total - last.total
          global.lx.lastCpuSample = { idle, total }
          if (deltaTotal === 0) return '0.00'
          return (100 * (1 - deltaIdle / deltaTotal)).toFixed(2)
        }

        const getProcessCpuUsage = () => {
          const currentUsage = process.cpuUsage()
          const currentTime = Date.now()
          const last = global.lx.lastProcessSample || { cpu: process.cpuUsage(), time: Date.now() - 100 }
          const deltaUsage = {
            user: currentUsage.user - last.cpu.user,
            system: currentUsage.system - last.cpu.system,
          }
          const deltaTime = (currentTime - last.time) * 1000 // microseconds
          global.lx.lastProcessSample = { cpu: currentUsage, time: currentTime }
          if (deltaTime === 0) return '0.00'
          return ((deltaUsage.user + deltaUsage.system) / deltaTime / os.cpus().length * 100).toFixed(2)
        }

        const status = {
          users: global.lx.config.users.length,
          devices: wss?.clients.size ?? 0,
          uptime: process.uptime(),
          memory: process.memoryUsage().rss,
          totalMemory: totalMem,
          freeMemory: freeMem,
          systemMemoryUsage: ((totalMem - freeMem) / totalMem * 100).toFixed(2),
          processMemoryUsage: (process.memoryUsage().rss / totalMem * 100).toFixed(2),
          cpuUsage: getSystemCpuUsage(),
          processCpuUsage: getProcessCpuUsage(),
          osUptime: os.uptime(),
          cpus: os.cpus().length,
          cpuModel: os.cpus()[0]?.model || 'Unknown',
          cpuSpeed: os.cpus()[0]?.speed || 0,
          isWebDAVConfigured: !!(global.lx.config['webdav.url'] && global.lx.config['webdav.url'].trim() !== '' && global.lx.config['webdav.enable']),
          sourcesCount: getLoadedApisCount ? getLoadedApisCount() : 0,
          nodeVersion: process.version,
          platform: `${os.type()} ${os.arch()}`,
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        })
        res.end(JSON.stringify(status))
        return
      }

      if (pathname === '/api/users') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }
        if (req.method === 'GET') {
          // 安全收紧：默认**不**回传明文密码。
          // 管理面板的「显示密码」按钮会在点击时额外带 `x-reveal-secrets: 1` 再请求一次，
          // 明文于是只在管理员显式索要时才出现在响应里，避免默认把全部用户密码一次性下发
          // （浏览器内存、扩展、日志、抓包等都会顺手拿到）。
          const revealSecrets = req.headers['x-reveal-secrets'] === '1'
          const users = global.lx.config.users.map(u => ({
            name: u.name,
            password: revealSecrets ? u.password : '',
            hasPassword: !!u.password,
            enableCustomMusicDir: u.enableCustomMusicDir ?? false,
            customMusicDir: u.customMusicDir || '',
            allowOperateCustomMusicDir: u.allowOperateCustomMusicDir ?? false,
            allowWriteCustomMusicDir: u.allowWriteCustomMusicDir ?? false,
            enableAutoDownload: u.enableAutoDownload ?? false,
          }))
          if (global.lx.config['user.enablePublicFavorites']) {
            users.unshift({ name: '_open', password: '', hasPassword: false, enableCustomMusicDir: false, customMusicDir: '', allowOperateCustomMusicDir: false, allowWriteCustomMusicDir: false, enableAutoDownload: false })
          }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          })
          res.end(JSON.stringify(users))
          return
        }
        if (req.method === 'POST') {
          void readBody(req).then(body => {
            try {
              const { name, password } = JSON.parse(body)
              if (!name || !password) {
                res.writeHead(400)
                res.end('Missing name or password')
                return
              }
              if (global.lx.config.users.some(u => u.name === name)) {
                res.writeHead(409)
                res.end('User already exists')
                return
              }

              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const { getUserDirname } = require('@/user')
              const dataPath = path.join(global.lx.userPath, getUserDirname(name))
              checkAndCreateDir(dataPath)

              global.lx.config.users.push({
                name,
                password,
                dataPath,
              })
              saveUsers()

              res.writeHead(200)
              res.end(JSON.stringify({ success: true }))
            } catch (e) {
              res.writeHead(500)
              res.end('Server Error')
            }
          })
          return
        }
        if (req.method === 'PUT') {
          void readBody(req).then(body => {
            try {
              const { name, newName, password, enableCustomMusicDir, customMusicDir, allowOperateCustomMusicDir, allowWriteCustomMusicDir, enableAutoDownload } = JSON.parse(body)
              if (!name) {
                res.writeHead(400)
                res.end('Missing required fields')
                return
              }
              const userIdx = global.lx.config.users.findIndex(u => u.name === name)
              if (userIdx === -1) {
                res.writeHead(404)
                res.end('User not found')
                return
              }

              const user = global.lx.config.users[userIdx]

              const handleFinalUpdate = () => {
                const oldEnabled = !!user.enableCustomMusicDir
                const oldCustomDir = (user.customMusicDir || '').trim()

                if (password) user.password = password
                if (enableCustomMusicDir !== undefined) user.enableCustomMusicDir = !!enableCustomMusicDir
                if (customMusicDir !== undefined) {
                  const trimmedMusicDir = String(customMusicDir).trim()
                  if (trimmedMusicDir) {
                    if (/[<>"|?*]/.test(trimmedMusicDir)) {
                      res.writeHead(422, { 'Content-Type': 'application/json' })
                      res.end(JSON.stringify({ success: false, error: '自定义音乐目录包含非法字符 (< > " | ? *)' }))
                      return
                    }
                    try {
                      fs.mkdirSync(trimmedMusicDir, { recursive: true })
                      fs.accessSync(trimmedMusicDir, fs.constants.R_OK)
                    } catch (e: any) {
                      res.writeHead(422, { 'Content-Type': 'application/json' })
                      res.end(JSON.stringify({ success: false, error: `自定义音乐目录无效或无法访问 (${trimmedMusicDir}): ${e.message || e}` }))
                      return
                    }
                  }
                  user.customMusicDir = trimmedMusicDir
                }
                if (allowOperateCustomMusicDir !== undefined) user.allowOperateCustomMusicDir = !!allowOperateCustomMusicDir
                if (allowWriteCustomMusicDir !== undefined) user.allowWriteCustomMusicDir = !!allowWriteCustomMusicDir
                if (enableAutoDownload !== undefined) user.enableAutoDownload = !!enableAutoDownload
                saveUsers()

                // 检测是否需要自动迁移该用户的同步下载歌曲
                try {
                  const newEnabled = !!user.enableCustomMusicDir
                  const newCustomDir = (user.customMusicDir || '').trim()
                  const syncData = getSyncDownloadData(user.name)

                  if (syncData.storageLocation === 'custom') {
                    if (oldEnabled && !newEnabled) {
                      // 关闭了自定义目录：自动将文件从旧自定义目录迁回根目录 (root)
                      console.log(`[用户管理] 用户 ${user.name} 自定义目录已被禁用，正在将同步歌曲从 ${oldCustomDir} 迁回根目录...`)
                      migrateSyncStorage(user.name, 'root', { overrideOldCustomDir: oldCustomDir })
                    } else if (newEnabled && oldCustomDir && newCustomDir && oldCustomDir !== newCustomDir) {
                      // 更改了自定义目录路径：自动将文件从旧自定义目录迁移到新自定义目录
                      console.log(`[用户管理] 用户 ${user.name} 自定义目录路径发生变更 (${oldCustomDir} -> ${newCustomDir})，正在迁移同步歌曲...`)
                      migrateSyncStorage(user.name, 'custom', { overrideOldCustomDir: oldCustomDir, overrideNewCustomDir: newCustomDir })
                    }
                  }
                } catch (migErr: any) {
                  console.error(`[用户管理] 用户 ${user.name} 自动迁移同步歌曲失败:`, migErr.message || migErr)
                }

                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: true }))
              }

              if (newName && newName !== name) {
                if (global.lx.config.users.some(u => u.name === newName)) {
                  res.writeHead(409)
                  res.end('New username already exists')
                  return
                }

                console.log(`[用户管理] 正在重命名用户 ${name} 为 ${newName}...`)

                // 1. 断开该用户的连接
                if (wss) {
                  for (const client of wss.clients) {
                    if (client.userInfo?.name === name) client.close(SYNC_CLOSE_CODE.normal)
                  }
                }

                // 2. 释放内存中的用户空间 (清除缓存) 并锁定，防止重命名期间被重新初始化
                renameUserSpace(name)

                // 3. 稍作延迟等待 Socket 释放和可能的异步操作完成 (Windows 友好)
                // 增加到 500ms 以确保稳定性
                setTimeout(() => {
                  try {
                    // 4. 迁移物理数据
                    migrateUserData(name, newName)

                    // 5. 更新内存中的用户信息 (全局配置)
                    user.name = newName

                    handleFinalUpdate()
                  } catch (err: any) {
                    console.error(`[用户管理] 迁移用户数据失败: ${err.message}`)
                    res.writeHead(500)
                    res.end(err.message || 'Data Migration Failed')
                  } finally {
                    // 无论成功失败，都解除锁定
                    finishRenameUserSpace(name)
                  }
                }, 500)
              } else {
                handleFinalUpdate()
              }
            } catch (e) {
              console.error('[用户管理] 重命名用户发生异常:', e)
              res.writeHead(500)
              res.end('Server Error')
            }
          })
          return
        }
        if (req.method === 'DELETE') {
          void readBody(req).then(body => {
            try {
              // 修改：同时支持单个 name 和批量 names，以及 deleteData 参数
              const { name, names, deleteData } = JSON.parse(body)
              const targets = names || (name ? [name] : [])

              if (targets.length === 0) {
                res.writeHead(400)
                res.end('Missing name or names')
                return
              }

              let deletedCount = 0
              const deletedUsers: { name: string, dataPath: string }[] = []

              for (const targetName of targets) {
                const idx = global.lx.config.users.findIndex(u => u.name === targetName)
                if (idx !== -1) {
                  const user = global.lx.config.users[idx]

                  // 保存用户数据路径（如果需要删除）
                  console.log(`[用户管理] 删除数据选项: ${deleteData}, 用户数据路径: ${user.dataPath}`)
                  if (deleteData && user.dataPath) {
                    deletedUsers.push({ name: targetName, dataPath: user.dataPath })
                  } else {
                    console.log(`[用户管理] 跳过删除用户 ${targetName} 的数据目录 (deleteData=${deleteData}, 数据目录存在=${!!user.dataPath})`)
                  }

                  // 断开该用户的连接
                  if (wss) {
                    for (const client of wss.clients) {
                      if (client.userInfo?.name === targetName) client.close(SYNC_CLOSE_CODE.normal)
                    }
                  }
                  global.lx.config.users.splice(idx, 1)
                  deletedCount++
                }
              }

              if (deletedCount > 0) {
                saveUsers()

                // 如果需要删除数据文件夹
                if (deleteData && deletedUsers.length > 0) {
                  console.log(`[用户管理] 正在清理 ${deletedUsers.length} 个用户的数据目录...`)
                  for (const user of deletedUsers) {
                    try {
                      console.log(`[用户管理] 检查并清理目录: ${user.dataPath}`)
                      if (fs.existsSync(user.dataPath)) {
                        fs.rmSync(user.dataPath, { recursive: true, force: true })
                        console.log(`[用户管理] 已删除用户数据目录: ${user.dataPath}`)
                      } else {
                        console.log(`[用户管理] 数据目录不存在: ${user.dataPath}`)
                      }
                    } catch (err) {
                      console.error(`[用户管理] 删除用户 ${user.name} 的数据目录失败:`, err)
                      // 继续删除其他用户，不中断流程
                    }
                  }
                } else {
                  console.log('[用户管理] 无需删除物理数据目录 (未勾选删除数据)')
                }

                res.writeHead(200)
                res.end(JSON.stringify({ success: true, deletedCount }))
              } else {
                res.writeHead(404)
                res.end('User not found')
              }
            } catch (e) {
              res.writeHead(500)
              res.end('Server Error')
            }
          })
          return
        }
      }

      if (pathname === '/api/data' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        const isAdminAuth = auth === global.lx.config['admin.password']
        const userParam = urlObj.searchParams.get('user')

        if (!userParam) {
          res.writeHead(400)
          res.end('Missing user param')
          return
        }

        // 鉴权逻辑：管理员 或 公共用户 或 具名用户(需 Token)
        let verifiedUser: string | null = null
        if (isAdminAuth) {
          verifiedUser = userParam // 管理员信任 userParam
        } else if (userParam === 'default' || userParam === '_open') {
          verifiedUser = '_open'
        } else {
          verifiedUser = verifyUserAuth(req)
          if (!verifiedUser || verifiedUser !== userParam) {
            res.writeHead(403)
            res.end('Forbidden: User mismatch or unauthorized')
            return
          }
        }

        const userSpace = getUserSpace(verifiedUser)
        void userSpace.listManage.getListData().then(async data => {
          let albums = []
          let artists = []
          let dislikeAlbums = []
          let dislikeArtists = []
          try {
            const userDirname = getUserDirname(verifiedUser)
            const libraryPath = path.join(global.lx.userPath, userDirname, 'library')
            const albumsPath = path.join(libraryPath, 'albums.json')
            const artistsPath = path.join(libraryPath, 'artists.json')

            const dislikeLibraryPath = path.join(global.lx.userPath, userDirname, 'dislike', 'library')
            const dislikeAlbumsPath = path.join(dislikeLibraryPath, 'albums.json')
            const dislikeArtistsPath = path.join(dislikeLibraryPath, 'artists.json')

            if (await fs.promises.stat(albumsPath).then(() => true).catch(() => false)) albums = JSON.parse(await fs.promises.readFile(albumsPath, 'utf8'))
            if (await fs.promises.stat(artistsPath).then(() => true).catch(() => false)) artists = JSON.parse(await fs.promises.readFile(artistsPath, 'utf8'))
            if (await fs.promises.stat(dislikeAlbumsPath).then(() => true).catch(() => false)) dislikeAlbums = JSON.parse(await fs.promises.readFile(dislikeAlbumsPath, 'utf8'))
            if (await fs.promises.stat(dislikeArtistsPath).then(() => true).catch(() => false)) dislikeArtists = JSON.parse(await fs.promises.readFile(dislikeArtistsPath, 'utf8'))
          } catch (err) {
            console.error(err)
          }

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          })
          res.end(JSON.stringify({ ...data, albums, artists, dislikeAlbums, dislikeArtists }))
        }).catch(err => {
          res.writeHead(500)
          res.end(err.message)
        })
        return
      }
      // 获取快照列表
      if (pathname === '/api/data/snapshots' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        const isAdminAuth = auth === global.lx.config['admin.password']
        const userParam = urlObj.searchParams.get('user')

        if (!userParam) {
          res.writeHead(400)
          res.end('Missing user param')
          return
        }

        // 鉴权逻辑
        let verifiedUser: string | null = null
        if (isAdminAuth) {
          verifiedUser = userParam
        } else if (userParam === 'default' || userParam === '_open') {
          verifiedUser = '_open'
        } else {
          verifiedUser = verifyUserAuth(req)
          if (!verifiedUser || verifiedUser !== userParam) {
            res.writeHead(403)
            res.end('Forbidden')
            return
          }
        }

        const userSpace = getUserSpace(verifiedUser)
        try {
          const list = await userSpace.listManage.getSnapshotList()
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          })
          res.end(JSON.stringify(list))
        } catch (err: any) {
          res.writeHead(500)
          res.end(err.message)
        }
        return
      }

      // 下载快照数据
      if (pathname === '/api/data/snapshot' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        const isAdminAuth = auth === global.lx.config['admin.password']
        const userParam = urlObj.searchParams.get('user')

        if (!userParam) {
          res.writeHead(400)
          res.end('Missing user param')
          return
        }

        let verifiedUser: string | null = null
        if (isAdminAuth) {
          verifiedUser = userParam
        } else if (userParam === 'default' || userParam === '_open') {
          verifiedUser = '_open'
        } else {
          verifiedUser = verifyUserAuth(req)
          if (!verifiedUser || verifiedUser !== userParam) {
            res.writeHead(403)
            res.end('Forbidden')
            return
          }
        }

        const userSpace = getUserSpace(verifiedUser)
        const id = urlObj.searchParams.get('id')
        if (!id) {
          res.writeHead(400)
          res.end('Missing id')
          return
        }
        try {
          const data = await userSpace.listManage.getSnapshot(id)
          if (!data) {
            res.writeHead(404)
            res.end('Not Found')
            return
          }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          })
          res.end(JSON.stringify(data))
        } catch (err: any) {
          res.writeHead(500)
          res.end(err.message)
        }
        return
      }

      // 恢复快照
      if (pathname === '/api/data/restore-snapshot' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        const isAdminAuth = auth === global.lx.config['admin.password']
        const userParam = urlObj.searchParams.get('user')

        if (!userParam) {
          res.writeHead(400)
          res.end('Missing user param')
          return
        }

        let verifiedUser: string | null = null
        if (isAdminAuth) {
          verifiedUser = userParam
        } else if (userParam === 'default' || userParam === '_open') {
          verifiedUser = '_open'
        } else {
          verifiedUser = verifyUserAuth(req)
          if (!verifiedUser || verifiedUser !== userParam) {
            res.writeHead(403)
            res.end('Forbidden')
            return
          }
        }

        const userSpace = getUserSpace(verifiedUser)
        try {
          const body = await readBody(req)
          const { id } = JSON.parse(body)
          if (!id) throw new Error('Missing id')

          await userSpace.listManage.restoreSnapshot(id)

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
        } catch (err: any) {
          res.writeHead(500)
          res.end(err.message)
        }
        return
      }

      // [新增] Batch Remove Songs from List (User Auth)
      if (pathname === '/api/music/user/list/remove' && req.method === 'POST') {
        const username = verifyUserAuth(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: '需要用户认证' }))
          return
        }

        void readBody(req).then(async body => {
          try {
            const { listId, songIds } = JSON.parse(body)

            if (!listId || !Array.isArray(songIds)) {
              res.writeHead(400)
              res.end('参数错误:需要listId和songIds数组')
              return
            }

            console.log(`[用户接口] 批量删除请求: 用户=${username}, 列表=${listId}, 删除歌曲数=${songIds.length}`)
            console.log(`[用户接口] 待删除歌曲ID:`, songIds)

            const userSpace = getUserSpace(username)

            // Get list before deletion
            const listBefore = await userSpace.listManage.listDataManage.getListMusics(listId)
            console.log(`[用户接口] 删除前列表歌曲数: ${listBefore.length}`)

            // Remove songs from the list
            const affectedLists = await userSpace.listManage.listDataManage.listMusicRemove(listId, songIds)
            console.log(`[用户接口] 受影响的列表:`, affectedLists)

            // Get list after deletion  
            const listAfter = await userSpace.listManage.listDataManage.getListMusics(listId)
            console.log(`[用户接口] 删除后列表歌曲数: ${listAfter.length}`)

            // Create new snapshot to persist changes
            const newSnapshotKey = await userSpace.listManage.createSnapshot()
            console.log(`[用户接口] 批量删除成功,已创建新快照: ${newSnapshotKey}`)

            res.writeHead(200)
            res.end('删除成功')
          } catch (err: any) {
            console.error('[用户接口] 批量删除失败:', err)
            res.writeHead(500)
            res.end(err.message || '删除失败')
          }
        })
        return
      }

      // [新增] Reorder Songs in List (User Auth)
      if (pathname === '/api/music/user/list/reorder' && req.method === 'POST') {
        const username = verifyUserAuth(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: '需要用户认证' }))
          return
        }

        void readBody(req).then(async body => {
          try {
            const { listId, orderedSongIds } = JSON.parse(body)

            if (!listId || !Array.isArray(orderedSongIds)) {
              res.writeHead(400)
              res.end('参数错误:需要listId和orderedSongIds数组')
              return
            }

            console.log(`[用户接口] 歌单重排请求: 用户=${username}, 列表=${listId}, 歌曲数=${orderedSongIds.length}`)

            const userSpace = getUserSpace(username)

            // Get current full song objects
            const currentList = await userSpace.listManage.listDataManage.getListMusics(listId)

            // Build ordered list from IDs, preserving song objects
            const songMap = new Map<string, LX.Music.MusicInfo>()
            for (const song of currentList) songMap.set(song.id, song)

            const reorderedList = orderedSongIds
              .map((id: string) => songMap.get(id))
              .filter(Boolean) as LX.Music.MusicInfo[]

            // Append any songs not in orderedSongIds (safety net)
            const orderedSet = new Set<string>(orderedSongIds)
            for (const song of currentList) {
              if (!orderedSet.has(song.id)) reorderedList.push(song)
            }

            await userSpace.listManage.listDataManage.listMusicOverwrite(listId, reorderedList)

            // Create new snapshot to persist changes
            const newSnapshotKey = await userSpace.listManage.createSnapshot()
            console.log(`[用户接口] 歌单重排成功,已创建新快照: ${newSnapshotKey}`)

            res.writeHead(200)
            res.end('重排成功')
          } catch (err: any) {
            console.error('[用户接口] 歌单重排失败:', err)
            res.writeHead(500)
            res.end(err.message || '重排失败')
          }
        })
        return
      }

      // [新增] Batch Add Songs to List (User Auth)
      if (pathname === '/api/music/user/list/add' && req.method === 'POST') {
        const username = verifyUserAuth(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: '需要用户认证' }))
          return
        }

        void readBody(req).then(async body => {
          try {
            const { listId, musicInfos, location } = JSON.parse(body)

            if (!listId || !Array.isArray(musicInfos)) {
              res.writeHead(400)
              res.end('参数错误:需要listId和musicInfos数组')
              return
            }

            console.log(`[用户接口] 批量添加请求: 用户=${username}, 列表=${listId}, 添加歌曲数=${musicInfos.length}`)

            const userSpace = getUserSpace(username)

            // Add songs to the list
            const addMusicLocationType = location === 'top' || location === 'bottom'
              ? location
              : getUserConfig(username)['list.addMusicLocationType']
            await userSpace.listManage.listDataManage.listMusicAdd(listId, musicInfos, addMusicLocationType)

            // Create new snapshot to persist changes
            const newSnapshotKey = await userSpace.listManage.createSnapshot()
            console.log(`[用户接口] 批量添加成功,已创建新快照: ${newSnapshotKey}`)

            res.writeHead(200)
            res.end('添加成功')
          } catch (err: any) {
            console.error('[用户接口] 批量添加失败:', err)
            res.writeHead(500)
            res.end(err.message || '添加失败')
          }
        })
        return
      }



      // [新增] 删除快照 API
      if (pathname === '/api/data/delete-snapshot' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        const isAdminAuth = auth === global.lx.config['admin.password']
        const userParam = urlObj.searchParams.get('user')

        if (!userParam) {
          res.writeHead(400)
          res.end('Missing user param')
          return
        }

        let verifiedUser: string | null = null
        if (isAdminAuth) {
          verifiedUser = userParam
        } else if (userParam === 'default' || userParam === '_open') {
          verifiedUser = '_open'
        } else {
          verifiedUser = verifyUserAuth(req)
          if (!verifiedUser || verifiedUser !== userParam) {
            res.writeHead(403)
            res.end('Forbidden')
            return
          }
        }

        const userSpace = getUserSpace(verifiedUser)
        try {
          const body = await readBody(req)
          const { id } = JSON.parse(body)
          if (!id) throw new Error('Missing id')

          // 调用刚刚在 ListManage 中添加的方法
          await userSpace.listManage.removeSnapshot(id)

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
        } catch (err: any) {
          res.writeHead(500)
          res.end(err.message)
        }
        return
      }
      // [新增] 上传快照 API
      if (pathname === '/api/data/upload-snapshot' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        const isAdminAuth = auth === global.lx.config['admin.password']
        const userParam = urlObj.searchParams.get('user')
        const time = parseInt(urlObj.searchParams.get('time') || '0')
        const filename = urlObj.searchParams.get('filename')

        if (!userParam) {
          res.writeHead(400)
          res.end('Missing user param')
          return
        }

        let verifiedUser: string | null = null
        if (isAdminAuth) {
          verifiedUser = userParam
        } else if (userParam === 'default' || userParam === '_open') {
          verifiedUser = '_open'
        } else {
          verifiedUser = verifyUserAuth(req)
          if (!verifiedUser || verifiedUser !== userParam) {
            res.writeHead(403)
            res.end('Forbidden')
            return
          }
        }

        if (!filename) {
          res.writeHead(400)
          res.end('Missing filename param')
          return
        }

        const userSpace = getUserSpace(verifiedUser)

        try {
          const body = await readBody(req)
          let finalData = body

          // [核心兼容性修复] 检测是否为落雪音乐离线备份格式 (playList_v2)
          try {
            const jsonData = JSON.parse(body)
            if (jsonData && jsonData.type === 'playList_v2' && Array.isArray(jsonData.data)) {
              startupLog.info(`[Snapshot] Detected LX Music backup format for user ${verifiedUser}, converting back to internal format...`)

              // 寻找默认列表
              const defaultList = jsonData.data.find((l: any) => l.id === 'default')?.list || []
              // 寻找收藏列表
              const loveList = jsonData.data.find((l: any) => l.id === 'love')?.list || []
              // 其他所有列表均作为用户列表
              const userList = jsonData.data.filter((l: any) => l.id !== 'default' && l.id !== 'love')

              // 拼装为服务器内部快照格式
              const internalFormat = {
                defaultList,
                loveList,
                userList
              }

              // 压缩为单行 JSON 以节省磁盘空间并保持与原生快照一致的大小
              finalData = JSON.stringify(internalFormat)
              startupLog.info(`[Snapshot] Conversion complete for user ${verifiedUser}.`)
            }
          } catch (parseErr) {
            // 解析失败说明不是标准的 JSON 格式或已经是原始快照，保持原样即可
          }

          // 处理文件名：如果以 snapshot_ 开头，则去掉（因为 saveSnapshotWithTime 会自动加）
          // 如果不以 snapshot_ 开头，则保持原样（saveSnapshotWithTime 会自动加 snapshot_ 前缀）
          let name = filename
          if (name.startsWith('snapshot_')) {
            name = name.substring(9)
          }

          // 调用 ListManage 中的 saveSnapshotWithTime 方法
          await userSpace.listManage.saveSnapshotWithTime(name, finalData, time)

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
        } catch (err: any) {
          res.writeHead(500)
          res.end(err.message)
        }
        return
      }

      // [新增] User Login Verification
      if (pathname === '/api/user/verify' && req.method === 'POST') {
        void readBody(req).then(body => {
          try {
            const { username, password } = JSON.parse(body)
            if (!username || !password) {
              res.writeHead(400)
              res.end('Missing username or password')
              return
            }
            const user = global.lx.config.users.find(u => u.name === username && u.password === password)
            if (user) {
              loginLog.info(`User login success: ${username} from ${ip}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } else {
              loginLog.warn(`User login failed: ${username} from ${ip}`)
              res.writeHead(401, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: 'Invalid credentials' }))
            }
          } catch (e) {
            res.writeHead(400)
            res.end('Bad Request')
          }
        })
        return
      }

      // [新增] 用户登录 - 颁发 Token（替代明文密码传输）
      if (pathname === '/api/user/login' && req.method === 'POST') {
        void readBody(req).then(body => {
          try {
            const { username, password } = JSON.parse(body)
            if (!username || !password) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: 'Missing username or password' }))
              return
            }
            const user = global.lx.config.users.find((u: any) => u.name === username && u.password === password)
            if (user) {
              const token = generateSessionId()
              addUserSession(token, username)
              loginLog.info(`User token issued: ${username} from ${ip}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true, token, username }))
            } else {
              loginLog.warn(`User login failed: ${username} from ${ip}`)
              res.writeHead(401, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: 'Invalid credentials' }))
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Bad Request' }))
          }
        })
        return
      }

      // [新增] 用户登出 - 注销 Token
      if (pathname === '/api/user/logout' && req.method === 'POST') {
        const token = req.headers['x-user-token'] as string
        if (token) removeUserSession(token)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
        return
      }

      // [新增] Token 有效性检查
      if (pathname === '/api/user/auth/verify' && req.method === 'GET') {
        const username = verifyUserAuth(req)
        const valid = !!username
        let enableCustomMusicDir = false
        let allowOperateCustomMusicDir = false
        let enableAutoDownload = false
        if (username) {
          const user = global.lx.config.users.find(u => u.name === username)
          // 全局总开关 user.enableCustomMusicDir 必须为 true，才读取用户自身配置
          const globalSwitch = !!global.lx.config['user.enableCustomMusicDir']
          if (user && globalSwitch) {
            enableCustomMusicDir = !!user.enableCustomMusicDir
            allowOperateCustomMusicDir = !!user.allowOperateCustomMusicDir
          }
          if (user) {
            enableAutoDownload = !!user.enableAutoDownload
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ valid, username: username || null, enableCustomMusicDir, allowOperateCustomMusicDir, enableAutoDownload }))
        return
      }

      // [新增] Get User List (User Auth)
      // [新增] Get User List (User Auth)
      if (pathname === '/api/user/list' && req.method === 'GET') {
        const targetUserParam = urlObj.searchParams.get('user')
        const reqUsername = (req.headers['x-user-name'] as string) || targetUserParam || ''
        const auth = req.headers['x-frontend-auth']
        const isAdmin = !!(auth && auth === global.lx.config['admin.password'])
        let username: string | null = null

        const canAccessOpen = global.lx.config['user.enablePublicFavorites'] && (
          global.lx.config['user.enablePublicNonAdminAccess'] || isAdmin || !!verifyUserAuth(req)
        )
        if (targetUserParam === '_open' || reqUsername === '_open' || (!reqUsername && !verifyUserAuth(req))) {
          if (canAccessOpen) {
            username = '_open'
          }
        }
        if (!username) {
          username = verifyUserAuth(req)
        }
        if (!username && reqUsername && reqUsername !== '_open') {
          username = reqUsername
        }


        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        const userSpace = getUserSpace(username)
        void userSpace.listManage.getListData().then(data => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          })
          res.end(JSON.stringify(data))
        }).catch(err => {
          res.writeHead(500)
          res.end(err.message)
        })
        return
      }

      // [新增] Update User List (User Auth) - Full Restore/Overwrite
      if (pathname === '/api/user/list' && req.method === 'POST') {
        const targetUserParam = urlObj.searchParams.get('user')
        const reqUsername = (req.headers['x-user-name'] as string) || targetUserParam || ''
        const auth = req.headers['x-frontend-auth']
        const isAdmin = !!(auth && auth === global.lx.config['admin.password'])
        let username: string | null = null

        const canAccessOpen = global.lx.config['user.enablePublicFavorites'] && (
          global.lx.config['user.enablePublicNonAdminAccess'] || isAdmin || !!verifyUserAuth(req)
        )
        if (targetUserParam === '_open' || reqUsername === '_open' || (!reqUsername && !verifyUserAuth(req))) {
          if (!canAccessOpen) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: '权限不足：未开启公开访问。' }))
            return
          }
          if (auth !== global.lx.config['admin.password']) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: '权限不足：公共歌单修改受限，请先验证管理员身份。' }))
            return
          }
          username = '_open'
        }
        if (!username) {
          username = verifyUserAuth(req)
        }
        if (!username && reqUsername && reqUsername !== '_open') {
          username = reqUsername
        }


        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        void readBody(req).then(async body => {
          try {
            const listData = JSON.parse(body)
            const userSpace = getUserSpace(username!)
            // Restore ensures consistency with the provided snapshot
            await userSpace.listManage.listDataManage.restore(listData)
            // Create a snapshot after update
            await userSpace.listManage.createSnapshot()

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(500)
            res.end(err.message)
          }
        })
        return
      }

      // [新增] 用户 Library API — 收藏歌手 & 收藏专辑
      const getLibUsername = (req: any): string | null => {
        const url = new URL(req.url || '', 'http://localhost')
        const userParam = url.searchParams.get('user') || ''
        const reqUsername = (req.headers['x-user-name'] as string) || userParam
        const auth = req.headers['x-frontend-auth']
        const isAdmin = !!(auth && auth === global.lx.config['admin.password'])

        const canAccessOpen = global.lx.config['user.enablePublicFavorites'] && (
          global.lx.config['user.enablePublicNonAdminAccess'] || isAdmin || !!verifyUserAuth(req)
        )
        if ((reqUsername === '_open' || userParam === '_open' || (!reqUsername && !verifyUserAuth(req))) && canAccessOpen) {
          return '_open'
        }

        let username = verifyUserAuth(req)
        if (!username && reqUsername && reqUsername !== '_open') {
          username = reqUsername
        }
        return username || '_open'
      }

      // GET /api/user/library/artists  — 读取收藏歌手列表（自动补全缺失头像 picUrl）
      if (pathname === '/api/user/library/artists' && req.method === 'GET') {
        const username = getLibUsername(req)
        if (!username) { res.writeHead(401); res.end('Unauthorized'); return }
        const userDirname = getUserDirname(username)
        const libDir = path.join(global.lx.userPath, userDirname, 'library')
        if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true })
        const filePath = path.join(libDir, 'artists.json')
        try {
          if (!fs.existsSync(filePath)) {
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return
          }
          let arr: any[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
          if (!Array.isArray(arr)) arr = []
          // [修复] 对没有可用 picUrl 的歌手，实时从音源拉取头像并补全（带内存缓存，单条失败不影响整体）
          // [稳健] 进程级共享并发队列与 In-flight Promise 复用，避免多请求并发/重复击穿音源接口
          const needFetch = arr.filter((a: any) => a && a.id != null && a.source &&
            !(a.picUrl && /^https?:\/\//.test(String(a.picUrl))))
          let changed = false
          if (needFetch.length) {
            await Promise.all(needFetch.map(async (a: any) => {
              try {
                const pic = await fetchArtistPicShared(a.source, a.id)
                if (pic) { a.picUrl = pic; changed = true }
              } catch (e) { /* 忽略单个歌手的拉取失败 */ }
            }))
            // 将补全后的 picUrl 持久化回文件：每个歌手最多实时查一次，之后永久生效（重启也不再查询）
            if (changed) {
              try { fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf-8') } catch { /* ignore */ }
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(arr))
        } catch (e: any) { res.writeHead(500); res.end(e.message) }
        return
      }

      // POST /api/user/library/artists  — 完整覆盖写入收藏歌手列表
      if (pathname === '/api/user/library/artists' && req.method === 'POST') {
        const username = getLibUsername(req)
        if (!username) { res.writeHead(401); res.end('Unauthorized'); return }
        void readBody(req).then(body => {
          try {
            const parsed = JSON.parse(body)
            if (!Array.isArray(parsed)) throw new Error('Expected an array')
            const userDirname = getUserDirname(username)
            const libDir = path.join(global.lx.userPath, userDirname, 'library')
            if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true })
            const filePath = path.join(libDir, 'artists.json')
            // 反向同步：对比旧数据计算增量，回写 Subsonic 星标
            let oldArr: any[] = []
            try { if (fs.existsSync(filePath)) oldArr = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { /* ignore */ }
            const keyOf = (x: any) => `${x.source}::${String(x.id)}`
            const oldKeys = new Set(oldArr.map(keyOf))
            const newKeys = new Set(parsed.map(keyOf))
            const added = parsed.filter((x: any) => !oldKeys.has(keyOf(x)))
            const removed = oldArr.filter((x: any) => !newKeys.has(keyOf(x)))
            fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8')

            // [Mutual Exclusivity] Remove newly liked artists from the dislike list
            const dislikeLibDir = path.join(global.lx.userPath, userDirname, 'dislike', 'library')
            const dislikeFilePath = path.join(dislikeLibDir, 'artists.json')
            if (added.length > 0 && fs.existsSync(dislikeFilePath)) {
              try {
                let dislikeArr: any[] = JSON.parse(fs.readFileSync(dislikeFilePath, 'utf8'))
                if (Array.isArray(dislikeArr)) {
                  const addedKeys = new Set(added.map(keyOf))
                  const newDislikeArr = dislikeArr.filter(x => !addedKeys.has(keyOf(x)))
                  if (newDislikeArr.length !== dislikeArr.length) {
                    fs.writeFileSync(dislikeFilePath, JSON.stringify(newDislikeArr, null, 2), 'utf-8')
                  }
                }
              } catch { /* ignore */ }
            }


            try {
              const { syncNativeLibraryToSubsonic } = require('./subsonic')
              syncNativeLibraryToSubsonic(username, 'artists',
                added.map((a: any) => ({ id: String(a.id), source: a.source, name: a.name })),
                removed.map((a: any) => ({ id: String(a.id), source: a.source, name: a.name })))
            } catch (e: any) { console.error('[音乐库] 反向同步 Subsonic 星标失败:', e) }
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
          } catch (e: any) { res.writeHead(400); res.end(e.message) }
        })
        return
      }

      // GET /api/user/library/albums  — 读取收藏专辑列表
      if (pathname === '/api/user/library/albums' && req.method === 'GET') {
        const username = getLibUsername(req)
        if (!username) { res.writeHead(401); res.end('Unauthorized'); return }
        const userDirname = getUserDirname(username)
        const libDir = path.join(global.lx.userPath, userDirname, 'library')
        if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true })
        const filePath = path.join(libDir, 'albums.json')
        try {
          if (!fs.existsSync(filePath)) {
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return
          }
          let arr: any[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
          if (!Array.isArray(arr)) arr = []
          // [修复] 对没有可用 picUrl 的专辑，实时从音源拉取封面并补全（best-effort，带内存缓存，单条失败不影响整体）
          // [稳健] 进程级共享并发队列与 In-flight Promise 复用，避免多请求并发/重复击穿音源接口
          const needFetch = arr.filter((a: any) => a && a.id != null && a.source &&
            !(a.picUrl && /^https?:\/\//.test(String(a.picUrl))))
          let changed = false
          if (needFetch.length) {
            await Promise.all(needFetch.map(async (a: any) => {
              try {
                const pic = await fetchAlbumPicShared(a.source, a.id)
                if (pic) { a.picUrl = pic; changed = true }
              } catch (e) { /* 忽略单个专辑的拉取失败 */ }
            }))
            // 将补全后的 picUrl 持久化回文件：每个专辑最多实时查一次，之后永久生效（重启也不再查询）
            if (changed) {
              try { fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf-8') } catch { /* ignore */ }
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(arr))
        } catch (e: any) { res.writeHead(500); res.end(e.message) }
        return
      }

      // POST /api/user/library/albums  — 完整覆盖写入收藏专辑列表
      if (pathname === '/api/user/library/albums' && req.method === 'POST') {
        const username = getLibUsername(req)
        if (!username) { res.writeHead(401); res.end('Unauthorized'); return }
        void readBody(req).then(body => {
          try {
            const parsed = JSON.parse(body)
            if (!Array.isArray(parsed)) throw new Error('Expected an array')
            const userDirname = getUserDirname(username)
            const libDir = path.join(global.lx.userPath, userDirname, 'library')
            if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true })
            const filePath = path.join(libDir, 'albums.json')
            // 反向同步：对比旧数据计算增量，回写 Subsonic 星标
            let oldArr: any[] = []
            try { if (fs.existsSync(filePath)) oldArr = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { /* ignore */ }
            const keyOf = (x: any) => `${x.source}::${String(x.id)}`
            const oldKeys = new Set(oldArr.map(keyOf))
            const newKeys = new Set(parsed.map(keyOf))
            const added = parsed.filter((x: any) => !oldKeys.has(keyOf(x)))
            const removed = oldArr.filter((x: any) => !newKeys.has(keyOf(x)))
            fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8')

            // [Mutual Exclusivity] Remove newly liked albums from the dislike list
            const dislikeLibDir = path.join(global.lx.userPath, userDirname, 'dislike', 'library')
            const dislikeFilePath = path.join(dislikeLibDir, 'albums.json')
            if (added.length > 0 && fs.existsSync(dislikeFilePath)) {
              try {
                let dislikeArr: any[] = JSON.parse(fs.readFileSync(dislikeFilePath, 'utf8'))
                if (Array.isArray(dislikeArr)) {
                  const addedKeys = new Set(added.map(keyOf))
                  const newDislikeArr = dislikeArr.filter(x => !addedKeys.has(keyOf(x)))
                  if (newDislikeArr.length !== dislikeArr.length) {
                    fs.writeFileSync(dislikeFilePath, JSON.stringify(newDislikeArr, null, 2), 'utf-8')
                  }
                }
              } catch { /* ignore */ }
            }

            try {
              const { syncNativeLibraryToSubsonic } = require('./subsonic')
              syncNativeLibraryToSubsonic(username, 'albums',
                added.map((a: any) => ({ id: String(a.id), source: a.source, name: a.name })),
                removed.map((a: any) => ({ id: String(a.id), source: a.source, name: a.name })))
            } catch (e: any) { console.error('[音乐库] 反向同步 Subsonic 星标失败:', e) }
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
          } catch (e: any) { res.writeHead(400); res.end(e.message) }
        })
        return
      }

      // --- DISLIKE LIBRARY ENDPOINTS ---

      // GET /api/user/dislike/library/artists
      if (pathname === '/api/user/dislike/library/artists' && req.method === 'GET') {
        const username = getLibUsername(req)
        if (!username) { res.writeHead(401); res.end('Unauthorized'); return }
        const userDirname = getUserDirname(username)
        const libDir = path.join(global.lx.userPath, userDirname, 'dislike', 'library')
        if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true })
        const filePath = path.join(libDir, 'artists.json')
        try {
          if (!fs.existsSync(filePath)) {
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return
          }
          let arr: any[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
          if (!Array.isArray(arr)) arr = []
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(arr))
        } catch (e: any) { res.writeHead(500); res.end(e.message) }
        return
      }

      // POST /api/user/dislike/library/artists
      if (pathname === '/api/user/dislike/library/artists' && req.method === 'POST') {
        const username = getLibUsername(req)
        if (!username) { res.writeHead(401); res.end('Unauthorized'); return }
        void readBody(req).then(async (body) => {
          try {
            const parsed = JSON.parse(body)
            if (!Array.isArray(parsed)) throw new Error('Expected an array')
            const userDirname = getUserDirname(username)
            const libDir = path.join(global.lx.userPath, userDirname, 'dislike', 'library')
            if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true })
            const filePath = path.join(libDir, 'artists.json')

            // Add dislikeRule if missing
            parsed.forEach((x: any) => {
              if (!x.dislikeRule) x.dislikeRule = `@${String(x.name)}`
            })

            let oldArr: any[] = []
            try { if (fs.existsSync(filePath)) oldArr = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { /* ignore */ }
            const keyOf = (x: any) => `${x.source}::${String(x.id)}`
            const oldKeys = new Set(oldArr.map(keyOf))
            const newKeys = new Set(parsed.map(keyOf))
            const added = parsed.filter((x: any) => !oldKeys.has(keyOf(x)))
            const removed = oldArr.filter((x: any) => !newKeys.has(keyOf(x)))

            fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8')

            // [Mutual Exclusivity] Remove newly disliked artists from the liked list
            const likeLibDir = path.join(global.lx.userPath, userDirname, 'library')
            const likeFilePath = path.join(likeLibDir, 'artists.json')
            if (added.length > 0 && fs.existsSync(likeFilePath)) {
              try {
                let likeArr: any[] = JSON.parse(fs.readFileSync(likeFilePath, 'utf8'))
                if (Array.isArray(likeArr)) {
                  const addedKeys = new Set(added.map(keyOf))
                  const newLikeArr = likeArr.filter(x => !addedKeys.has(keyOf(x)))
                  if (newLikeArr.length !== likeArr.length) {
                    fs.writeFileSync(likeFilePath, JSON.stringify(newLikeArr, null, 2), 'utf-8')
                  }
                }
              } catch { /* ignore */ }
            }

            const { invalidateDislikeCache } = require('./utils/dislikeCache')
            invalidateDislikeCache(username)

            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
          } catch (e: any) { res.writeHead(400); res.end(e.message) }
        })
        return
      }

      // GET /api/user/dislike/library/albums
      if (pathname === '/api/user/dislike/library/albums' && req.method === 'GET') {
        const username = getLibUsername(req)
        if (!username) { res.writeHead(401); res.end('Unauthorized'); return }
        const userDirname = getUserDirname(username)
        const libDir = path.join(global.lx.userPath, userDirname, 'dislike', 'library')
        if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true })
        const filePath = path.join(libDir, 'albums.json')
        try {
          if (!fs.existsSync(filePath)) {
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return
          }
          let arr: any[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
          if (!Array.isArray(arr)) arr = []
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(arr))
        } catch (e: any) { res.writeHead(500); res.end(e.message) }
        return
      }

      // POST /api/user/dislike/library/albums
      if (pathname === '/api/user/dislike/library/albums' && req.method === 'POST') {
        const username = getLibUsername(req)
        if (!username) { res.writeHead(401); res.end('Unauthorized'); return }
        void readBody(req).then(async (body) => {
          try {
            const parsed = JSON.parse(body)
            if (!Array.isArray(parsed)) throw new Error('Expected an array')
            const userDirname = getUserDirname(username)
            const libDir = path.join(global.lx.userPath, userDirname, 'dislike', 'library')
            if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true })
            const filePath = path.join(libDir, 'albums.json')

            // Add dislikeRule if missing
            parsed.forEach((x: any) => {
              if (!x.dislikeRule) x.dislikeRule = `!${String(x.name)}@${String(x.artistName || '')}`
            })

            let oldArr: any[] = []
            try { if (fs.existsSync(filePath)) oldArr = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { /* ignore */ }
            const keyOf = (x: any) => `${x.source}::${String(x.id)}`
            const oldKeys = new Set(oldArr.map(keyOf))
            const newKeys = new Set(parsed.map(keyOf))
            const added = parsed.filter((x: any) => !oldKeys.has(keyOf(x)))
            const removed = oldArr.filter((x: any) => !newKeys.has(keyOf(x)))

            fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8')

            // [Mutual Exclusivity] Remove newly disliked albums from the liked list
            const likeLibDir = path.join(global.lx.userPath, userDirname, 'library')
            const likeFilePath = path.join(likeLibDir, 'albums.json')
            if (added.length > 0 && fs.existsSync(likeFilePath)) {
              try {
                let likeArr: any[] = JSON.parse(fs.readFileSync(likeFilePath, 'utf8'))
                if (Array.isArray(likeArr)) {
                  const addedKeys = new Set(added.map(keyOf))
                  const newLikeArr = likeArr.filter(x => !addedKeys.has(keyOf(x)))
                  if (newLikeArr.length !== likeArr.length) {
                    fs.writeFileSync(likeFilePath, JSON.stringify(newLikeArr, null, 2), 'utf-8')
                  }
                }
              } catch { /* ignore */ }
            }

            const { invalidateDislikeCache } = require('./utils/dislikeCache')
            invalidateDislikeCache(username)

            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
          } catch (e: any) { res.writeHead(400); res.end(e.message) }
        })
        return
      }

      // ─── 同步下载 API ─────────────────────────────────────────────────────
      // GET /api/user/sync-download/status  查询当前用户同步下载配置 + 歌单列表 + 进度
      if (pathname === '/api/user/sync-download/status' && req.method === 'GET') {
        const reqUsername = req.headers['x-user-name'] as string
        const isPublic = !reqUsername || reqUsername === 'default' || reqUsername === '_open'
        let username: string | null = null
        if (isPublic) {
          username = '_open'
        } else {
          username = verifyUserAuth(req)
        }
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        try {
          const userSpace = getUserSpace(username)
          const listData = await userSpace.listManage.getListData()
          const syncData = getSyncDownloadData(username)
          const progress = getUserSyncProgress(username)
          // 检查是否开启了自动更新网络歌单
          const settingsPath = path.join(userSpace.dataManage.userDir, File.userSettingsJSON)
          let autoUpdateNetworkList = false
          if (fs.existsSync(settingsPath)) {
            try { autoUpdateNetworkList = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).autoUpdateNetworkList === true } catch { }
          }
          // 获取调度器网络歌单任务状态，以便提供准确的下次触发时间
          const taskStatus = scheduler.getSchedulerStatus()
          const networkTask = taskStatus.find(t => t.id === 'network_list_autocheck')
          const nextSyncTime = (autoUpdateNetworkList && networkTask?.enabled) ? (networkTask.nextRunTime || null) : null

          const getSongCoverUrl = (song: any): string => {
            if (!song) return ''
            return song.img ||
              song.pic ||
              song.picUrl ||
              song.meta?.picUrl ||
              song.meta?.pic ||
              song.meta?.albumPic ||
              song.meta?.cover ||
              song.album?.picUrl ||
              song.album?.pic ||
              song.album?.img ||
              song.otherSource?.meta?.picUrl ||
              ''
          }

          const playlists = (listData?.userList ?? []).map((l: any) => {
            let cover = l.Album || l.album || l.cover || l.pic || l.picUrl || ''
            if (!cover && Array.isArray(l.list) && l.list.length > 0) {
              for (const song of l.list) {
                const sCover = getSongCoverUrl(song)
                if (sCover) {
                  cover = sCover
                  break
                }
              }
            }
            return {
              id: l.id,
              name: l.name,
              cover: cover || null,
              source: l.source || null,
              songCount: Array.isArray(l.list) ? l.list.length : 0,
              isNetwork: !!l.sourceListId,
              syncConfig: syncData.playlists[l.id] ?? { enabled: false, lastSyncTime: null, failedSongs: [] },
            }
          })
          const storageLocation = getUserSyncStorageLocation(username)
          // 检查该用户是否启用了自定义音乐目录
          const globalCustSwitch = !!global.lx.config['user.enableCustomMusicDir']
          const userCustCfg = global.lx.config.users?.find((u: any) => u.name === username)
          const hasCustomDir = globalCustSwitch && !!userCustCfg?.enableCustomMusicDir && !!userCustCfg?.customMusicDir
          const availableLocations: string[] = ['root', 'data']
          if (hasCustomDir) availableLocations.push('custom')

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: true,
            data: {
              autoUpdateNetworkList,
              nextSyncTime,
              storageLocation,
              availableLocations,
              syncDownload: {
                enabled: syncData.enabled,
                preferredQuality: syncData.preferredQuality || '320k',
                downloadLyric: syncData.downloadLyric !== false, // 默认 true
                embedLyric: syncData.embedLyric !== false,       // 默认 true
                lastSyncTime: syncData.lastSyncTime,
                lastSyncResult: syncData.lastSyncResult,
              },
              playlists,
              progress,
            }
          }))
        } catch (e: any) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: e.message })) }
        return
      }

      // PUT /api/user/sync-download/settings  保存同步下载配置
      if (pathname === '/api/user/sync-download/settings' && req.method === 'PUT') {
        const reqUsername = req.headers['x-user-name'] as string
        const isPublic = !reqUsername || reqUsername === 'default' || reqUsername === '_open'
        let username: string | null = null
        if (isPublic) {
          if (global.lx.config['user.enablePublicRestriction']) {
            const auth = req.headers['x-frontend-auth']
            if (auth !== global.lx.config['admin.password']) {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '权限不足：公共用户受限模式下需要管理员权限' }))
              return
            }
          }
          username = '_open'
        } else {
          username = verifyUserAuth(req)
        }
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(async body => {
          try {
            const payload = JSON.parse(body)
            const syncData = getSyncDownloadData(username!)
            if (typeof payload.enabled === 'boolean') syncData.enabled = payload.enabled
            if (typeof payload.preferredQuality === 'string' && ['128k', '320k', 'flac', 'flac24bit'].includes(payload.preferredQuality)) {
              syncData.preferredQuality = payload.preferredQuality
            }
            if (typeof payload.downloadLyric === 'boolean') syncData.downloadLyric = payload.downloadLyric
            if (typeof payload.embedLyric === 'boolean') syncData.embedLyric = payload.embedLyric
            if (payload.playlists && typeof payload.playlists === 'object') {
              for (const [id, cfg] of Object.entries(payload.playlists) as any) {
                if (!syncData.playlists[id]) {
                  syncData.playlists[id] = { enabled: false, lastSyncTime: null, failedSongs: [] }
                }
                if (typeof cfg.enabled === 'boolean') syncData.playlists[id].enabled = cfg.enabled
              }
            }
            saveSyncDownloadData(username!, syncData)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (e: any) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: e.message })) }
        })
        return
      }

      // POST /api/user/sync-download/trigger  手动触发同步
      if (pathname === '/api/user/sync-download/trigger' && req.method === 'POST') {
        const reqUsername = req.headers['x-user-name'] as string
        const isPublic = !reqUsername || reqUsername === 'default' || reqUsername === '_open'
        let username: string | null = null
        if (isPublic) {
          if (global.lx.config['user.enablePublicRestriction']) {
            const auth = req.headers['x-frontend-auth']
            if (auth !== global.lx.config['admin.password']) {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '权限不足：公共用户受限模式下需要管理员权限' }))
              return
            }
          }
          username = '_open'
        } else {
          username = verifyUserAuth(req)
        }
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        try {
          const targetPlId = urlObj.searchParams.get('playlistId') || undefined
          const result = await triggerUserSync(username, targetPlId)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, ...result }))
        } catch (e: any) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: e.message })) }
        return
      }

      // POST /api/user/sync-download/cancel  取消/暂停当前同步
      if ((pathname === '/api/user/sync-download/cancel' || pathname === '/api/user/sync-download/pause') && req.method === 'POST') {
        const reqUsername = req.headers['x-user-name'] as string
        const isPublic = !reqUsername || reqUsername === 'default' || reqUsername === '_open'
        let username: string | null = null
        if (isPublic) {
          username = '_open'
        } else {
          username = verifyUserAuth(req)
        }
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        const cancelled = cancelUserSync(username)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, cancelled, message: cancelled ? '已暂停同步' : '当前无正在进行的同步' }))
        return
      }

      // GET /api/user/sync-download/progress  轮询实时进度
      if (pathname === '/api/user/sync-download/progress' && req.method === 'GET') {
        const reqUsername = req.headers['x-user-name'] as string
        const isPublic = !reqUsername || reqUsername === 'default' || reqUsername === '_open'
        let username: string | null = null
        if (isPublic) {
          username = '_open'
        } else {
          username = verifyUserAuth(req)
        }
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: getUserSyncProgress(username) }))
        return
      }

      // POST /api/user/sync-download/migrate-storage  迁移存储位置
      if (pathname === '/api/user/sync-download/migrate-storage' && req.method === 'POST') {
        const reqUsername = req.headers['x-user-name'] as string
        const isPublic = !reqUsername || reqUsername === 'default' || reqUsername === '_open'
        let username: string | null = null
        if (isPublic) {
          username = '_open'
        } else {
          username = verifyUserAuth(req)
        }
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(async body => {
          try {
            const { newLocation } = JSON.parse(body)
            if (!['root', 'data', 'custom'].includes(newLocation)) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '无效的存储位置，仅支持 root / data / custom' }))
              return
            }
            // 同步运行中不允许切换
            if (isUserSyncRunning(username!)) {
              res.writeHead(409, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '同步任务正在运行中，请先暂停同步再切换存储位置' }))
              return
            }
            // 如果选择 custom，验证该用户有自定义目录配置
            if (newLocation === 'custom') {
              const globalCustSwitch = !!global.lx.config['user.enableCustomMusicDir']
              const userCustCfg = global.lx.config.users?.find((u: any) => u.name === username)
              const hasCustomDir = globalCustSwitch && !!userCustCfg?.enableCustomMusicDir && !!userCustCfg?.customMusicDir
              if (!hasCustomDir) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: '该用户未配置自定义音乐目录' }))
                return
              }
            }

            let migrateResult: { moved: number; skipped: number; errors: number; message: string }

            // migrateSyncStorage 已支持全部三种方向（root↔data、root/data↔custom）
            migrateResult = await migrateSyncStorage(username!, newLocation as 'root' | 'data' | 'custom')

            // 保存新 storageLocation 到 data.json
            const syncData = getSyncDownloadData(username!)
            syncData.storageLocation = newLocation as 'root' | 'data' | 'custom'
            saveSyncDownloadData(username!, syncData)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, ...migrateResult }))
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message }))
          }
        })
        return
      }
      // ─────────────────────────────────────────────────────────────────────


      // [新增] Get User Settings (User Auth)
      if (pathname === '/api/user/settings' && req.method === 'GET') {
        const reqUsername = req.headers['x-user-name'] as string
        const isPublic = !reqUsername || reqUsername === 'default'
        let resolvedUsername: string | null = null

        if (isPublic && global.lx.config['user.enablePublicRestriction']) {
          resolvedUsername = '_open' // 公开受限用户允许访问 _open 空间
        } else {
          resolvedUsername = verifyUserAuth(req)
          if (!resolvedUsername) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
        }

        const userSpace = getUserSpace(resolvedUsername)
        const settingsPath = path.join(userSpace.dataManage.userDir, File.userSettingsJSON)

        if (fs.existsSync(settingsPath)) {
          const settingsData = fs.readFileSync(settingsPath, 'utf8')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(settingsData)
        } else {
          // Return empty object instead of 404 to avoid console error on fresh installs
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{}')
        }
        return
      }

      // [新增] Update User Settings (User Auth)
      if (pathname === '/api/user/settings' && req.method === 'POST') {
        const reqUsername = req.headers['x-user-name'] as string
        const isPublic = !reqUsername || reqUsername === 'default'
        let resolvedUsername: string | null = null

        if (isPublic) {
          // 公开用户：若开启了限制，需要管理员密码
          if (global.lx.config['user.enablePublicRestriction']) {
            const auth = req.headers['x-frontend-auth']
            if (auth !== global.lx.config['admin.password']) {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: '权限不足：公共用户保存设置受限，请先验证管理员身份。' }))
              return
            }
          }
          resolvedUsername = '_open'
        } else {
          resolvedUsername = verifyUserAuth(req)
          if (!resolvedUsername) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
        }

        void readBody(req).then(body => {
          try {
            const userSpace = getUserSpace(resolvedUsername!)
            const settingsPath = path.join(userSpace.dataManage.userDir, File.userSettingsJSON)

            let settings = JSON.parse(body)

            // [核心逻辑] 如果是受限的公开用户，仅允许保存特定的 3 项设置
            if (resolvedUsername === '_open' && global.lx.config['user.enablePublicRestriction']) {
              const restrictedSettings: any = {}
              const allowedKeys = ['enableServerCache', 'enableServerLyricCache', 'serverCacheLocation', 'serverCacheNamingPattern', 'downloadConcurrency', 'enableRemaster', 'preferredQuality', 'enableOnlyDownloadMode', 'enablePublicSources', 'embedLyricToFile', 'preferServerCache']
              allowedKeys.forEach(key => {
                if (settings[key] !== undefined) restrictedSettings[key] = settings[key]
              })
              settings = restrictedSettings
            }

            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')

            if (settings.serverCacheLocation !== undefined) {
              fileCache.setUserCacheLocation(resolvedUsername!, settings.serverCacheLocation)
            }
            if (settings.serverCacheNamingPattern !== undefined) {
              fileCache.setUserNamingPattern(resolvedUsername!, settings.serverCacheNamingPattern)
            }

            // 如果更新了网络歌单自动检测设置，同步更新后台任务调度器
            if (settings.networkListAutoCheckInterval !== undefined || settings.autoUpdateNetworkList !== undefined) {
              const taskConfig: { intervalMs?: number; enabled?: boolean } = {}
              if (settings.networkListAutoCheckInterval !== undefined) {
                const ms = scheduler.parseIntervalMs(settings.networkListAutoCheckInterval)
                if (ms) taskConfig.intervalMs = ms
              }
              if (settings.autoUpdateNetworkList !== undefined) {
                taskConfig.enabled = !!settings.autoUpdateNetworkList
              }
              scheduler.updateTaskConfig('network_list_autocheck', taskConfig)
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(400)
            res.end('Invalid JSON data')
          }
        })
        return
      }

      // [核心路由记录] Token 管理相关 API
      // 1. 获取/更新 Token 配置 (开启状态及列表)
      if (pathname === '/api/user/token/config') {
        const username = verifyUserAuth(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        if (req.method === 'GET') {
          const config = getUserTokenConfig(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: true,
            config: {
              enabled: config.enabled,
              tokens: config.tokens
            }
          }))
        } else if (req.method === 'POST') {
          void readBody(req).then(body => {
            try {
              const { enabled } = JSON.parse(body)
              const config = getUserTokenConfig(username)
              const newEnabled = !!enabled

              // 只有状态发生物理改变（从 True 到 False 或反之）时才处理
              if (config.enabled !== newEnabled) {
                config.enabled = newEnabled
                saveUserTokenConfig(username, config) // 这里内部会自动更新内存缓存逻辑
                tokenLog.info(`User ${username} ${newEnabled ? 'enabled' : 'disabled'} persistent token auth`)
              }

              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } catch (e) {
              res.writeHead(400)
              res.end('Invalid Body')
            }
          })
        }
        return
      }

      // 3. 生成新 Token
      if (pathname === '/api/user/token/add' && req.method === 'POST') {
        const username = verifyUserAuth(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        void readBody(req).then(body => {
          try {
            const { name, expireDays, expiresAt } = JSON.parse(body)
            const config = getUserTokenConfig(username)
            const newTokenValue = `lx_tk_${crypto.randomBytes(16).toString('hex')}`
            const newToken: UserToken = {
              name: name || '未命名 Token',
              token: newTokenValue,
              createdAt: Date.now(),
              expiresAt: (expiresAt !== undefined && expiresAt !== null) ? expiresAt : (expireDays ? Date.now() + (expireDays * 24 * 60 * 60 * 1000) : null),
              lastUsed: undefined
            }
            config.tokens.push(newToken)
            saveUserTokenConfig(username, config)
            tokenLog.info(`User ${username} generated a new token: ${name}`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, token: newTokenValue }))
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }

      // 3. 删除 Token
      if (pathname === '/api/user/token/remove' && req.method === 'POST') {
        const username = verifyUserAuth(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        void readBody(req).then(body => {
          try {
            const { token, tokenMasked } = JSON.parse(body)
            // 优先使用完整 Token 删除，兼容旧的 tokenMasked
            const target = token || tokenMasked
            if (!target) {
              res.writeHead(400)
              res.end('Missing token identifier')
              return
            }

            const config = getUserTokenConfig(username)
            const initialCount = config.tokens.length

            config.tokens = config.tokens.filter(t => {
              if (target.startsWith('lx_tk_')) {
                return t.token !== target
              }
              // 回退：使用脱敏串匹配
              const m = `${t.token.slice(0, 6)}...${t.token.slice(-4)}`
              return m !== target
            })

            if (config.tokens.length !== initialCount) {
              saveUserTokenConfig(username, config)
              tokenLog.info(`User ${username} removed a token identifier: ${target.length > 20 ? target.slice(0, 10) + '...' : target}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } else {
              // 注意：这里返回 404 表明没找到，前端会显示删除失败
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: 'Token not found' }))
            }
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }

      // 4. 更新 Token 信息 (名称/有效期)
      if (pathname === '/api/user/token/update' && req.method === 'POST') {
        const username = verifyUserAuth(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        void readBody(req).then(body => {
          try {
            const { tokenMasked, name, expireDays, expiresAt } = JSON.parse(body)
            const config = getUserTokenConfig(username)
            const tokenItem = config.tokens.find(t => {
              const masked = `${t.token.slice(0, 6)}...${t.token.slice(-4)}`
              return masked === tokenMasked
            })

            if (tokenItem) {
              if (name !== undefined) tokenItem.name = name
              if (expiresAt !== undefined) {
                tokenItem.expiresAt = expiresAt
              } else if (expireDays !== undefined) {
                tokenItem.expiresAt = expireDays ? Date.now() + (expireDays * 24 * 60 * 60 * 1000) : null
              }
              saveUserTokenConfig(username, config)
              tokenLog.info(`User ${username} updated token config: ${tokenMasked}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } else {
              res.writeHead(404)
              res.end('Token not found')
            }
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }

      // 5. 切换 Token 启用/禁用状态
      if (pathname === '/api/user/token/toggle' && req.method === 'POST') {
        const username = verifyUserAuth(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        void readBody(req).then(body => {
          try {
            const { tokenMasked, disabled } = JSON.parse(body)
            const config = getUserTokenConfig(username)
            const tokenItem = config.tokens.find(t => {
              const masked = `${t.token.slice(0, 6)}...${t.token.slice(-4)}`
              return masked === tokenMasked
            })

            if (tokenItem) {
              tokenItem.disabled = !!disabled
              saveUserTokenConfig(username, config)
              tokenLog.info(`User ${username} ${disabled ? 'disabled' : 'enabled'} token: ${tokenMasked}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: 'Token not found' }))
            }
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }

      // 5. 获取特定 Token 的审计日志
      if (pathname === '/api/user/token/logs' && req.method === 'GET') {
        const username = verifyUserAuth(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        const tokenMaskedRaw = urlObj.searchParams.get('tokenMasked')
        const tokenMasked = tokenMaskedRaw ? decodeURIComponent(tokenMaskedRaw).trim() : ''

        if (!tokenMasked) {
          res.writeHead(400)
          res.end('Missing tokenMasked')
          return
        }

        try {
          // 与写侧保持一致：token.log 由 utils/log4js.ts 的 createLogConfig 写到 `global.lx.logPath` 下
          // （容器内即 `LOG_PATH`，默认 /server/data/logs）。
          // 此前这里硬编码 `process.cwd()/logs/token.log`，与写侧不是同一目录，
          // 导致「按 tokenMasked 查 Token 日志」这个接口默认永远查不到内容。
          const logPath = path.join(global.lx.logPath, 'token.log')
          let logs: string[] = []
          if (fs.existsSync(logPath)) {
            const content = fs.readFileSync(logPath, 'utf8')
            logs = content.split('\n')
              .filter(line => line.trim().includes(tokenMasked))
              .reverse()
              .slice(0, 50)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, logs }))
        } catch (e) {
          res.writeHead(500)
          res.end('Error reading logs')
        }
        return
      }

      // [新增] Get User Sound Effects (User Auth)
      if (pathname === '/api/user/sound-effects' && req.method === 'GET') {
        const username = verifyUserAuth(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        const userSpace = getUserSpace(username)
        const soundEffectsPath = path.join(userSpace.dataManage.userDir, File.userSoundEffectsJSON)

        if (fs.existsSync(soundEffectsPath)) {
          const soundEffectsData = fs.readFileSync(soundEffectsPath, 'utf8')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(soundEffectsData)
        } else {
          // Return empty object instead of 404 to avoid console error on fresh installs
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{}')
        }
        return
      }

      // [后台任务] 获取所有后台定时任务状态
      if ((pathname === '/api/tasks/status' || pathname === '/api/music/tasks/status') && req.method === 'GET') {
        const reqUsername = req.headers['x-user-name'] as string
        const isPublic = !reqUsername || reqUsername === 'default'

        if (!isPublic && !verifyUserAuth(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        const tasks = scheduler.getSchedulerStatus()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, tasks }))
        return
      }

      // [后台任务] 手动触发后台定时任务执行
      if ((pathname === '/api/tasks/trigger' || pathname === '/api/music/tasks/trigger') && req.method === 'POST') {
        const reqUsername = req.headers['x-user-name'] as string
        const isPublic = !reqUsername || reqUsername === 'default'

        if (isPublic) {
          if (global.lx.config['user.enablePublicRestriction']) {
            const auth = req.headers['x-frontend-auth']
            if (auth !== global.lx.config['admin.password']) {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '权限不足：受限模式下需要管理员权限' }))
              return
            }
          }
        } else {
          if (!verifyUserAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
        }

        let taskId = urlObj.searchParams.get('id') || 'network_list_autocheck'
        if (taskId === 'sync_download') taskId = 'sync_download_task'
        void scheduler.executeTask(taskId).then(result => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        }).catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: err.message }))
        })
        return
      }

      // [后台任务] 通用任务用户数据接口（内存临时，重启后自动清除）
      // GET  /api/tasks/user-data?task=<taskId>  → 返回当前用户该任务的状态数据
      // POST /api/tasks/user-data?task=<taskId>  → 更新（如清除红点）
      if ((pathname === '/api/tasks/user-data' || pathname === '/api/music/tasks/user-data') &&
        (req.method === 'GET' || req.method === 'POST')) {
        const reqUsername = req.headers['x-user-name'] as string
        const isPublic = !reqUsername || reqUsername === 'default'
        let targetUser = '_open'
        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (verified) targetUser = verified
        }

        const taskId = urlObj.searchParams.get('task') || ''

        // 目前支持的任务类型：network_list_autocheck, sync_download_task
        if (taskId === 'network_list_autocheck') {
          if (req.method === 'GET') {
            const updatedListIds = getUpdatedListIds(targetUser)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, updatedListIds }))
            return
          }

          if (req.method === 'POST') {
            void readBody(req).then(body => {
              try {
                let clearId = ''
                if (typeof body === 'string') {
                  try { clearId = JSON.parse(body).listId || JSON.parse(body).id || '' } catch { clearId = body.trim() }
                } else if (body && typeof body === 'object') {
                  clearId = (body as any).listId || (body as any).id || ''
                }
                if (clearId) removeUpdatedListId(targetUser, clearId)
                const updatedListIds = getUpdatedListIds(targetUser)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: true, updatedListIds }))
              } catch (err: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: err.message }))
              }
            })
            return
          }
        }

        if (taskId === 'sync_download_task' || taskId === 'sync_download') {
          if (req.method === 'GET') {
            const syncData = getSyncDownloadData(targetUser)
            const progress = getUserSyncProgress(targetUser)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, syncData, progress }))
            return
          }

          if (req.method === 'POST') {
            void readBody(req).then(async body => {
              try {
                let action = ''
                if (typeof body === 'string') {
                  try { action = JSON.parse(body).action || '' } catch { }
                } else if (body && typeof body === 'object') {
                  action = (body as any).action || ''
                }
                if (action === 'trigger') {
                  const result = await triggerUserSync(targetUser)
                  res.writeHead(200, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ success: true, ...result }))
                } else {
                  res.writeHead(200, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ success: true }))
                }
              } catch (err: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: err.message }))
              }
            })
            return
          }
        }

        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: '未知任务或不支持的操作' }))
        return
      }

      // [新增] Update User Sound Effects (User Auth)
      if (pathname === '/api/user/sound-effects' && req.method === 'POST') {
        const username = verifyUserAuth(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        void readBody(req).then(body => {
          try {
            const userSpace = getUserSpace(username)
            const soundEffectsPath = path.join(userSpace.dataManage.userDir, File.userSoundEffectsJSON)

            // Validate JSON
            JSON.parse(body)

            fs.writeFileSync(soundEffectsPath, body, 'utf8')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(400)
            res.end('Invalid JSON data')
          }
        })
        return
      }

      // Local music remaster APIs use the same account access rules as other cache operations.
      if (pathname.startsWith('/api/music/remaster/')) {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        if (pathname === '/api/music/remaster/start' && req.method === 'POST') {
          try {
            const body = JSON.parse(await readBody(req))
            const explicitIsCustomDir = body?.isCustomDir === undefined ? undefined : Boolean(body?.isCustomDir)

            if (explicitIsCustomDir) {
              const userCfg = getUserConfig(username)
              if (!userCfg?.allowOperateCustomMusicDir) {
                res.writeHead(403, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: '管理员未允许操作自定义目录中的文件' }))
                return
              }
            }

            const data = await remasterQueue.start(username, String(body?.targetQuality || ''), body?.filenames, explicitIsCustomDir)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err?.message || '启动洗版失败' }))
          }
          return
        }

        if (pathname === '/api/music/remaster/status' && req.method === 'GET') {
          const offset = Number(urlObj.searchParams.get('offset') || 0)
          const limit = Number(urlObj.searchParams.get('limit') || 200)
          const data = remasterQueue.getStatus(username, offset, limit)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data }))
          return
        }

        if (pathname === '/api/music/remaster/cancel' && req.method === 'POST') {
          const cancelled = remasterQueue.cancel(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: { cancelled } }))
          return
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: 'Not Found' }))
        return
      }

      // [新增] File Cache APIs
      // 1. Config Cache Location
      if (pathname === '/api/music/cache/config' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        // 具名用户必须通过 Token（或兼容密码）验证身份
        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        void readBody(req).then(async body => {
          try {
            const { location, namingPattern } = JSON.parse(body)
            let updated = false

            const userSpace = getUserSpace(username)
            const settingsPath = path.join(userSpace.dataManage.userDir, File.userSettingsJSON)
            let userSettings: any = {}
            if (fs.existsSync(settingsPath)) {
              try {
                userSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
              } catch (e) { }
            }

            if (location) {
              if (location !== fileCache.getUserCacheLocation(username)) {
                // 公开用户：需要管理员密码才能修改
                if (isPublic && global.lx.config['user.enablePublicRestriction']) {
                  const auth = req.headers['x-frontend-auth']
                  if (auth !== global.lx.config['admin.password']) {
                    res.writeHead(403, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ success: false, error: '权限不足：公共用户修改缓存位置受限，请输入管理员密码。' }))
                    return
                  }
                }
                fileCache.setUserCacheLocation(username, location)
                userSettings.serverCacheLocation = location
                updated = true
              }
            }

            if (namingPattern) {
              const normalizedNamingPattern = fileCache.setUserNamingPattern(username, namingPattern)
              userSettings.serverCacheNamingPattern = normalizedNamingPattern
              updated = true
            }

            if (updated) {
              fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2), 'utf8')
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true, message: 'No changes' }))
            }
          } catch (e) {
            res.writeHead(500)
            res.end('Error')
          }
        })
        return
      }

      // 1.05 Get Real Cache & Download Directories
      if (pathname === '/api/music/cache/directories' && req.method === 'GET') {
        const parsedUrl = url.parse(req.url || '', true)
        const locationQuery = (parsedUrl.query.location as string) || undefined
        const onlyDownloadQuery = parsedUrl.query.onlyDownload === 'true' || parsedUrl.query.onlyDownload === '1'

        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        const effectiveLocation = locationQuery || fileCache.getUserCacheLocation(username)
        const cacheDir = fileCache.getCacheDir(username, false, effectiveLocation)
        const downloadDir = fileCache.getCacheDir(username, true, effectiveLocation)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          data: {
            username,
            location: effectiveLocation,
            isOnlyDownloadMode: onlyDownloadQuery,
            isSameDirectory: !onlyDownloadQuery,
            cacheDirectory: cacheDir,
            downloadDirectory: onlyDownloadQuery ? downloadDir : cacheDir,
            rawDownloadDirectory: downloadDir,
            rootType: effectiveLocation === 'data' ? 'DATA_PATH (WebDAV同步)' : '运行目录 (仅本地)',
            isWebDAVSynced: effectiveLocation === 'data'
          }
        }))
        return
      }

      // 1.1 Sync Cache Index
      if (pathname === '/api/music/cache/sync' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        try {
          await fileCache.syncCacheIndex(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, message: 'Sync completed' }))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Sync failed: ' + (e as any).message }))
        }
        return
      }

      // 1.1-B Get Subdirectories
      if (pathname === '/api/music/cache/subdirs' && req.method === 'GET') {
        const reqUsername = (req.headers['x-user-name'] as string) || urlObj.searchParams.get('user') || ''
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        const folder = (urlObj.searchParams.get('folder') as 'cache' | 'music') || 'music'
        const subdirs = fileCache.getSubDirectories(username, folder)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: subdirs }))
        return
      }

      // 1.1-C Create Subdirectory
      if (pathname === '/api/music/cache/mkdir' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        void readBody(req).then(body => {
          try {
            const { folder, subPath } = JSON.parse(body)
            if (!folder || !subPath) {
              res.writeHead(400)
              res.end('Missing params')
              return
            }
            const success = fileCache.createSubDirectory(username, folder, subPath)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success }))
          } catch (e) {
            res.writeHead(500)
            res.end('Error')
          }
        })
        return
      }

      // 1.1-D Categorize Files
      if (pathname === '/api/music/cache/categorize' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        void readBody(req).then(async body => {
          try {
            const { filenames, subPath } = JSON.parse(body)
            if (!Array.isArray(filenames)) {
              res.writeHead(400)
              res.end('Missing params')
              return
            }
            const result = await fileCache.categorizeFiles(filenames, subPath, username)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, ...result }))
          } catch (e) {
            res.writeHead(500)
            res.end('Error')
          }
        })
        return
      }

      // 1.1-E Rename Subdirectory
      if (pathname === '/api/music/cache/subdirs/rename' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const auth = req.headers['x-frontend-auth']
        const isAdmin = !!(auth && auth === global.lx.config['admin.password'])
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        if (isPublic) {
          if (!isAdmin) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: '权限不足：修改公共本地分类需要验证管理员权限。' }))
            return
          }
        } else {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        void readBody(req).then(body => {
          try {
            const { folder = 'music', oldSubPath, newSubPath } = JSON.parse(body)
            if (!oldSubPath || !newSubPath) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '缺少参数' }))
              return
            }
            const result = fileCache.renameSubDirectory(username, folder, oldSubPath.trim(), newSubPath.trim())
            res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e?.message || 'Server error' }))
          }
        })
        return
      }

      // 检查文件夹是否有效
      if (pathname === '/api/utils/check-dir' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(body => {
          try {
            const { dirPath } = JSON.parse(body)
            if (!dirPath || typeof dirPath !== 'string' || !dirPath.trim()) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '请输入路径' }))
              return
            }
            const absolutePath = path.resolve(dirPath.trim())
            if (!fs.existsSync(absolutePath)) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '目录不存在，请检查路径是否正确' }))
              return
            }
            const stat = fs.statSync(absolutePath)
            if (!stat.isDirectory()) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '指定路径不是一个有效的目录' }))
              return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, message: '目录可用', path: absolutePath }))
          } catch (e: any) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e?.message || '检测目录发生错误' }))
          }
        })
        return
      }

      // 1.1-F Delete Subdirectory
      if (pathname === '/api/music/cache/subdirs/delete' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const auth = req.headers['x-frontend-auth']
        const isAdmin = !!(auth && auth === global.lx.config['admin.password'])
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        if (isPublic) {
          if (!isAdmin) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: '权限不足：删除公共本地分类需要验证管理员权限。' }))
            return
          }
        } else {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        void readBody(req).then(body => {
          try {
            const { folder = 'music', subPath, deleteSongs = false } = JSON.parse(body)
            if (!subPath) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '缺少 subPath 参数' }))
              return
            }
            const result = fileCache.deleteSubDirectory(username, folder, subPath.trim(), !!deleteSongs)
            res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e?.message || 'Server error' }))
          }
        })
        return
      }

      // 1.2 Batch Rename Cache Files
      if (pathname === '/api/music/cache/rename' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        try {
          const result = await fileCache.batchRenameCacheFiles(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Rename failed: ' + (e as any).message }))
        }
        return
      }

      // 2. Check Cache
      if (pathname === '/api/music/cache/check' && req.method === 'GET') {
        const name = urlObj.searchParams.get('name')
        const singer = urlObj.searchParams.get('singer')
        const source = urlObj.searchParams.get('source')
        const songmid = urlObj.searchParams.get('songmid')
        const songId = urlObj.searchParams.get('songId')
        const quality = urlObj.searchParams.get('quality')
        const exactQuality = urlObj.searchParams.get('exactQuality') === '1' || urlObj.searchParams.get('exactQuality') === 'true'

        if (!name || !singer || !source || (!songmid && !songId)) {
          res.writeHead(400)
          res.end('Missing params')
          return
        }

        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        const result = fileCache.checkCache({ name, singer, source, songmid, songId, quality, exactQuality }, username)
        if (result && result.exists && username !== '_open' && username !== 'default') {
          const token = req.headers['x-user-token']
          if (token) {
            result.url += `&token=${encodeURIComponent(token as string)}`
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      // 缓存来源体检：逐条核验缓存音频与曲目是不是同一首，专门识别「音源对失效 ID 兜底返回别曲」。
      // GET 永远是 dry-run（只出报告）；删除必须走 POST + {"confirm":true}。
      // 误删用户缓存不可逆，所以默认行为只能是「报告」，不能是「清理」。
      if (pathname === '/api/music/cache/audit' && (req.method === 'GET' || req.method === 'POST')) {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        if (cacheAuditRunning) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: '体检正在进行中，完成后再试' }))
          return
        }
        let payload: any = {}
        if (req.method === 'POST') {
          try { payload = JSON.parse((await readBody(req)) || '{}') } catch { payload = {} }
        }
        const rawLimit = req.method === 'POST' ? payload?.limit : urlObj.searchParams.get('limit')
        const limit = Math.max(0, Number(rawLimit) || 0)
        const apply = req.method === 'POST' && payload?.confirm === true

        // 全量 dry-run 的结果复用（启动时已跑过一次），避免每次刷新页面都重新解码几十个文件
        if (req.method === 'GET' && limit === 0 && lastCacheAudit && Date.now() - lastCacheAudit.at < 10 * 60 * 1000) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
          res.end(JSON.stringify({ success: true, cachedReport: true, ...lastCacheAudit.report }))
          return
        }

        cacheAuditRunning = true
        try {
          const report = await fileCache.auditCache({ username, limit, apply, intervalMs: 150 })
          // 明细只回非 clean 的：全绿时返回 37 条「没问题」对排查没有信息量
          const publicItems = report.items.filter(item => item.verdict !== 'clean')
          // 缓存用的也得是过滤后的版本，否则下次走 cachedReport 分支又会把全量明细吐出来
          if (!apply && limit === 0) lastCacheAudit = { at: Date.now(), report: { ...report, items: publicItems } }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
          res.end(JSON.stringify({
            success: true,
            ...report,
            items: publicItems,
          }))
        } catch (error: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: error?.message || '体检失败' }))
        } finally {
          cacheAuditRunning = false
        }
        return
      }

      // Persistent server download queue. These tasks continue after the browser closes.
      if (pathname === '/api/music/cache/queue' && req.method === 'GET') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: serverDownloadQueue.list(username) }))
        return
      }

      if (pathname === '/api/music/cache/queue' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        const auth = req.headers['x-frontend-auth']
        const isPublic = username === '_open'
        const isAdmin = auth === global.lx.config['admin.password'] || username === 'admin'
        const enablePublicRestriction = global.lx.config['user.enablePublicRestriction']
        const isServerCacheAllowed = global.lx.config['user.enablePublicNonAdminServerCache'] !== false

        if (enablePublicRestriction && !isServerCacheAllowed && isPublic && !isAdmin) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: '权限限制：非管理员服务器缓存已被禁用' }))
          return
        }

        void readBody(req).then(body => {
          try {
            const { tasks, namingPattern, concurrency } = JSON.parse(body)
            if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Missing tasks')
            if (concurrency !== undefined) serverDownloadQueue.setConcurrency(username, concurrency)
            if (namingPattern) {
              const auth = req.headers['x-frontend-auth']
              if (auth === global.lx.config['admin.password']) {
                const normalizedNamingPattern = fileCache.setNamingPattern(namingPattern)
                if (global.lx.config) global.lx.config['cache.namingPattern'] = normalizedNamingPattern
              }
            }
            const queued = serverDownloadQueue.enqueue(username, tasks)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: queued }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message || 'Invalid queue request' }))
          }
        })
        return
      }

      if (pathname === '/api/music/cache/queue/concurrency' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(body => {
          try {
            const { concurrency } = JSON.parse(body)
            const savedConcurrency = serverDownloadQueue.setConcurrency(username, concurrency)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: { concurrency: savedConcurrency } }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message || 'Invalid concurrency' }))
          }
        })
        return
      }

      if (pathname === '/api/music/cache/queue/resume' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(body => {
          try {
            const { id, all } = JSON.parse(body)
            if (all !== true && !id) throw new Error('Missing queue task id')
            serverDownloadQueue.resume(username, all ? undefined : id)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message }))
          }
        })
        return
      }

      if (pathname === '/api/music/cache/queue/remove' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(body => {
          try {
            const options = JSON.parse(body)
            if (!options || (options.all !== true && options.completed !== true && !options.id)) throw new Error('Missing queue removal option')
            serverDownloadQueue.remove(username, options)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message }))
          }
        })
        return
      }

      // 3. Trigger Download
      if (pathname === '/api/music/cache/download' && req.method === 'POST') {
        void readBody(req).then(body => {
          try {
            const { songInfo, url, quality, enableOnlyDownloadMode, namingPattern, cacheLyric, embedLyric, requestedSource, downloadSource, sourceName } = JSON.parse(body)
            if (!songInfo || !url) {
              res.writeHead(400)
              res.end('Missing params')
              return
            }

            // Fire and forget (background download) with Abort support
            const reqUsername = (req.headers['x-user-name'] as string) || ''
            const isPublic = !reqUsername || reqUsername === 'default'
            let username = '_open'

            if (!isPublic) {
              const verified = verifyUserAuth(req)
              if (!verified) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
                return
              }
              username = verified
            }

            const auth = req.headers['x-frontend-auth']
            const isAdmin = auth === global.lx.config['admin.password'] || username === 'admin'
            const enablePublicRestriction = global.lx.config['user.enablePublicRestriction']
            const isServerCacheAllowed = global.lx.config['user.enablePublicNonAdminServerCache'] !== false

            if (enablePublicRestriction && !isServerCacheAllowed && isPublic && !isAdmin) {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '权限限制：非管理员服务器缓存已被禁用' }))
              return
            }
            if (namingPattern) {
              const auth = req.headers['x-frontend-auth']
              if (auth === global.lx.config['admin.password']) {
                const normalizedNamingPattern = fileCache.setNamingPattern(namingPattern)
                if (global.lx.config) global.lx.config['cache.namingPattern'] = normalizedNamingPattern
              }
            }
            const songKey = fileCache.normalizeSongId(songInfo) + '_' + (quality || 'unknown')

            console.log(`[文件缓存] 注册下载任务: ${songKey} (用户: "${username}")`)

            const controller = new AbortController()
            let userTasks = fileCache.activeTasks.get(username)
            if (!userTasks) {
              userTasks = []
              fileCache.activeTasks.set(username, userTasks)
            }
            userTasks.push({ songKey, controller })

            void fileCache.downloadAndCache(songInfo, url, quality, username, controller.signal, !!enableOnlyDownloadMode, cacheLyric !== false, embedLyric !== false, {
              requestedSource: requestedSource || songInfo.source,
              downloadSource,
              sourceName,
            })
              .then(() => console.log(`[文件缓存] 已成功下载 ${songInfo.name} (用户: ${username || '_open'})`))
              .catch((err: any) => {
                if (err.message === 'Aborted') {
                  console.log(`[文件缓存] 任务已取消: ${songInfo.name}`)
                } else {
                  console.error(`[文件缓存] 下载歌曲失败 (${songInfo.name}):`, err)
                }
              })
              .finally(() => {
                // Cleanup active task
                const tasks = fileCache.activeTasks.get(username)
                if (tasks) {
                  const idx = tasks.findIndex(t => t.songKey === songKey)
                  if (idx !== -1) {
                    tasks.splice(idx, 1)
                    console.log(`[文件缓存] 清理已完成任务: ${songKey} (用户: "${username}")`)
                  }
                }
              })

            res.writeHead(200)
            res.end(JSON.stringify({ success: true, message: 'Download started' }))
          } catch (e) {
            res.writeHead(500)
            res.end('Error')
          }
        })
        return
      }

      // [New] Stop Cache Task
      if (pathname === '/api/music/cache/stop' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        void readBody(req).then(body => {
          try {
            const { songKey, queueId, all } = JSON.parse(body)
            if (all) {
              fileCache.stopUserTasks(username)
              serverDownloadQueue.pause(username)
              console.log(`[文件缓存] 已停止用户 ${username} 的所有下载任务`)
            } else if (queueId) {
              serverDownloadQueue.pause(username, queueId)
              console.log(`[文件缓存] 已暂停队列任务 ${queueId} (用户: ${username})`)
            } else if (songKey) {
              fileCache.stopUserTasks(username, songKey)
              console.log(`[文件缓存] 已停止任务 ${songKey} (用户: ${username})`)
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }

      // 4. Serve Cached File
      if (pathname.startsWith('/api/music/cache/file/')) {
        const parts = pathname.replace('/api/music/cache/file/', '').split('/')
        const reqUsername = parts.length > 1 ? decodeURIComponent(parts[0]) : '_open'
        const filename = parts.length > 1 ? parts[1] : parts[0]

        if (filename) {
          let username = '_open'
          const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'

          if (!isPublic) {
            const urlToken = urlObj.searchParams.get('token')
            if (urlToken && !req.headers['x-user-token']) {
              (req.headers as any)['x-user-token'] = urlToken
            }
            if (reqUsername && !req.headers['x-user-name']) {
              (req.headers as any)['x-user-name'] = reqUsername
            }
            const verified = verifyUserAuth(req)
            if (!verified) {
              res.writeHead(401)
              res.end('Unauthorized')
              return
            }
            username = verified
          }
          const folderParam = urlObj.searchParams.get('folder')
          const requestedFolder = folderParam === 'cache' || folderParam === 'music' ? folderParam as fileCache.CacheFolder : undefined
          fileCache.serveCacheFile(req, res, decodeURIComponent(filename), username, requestedFolder)
          return
        }
      }

      // 5. Get Cache Statistics
      if (pathname === '/api/music/cache/stats' && req.method === 'GET') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        try {
          const stats = fileCache.getCacheStats(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: stats }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || 'Failed to get cache stats' }))
        }
        return
      }

      if (pathname === '/api/music/cache/clear' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        try {
          const result = fileCache.clearAllCache(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: result }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || 'Failed to clear cache' }))
        }
        return
      }

      if (pathname === '/api/music/cache/lyric/clear' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        try {
          const result = fileCache.clearLyricCache(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: result }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || 'Failed to clear lyric cache' }))
        }
        return
      }

      // 6.5 未引用歌词（孤儿 .lrc）扫描与删除
      if (pathname === '/api/music/cache/lyric/orphans' && req.method === 'GET') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        try {
          const data = fileCache.listOrphanLyrics(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || 'Failed to list orphan lyrics' }))
        }
        return
      }

      if (pathname === '/api/music/cache/lyric/orphans/delete' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        void readBody(req).then(body => {
          try {
            const payload = JSON.parse(body)
            const rawItems = Array.isArray(payload.items) ? payload.items : []
            if (rawItems.length === 0) throw new Error('Missing items')
            const items = rawItems.map((item: any) => {
              if (typeof item === 'string') return { filename: item }
              if (!item || typeof item.filename !== 'string') throw new Error('Invalid item')
              if (item.folder !== undefined && item.folder !== 'cache' && item.folder !== 'music') throw new Error('Invalid folder')
              return { filename: item.filename, folder: item.folder }
            })
            const result = fileCache.deleteOrphanLyrics(items, username)
            accessLog.info(`orphan lyrics deleted user=${username} count=${result.deletedCount} failures=${result.failures.length}`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: result.failures.length === 0, data: result }))
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message || 'Bad Request' }))
          }
        })
        return
      }

      // 7. Get Cache Progress
      if (pathname === '/api/music/cache/progress' && req.method === 'GET') {
        const ids = urlObj.searchParams.get('ids')?.split(',') || []
        const progress: any = {}
        ids.forEach(id => {
          if (fileCache.cacheProgress.has(id)) {
            progress[id] = fileCache.cacheProgress.get(id)
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: progress }))
        return
      }

      // 7. Get Detailed Cache List
      if (pathname === '/api/music/cache/list' && req.method === 'GET') {
        const targetUserParam = urlObj.searchParams.get('user')
        const reqUsername = targetUserParam || (req.headers['x-user-name'] as string) || ''
        const auth = req.headers['x-frontend-auth']
        const isAdmin = !!(auth && auth === global.lx.config['admin.password'])
        const isPublic = !reqUsername || reqUsername === 'default' || reqUsername === '_open' || targetUserParam === '_open'
        let username = '_open'

        if (isPublic) {
          const enablePublicNonAdminLocalMusic = !!global.lx.config['user.enablePublicNonAdminLocalMusic']
          const verified = verifyUserAuth(req)
          if (!enablePublicNonAdminLocalMusic && !isAdmin && !verified) {
            res.writeHead(403, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
            })
            res.end(JSON.stringify({ success: false, message: '您没有权限查看此目录，请联系管理员设置' }))
            return
          }
          username = '_open'
        } else {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
            })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        void fileCache.getCacheList(username).then(list => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          })
          res.end(JSON.stringify({ success: true, data: list }))
        }).catch(err => {
          res.writeHead(500)
          res.end(err.message)
        })
        return
      }

      // 8. Get Cache Cover
      if (pathname === '/api/music/cache/cover' && req.method === 'GET') {
        const reqUsername = (req.headers['x-user-name'] as string) || urlObj.searchParams.get('user') || ''
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          // <img src> 无法携带自定义请求头，允许从 URL ?token= 参数读取 Token 作为补偿
          const urlToken = urlObj.searchParams.get('token')
          if (urlToken && !req.headers['x-user-token']) {
            (req.headers as any)['x-user-token'] = urlToken
          }
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401)
            res.end('Unauthorized')
            return
          }
          username = verified
        }
        const filename = urlObj.searchParams.get('filename')
        if (!filename) {
          res.writeHead(400)
          res.end('Missing filename')
          return
        }
        const cover = await fileCache.getCacheCover(filename, username) as any
        if (cover && cover.data) {
          res.writeHead(200, {
            'Content-Type': cover.mime || 'image/jpeg',
            'Cache-Control': 'public, max-age=86400'
          })
          res.end(cover.data)
        } else {
          // Fallback to logo or 404
          res.writeHead(404)
          res.end('Not Found')
        }
        return
      }

      // 9. Remove Cache File (Single or Batch)
      if (pathname === '/api/music/cache/remove' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const auth = req.headers['x-frontend-auth']
        const isAdmin = !!(auth && auth === global.lx.config['admin.password'])
        const isPublic = !reqUsername || reqUsername === 'default' || reqUsername === '_open'
        let username = '_open'

        if (isPublic) {
          if (!isAdmin) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: '权限不足：删除公共本地歌曲需要验证管理员权限。' }))
            return
          }
        } else {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        void readBody(req).then(body => {
          try {
            const payload = JSON.parse(body)
            const legacyFilenames = payload.filenames
            const rawItems = Array.isArray(payload.items)
              ? payload.items
              : (legacyFilenames ? (Array.isArray(legacyFilenames) ? legacyFilenames : [legacyFilenames]) : [])
            if (rawItems.length === 0) throw new Error('Missing items')

            const deleteItems: Array<{ filename: string; folder?: fileCache.CacheFolder }> = rawItems.map((item: any) => {
              if (typeof item === 'string') return { filename: item }
              if (!item || typeof item.filename !== 'string') throw new Error('Invalid delete item')
              if (item.folder !== undefined && item.folder !== 'cache' && item.folder !== 'music') {
                throw new Error('Invalid folder')
              }
              return { filename: item.filename, folder: item.folder }
            })

            let deletedCount = 0
            const failures: Array<{ filename: string; folder?: fileCache.CacheFolder; message: string }> = []
            for (const item of deleteItems) {
              try {
                const result = fileCache.removeCacheFile(item.filename, username, item.folder)
                if (result.deleted) {
                  deletedCount++
                  accessLog.info(`music file deleted user=${username} folder=${result.folder} filename=${JSON.stringify(item.filename)}`)
                } else {
                  failures.push({ ...item, message: 'File not found' })
                }
              } catch (error: any) {
                failures.push({ ...item, message: error?.message || 'Delete failed' })
                accessLog.warn(`music file delete rejected user=${username} folder=${item.folder || 'unspecified'} filename=${JSON.stringify(item.filename)} reason=${JSON.stringify(error?.message || 'Delete failed')}`)
              }
            }

            const success = failures.length === 0
            const statusCode = success ? 200 : (deletedCount > 0 ? 207 : 409)
            res.writeHead(statusCode, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              success,
              deletedCount,
              failedCount: failures.length,
              failures,
              message: success ? undefined : failures[0]?.message,
            }))
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message }))
          }
        })
        return
      }

      // ===== [新增] Custom Music APIs (独立于 cache/music) =====
      // A. 获取自定义目录歌曲列表
      if (pathname === '/api/music/custom/list' && req.method === 'GET') {
        const verified = verifyUserAuth(req)
        if (!verified) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        const userCfg = getUserConfig(verified)
        void customMusicManager.getCustomMusicList(verified).then(list => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          })
          res.end(JSON.stringify({
            success: true,
            data: list,
            allowOperateCustomMusicDir: !!userCfg?.allowOperateCustomMusicDir,
            allowWriteCustomMusicDir: !!userCfg?.allowWriteCustomMusicDir
          }))
        }).catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: err.message }))
        })
        return
      }

      // B. 强制重新同步自定义目录
      if (pathname === '/api/music/custom/sync' && req.method === 'POST') {
        const verified = verifyUserAuth(req)
        if (!verified) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void customMusicManager.syncCustomIndex(verified).then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, message: 'Sync completed' }))
        }).catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: err.message }))
        })
        return
      }

      // C. 流式播放自定义音频文件（支持深层子目录相对路径）
      if (pathname === '/api/music/custom/file' || pathname.startsWith('/api/music/custom/file/')) {
        let rawFilename = urlObj.searchParams.get('filename')
        let reqUsername = urlObj.searchParams.get('user') || ''

        if (!rawFilename && pathname.startsWith('/api/music/custom/file/')) {
          const rest = pathname.substring('/api/music/custom/file/'.length)
          try {
            rawFilename = decodeURIComponent(rest)
          } catch (e) {
            rawFilename = rest
          }
        }

        if (rawFilename) {
          const urlToken = urlObj.searchParams.get('token')
          if (urlToken && !req.headers['x-user-token']) {
            (req.headers as any)['x-user-token'] = urlToken
          }
          if (reqUsername && !req.headers['x-user-name']) {
            (req.headers as any)['x-user-name'] = reqUsername
          }
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401)
            res.end('Unauthorized')
            return
          }
          customMusicManager.serveCustomFile(req, res, rawFilename, verified)
          return
        }
      }

      // D. 获取自定义目录封面
      if (pathname === '/api/music/custom/cover' && req.method === 'GET') {
        const reqUsername = (req.headers['x-user-name'] as string) || urlObj.searchParams.get('user') || ''
        const urlToken = urlObj.searchParams.get('token')
        if (urlToken && !req.headers['x-user-token']) {
          (req.headers as any)['x-user-token'] = urlToken
        }
        if (reqUsername && !req.headers['x-user-name']) {
          (req.headers as any)['x-user-name'] = reqUsername
        }
        const verified = verifyUserAuth(req)
        if (!verified) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }
        const filename = urlObj.searchParams.get('filename')
        if (!filename) {
          res.writeHead(400)
          res.end('Missing filename')
          return
        }
        const cover = await customMusicManager.getCustomCover(filename, verified)
        if (cover && cover.data) {
          res.writeHead(200, {
            'Content-Type': cover.mime || 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
          })
          res.end(cover.data)
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
        return
      }

      // E. 删除自定义目录中的歌曲（受 allowOperateCustomMusicDir 限制）
      if (pathname === '/api/music/custom/remove' && req.method === 'POST') {
        const verified = verifyUserAuth(req)
        if (!verified) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        const userCfg = getUserConfig(verified)
        if (!userCfg?.allowOperateCustomMusicDir) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: '管理员未允许操作或删除自定义目录中的文件' }))
          return
        }

        void readBody(req).then(body => {
          try {
            const payload = JSON.parse(body)
            const rawItems = Array.isArray(payload.items)
              ? payload.items
              : (payload.filenames ? (Array.isArray(payload.filenames) ? payload.filenames : [payload.filenames]) : [])

            let deletedCount = 0
            for (const item of rawItems) {
              const filename = typeof item === 'string' ? item : item?.filename
              if (filename && customMusicManager.removeCustomFile(filename, verified)) {
                deletedCount++
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, deletedCount }))
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message }))
          }
        })
        return
      }

      // F. 手动关联自定义目录歌曲
      if (pathname === '/api/music/custom/link' && req.method === 'POST') {
        const verified = verifyUserAuth(req)
        if (!verified) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        const userCfg = getUserConfig(verified)
        if (!userCfg?.allowWriteCustomMusicDir) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: '管理员未允许操作自定义目录中的文件' }))
          return
        }

        void readBody(req).then(async body => {
          try {
            const { filename, songInfo } = JSON.parse(body)
            if (!filename || !songInfo) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: 'Missing params' }))
              return
            }

            const result = await customMusicManager.linkCustomSong(filename, songInfo, verified)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message || 'Linking failed' }))
          }
        })
        return
      }

      // G. 批量补全自定义目录元信息（封面与ID3）
      if (pathname === '/api/music/custom/updateMetadata' && req.method === 'POST') {
        const verified = verifyUserAuth(req)
        if (!verified) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        const userCfg = getUserConfig(verified)
        if (!userCfg?.allowWriteCustomMusicDir) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: '管理员未允许写入自定义目录中的歌曲文件' }))
          return
        }

        void readBody(req).then(async body => {
          try {
            const { filenames } = JSON.parse(body)
            if (!filenames) throw new Error('Missing filenames')
            const fileList = Array.isArray(filenames) ? filenames : [filenames]
            const result = await customMusicManager.batchUpdateMetadata(fileList, verified)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, ...result }))
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message }))
          }
        })
        return
      }

      // H-GET. 读取自定义目录音频文件内嵌歌词（供播放时使用）
      if (pathname === '/api/music/custom/embedLyric' && req.method === 'GET') {
        const verified = verifyUserAuth(req)
        if (!verified) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        const filename = urlObj.searchParams.get('filename') || ''
        if (!filename) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Missing filename' }))
          return
        }
        try {
          const customDir = customMusicManager.getCustomMusicDir(verified)
          if (!customDir) throw new Error('未配置自定义目录')
          const filePath = path.resolve(customDir, filename)
          // 安全检查：防止路径穿越
          if (!filePath.startsWith(path.resolve(customDir))) throw new Error('非法路径')
          if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: '文件不存在' }))
            return
          }
          const { MusicTagger: MT } = require('music-tag-native')
          const tagger = new MT()
          tagger.loadPath(filePath)
          const lrc = tagger.lyrics || ''
          tagger.dispose()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, lrc }))
        } catch (e: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || '读取内嵌歌词失败' }))
        }
        return
      }

      // H. 批量将歌词嵌入自定义目录音频标签 (USLT)
      if (pathname === '/api/music/custom/embedLyric' && req.method === 'POST') {
        const verified = verifyUserAuth(req)
        if (!verified) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        const userCfg = getUserConfig(verified)
        if (!userCfg?.allowWriteCustomMusicDir) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: '管理员未允许写入自定义目录中的歌曲文件' }))
          return
        }

        void readBody(req).then(async body => {
          try {
            const { filenames } = JSON.parse(body)
            if (!filenames || !Array.isArray(filenames)) throw new Error('Missing filenames')
            const result = await customMusicManager.batchEmbedLyric(filenames, verified)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, ...result }))
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message }))
          }
        })
        return
      }
      // ===== [结束] Custom Music APIs =====

      // [New] Batch Move Files between folders
      if (pathname === '/api/music/cache/move' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401)
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        void readBody(req).then(async body => {
          try {
            const { filenames } = JSON.parse(body)
            if (!filenames) throw new Error('Missing filenames')
            const fileList = Array.isArray(filenames) ? filenames : [filenames]

            const result = await fileCache.switchFolder(fileList, username)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, ...result }))
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }

      // [New] WebDAV/Base Location switch
      if (pathname === '/api/music/cache/switch-base' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401)
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        void readBody(req).then(async body => {
          try {
            const { filenames } = JSON.parse(body)
            if (!filenames) throw new Error('Missing filenames')
            const fileList = Array.isArray(filenames) ? filenames : [filenames]

            const result = await fileCache.switchBaseLocation(fileList, username)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, ...result }))
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }



      // 10. Update Metadata (Batch)
      if (pathname === '/api/music/cache/updateMetadata' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        void readBody(req).then(async body => {
          try {
            const { filenames } = JSON.parse(body)
            if (!filenames) throw new Error('Missing filenames')

            const fileList = Array.isArray(filenames) ? filenames : [filenames]
            const result = await fileCache.batchUpdateMetadata(fileList, username)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, ...result }))
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }

      // [新增-GET] 读取本地缓存音频文件内嵌歌词（供播放时使用）
      if (pathname === '/api/music/cache/embedLyric' && req.method === 'GET') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'
        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        const filename = urlObj.searchParams.get('filename') || ''
        const folder = (urlObj.searchParams.get('folder') || 'cache') as 'cache' | 'music'
        if (!filename) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Missing filename' }))
          return
        }
        try {
          const dir = fileCache.getCacheDir(username, folder === 'music')
          const filePath = path.join(dir, filename)
          if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: '文件不存在' }))
            return
          }
          const { MusicTagger: MT } = require('music-tag-native')
          const tagger = new MT()
          tagger.loadPath(filePath)
          const lrc = tagger.lyrics || ''
          tagger.dispose()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, lrc }))
        } catch (e: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || '读取内嵌歌词失败' }))
        }
        return
      }

      // [新增] Embed Lyric into Audio File Tags (USLT)
      if (pathname === '/api/music/cache/embedLyric' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        void readBody(req).then(async body => {
          try {
            const { filenames } = JSON.parse(body)
            if (!filenames || !Array.isArray(filenames)) throw new Error('Missing filenames')

            let successCount = 0
            let skippedCount = 0
            let failCount = 0
            const details: any[] = []

            for (const filename of filenames) {
              let filePath = ''
              let folder: 'cache' | 'music' = 'cache'

              // 在 cache 和 music 两个目录中查找文件
              for (const f of ['cache', 'music'] as const) {
                const dir = fileCache.getCacheDir(username, f === 'music')
                const candidate = path.join(dir, filename)
                if (fs.existsSync(candidate)) {
                  filePath = candidate
                  folder = f
                  break
                }
              }

              if (!filePath) {
                details.push({ filename, status: 'fail', reason: '文件不存在' })
                failCount++
                continue
              }

              try {
                const indexItem = fileCache.getIndexItemByFilename(filename, username) as any
                if (indexItem?.metadataWritable === false) {
                  details.push({ filename, status: 'fail', reason: indexItem.embedLyricError || indexItem.metadataError || '当前音频容器不支持嵌入歌词，外置歌词文件仍可正常使用' })
                  failCount++
                  continue
                }

                // 检查是否已有 USLT 歌词（已有则跳过）
                const { MusicTagger: MT } = require('music-tag-native')
                let checkTagger: any
                let existingLyrics = ''
                try {
                  checkTagger = new MT()
                  checkTagger.loadPath(filePath)
                  existingLyrics = checkTagger.lyrics || ''
                } catch (checkError: any) {
                  const unsupportedStatus = fileCache.getAudioMetadataUnsupportedStatus(filePath)
                  fileCache.setIndexEmbedLyric(filename, username, false, {
                    audioContainer: unsupportedStatus.audioContainer,
                    metadataWritable: false,
                    metadataError: unsupportedStatus.error,
                    embedLyricError: unsupportedStatus.error,
                  })
                  details.push({ filename, status: 'fail', reason: unsupportedStatus.error || '当前音频容器不支持嵌入歌词，外置歌词文件仍可正常使用' })
                  failCount++
                  continue
                } finally {
                  try { if (checkTagger) checkTagger.dispose() } catch (e) { }
                }

                if (existingLyrics && existingLyrics.trim().length > 10) {
                  details.push({ filename, status: 'skipped', reason: '已有歌词标签' })
                  skippedCount++
                  continue
                }

                // 从索引中获取 songInfo（索引条目本身就包含 source/songmid 等字段）
                const songInfo = indexItem

                // 优先读同名 .lrc 文件
                const ext = path.extname(filename)
                const baseName = filename.slice(0, filename.length - ext.length)
                const lrcFilename = baseName + '.lrc'
                const dir = fileCache.getCacheDir(username, folder === 'music')
                const lrcPath = path.join(dir, lrcFilename)

                let lyricText: string | null = null

                if (fs.existsSync(lrcPath)) {
                  lyricText = fs.readFileSync(lrcPath, 'utf8')
                  console.log(`[嵌入歌词] 正在使用本地 .lrc 文件: ${filename}`)
                } else if (songInfo && songInfo.source && songInfo.source !== 'unknown' && songInfo.source !== 'local') {
                  // 没有 .lrc 文件，尝试通过 SDK 获取
                  const lyricFetcherFn = fileCache.getLyricFetcher()
                  if (lyricFetcherFn) {
                    lyricText = await lyricFetcherFn(songInfo)
                  }
                  if (lyricText) {
                    console.log(`[嵌入歌词] 从音源获取到歌词: ${filename}`)
                  }
                }

                if (!lyricText) {
                  details.push({ filename, status: 'fail', reason: '无法获取歌词' })
                  failCount++
                  continue
                }

                const embedResult = fileCache.embedLyricsIntoFile(filePath, lyricText)
                fileCache.setIndexEmbedLyric(filename, username, embedResult.hasEmbedLyric, {
                  audioContainer: embedResult.audioContainer,
                  metadataWritable: embedResult.metadataWritable,
                  metadataError: embedResult.metadataWritable ? undefined : embedResult.error,
                  embedLyricError: embedResult.error,
                })
                if (!embedResult.success) {
                  details.push({ filename, status: 'fail', reason: embedResult.error || '歌词标签写入后校验失败，外置歌词文件仍可正常使用' })
                  failCount++
                  continue
                }

                details.push({ filename, status: 'success' })
                successCount++
                console.log(`[嵌入歌词] 歌词已成功写入文件: ${filename}`)
              } catch (itemErr: any) {
                details.push({ filename, status: 'fail', reason: itemErr.message || '未知错误' })
                failCount++
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, successCount, skippedCount, failCount, details }))
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message }))
          }
        })
        return
      }

      // 11. Link Unindexed Local File
      if (pathname === '/api/music/cache/link' && req.method === 'POST') {
        const verified = verifyUserAuth(req)
        if (!verified) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        void readBody(req).then(async body => {
          try {
            const { filename, songInfo } = JSON.parse(body)
            if (!filename || !songInfo) {
              res.writeHead(400)
              res.end('Missing params')
              return
            }

            const result = await fileCache.linkLocalFile(filename, songInfo, verified)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message || 'Linking failed' }))
          }
        })
        return
      }

      // 12. Identify Local File (AcoustID)
      if (pathname === '/api/music/identify' && req.method === 'POST') {
        const verified = verifyUserAuth(req)
        if (!verified) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        void readBody(req).then(async body => {
          try {
            const { filename, folder } = JSON.parse(body)
            if (!filename) {
              res.writeHead(400)
              res.end('Missing filename')
              return
            }

            const { identifyLocalSong } = require('./utils/identify')
            const username = verified

            const dir = folder === 'custom'
              ? customMusicManager.getCustomMusicDir(username)
              : fileCache.getCacheDir(username, folder === 'music')

            if (!dir) {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: 'Directory not found' }))
              return
            }
            const filePath = path.join(dir, filename) // [Fix] Allow subfolders

            if (!fs.existsSync(filePath)) {
              throw new Error('文件不存在: ' + filename)
            }

            const results = await identifyLocalSong(filePath)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, results }))
          } catch (e: any) {
            console.error('[歌曲识别] 识别发生异常:', e.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message || 'Identification failed' }))
          }
        })
        return
      }



      // [New] Fetch Lyrics
      if (pathname === '/api/music/lyric' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source')
        // [Optimization] Accept multiple ID param names for better client compatibility
        let songmid = urlObj.searchParams.get('songmid') || urlObj.searchParams.get('songId') || urlObj.searchParams.get('id')

        if (!source || !songmid) {
          res.writeHead(400)
          res.end('Missing source or songmid')
          return
        }

        // [Fix] Normalize ID by stripping source prefix if present (e.g., "tx_001..." -> "001...")
        const sourcePrefix = `${source}_`
        if (songmid.startsWith(sourcePrefix)) {
          songmid = songmid.slice(sourcePrefix.length)
        }

        // [优化] 先检查本地 .lrc 文件缓存，命中则直接返回，无需网络请求（断网也可用）
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let lyricUsername = '_open'
        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (verified) lyricUsername = verified
        }
        // [Fix] 汽水本地曲：前端给的 id 带 "soda_" 前缀（如 local + soda_7676..._d119c815），
        // 而缓存索引里存的是剥掉前缀的原生 ID，直接查必然 miss → 白跑一次网络再报错。
        const buildLyricSongInfo = (smid: string) => ({
          source,
          songmid: smid,
          id: urlObj.searchParams.get('songId') || urlObj.searchParams.get('id') || smid,
          name: urlObj.searchParams.get('name') || '',
          singer: urlObj.searchParams.get('singer') || '',
        })
        const checkLocalLyric = (smid: string) => {
          const hit = fileCache.checkLyricCache(buildLyricSongInfo(smid), lyricUsername)
          if (hit.exists) return hit
          const stripped = smid.replace(/^soda_/i, '')
          return stripped !== smid
            ? fileCache.checkLyricCache(buildLyricSongInfo(stripped), lyricUsername)
            : hit
        }
        const localLyricResult = checkLocalLyric(songmid)

        if (localLyricResult.exists && localLyricResult.content) {
          console.log(`[歌词服务] 命中本地 .lrc 缓存: ${source}_${songmid}`)
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' })
          res.end(JSON.stringify({ ...localLyricResult.content, _fromLocalCache: true }))
          return
        }

        try {
          if (!musicSdk[source]) {
            // [Fix] 本地音乐（local）、B站兜底（bili）、汽水（soda）等来源没有内置在线歌词接口。
            // 本地 .lrc 已在上面查过，未命中就返回空歌词让前端显示「暂无歌词」——
            // 这是设计如此，不是故障，不该按 ERROR 打印（旧版会刷 "Source not supported"）。
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify({ lyric: '', tlyric: '', rlyric: '', klyric: '', lxlyric: '', _noOnlineLyric: true }))
            return
          }

          // console.log('[歌词服务] 正在从音源获取歌词:', source, songmid)

          // Construct complete songInfo object for SDK compatibility
          // KuGou (kg) needs: name, hash, interval
          // MiGu (mg) needs: copyrightId, lrcUrl, mrcUrl, trcUrl (优先，避免调用getMusicInfo API)
          const songInfo = {
            songmid,
            name: urlObj.searchParams.get('name') || '',
            singer: urlObj.searchParams.get('singer') || '',
            hash: urlObj.searchParams.get('hash') || '',
            interval: urlObj.searchParams.get('interval') || '',
            copyrightId: urlObj.searchParams.get('copyrightId') || '',
            albumId: urlObj.searchParams.get('albumId') || '',
            lrcUrl: urlObj.searchParams.get('lrcUrl') || '',
            mrcUrl: urlObj.searchParams.get('mrcUrl') || '',
            trcUrl: urlObj.searchParams.get('trcUrl') || ''
          }

          const requestObj = musicSdk[source].getLyric(songInfo)
          const lyricInfo = await requestObj.promise

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=86400' // Cache lyrics for 1 day
          })
          res.end(JSON.stringify(lyricInfo))
        } catch (err: any) {
          console.error('[歌词服务] 获取歌词失败:', source, songmid, err.message || err)

          // [Fallback] 网络请求失败时，再次尝试本地 .lrc 文件（防止 Step2 miss 但物理文件存在的情况）
          const fallbackResult = checkLocalLyric(songmid)
          if (fallbackResult.exists && fallbackResult.content) {
            console.log(`[歌词服务] 网络获取失败，回退到本地 .lrc: ${source}_${songmid}`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ...fallbackResult.content, _fromLocalCache: true }))
            return
          }

          // Avoid circular structure error - only send message
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end(err.message || 'Failed to fetch lyric')
        }
        return
      }

      // [新增] File Cache Lyric APIs
      if (pathname === '/api/music/cache/lyric' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source')
        const songmid = urlObj.searchParams.get('songmid') || urlObj.searchParams.get('songId') || urlObj.searchParams.get('id')
        const songId = urlObj.searchParams.get('songId') || urlObj.searchParams.get('id')

        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        if (!source || (!songmid && !songId)) {
          res.writeHead(400)
          res.end('Missing source or songmid')
          return
        }

        const name = urlObj.searchParams.get('name') || ''
        const singer = urlObj.searchParams.get('singer') || ''
        const result = fileCache.checkLyricCache({ source, songmid, id: songId, name, singer }, username)
        if (result.exists) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: result.content }))
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Not found in cache' }))
        }
        return
      }

      if (pathname === '/api/music/cache/lyric' && req.method === 'POST') {
        void readBody(req).then(body => {
          try {
            const { songInfo, lyricsObj, enableOnlyDownloadMode } = JSON.parse(body)
            const reqUsername = (req.headers['x-user-name'] as string) || ''
            const isPublic = !reqUsername || reqUsername === 'default'
            let username = '_open'

            if (!isPublic) {
              const verified = verifyUserAuth(req)
              if (!verified) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
                return
              }
              username = verified
            }

            if (!songInfo || !lyricsObj) {
              res.writeHead(400)
              res.end('Missing parameters')
              return
            }

            let success = false
            if (songInfo?.folder === 'custom') {
              success = customMusicManager.saveCustomLyricCache(songInfo, lyricsObj, username)
            } else {
              success = fileCache.saveLyricCache(songInfo, lyricsObj, username, !!enableOnlyDownloadMode)
              if (!success) {
                // 如果在常规缓存没找到，尝试在自定义目录匹配
                success = customMusicManager.saveCustomLyricCache(songInfo, lyricsObj, username)
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success }))
          } catch (e: any) {
            res.writeHead(500)
            res.end('Server internal error')
          }
        })
        return
      }

      // [新增] Download Proxy API
      if (pathname === '/api/music/download' && req.method === 'GET') {
        const urlStr = urlObj.searchParams.get('url')
        const filename = urlObj.searchParams.get('filename') || 'download.mp3'
        const isInline = urlObj.searchParams.get('inline') === '1'

        if (!urlStr) {
          res.writeHead(400)
          res.end('Missing url param')
          return
        }

        try {
          const isTaggingMode = urlObj.searchParams.get('tag') === '1'
          const taskId = urlObj.searchParams.get('taskId')
          console.log(`[下载代理] 正在获取音频流: ${urlStr} (写入标签: ${isTaggingMode}, 任务ID: ${taskId})`)

          // 使用原生 http/https 模块以获得最高的流媒体转发性能
          const http = require('http')
          const https = require('https')

          // Manual redirect handling for maximum control and stability
          const doFetch = (targetUrl: string, attempt: number) => {
            if (attempt > 5) {
              console.error('[下载代理] 触发过多重定向，已终止')
              if (!res.headersSent) {
                res.writeHead(502)
                res.end('Too Many Redirects')
              }
              return
            }

            try {
              const parsedUrl = new URL(targetUrl)
              const options: any = {
                method: 'GET',
                // Referer 必须按目标域名分流：B站 CDN 要 bilibili.com 来源，
                // 抖音系（汽水）反而不能带。见 utils/streamHeaders。
                headers: buildStreamHeaders(targetUrl),
              }

              // 转发 Range 请求头，以支持播放器的快进和拖拽
              if (req.headers['range']) {
                options.headers['Range'] = req.headers['range']
              }

              const lib = parsedUrl.protocol === 'https:' ? https : http

              const proxyReq = lib.request(targetUrl, options, (proxyRes: any) => {
                // 处理重定向
                if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
                  const location = proxyRes.headers.location
                  if (location) {
                    const nextUrl = location.startsWith('http') ? location : new URL(location, targetUrl).href
                    doFetch(nextUrl, attempt + 1)
                    return
                  }
                }

                // 处理最终响应
                let contentType = proxyRes.headers['content-type'] || 'application/octet-stream'
                if (contentType.includes('audio/') || contentType.includes('video/')) {
                  contentType = contentType.split(';')[0].trim()
                }

                const headers: Record<string, string | string[] | undefined> = {
                  'Content-Type': contentType,
                  'Access-Control-Allow-Origin': '*',
                }

                if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length']
                if (proxyRes.headers['accept-ranges']) headers['Accept-Ranges'] = proxyRes.headers['accept-ranges']
                if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range']

                if (!isInline) {
                  headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`
                }

                // [Unified metadata] Tagging support for browser download
                // NOTE: Local fetch from browser often sends Range: bytes=0- for full download
                const rangeHeader = req.headers['range']
                const isFullRange = rangeHeader === 'bytes=0-'

                if (isTaggingMode && (!rangeHeader || isFullRange)) {
                  const songName = urlObj.searchParams.get('name') || ''
                  const artist = urlObj.searchParams.get('singer') || ''
                  const album = urlObj.searchParams.get('album') || ''
                  const imageUrl = urlObj.searchParams.get('pic') || ''
                  // [新增] 浏览器下载歌词嵌入参数
                  const embedLyric = urlObj.searchParams.get('lyric') === '1'
                  const lyricSource = urlObj.searchParams.get('source') || ''
                  const lyricSongmid = urlObj.searchParams.get('songmid') || ''
                  const lyricHash = urlObj.searchParams.get('hash') || ''
                  const lyricInterval = urlObj.searchParams.get('interval') || ''

                  const chunks: any[] = []
                  let received = 0
                  const total = parseInt(proxyRes.headers['content-length'] as string || '0', 10)
                  let lastSpeedAt = Date.now()
                  let lastSpeedBytes = 0
                  let currentSpeed = 0

                  if (taskId) {
                    fileCache.cacheProgress.set(taskId, { progress: 0, status: 'downloading', total, received: 0, speed: 0, updatedAt: Date.now() })
                  }

                  proxyRes.on('data', (c: any) => {
                    chunks.push(c)
                    if (taskId) {
                      received += c.length
                      const now = Date.now()
                      if (now - lastSpeedAt >= 1000) {
                        currentSpeed = Math.max(0, (received - lastSpeedBytes) / ((now - lastSpeedAt) / 1000))
                        lastSpeedAt = now
                        lastSpeedBytes = received
                      }
                      const progress = total > 0 ? Math.round((received / total) * 100) : 0
                      fileCache.cacheProgress.set(taskId, { progress, status: 'downloading', total, received, speed: currentSpeed, updatedAt: now })
                    }
                  })
                  proxyRes.on('end', async () => {
                    if (taskId) {
                      fileCache.cacheProgress.set(taskId, { progress: 100, status: 'tagging', total, received, speed: 0, updatedAt: Date.now() })
                    }
                    const finishProgress = () => {
                      if (!taskId) return
                      fileCache.cacheProgress.set(taskId, { progress: 100, status: 'finished', total: total || received, received, speed: 0, updatedAt: Date.now() })
                      setTimeout(() => fileCache.cacheProgress.delete(taskId), 30000)
                    }
                    let tempPath = ''
                    let tagger: any = null
                    try {
                      const buffer = Buffer.concat(chunks)
                      if (buffer.length < 100) throw new Error('File too small, possibly invalid');

                      // Use filename extension for temp file so MusicTagger can identify container format
                      const ext = path.extname(filename) || '.mp3'
                      tempPath = path.join(os.tmpdir(), `lx_tag_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`)
                      fs.writeFileSync(tempPath, new Uint8Array(buffer))

                      tagger = new MusicTagger()
                      tagger.loadPath(tempPath)
                      if (songName) tagger.title = songName
                      if (artist) tagger.artist = artist
                      if (album) tagger.album = album

                      if (imageUrl) {
                        try {
                          let imgBuf: Buffer | null = null;
                          if (imageUrl.startsWith('http')) {
                            const imgResp = await (global as any).fetch(imageUrl)
                            if (imgResp.ok) imgBuf = Buffer.from(await imgResp.arrayBuffer())
                          } else if (imageUrl.startsWith('/api')) {
                            // 内部 API 请求，使用请求头中的 host
                            const hostLabel = req.headers.host || '127.0.0.1:2026'
                            const internalUrl = `http://${hostLabel}${imageUrl}`
                            const imgResp = await (global as any).fetch(internalUrl)
                            if (imgResp.ok) imgBuf = Buffer.from(await imgResp.arrayBuffer())
                          }

                          if (imgBuf && imgBuf.length > 0) {
                            try {
                              // music-tag-native signature: (mime, data, type)
                              tagger.pictures = [new MetaPicture('image/jpeg', new Uint8Array(imgBuf), 'Cover')]
                            } catch (picErr) {
                              console.warn('[下载代理] 封面标签创建失败:', picErr)
                            }
                          }
                        } catch (e: any) {
                          console.warn('[下载代理] 获取或嵌入封面失败:', imageUrl, e.message)
                        }
                      }
                      // [新增] 嵌入歌词 USLT 标签：SDK 返回 { promise, cancel }，必须 await .promise
                      if (embedLyric && lyricSource && lyricSongmid && musicSdk[lyricSource]?.getLyric) {
                        try {
                          const lyricReqObj = musicSdk[lyricSource].getLyric({
                            songmid: lyricSongmid,
                            name: songName,
                            singer: artist,
                            hash: lyricHash,
                            interval: lyricInterval,
                          })
                          const lyricResult = await lyricReqObj.promise
                          const lyricText = lyricResult?.lyric || lyricResult?.lrc || ''
                          if (lyricText) tagger.lyrics = lyricText
                        } catch (e) { /* 歌词获取失败不影响下载 */ }
                      }
                      tagger.save()
                      console.log('[下载代理] 音频元数据标签保存成功:', songName)
                      tagger.dispose()
                      tagger = null

                      const tagged = fs.readFileSync(tempPath)
                      headers['Content-Length'] = tagged.length.toString()
                      if (!res.headersSent) {
                        res.writeHead(200, headers)
                        res.end(tagged)
                      }
                      finishProgress()
                    } catch (e: any) {
                      if (!res.headersSent) {
                        res.writeHead(200, headers)
                        res.end(Buffer.concat(chunks))
                      }
                      finishProgress()
                    } finally {
                      if (tagger) tagger.dispose()
                      if (tempPath) fs.unlink(tempPath, () => { })
                    }
                  })
                  return
                }

                if (!res.headersSent) {
                  res.writeHead(proxyRes.statusCode || 200, headers)
                  proxyRes.pipe(res)
                }
              })

              proxyReq.on('error', (err: any) => {
                console.error('[下载代理] 请求异常:', err)
                if (!res.headersSent) {
                  res.writeHead(502)
                  res.end('Request Error')
                }
              })

              // 如果客户端（浏览器）中止了请求（例如：用户拖拽进度条、切换歌曲等），应该立刻销毁上游的下载请求，防止持续占用服务器下行带宽
              req.on('close', () => {
                if (!proxyReq.destroyed) {
                  proxyReq.destroy()
                }
              })

              proxyReq.end()

            } catch (err: any) {
              console.error('[下载代理] 代理请求捕获异常:', err)
              if (!res.headersSent) {
                res.writeHead(500)
                res.end('Internal Server Error')
              }
            }
          }

          // Start the fetch process
          doFetch(urlStr, 0)

        } catch (err: any) {
          console.error('[下载代理] 发生错误:', err)
          res.writeHead(500)
          res.end('Server Error')
        }
        return
      }

      if (pathname === '/api/data/delete-playlist' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }


        void readBody(req).then(async body => {
          try {
            const { username, playlistId } = JSON.parse(body)

            // 检查用户是否存在
            if (!global.lx.config.users.some(u => u.name === username)) {
              res.writeHead(404)
              res.end('User not found')
              return
            }

            const userSpace = getUserSpace(username)
            const listManage = userSpace.listManage

            // 删除歌单
            await listManage.listDataManage.userListsRemove([playlistId])
            // 创建快照
            await listManage.createSnapshot()

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(500)
            res.end(err.message)
          }
        })
        return
      }

      // 删除歌曲
      if (pathname === '/api/data/delete-song' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        void readBody(req).then(async body => {
          try {
            const { username, playlistId, songIndex } = JSON.parse(body)

            // 检查用户是否存在
            if (!global.lx.config.users.some(u => u.name === username)) {
              res.writeHead(404)
              res.end('User not found')
              return
            }

            const userSpace = getUserSpace(username)
            const listManage = userSpace.listManage
            const listData = await listManage.getListData()

            // 获取歌单
            const playlist = listData.userList.find((list: any) => list.id === playlistId)

            if (!playlist) {
              res.writeHead(404)
              res.end('Playlist not found')
              return
            }

            if (!playlist.list || songIndex >= playlist.list.length) {
              res.writeHead(404)
              res.end('Song not found')
              return
            }

            const songInfo = playlist.list[songIndex]
            // 从歌单中删除歌曲
            await listManage.listDataManage.listMusicRemove(playlistId, [songInfo.id])
            // 创建快照
            await listManage.createSnapshot()

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(500)
            res.end(err.message)
          }
        })
        return
      }
      // 重命名歌单
      if (pathname === '/api/data/rename-playlist' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        void readBody(req).then(async body => {
          try {
            const { username, playlistId, newName } = JSON.parse(body)

            // 检查用户是否存在
            if (!global.lx.config.users.some(u => u.name === username)) {
              res.writeHead(404)
              res.end('User not found')
              return
            }

            const userSpace = getUserSpace(username)
            const listManage = userSpace.listManage
            const listData = await listManage.getListData()

            // 查找歌单
            const playlist = listData.userList.find((list: any) => list.id === playlistId)

            if (!playlist) {
              res.writeHead(404)
              res.end('Playlist not found')
              return
            }

            // 更新歌单信息
            await listManage.listDataManage.userListsUpdate([{
              id: playlist.id,
              name: newName,
              source: playlist.source,
              sourceListId: playlist.sourceListId,
              locationUpdateTime: playlist.locationUpdateTime
            }])
            // 创建快照
            await listManage.createSnapshot()

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(500)
            res.end(err.message)
          }
        })
        return
      }

      // 批量删除歌曲
      if (pathname === '/api/data/batch-delete-songs' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        void readBody(req).then(async body => {
          try {
            const { username, playlistId, songIndices } = JSON.parse(body)

            // 检查用户是否存在
            if (!global.lx.config.users.some(u => u.name === username)) {
              res.writeHead(404)
              res.end('User not found')
              return
            }

            const userSpace = getUserSpace(username)
            const listManage = userSpace.listManage
            const listData = await listManage.getListData()

            // 获取歌单
            const playlist = listData.userList.find((list: any) => list.id === playlistId)

            if (!playlist) {
              res.writeHead(404)
              res.end('Playlist not found')
              return
            }

            // 获取要删除的歌曲ID列表
            const songIds = songIndices.map((index: number) => {
              if (playlist.list && playlist.list[index]) {
                const id = playlist.list[index].id
                return id
              }
              return null
            }).filter((id: any) => id !== null)

            if (songIds.length === 0) {
              res.writeHead(400)
              res.end('No valid songs selected')
              return
            }

            // 批量删除
            await listManage.listDataManage.listMusicRemove(playlistId, songIds)
            // 创建快照
            await listManage.createSnapshot()

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(500)
            res.end(err.message)
          }
        })
        return
      }

      // [新增] Web播放器公共配置 API (无需鉴权)
      if (pathname === '/api/music/config' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        })
        res.end(JSON.stringify({
          'player.name': global.lx.config['player.name'] || 'LX Music Web',
          'player.enableAuth': global.lx.config['player.enableAuth'] || false,
          'user.enablePublicRestriction': global.lx.config['user.enablePublicRestriction'] || false,
          'user.enablePublicFavorites': global.lx.config['user.enablePublicFavorites'] || false,
          'user.enablePublicNonAdminAccess': global.lx.config['user.enablePublicNonAdminAccess'] || false,
          'user.enablePublicNonAdminLocalMusic': global.lx.config['user.enablePublicNonAdminLocalMusic'] || false,
          'user.enablePublicNonAdminBrowserDownload': global.lx.config['user.enablePublicNonAdminBrowserDownload'] ?? true,
          'user.enablePublicNonAdminServerCache': global.lx.config['user.enablePublicNonAdminServerCache'] ?? false
        }))
        return
      }

      // [新增] Web播放器认证 API（颁发 HttpOnly Cookie Session，支持用户账号登录 / 播放器访问密码双模式）
      if (pathname === '/api/music/auth' && req.method === 'POST') {
        void readBody(req).then(body => {
          try {
            const { password, username, mode } = JSON.parse(body)
            const correctPlayerPassword = global.lx.config['player.password'] || ''
            const isPlayerMode = mode === 'player' || (!username && mode !== 'user')

            // 1. 播放器访问密码模式（无账号访客进入）
            if (isPlayerMode) {
              if (correctPlayerPassword && password === correctPlayerPassword) {
                const sessionId = generateSessionId()
                playerSessions.set(sessionId, { createdAt: Date.now(), user: null })
                loginLog.info(`Player guest login success from ${ip}`)
                res.writeHead(200, {
                  'Content-Type': 'application/json',
                  'Set-Cookie': buildSessionCookieHeader(req, sessionId, SESSION_TTL / 1000)
                })
                res.end(JSON.stringify({
                  success: true,
                  mode: 'player',
                  username: null,
                  token: null
                }))
                return
              } else {
                loginLog.warn(`Player guest login failed from ${ip}`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: '播放器访问密码错误' }))
                return
              }
            }

            // 2. 用户账号登录模式
            const matchedUser = (global.lx.config.users || []).find((u: any) => u.name === username && u.password === password)
            if (matchedUser) {
              const sessionId = generateSessionId()
              playerSessions.set(sessionId, { createdAt: Date.now(), user: matchedUser.name })
              loginLog.info(`Player login success (${matchedUser.name}) from ${ip}`)
              const userToken = generateSessionId()
              addUserSession(userToken, matchedUser.name)
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': buildSessionCookieHeader(req, sessionId, SESSION_TTL / 1000)
              })
              res.end(JSON.stringify({
                success: true,
                mode: 'user',
                username: matchedUser.name,
                token: userToken
              }))
            } else {
              loginLog.warn(`Player user login failed (${username || 'unknown'}) from ${ip}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: '账号或密码错误' }))
            }
          } catch (err: any) {
            res.writeHead(500)
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        })
        return
      }

      // [新增] Web播放器登出 API（清除 Session Cookie）
      if (pathname === '/api/music/auth/logout' && req.method === 'POST') {
        const cookies = parseCookies(req.headers['cookie'])
        const sessionId = cookies[SESSION_COOKIE_NAME]
        if (sessionId) playerSessions.delete(sessionId)
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': buildSessionCookieHeader(req, '', 0)
        })
        res.end(JSON.stringify({ success: true }))
        return
      }

      // [新增] Web播放器认证状态检查 API
      if (pathname === '/api/music/auth/verify' && req.method === 'GET') {
        const isValid = checkPlayerAuth(req)
        const responseHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        }
        if (isValid) {
          // 若当前请求没有有效 Session Cookie（例如通过 x-user-token 凭据静默恢复），
          // 则立即补发 Session Cookie，确保随后跳转页面能够顺利通过文档级路由认证
          const cookies = parseCookies(req.headers['cookie'])
          const sessionId = cookies[SESSION_COOKIE_NAME]
          const existingSession = sessionId ? playerSessions.get(sessionId) : null
          if (!existingSession || Date.now() - existingSession.createdAt > SESSION_TTL) {
            const user = verifyUserAuth(req)
            const newSessionId = generateSessionId()
            playerSessions.set(newSessionId, { createdAt: Date.now(), user: user || null })
            responseHeaders['Set-Cookie'] = buildSessionCookieHeader(req, newSessionId, SESSION_TTL / 1000)
          }
        }
        res.writeHead(200, responseHeaders)
        res.end(JSON.stringify({ valid: isValid }))
        return
      }

      // [新增] 音乐搜索 API
      if (pathname === '/api/music/search' && req.method === 'GET') {
        const name = urlObj.searchParams.get('name') || ''
        const singer = urlObj.searchParams.get('singer') || ''
        const source = urlObj.searchParams.get('source') || 'kw'
        const type = urlObj.searchParams.get('type') || 'song' // 新增 type 参数: song, singer, album, playlist
        const limit = parseInt(urlObj.searchParams.get('limit') || '20')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        // 调用方显式要了 N 条时只取够 N 条（如本地音乐匹配一首歌），不传就是取该平台全量
        const requestedLimit = urlObj.searchParams.get('limit') ? parseInt(urlObj.searchParams.get('limit') || '0') : 0

        if (!name) {
          res.writeHead(400); res.end('Missing name'); return
        }

        try {
          // 额外音源（Bilibili / 汽水）自带搜索实现，不经过 musicSdk（那个目录会被上游覆盖）
          if (extraSources.isExtraSource(source)) {
            if (type !== 'song') {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                success: false,
                error: `${extraSources.displayName(source)} 暂不支持${type === 'singer' ? '歌手' : type === 'album' ? '专辑' : '歌单'}搜索，请切换到歌曲`,
              }))
              return
            }
            const pageSize = requestedLimit > 0 ? Math.min(requestedLimit, 50) : 20
            const pageNo = requestedLimit > 0 ? Math.max(1, page) : 1
            // 不传 limit = 搜索界面用法：串行翻 3 页拼成 60 条，前端一次拿全量本地分页
            const data = requestedLimit > 0
              ? await extraSources.searchSongs(source, name, pageNo, pageSize)
              : await extraSources.searchAll(source, name)
            const list = requestedLimit > 0 ? data.list.slice(0, requestedLimit) : data.list
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              list,
              total: data.total,
              allPage: data.allPage,
              pageSize,
              fetchedPages: (data as any).fetchedPages || pageNo,
              stopReason: 'extra-source',
              hasMore: requestedLimit > 0 ? pageNo < data.allPage : false,
              source,
            }))
            return
          }

          if (!musicSdk[source]) {
            throw new Error(`Source ${source} is not supported`)
          }

          // 搜索结果统一成对象返回：list 是去重后的条目，total/allPage 是平台自报值（可能不可信），
          // fetchedPages 是本次实际取到的页数，hasMore 表示被页数墙或预算截断、还有数据没取到。
          let result: any
          if (type === 'song') {
            const api = musicSdk[source].musicSearch
            // 调用方显式带了 limit 时，走「第 page 页、每页 limit 条」的传统分页（本地音乐的在线匹配靠它翻页）；
            // 不带 limit 才是搜索界面的用法：按各源 musicSearch.js 里实测出的 limit 取全量。
            const singlePage = requestedLimit > 0
            const startPage = singlePage ? page : 1
            const pageSize: number = singlePage
              ? Math.min(requestedLimit, api.limit || 20)
              : (api.limit || 20)
            const startedAt = Date.now()
            const first: any = await api.search(name, startPage, pageSize)
            const firstList: any[] = (first && first.list) || []
            const rawTotal = first && typeof first.total === 'number' && first.total > 0 ? first.total : firstList.length
            const rawAllPage = first && typeof first.allPage === 'number' && first.allPage > 0
              ? first.allPage
              : Math.ceil(rawTotal / pageSize)
            // 平台自报的 total/allPage 不可全信（tx 报 45206 条 = 754 页，实测取不到那么多），
            // 所以取数上限是「allPage 推算 + 页数墙 + 条数预算 + 时间预算」四重收紧，而不是照 total 硬翻页。
            const SEARCH_PAGE_CAP = 60
            const SEARCH_MAX_ITEMS = 4000
            const SEARCH_MAX_MS = 15000
            const capPages = singlePage ? startPage : Math.max(1, Math.min(
              Number.isFinite(rawAllPage) ? rawAllPage : 1,
              SEARCH_PAGE_CAP
            ))

            const seen = new Set<string>()
            const allSongs: any[] = []
            const pushItems = (pageList: any[]): number => {
              // 返回本页贡献的新条目数（0 表示整页都是已见过的 → 平台已开始回绕）
              let fresh = 0
              for (const item of pageList) {
                const key = `${source}_${item.id ?? item.songmid ?? item.mid ?? item.hash ?? item.copyrightId ?? item.strMediaMid ?? `${item.name || ''}-${item.singer || ''}`}`
                if (seen.has(key)) continue
                seen.add(key)
                allSongs.push(item)
                fresh++
              }
              return fresh
            }
            pushItems(firstList)

            // 必须串行翻页：2026-10-09 实测并发（3 路）取 kw 同一关键词三次只拿回 3000/2000/2000 条
            // （串行是 3045 条），tx 并发 60 页只回 240 条 —— 平台在快速连发时会返回重复或漂移的页。
            let fetchedPages = startPage
            let stopReason = 'all-pages'
            for (let p = startPage + 1; p <= capPages; p++) {
              if (Date.now() - startedAt > SEARCH_MAX_MS) { stopReason = 'time-budget'; break }
              if (allSongs.length >= SEARCH_MAX_ITEMS) { stopReason = 'item-budget'; break }
              let pageData: any
              try {
                pageData = await api.search(name, p, pageSize)
              } catch (e) {
                // 平台自己的页数墙（kg 的 try max num 等）：撞到就到此为止
                stopReason = 'page-wall'
                break
              }
              const pageList: any[] = (pageData && pageData.list) || []
              fetchedPages = p
              if (pageList.length === 0) { stopReason = 'empty-page'; break }
              if (pushItems(pageList) === 0) { stopReason = 'repeat-page'; break }
            }
            if (singlePage) {
              stopReason = 'single-page'
            } else if (fetchedPages < capPages && stopReason === 'all-pages') {
              stopReason = 'page-cap'
            }

            const list = requestedLimit > 0 ? allSongs.slice(0, requestedLimit) : allSongs
            // 取完一整轮（empty-page/repeat-page/all-pages）就不算还有剩，别用「条数 < 平台报的 total」误判：
            // kw 报 3600 条里本身就含跨页重复，串行取到第 18 页也只有 3045 条新内容。
            const finished = stopReason === 'empty-page' || stopReason === 'repeat-page' || stopReason === 'all-pages'
            result = {
              list,
              total: rawTotal,
              allPage: rawAllPage,
              pageSize,
              fetchedPages,
              stopReason,
              hasMore: singlePage ? firstList.length >= pageSize : !finished,
              source,
            }
          } else if (type === 'singer') {
            if (!musicSdk[source].extendSearch || !musicSdk[source].extendSearch.searchSinger) {
              throw new Error(`Source ${source} does not support singer search`)
            }
            const searchData = await musicSdk[source].extendSearch.searchSinger(name, page, limit)
            result = { list: searchData.list || [], total: searchData.total || 0, allPage: searchData.allPage || 1, pageSize: limit, fetchedPages: page, source }
          } else if (type === 'album') {
            if (!musicSdk[source].extendSearch || !musicSdk[source].extendSearch.searchAlbum) {
              throw new Error(`Source ${source} does not support album search`)
            }
            const searchData = await musicSdk[source].extendSearch.searchAlbum(name, page, limit)
            result = { list: searchData.list || [], total: searchData.total || 0, allPage: searchData.allPage || 1, pageSize: limit, fetchedPages: page, source }
          } else if (type === 'playlist') {
            if (!musicSdk[source].extendSearch || !musicSdk[source].extendSearch.searchPlaylist) {
              throw new Error(`Source ${source} does not support playlist search`)
            }
            const searchData = await musicSdk[source].extendSearch.searchPlaylist(name, page, limit)
            result = { list: searchData.list || [], total: searchData.total || 0, allPage: searchData.allPage || 1, pageSize: limit, fetchedPages: page, source }
          } else {
            throw new Error(`Invalid search type: ${type}`)
          }

          fs.appendFileSync(path.join(process.cwd(), 'debug.txt'), `[Search] Source: ${source}, Type: ${type}, Query: ${name}, FetchedPages: ${result.fetchedPages}, Returned: ${result.list.length}, PlatformTotal: ${result.total}\n`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          fs.appendFileSync(path.join(process.cwd(), 'debug.txt'), `[Search Error] ${err.message}\n${err.stack}\n`)
          console.error(err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message, code: 500 }))
        }
        return
      }

      // [新增] 搜索提示 (TipSearch) API
      if (pathname === '/api/music/tipSearch' && req.method === 'GET') {
        const name = urlObj.searchParams.get('name') || ''
        const source = urlObj.searchParams.get('source') || 'kw'
        if (!name) {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].tipSearch) {
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return
          }
          const tips = await musicSdk[source].tipSearch.search(name)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(tips || []))
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('[]')
        }
        return
      }

      // [新增] 获取歌手详情 API
      if (pathname === '/api/music/artistDetail' && req.method === 'GET') {
        const id = urlObj.searchParams.get('id')
        const source = urlObj.searchParams.get('source') || 'wy'
        if (!id) {
          res.writeHead(400); res.end('Missing id'); return
        }
        if (typeof musicSdk[source]?.extendDetail?.getArtistDetail !== 'function') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: `音源 ${source} 暂不支持歌手详情` }))
          return
        }
        try {
          const data = await musicSdk[source].extendDetail.getArtistDetail(id)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        } catch (err: any) {
          res.writeHead(500); res.end(err.message)
        }
        return
      }

      // [新增] 获取歌手专辑列表 API
      if (pathname === '/api/music/artistAlbums' && req.method === 'GET') {
        const id = urlObj.searchParams.get('id')
        const source = urlObj.searchParams.get('source') || 'wy'
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!id) {
          res.writeHead(400); res.end('Missing id'); return
        }
        if (typeof musicSdk[source]?.extendDetail?.getArtistAlbums !== 'function') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: `音源 ${source} 暂不支持歌手专辑列表` }))
          return
        }
        try {
          const data = await musicSdk[source].extendDetail.getArtistAlbums(id, page)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        } catch (err: any) {
          res.writeHead(500); res.end(err.message)
        }
        return
      }

      // [新增] 获取歌手歌曲 API（循环拉取全部，前端分页）
      if (pathname === '/api/music/artistSongs' && req.method === 'GET') {
        const id = urlObj.searchParams.get('id')
        const source = urlObj.searchParams.get('source') || 'wy'
        const order = urlObj.searchParams.get('order') || 'hot'
        if (!id) {
          res.writeHead(400); res.end('Missing id'); return
        }
        try {
          const PAGE_SIZE = 100
          const configuredMaxPages = Number((global.lx.config as any)?.['artist.maxFetchPages'])
          const MAX_PAGES = Number.isFinite(configuredMaxPages) && configuredMaxPages > 0
            ? Math.min(Math.floor(configuredMaxPages), 100)
            : 20
        if (typeof musicSdk[source]?.extendDetail?.getArtistSongs !== 'function') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: `音源 ${source} 暂不支持歌手歌曲列表` }))
          return
        }
          let allSongs: any[] = []
          for (let p = 1; p <= MAX_PAGES; p++) {
            const data = await musicSdk[source].extendDetail.getArtistSongs(id, p, PAGE_SIZE, order)
            const pageList: any[] = data.list || []
            allSongs = allSongs.concat(pageList)
            const total = Number(data.total) || 0
            if (pageList.length < PAGE_SIZE || (total > 0 && allSongs.length >= total)) break
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(allSongs))
        } catch (err: any) {
          res.writeHead(500); res.end(err.message)
        }
        return
      }

      // [新增] 获取专辑歌曲 API
      if (pathname === '/api/music/albumSongs' && req.method === 'GET') {
        const id = urlObj.searchParams.get('id')
        const source = urlObj.searchParams.get('source') || 'wy'
        if (!id) {
          res.writeHead(400); res.end('Missing id'); return
        }
        if (typeof musicSdk[source]?.extendDetail?.getAlbumSongs !== 'function') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: `音源 ${source} 暂不支持专辑歌曲列表` }))
          return
        }
        try {
          const data = await musicSdk[source].extendDetail.getAlbumSongs(id)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        } catch (err: any) {
          res.writeHead(500); res.end(err.message)
        }
        return
      }

      // [新增] 音乐解析进度 SSE 端点 (无需登录, 用 requestId 区分)
      if (pathname === '/api/music/progress' && req.method === 'GET') {
        const reqId = urlObj.searchParams.get('reqId')
        if (!reqId) {
          res.writeHead(400)
          res.end('Missing reqId')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-Accel-Buffering': 'no', // 关键：禁用 Nginx 等代理的缓冲
        })
        res.write('retry: 3000\n\n')
        musicProgressClients.set(reqId, res)
        req.on('close', () => {
          musicProgressClients.delete(reqId)
        })
        return
      }

      // ===== 小爱同学（米家云）投播 API =====
      // 播放流地址：音箱本身没有登录态，只能靠 URL 里的签名 token 授权，因此这里不做会话鉴权
      // 路径可能带音频后缀（/stream.mp3、/stream.m4a …）：音箱靠后缀判断解码方式，
      // 所以投送地址会按真实格式补后缀，这里两种写法都要认
      if ((pathname === '/api/music/xiaoai/stream' || /^\/api\/music\/xiaoai\/stream\.[a-z0-9]{2,5}$/i.test(pathname)) && req.method === 'GET') {
        try {
          const streamPayload = parseStreamToken(urlObj.searchParams.get('token') || '')
          // 音箱第一次来要这一路流的时间点：减去投送时刻就是「投送→开始拉流」的真实延迟。
          // 自动切歌的提前量必须覆盖它（还要加上设备起播缓冲），否则新歌总是慢半步，
          // 用户就会听到上一首被重头播了几秒。
          if (streamPayload.sid && streamPayload.sid === lastXiaoAiStreamSid && !lastXiaoAiStreamAt) {
            lastXiaoAiStreamAt = Date.now()
          }
          void serveXiaoAiStream(req, res, streamPayload)
        } catch (error: any) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: error?.message || 'Invalid XiaoAi token' }))
        }
        return
      }

      if (pathname.startsWith('/api/music/xiaoai/')) {
        if (!isXiaoAiRequestAuthorized(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        const sendJson = (data: any, status = 200) => {
          if (res.writableEnded) return
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
          res.end(JSON.stringify(data))
        }
        const readJsonBody = async (): Promise<any> => {
          const body = await readBody(req)
          try {
            return JSON.parse(body || '{}')
          } catch {
            return {}
          }
        }
        const failed = (error: any, fallback: string, level: 'error' | 'warn' = 'error') => {
          const msg = error?.message || fallback
          const line = `[XiaoAi] 接口失败（${fallback}）：${msg}`
          // 排障盲区：此前投送失败只回 400、不在服务端留任何痕迹（如 kg 源瞬态 400 无处可查）。
          // 但参数类错误（用户填了非法值）不算故障，记 WARN 即可——
          // 一律记 ERROR 会把真正的上游故障淹没在噪声里。
          if (level === 'warn') {
            console.warn(line)
            syncLog.warn(line)
          } else {
            console.error(line)
            syncLog.error(line)
          }
          sendJson({ success: false, message: msg }, 400)
        }

        // --- 配置读写 ---
        if (pathname === '/api/music/xiaoai/config' && req.method === 'GET') {
          // 带上请求来源，建议地址才能是「音箱可达的局域网地址+真实端口」
          sendJson({ success: true, config: xiaoAiService.getPublicConfig(getRequestOrigin(req)) })
          return
        }
        if (pathname === '/api/music/xiaoai/config' && req.method === 'POST') {
          void readJsonBody().then(payload => {
            try {
              sendJson({ success: true, config: xiaoAiService.updateConfig(payload, getRequestOrigin(req)) })
            } catch (error: any) {
              failed(error, '保存小爱配置失败')
            }
          })
          return
        }

        // --- 扫码登录 ---
        if (pathname === '/api/music/xiaoai/login/qrcode' && req.method === 'POST') {
          void xiaoAiService
            .startQrLogin()
            .then(info =>
              sendJson({
                success: true,
                qrcodeUrl: info.qrcodeUrl,
                qrcodeImage: info.qrcodeImage,
                loginUrl: info.loginUrl,
              })
            )
            .catch((error: any) => failed(error, '获取二维码失败'))
          return
        }
        if (pathname === '/api/music/xiaoai/login/qrcode/poll' && req.method === 'POST') {
          void xiaoAiService
            .pollQrLogin()
            .then(result =>
              sendJson({
                success: true,
                state: result.state,
                message: result.message,
                config: xiaoAiService.getPublicConfig(),
              })
            )
            .catch((error: any) => failed(error, '轮询扫码状态失败'))
          return
        }

        // --- 账号密码 / 图形验证码 / 二次验证 / Cookie 登录 ---
        if (pathname === '/api/music/xiaoai/login/password' && req.method === 'POST') {
          void readJsonBody().then(async payload => {
            try {
              const result = await xiaoAiService.loginWithPassword(
                String(payload.account || '').trim(),
                String(payload.password || '')
              )
              sendJson({
                success: result.state === 'success',
                state: result.state,
                message: result.error || '',
                captchaImage: result.captchaImage || '',
                verifyUrl: result.verifyUrl || '',
                verifyType: result.verifyType || '',
                config: xiaoAiService.getPublicConfig(),
              })
            } catch (error: any) {
              failed(error, '登录失败')
            }
          })
          return
        }
        if (pathname === '/api/music/xiaoai/login/captcha' && req.method === 'POST') {
          void readJsonBody().then(async payload => {
            try {
              const result = await xiaoAiService.loginWithCaptcha(String(payload.captcha || '').trim())
              sendJson({
                success: result.state === 'success',
                state: result.state,
                message: result.error || '',
                captchaImage: result.captchaImage || '',
                verifyUrl: result.verifyUrl || '',
                verifyType: result.verifyType || '',
                config: xiaoAiService.getPublicConfig(),
              })
            } catch (error: any) {
              failed(error, '验证码登录失败')
            }
          })
          return
        }
        if (pathname === '/api/music/xiaoai/login/verify' && req.method === 'POST') {
          void readJsonBody().then(async payload => {
            try {
              const result = await xiaoAiService.loginWithVerifyCode(String(payload.code || '').trim())
              sendJson({
                success: result.state === 'success',
                state: result.state,
                message: result.error || '',
                config: xiaoAiService.getPublicConfig(),
              })
            } catch (error: any) {
              failed(error, '二次验证失败')
            }
          })
          return
        }
        if (pathname === '/api/music/xiaoai/login/cookie' && req.method === 'POST') {
          void readJsonBody().then(async payload => {
            try {
              const result = await xiaoAiService.loginByCookie({
                passToken: String(payload.passToken || '').trim(),
                userId: String(payload.userId || '').trim(),
                cUserId: String(payload.cUserId || '').trim(),
              })
              sendJson({
                success: result.state === 'success',
                state: result.state,
                message: result.error || '',
                config: xiaoAiService.getPublicConfig(),
              })
            } catch (error: any) {
              failed(error, 'Cookie 登录失败')
            }
          })
          return
        }
        if (pathname === '/api/music/xiaoai/logout' && req.method === 'POST') {
          sendJson({ success: true, config: (xiaoAiService.logout(), xiaoAiService.getPublicConfig()) })
          return
        }

        // --- 设备列表 ---
        if (pathname === '/api/music/xiaoai/devices' && req.method === 'GET') {
          const refresh = ['1', 'true'].includes(String(urlObj.searchParams.get('refresh') || '').toLowerCase())
          void xiaoAiService
            .listDevices(refresh)
            .then(result => sendJson({ success: true, ...result, config: xiaoAiService.getPublicConfig() }))
            .catch((error: any) => failed(error, '获取小爱设备失败'))
          return
        }

        // --- 投播 ---
        if (pathname === '/api/music/xiaoai/play' && req.method === 'POST') {
          void readJsonBody().then(async payload => {
            try {
              const verifiedUsername = resolveXiaoAiUser(req)
              if (verifiedUsername === null) {
                sendJson({ success: false, message: 'Unauthorized' }, 401)
                return
              }
              const songInfo = normalizeSongInfo(payload.songInfo || payload.song || {}) || {}
              const quality = String(payload.quality || songInfo.quality || '320k')
              const deviceIds = Array.isArray(payload.deviceIds) ? payload.deviceIds.map(String) : undefined
              // 参数校验前置：缺歌名/来源属于调用方问题，按 WARN 记一条就够了，
              // 不要走到深层解析再抛异常被记成 ERROR（会污染故障告警）。
              const hasSource = !!(songInfo.source || songInfo.url || songInfo.streamUrl || String(payload.streamUrl || '').trim())
              if (!hasSource) {
                failed(new Error('缺少可投送的歌曲信息（需要 source 或可播放地址）'), '投送小爱失败', 'warn')
                return
              }
              const config = loadXiaoAiConfig()
              const baseUrl = resolvePlayBaseUrl(req, config.serverBaseUrl)
              const streamPath = config.streamPath || '/api/music/xiaoai/stream'
              const songName = String(songInfo.name || songInfo.title || 'track')
              const singer = String(songInfo.singer || songInfo.artist || '')

              const target = await resolveXiaoAiTrack(req, songInfo, quality, verifiedUsername, payload.streamUrl)
              const streamUrl = buildStreamUrl(baseUrl, streamPath, target)
              // 队列线索写进 app.log（console 只进 stdout，容器外看不到）：
              // 自动续播出问题时，能直接从日志判断是「前端算错索引」还是「服务端投送了别的歌」
              const queueIndex = Number.isFinite(Number(payload.queueIndex)) ? Number(payload.queueIndex) : null
              const playMode = typeof payload.playMode === 'string' ? payload.playMode : ''
              const caller = typeof payload.caller === 'string' ? payload.caller : 'manual'
              const seconds = target.durationMs ? Math.round(target.durationMs / 1000) : 0
              const trace = `索引=${queueIndex === null ? '?' : queueIndex} 模式=${playMode || '?'} 调用=${caller}${seconds ? ` 时长=${seconds}s` : ''}`
              console.log(`[XiaoAi] 投送 ${songName}${singer ? ' - ' + singer : ''}（${target.via}｜${trace}）`)
              syncLog.info(`[XiaoAi] 投送 ${songName}${singer ? ' - ' + singer : ''}（${target.via}｜${trace}）`)
              // 投送新歌前，把上一首正在传输的连接作废旧连接：音箱播完一首会拿旧 URL
              // 重拉（songloft #437），否则它会真的把上一首从头再放，听起来就是「切歌前先响上一首」
              try {
                const killed = retireStreams()
                if (killed > 0) syncLog.info(`[XiaoAi] 切歌：已掐断上一首的 ${killed} 路旧流`)
              } catch {
                /* 无旧流可断时忽略 */
              }
              const result = await xiaoAiService.play({
                streamUrl,
                deviceIds,
                song: { name: songName, singer },
              })
              // 记住本次投送的流标识：/status 会把「这一路被拉了几遍」带下去，
              // 前端据此判断音箱是否已经把这首放完（它播完会自己重拉同一个 URL）
              try {
                const tokenStr = decodeURIComponent(streamUrl.split('token=')[1] || '')
                lastXiaoAiStreamSid = parseStreamToken(tokenStr).sid || ''
              } catch {
                lastXiaoAiStreamSid = ''
              }
              if (result.success) {
                lastXiaoAiPushAt = Date.now()
                lastXiaoAiStreamAt = 0
                // 记下这次投送的音源，供后续拖动进度条复用（不重新取链）
                lastXiaoAiSeekSec = 0
                lastXiaoAiTrack = {
                  songInfo,
                  quality,
                  username: verifiedUsername,
                  deviceIds: Array.isArray(deviceIds) ? [...deviceIds] : [],
                  target,
                  durationMs: Number(target.durationMs) || 0,
                }
                // 定时关机（按曲数模式）：每成功投送一首扣一次
                try {
                  const consumed = sleepTimer.consumeSong()
                  if (consumed.fired) syncLog.info('[XiaoAi] 定时关机已触发（按曲数）')
                } catch {
                  /* 定时器异常不能影响投送结果 */
                }
              }
              // 排障盲区：以前「所有设备投送失败」只是把原因塞进响应体，服务端一条痕迹都没有，
              // 用户反馈「点了没反应」时无从查起（catch 只覆盖抛异常，这类是正常返回的失败）。
              if (!result.success) {
                const detail = (Array.isArray(result.results) ? result.results : [])
                  .map((item: any) => `${item?.deviceId || '?'}: ${item?.error || item?.message || '失败'}`)
                  .join('；')
                syncLog.error(`[XiaoAi] 投送失败（${songName}${singer ? ' - ' + singer : ''}）：${detail || '所有设备均未成功'}｜目标设备 ${(Array.isArray(deviceIds) ? deviceIds : []).join(',') || '-'}`)
              }
              sendJson({
                success: result.success,
                streamUrl,
                cached: target.cached,
                via: target.via,
                // 真实音频时长：前端自动续播用它算「还剩几秒」，避免用不可靠的 interval 元数据
                audioDurationMs: target.durationMs || 0,
                device: result.results,
                message: result.success ? '' : '所有设备投送失败，请检查设备在线状态与登录态',
              })
            } catch (error: any) {
              failed(error, '投送小爱失败')
            }
          })
          return
        }

        // --- 预解析下一首（自动续播用；失败不影响播放主流程）---
        if (pathname === '/api/music/xiaoai/prefetch' && req.method === 'POST') {
          void readJsonBody().then(async payload => {
            const verifiedUsername = resolveXiaoAiUser(req)
            if (verifiedUsername === null) {
              sendJson({ success: false, message: 'Unauthorized' }, 401)
              return
            }
            try {
              const songInfo = normalizeSongInfo(payload.songInfo || payload.song || {}) || {}
              const quality = String(payload.quality || songInfo.quality || '320k')
              const target = await resolveXiaoAiTrack(req, songInfo, quality, verifiedUsername)
              sendJson({
                success: true,
                ready: !!(target.url || target.path),
                cached: target.cached,
                via: target.via,
                audioDurationMs: target.durationMs || 0,
              })
            } catch (error: any) {
              sendJson({ success: false, message: error?.message || '预解析失败' })
            }
          })
          return
        }

        // --- 播放控制 ---
        if (pathname === '/api/music/xiaoai/pause' && req.method === 'POST') {
          void readJsonBody().then(async payload => {
            try {
              sendJson({ ...(await xiaoAiService.pause(payload.deviceIds)) })
            } catch (error: any) {
              failed(error, '暂停失败')
            }
          })
          return
        }
        if (pathname === '/api/music/xiaoai/resume' && req.method === 'POST') {
          void readJsonBody().then(async payload => {
            try {
              sendJson({ ...(await xiaoAiService.resume(payload.deviceIds)) })
            } catch (error: any) {
              failed(error, '继续播放失败')
            }
          })
          return
        }
        if (pathname === '/api/music/xiaoai/stop' && req.method === 'POST') {
          void readJsonBody().then(async payload => {
            try {
              sendJson({ ...(await xiaoAiService.stop(payload.deviceIds)) })
            } catch (error: any) {
              failed(error, '停止失败')
            }
          })
          return
        }
        // --- 切回本机播放：让音箱把手上这首放完就停 ---
        // 与 /stop 的区别：/stop 是立刻掐掉这首；这里只标记「放完即止」，
        // 当前这次传输照常走完，音箱播完重拉时回 410 停住（否则会一直重复同一首）
        if (pathname === '/api/music/xiaoai/detach' && req.method === 'POST') {
          void readJsonBody().then(payload => {
            try {
              const sid = String(payload.sid || lastXiaoAiStreamSid || '')
              const ok = markDrainOnly(sid)
              if (ok) {
                console.log(`[XiaoAi] 已切回本机播放：当前流标为放完即止（sid=${sid.slice(0, 8)}）`)
                syncLog.info(`[XiaoAi] 已切回本机播放：当前流标为放完即止（sid=${sid.slice(0, 8)}）`)
              }
              sendJson({ success: ok, sid })
            } catch (error: any) {
              failed(error, '切换本机播放失败')
            }
          })
          return
        }
        if (pathname === '/api/music/xiaoai/seek' && req.method === 'POST') {
          void readJsonBody().then(async payload => {
            try {
              // 和 /play 一样要求登录态：seek 会直接驱动音箱重新播放
              const verifiedUsername = resolveXiaoAiUser(req)
              if (verifiedUsername === null) {
                sendJson({ success: false, message: 'Unauthorized' }, 401)
                return
              }
              const track = lastXiaoAiTrack
              if (!track) {
                sendJson({ success: false, message: '还没有投送过歌曲，无法跳转' }, 400)
                return
              }
              const rawPosition = payload.positionSec
              // Number(null)=0、Number('')=0 都是「有限非负数」，会让 null/空串静默退化成「跳到 0 秒」
              const missingPosition = rawPosition === null || rawPosition === undefined || rawPosition === ''
              const requested = Number(rawPosition)
              if (missingPosition || !Number.isFinite(requested) || requested < 0) {
                sendJson({ success: false, message: 'positionSec 必须是非负数' }, 400)
                return
              }

              // 时长三档兜底：投送时探测到的 → 现场再探一次（探测偶发失败时会补回来）
              // → 设备上报的曲目时长。三者都没有就不夹取，按用户拖的位置直接跳，
              // 也好过退化成「从头重播」。
              if (track.durationMs <= 0 && track.target.path) {
                track.durationMs = probeLocalFileDuration(track.target.path)
              }
              const knownMs = track.durationMs > 0 ? track.durationMs : lastXiaoAiDeviceDurationMs
              const totalSec = knownMs > 0 ? knownMs / 1000 : 0
              // 贴到结尾会切出 0.5 秒碎片，夹到 duration-3（songloft 同款守卫）
              const maxSec = totalSec > 4 ? Math.floor(totalSec - 3) : Math.max(0, Math.floor(totalSec))
              const seekSec =
                totalSec > 0 ? Math.max(0, Math.min(Math.floor(requested), maxSec)) : Math.max(0, Math.floor(requested))
              // 剩余时长：平滑下发按它算码率，传整首会让数据喂得比播放慢 → 卡顿
              const remainingMs = knownMs > 0 ? Math.max(1000, knownMs - seekSec * 1000) : 0
              const base = track.target

              let nextTarget: XiaoAiTrackTarget
              let how = ''
              if (base.path && seekSec > 0 && isMp3File(base.path)) {
                // 本地完整 mp3：切一段（`-ss` + copy，不重编码），走原来的本地直发链路
                const slicePath = seekSlicePath(track.username, track.songInfo, track.quality, seekSec)
                const sliced = await sliceMp3FromFile(base.path, seekSec, slicePath)
                if (!sliced.ok || !sliced.path) {
                  sendJson({ success: false, message: `切片失败：${sliced.error || '未知原因'}` })
                  return
                }
                pruneSeekSlices(track.username, track.songInfo, track.quality)
                nextTarget = {
                  ...base,
                  path: sliced.path,
                  contentType: 'audio/mpeg',
                  durationMs: remainingMs,
                  seekSec,
                  via: `${base.via}｜seek ${seekSec}s`,
                }
                how = sliced.reused ? '切片复用' : '切片'
              } else if (seekSec === 0) {
                // 拖回开头：直接用原音源重投，不留切片
                nextTarget = { ...base, durationMs: track.durationMs || base.durationMs, seekSec: 0 }
                how = '回到开头'
              } else {
                // 远端源 / 本地非 mp3：只能边转边发（`-ss` 在 -i 前），同时 tee 到 seek 目录
                const seekPath = seekSlicePath(track.username, track.songInfo, track.quality, seekSec)
                nextTarget = {
                  ...base,
                  format: 'mp3',
                  seekSec,
                  durationMs: remainingMs,
                  mp3Path: seekPath,
                  via: `${base.via}｜seek ${seekSec}s（流式）`,
                }
                how = '流式 seek'
              }

              const config = loadXiaoAiConfig()
              const baseUrl = resolvePlayBaseUrl(req, config.serverBaseUrl)
              const streamPath = config.streamPath || '/api/music/xiaoai/stream'
              const streamUrl = buildStreamUrl(baseUrl, streamPath, nextTarget)
              try {
                retireStreams()
              } catch {
                /* 没有旧流可断时忽略 */
              }
              const result = await xiaoAiService.play({
                streamUrl,
                deviceIds: track.deviceIds,
                song: {
                  name: String(track.songInfo.name || track.songInfo.title || ''),
                  singer: String(track.songInfo.singer || ''),
                },
              })
              if (!result.success) {
                sendJson({ success: false, message: '跳转投送失败', seekSec })
                return
              }
              lastXiaoAiSeekSec = seekSec
              lastXiaoAiPushAt = Date.now()
              lastXiaoAiStreamAt = 0
              try {
                const tokenStr = decodeURIComponent(streamUrl.split('token=')[1] || '')
                lastXiaoAiStreamSid = parseStreamToken(tokenStr).sid || ''
              } catch {
                lastXiaoAiStreamSid = ''
              }
              const songLabel = `${track.songInfo.name || ''}${track.songInfo.singer ? ' - ' + track.songInfo.singer : ''}`
              console.log(`[XiaoAi] 跳转 ${seekSec}s（${how}｜剩余 ${Math.round(remainingMs / 1000)}s）：${songLabel}`)
              syncLog.info(`[XiaoAi] 跳转 ${seekSec}s（${how}｜剩余 ${Math.round(remainingMs / 1000)}s）：${songLabel}`)
              sendJson({ success: true, seekSec, durationMs: remainingMs, streamUrl, via: how })
            } catch (error: any) {
              failed(error, '跳转失败')
            }
          })
          return
        }
        // 原 /next、/prev 已移除：音箱的播放上下文只有我们推的这一路流，没有队列，
        // 下发 player_next/prev 只会让当前这首从头重播（实测 position 由 5.5s 掉回 2.9s），
        // 而真正的切歌是前端 advanceToNext → playSong → /play 重新投送。
        // 留着这个接口只会让后来的调用方误以为它有用，所以直接删掉（未知接口会落到下面的 404）。
        if (pathname === '/api/music/xiaoai/volume' && req.method === 'POST') {
          void readJsonBody().then(async payload => {
            try {
              sendJson({ ...(await xiaoAiService.setVolume(payload.volume, payload.deviceIds)) })
            } catch (error: any) {
              failed(error, '设置音量失败')
            }
          })
          return
        }
        if (pathname === '/api/music/xiaoai/sleep-timer' && req.method === 'GET') {
          sendJson({ success: true, sleepTimer: sleepTimer.status() })
          return
        }
        if (pathname === '/api/music/xiaoai/sleep-timer' && req.method === 'POST') {
          void readJsonBody().then(payload => {
            try {
              const mode = String(payload.mode || 'off').toLowerCase()
              if (mode === 'off' || mode === 'cancel') {
                sendJson({ success: true, sleepTimer: sleepTimer.cancel('用户关闭') })
                return
              }
              const status = sleepTimer.start({
                mode,
                minutes: Number(payload.minutes) || 0,
                songs: Number(payload.songs) || 0,
              })
              sendJson({ success: true, sleepTimer: status })
            } catch (error: any) {
              // 这里抛的都是「参数不合法」（方式/分钟数/曲数），属用户输入问题，记 WARN
              failed(error, '设置定时关机失败', 'warn')
            }
          })
          return
        }
        if (pathname === '/api/music/xiaoai/status' && req.method === 'GET') {
          const deviceId = String(urlObj.searchParams.get('deviceId') || '')
          void xiaoAiService
            .getStatus(deviceId)
            .then(result => {
              // streamFull：本次投送这一路流被完整拉了几遍。
              // 音箱播完会自己重拉同一个 URL，所以 >=2 就等于「已经放完一遍」，
              // 走 player_play_music 的机型不报进度，这个信号比猜时长可靠。
              const rounds = getStreamRounds(lastXiaoAiStreamSid)
              // 设备上报的曲目时长：本地探测失败时给 seek 兜底，避免「拖到哪都从头播」
              const reportedDuration = Number(
                (result as any)?.raw?.play_song_detail?.duration || (result as any)?.durationMs || 0,
              )
              if (reportedDuration > 0) lastXiaoAiDeviceDurationMs = reportedDuration
              sendJson({
                success: true,
                ...result,
                streamFull: rounds.full,
                streamBytes: rounds.bytes,
                // 音箱已经完整拉过一遍、现在又开始新一轮 → 这首确实播完了（最准的完成信号）
                streamReplay: rounds.replay === true,
                // 本次投送后音箱有没有真的来拉我们这一路流。
                // unplayableCode=2 只说明「曲库把该 audioID 标成 VIP」，不代表没声音：
                // 实测曲库命中 VIP 歌时音箱照样拉我们的直链、正常播放。
                // 前端据此区分「曲库版权标记」与「真的不出声」。
                streamPulled: lastXiaoAiStreamAt > lastXiaoAiPushAt,
                // 设备在线：status=-1 表示读不到播放状态（设备离线 / 登录态失效）。
                // 新增字段不影响既有语义，老前端忽略即可。
                online: Number((result as any)?.status) >= 0,
                // 当前这一路流从第几秒开始：设备上报的 position 是「流内偏移」，
                // 加上它才是曲内位置（songloft 的 streamSeekOffsetSec 同款，不加进度条会掉回 0）
                seekOffsetMs: lastXiaoAiSeekSec * 1000,
                // 实测「投送完成 → 音箱来拉流」的延迟：前端据此把切歌提前量调到真正够用
                startDelayMs: lastXiaoAiStreamAt && lastXiaoAiPushAt ? lastXiaoAiStreamAt - lastXiaoAiPushAt : 0,
              })
            })
            .catch((error: any) => failed(error, '查询小爱状态失败'))
          return
        }

        sendJson({ success: false, message: '未知的小爱接口' }, 404)
        return
      }

      // [新增] 音乐 URL API
      if (pathname === '/api/music/url' && req.method === 'POST') {
        const clientUsername = req.headers['x-user-name'] as string | undefined

        // 鉴权逻辑：如果提供了具名用户，必须通过 Token 或密码验证
        let verifiedUsername = 'open' // userApi 中公开用户标识为 'open'
        if (clientUsername && clientUsername !== 'default' && clientUsername !== 'open' && clientUsername !== '_open') {
          const verified = verifyUserAuth(req)
          if (!verified || verified !== clientUsername) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          verifiedUsername = verified
        }

        const clientId = req.headers['x-client-id'] as string | undefined
        const reqId = req.headers['x-req-id'] as string | undefined

        void readBody(req).then(async body => {
          // 辅助：通过 SSE 推送进度（内置竞态重试，最多等 600ms 让 SSE 连接就绪）
          let sseFailed = false
          const pushProgress = async (attempt: any, retries = 10): Promise<void> => {
            if (!reqId || sseFailed) return
            if (musicProgressClients.has(reqId)) {
              musicProgressClients.get(reqId)!.write(`data: ${JSON.stringify(attempt)}\n\n`)
              return
            }
            if (retries > 0) {
              await new Promise(r => setTimeout(r, 300))
              await pushProgress(attempt, retries - 1)
            } else {
              sseFailed = true
              console.warn(`[进度推送] 经过多次重试未找到 ReqId: ${reqId} (当前已注册 ${musicProgressClients.size} 个客户端)`)
            }
          }

          try {
            let { songInfo, quality, enableAutoSwitchApiSource, excludeApiSources, noCache } = JSON.parse(body)
            songInfo = normalizeSongInfo(songInfo)
            // console.log('[歌曲播放] 歌曲信息:', JSON.stringify(songInfo, null, 2))
            if (!songInfo || !songInfo.source) {
              throw new Error('Invalid songInfo')
            }
            const source = songInfo.source
            let result: any
            // 失败短缓存用的键：平台 + 曲目标识 + 音质（换音质/换平台视为新请求）
            const failKey = buildMusicUrlFailKey(songInfo, quality || '', verifiedUsername)
            // 首次点播给宽预算（别误杀慢源），进入失败重试态才收紧
            const budgetMs = pickMusicUrlBudget(failKey)

            // 本地缓存优先。
            // 这里原来完全没有缓存判定，已缓存的曲子也要把 30+ 个自定义源串行问一遍
            // （实测单曲耗时 45~90 秒，HYWmusic 这类源单个就要 20 秒超时），
            // 前端一旦没命中缓存就会「已缓存的歌也一直在全网找源」。
            // 判定口径与前端 checkServerCache 保持一致：允许音质回退，仅跳过命名冲突。
            if (!noCache) {
              try {
                const cached: any = fileCache.checkCache({ ...songInfo, quality: quality || '' }, verifiedUsername)
                if (cached && cached.exists && !cached.isCollision && cached.url) {
                  const token = req.headers['x-user-token'] as string | undefined
                  // <audio>/下载都走不了自定义请求头，鉴权 token 只能挂在 query 上
                  if (token && !String(cached.url).includes('token=')) {
                    cached.url += `&token=${encodeURIComponent(token)}`
                  }
                  result = {
                    url: cached.url,
                    type: 'local',
                    sourceName: '本地缓存',
                    sourceId: 'local-cache',
                    quality: cached.quality || quality,
                    folder: cached.folder,
                    attempts: [{ name: '本地缓存', status: 'success' }],
                  }
                  void pushProgress({ name: '本地缓存', status: 'success' })
                  console.log(`[歌曲播放] 命中本地缓存，直接返回: ${songInfo.name} (${cached.quality})`)
                }
              } catch (e: any) {
                console.warn(`[歌曲播放] 缓存查询异常（忽略，继续取链）: ${e?.message || e}`)
              }
            }

            // 失败短缓存：同一首歌 TTL 内重复请求直接复用上次的失败结论，
            // 不再把 30 多个自定义源重问一遍（这是「音源整体失效时请求风暴」的主要成本）。
            if (!result && MUSIC_URL_FAIL_TTL_MS) {
              const remembered = readMusicUrlFailure(failKey)
              if (remembered) {
                const waitSec = Math.max(1, Math.round(remembered.retryAfterMs / 1000))
                console.warn(`[歌曲播放] 命中失败短缓存（${waitSec}s 后可重试）: ${songInfo.name} — ${remembered.message}`)
                const err: any = new Error(remembered.message)
                err.attempts = remembered.attempts
                err.failureCached = true
                err.retryAfterMs = remembered.retryAfterMs
                throw err
              }
            }

            // 额外音源（Bilibili / 汽水）不依赖 musicSdk、也不依赖自定义源：
            // 搜索由 extraSources 提供，取流同样自带（B站匿名可用，配了 Cookie 才有大会员音质）。
            // 命中本地缓存时跳过（否则会把缓存结果覆盖成一次全新的远端取链）。
            if (!result && extraSources.isExtraSource(source)) {
              try {
                const extra = await withHardBudget(
                  extraSources.getMusicUrl(source, songInfo, quality || '128k', verifiedUsername),
                  budgetMs,
                  `${extraSources.displayName(source)} 取链`,
                )
                if (!extra) {
                  throw new Error(`${extraSources.displayName(source)} 取链超时（${Math.round(budgetMs / 1000)} 秒）`)
                }

                // 汽水加密流：随取链响应下发的 CENC 加密 MP4，其 AES 密钥（spade_a）已在
                // getAudioUrl 里捕获并登记（extra.key）。这里不再「判死 DRM」，而是走
                // 「下载 → 本地解密落缓存 → 返回明文缓存地址」，让首播即可播。
                // 无密钥（非加密曲 / 没拿到 spade_a）才维持原直链透传逻辑。
                const sodaKey = source === 'soda' ? (extra as any).key : ''
                if (source === 'soda' && sodaKey) {
                  let cached = fileCache.checkCache({ ...songInfo, quality: quality || '' }, verifiedUsername)
                  if (!(cached && cached.exists && !cached.isCollision && cached.url)) {
                    // 下载并本地解密（downloadAndCache 内部已支持 decryptKey）
                    await fileCache.downloadAndCache(
                      songInfo, extra.url, quality || '128k', verifiedUsername, undefined,
                      false, false, false,
                      { requestedSource: source, downloadSource: source, sourceName: extra.sourceName, decryptKey: sodaKey },
                    )
                    cached = fileCache.checkCache({ ...songInfo, quality: quality || '' }, verifiedUsername)
                  }
                  if (!cached || !cached.exists || !cached.url) {
                    throw new Error('汽水加密曲下载/解密失败，无法生成可播放地址')
                  }
                  console.log(`[汽水解密] 返回已解密缓存地址: ${songInfo.name} (${cached.quality || quality})`)
                  result = {
                    url: cached.url,
                    type: 'local',
                    sourceName: `${extra.sourceName}（已解密）`,
                    sourceId: 'extra:soda',
                    quality: cached.quality || quality || extra.type,
                    folder: cached.folder,
                    attempts: [{ name: extra.sourceName, status: 'success' }],
                  }
                  void pushProgress({ name: extra.sourceName, status: 'success' })
                } else {
                  // B站 / 汽水非加密曲：直链透传（仍保留加密流兜底拦截）
                  if (await isEncryptedRemoteStream(extra.url)) {
                    throw new Error(
                      `${extraSources.displayName(source)} 该曲返回的是加密流（DRM），浏览器无法播放，请改用它源或其他平台播放`
                    )
                  }
                  result = {
                    url: extra.url,
                    type: extra.type,
                    sourceName: extra.sourceName,
                    sourceId: `extra:${source}`,
                    attempts: [{ name: extra.sourceName, status: 'success' }],
                  }
                  void pushProgress({ name: extra.sourceName, status: 'success' })
                }
              } catch (e: any) {
                console.error(`[额外音源] ${source} 取链失败:`, e?.message || e)
                rememberMusicUrlFailure(failKey, e?.message || String(e))
                throw e
              }
            }

            // 账号通道独立于自定义源存在：即使一个自定义源都没装，
            // 只要管理员配了自己的平台 Cookie，也应该能播。所以这里放宽进入条件。
            // 使用权限：名单外的用户不算「账号可用」（名单为空=所有人可用），
            // 让下面「未找到支持平台的自定义源」的报错文案回到正确分支。
            const accountUsable = musicAccount.isEnabled() &&
              musicAccount.isSupportedSource(source) &&
              musicAccount.hasAccount(source) &&
              isUserAllowed(verifiedUsername)

            let customSourceError: string | null = null
            let attempts: any[] = []
            if (!result && (isSourceSupported(source, verifiedUsername) || accountUsable)) {
              try {
                console.log(`[歌曲播放] 使用自定义源解析: ${source} (请求ID: ${reqId || '无'}, 用户: ${verifiedUsername})`)

                const userApiResult = await withHardBudget(
                  callUserApiGetMusicUrl(
                    source, songInfo, quality || '128k', verifiedUsername,
                    (attempt) => { void pushProgress(attempt) },
                    enableAutoSwitchApiSource !== false,
                    excludeApiSources
                  ),
                  budgetMs,
                  '自定义源取链',
                )
                if (!userApiResult) {
                  // 预算内没有任何源返回地址：抛出去走统一的「解析失败」分支（会写失败短缓存）
                  throw new Error(`取链超时：${Math.round(budgetMs / 1000)} 秒内没有任何源返回可用地址`)
                }
                result = userApiResult
                attempts = userApiResult.attempts || []
              } catch (userApiError: any) {
                console.error(`[歌曲播放] 自定义源解析失败:`, userApiError.message)
                customSourceError = userApiError.message
                attempts = userApiError.attempts || []
                // 不抛出错误，继续尝试内置源
              }
            } else if (!result) {
              // isSourceSupported = false: 无任何自定义源支持此平台，立即通知前端
              const why = musicAccount.isSupportedSource(source)
                ? `未找到支持 ${source} 平台的自定义源；如已在「平台账号」里填写 Cookie，请确认总开关已打开`
                : `未找到支持 ${source} 平台的自定义源，请在设置中添加或启用相关源`
              void pushProgress({ name: '系统', status: 'fail', message: why })
            }

            // 自定义源失败则直接报错（内置 SDK 无独立解析能力，回退无意义）
            if (!result) {
              const fallbackMsg = accountUsable
                ? `自定义源与你配置的账号都未能取到链接（账号见 /health 日志里的 [平台账号] 记录）`
                : `未找到支持 ${source} 平台的自定义源，请在设置中添加或启用相关源`
              const errMsg = customSourceError || fallbackMsg
              const err: any = new Error(errMsg)
              err.attempts = attempts
              rememberMusicUrlFailure(failKey, errMsg, attempts)
              throw err
            }

            // 有 result 却没有可用地址。
            // 实测出现过三种：① 上游返回 200 但字段为空（url:null）；
            // ② 酷我账号通道把上游的 Python None 原样当字符串 "None" 返回来；
            // ③ 自定义源把占位串拼进地址，凑出一个「形似合法」的 http://host/None。
            // 后两种以前都被当成取链成功，前端拿它当 src 必然播放失败，
            // 于是触发「播不出来 → 换源 → 再失败」的循环，还查不到原因。
            const resolvedUrl = String(result?.url || '').trim()
            const placeholder = /(?:^|[/=&#?])(?:None|undefined)(?:[/=&#?]|$)/.test(resolvedUrl)
            const urlUsable = !!resolvedUrl
              && (/^https?:\/\//i.test(resolvedUrl) || resolvedUrl.startsWith('/'))
              && !placeholder
            if (!urlUsable) {
              const errMsg = !resolvedUrl
                ? '音源未返回播放地址（上游返回为空）'
                : `音源返回的地址不可用（${resolvedUrl.slice(0, 60)}）`
              const err: any = new Error(errMsg)
              err.attempts = attempts
              rememberMusicUrlFailure(failKey, errMsg, attempts)
              throw err
            }

            // 解析成功：把这首歌的失败记录清掉（上一轮失败可能是临时抖动）
            if (MUSIC_URL_FAIL_TTL_MS) {
              musicUrlFailures.delete(failKey)
              musicUrlRecentFails.delete(failKey)
            }

            // 合并解析尝试记录到响应（前端可用于诊断）
            if (attempts.length > 0) result.attempts = attempts

            // [Fix] Server-side Mixed Content handling & Redirect Resolution
            // If the upstream URL is HTTP, rewrite it to use our secure proxy OR resolve it if it's a redirect
            if (result && result.url) {
              // 1. Resolve Redirects (301, 302, 307, etc.) to get direct link
              try {
                // Only try to resolve if it looks like a remote URL and is not already resolved
                if (result.url.startsWith('http')) {
                  // console.log(`[歌曲播放] 正在解析重定向: ${songInfo.name} (${quality})`);

                  const checkRedirect = async (u: string, depth: number = 0): Promise<string> => {
                    if (depth > 3) return u // Max depth 3
                    try {
                      const resp = await needle('head', u, null, {
                        follow_max: 0,
                        response_timeout: 4000, // Increase timeout slightly
                        read_timeout: 4000,
                        // 解析的是音乐平台链接，归 music 分类
                        agent: await getProxyAgent(u, 'music'),
                        headers: buildStreamHeaders(u),
                      })
                      if (resp.statusCode && [301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
                        let nextUrl = resp.headers.location
                        if (!nextUrl.startsWith('http')) {
                          try { nextUrl = new URL(nextUrl, u).href } catch (e) { }
                        }
                        // console.log(`[歌曲播放] 解析重定向 [${resp.statusCode}]: ${u.substring(0, 50)}... -> ${nextUrl.substring(0, 50)}...`)
                        return checkRedirect(nextUrl, depth + 1)
                      }
                      // If error status but not redirect, return original
                      if (resp.statusCode !== undefined && resp.statusCode >= 400) {
                        console.warn(`[歌曲播放] 重定向探测返回异常状态码 ${resp.statusCode}，使用原始链接`);
                        return u;
                      }
                    } catch (e: any) {
                      console.warn(`[歌曲播放] HEAD 校验重定向失败: ${e.message}`);
                    }
                    return u
                  }

                  const finalUrl = await checkRedirect(result.url)
                  if (finalUrl !== result.url) {
                    result.url = finalUrl
                  }
                  // console.log(`[歌曲播放] 最终解析音频链接: ${result.url.substring(0, 100)}...`);
                }
              } catch (e) {
                console.error('[歌曲播放] 解析重定向发生异常:', e)
              }

              // 2. Mixed Content Handling (Optional Proxy) implementation details handled by frontend now
              // But we can keep the log for debugging
              if (result.url.startsWith('http://')) {
                // console.log(`[歌曲播放] 提示: 音频链接为 HTTP 协议: ${result.url}`)
              }

              result.requestedSource = songInfo.source
              result.downloadSource = fileCache.detectDownloadSource(result.url, songInfo.source)
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err: any) {
            console.error('[歌曲播放] 音频地址解析失败:', err.message)
            // [Fix] Return 500 but with specific error JSON to let frontend show detailed toast
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              error: err.message,
              code: 500,
              attempts: err.attempts,
              // 命中失败短缓存时告诉前端「多久后可重试」，前端据此退避而不是立刻重来
              failureCached: err.failureCached === true,
              retryAfterMs: err.retryAfterMs,
            }))
          }
        })
        return
      }

      // [新增] 音质真实大小 API
      if (pathname === '/api/music/quality/size' && req.method === 'POST') {
        const clientUsername = req.headers['x-user-name'] as string | undefined

        let verifiedUsername = 'open'
        if (clientUsername && clientUsername !== 'default' && clientUsername !== 'open' && clientUsername !== '_open') {
          const verified = verifyUserAuth(req)
          if (!verified || verified !== clientUsername) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          verifiedUsername = verified
        }

        void readBody(req).then(async body => {
          try {
            let { songInfo, quality } = JSON.parse(body)
            songInfo = normalizeSongInfo(songInfo)
            if (!songInfo || !songInfo.source || !quality) {
              throw new Error('Invalid quality size request')
            }

            const result = await resolveServerSong(songInfo, quality, verifiedUsername, false)
            const bytes = await getAudioRemoteSize(result.url)
            if (!bytes) throw new Error('无法读取真实文件大小')

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              success: true,
              quality,
              bytes,
              size: formatBytes(bytes),
              type: result.quality,
              source: fileCache.detectDownloadSource(result.url, result.downloadSource || result.songInfo?.source),
              sourceName: result.sourceName,
            }))
          } catch (err: any) {
            console.error('[音质探测] 获取文件大小失败:', err.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: err.message, code: 500 }))
          }
        })
        return
      }

      // [新增] 歌词 API
      if (pathname === '/api/music/lyric' && req.method === 'POST') {
        void readBody(req).then(async body => {
          try {
            let { songInfo } = JSON.parse(body)
            songInfo = normalizeSongInfo(songInfo)
            if (!songInfo || !songInfo.source) {
              throw new Error('Invalid songInfo')
            }
            const source = songInfo.source
            if (!musicSdk[source] || !musicSdk[source].getLyric) {
              throw new Error(`Source ${source} not supported`)
            }
            const result = await musicSdk[source].getLyric(songInfo)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err: any) {
            console.error(err)
            res.writeHead(500)
            res.end(err.message)
          }
        })
        return
      }

      // [新增] 热搜 API
      if (pathname === '/api/music/hotSearch' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'mg'

        try {
          // 检查是否支持热搜
          if (!musicSdk[source] || !musicSdk[source].hotSearch) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: '该音源不支持热搜功能' }))
            return
          }

          // console.log(`[热搜服务] 获取热搜: source=${source}`)
          const result = await musicSdk[source].hotSearch.getList()

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300' // 5分钟缓存
          })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error('[热搜服务] 获取热搜失败:', err.message)
          // Return empty array instead of 500 to keep UI stable
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify([]))
        }
        return
      }

      // [新增] 歌单分类标签 API
      if (pathname === '/api/music/songList/tags' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.getTags()
          const sortList = musicSdk[source].songList.sortList
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ...result, sortList }))
        } catch (err: any) {
          console.error(`[歌单服务] 获取歌单分类标签失败:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取歌单标签失败' }))
        }
        return
      }
      // [新增] 歌单列表 API
      if (pathname === '/api/music/songList/list' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        const tagId = urlObj.searchParams.get('tagId') || ''
        const sortId = urlObj.searchParams.get('sortId') || 'hot'
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.getList(sortId, tagId, page)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[歌单服务] 获取歌单列表失败:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取歌单列表失败' }))
        }
        return
      }
      // [新增] 歌单详情 API
      if (pathname === '/api/music/songList/detail' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        const id = urlObj.searchParams.get('id')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!id) {
          res.writeHead(400)
          res.end('Missing id')
          return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.getListDetail(id, page)
          if (result && result.list) {
            result.list = result.list.map(normalizeSongInfo)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[歌单服务] 获取歌单详情失败:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取歌单详情失败' }))
        }
        return
      }
      // [新增] 歌单搜索 API
      if (pathname === '/api/music/songList/search' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        const text = urlObj.searchParams.get('text')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!text) {
          res.writeHead(400)
          res.end('Missing text')
          return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.search(text, page)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[歌单服务] 搜索歌单失败:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '搜索歌单失败' }))
        }
        return
      }

      // [新增] 获取用户歌单 API
      if (pathname === '/api/music/songList/userPlaylist' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'tx'
        const uid = urlObj.searchParams.get('uid')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!uid) {
          res.writeHead(400)
          res.end('Missing uid')
          return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].userPlaylist) {
            throw new Error(`Source ${source} does not support userPlaylist`)
          }
          const result = await musicSdk[source].userPlaylist.getList(uid, page)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[用户歌单] 获取用户歌单失败:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取用户歌单失败' }))
        }
        return
      }

      // [新增] 排行榜 - 获取榜单列表 API
      if (pathname === '/api/music/leaderboard/boards' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'kg'
        try {
          if (!musicSdk[source] || !musicSdk[source].leaderboard) {
            throw new Error(`Source ${source} does not support leaderboard`)
          }
          const result = await musicSdk[source].leaderboard.getBoards()
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=600'
          })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[排行榜] 获取排行榜列表失败:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取排行榜列表失败' }))
        }
        return
      }

      // [新增] 排行榜 - 获取榜单内歌曲 API
      if (pathname === '/api/music/leaderboard/list' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'kg'
        const bangid = urlObj.searchParams.get('bangid')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!bangid) {
          res.writeHead(400); res.end('Missing bangid'); return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].leaderboard) {
            throw new Error(`Source ${source} does not support leaderboard`)
          }
          const result = await musicSdk[source].leaderboard.getList(bangid, page)
          if (result && result.list) {
            result.list = result.list.map(normalizeSongInfo)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[排行榜] 获取排行榜歌曲失败:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取排行榜歌曲失败' }))
        }
        return
      }

      // [新增] 评论 API
      if (pathname === '/api/music/comment' && req.method === 'POST') {
        void readBody(req).then(async body => {
          try {
            let { songInfo, type, page, limit } = JSON.parse(body)
            songInfo = normalizeSongInfo(songInfo)
            if (!songInfo || !songInfo.source) {
              console.warn('[评论服务] 无效的请求参数:', body)
              throw new Error('Invalid songInfo')
            }
            const source = songInfo.source
            console.log(`[评论服务] 请求评论: ${source} - ${songInfo.name} - ${type} - 第 ${page} 页`)

            if (!musicSdk[source] || !musicSdk[source].comment) {
              console.warn(`[评论服务] 音源 ${source} 不支持评论功能`)
              throw new Error(`Source ${source} not supported for comments`)
            }

            const method = type === 'hot' ? 'getHotComment' : 'getComment'
            console.log(`[评论服务] 歌曲: ${songInfo.name}, ID: ${songInfo.songmid}, 音源: ${source}`)

            if (!musicSdk[source].comment[method]) {
              console.warn(`[评论服务] 方法 ${method} 不被音源 ${source} 支持`)
              throw new Error(`Method ${method} not supported for source ${source}`)
            }

            const result = await musicSdk[source].comment[method](songInfo, page, limit)
            console.log(`[评论服务] 获取成功: ${source} - 共找到 ${result.comments?.length} 条评论`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err: any) {
            console.error('[评论服务] 获取评论发生异常:', err.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message, code: 500 }))
          }
        })
        return
      }

      // [新增] dislike 规则 API
      // 与 Subsonic 评分联动共用同一份 lx-music 原生规则，保证各端一致：
      //   GET  /api/music/dislike        返回已解析的规则集（歌曲 / 歌手 / 专辑）
      //   POST /api/music/dislike/add     body: { type, name?, singer?, source?, albumId? }
      //   POST /api/music/dislike/remove  body: 同上
      if (pathname === '/api/music/dislike' && req.method === 'GET') {
        const verified = verifyUserAuth(req)
        if (!verified) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void getUserSpace(verified).dislikeManage.getDislikeRules().then(rules => {
          const dm = getUserSpace(verified).dislikeManage
          const rulesString = dm.dislikeDataManage.getDislikeRulesString()
          const data: any = serializeDislikeRules(rulesString, verified)
          data.dislikeList = dm.dislikeDataManage.dislikeRules.dislikeList || []
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ success: true, data, options: dislikeMatchOptions() }))
        }).catch((err: any) => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: err.message }))
        })
        return
      }

      if ((pathname === '/api/music/dislike/add' || pathname === '/api/music/dislike/remove') && req.method === 'POST') {
        void readBody(req).then(async body => {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          try {
            const isAdd = pathname === '/api/music/dislike/add'
            const payload = JSON.parse(body || '{}')
            const type = String(payload.type || 'song')
            const name = String(payload.name || '')
            const singer = String(payload.singer || '')
            const source = String(payload.source || '')
            const id = String(payload.id || '')
            const albumId = String(payload.albumId || '')
            const pic = String(payload.pic || '')
            const interval = String(payload.interval || '')
            const meta = payload.meta || {}

            const dm = getUserSpace(verified).dislikeManage

            let removeKeys: Set<string> = new Set()
            if (type === 'album') {
              const albumName = String(payload.albumName || '')
              if (!albumName) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: 'Missing albumName' }))
                return
              }
              const singers = splitSingers(singer)
              if (isAdd) await dm.dislikeDataManage.addDislikeAlbums(singers.map(s => ({ albumName, singer: s })))
              else for (const s of singers) {
                removeKeys.add(encodeAlbumRule(normalizeText(albumName), s))
                removeKeys.add(normalizeText(encodeAlbumRule(albumName, s)))
              }
            } else if (type === 'singer') {
              if (!singer) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: 'Missing singer' }))
                return
              }
              if (isAdd) await dm.dislikeDataManage.addDislikeInfo([{ name: '', singer, dislikeRule: '' }])
              else removeKeys.add(`@${normalizeText(singer)}`)
            } else {
              if (!name) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: 'Missing name' }))
                return
              }
              if (isAdd) {
                const { type, ...songData } = payload
                songData.dislikeRule = ''
                await dm.dislikeDataManage.addDislikeInfo([songData])
              } else {
                if (singer) {
                  removeKeys.add(`${name}@${singer}`.toLowerCase())
                  removeKeys.add(`${normalizeText(name)}@${normalizeText(singer)}`.toLowerCase())
                }
                removeKeys.add(name.toLowerCase())
                removeKeys.add(normalizeText(name).toLowerCase())
              }
            }

            const dislikeRatingThreshold = global.lx.config['subsonic.dislikeRating'] ?? 1
            if (global.lx.config['subsonic.linkDislikeToRating'] && dislikeRatingThreshold > 0 && id && source) {
              const subId = id.startsWith(`${source}_`) ? id : `${source}_${id}`
              try {
                const { syncDislikeToRating } = require('./subsonic')
                await syncDislikeToRating(verified, subId, isAdd ? 1 : 0)
              } catch (e) {
                console.error('[黑名单 API] 评分回写失败:', e)
              }
            }

            if (!isAdd && removeKeys.size > 0) {
              const rulesString = dm.dislikeDataManage.getDislikeRulesString()
              const lines = rulesString.split('\n').filter((l: string) => l.trim())
              const remain = lines.filter((l: string) => {
                const trimmed = l.trim().toLowerCase()
                if (removeKeys.has(trimmed)) return false
                // Also check without spaces or with alias
                return true
              })
              if (remain.length !== lines.length) {
                await dm.dislikeDataManage.overwirteDislikeInfo(remain.join('\n'))
              }
            }

            await dm.createSnapshot()
            invalidateDislikeCache(verified)
            const rules = await dm.getDislikeRules()
            const finalRulesString = dm.dislikeDataManage.getDislikeRulesString()
            const data: any = serializeDislikeRules(finalRulesString, verified)
            data.dislikeList = dm.dislikeDataManage.dislikeRules.dislikeList || []
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify({ success: true, data, options: dislikeMatchOptions() }))
          } catch (err: any) {
            console.error('[黑名单 API] 处理异常:', err?.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message }))
          }
        })
        return
      }

      // [新增] 封面 API (备用)

      // [新增] 自定义源管理 API
      // 注：此处不再进行全局强制鉴权，鉴权逻辑已下放到 customSourceHandlers 中，
      // 以便根据请求体中的 username 字段判断是否需要校验管理员密码。

      // [新增] 管理员身份验证接口
      if (pathname === '/api/admin/verify' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth === global.lx.config['admin.password']) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: '管理员密码验证失败' }))
        }
        return
      }

      if (pathname === '/api/custom-source/validate' && req.method === 'POST') {
        return customSourceHandlers.handleValidate(req, res)
      }

      // 所有自定义源修改接口通用鉴权 (如果是公开访问限制模式，则必须登录)
      if (pathname.startsWith('/api/custom-source/') && req.method === 'POST' && pathname !== '/api/custom-source/validate') {
        if (global.lx.config['user.enablePublicRestriction']) {
          const auth = req.headers['x-frontend-auth']
          const isAdmin = auth === global.lx.config['admin.password']
          const user = verifyUserAuth(req)
          if (!isAdmin && !user) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: '当前系统已开启访问限制，管理操作请登录后重试。' }))
            return
          }
        }
      }

      if (pathname === '/api/custom-source/import' && req.method === 'POST') {
        return customSourceHandlers.handleImport(req, res)
      }
      if (pathname === '/api/custom-source/upload' && req.method === 'POST') {
        return customSourceHandlers.handleUpload(req, res)
      }
      if (pathname === '/api/custom-source/list' && req.method === 'GET') {
        const username = urlObj.searchParams.get('username') || 'default'

        // 鉴权逻辑：如果开启了页面公开访问限制
        if (global.lx.config['user.enablePublicRestriction']) {
          const auth = req.headers['x-frontend-auth']
          const isAdmin = auth === global.lx.config['admin.password']
          const user = verifyUserAuth(req)
          if (!isAdmin && !user) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: '当前系统已开启公开访问限制，请登录后重试。' }))
            return
          }
        }

        return customSourceHandlers.handleList(req, res, username)
      }
      if (pathname === '/api/custom-source/toggle' && req.method === 'POST') {
        return customSourceHandlers.handleToggle(req, res)
      }
      if (pathname === '/api/custom-source/delete' && req.method === 'POST') {
        return customSourceHandlers.handleDelete(req, res)
      }

      if (pathname === '/api/custom-source/reorder' && req.method === 'POST') {
        return customSourceHandlers.handleReorder(req, res)
      }
      if (pathname === '/api/custom-source/update-platforms' && req.method === 'POST') {
        return customSourceHandlers.handleUpdatePlatforms(req, res)
      }

      // ===== 自检护栏：可疑音源的手动处置 =====
      // 静态特征只是「可疑」不是「恶意」，自动禁用会误杀混淆过的正常音源，
      // 所以这里只提供处置接口，由用户在面板上决定信任还是隔离。
      if (pathname.startsWith('/api/source-guard/') && req.method === 'POST') {
        const action = pathname.slice('/api/source-guard/'.length).split('?')[0]
        void (async () => {
          try {
            if (req.headers['x-frontend-auth'] !== global.lx.config['admin.password']) {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: '权限不足：处置自定义源需要管理员身份。' }))
              return
            }
            const { owner, id, name } = JSON.parse(await readBody(req))
            if (!id) throw new Error('缺少音源ID')
            const targetOwner = (owner && owner !== 'default' && owner !== 'open') ? owner : 'open'

            let payload: Record<string, unknown> = { success: true }
            if (action === 'trust') {
              trustSource(targetOwner, id)
            } else if (action === 'untrust') {
              payload = { success: untrustSource(targetOwner, id) }
            } else if (action === 'isolate') {
              payload = { success: isolateManually(targetOwner, id, name || id) }
            } else if (action === 'release') {
              payload = { success: clearIsolation(targetOwner, id) }
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: `未知操作: ${action}` }))
              return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ...payload, id, owner: targetOwner }))
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
          }
        })()
        return
      }

      // elFinder 文件管理器连接器
      if (pathname === '/api/elfinder/connector') {
        // [修改] 优先从 Header 获取，如果没有则尝试从 URL 参数获取 (用于支持下载和预览)
        const auth = req.headers['x-frontend-auth'] || urlObj.searchParams.get('auth')

        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        // 处理GET请求
        if (req.method === 'GET') {
          void (async () => {
            try {
              const params: any = {}
              const url = new URL(req.url || '', `http://${req.headers.host}`)
              url.searchParams.forEach((value, key) => {
                params[key] = value
              })

              const connector = new ElFinderConnector(getSystemRoot())
              const cmd = params.cmd || 'open'
              const result = await connector.handle(cmd, params)

              // [新增] 处理文件下载 (file) 和 打包下载 (zipdl)
              if ((cmd === 'file' || cmd === 'zipdl') && result.path && !result.error) {
                if (fs.existsSync(result.path)) {
                  const mime = getMime(result.path)
                  const headers: any = { 'Content-Type': mime }

                  // 如果是下载请求，或者是打包下载，强制添加附件头
                  if (params.download === '1' || cmd === 'zipdl') {
                    headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(result.path))}"`
                  }

                  res.writeHead(200, headers)
                  fs.createReadStream(result.path).pipe(res)
                  return
                } else {
                  res.writeHead(404)
                  res.end('Not Found')
                  return
                }
              }

              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(result))
            } catch (err: any) {
              res.writeHead(500)
              res.end(JSON.stringify({ error: [err.message] }))
            }
          })()
          return
        }

        // 处理POST请求
        if (req.method === 'POST') {
          const contentType = req.headers['content-type'] || ''

          // 处理文件上传
          if (contentType.includes('multipart/form-data')) {
            const form = formidable({ multiples: true, uploadDir: require('os').tmpdir() })

            form.parse(req, async (err: any, fields: any, files: any) => {
              if (err) {
                res.writeHead(500)
                res.end(JSON.stringify({ error: ['Upload error'] }))
                return
              }

              const params = { ...fields }
              // formidable v3 返回的值可能是数组，需要转换
              for (const key in params) {
                if (Array.isArray(params[key]) && params[key].length === 1) {
                  params[key] = params[key][0]
                }
              }
              console.log('[文件管理] 接收到上传文件列表:', Object.keys(files))
              console.log('[文件管理] 接收到文件详情:', files)
              try {
                // 获取上传的文件（字段名可能是 upload, upload[] 等）
                const uploadedFiles = files.upload || files['upload[]'] || Object.values(files)[0]

                if (params.cmd === 'upload' && uploadedFiles) {
                  const connector = new ElFinderConnector(getSystemRoot())
                  const uploadFiles = Array.isArray(uploadedFiles) ? uploadedFiles : [uploadedFiles]
                  const added: any[] = []

                  for (const file of uploadFiles) {
                    const target = (connector as any).decode(params.target)
                    const destPath = require('path').join(target, file.originalFilename || file.newFilename)
                    await require('fs').promises.copyFile(file.filepath, destPath)
                    await require('fs').promises.unlink(file.filepath)

                    const fileInfo = await (connector as any).getFileInfo(destPath)
                    if (fileInfo) added.push(fileInfo)
                  }

                  res.writeHead(200, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ added }))
                } else {
                  const connector = new ElFinderConnector(getSystemRoot())
                  const cmd = params.cmd || 'open'
                  const result = await connector.handle(cmd, params)

                  res.writeHead(200, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify(result))
                }
              } catch (err: any) {
                res.writeHead(500)
                res.end(JSON.stringify({ error: [err.message] }))
              }
            })
            return
          } else {
            // 普通POST数据
            void readBody(req).then(async body => {
              try {
                // 修改开始：兼容 JSON 和 x-www-form-urlencoded
                let params: any = {}
                try {
                  params = JSON.parse(body || '{}')
                } catch (e) {
                  // 如果 JSON 解析失败，尝试解析为 URL 查询参数格式
                  const urlParams = new URLSearchParams(body)
                  urlParams.forEach((value, key) => {
                    // 处理数组情况 (例如 targets[])
                    if (params[key]) {
                      if (Array.isArray(params[key])) {
                        params[key].push(value)
                      } else {
                        params[key] = [params[key], value]
                      }
                    } else {
                      params[key] = value
                    }
                  })
                }
                // 修改结束

                const connector = new ElFinderConnector(getSystemRoot())
                const cmd = params.cmd || 'open'
                const result = await connector.handle(cmd, params)

                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(result))
              } catch (err: any) {
                res.writeHead(500)
                res.end(JSON.stringify({ error: [err.message] }))
              }
            })
            return
          }
        }

        return
      }


      // Configuration API
      if (pathname === '/api/config') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        if (req.method === 'GET') {
          const config = {
            serverName: global.lx.config.serverName,
            'debug.enabled': global.lx.config['debug.enabled'] || false,
            maxSnapshotNum: global.lx.config.maxSnapshotNum,
            'list.addMusicLocationType': global.lx.config['list.addMusicLocationType'],
            'proxy.enabled': global.lx.config['proxy.enabled'],
            'proxy.header': global.lx.config['proxy.header'],
            'user.enablePath': global.lx.config['user.enablePath'],
            'user.enableRoot': global.lx.config['user.enableRoot'],
            'user.enablePublicRestriction': global.lx.config['user.enablePublicRestriction'],
            'user.enablePublicNonAdminLocalMusic': global.lx.config['user.enablePublicNonAdminLocalMusic'],
            'user.enablePublicNonAdminBrowserDownload': global.lx.config['user.enablePublicNonAdminBrowserDownload'] ?? true,
            'user.enablePublicNonAdminServerCache': global.lx.config['user.enablePublicNonAdminServerCache'] ?? false,
            'user.enablePublicFavorites': global.lx.config['user.enablePublicFavorites'],
            'user.enablePublicNonAdminAccess': global.lx.config['user.enablePublicNonAdminAccess'],
            'user.enableCustomMusicDir': global.lx.config['user.enableCustomMusicDir'] ?? false,
            'user.enableLoginCacheRestriction': global.lx.config['user.enableLoginCacheRestriction'],
            'user.enableCacheSizeLimit': global.lx.config['user.enableCacheSizeLimit'],
            'user.cacheSizeLimit': global.lx.config['user.cacheSizeLimit'],
            'cache.maxAgeDays': typeof global.lx.config['cache.maxAgeDays'] !== 'undefined' ? global.lx.config['cache.maxAgeDays'] : 14,
            'admin.password': global.lx.config['admin.password'],
            'player.name': global.lx.config['player.name'] || 'LX Music Web',
            'player.enableAuth': global.lx.config['player.enableAuth'] || false,
            'player.password': global.lx.config['player.password'] || '',
            'webdav.enable': global.lx.config['webdav.enable'] ?? false,
            'webdav.url': global.lx.config['webdav.url'] || '',
            'webdav.username': global.lx.config['webdav.username'] || '',
            'webdav.password': global.lx.config['webdav.password'] || '',
            'webdav.syncPath': global.lx.config['webdav.syncPath'] || '/lx-sync',
            'webdav.backupPath': global.lx.config['webdav.backupPath'] || '/lx-sync-backups',
            'sync.interval': global.lx.config['sync.interval'] || 60,
            'sync.backupInterval': global.lx.config['sync.backupInterval'] || 24,
            'webdav.excludeCache': global.lx.config['webdav.excludeCache'] ?? false,
            'webdav.excludeMusic': global.lx.config['webdav.excludeMusic'] ?? false,
            'proxy.all.enabled': global.lx.config['proxy.all.enabled'] || false,
            'proxy.all.address': global.lx.config['proxy.all.address'] || '',
            // 三类细分代理：enabled 为 undefined 表示「沿用上面的统一开关」
            'proxy.music.enabled': global.lx.config['proxy.music.enabled'],
            'proxy.music.address': global.lx.config['proxy.music.address'] || '',
            'proxy.customSource.enabled': global.lx.config['proxy.customSource.enabled'],
            'proxy.customSource.address': global.lx.config['proxy.customSource.address'] || '',
            'proxy.app.enabled': global.lx.config['proxy.app.enabled'],
            'proxy.app.address': global.lx.config['proxy.app.address'] || '',
            'admin.path': global.lx.config['admin.path'] ?? '/music',
            'player.path': global.lx.config['player.path'] ?? '/',
            'subsonic.enable': global.lx.config['subsonic.enable'] ?? true,
            'subsonic.path': global.lx.config['subsonic.path'] ?? '/rest',
            'subsonic.port': global.lx.config['subsonic.port'] ?? 0,
            'subsonic.enableDebug': global.lx.config['subsonic.enableDebug'] ?? false,
            'subsonic.onlineSearch': global.lx.config['subsonic.onlineSearch'] ?? true,
            'subsonic.onlineSearchMode': global.lx.config['subsonic.onlineSearchMode'] ?? 'fallback',
            'subsonic.onlineSearchSources': global.lx.config['subsonic.onlineSearchSources'] ?? 'wy,tx,kw,kg,mg',
            'subsonic.publicLeaderboards': global.lx.config['subsonic.publicLeaderboards'] ?? false,
            'subsonic.leaderboardSource': global.lx.config['subsonic.leaderboardSource'] ?? 'tx',
            'subsonic.sharedListMode': global.lx.config['subsonic.sharedListMode'] ?? 'leaderboard',
            'subsonic.sharedListSort': global.lx.config['subsonic.sharedListSort'] ?? 'hot',
            'subsonic.dislikeRating': global.lx.config['subsonic.dislikeRating'] ?? 1,
            'subsonic.linkRatingToDislike': global.lx.config['subsonic.linkRatingToDislike'] ?? false,
            'subsonic.linkDislikeToRating': global.lx.config['subsonic.linkDislikeToRating'] ?? false,
            'subsonic.hideDisliked': global.lx.config['subsonic.hideDisliked'] ?? true,
            'subsonic.dislikeCrossSource': global.lx.config['subsonic.dislikeCrossSource'] ?? false,
            'subsonic.dislikeNoRecommend': global.lx.config['subsonic.dislikeNoRecommend'] ?? true,
            'subsonic.dislikeDuetMode': global.lx.config['subsonic.dislikeDuetMode'] ?? 'any',
            'subsonic.dislikeNormalizeName': global.lx.config['subsonic.dislikeNormalizeName'] ?? true,
            'subsonic.dislikeRequireSinger': global.lx.config['subsonic.dislikeRequireSinger'] ?? true,
            'subsonic.lyricTranslation': global.lx.config['subsonic.lyricTranslation'] ?? true,
            'subsonic.cacheOnPlay': global.lx.config['subsonic.cacheOnPlay'] ?? false,
            'subsonic.playCacheFirst': global.lx.config['subsonic.playCacheFirst'] ?? true,
            'subsonic.quality.enabled': global.lx.config['subsonic.quality.enabled'] ?? true,
            'subsonic.quality.priority': global.lx.config['subsonic.quality.priority'] ?? 'flac,320k,128k',
            'subsonic.quality.clientCapMode': global.lx.config['subsonic.quality.clientCapMode'] ?? 'soft',
            'subsonic.source.priority': global.lx.config['subsonic.source.priority'] ?? 'kw,tx,wy,mg,kg',
            'subsonic.source.crossPlatform': global.lx.config['subsonic.source.crossPlatform'] ?? true,
            'subsonic.source.autoSwitchCustom': global.lx.config['subsonic.source.autoSwitchCustom'] ?? true,
            'singer.sourcePriority': (global.lx.config['singer.sourcePriority'] || ['tx', 'wy']).join(','),
            'artist.maxFetchPages': global.lx.config['artist.maxFetchPages'] ?? 20,
            'system.allowUnsafeVM': global.lx.config['system.allowUnsafeVM'] || false,
            // 音源平台可用性巡检：此前只能手改 config.js，改完还要重启才生效
            'customSource.probe.enabled': global.lx.config['customSource.probe.enabled'] !== false,
            'customSource.probe.intervalMinutes': Number(global.lx.config['customSource.probe.intervalMinutes']) || 180,
            'customSource.probe.failThreshold': Number(global.lx.config['customSource.probe.failThreshold']) || 2,
            'customSource.probe.concurrency': Math.min(8, Math.max(1, Number(global.lx.config['customSource.probe.concurrency']) || 6)),
            'customSource.probe.autoDisablePlatform': global.lx.config['customSource.probe.autoDisablePlatform'] !== false,
            'customSource.probe.autoRemoveSource': global.lx.config['customSource.probe.autoRemoveSource'] !== false,
            'customSource.probe.removeMode': global.lx.config['customSource.probe.removeMode'] === 'delete' ? 'delete' : 'trash',
            'configBackup.enable': global.lx.config['configBackup.enable'] ?? true,
            'configBackup.retentionDays': global.lx.config['configBackup.retentionDays'] ?? 7,
            'configBackup.dir': global.lx.config['configBackup.dir'] ?? '',
            'snapshot.backupPath': global.lx.config['snapshot.backupPath'] ?? '',
            'musicAccount.enabled': global.lx.config['musicAccount.enabled'] ?? false,
            'musicAccount.priority': global.lx.config['musicAccount.priority'] !== false,
            'musicAccount.timeoutMs': global.lx.config['musicAccount.timeoutMs'] ?? 15000,
            subsonicPortConflict: global.lx.subsonicPortConflict || null,
            configFilePath: global.lx.configPath || process.env.CONFIG_PATH || path.join(global.lx.dataPath, 'config.js'),
          }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          })
          res.end(JSON.stringify(config))
          return
        }

        if (req.method === 'POST') {
          void readBody(req).then(body => {
            try {
              const newConfig = JSON.parse(body)
              if (newConfig.serverName !== undefined) global.lx.config.serverName = newConfig.serverName
              if (newConfig['debug.enabled'] !== undefined) global.lx.config['debug.enabled'] = newConfig['debug.enabled']
              if (newConfig.maxSnapshotNum !== undefined) global.lx.config.maxSnapshotNum = parseInt(newConfig.maxSnapshotNum)
              if (newConfig['list.addMusicLocationType'] !== undefined) global.lx.config['list.addMusicLocationType'] = newConfig['list.addMusicLocationType']
              if (newConfig['proxy.enabled'] !== undefined) global.lx.config['proxy.enabled'] = newConfig['proxy.enabled']
              if (newConfig['proxy.header'] !== undefined) global.lx.config['proxy.header'] = newConfig['proxy.header']
              if (newConfig['user.enablePath'] !== undefined) global.lx.config['user.enablePath'] = newConfig['user.enablePath']
              // 新增：处理 user.enableRoot
              if (newConfig['user.enableRoot'] !== undefined) global.lx.config['user.enableRoot'] = newConfig['user.enableRoot']
              if (newConfig['user.enablePublicRestriction'] !== undefined) global.lx.config['user.enablePublicRestriction'] = newConfig['user.enablePublicRestriction']
              if (newConfig['user.enablePublicNonAdminLocalMusic'] !== undefined) global.lx.config['user.enablePublicNonAdminLocalMusic'] = newConfig['user.enablePublicNonAdminLocalMusic']
              if (newConfig['user.enablePublicNonAdminBrowserDownload'] !== undefined) global.lx.config['user.enablePublicNonAdminBrowserDownload'] = newConfig['user.enablePublicNonAdminBrowserDownload']
              if (newConfig['user.enablePublicNonAdminServerCache'] !== undefined) global.lx.config['user.enablePublicNonAdminServerCache'] = newConfig['user.enablePublicNonAdminServerCache']
              if (newConfig['user.enablePublicFavorites'] !== undefined) global.lx.config['user.enablePublicFavorites'] = newConfig['user.enablePublicFavorites']
              if (newConfig['user.enablePublicNonAdminAccess'] !== undefined) global.lx.config['user.enablePublicNonAdminAccess'] = newConfig['user.enablePublicNonAdminAccess']
              if (newConfig['user.enableCustomMusicDir'] !== undefined) global.lx.config['user.enableCustomMusicDir'] = newConfig['user.enableCustomMusicDir']
              if (newConfig['user.enableLoginCacheRestriction'] !== undefined) global.lx.config['user.enableLoginCacheRestriction'] = newConfig['user.enableLoginCacheRestriction']
              if (newConfig['user.enableCacheSizeLimit'] !== undefined) global.lx.config['user.enableCacheSizeLimit'] = newConfig['user.enableCacheSizeLimit']
              if (newConfig['user.cacheSizeLimit'] !== undefined) global.lx.config['user.cacheSizeLimit'] = parseInt(newConfig['user.cacheSizeLimit']) || 2000
              if (newConfig['cache.maxAgeDays'] !== undefined) global.lx.config['cache.maxAgeDays'] = Math.max(0, parseInt(newConfig['cache.maxAgeDays']) || 0)
              if (newConfig['system.allowUnsafeVM'] !== undefined) global.lx.config['system.allowUnsafeVM'] = newConfig['system.allowUnsafeVM']

              // 音源平台可用性巡检
              if (newConfig['customSource.probe.enabled'] !== undefined) {
                global.lx.config['customSource.probe.enabled'] = !!newConfig['customSource.probe.enabled']
              }
              if (newConfig['customSource.probe.intervalMinutes'] !== undefined) {
                global.lx.config['customSource.probe.intervalMinutes'] = Math.max(5, parseInt(newConfig['customSource.probe.intervalMinutes']) || 180)
              }
              if (newConfig['customSource.probe.failThreshold'] !== undefined) {
                global.lx.config['customSource.probe.failThreshold'] = Math.max(1, parseInt(newConfig['customSource.probe.failThreshold']) || 2)
              }
              if (newConfig['customSource.probe.concurrency'] !== undefined) {
                global.lx.config['customSource.probe.concurrency'] = Math.min(8, Math.max(1, parseInt(newConfig['customSource.probe.concurrency']) || 6))
              }
              if (newConfig['customSource.probe.autoDisablePlatform'] !== undefined) {
                global.lx.config['customSource.probe.autoDisablePlatform'] = !!newConfig['customSource.probe.autoDisablePlatform']
              }
              if (newConfig['customSource.probe.autoRemoveSource'] !== undefined) {
                global.lx.config['customSource.probe.autoRemoveSource'] = !!newConfig['customSource.probe.autoRemoveSource']
              }
              if (newConfig['customSource.probe.removeMode'] !== undefined) {
                global.lx.config['customSource.probe.removeMode'] = newConfig['customSource.probe.removeMode'] === 'delete' ? 'delete' : 'trash'
              }

              // 巡检开关与间隔改动后立即重排任务。
              // 不能指望配置文件热重载：那边的 hash 判定会把「本次保存自己触发的
              // fs.watch 事件」当成无实质变化跳过，改完要等重启才生效。
              if (Object.keys(newConfig).some(k => k.startsWith('customSource.probe.'))) {
                try {
                  scheduler.updateTaskConfig('custom_source_health_probe', {
                    enabled: global.lx.config['customSource.probe.enabled'] !== false,
                    intervalMs: (Number(global.lx.config['customSource.probe.intervalMinutes']) || 180) * 60 * 1000,
                  })
                } catch { /* 调度器尚未启动时忽略 */ }
              }

              let warning = ''

              // 校验：至少开启一种模式
              if (!global.lx.config['user.enablePath'] && !global.lx.config['user.enableRoot']) {
                // 如果都关闭了，强制开启根路径（或者报错，这里建议强制开启并警告）
                global.lx.config['user.enableRoot'] = true
                warning = '必须至少开启一种连接方式，已自动开启“根路径”模式。'
              }

              // 校验：如果开启了根路径，检查密码重复
              if (global.lx.config['user.enableRoot']) {
                const passwords = global.lx.config.users.map(u => u.password)
                if (new Set(passwords).size !== passwords.length) {
                  warning = warning ? warning + '\n' : ''
                  warning += '检测到重复密码！开启“根路径”模式要求所有用户密码唯一，否则可能导致连接错误。'
                }
              }
              if (newConfig['admin.password'] !== undefined) global.lx.config['admin.password'] = newConfig['admin.password']

              // Web播放器配置
              if (newConfig['player.name'] !== undefined) global.lx.config['player.name'] = newConfig['player.name']
              if (newConfig['player.enableAuth'] !== undefined) global.lx.config['player.enableAuth'] = newConfig['player.enableAuth']
              if (newConfig['player.password'] !== undefined) global.lx.config['player.password'] = newConfig['player.password']

              // WebDAV 配置
              if (newConfig['webdav.enable'] !== undefined) global.lx.config['webdav.enable'] = newConfig['webdav.enable']
              if (newConfig['webdav.url'] !== undefined) global.lx.config['webdav.url'] = newConfig['webdav.url']
              if (newConfig['webdav.username'] !== undefined) global.lx.config['webdav.username'] = newConfig['webdav.username']
              if (newConfig['webdav.password'] !== undefined) global.lx.config['webdav.password'] = newConfig['webdav.password']
              if (newConfig['webdav.syncPath'] !== undefined) global.lx.config['webdav.syncPath'] = newConfig['webdav.syncPath']
              if (newConfig['webdav.backupPath'] !== undefined) global.lx.config['webdav.backupPath'] = newConfig['webdav.backupPath']
              if (newConfig['sync.interval'] !== undefined) global.lx.config['sync.interval'] = parseInt(newConfig['sync.interval'])
              if (newConfig['sync.backupInterval'] !== undefined) global.lx.config['sync.backupInterval'] = parseInt(newConfig['sync.backupInterval']) || 24
              if (newConfig['webdav.excludeCache'] !== undefined) global.lx.config['webdav.excludeCache'] = !!newConfig['webdav.excludeCache']
              if (newConfig['webdav.excludeMusic'] !== undefined) global.lx.config['webdav.excludeMusic'] = !!newConfig['webdav.excludeMusic']
              const validateAndCleanProxy = (addr: any) => {
                if (!addr || typeof addr !== 'string') return ''
                const trimmed = addr.trim()
                if (!trimmed) return ''
                try {
                  const parsed = new URL(trimmed)
                  if (['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(parsed.protocol)) return trimmed
                  return ''
                } catch {
                  return ''
                }
              }

              if (newConfig['proxy.all.enabled'] !== undefined) global.lx.config['proxy.all.enabled'] = newConfig['proxy.all.enabled']
              if (newConfig['proxy.all.address'] !== undefined) global.lx.config['proxy.all.address'] = validateAndCleanProxy(newConfig['proxy.all.address'])
                // 细分代理：null 表示「沿用统一开关」(写回 undefined，序列化时省略)
                ; (['music', 'customSource', 'app'] as const).forEach(cat => {
                  const cfg: any = global.lx.config
                  const kEnabled = `proxy.${cat}.enabled`
                  const kAddress = `proxy.${cat}.address`
                  if (newConfig[kEnabled] !== undefined) {
                    cfg[kEnabled] = newConfig[kEnabled] === null ? undefined : !!newConfig[kEnabled]
                  }
                  if (newConfig[kAddress] !== undefined) {
                    cfg[kAddress] = newConfig[kAddress] === null ? '' : validateAndCleanProxy(newConfig[kAddress])
                  }
                })

              if (newConfig['admin.path'] !== undefined || newConfig['player.path'] !== undefined) {
                const adminPath = (newConfig['admin.path'] !== undefined ? newConfig['admin.path'] : (global.lx.config['admin.path'] ?? '/admin'))
                const playerPath = (newConfig['player.path'] !== undefined ? newConfig['player.path'] : (global.lx.config['player.path'] ?? '/'))
                const normalizedAdmin = adminPath.replace(/\/+$/, '')
                const normalizedPlayer = playerPath.replace(/\/+$/, '')

                if (normalizedPlayer !== '' && !normalizedPlayer.startsWith('/')) {
                  res.writeHead(422, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ success: false, error: '播放器路径必须以 / 开头或为空（代表根路径）' }))
                  return
                }
                if (normalizedAdmin !== '' && !normalizedAdmin.startsWith('/')) {
                  res.writeHead(422, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ success: false, error: '后台路径必须以 / 开头或为空' }))
                  return
                }
                if ((normalizedAdmin || '/') === (normalizedPlayer || '/')) {
                  res.writeHead(422, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ success: false, error: '后台管理路径与播放器路径不能相同' }))
                  return
                }
                if (normalizedAdmin.startsWith('/api') || normalizedPlayer.startsWith('/api')) {
                  res.writeHead(422, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ success: false, error: '路径不能以 /api 开头' }))
                  return
                }
                global.lx.config['admin.path'] = normalizedAdmin
                global.lx.config['player.path'] = normalizedPlayer
              }

              // [路径合法性校验] 校验配置备份目录与歌单快照路径
              const validateDirectoryPath = (rawPath: string, fieldName: string): string => {
                const trimmed = rawPath.trim()
                if (!trimmed) return ''
                // 检查系统非法字符 (如 < > " | ? *)
                if (/[<>"|?*]/.test(trimmed)) {
                  throw new Error(`${fieldName} 包含非法字符 (< > " | ? *)`)
                }
                const resolved = path.isAbsolute(trimmed) ? trimmed : path.join(global.lx.dataPath, trimmed)
                // 尝试创建目录检测有效性与写入权限
                try {
                  fs.mkdirSync(resolved, { recursive: true })
                  fs.accessSync(resolved, fs.constants.W_OK)
                } catch (e: any) {
                  throw new Error(`${fieldName} 路径无效或无写入权限 (${resolved}): ${e.message || e}`)
                }
                return trimmed
              }

              if (newConfig['configBackup.dir'] !== undefined) {
                try {
                  global.lx.config['configBackup.dir'] = validateDirectoryPath(String(newConfig['configBackup.dir']), '配置备份目录')
                } catch (err: any) {
                  res.writeHead(422, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ success: false, error: err.message }))
                  return
                }
              }

              if (newConfig['snapshot.backupPath'] !== undefined) {
                try {
                  global.lx.config['snapshot.backupPath'] = validateDirectoryPath(String(newConfig['snapshot.backupPath']), '歌单快照备份路径')
                } catch (err: any) {
                  res.writeHead(422, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ success: false, error: err.message }))
                  return
                }
              }

              // 新增：Subsonic 配置保存逻辑
              if (newConfig['subsonic.enable'] !== undefined) global.lx.config['subsonic.enable'] = newConfig['subsonic.enable']
              if (newConfig['subsonic.path'] !== undefined) {
                global.lx.config['subsonic.path'] = newConfig['subsonic.path'].replace(/\/+$/, '') || '/rest'
              }
              if (newConfig['subsonic.port'] !== undefined) {
                const port = parseInt(newConfig['subsonic.port'], 10)
                global.lx.config['subsonic.port'] = !isNaN(port) && port >= 0 ? port : 0
              }
              if (newConfig['subsonic.enableDebug'] !== undefined) global.lx.config['subsonic.enableDebug'] = newConfig['subsonic.enableDebug']
              // [本地配置备份] configBackup 配置
              // 平台账号（Cookie 本体不在这里保存，只存开关；Cookie 走 /api/music/accounts）
              if (newConfig['musicAccount.enabled'] !== undefined) global.lx.config['musicAccount.enabled'] = !!newConfig['musicAccount.enabled']
              if (newConfig['musicAccount.priority'] !== undefined) global.lx.config['musicAccount.priority'] = !!newConfig['musicAccount.priority']
              if (newConfig['musicAccount.timeoutMs'] !== undefined) {
                const tm = Number(newConfig['musicAccount.timeoutMs'])
                global.lx.config['musicAccount.timeoutMs'] = Number.isFinite(tm) ? Math.min(60000, Math.max(3000, Math.floor(tm))) : 15000
              }

              if (newConfig['configBackup.enable'] !== undefined) global.lx.config['configBackup.enable'] = !!newConfig['configBackup.enable']
              if (newConfig['configBackup.retentionDays'] !== undefined) {
                const rd = Number(newConfig['configBackup.retentionDays'])
                global.lx.config['configBackup.retentionDays'] = Number.isFinite(rd) && rd > 0 ? Math.floor(rd) : 7
              }
              if (newConfig['subsonic.onlineSearch'] !== undefined) global.lx.config['subsonic.onlineSearch'] = newConfig['subsonic.onlineSearch']
              if (newConfig['subsonic.onlineSearchMode'] !== undefined) global.lx.config['subsonic.onlineSearchMode'] = newConfig['subsonic.onlineSearchMode']
              if (newConfig['subsonic.onlineSearchSources'] !== undefined) global.lx.config['subsonic.onlineSearchSources'] = newConfig['subsonic.onlineSearchSources']
              if (newConfig['subsonic.publicLeaderboards'] !== undefined) global.lx.config['subsonic.publicLeaderboards'] = newConfig['subsonic.publicLeaderboards']
              if (newConfig['subsonic.leaderboardSource'] !== undefined) {
                const s = String(newConfig['subsonic.leaderboardSource']).trim().toLowerCase()
                if (['tx', 'wy', 'kg', 'kw', 'mg'].includes(s)) global.lx.config['subsonic.leaderboardSource'] = s
              }
              if (newConfig['subsonic.sharedListMode'] !== undefined) {
                const m = String(newConfig['subsonic.sharedListMode']).trim().toLowerCase()
                if (['leaderboard', 'playlist', 'both'].includes(m)) global.lx.config['subsonic.sharedListMode'] = m as any
              }
              if (newConfig['subsonic.sharedListSort'] !== undefined) {
                const st = String(newConfig['subsonic.sharedListSort']).trim().toLowerCase()
                if (['hot', 'new'].includes(st)) global.lx.config['subsonic.sharedListSort'] = st as any
              }
              if (newConfig['subsonic.dislikeRating'] !== undefined) global.lx.config['subsonic.dislikeRating'] = Number(newConfig['subsonic.dislikeRating'])
              if (newConfig['subsonic.hideDisliked'] !== undefined) global.lx.config['subsonic.hideDisliked'] = !!newConfig['subsonic.hideDisliked']
              if (newConfig['subsonic.dislikeCrossSource'] !== undefined) global.lx.config['subsonic.dislikeCrossSource'] = !!newConfig['subsonic.dislikeCrossSource']
              if (newConfig['subsonic.dislikeNoRecommend'] !== undefined) global.lx.config['subsonic.dislikeNoRecommend'] = !!newConfig['subsonic.dislikeNoRecommend']
              if (newConfig['subsonic.dislikeDuetMode'] !== undefined) {
                const dm = String(newConfig['subsonic.dislikeDuetMode']).trim().toLowerCase()
                if (['any', 'all', 'primary'].includes(dm)) global.lx.config['subsonic.dislikeDuetMode'] = dm as any
              }
              if (newConfig['subsonic.dislikeNormalizeName'] !== undefined) global.lx.config['subsonic.dislikeNormalizeName'] = !!newConfig['subsonic.dislikeNormalizeName']
              if (newConfig['subsonic.dislikeRequireSinger'] !== undefined) global.lx.config['subsonic.dislikeRequireSinger'] = !!newConfig['subsonic.dislikeRequireSinger']
              if (newConfig['subsonic.linkRatingToDislike'] !== undefined) global.lx.config['subsonic.linkRatingToDislike'] = !!newConfig['subsonic.linkRatingToDislike']
              if (newConfig['subsonic.linkDislikeToRating'] !== undefined) global.lx.config['subsonic.linkDislikeToRating'] = !!newConfig['subsonic.linkDislikeToRating']
              if (newConfig['subsonic.recommendPoolSize'] !== undefined) global.lx.config['subsonic.recommendPoolSize'] = Number(newConfig['subsonic.recommendPoolSize'])
              if (newConfig['subsonic.lyricTranslation'] !== undefined) global.lx.config['subsonic.lyricTranslation'] = newConfig['subsonic.lyricTranslation']
              if (newConfig['subsonic.cacheOnPlay'] !== undefined) global.lx.config['subsonic.cacheOnPlay'] = newConfig['subsonic.cacheOnPlay']
              if (newConfig['subsonic.playCacheFirst'] !== undefined) global.lx.config['subsonic.playCacheFirst'] = newConfig['subsonic.playCacheFirst']
              if (newConfig['subsonic.quality.enabled'] !== undefined) global.lx.config['subsonic.quality.enabled'] = !!newConfig['subsonic.quality.enabled']
              if (newConfig['subsonic.quality.priority'] !== undefined) global.lx.config['subsonic.quality.priority'] = String(newConfig['subsonic.quality.priority'])
              if (newConfig['subsonic.quality.clientCapMode'] !== undefined && ['hard', 'soft'].includes(newConfig['subsonic.quality.clientCapMode'])) global.lx.config['subsonic.quality.clientCapMode'] = newConfig['subsonic.quality.clientCapMode']
              if (newConfig['subsonic.source.priority'] !== undefined) global.lx.config['subsonic.source.priority'] = String(newConfig['subsonic.source.priority'])
              if (newConfig['subsonic.source.crossPlatform'] !== undefined) global.lx.config['subsonic.source.crossPlatform'] = !!newConfig['subsonic.source.crossPlatform']
              if (newConfig['subsonic.source.autoSwitchCustom'] !== undefined) global.lx.config['subsonic.source.autoSwitchCustom'] = !!newConfig['subsonic.source.autoSwitchCustom']
              if (newConfig['singer.sourcePriority'] !== undefined) {
                const priority = String(newConfig['singer.sourcePriority']).split(',').filter(s => s === 'tx' || s === 'wy') as Array<'tx' | 'wy'>
                if (priority.length > 0) global.lx.config['singer.sourcePriority'] = priority
              }
              if (newConfig['artist.maxFetchPages'] !== undefined) {
                const maxPages = Number(newConfig['artist.maxFetchPages'])
                global.lx.config['artist.maxFetchPages'] = Number.isFinite(maxPages) && maxPages > 0
                  ? Math.min(Math.floor(maxPages), 100)
                  : 20
              }

              // 更新 WebDAVSync 配置
              if (global.lx.webdavSync && (newConfig['webdav.enable'] !== undefined || newConfig['webdav.url'] || newConfig['webdav.username'] || newConfig['webdav.password'] || newConfig['webdav.syncPath'] || newConfig['webdav.backupPath'] || newConfig['sync.interval'] || newConfig['sync.backupInterval'] || newConfig['webdav.excludeCache'] !== undefined || newConfig['webdav.excludeMusic'] !== undefined)) {
                global.lx.webdavSync.updateConfig({
                  enable: global.lx.config['webdav.enable'],
                  url: global.lx.config['webdav.url'],
                  username: global.lx.config['webdav.username'],
                  password: global.lx.config['webdav.password'],
                  syncPath: global.lx.config['webdav.syncPath'],
                  backupPath: global.lx.config['webdav.backupPath'],
                  interval: global.lx.config['sync.interval'],
                  backupInterval: global.lx.config['sync.backupInterval'],
                  excludeCache: global.lx.config['webdav.excludeCache'],
                  excludeMusic: global.lx.config['webdav.excludeMusic'],
                })
              }

              const configPath = global.lx.configPath || process.env.CONFIG_PATH || path.join(global.lx.dataPath, 'config.js')
              const configContent = `module.exports = ${JSON.stringify({
                serverName: global.lx.config.serverName,
                bindIP: global.lx.config.bindIP,
                port: global.lx.config.port,
                'proxy.enabled': global.lx.config['proxy.enabled'],
                'proxy.header': global.lx.config['proxy.header'],
                'user.enablePath': global.lx.config['user.enablePath'],
                'user.enableRoot': global.lx.config['user.enableRoot'],
                'user.enablePublicRestriction': global.lx.config['user.enablePublicRestriction'],
                'user.enablePublicNonAdminLocalMusic': global.lx.config['user.enablePublicNonAdminLocalMusic'],
                'user.enablePublicNonAdminBrowserDownload': global.lx.config['user.enablePublicNonAdminBrowserDownload'],
                'user.enablePublicNonAdminServerCache': global.lx.config['user.enablePublicNonAdminServerCache'],
                'user.enablePublicFavorites': global.lx.config['user.enablePublicFavorites'],
                'user.enablePublicNonAdminAccess': global.lx.config['user.enablePublicNonAdminAccess'],
                'user.enableCustomMusicDir': global.lx.config['user.enableCustomMusicDir'],
                'user.enableLoginCacheRestriction': global.lx.config['user.enableLoginCacheRestriction'],
                'user.enableCacheSizeLimit': global.lx.config['user.enableCacheSizeLimit'],
                'user.cacheSizeLimit': global.lx.config['user.cacheSizeLimit'],
                'cache.maxAgeDays': typeof global.lx.config['cache.maxAgeDays'] !== 'undefined' ? global.lx.config['cache.maxAgeDays'] : 14,
                maxSnapshotNum: global.lx.config.maxSnapshotNum,
                'list.addMusicLocationType': global.lx.config['list.addMusicLocationType'],
                'debug.enabled': global.lx.config['debug.enabled'] || false,
                disableTelemetry: global.lx.config.disableTelemetry,
                'admin.password': global.lx.config['admin.password'],
                'player.name': global.lx.config['player.name'],
                'player.enableAuth': global.lx.config['player.enableAuth'],
                'player.password': global.lx.config['player.password'],
                'webdav.enable': global.lx.config['webdav.enable'],
                'webdav.url': global.lx.config['webdav.url'],
                'webdav.username': global.lx.config['webdav.username'],
                'webdav.password': global.lx.config['webdav.password'],
                'webdav.syncPath': global.lx.config['webdav.syncPath'],
                'webdav.backupPath': global.lx.config['webdav.backupPath'],
                'sync.interval': global.lx.config['sync.interval'],
                'sync.backupInterval': global.lx.config['sync.backupInterval'],
                'webdav.excludeCache': global.lx.config['webdav.excludeCache'],
                'webdav.excludeMusic': global.lx.config['webdav.excludeMusic'],
                'proxy.all.enabled': global.lx.config['proxy.all.enabled'],
                'proxy.all.address': global.lx.config['proxy.all.address'],
                // undefined 会被序列化省略 -> 下次启动仍为「沿用统一开关」
                'proxy.music.enabled': global.lx.config['proxy.music.enabled'],
                'proxy.music.address': global.lx.config['proxy.music.address'] || '',
                'proxy.customSource.enabled': global.lx.config['proxy.customSource.enabled'],
                'proxy.customSource.address': global.lx.config['proxy.customSource.address'] || '',
                'proxy.app.enabled': global.lx.config['proxy.app.enabled'],
                'proxy.app.address': global.lx.config['proxy.app.address'] || '',
                'admin.path': global.lx.config['admin.path'] ?? '/admin',
                'player.path': global.lx.config['player.path'] ?? '/',
                'subsonic.enable': global.lx.config['subsonic.enable'],
                'subsonic.path': global.lx.config['subsonic.path'],
                'subsonic.port': global.lx.config['subsonic.port'] ?? 0,
                'subsonic.enableDebug': global.lx.config['subsonic.enableDebug'],
                'subsonic.onlineSearch': global.lx.config['subsonic.onlineSearch'],
                'subsonic.onlineSearchMode': global.lx.config['subsonic.onlineSearchMode'],
                'subsonic.onlineSearchSources': global.lx.config['subsonic.onlineSearchSources'],
                'subsonic.publicLeaderboards': global.lx.config['subsonic.publicLeaderboards'],
                'subsonic.leaderboardSource': global.lx.config['subsonic.leaderboardSource'],
                'subsonic.sharedListMode': global.lx.config['subsonic.sharedListMode'],
                'subsonic.sharedListSort': global.lx.config['subsonic.sharedListSort'],
                'subsonic.dislikeRating': global.lx.config['subsonic.dislikeRating'],
                'subsonic.linkRatingToDislike': global.lx.config['subsonic.linkRatingToDislike'],
                'subsonic.linkDislikeToRating': global.lx.config['subsonic.linkDislikeToRating'],
                'subsonic.hideDisliked': global.lx.config['subsonic.hideDisliked'],
                'subsonic.dislikeCrossSource': global.lx.config['subsonic.dislikeCrossSource'],
                'subsonic.dislikeNoRecommend': global.lx.config['subsonic.dislikeNoRecommend'],
                'subsonic.dislikeDuetMode': global.lx.config['subsonic.dislikeDuetMode'],
                'subsonic.dislikeNormalizeName': global.lx.config['subsonic.dislikeNormalizeName'],
                'subsonic.dislikeRequireSinger': global.lx.config['subsonic.dislikeRequireSinger'],
                'subsonic.recommendPoolSize': global.lx.config['subsonic.recommendPoolSize'],
                'subsonic.lyricTranslation': global.lx.config['subsonic.lyricTranslation'],
                'subsonic.cacheOnPlay': global.lx.config['subsonic.cacheOnPlay'],
                'subsonic.playCacheFirst': global.lx.config['subsonic.playCacheFirst'],
                'subsonic.quality.enabled': global.lx.config['subsonic.quality.enabled'],
                'subsonic.quality.priority': global.lx.config['subsonic.quality.priority'],
                'subsonic.quality.clientCapMode': global.lx.config['subsonic.quality.clientCapMode'],
                'subsonic.source.priority': global.lx.config['subsonic.source.priority'],
                'subsonic.source.crossPlatform': global.lx.config['subsonic.source.crossPlatform'],
                'subsonic.source.autoSwitchCustom': global.lx.config['subsonic.source.autoSwitchCustom'],
                'configBackup.enable': global.lx.config['configBackup.enable'],
                'configBackup.retentionDays': global.lx.config['configBackup.retentionDays'],
                'configBackup.dir': global.lx.config['configBackup.dir'],
                'snapshot.backupPath': global.lx.config['snapshot.backupPath'] || '',
                'singer.sourcePriority': global.lx.config['singer.sourcePriority'],
                'artist.maxFetchPages': global.lx.config['artist.maxFetchPages'],
                'cache.namingPattern': global.lx.config['cache.namingPattern'],
                'system.allowUnsafeVM': global.lx.config['system.allowUnsafeVM'],
                users: global.lx.config.users.map(u => ({
                  name: u.name,
                  password: u.password,
                  maxSnapshotNum: u.maxSnapshotNum,
                  'list.addMusicLocationType': u['list.addMusicLocationType'],
                  enableCustomMusicDir: u.enableCustomMusicDir,
                  customMusicDir: u.customMusicDir,
                  allowOperateCustomMusicDir: u.allowOperateCustomMusicDir,
                })),
              }, null, 2)}`
              if (typeof global.lx?.saveConfig === 'function') {
                global.lx.saveConfig()
              }

              // 动态热迁移所有活跃用户空间的快照目录
              if (newConfig['snapshot.backupPath'] !== undefined) {
                updateAllUserSnapshotDirs(global.lx.config['snapshot.backupPath'])
              }

              // 触发一次 WebDAV 同步检查（如果已配置）
              if (global.lx.webdavSync && global.lx.webdavSync.isConfigured()) {
                void global.lx.webdavSync.syncChangedFiles()
              }

              res.writeHead(200)
              res.end(JSON.stringify({ success: true, warning }))
            } catch (e) {
              res.writeHead(500)
              res.end('Server Error')
            }
          })
          return
        }
      }

      // [配置备份管理 API] 获取备份列表及状态
      if (pathname === '/api/config/backups' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Unauthorized' }))
          return
        }

        try {
          const backupDir = global.lx.getConfigBackupDir ? global.lx.getConfigBackupDir() : path.join(global.lx.dataPath, 'backups')
          const list: Array<{ name: string, size: number, time: number, type: 'auto' | 'manual' }> = []

          if (fs.existsSync(backupDir)) {
            const files = fs.readdirSync(backupDir)
            for (const file of files) {
              if (!/^config-.*\.js$/.test(file)) continue
              const fp = path.join(backupDir, file)
              try {
                const stat = fs.statSync(fp)
                const isManual = file.startsWith('config-manual-')

                // 优先从文件名解析精确时间戳
                let timestamp = 0
                const manualMatch = file.match(/^config-manual-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})\.js$/)
                const autoMatch = file.match(/^config-(\d{4})-(\d{2})-(\d{2})\.js$/)

                if (manualMatch) {
                  const [, y, m, d, h, min, s] = manualMatch
                  timestamp = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s)).getTime()
                } else if (autoMatch) {
                  // 自动备份若与 mtime/birthtime 在同一天，优先使用文件修改时间以展示具体时刻；否则取日期当天 00:00
                  timestamp = stat.mtimeMs || stat.birthtimeMs || 0
                }

                if (!timestamp) {
                  timestamp = Math.max(stat.birthtimeMs || 0, stat.mtimeMs || 0)
                }

                list.push({
                  name: file,
                  size: stat.size,
                  time: timestamp,
                  type: isManual ? 'manual' : 'auto',
                })
              } catch { }
            }
          }

          // 按时间倒序排序（从新到旧）
          list.sort((a, b) => b.time - a.time)

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          })
          res.end(JSON.stringify({
            success: true,
            backupDir,
            autoBackupEnabled: global.lx.config['configBackup.enable'] !== false,
            retentionDays: global.lx.config['configBackup.retentionDays'] || 7,
            list,
          }))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: err.message }))
        }
        return
      }

      // [配置备份管理 API] 手动立即备份
      if (pathname === '/api/config/backup-now' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Unauthorized' }))
          return
        }

        try {
          if (typeof global.lx.backupConfigNow === 'function') {
            const result = global.lx.backupConfigNow()
            if (result.success) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true, filename: result.filename }))
            } else {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: result.error || 'Backup failed' }))
            }
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'backupConfigNow is not available' }))
          }
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: err.message }))
        }
        return
      }

      // [配置备份管理 API] 下载指定备份文件
      if (pathname === '/api/config/backups/download' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const fileName = urlObj.searchParams.get('file')
        if (!fileName || !/^config-.*\.js$/.test(fileName) || fileName.includes('/') || fileName.includes('\\')) {
          res.writeHead(400)
          res.end('Invalid file name')
          return
        }

        const backupDir = global.lx.getConfigBackupDir ? global.lx.getConfigBackupDir() : path.join(global.lx.dataPath, 'backups')
        const filePath = path.join(backupDir, fileName)

        if (!fs.existsSync(filePath)) {
          res.writeHead(404)
          res.end('File not found')
          return
        }

        try {
          const content = fs.readFileSync(filePath)
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Length': content.length,
          })
          res.end(content)
        } catch (err: any) {
          res.writeHead(500)
          res.end(err.message)
        }
        return
      }

      // [配置备份管理 API] 删除指定备份文件
      if (pathname.startsWith('/api/config/backups/') && req.method === 'DELETE') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Unauthorized' }))
          return
        }

        const fileName = decodeURIComponent(pathname.replace('/api/config/backups/', '')).trim()
        if (!fileName || !/^config-.*\.js$/.test(fileName) || fileName.includes('/') || fileName.includes('\\')) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Invalid file name' }))
          return
        }

        const backupDir = global.lx.getConfigBackupDir ? global.lx.getConfigBackupDir() : path.join(global.lx.dataPath, 'backups')
        const filePath = path.join(backupDir, fileName)

        if (!fs.existsSync(filePath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'File not found' }))
          return
        }

        try {
          fs.unlinkSync(filePath)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: err.message }))
        }
        return
      }

      // [配置备份管理 API] 从备份文件还原配置
      if (pathname === '/api/config/backups/restore' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Unauthorized' }))
          return
        }

        void readBody(req).then(async body => {
          try {
            const { fileName } = JSON.parse(body)
            if (!fileName || !/^config-.*\.js$/.test(fileName) || fileName.includes('/') || fileName.includes('\\')) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: 'Invalid file name' }))
              return
            }

            const backupDir = global.lx.getConfigBackupDir ? global.lx.getConfigBackupDir() : path.join(global.lx.dataPath, 'backups')
            const filePath = path.join(backupDir, fileName)

            if (!fs.existsSync(filePath)) {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: 'Backup file not found' }))
              return
            }

            // 先自动备份一份当前的 config.js 防止回滚失误
            if (typeof global.lx.backupConfigNow === 'function') {
              global.lx.backupConfigNow()
            }

            // 复制备份文件覆盖当前 config.js
            const activeConfigPath = global.lx.configPath || path.join(global.lx.dataPath, 'config.js')
            fs.copyFileSync(filePath, activeConfigPath)

            // 执行服务器热重载数据
            await reloadServerData()

            // 同步 snapshot 目录更新
            if (global.lx.config['snapshot.backupPath'] !== undefined) {
              updateAllUserSnapshotDirs(global.lx.config['snapshot.backupPath'])
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, message: `已成功从 ${fileName} 还原配置并热加载生效！` }))
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        })
        return
      }

      // Test Proxy API
      // ==================== 平台账号（用自己的会员账号听歌） ====================
      // 全部要求管理员身份：Cookie 是登录凭证，绝不能让普通用户读写。
      if (pathname === '/api/music/accounts' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          data: {
            enabled: musicAccount.isEnabled(),
            priority: musicAccount.isPriority(),
            timeoutMs: global.lx.config['musicAccount.timeoutMs'] ?? 15000,
            allowedUsers: getAllowedUsers(),
            accounts: musicAccount.getAccounts(),
            storePath: musicAccount.getStoreFilePath(),
          },
        }))
        return
      }

      // 设置（或清空）某平台 Cookie
      if (pathname === '/api/music/accounts' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(async body => {
          try {
            const { platform, cookie } = JSON.parse(body)
            // 记一条「请求到达」日志：用户反馈「同步了但后台没有」时，
            // 先看日志区分「插件根本没送到」和「送到了但平台/字段不对」
            console.log(`[平台账号] 收到保存请求：platform=${platform || '(空)'}，${String(cookie || '').length} 字符`)
            // 用户粘进来的可能是 Cookie 头 / cURL / Netscape 文件 / JSON，
            // 统一在保存时归一化，避免「填了却播不了」
            const result = musicAccount.saveAccount(String(platform || ''), String(cookie || ''))
            if (!result.success) {
              console.log(`[平台账号] 保存被拒：${result.error || '未知原因'}`)
            }
            res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (e: any) {
            console.log(`[平台账号] 保存异常：${e?.message || e}`)
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
          }
        })
        return
      }

      // 删除某平台账号
      if (pathname === '/api/music/accounts' && req.method === 'DELETE') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(async body => {
          try {
            const { platform } = JSON.parse(body || '{}')
            const result = musicAccount.removeAccount(String(platform || ''))
            res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
          }
        })
        return
      }

      // 验证某平台 Cookie（探测登录态与会员状态）
      if (pathname === '/api/music/accounts/verify' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(async body => {
          try {
            const { platform } = JSON.parse(body)
            const info = await musicAccount.verifyAccount(String(platform || ''))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: info }))
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
          }
        })
        return
      }

      // 抓取引导：把平台定义里的域名/步骤/收益下发给前端，前端不内置平台清单，避免两处维护
      if (pathname === '/api/music/accounts/guide' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        const plat = new URL(req.url || '', 'http://localhost').searchParams.get('platform') || ''
        const info = musicAccount.getPlatform(String(plat))
        if (!info) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: `不支持的平台：${plat}` }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          data: {
            ...info,
            // 支持扫码的平台，引导里先提一句「扫码更快」，避免用户上来就去 F12 抄 Cookie
            guide: info.qrLogins?.length
              ? [
                `这个平台支持扫码登录：直接点「${info.qrLogins.map(q => q.label).join(' / ')}」用手机扫一下就完成，不需要手工复制 Cookie。下面是手工填写的方式：`,
                ...info.guide,
              ]
              : info.guide,
          },
        }))
        return
      }

      // 浏览器扩展包：每次请求按 public/ext/cookie-sync 的当前内容现打 zip，
      // 源码改了立刻生效，不会出现「下载到的扩展和服务器版本不一致」
      if (pathname === '/api/music/accounts/extension.zip' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        try {
          const buf = musicAccount.buildExtensionZip()
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="lx-cookie-sync.zip"',
            'Content-Length': buf.length,
            'Cache-Control': 'no-store',
          })
          res.end(buf)
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
        }
        return
      }

      // 更新账号功能开关
      if (pathname === '/api/music/accounts/config' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(async body => {
          try {
            const patch = JSON.parse(body || '{}')
            if (typeof patch.enabled === 'boolean') global.lx.config['musicAccount.enabled'] = patch.enabled
            if (typeof patch.priority === 'boolean') global.lx.config['musicAccount.priority'] = patch.priority
            if (patch.allowedUsers !== undefined) {
              // 使用权限名单：只收字符串，修剪去重；空数组=恢复「所有人可用」
              if (!Array.isArray(patch.allowedUsers)) throw new Error('allowedUsers 必须是字符串数组')
              const allowedList: string[] = (patch.allowedUsers as unknown[])
                .filter((u): u is string => typeof u === 'string' && !!u.trim())
                .map((u) => u.trim())
              global.lx.config['musicAccount.allowedUsers'] = [...new Set(allowedList)]
            }
            if (typeof patch.timeoutMs === 'number' && patch.timeoutMs >= 3000) {
              global.lx.config['musicAccount.timeoutMs'] = patch.timeoutMs
            }
            if (typeof global.lx?.saveConfig === 'function') global.lx.saveConfig()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: {
              enabled: musicAccount.isEnabled(),
              priority: musicAccount.isPriority(),
              timeoutMs: global.lx.config['musicAccount.timeoutMs'],
              allowedUsers: getAllowedUsers(),
            } }))
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
          }
        })
        return
      }

      // 扫码登录：取二维码（每种扫码方式一个 session，状态只留在服务端内存）
      if (pathname === '/api/music/accounts/qr/start' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(async body => {
          try {
            const { platform, driver } = JSON.parse(body || '{}')
            const payload = await musicAccount.qrLoginStart(
              String(platform || ''),
              driver ? String(driver) : undefined,
            )
            res.writeHead(payload.ok ? 200 : 400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              success: payload.ok,
              data: payload,
              error: payload.ok ? undefined : payload.error,
            }))
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
          }
        })
        return
      }

      // 扫码登录：查询扫码结果（前端定时轮询，成功时后端已把 Cookie 保存好）
      if (pathname === '/api/music/accounts/qr/poll' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        const session = new URL(req.url || '', 'http://localhost').searchParams.get('session') || ''
        try {
          const payload = await musicAccount.qrLoginPoll(session)
          // 轮询一律 200：失败状态也要让前端读到 status 文案，而不是被当成网络错误
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: payload }))
        } catch (e: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: { ok: false, status: 'failed', message: e?.message || String(e) } }))
        }
        return
      }

      // 扫码登录：关闭弹窗时释放会话
      if (pathname === '/api/music/accounts/qr/close' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(async body => {
          try {
            const { session } = JSON.parse(body || '{}')
            musicAccount.qrLoginClose(String(session || ''))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
          }
        })
        return
      }

      // ===== 汽水签名器地址（傻瓜化：后台填一次即可，不用改环境变量） =====
      if (pathname === '/api/music/prefetch/signer' && (req.method === 'GET' || req.method === 'POST')) {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        const reply = async () => {
          const st = await extraSources.signer.status(true)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: true,
            data: {
              url: st.url,
              source: extraSources.signer.signerSource(),
              configured: st.configured,
              online: st.online,
              message: st.message,
            },
          }))
        }

        if (req.method === 'GET') { void reply(); return }

        void readBody(req).then(async body => {
          try {
            const patch = JSON.parse(body || '{}')
            const raw = String(patch.url || '').trim()
            if (raw && !/^https?:\/\//i.test(raw)) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: '地址必须以 http:// 或 https:// 开头' }))
              return
            }
            // Config 类型里没有这个键（它属于额外音源的可选项），用 any 断言写入即可
            ;(global.lx.config as any)['qishui.signerUrl'] = raw ? raw.replace(/\/+$/, '') : ''
            if (typeof global.lx?.saveConfig === 'function') global.lx.saveConfig()
            extraSources.signer.resetStatusCache()
            await reply()
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
          }
        })
        return
      }

      // ===== 额外音源取流诊断（排障用：整曲/试听、走了哪条通道、签名链路缺哪一环） =====
      if (pathname === '/api/music/extra/diagnose' && (req.method === 'GET' || req.method === 'POST')) {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }

        const run = async (raw: string) => {
          let payload: any = {}
          if (raw) {
            try {
              payload = JSON.parse(raw)
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: '请求体不是合法 JSON' }))
              return
            }
          }
          const source = String(payload.source || 'soda').trim()
          const trackId = String(payload.track_id || payload.id || '').trim()
          if (!trackId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: '缺少 track_id' }))
            return
          }
          try {
            const data = await extraSources.diagnoseStream(source, { id: trackId, songmid: trackId, source }, String(payload.quality || '320k'))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data }))
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
          }
        }

        if (req.method === 'GET') {
          // GET 走查询串：?track_id=xxx&quality=320k&source=soda
          const u = new URL(req.url || '/', 'http://localhost')
          void run(JSON.stringify({
            source: u.searchParams.get('source') || 'soda',
            track_id: u.searchParams.get('track_id') || u.searchParams.get('id') || '',
            quality: u.searchParams.get('quality') || '320k',
          }))
          return
        }

        void readBody(req).then(body => run(body || '{}')).catch((e: any) => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
        })
        return
      }

      // ===== 汽水待补清单 / 签名器（L2 骨架） =====
      if (pathname === '/api/music/prefetch/status' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        const force = urlObj.searchParams.get('force') === '1'
        void (async () => {
          try {
            const signerStatus = await extraSources.signer.status(force)
            const items = extraSources.pending.list()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              success: true,
              data: {
                signer: signerStatus,
                pending: {
                  count: items.length,
                  items: items.slice(0, 50).map(i => ({
                    key: i.key,
                    name: i.song.name,
                    singer: i.song.singer,
                    reason: i.reason,
                    tries: i.tries,
                    lastError: i.lastError,
                    at: i.at,
                    // 补传会落回这个用户的缓存目录；空 = 匿名 _open
                    username: i.username || '',
                  })),
                },
                running: extraSources.prefetch.isRunning(),
                lastRun: extraSources.prefetch.lastResult(),
                // 自动补传：签名器在线且有清单时，每几分钟自己补 3 首
                auto: extraSources.prefetch.autoStatus(),
              },
            }))
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
          }
        })()
        return
      }

      if (pathname === '/api/music/prefetch/flush' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        void readBody(req).then(async body => {
          try {
            const patch = JSON.parse(body || '{}')
            const result = await extraSources.prefetch.flush({
              username: String(patch.username || '_open'),
              quality: String(patch.quality || '320k'),
              limit: Number(patch.limit) || 10,
              force: patch.force === true,
            })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: result }))
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: e?.message || String(e) }))
          }
        })
        return
      }

      if (pathname === '/api/music/prefetch/clear' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        const removed = extraSources.pending.clear()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { removed } }))
        return
      }

      if (pathname === '/api/config/test-proxy' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        void readBody(req).then(async body => {
          try {
            const { address } = JSON.parse(body)
            if (!address) throw new Error('Missing address')

            const url = new URL(address)
            const options: any = {
              timeout: 10000,
              headers: {
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
              }
            }

            if (url.protocol === 'http:' || url.protocol === 'https:') {
              options.proxy = address
            } else if (url.protocol.startsWith('socks')) {
              const { SocksProxyAgent } = await import('socks-proxy-agent')
              options.agent = new SocksProxyAgent(address)
            } else {
              throw new Error('Unsupported protocol: ' + url.protocol)
            }

            console.log(`[代理测试] 正在通过代理 ${address} 测试连接 baidu.com...`)
            const startTime = Date.now()
            needle.get('https://www.baidu.com', options, (err: Error | null, resp: any) => {
              const duration = Date.now() - startTime
              if (err) {
                console.error('[代理测试] 连接失败:', err.message)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: err.message }))
              } else {
                console.log(`[代理测试] 测试成功: 状态码 ${resp.statusCode} (耗时 ${duration}ms)`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: true, message: `连接成功 (状态码: ${resp.statusCode}, 耗时: ${duration}ms)` }))
              }
            })
          } catch (err: any) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message }))
          }
        })
        return
      }

      // Logs API
      if (pathname === '/api/logs' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const logType = urlObj.searchParams.get('type') || 'app'
        const lines = parseInt(urlObj.searchParams.get('lines') || '100')
        const logFile = path.join(global.lx.logPath, `${logType}.log`)

        fs.readFile(logFile, 'utf-8', (err, content) => {
          if (err) {
            res.writeHead(404)
            res.end('Log file not found')
            return
          }
          const logLines = content.split('\n').slice(-lines)
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          })
          res.end(JSON.stringify({ logs: logLines }))
        })
        return
      }

      // Stats API
      if (pathname === '/api/stats' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const stats = {
          users: global.lx.config.users.length,
          connectedDevices: status.devices.length,
          serverStatus: status.status,
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        })
        res.end(JSON.stringify(stats))
        return
      }

      // WebDAV Test Connection API
      if (pathname === '/api/webdav/test' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const webdavSync = global.lx.webdavSync
        if (!webdavSync) {
          res.writeHead(500)
          res.end(JSON.stringify({ success: false, message: 'WebDAV not initialized' }))
          return
        }

        void webdavSync.testConnection().then((result: any) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        })
        return
      }

      // WebDAV Sync File API
      if (pathname === '/api/webdav/sync-file' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        void readBody(req).then(async body => {
          try {
            const { action, path: filePath } = JSON.parse(body)
            const webdavSync = global.lx.webdavSync

            if (!webdavSync) {
              res.writeHead(500)
              res.end(JSON.stringify({ success: false, message: 'WebDAV not initialized' }))
              return
            }

            let success = false
            if (action === 'upload') {
              success = await webdavSync.uploadFile(filePath)
            } else if (action === 'download') {
              success = await webdavSync.downloadFile(filePath)
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success }))
          } catch (err: any) {
            res.writeHead(500)
            res.end(JSON.stringify({ success: false, message: err.message }))
          }
        })
        return
      }

      // WebDAV Backup API
      if (pathname === '/api/webdav/backup' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const webdavSync = global.lx.webdavSync
        if (!webdavSync) {
          res.writeHead(500)
          res.end(JSON.stringify({ success: false, message: 'WebDAV not initialized' }))
          return
        }

        void readBody(req).then((body) => {
          const { force } = JSON.parse(body || '{}')
          void webdavSync.uploadBackup(force).then((success: boolean) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success }))
          })
        })
        return
      }
      // WebDAV Sync All Files API
      if (pathname === '/api/webdav/sync' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const webdavSync = global.lx.webdavSync
        if (!webdavSync) {
          res.writeHead(500)
          res.end(JSON.stringify({ success: false, message: 'WebDAV not initialized' }))
          return
        }

        void webdavSync.syncAllFiles().then((success: boolean) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success }))
        })
        return
      }

      // WebDAV Backups List API
      if (pathname === '/api/webdav/backups' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const webdavSync = global.lx.webdavSync
        if (!webdavSync) {
          res.writeHead(500)
          res.end(JSON.stringify({ success: false, message: 'WebDAV not initialized', backups: [] }))
          return
        }

        void webdavSync.getBackupList().then((backups: any[]) => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          })
          res.end(JSON.stringify({ success: true, backups }))
        }).catch((err: any) => {
          res.writeHead(500)
          res.end(JSON.stringify({ success: false, message: err.message, backups: [] }))
        })
        return
      }

      // WebDAV Delete Backup API
      if (pathname === '/api/webdav/backup' && req.method === 'DELETE') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const webdavSync = global.lx.webdavSync
        if (!webdavSync) {
          res.writeHead(500)
          res.end(JSON.stringify({ success: false, message: 'WebDAV not initialized' }))
          return
        }

        let body = ''
        req.on('data', chunk => {
          body += chunk.toString()
        })
        req.on('end', () => {
          try {
            const data = body ? JSON.parse(body) : {}
            const filename = data.filename
            if (!filename) {
              res.writeHead(400)
              res.end(JSON.stringify({ success: false, message: 'Filename is required' }))
              return
            }

            void webdavSync.deleteBackupFile(filename).then((success: boolean) => {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success }))
            }).catch((err: any) => {
              res.writeHead(500)
              res.end(JSON.stringify({ success: false, message: err.message }))
            })
          } catch (err: any) {
            res.writeHead(400)
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }))
          }
        })
        return
      }

      // WebDAV Restore API
      if (pathname === '/api/webdav/restore' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const webdavSync = global.lx.webdavSync
        if (!webdavSync) {
          res.writeHead(500)
          res.end(JSON.stringify({ success: false, message: 'WebDAV not initialized' }))
          return
        }

        void readBody(req).then((body) => {
          let payload: any = {}
          try {
            payload = JSON.parse(body || '{}')
          } catch (e) { }

          const mode = payload.mode || 'auto'
          const targetFilename = payload.targetFilename

          void webdavSync.restoreFromRemote({ mode, targetFilename }).then(async (success: boolean) => {
            if (success) {
              await reloadServerData()
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success }))
          }).catch((err: any) => {
            res.writeHead(500)
            res.end(JSON.stringify({ success: false, message: err.message }))
          })
        })
        return
      }

      // WebDAV Logs API
      if (pathname === '/api/webdav/logs' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const webdavSync = global.lx.webdavSync
        if (!webdavSync) {
          res.writeHead(404)
          res.end(JSON.stringify({ logs: [] }))
          return
        }

        const logs = webdavSync.getSyncLogs()
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        })
        res.end(JSON.stringify({ logs }))
        return
      }
      // WebDAV Progress SSE API
      if (pathname === '/api/webdav/progress' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth'] || urlObj.searchParams.get('auth')
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        })
        res.write('retry: 5000\n\n')

        const client = res
        sseClients.add(client)

        // 定时发送 SSE 心跳保活
        const heartbeatTimer = setInterval(() => {
          try {
            client.write(': heartbeat\n\n')
          } catch {
            clearInterval(heartbeatTimer)
          }
        }, 15000)

        req.on('close', () => {
          clearInterval(heartbeatTimer)
          sseClients.delete(client)
        })
        return
      }
      // [新增] 本地备份下载 API
      if (pathname === '/api/backup/download' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth'] || urlObj.searchParams.get('auth')
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401); res.end('Unauthorized'); return
        }

        try {
          const webdavSync = global.lx.webdavSync
          if (!webdavSync) throw new Error('Backup system not initialized')

          const zipName = await webdavSync.createBackup()
          if (!zipName) throw new Error('Backup creation failed')

          const zipPath = path.join(global.lx.dataPath, zipName)
          if (!fs.existsSync(zipPath)) throw new Error('ZIP file not found')

          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${zipName}"`,
          })
          const readStream = fs.createReadStream(zipPath)
          readStream.pipe(res)
          readStream.on('finish', () => {
            // 延时删除本地临时ZIP文件
            setTimeout(() => {
              if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)
            }, 5000)
          })
        } catch (err: any) {
          res.writeHead(500); res.end(err.message)
        }
        return
      }

      // [新增] 本地备份还原 API
      if (pathname === '/api/backup/upload' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401); res.end('Unauthorized'); return
        }

        const form = formidable({ multiples: false, uploadDir: os.tmpdir() })
        form.parse(req, async (err: any, fields: any, files: any) => {
          if (err) {
            res.writeHead(500); res.end('Upload failed: ' + err.message); return
          }
          // formidable v3 字段返回可能是数组
          let file = files.backup || files.file || Object.values(files)[0]
          if (Array.isArray(file)) file = file[0]

          if (!file || !file.filepath) {
            res.writeHead(400); res.end('No ZIP file uploaded'); return
          }

          try {
            const webdavSync = global.lx.webdavSync
            if (!webdavSync) throw new Error('Restore system not initialized')

            await webdavSync.extractZip(file.filepath, global.lx.dataPath)

            // 删除临时上传的文件
            if (fs.existsSync(file.filepath)) fs.unlinkSync(file.filepath)

            // [新增] 还原后自动触发重载
            await reloadServerData()

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, message: 'Restore from local ZIP success and reloaded' }))
          } catch (restoreErr: any) {
            console.error('[数据备份] 本地还原异常:', restoreErr)
            res.writeHead(500); res.end('Restore failed: ' + restoreErr.message)
          }
        })
        return
      }

      // [新增] 管理重载 API
      if (pathname === '/api/admin/reload' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401); res.end('Unauthorized'); return
        }

        try {
          await reloadServerData()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, message: 'Server data reloaded from disk' }))
        } catch (err: any) {
          res.writeHead(500); res.end(err.message)
        }
        return
      }

      // Restart Server API
      if (pathname === '/api/restart' && req.method === 'POST') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, message: 'Server restarting...' }))

        // 延迟1秒后重启
        setTimeout(() => {
          console.log('[系统管理] 收到管理员指令，服务正在重启...')
          // 尝试通过更新文件时间戳触发 nodemon 重启
          const entryFile = path.join(process.cwd(), 'src', 'index.ts')
          try {
            if (fs.existsSync(entryFile)) {
              const time = new Date()
              fs.utimesSync(entryFile, time, time)
            } else {
              process.exit(0)
            }
          } catch (err) {
            console.error('[系统管理] 触发热重启失败，正在强制退出进程:', err)
            process.exit(0)
          }
        }, 1000)

        return
      }
      // File Management - List Files
      if (pathname === '/api/files' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const dirPath = urlObj.searchParams.get('path') || ''
        const fullPath = path.join(global.lx.dataPath, dirPath)

        // 安全检查：确保路径在 dataPath 内
        if (!fullPath.startsWith(global.lx.dataPath)) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }

        try {
          const items = fs.readdirSync(fullPath).map(name => {
            const itemPath = path.join(fullPath, name)
            const stat = fs.statSync(itemPath)
            return {
              name,
              path: path.relative(global.lx.dataPath, itemPath),
              isDirectory: stat.isDirectory(),
              size: stat.size,
              mtime: stat.mtime.getTime(),
            }
          })
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          })
          res.end(JSON.stringify({ items }))
        } catch (err: any) {
          res.writeHead(500)
          res.end(JSON.stringify({ error: err.message }))
        }
        return
      }

      // File Management - Download File
      if (pathname === '/api/files/download' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const filePath = urlObj.searchParams.get('path') || ''
        const fullPath = path.join(global.lx.dataPath, filePath)

        if (!fullPath.startsWith(global.lx.dataPath)) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }

        try {
          const content = fs.readFileSync(fullPath)
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${path.basename(fullPath)}"`,
          })
          res.end(content)
        } catch (err) {
          res.writeHead(404)
          res.end('File not found')
        }
        return
      }

      // File Management - Create/Update File
      if (pathname === '/api/files' && (req.method === 'POST' || req.method === 'PUT')) {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        void readBody(req).then(body => {
          try {
            const { path: filePath, content, isDirectory } = JSON.parse(body)
            const fullPath = path.join(global.lx.dataPath, filePath)

            if (!fullPath.startsWith(global.lx.dataPath)) {
              res.writeHead(403)
              res.end('Forbidden')
              return
            }

            if (isDirectory) {
              fs.mkdirSync(fullPath, { recursive: true })
            } else {
              const dir = path.dirname(fullPath)
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
              }
              fs.writeFileSync(fullPath, content || '')
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(500)
            res.end(JSON.stringify({ success: false, message: err.message }))
          }
        })
        return
      }

      // File Management - Delete File
      if (pathname === '/api/files' && req.method === 'DELETE') {
        const auth = req.headers['x-frontend-auth']
        if (auth !== global.lx.config['admin.password']) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        void readBody(req).then(body => {
          try {
            const { path: filePath } = JSON.parse(body)
            const fullPath = path.join(global.lx.dataPath, filePath)

            if (!fullPath.startsWith(global.lx.dataPath)) {
              res.writeHead(403)
              res.end('Forbidden')
              return
            }

            const stat = fs.statSync(fullPath)
            if (stat.isDirectory()) {
              fs.rmSync(fullPath, { recursive: true })
            } else {
              fs.unlinkSync(fullPath)
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(500)
            res.end(JSON.stringify({ success: false, message: err.message }))
          }
        })
        return
      }

    }

    const endUrl = `/${req.url?.split('/').at(-1) ?? ''}`
    let code
    let msg
    switch (endUrl) {
      case '/hello':
        // 新增：如果禁用了根路径，且当前访问的是根路径 (例如 /hello 而不是 /user/hello)，则拒绝
        if (!global.lx.config['user.enableRoot']) {
          const parts = pathname.split('/').filter(p => p)
          // parts.length <= 1 说明没有用户名部分，只有 'hello'
          if (parts.length <= 1) {
            code = 403
            msg = 'Root access disabled'
            break
          }
        }
        code = 200
        msg = SYNC_CODE.helloMsg
        break
      case '/id':
        // 新增：同上，对 /id 接口也进行同样的检查
        if (!global.lx.config['user.enableRoot']) {
          const parts = pathname.split('/').filter(p => p)
          if (parts.length <= 1) {
            code = 403
            msg = 'Root access disabled'
            break
          }
        }

        code = 200
        msg = SYNC_CODE.idPrefix + getServerId()
        break
      case '/ah':
        let targetUserName

        // 1. 尝试匹配用户路径 /<userName>/ah
        if (global.lx.config['user.enablePath']) {
          const parts = pathname.split('/').filter(p => p)
          // parts 应该是 ['username', 'ah']
          if (parts.length > 1 && parts[parts.length - 1] === 'ah') {
            targetUserName = decodeURIComponent(parts[parts.length - 2])
          }
        }

        // 2. 如果没有匹配到用户名（说明是访问的根路径 /ah，或者 URL 格式不对）
        if (!targetUserName) {
          // 如果未开启根路径模式，则拒绝访问
          if (!global.lx.config['user.enableRoot']) {
            res.writeHead(403)
            res.end('Access denied: Root path access is disabled. Please use /<username>/ah')
            return
          }
          // 如果开启了根路径，targetUserName 保持 undefined，authCode 会遍历尝试所有用户
        }

        // 将 targetUserName 传递给 authCode
        void authCode(req, res, global.lx.config.users, targetUserName)
        break
      default:
        // 如果设置了独立后台路径，兜底拦截根目录访问请求
        if (global.lx.config['admin.path'] && (pathname === '/' || pathname === '/index.html')) {
          code = 404
          msg = 'Not Found'
          break
        }

        // Serve static files
        // If root, serve index.html
        let filePath = path.join(process.cwd(), 'public', pathname === '/' ? 'index.html' : pathname)
        // Prevent directory traversal
        if (!filePath.startsWith(path.join(process.cwd(), 'public'))) {
          code = 403
          msg = 'Forbidden'
          break
        }

        // Check if file exists, if not fall back to 404 handled by serveStatic or check original logic
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          serveStatic(req, res, filePath)
          return
        }

        code = 404
        msg = 'Not Found'
        break
    }
    if (!code) return
    res.writeHead(code)
    res.end(msg)
  })

  wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  }) as unknown as LX.SocketServer

  // WebDAV Sync Progress & Log Broadcast
  if (global.lx.webdavSync) {
    // 移除旧的监听器以防重复添加
    global.lx.webdavSync.removeAllListeners('progress')
    global.lx.webdavSync.removeAllListeners('log')

    global.lx.webdavSync.on('progress', (data: any) => {
      // Broadcast to WebSocket clients
      if (wss) {
        const msg = JSON.stringify({ type: 'webdav_progress', data })
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg)
          }
        }
      }
      // Broadcast to SSE clients
      const sseMsg = `data: ${JSON.stringify(data)}\n\n`
      for (const client of sseClients) {
        client.write(sseMsg)
      }
    })

    global.lx.webdavSync.on('log', (log: any) => {
      const data = { type: 'sync_log', log }
      if (wss) {
        const msg = JSON.stringify({ type: 'webdav_log', data })
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg)
          }
        }
      }
      const sseMsg = `data: ${JSON.stringify(data)}\n\n`
      for (const client of sseClients) {
        client.write(sseMsg)
      }
    })
  }

  wss.on('connection', function (socket: any, request) {
    socket.isReady = false
    socket.moduleReadys = {
      list: false,
      dislike: false,
    }
    socket.feature = {
      list: false,
      dislike: false,
    }
    socket.on('pong', () => {
      socket.isAlive = true
    })

    // const events = new Map<keyof ActionsType, Array<(err: Error | null, data: LX.Sync.ActionSyncType[keyof LX.Sync.ActionSyncType]) => void>>()
    // const events = new Map<keyof LX.Sync.ActionSyncType, Array<(err: Error | null, data: LX.Sync.ActionSyncType[keyof LX.Sync.ActionSyncType]) => void>>()
    // let events: Partial<{ [K in keyof LX.Sync.ActionSyncType]: Array<(data: LX.Sync.ActionSyncType[K]) => void> }> = {}
    let closeEvents: Array<(err: Error) => (void | Promise<void>)> = []
    let disconnected = false
    const msg2call = createMsg2call<LX.Sync.ClientSyncActions>({
      funcsObj: callObj,
      timeout: 120 * 1000,
      sendMessage(data: any) {
        if (disconnected) throw new Error('disconnected')
        void encryptMsg(socket.keyInfo, JSON.stringify(data)).then((data: string) => {
          // console.log('sendData', eventName)
          socket.send(data)
        }).catch(err => {
          syncLog.error('encrypt message error:', err)
          syncLog.error(err.message)
          socket.close(SYNC_CLOSE_CODE.failed)
        })
      },
      onCallBeforeParams(rawArgs: any[]) {
        return [socket, ...rawArgs]
      },
      onError(error: Error, path: string[], groupName: string | null) {
        const name = groupName ?? ''
        const userName = socket.userInfo?.name ?? ''
        const deviceName = socket.keyInfo?.deviceName ?? ''
        syncLog.error(`sync call ${userName} ${deviceName} ${name} ${path.join('.')} error:`, error)
        // if (groupName == null) return
        // // TODO
        // socket.close(SYNC_CLOSE_CODE.failed)
      },
    })
    socket.remote = msg2call.remote
    socket.remoteQueueList = msg2call.createQueueRemote('list')
    socket.remoteQueueDislike = msg2call.createQueueRemote('dislike')
    socket.addEventListener('message', ({ data }: any) => {
      if (typeof data != 'string') return
      void decryptMsg(socket.keyInfo, data).then((data) => {
        let syncData: any
        try {
          syncData = JSON.parse(data)
        } catch (err) {
          syncLog.error('parse message error:', err)
          socket.close(SYNC_CLOSE_CODE.failed)
          return
        }
        msg2call.message(syncData)
      }).catch(err => {
        syncLog.error('decrypt message error:', err)
        syncLog.error(err.message)
        socket.close(SYNC_CLOSE_CODE.failed)
      })
    })
    socket.addEventListener('close', () => {
      const err = new Error('closed')
      try {
        for (const handler of closeEvents) void handler(err)
      } catch (err: any) {
        syncLog.error(err?.message)
      }
      closeEvents = []
      disconnected = true
      msg2call.destroy()
      if (socket.isReady) {
        accessLog.info('deconnection', socket.userInfo.name, socket.keyInfo.deviceName)
        // events = {}
        if (!status.devices.map(d => getUserName(d.clientId)).filter(n => n == socket.userInfo.name).length) handleUnconnection(socket.userInfo.name)
      } else {
        const queryData = new URL(request.url as string, host).searchParams
        accessLog.info('deconnection', queryData.get('i'))
      }
    })
    socket.onClose = function (handler: typeof closeEvents[number]) {
      closeEvents.push(handler)
      return () => {
        closeEvents.splice(closeEvents.indexOf(handler), 1)
      }
    }
    socket.broadcast = function (handler: any) {
      if (!wss) return
      for (const client of wss.clients) handler(client)
    }

    void handleConnection(socket, request)
  })

  httpServer.on('upgrade', function upgrade(request, socket, head) {
    socket.addListener('error', onSocketError)

    // 调用全局定义的 authConnection (在文件顶部约113行已经定义过)
    authConnection(request, (err, success) => {
      // 如果报错或者 success 为 false，则拒绝连接
      if (err || !success) {
        // console.log('Auth failed', err)
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      socket.removeListener('error', onSocketError)

      // 鉴权通过，升级协议
      // 强制删除压缩扩展头，防止 permessage-deflate 协商导致 "RSV1 must be clear" 错误
      delete request.headers['sec-websocket-extensions']
      wss?.handleUpgrade(request, socket, head, function done(ws) {
        wss?.emit('connection', ws, request)
      })
    })
  })

  const interval = setInterval(() => {
    wss?.clients.forEach(socket => {
      if (socket.isAlive == false) {
        syncLog.info('alive check false:', socket.userInfo.name, socket.keyInfo.deviceName)
        socket.terminate()
        return
      }

      socket.isAlive = false
      socket.ping(noop)
      if (socket.keyInfo.isMobile) socket.send('ping', noop)
    })
  }, 30000)

  wss?.on('close', function close() {
    clearInterval(interval)
  })

  httpServer.on('error', error => {
    console.log(error)
    reject(error)
  })

  httpServer.on('listening', () => {
    const addr = httpServer.address()
    // console.log(addr)
    if (!addr) {
      reject(new Error('address is null'))
      return
    }
    const bind = typeof addr == 'string' ? `pipe ${addr}` : `port ${addr.port}`
    startupLog.info(`Listening on ${ip} ${bind}`)
    // 启动自检：缓存/下载目录若未挂载到独立卷，会写进容器可写层（宿主看不到、重建即丢）
    try {
      checkPersistentVolumes()
    } catch (e: any) {
      console.warn('[挂载自检] 检查失败（不影响服务运行）:', e?.message || e)
    }
    resolve(null)
    void registerLocalSyncEvent(wss as LX.SocketServer)
    // 启动 2 分钟后跑一次缓存来源体检（dry-run）：老缓存可能混着音源兜底返回的别曲
    scheduleCacheAuditOnStartup()
    // 汽水待补：签名器在线且有清单时自己补，不用去后台点「补传」
    try {
      extraSources.prefetch.startAuto()
    } catch (e: any) {
      console.warn('[汽水待补] 自动补传启动失败（不影响服务运行）:', e?.message || e)
    }
  })

  host = `http://${ip.includes(':') ? `[${ip}]` : ip}:${port}`
  httpServer.listen(port, ip)
})

// [Subsonic 独立端口] 在独立监听端口上只暴露 Subsonic API。
// 鉴权复用 subsonic 自身 verifyAuth（subsonic.ts 内部实现）——只有携带合法 Subsonic 凭据(用户/密码/token)的请求才会被处理，
// 未通过鉴权的请求一律返回错误，从而实现「只允许 Subsonic 用户通过」。
const startSubsonicStandaloneServer = () => {
  const subEnabled = global.lx.config['subsonic.enable'] !== false
  const subPort = global.lx.config['subsonic.port']
  if (!subEnabled || !(typeof subPort === 'number' && subPort > 0)) return

  // 不绑定特定 IP：监听所有网卡，访问控制交由防火墙处理
  const subBindIP = '0.0.0.0'
  const subServer = http.createServer(async (req, res) => {
    // 与主端口一致的 CORS 头，兼容跨域 Subsonic 客户端
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      const { subsonicHandler } = require('./subsonic')
      const urlObj = new URL(req.url ?? '', `http://${req.headers.host}`)

      // [路由守卫] 仅允许 /rest/{method} 形式的 Subsonic API 调用，其余路径一律 404。
      // 真正的 Subsonic 客户端请求形如 /rest/ping.view，会正常进入处理方法；
      // 浏览器裸访问（/、/rest、/rest/ 等）及爬虫请求返回「像资源不存在」的 404：
      // 只给状态码、不附带任何服务器说明文案，避免暴露「这是一个服务器 / 服务在响应」的特征。
      if (!/^\/rest\/.+/.test(urlObj.pathname)) {
        res.writeHead(404)
        res.end()
        return
      }

      // 直接交给 subsonic 处理；handleRequest 内部 verifyAuth 只会放行通过 Subsonic 鉴权的用户
      await subsonicHandler.handleRequest(req, res, urlObj)
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Internal Server Error')
      }
    }
  })

  subServer.on('error', (err: any) => {
    global.lx.subsonicPortConflict = {
      port: subPort,
      error: err.code === 'EADDRINUSE' ? `端口 ${subPort} 已被占用` : (err.message || '端口绑定失败'),
      time: Date.now(),
    }
    startupLog.error(`Subsonic standalone server failed on ${subBindIP}:${subPort}: ${err.message}`)
    console.error('[Subsonic] 独立服务发生异常:', err)
  })

  subServer.listen(subPort, subBindIP, () => {
    global.lx.subsonicPortConflict = undefined
    startupLog.info(`Subsonic standalone server listening on ${subBindIP}:${subPort}`)
    console.log(`[Subsonic] 独立服务已监听: http://${subBindIP}:${subPort}`)
  })
}

// const handleStopServer = async() => new Promise<void>((resolve, reject) => {
//   if (!wss) return
//   for (const client of wss.clients) client.close(SYNC_CLOSE_CODE.normal)
//   unregisterLocalSyncEvent()
//   wss.close()
//   wss = null
//   httpServer.close((err) => {
//     if (err) {
//       reject(err)
//       return
//     }
//     resolve()
//   })
// })

// export const stopServer = async() => {
//   codeTools.stop()
//   if (!status.status) {
//     status.status = false
//     status.message = ''
//     status.address = []
//     status.code = ''
//     sendStatus(status)
//     return
//   }
//   console.log('stoping sync server...')
//   await handleStopServer().then(() => {
//     console.log('sync server stoped')
//     status.status = false
//     status.message = ''
//     status.address = []
//     status.code = ''
//   }).catch(err => {
//     console.log(err)
//     status.message = err.message
//   }).finally(() => {
//     sendStatus(status)
//   })
// }

export const startServer = async (port: number, ip: string) => {
  // Initialize file cache settings from global config
  if (global.lx.config) {
    if (global.lx.config.serverCacheLocation) fileCache.setCacheLocation(global.lx.config.serverCacheLocation)
    global.lx.config['cache.namingPattern'] = fileCache.setNamingPattern(global.lx.config['cache.namingPattern'])

    // Background sync cache index for active users
    if (global.lx.config.users) {
      for (const user of global.lx.config.users) {
        void fileCache.syncCacheIndex(user.name)
      }
    }
  }

  // [新增] 注入歌词获取钩子：用于服务器缓存时自动嵌入 USLT 标签
  // SDK 的 getLyric() 返回 { promise, cancel }，必须 await .promise
  fileCache.setLyricFetcher(async (songInfo: any) => {
    try {
      const source = songInfo.source
      if (!source || !musicSdk[source] || !musicSdk[source].getLyric) {
        console.log(`[歌词抓取] 跳过: 不支持的音源 "${source}"`)
        return null
      }
      // [Fix] Strip source prefix from songmid (e.g. "tx_004bd0..." -> "004bd0...")
      // 归一化为字符串：网易云等平台的 songmid 是纯数字（如 1903149553），
      // 直接调用 .startsWith 会抛 "songmid.startsWith is not a function"，导致歌词抓取整体失败。
      // 少数平台把 id 包在对象里（{ songmid }），这里一并展平。
      let rawId: any = songInfo.songmid ?? songInfo.id ?? ''
      if (rawId && typeof rawId === 'object') rawId = rawId.songmid ?? rawId.id ?? ''
      let songmid: string = String(rawId)
      const sourcePrefix = `${source}_`
      if (songmid.startsWith(sourcePrefix)) songmid = songmid.slice(sourcePrefix.length)
      if (!songmid) {
        console.log(`[歌词抓取] 跳过: 歌曲 songmid 为空`)
        return null
      }
      console.log(`[歌词抓取] 正在获取歌词: ${source}_${songmid} (${songInfo.name})`)
      const requestObj = musicSdk[source].getLyric({
        songmid,
        name: songInfo.name || '',
        singer: songInfo.singer || '',
        hash: songInfo.hash || '',
        interval: songInfo.interval || '',
      })
      const result = await requestObj.promise
      const lyricText = result?.lyric || result?.lrc || null
      console.log(`[歌词抓取] 获取结果: ${lyricText ? lyricText.length + ' 字符' : '无歌词'}`)
      return lyricText
    } catch (e: any) {
      console.warn(`[歌词抓取] 抓取失败 (${songInfo.name}):`, e.message || e)
      return null
    }
  })

  // if (status.status) await handleStopServer()

  startupLog.info(`starting sync server in ${process.env.NODE_ENV == 'production' ? 'production' : 'development'}`)
  const proxyEnabled = global.lx.config['proxy.all.enabled']
  const proxyAddress = global.lx.config['proxy.all.address']
  console.log(`[网络代理] 音乐 SDK 代理状态: ${proxyEnabled ? `已启用 (${proxyAddress})` : '未启用'}`)
  startupLog.info(`Music SDK Proxy: ${proxyEnabled ? `Enabled (${proxyAddress})` : 'Disabled'}`)
  try {
    await musicSdk.init()
    startupLog.info('musicSdk initialized')
  } catch (err) {
    startupLog.error('musicSdk init failed:', err)
  }

  // 初始化自定义源
  try {
    console.log('[服务] 正在初始化自定义源...')
    // 修改：不传参数，默认加载 open + 所有用户源
    await initUserApis()
    console.log('[服务] 自定义源初始化完成')
  } catch (err: any) {
    console.error('[服务] 初始化自定义源失败:', err.message)
  }

  // [Fix] 服务启动时从 _open 用户 settings.json 读取 serverCacheLocation 并预初始化 fileCache，
  // 避免前端初始化同步时因服务端内存状态（默认 'root'）与持久化设置不一致而触发权限检查返回 403
  try {
    const openUserSpace = getUserSpace('_open')
    const settingsPath = path.join(openUserSpace.dataManage.userDir, File.userSettingsJSON)
    if (fs.existsSync(settingsPath)) {
      const savedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      if (savedSettings.serverCacheLocation) {
        fileCache.setUserCacheLocation('_open', savedSettings.serverCacheLocation)
        console.log(`[缓存] 从配置恢复服务器缓存路径: ${savedSettings.serverCacheLocation}`)
      }
      if (savedSettings.serverCacheNamingPattern) {
        const normalizedNamingPattern = fileCache.setUserNamingPattern('_open', savedSettings.serverCacheNamingPattern)
        console.log(`[缓存] 从配置恢复缓存文件命名模式: ${normalizedNamingPattern}`)
      }
    }
  } catch (err: any) {
    console.warn('[缓存] 恢复缓存设置失败:', err.message)
  }

  // 恢复登录会话：容器重启后用户不必重新登录（否则前端会拿着失效 token 一路 401，
  // 表现为「已缓存的歌也播不了 + 一直在智能换源 + 菜单点不动」）
  try {
    const restored = loadPersistedSessions(USER_SESSION_TTL)
    let count = 0
    for (const [token, session] of restored) {
      userSessions.set(token, session)
      count++
    }
    if (count > 0) {
      console.log(`[会话] 已恢复 ${count} 个登录会话（重启不再踢人下线）`)
      startupLog.info(`Restored ${count} user session(s) from disk`)
    }
  } catch (err: any) {
    console.warn('[会话] 恢复登录会话失败:', err?.message || err)
  }

  serverDownloadQueue.initialize(async task => {
    const songInfo = normalizeSongInfo(task.songInfo)
    const apiUsername = task.username === '_open' ? 'open' : task.username
    const resolved = await resolveServerSong(songInfo, task.requestedQuality, apiUsername, true)
    return {
      url: resolved.url,
      quality: resolved.quality,
      songInfo: resolved.songInfo,
      requestedSource: resolved.requestedSource,
      downloadSource: resolved.downloadSource,
      sourceName: resolved.sourceName,
    }
  })

  // 注入同步下载引擎的 resolver（低耦合：由此处唯一注入）
  setSongResolver(async (songInfo, quality, username) => {
    const apiUsername = username === '_open' ? 'open' : username
    const resolved = await resolveServerSong(normalizeSongInfo(songInfo), quality, apiUsername, true)
    return {
      url: resolved.url,
      quality: resolved.quality,
      songInfo: resolved.songInfo,
    }
  })

  remasterQueue.initialize(async (songInfo, requestedQuality, username) => {
    const apiUsername = username === '_open' ? 'open' : username
    const resolved = await resolveServerSong(songInfo, requestedQuality, apiUsername, true)
    return {
      url: resolved.url,
      quality: resolved.quality,
    }
  })

  await handleStartServer(port, ip).then(async () => {
    // console.log('sync server started')
    status.status = true
    status.message = ''
    scheduler.startScheduler()
    status.address = ip == '0.0.0.0' ? getAddress() : [ip]

    // [Subsonic 独立端口] 主端口就绪后启动（独立端口失败不影响主服务）
    startSubsonicStandaloneServer()



    // void generateCode()
    // codeTools.start()
  }).catch(err => {
    console.error('[服务] 启动同步服务异常:', err)
    status.status = false
    status.message = err.message
    status.address = []
    // status.code = ''
  })
  // .finally(() => {
  //   sendStatus(status)
  // })
}

export const getStatus = (): LX.Sync.Status => status

// export const generateCode = async() => {
//   status.code = handleGenerateCode()
//   sendStatus(status)
//   return status.code
// }

export const getDevices = async (userName: string) => {
  const userSpace = getUserSpace(userName)
  return userSpace.getDecices()
}

export const removeDevice = async (userName: string, clientId: string) => {
  if (wss) {
    for (const client of wss.clients) {
      if (client.userInfo?.name == userName && client.keyInfo?.clientId == clientId) client.close(SYNC_CLOSE_CODE.normal)
    }
  }
  const userSpace = getUserSpace(userName)
  await userSpace.removeDevice(clientId)
}

// ===== 缓存生命周期自动过期清理任务 (支持 0 永久保留) =====
const getCacheRetentionMs = () => {
  const daysConfig = global.lx.config && typeof global.lx.config['cache.maxAgeDays'] !== 'undefined'
    ? Number(global.lx.config['cache.maxAgeDays'])
    : 14
  if (isNaN(daysConfig) || daysConfig <= 0) return 0 // 0 表示永久保留，不清理
  return daysConfig * 24 * 60 * 60 * 1000
}

const cleanExpiredCacheFiles = async () => {
  try {
    const retentionMs = getCacheRetentionMs()
    if (retentionMs === 0) {
      // 设置为 0，永久保留缓存
      return
    }

    const cacheDirs = [
      path.join(process.cwd(), 'cache'),
      path.join(global.lx.dataPath, 'cache'),
    ]
    const now = Date.now()
    let totalCleaned = 0
    let totalBytesFreed = 0

    const scanAndCleanAsync = async (dir: string) => {
      try {
        const exists = await fs.promises.access(dir).then(() => true).catch(() => false)
        if (!exists) return
        const entries = await fs.promises.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            await scanAndCleanAsync(fullPath)
            await new Promise(resolve => setImmediate(resolve))
          } else if (entry.isFile()) {
            if (entry.name === 'cache_index.json' || entry.name.endsWith('.json')) continue
            try {
              const stats = await fs.promises.stat(fullPath)
              const fileTime = Math.max(stats.atimeMs || 0, stats.mtimeMs || 0)
              if (now - fileTime > retentionMs) {
                await fs.promises.unlink(fullPath)
                totalCleaned++
                totalBytesFreed += stats.size
              }
            } catch (e) { }
          }
        }
      } catch (e) { }
    }

    const uniqueDirs = Array.from(new Set(cacheDirs))
    for (const d of uniqueDirs) {
      await scanAndCleanAsync(d)
    }
    if (totalCleaned > 0) {
      const retentionDays = Math.round(retentionMs / (24 * 60 * 60 * 1000))
      console.log(`[文件缓存] [${retentionDays}天过期清理] 成功清理 ${totalCleaned} 个过期缓存音频/歌词文件 (释放 ${(totalBytesFreed / 1024 / 1024).toFixed(2)} MB)`)
    }
  } catch (err) {
    console.error('[文件缓存] 自动清理异常:', err)
  }
}

setTimeout(() => void cleanExpiredCacheFiles(), 10000)
setInterval(() => void cleanExpiredCacheFiles(), 12 * 60 * 60 * 1000)
