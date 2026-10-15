import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getProxyAgent } from '../../modules/utils/proxy.js'
import type { StreamTokenPayload } from './streamToken'

/**
 * 把小爱音箱要播放的音频流转发出去。
 *
 * 音箱只会照 URL 拉流，所以：
 *  - 在线歌曲：由本服务做中转（带上 Referer/UA 回源），绕开音源防盗链与 http/https 混用问题
 *  - 本地文件：直接读盘返回
 * 两种目标都由签名 token 授权，token 过期即失效。
 */

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape',
}

const parseRange = (range: string | undefined, size: number) => {
  if (!range) return null
  const match = /bytes=(\d*)-(\d*)/.exec(range)
  if (!match) return null
  const start = match[1] ? Number(match[1]) : 0
  const end = match[2] ? Number(match[2]) : size - 1
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return null
  return { start, end: Math.min(end, size - 1) }
}

/** 本地文件流 */
const serveLocalFile = (req: IncomingMessage, res: ServerResponse, filePath: string, filename?: string) => {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, message: '文件不存在' }))
    return
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, message: '不是有效文件' }))
    return
  }

  const contentType = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  const range = parseRange(req.headers.range as string | undefined, stat.size)

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  if (filename) headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`

  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
    headers['Content-Length'] = String(range.end - range.start + 1)
    res.writeHead(206, headers)
    fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res)
    return
  }

  headers['Content-Length'] = String(stat.size)
  res.writeHead(200, headers)
  fs.createReadStream(filePath).pipe(res)
}

/** 远端音频中转 */
const serveRemoteUrl = async (req: IncomingMessage, res: ServerResponse, upstreamUrl: string, filename?: string) => {
  const agent = await getProxyAgent(upstreamUrl, 'music')
  const headers: Record<string, string> = {
    // 部分音源按 UA/Referer 防盗链，这里伪装成浏览器取流
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Encoding': 'identity',
  }
  try {
    headers.Referer = new URL(upstreamUrl).origin
  } catch {
    /* 忽略非法 URL */
  }
  if (req.headers.range) headers.Range = String(req.headers.range)
  if (filename) headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`

  const client = upstreamUrl.startsWith('https:') ? https : http

  await new Promise<void>(resolve => {
    let settled = false
    const done = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }

    const upstream = client.get(upstreamUrl, { headers, agent: (agent as any) || undefined }, up => {
      const status = Number(up.statusCode) || 0
      if (status >= 400) {
        up.resume()
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: `回源失败: HTTP ${status}` }))
        }
        return done()
      }

      const outHeaders: Record<string, string> = {
        'Content-Type': String(up.headers['content-type'] || 'audio/mpeg'),
        'Accept-Ranges': String(up.headers['accept-ranges'] || 'bytes'),
        'Cache-Control': 'no-store',
      }
      if (up.headers['content-length']) outHeaders['Content-Length'] = String(up.headers['content-length'])
      if (up.headers['content-range']) outHeaders['Content-Range'] = String(up.headers['content-range'])
      if (filename) outHeaders['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`

      res.writeHead(status === 206 ? 206 : 200, outHeaders)
      up.pipe(res)
      up.on('end', done)
      up.on('error', done)
    })

    upstream.on('error', (error: any) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: `回源失败: ${error?.message || error}` }))
      }
      done()
    })
    upstream.setTimeout(30000, () => {
      upstream.destroy()
      done()
    })
    req.on('close', () => {
      upstream.destroy()
      done()
    })
  })
}

/** 统一入口 */
export const serveXiaoAiStream = async (req: IncomingMessage, res: ServerResponse, payload: StreamTokenPayload) => {
  if (payload.path) {
    serveLocalFile(req, res, payload.path, payload.filename)
    return
  }
  if (payload.url) {
    await serveRemoteUrl(req, res, payload.url, payload.filename)
    return
  }
  res.writeHead(400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ success: false, message: 'token 缺少播放目标' }))
}
