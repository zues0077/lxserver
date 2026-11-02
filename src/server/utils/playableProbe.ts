/**
 * 取链结果可播性探测。
 *
 * 背景（2026-11-02）：
 *  - B站直链经常先 302 到 `*.v.smtcdns.com`，落地域名不带 bilibili Referer 就 403；
 *    于是「解析成功」返回给前端 → 浏览器/缓存拉流 403 → 前端当成链接失效 → 换源 →
 *    又拿回同一条 403 链接 → 再失败，界面就在「解析成功 / 解析失败」之间死循环。
 *  - 同类问题不止 B站：抖音系、部分自定义源也会返回「形似合法但拉不动」的地址
 *    （鉴权过期、防盗链、返回 HTML 错误页）。
 *
 * 所以在把地址交给前端之前做一次极轻量的 Range 探测：只取 1 字节。
 * 明确 4xx 才判定不可用（401/403/404/410/451），超时/网络错误一律视为「未知，放行」，
 * 避免把慢 CDN 误杀成「没有可用音源」。
 */

import http from 'http'
import https from 'https'
import { buildStreamHeaders } from './streamHeaders'

export interface PlayableProbeResult {
  ok: boolean
  status: number
  contentType: string
  reason?: string
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 3
/** 明确表示「这条链现在拉不动」的状态码；5xx / 429 视作未知，不判死 */
const DEFINITE_BAD = new Set([400, 401, 403, 404, 405, 410, 451])

/**
 * 探测一个远程音频地址现在能不能拉到数据。
 * @param timeoutMs 单跳超时；整条链最多 3 跳，超时即视为未知（ok=true）。
 */
export function probePlayableUrl(url: string, timeoutMs = 3000): Promise<PlayableProbeResult> {
  return new Promise(resolve => {
    if (!/^https?:\/\//i.test(url)) {
      resolve({ ok: true, status: 0, contentType: '', reason: 'not-remote' })
      return
    }

    const originUrl = url
    let settled = false
    const finish = (r: PlayableProbeResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    const hop = (current: string, depth: number) => {
      if (depth > MAX_REDIRECTS) {
        finish({ ok: false, status: 0, contentType: '', reason: 'too-many-redirects' })
        return
      }
      let parsed: URL
      try {
        parsed = new URL(current)
      } catch {
        finish({ ok: true, status: 0, contentType: '', reason: 'bad-url' })
        return
      }
      const lib = parsed.protocol === 'https:' ? https : http
      const headers = buildStreamHeaders(current, {
        Range: 'bytes=0-1',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
      }, originUrl)

      const req = lib.get(current, { headers }, res => {
        const status = Number(res.statusCode) || 0
        const location = res.headers.location
        const contentType = String(res.headers['content-type'] || '')

        if (REDIRECT_STATUS.has(status) && location) {
          res.resume()
          try {
            hop(new URL(location, current).toString(), depth + 1)
          } catch {
            finish({ ok: true, status, contentType, reason: 'bad-redirect' })
          }
          return
        }

        res.resume()

        // HTML/JSON 说明拿到的是错误页而不是音频（B站 403 就返回 text/html）
        const isErrorBody = /^(text\/html|application\/json|application\/xml)/i.test(contentType)
        if (status === 200 || status === 206) {
          if (isErrorBody) {
            finish({ ok: false, status, contentType, reason: 'not-audio' })
            return
          }
          finish({ ok: true, status, contentType })
          return
        }
        if (DEFINITE_BAD.has(status)) {
          finish({ ok: false, status, contentType, reason: `http-${status}` })
          return
        }
        // 5xx / 429 / 其它：可能是临时抖动，别据此判死
        finish({ ok: true, status, contentType, reason: `soft-${status}` })
      })

      req.setTimeout(timeoutMs, () => {
        req.destroy()
        finish({ ok: true, status: 0, contentType: '', reason: 'timeout' })
      })
      req.on('error', () => {
        finish({ ok: true, status: 0, contentType: '', reason: 'network-error' })
      })
    }

    hop(url, 0)
  })
}
