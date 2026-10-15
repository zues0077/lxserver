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
  ttlMs?: number
}): string => {
  const ttl = Math.max(MIN_TTL_MS, Number(target.ttlMs) || DEFAULT_TTL_MS)
  const payload: StreamTokenPayload = {
    exp: Date.now() + ttl,
  }
  if (target.path) payload.path = String(target.path)
  if (target.url) payload.url = String(target.url)
  if (target.filename) payload.filename = String(target.filename)

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

/** 拼接给音箱播放的完整地址（优先使用配置里的对外地址，否则用请求来源） */
export const buildStreamUrl = (baseUrl: string, streamPath: string, target: { path?: string; url?: string; filename?: string }) => {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  const rawPath = String(streamPath || '/api/music/xiaoai/stream').trim()
  const pathname = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (!base) throw new Error('无法确定服务对外地址，请在设置里填写「服务地址」')
  const token = createStreamToken(target)
  return `${base}${pathname}?token=${encodeURIComponent(token)}`
}
