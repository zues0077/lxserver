/**
 * 咪咕音乐 —— 带账号 Cookie 取链
 *
 * 走 `c.musicapp.migu.cn/MIGUM2.0/v2.1/content/listen-url`，用 toneFlag 指定音质。
 * 实测结论（很能说明账号的价值）：
 *   未登录  → 只有 PQ(128k) 能返回链接
 *   登录后  → HQ(320k) / SQ(无损) 才会返回链接
 * 所以这里按「请求音质往下退」，但把 PQ 留作最后兜底。
 */

import { request, withTimeout, extFromUrl, hasLoginKey } from '../http'
import type { AccountResolveResult, AccountInfo } from '../types'

const LISTEN_URL = 'https://c.musicapp.migu.cn/MIGUM2.0/v2.1/content/listen-url'
const MIGU_UA = 'Android_migu/7.41.13 okhttp/3.12.13'
const CHANNEL = '0146832'
const VERSION = '7.41.13'

/** LX 音质 → 咪咕 toneFlag（从高到低） */
const TONE_CHAIN: Array<{ tone: string; quality: string; vip: boolean }> = [
  { tone: 'ZQ', quality: 'flac24bit', vip: true },
  { tone: 'SQ', quality: 'flac', vip: true },
  { tone: 'HQ', quality: '320k', vip: true },
  { tone: 'PQ', quality: '128k', vip: false },
]

function pickIds(songInfo: any): { contentId: string; copyrightId: string } {
  return {
    contentId: String(songInfo?.songmid ?? songInfo?.meta?.songId ?? songInfo?.id ?? ''),
    copyrightId: String(songInfo?.copyrightId ?? songInfo?.meta?.copyrightId ?? ''),
  }
}

export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  // 咪咕同样没有可靠的「查当前登录用户」接口（试过的 userInfo.do 返回「路由请求不支持」）。
  // 用公开接口试探无效 —— 不登录也 200。如实只做结构校验。
  if (!hasLoginKey(cookie, ['migu_music', 'USERTICKET', 'pusk', 'userid'])) {
    return { ok: false, verified: 'structural', message: 'Cookie 里没有找到 USERTICKET / pusk 等登录字段，请确认已登录咪咕后再复制' }
  }
  return {
    ok: true,
    verified: 'structural',
    message: '已完成结构校验；咪咕不提供可用的登录态查询接口，会员状态以实际取链音质为准',
  }
}

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const { contentId, copyrightId } = pickIds(songInfo)
  if (!contentId) return { ok: false, error: '歌曲缺少咪咕 contentId，无法用账号取链' }

  const start = TONE_CHAIN.findIndex(t => t.quality === quality)
  const chain = start >= 0 ? TONE_CHAIN.slice(start) : TONE_CHAIN.slice(2)

  for (const item of chain) {
    const params = new URLSearchParams({
      netType: '01',
      resourceType: '2',
      contentId,
      toneFlag: item.tone,
    })
    if (copyrightId) params.set('copyrightId', copyrightId)

    try {
      const resp = await withTimeout(request(`${LISTEN_URL}?${params.toString()}`, {
        headers: {
          'User-Agent': MIGU_UA,
          channel: CHANNEL,
          version: VERSION,
          Referer: 'https://music.migu.cn/',
          Cookie: cookie,
        },
      }), 12000, '咪咕取链')

      const body: any = resp.body
      // 咪咕用字符串 code，'000000' 才是成功
      if (body?.code && body.code !== '000000') continue
      const url = String(body?.data?.url || '')
      if (url) {
        return {
          ok: true,
          url,
          quality: item.quality,
          isVip: item.vip,
          via: `listen-url:${item.tone}`,
          ext: extFromUrl(url),
        }
      }
    } catch (e: any) {
      return { ok: false, error: `咪咕取链失败：${e.message}` }
    }
  }

  return { ok: false, error: '咪咕未返回可用链接（多为版权受限）' }
}
