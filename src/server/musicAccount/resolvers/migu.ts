/**
 * 咪咕音乐 —— 带账号 Cookie 取链
 *
 * ⚠️ 必须记住的实测事实（2026-10-24，别再凭想象改）：
 *
 * 1) **端点要用 v2.0 + netType=00 + songId=数字内容id。**
 *    旧实现走的 `v2.1/content/listen-url?netType=01&contentId=xx` 会对所有歌统一返回
 *    `code=200000 歌曲下线暂不支持播放` —— 那不是歌真下线了，是请求形态不对被软拒。
 *    换成 `v2.0/content/listen-url?netType=00&resourceType=2&songId={contentId}&toneFlag=SQ`
 *    后全部正常出链（实测 孤勇者/起风了/月亮之上/七里香 全过）。
 *
 * 2) **头必须带全套，最小头（只有 UA+Referer）会被拒 299999「channel不能为空」。**
 *    实测需要：UA + Referer(m.music.migu.cn/v4) + By(设备id) + channel + pacmtoken + Cookie。
 *
 * 3) **toneFlag 是被尊重的，音质标签可以直接按请求档落。**
 *    实测 孤勇者 1139098751：PQ 3.9MB mp3 / HQ 9.8MB mp3 / SQ 27.3MB x-flac（真无损）。
 */

import { request, withTimeout, extFromUrl, hasLoginKey, parseCookie } from '../http'
import { getPlatform } from '../platforms'
import type { AccountResolveResult, AccountInfo } from '../types'

const LISTEN_URL = 'https://c.musicapp.migu.cn/MIGUM2.0/v2.0/content/listen-url'
const MIGU_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const CHANNEL = '0146921'
const VERSION = '7.41.13'

/**
 * 咪咕的登录凭证不止在 Cookie 里，接口还认请求头里的 pacmtoken，
 * By 要带设备 id（cookieId / migu-device-uuid 都行），channel 是固定值。
 * 缺任意一个都可能被软拒（299999 / 200000）。
 */
function authHeaders(cookie: string): Record<string, string> {
  const map = parseCookie(cookie)
  const headers: Record<string, string> = {}
  const token = map.pacmtoken || map['migu-utoken-sessionid'] || map.LTToken || ''
  if (token) headers.pacmtoken = token
  const uid = map.mg_auth_uid || map.userid || map.userId || map.uid || ''
  if (uid) headers.uid = uid
  const by = map.cookieId || map['migu-device-uuid'] || map['mgAppH5CookieId'] || ''
  if (by) headers.By = by
  return headers
}

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
  //
  // 字段清单必须读平台定义，不能在这里另写一份：
  // 网页版登录后的字段是 idmpauth / pacmtoken / migu-utoken-sessionid / LTToken，
  // 早先这里写死成 migu_music / USERTICKET / pusk，结果登录了也一律判「没找到登录字段」。
  const keys = getPlatform('mg')?.loginKeys ?? ['*pacmtoken*', '*utoken*']
  if (!hasLoginKey(cookie, keys)) {
    return { ok: false, verified: 'structural', message: `Cookie 里没有找到登录字段（${keys.join(' / ')}），请确认已登录咪咕后再复制` }
  }
  return {
    ok: true,
    verified: 'structural',
    message: '已完成结构校验；咪咕不提供可用的登录态查询接口，会员状态以实际取链音质为准',
  }
}

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const { contentId } = pickIds(songInfo)
  if (!contentId) return { ok: false, error: '歌曲缺少咪咕 contentId，无法用账号取链' }

  const start = TONE_CHAIN.findIndex(t => t.quality === quality)
  const chain = start >= 0 ? TONE_CHAIN.slice(start) : TONE_CHAIN.slice(2)

  let lastError = ''
  for (const item of chain) {
    // v2.0 形态：netType=00 + songId=数字内容id（contentId/copyrightId 形态都会被「下线」软拒）
    const params = new URLSearchParams({
      netType: '00',
      resourceType: '2',
      songId: contentId,
      toneFlag: item.tone,
    })

    try {
      const resp = await withTimeout(request(`${LISTEN_URL}?${params.toString()}`, {
        headers: {
          'User-Agent': MIGU_UA,
          Referer: 'https://m.music.migu.cn/v4',
          channel: CHANNEL,
          version: VERSION,
          Cookie: cookie,
          ...authHeaders(cookie),
        },
      }), 12000, '咪咕取链')

      const body: any = resp.body
      // 咪咕用字符串 code，'000000' 才是成功；单档失败降级继续，不中断整个链
      if (body?.code && body.code !== '000000') {
        lastError = `${item.tone}:${body.info || body.code}`
        continue
      }
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
      lastError = `${item.tone}:${e.message}`
    }
  }

  return { ok: false, error: `咪咕未返回可用链接（${lastError || '多为版权受限'}）` }
}
