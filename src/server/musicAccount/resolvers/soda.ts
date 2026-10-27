/**
 * 汽水音乐 —— 账号取链适配层
 *
 * 真正接口在 extraSources/soda.ts：走 `/luna/h5/track_v2`，免登录即可播 cover/UGC 类曲目；
 * 只有「版权受限曲的整曲 / 会员无损」需要官方 Windows 客户端签名（x-helios/x-medusa），NAS 侧做不到。
 * 这里只做一层薄转发：把 Cookie 传下去，并把失败原因原样透出（例如「该曲仅有 30 秒试听」）。
 */

import * as soda from '../../extraSources/soda'
import type { AccountResolveResult, AccountInfo } from '../types'

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  try {
    const result = await soda.getAudioUrl(songInfo, quality, cookie)
    return {
      ok: true,
      url: result.url,
      quality: result.quality,
      isVip: false,
      via: result.via,
      ext: result.ext,
      key: result.key,
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  const info = await soda.getAccountInfo(cookie)
  return {
    ok: info.ok,
    isVip: info.isVip,
    message: info.message,
    verified: info.verified || 'structural',
  }
}
