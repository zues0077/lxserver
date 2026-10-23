/**
 * 酷狗音乐 —— 带账号 Cookie 取链
 *
 * 酷狗是五个平台里链路最多的一个，按「从强到弱」依次尝试：
 *   1. VIP 链路（fetchURLV5 / fetchPrivURLV6 对应端点）—— 只有带登录 Cookie 才可能成功
 *   2. songinfo_v2 —— 需要 Cookie 里的 t 与 KugooID，会员高音质走这条
 *   3. getSongInfo —— 公开兜底，不登录也能拿 128k
 *
 * 会员判定走 vip.kugou.com/recharge/roleinfo，返回里有 vipRemains 与 isExpiredMember。
 */

import { request, withTimeout, parseCookie, extFromUrl } from '../http'
import type { AccountResolveResult, AccountInfo } from '../types'

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1'
const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const MOBILE_REFERER = 'http://m.kugou.com'
const VIP_INFO_API = 'https://vip.kugou.com/recharge/roleinfo'
const GET_SONG_INFO = 'http://m.kugou.com/app/i/getSongInfo.php'

const firstNonEmpty = (...vals: Array<string | undefined>) => vals.find(v => v && String(v).trim()) || ''

function pickHash(songInfo: any): string {
  return String(songInfo?.hash ?? songInfo?.meta?.hash ?? songInfo?.songmid ?? songInfo?.meta?.songId ?? '')
}

/** 公开兜底：getSongInfo */
async function fetchBySongInfo(hash: string, cookie: string): Promise<string> {
  const params = new URLSearchParams({ cmd: 'playInfo', hash })
  const resp = await request(`${GET_SONG_INFO}?${params.toString()}`, {
    headers: { 'User-Agent': MOBILE_UA, Referer: MOBILE_REFERER, Cookie: cookie },
  })
  const body: any = resp.body
  // errcode 非 0 通常意味着风控或付费受限
  if (body?.errcode && Number(body.errcode) !== 0) return ''
  return String(body?.url || '')
}

/**
 * songinfo_v2：两步走，先拿 encode_album_audio_id，再换播放链接。
 * 需要 Cookie 里的 t（令牌）与 KugooID（用户 id），缺一不可。
 */
async function fetchBySonginfoV2(hash: string, cookie: string): Promise<string> {
  const cm = parseCookie(cookie)
  const token = cm['t'] || cm['token'] || ''
  const userId = cm['KugooID'] || cm['userid'] || cm['user_id'] || ''
  if (!token || !userId) return ''

  const base: Record<string, string> = {
    srcappid: '2919',
    clientver: '20000',
    clienttime: String(Date.now()),
    mid: firstNonEmpty(cm['mid'], cm['kg_mid']),
    uuid: firstNonEmpty(cm['uuid'], cm['mid'], cm['kg_mid']),
    dfid: firstNonEmpty(cm['dfid'], cm['kg_dfid']),
    appid: '1014',
    platid: '4',
    token,
    userid: userId,
  }

  const step1 = new URLSearchParams({ ...base, hash })
  const r1 = await request(`https://gateway.kugou.com/v5/album_audio/audio?${step1.toString()}`, {
    headers: { 'User-Agent': PC_UA, Referer: 'https://www.kugou.com/', Cookie: cookie },
  })
  const encodeId = String((r1?.body as any)?.data?.encode_album_audio_id || '')
  if (!encodeId) return ''

  const step2 = new URLSearchParams({ ...base, encode_album_audio_id: encodeId })
  const r2 = await request(`https://gateway.kugou.com/v5/album_audio/audio?${step2.toString()}`, {
    headers: { 'User-Agent': PC_UA, Referer: 'https://www.kugou.com/', Cookie: cookie },
  })
  const data: any = (r2?.body as any)?.data || {}
  return String(data?.play_url || data?.play_backup_url || '')
}

export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  try {
    const resp = await withTimeout(request(VIP_INFO_API, {
      headers: {
        'User-Agent': PC_UA,
        Accept: '*/*',
        Host: 'vip.kugou.com',
        Connection: 'keep-alive',
        Cookie: cookie,
      },
    }), 10000, '酷狗会员校验')

    const b: any = resp.body || {}
    // errno / error_code 非 0 表示令牌无效（实测无效 token 返回 errno=105、error_code=20017）。
    // 这一步必须做：否则任何胡填的 Cookie 都会被显示成「已登录」。
    if (Number(b?.errno) !== 0 || Number(b?.error_code) !== 0) {
      return {
        ok: false,
        verified: 'online',
        message: `Cookie 无效或已过期（errno=${b?.errno}，error_code=${b?.error_code}），请重新登录酷狗后复制`,
      }
    }
    const isVip = Number(b?.vipRemains) > 0 &&
      Number(b?.isExpiredMember) === 0 &&
      Number(b?.role) !== 0
    return { ok: true, verified: 'online', isVip, nickname: String(b?.nickname || '酷狗账号') }
  } catch (e: any) {
    return { ok: false, message: `酷狗会员校验失败：${e.message}` }
  }
}

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const hash = pickHash(songInfo)
  if (!hash) return { ok: false, error: '歌曲缺少酷狗 hash，无法用账号取链' }

  // 1) 会员链路：songinfo_v2 能拿到高音质
  try {
    const url = await withTimeout(fetchBySonginfoV2(hash, cookie), 12000, '酷狗会员取链')
    if (url) {
      return { ok: true, url, quality, isVip: true, via: 'songinfo_v2', ext: extFromUrl(url) }
    }
  } catch { /* 会员链路不可用，继续兜底 */ }

  // 2) 公开兜底
  try {
    const url = await withTimeout(fetchBySongInfo(hash, cookie), 12000, '酷狗取链')
    if (url) {
      return { ok: true, url, quality: '128k', isVip: false, via: 'getSongInfo', ext: extFromUrl(url) }
    }
  } catch (e: any) {
    return { ok: false, error: `酷狗取链失败：${e.message}` }
  }

  return { ok: false, error: '酷狗未返回可用链接（多为付费曲目或触发风控）' }
}
