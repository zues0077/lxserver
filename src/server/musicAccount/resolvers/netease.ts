/**
 * 网易云音乐 —— 带账号 Cookie 取链
 *
 * 两条通道（与参考实现 go-music-dl 保持一致）：
 *   1. weapi  `/weapi/song/enhance/player/url`      按 br 取码率，通用通道
 *   2. eapi   `/eapi/song/enhance/player/url/v1`    按 level 取，会员才能拿到无损/Hi-Res
 *
 * 实测注意：匿名请求这两条通道都会返回空 body 或 400 —— 网易对未登录请求直接不回内容，
 * 所以「配了账号却仍取不到」时，第一怀疑对象应是 Cookie 失效，而不是代码逻辑。
 */

import { weapi, eapi } from '@/modules/utils/musicSdk/wy/utils/crypto.js'
import { request, withTimeout, extFromUrl } from '../http'
import type { AccountResolveResult, AccountInfo } from '../types'

const REFERER = 'https://music.163.com/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const DOWNLOAD_API = 'https://music.163.com/weapi/song/enhance/player/url'
const DOWNLOAD_EAPI = 'https://interface3.music.163.com/eapi/song/enhance/player/url/v1'
const USER_ACCOUNT_API = 'https://music.163.com/weapi/nuser/account/get'
const EAPI_HEADER = JSON.stringify({ os: 'pc', appver: '', osver: '', deviceId: 'pyncm!', requestId: '12345678' })

/** LX 音质 → 网易 level 与 weapi 码率 */
const QUALITY_MAP: Record<string, { level: string; br: number }> = {
  '128k': { level: 'standard', br: 128000 },
  '192k': { level: 'exhigh', br: 192000 },
  '320k': { level: 'exhigh', br: 320000 },
  'ape': { level: 'lossless', br: 999000 },
  'flac': { level: 'lossless', br: 999000 },
  'flac24bit': { level: 'hires', br: 999000 },
  'hires': { level: 'hires', br: 999000 },
  'atmos': { level: 'jyeffect', br: 999000 },
  'atmos_plus': { level: 'sky', br: 999000 },
  'master': { level: 'jymaster', br: 999000 },
  'wav': { level: 'jymaster', br: 999000 },
}

/** 会员优先尝试的音质顺序：从请求音质往下退，避免「有会员却只拿到 128k」 */
const VIP_LEVEL_CHAIN = ['jymaster', 'sky', 'jyeffect', 'hires', 'lossless', 'exhigh', 'standard']

function formOf(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

/** 探测登录态与 VIP 状态（VIP 判定用于决定是否走 eapi 高音质通道） */
export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  const { params, encSecKey } = weapi({ csrf_token: '' })
  try {
    const resp = await withTimeout(request(USER_ACCOUNT_API, {
      method: 'post',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: REFERER, Cookie: cookie },
      form: formOf({ params, encSecKey }),
    }), 12000, '网易账号信息')

    const body: any = resp.body
    if (!body || typeof body !== 'object') {
      return { ok: false, message: '接口返回空内容，Cookie 可能已失效' }
    }
    if (body.code !== 200) {
      return { ok: false, verified: 'online', message: `未登录或 Cookie 失效（code=${body.code}）` }
    }
    // code=200 但 profile 为空 = 网易对无效 Cookie 的软失败（实测假 MUSIC_U 也返回 200），
    // 必须再确认拿到了真实账号信息，否则会把游客显示成已登录。
    const profile = body?.profile
    if (!profile || (!profile.userId && !profile.nickname)) {
      return { ok: false, verified: 'online', message: '未取到账号信息，Cookie 无效或已过期，请重新登录后复制' }
    }
    return {
      ok: true,
      verified: 'online',
      isVip: Number(profile.vipType || 0) !== 0,
      nickname: profile.nickname || undefined,
    }
  } catch (e: any) {
    return { ok: false, message: `账号校验失败：${e.message}` }
  }
}

/** weapi 通道：按 br 取链，会员与非会员都可用 */
async function fetchByWeapi(songId: string, br: number, cookie: string): Promise<string> {
  const { params, encSecKey } = weapi({ ids: [String(songId)], br, csrf_token: '' })
  const resp = await request(DOWNLOAD_API, {
    method: 'post',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: REFERER, Cookie: cookie, 'User-Agent': UA },
    form: formOf({ params, encSecKey }),
  })
  const body: any = resp.body
  const item = body?.data?.[0]
  return item?.url ? String(item.url) : ''
}

/** eapi 通道：按 level 取链，会员高音质走这里 */
async function fetchByEapi(songId: string, level: string, cookie: string): Promise<string> {
  const payload = { ids: [Number(songId)], level, encodeType: 'flac', header: EAPI_HEADER }
  const { params } = eapi('/eapi/song/enhance/player/url/v1', payload)
  const resp = await request(DOWNLOAD_EAPI, {
    method: 'post',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: REFERER, Cookie: cookie, 'User-Agent': UA },
    form: formOf({ params }),
  })
  const body: any = resp.body
  const item = body?.data?.[0]
  return item?.url ? String(item.url) : ''
}

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const songId = String(songInfo?.songmid ?? songInfo?.meta?.songId ?? songInfo?.id ?? '')
  if (!songId || !/^\d+$/.test(songId)) {
    return { ok: false, error: '歌曲缺少网易 songmid，无法用账号取链' }
  }

  const cfg = QUALITY_MAP[quality] || QUALITY_MAP['320k']

  // 会员：先按 level 从高往低试 eapi，拿到最好音质
  let isVip = false
  try {
    const info = await getAccountInfo(cookie)
    isVip = !!info.isVip
  } catch { /* 探测失败不阻断取链，按非会员处理 */ }

  if (isVip) {
    const start = VIP_LEVEL_CHAIN.indexOf(cfg.level)
    const chain = start >= 0 ? VIP_LEVEL_CHAIN.slice(start) : VIP_LEVEL_CHAIN
    for (const level of chain) {
      try {
        const url = await withTimeout(fetchByEapi(songId, level, cookie), 12000, '网易 eapi 取链')
        if (url) {
          return { ok: true, url, quality: quality, isVip: true, via: 'eapi', ext: extFromUrl(url) }
        }
      } catch { /* 单个 level 失败继续往下退 */ }
    }
  }

  // 非会员（或会员 eapi 全失败）：走 weapi 按码率取
  for (const br of [cfg.br, 320000, 128000]) {
    try {
      const url = await withTimeout(fetchByWeapi(songId, br, cookie), 12000, '网易 weapi 取链')
      if (url) {
        return { ok: true, url, quality: quality, isVip, via: 'weapi', ext: extFromUrl(url) }
      }
    } catch (e: any) {
      return { ok: false, error: `网易取链失败：${e.message}` }
    }
  }

  return { ok: false, error: '网易未返回可用链接（多为版权受限或会员过期）' }
}
