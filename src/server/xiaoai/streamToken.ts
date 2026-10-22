import { loadSecret } from './config'
import { hmacSha256Hex } from './crypto'

/**
 * 播放直链签名。
 *
 * 音箱只会照着 URL 去拉流，没法带我们的登录态，所以「谁能访问这个流」只能靠
 * URL 自带的签名来判定：payload 用 base64url 编码，附上 HMAC-SHA256 签名，
 * 并带过期时间。密钥持久化在 data 目录，重启后仍有效。
 */

export interface StreamTokenPayload {
  /** 本地文件绝对路径 */
  path?: string
  /** 远端音频地址（中转代理） */
  url?: string
  /** 下载文件名 */
  filename?: string
  /** 投送前探测到的真实 Content-Type（上游给 octet-stream 时用它纠正） */
  contentType?: string
  /** 本次投送的流标识：服务端据此统计「音箱把这一路流拉了几遍」 */
  sid?: string
  /** 本首真实时长（毫秒）：中转按它算码率，把数据平滑地喂给音箱而不是一阵一阵地灌 */
  durationMs?: number
  /** 要求中转统一转成 mp3（直投远端源时用；源已是 mp3 则不重复转码） */
  format?: 'mp3'
  /** 转 mp3 时的尾部淡出秒数（0/缺省 = 不淡出） */
  fadeOutSec?: number
  /**
   * 转码产物的落盘路径。
   * 音箱播完一首常会拿同一个 URL 重新拉流：第一次边转边发并落盘，
   * 第二次直接命中本地文件（支持 Range），既快又稳。
   */
  mp3Path?: string
  /** 过期时间戳（毫秒） */
  exp: number
}

const DEFAULT_TTL_MS = 30 * 60 * 1000
const MIN_TTL_MS = 60 * 1000

const sign = (payload: string) => hmacSha256Hex(loadSecret(), payload)

export const createStreamToken = (target: {
  path?: string
  url?: string
  filename?: string
  contentType?: string
  durationMs?: number
  format?: 'mp3'
  fadeOutSec?: number
  mp3Path?: string
  ttlMs?: number
}): string => {
  const ttl = Math.max(MIN_TTL_MS, Number(target.ttlMs) || DEFAULT_TTL_MS)
  const payload: StreamTokenPayload = {
    exp: Date.now() + ttl,
    // 每路流一个短标识：音箱播完会重拉同一个 URL，服务端靠它统计「拉了几遍」，
    // 比猜歌曲时长可靠得多（走 player_play_music 的机型根本不报进度）
    sid: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  }
  if (target.path) payload.path = String(target.path)
  if (target.url) payload.url = String(target.url)
  if (target.filename) payload.filename = String(target.filename)
  if (target.contentType) payload.contentType = String(target.contentType)
  if (Number(target.durationMs) > 0) payload.durationMs = Number(target.durationMs)
  if (target.format === 'mp3') {
    payload.format = 'mp3'
    if (Number(target.fadeOutSec) > 0) payload.fadeOutSec = Number(target.fadeOutSec)
    if (target.mp3Path) payload.mp3Path = String(target.mp3Path)
  }

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${sign(encoded)}`
}

export const parseStreamToken = (token: string): StreamTokenPayload => {
  const raw = String(token || '').trim()
  if (!raw) throw new Error('缺少 token')
  const [encoded, signature] = raw.split('.')
  if (!encoded || !signature) throw new Error('无效 token')
  if (sign(encoded) !== signature) throw new Error('token 签名校验失败')

  let payload: StreamTokenPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new Error('token 内容解析失败')
  }
  if (!payload?.path && !payload?.url) throw new Error('token 缺少播放目标')
  if (!payload.exp || Number.isNaN(Number(payload.exp)) || Date.now() > Number(payload.exp)) {
    throw new Error('token 已过期')
  }
  return payload
}

/** Content-Type → URL 后缀（音箱靠后缀判断解码方式，必须和真实内容一致） */
const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/x-ape': '.ape',
}

/** 拼接给音箱播放的完整地址（优先使用配置里的对外地址，否则用请求来源） */
export const buildStreamUrl = (
  baseUrl: string,
  streamPath: string,
  target: {
    path?: string
    url?: string
    filename?: string
    contentType?: string
    durationMs?: number
    format?: 'mp3'
    fadeOutSec?: number
    mp3Path?: string
  },
) => {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  const rawPath = String(streamPath || '/api/music/xiaoai/stream').trim()
  let pathname = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (!base) throw new Error('无法确定服务对外地址，请在设置里填写「服务地址」')
  // 地址没有扩展名时按真实格式补一个：小爱音箱会依据后缀决定解码器，
  // 给它一个「.mp3 后缀 + m4a 内容」或者干脆没后缀的地址，很容易被判成无法播放
  if (!/\.[a-z0-9]{2,5}$/i.test(pathname)) {
    if (target.format === 'mp3') {
      // 统一转 mp3：后缀必须和实际内容一致（中转出来的一定是 mp3）
      pathname += '.mp3'
    } else {
      const mime = String(target.contentType || '').split(';')[0].trim().toLowerCase()
      pathname += EXT_BY_MIME[mime] || '.mp3'
    }
  }
  const token = createStreamToken(target)
  return `${base}${pathname}?token=${encodeURIComponent(token)}`
}
