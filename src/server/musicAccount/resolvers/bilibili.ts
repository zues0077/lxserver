/**
 * Bilibili —— 账号取链适配层
 *
 * 真正的接口逻辑在 src/server/extraSources/bilibili.ts（匿名取链也要用它，不能写在账号模块里）。
 * 这里只负责把结果翻译成账号通道的 AccountResolveResult。
 */

import * as bilibili from '../../extraSources/bilibili'
import { getPlatform } from '../platforms'
import type { AccountResolveResult, AccountInfo } from '../types'

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  try {
    const result = await bilibili.getAudioUrl(songInfo, quality, cookie)
    return {
      ok: true,
      url: result.url,
      quality: result.quality,
      isVip: /\+vip/.test(result.via),
      via: result.via,
      ext: result.ext,
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  const info = await bilibili.getAccountInfo(cookie)
  // 结构校验已由编排层做过，这里只把在线结果透传；拿不到就如实标 structural
  return {
    ok: info.ok,
    isVip: info.isVip,
    nickname: info.nickname,
    message: info.message || (getPlatform('bili')?.name ?? 'Bilibili'),
    verified: info.verified || 'online',
  }
}
