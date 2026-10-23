/**
 * 平台账号取链 —— 对外入口
 *
 * 职责边界：
 *   - 只负责「用自己的账号能不能拿到更好的链接」，拿到就交给播放链路；
 *   - 拿不到就返回 null，由自定义音源继续兜底，绝不在这里抛错打断取链。
 *
 * 之所以做成「独立模块 + 单一入口」，是为了不侵入内置 musicSdk：
 * 上游 musicSdk 需要经常被原作者的新版本覆盖，任何改动都会在覆盖时丢失。
 */

import * as netease from './resolvers/netease'
import * as qq from './resolvers/qq'
import * as kuwo from './resolvers/kuwo'
import * as kugou from './resolvers/kugou'
import * as migu from './resolvers/migu'
import { isSupportedSource, getPlatform } from './platforms'
import { hasLoginKey } from './http'
import * as store from './store'
import type { AccountResolveResult, AccountInfo, PlatformResolver } from './types'

export { PLATFORMS, getPlatform, isSupportedSource } from './platforms'
export type { AccountResolveResult, AccountInfo } from './types'

/** 平台 id → 解析器。新增平台时在这里补一行即可。 */
const RESOLVERS: Record<string, PlatformResolver> = {
  wy: netease,
  tx: qq,
  kw: kuwo,
  kg: kugou,
  mg: migu,
}

/** 会员状态缓存：避免每首歌都去探一次会员接口 */
const vipCache = new Map<string, { at: number; isVip: boolean }>()
const VIP_CACHE_TTL = 10 * 60 * 1000

function config(): any {
  return global.lx?.config || {}
}

/** 总开关：未开启时整条账号通道不参与取链 */
export function isEnabled(): boolean {
  return config()['musicAccount.enabled'] === true
}

/**
 * 该 source 当前能否走账号通道（开关开 + 平台受支持 + 已配置账号）。
 * 供上层路由判断「没有自定义源时还要不要试账号」。
 */
export function hasAccount(source: string): boolean {
  return store.hasAccount(source)
}

/** 是否「首选自己账号」；关闭则退化为「自定义源失败后才尝试账号」 */
export function isPriority(): boolean {
  return config()['musicAccount.priority'] !== false
}

/** 取链超时上限 */
function timeoutMs(): number {
  const n = Number(config()['musicAccount.timeoutMs'])
  return Number.isFinite(n) && n >= 3000 ? n : 15000
}

/**
 * 尝试用已配置的平台账号取播放链接。
 *
 * @returns 成功返回结果；「未启用 / 未配置 / 不支持 / 失败」一律返回 null，
 *          由调用方继续走自定义音源。
 */
export async function tryResolveByAccount(
  source: string,
  songInfo: any,
  quality: string,
): Promise<AccountResolveResult | null> {
  if (!isEnabled()) return null
  if (!isSupportedSource(source)) return null

  const resolver = RESOLVERS[source]
  if (!resolver) return null

  const cookie = store.getCookie(source)
  if (!cookie) return null

  try {
    const result = await withDeadline(resolver.resolve(songInfo, quality, cookie), timeoutMs())
    if (result?.ok && result.url) {
      const p = getPlatform(source)
      console.log(`[平台账号] ✓ ${p?.name ?? source} 取链成功（通道 ${result.via ?? '-'}，音质 ${result.quality ?? quality}${result.isVip ? '，会员' : ''}）`)
      return result
    }
    if (result?.error) {
      console.log(`[平台账号] ${getPlatform(source)?.name ?? source} 未取到链接：${result.error}`)
    }
    return null
  } catch (e: any) {
    console.log(`[平台账号] ${getPlatform(source)?.name ?? source} 取链异常：${e?.message || e}`)
    return null
  }
}

/** 验证某平台账号：先做结构校验，再做（有把握的）在线校验 */
export async function verifyAccount(id: string): Promise<AccountInfo> {
  const resolver = RESOLVERS[id]
  const platform = getPlatform(id)
  if (!resolver || !platform) return { ok: false, message: `不支持的平台：${id}` }

  const cookie = store.getCookie(id)
  if (!cookie) return { ok: false, message: '尚未配置 Cookie' }

  // 结构校验：Cookie 里必须含该平台的登录字段。
  // 这一步挡掉「粘了半截 Cookie」「粘了别家 Cookie」这类最常见的手误，
  // 而且所有平台都能做，不依赖各家接口是否提供用户信息端点。
  if (!hasLoginKey(cookie, platform.loginKeys)) {
    const miss = platform.loginKeys.join(' / ')
    return {
      ok: false,
      verified: 'structural',
      message: `Cookie 里没有找到登录字段（需要包含 ${miss} 之一），请确认已登录后再复制`,
    }
  }

  let info: AccountInfo
  try {
    info = await withDeadline(resolver.getAccountInfo(cookie), 12000)
  } catch (e: any) {
    info = { ok: false, message: `校验超时或网络异常：${e?.message || e}` }
  }

  if (info.ok && typeof info.isVip === 'boolean') {
    vipCache.set(id, { at: Date.now(), isVip: info.isVip })
  }
  store.saveVerifyResult(id, {
    at: Date.now(),
    ok: info.ok,
    isVip: info.isVip,
    message: info.message,
    nickname: info.nickname,
    verified: info.verified ?? 'online',
  })
  return info
}

/** 取缓存的会员状态（无缓存返回 undefined） */
export function cachedIsVip(id: string): boolean | undefined {
  const hit = vipCache.get(id)
  if (!hit) return undefined
  if (Date.now() - hit.at > VIP_CACHE_TTL) { vipCache.delete(id); return undefined }
  return hit.isVip
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超过 ${ms}ms 未完成`)), ms)
    p.then(v => { clearTimeout(timer); resolve(v) })
      .catch(e => { clearTimeout(timer); reject(e) })
  })
}

// ---- 供接口层使用的 store 再导出，避免 API 直接依赖内部文件 ----
export const getAccounts = store.listAccounts
export const setAccount = store.setCookie
export const removeAccount = store.removeCookie
export const getStoreFilePath = store.getStoreFilePath
