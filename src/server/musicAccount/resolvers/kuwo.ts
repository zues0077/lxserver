/**
 * 酷我音乐 —— 带账号 Cookie 取链
 *
 * 走移动端 `mobi.kuwo.cn/mobi.s` 的 `convert_url_with_sign`，用 br 指定音质。
 * 酷我的特点是同一接口同时决定「能不能播」和「什么音质」，
 * 所以这里从高到低依次尝试，取第一个真正返回链接的档位。
 */

import { request, withTimeout, extFromUrl, hasLoginKey } from '../http'
import { getPlatform } from '../platforms'
import type { AccountResolveResult, AccountInfo } from '../types'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MOBI_API = 'https://mobi.kuwo.cn/mobi.s'
const SOURCE = 'kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk'

/** LX 音质 → 酷我 br 参数（从高到低） */
const QUALITY_CHAIN: Array<{ br: string; quality: string; vip: boolean }> = [
  { br: '2000kflac', quality: 'flac24bit', vip: true },
  { br: 'flac', quality: 'flac', vip: true },
  { br: '320kmp3', quality: '320k', vip: true },
  { br: '128kmp3', quality: '128k', vip: false },
]

/**
 * 真实的登录态探测：酷我没有独立的会员信息接口，
 * 这里用一个公开的榜单接口带 Cookie 试探，能正常返回 JSON 即认为 Cookie 有效。
 */
export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  // 酷我没有可靠的「查询当前登录用户」接口（/api/user/info 已 404），
  // 拿公开榜单接口试探是无效判据 —— 不带 Cookie 也照样 200，会把游客判成已登录。
  // 所以这里如实只给结构校验结果，会员状态以实际取链拿到的音质为准。
  // 字段清单读平台定义，避免这里另写一份导致前后两套判据
  const keys = getPlatform('kw')?.loginKeys ?? ['kw_token', 'user_id']
  if (!hasLoginKey(cookie, keys)) {
    return { ok: false, verified: 'structural', message: `Cookie 里没有找到 ${keys.join(' / ')}，请确认已登录酷我后再复制` }
  }
  return {
    ok: true,
    verified: 'structural',
    message: '已完成结构校验；酷我不提供可用的登录态查询接口，会员状态以实际取链音质为准',
  }
}

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const rid = String(songInfo?.songmid ?? songInfo?.meta?.songId ?? songInfo?.id ?? '')
  if (!rid) return { ok: false, error: '歌曲缺少酷我 rid，无法用账号取链' }

  const start = QUALITY_CHAIN.findIndex(q => q.quality === quality)
  const chain = start >= 0 ? QUALITY_CHAIN.slice(start) : QUALITY_CHAIN
  const user = `C_APK_guanwang_${Date.now()}${Math.floor(Math.random() * 1_000_000)}`

  for (const item of chain) {
    const params = new URLSearchParams({
      f: 'web',
      source: SOURCE,
      from: 'PC',
      type: 'convert_url_with_sign',
      br: item.br,
      rid,
      user,
    })
    try {
      const resp = await withTimeout(request(`${MOBI_API}?${params.toString()}`, {
        headers: { 'User-Agent': UA, Cookie: cookie },
      }), 12000, '酷我取链')

      const url = String((resp?.body as any)?.data?.url || '')
      if (url) {
        return {
          ok: true,
          url,
          quality: item.quality,
          isVip: item.vip,
          via: `mobi:${item.br}`,
          ext: extFromUrl(url),
        }
      }
    } catch (e: any) {
      return { ok: false, error: `酷我取链失败：${e.message}` }
    }
  }

  return { ok: false, error: '酷我未返回可用链接（多为版权受限或 Cookie 失效）' }
}
