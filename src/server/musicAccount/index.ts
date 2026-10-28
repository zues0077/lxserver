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
import * as bilibili from './resolvers/bilibili'
import * as soda from './resolvers/soda'
import { isSupportedSource, getPlatform } from './platforms'
import { hasLoginKey, parseCookie } from './http'
import { normalizeCookieInput, formatLabel } from './cookieParse'
import * as store from './store'
import * as qrLogin from './qrLogin'
import { summarize } from './health'
import type { HealthSummary } from './health'
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
  bili: bilibili,
  soda: soda,
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
      probeAccountAfterFailure(source)
    }
    return null
  } catch (e: any) {
    const msg = e?.message || String(e)
    console.log(`[平台账号] ${getPlatform(source)?.name ?? source} 取链异常：${msg}`)
    probeAccountAfterFailure(source)
    return null
  }
}

/**
 * 取链失败后，后台复核一次账号登录态。
 *
 * 为什么不用「报错文案里有没有『失效』」来判断：各平台 resolver 的兜底文案是**含糊**的，
 * 比如酷我是「多为版权受限、需要会员或 Cookie 失效」、QQ 是「多为付费/版权受限曲目…
 * 或 Cookie 已过期」——同一句话既可能是歌的问题也可能是账号的问题。按关键词标记，
 * 唱一首没版权的歌就能把好账号标成「已失效」，比不提示更糟。
 *
 * 所以改成「让平台自己的接口说话」：调一次 getAccountInfo（需登录态的接口），
 * 它说没登录才是真失效；说正常就顺手把校验时间刷新成现在。
 * 加 30 分钟冷却，避免连播几十首失败曲把各家接口打成扫描。
 */
const lastAuthProbeAt = new Map<string, number>()
const AUTH_PROBE_COOLDOWN_MS = 30 * 60 * 1000

function probeAccountAfterFailure(id: string): void {
  const last = lastAuthProbeAt.get(id) ?? 0
  if (Date.now() - last < AUTH_PROBE_COOLDOWN_MS) return
  lastAuthProbeAt.set(id, Date.now())

  void verifyAccount(id)
    .then(info => {
      const name = getPlatform(id)?.name ?? id
      if (info.ok) return
      if (info.verified === 'structural') {
        console.log(`[平台账号] ${name} 取链失败，但本平台只能做结构校验，无法判断登录态：${info.message || ''}`)
        return
      }
      console.log(`[平台账号] ⚠ ${name} 登录态复查失败，已标记为失效：${info.message || ''}`)
    })
    .catch((e: any) => {
      console.log(`[平台账号] 取链失败后的账号复核出错（忽略）：${e?.message || e}`)
    })
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
    // 把「实际有哪些字段」一并回显：用户不必截图问人，自己就能看出
    // 是没登录、还是平台换了新字段名（我们认不出来）
    const present = Object.keys(parseCookie(cookie))
    const names = present.slice(0, 14).join(', ') + (present.length > 14 ? ' …' : '')
    return {
      ok: false,
      verified: 'structural',
      message: `没有识别到登录字段（期望 ${platform.loginKeys.join(' / ')}）。当前 Cookie 里的字段是：${names || '（空）'}。`
        + '如果你确认已经登录，请把这段字段名发我，我按新字段名适配。',
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

export interface SaveAccountResult {
  success: boolean
  error?: string
  /** 识别到的格式：cookie-header / curl / netscape / json / kv */
  format?: string
  /** 格式的中文名，前端直接展示 */
  formatText?: string
  /** 有效 Cookie 条数 */
  count?: number
  /** 解析出的字段名（前 30 个），前端可展示，便于用户判断有没有抄对 */
  keys?: string[]
  /** 归一化后的长度 */
  cookieLength?: number
  /** 关键字段缺失等提示，不阻断保存 */
  warnings?: string[]
  /** 被丢弃的条目（多为已过期） */
  dropped?: string[]
}

/**
 * 保存账号：先把用户粘进来的任意内容归一化成 Cookie 头再落库。
 *
 * 这一步必须放在保存侧而不是取链侧 —— 用户粘错的格式（cURL、Netscape 文件）
 * 也能保存成功，但取链时整串会被当成一个 Cookie，表现为「填了却播不了」，
 * 排查成本极高。保存时就识别并回显，问题当场就能看见。
 */
export function saveAccount(platform: string, rawCookie: string): SaveAccountResult {
  const p = getPlatform(platform)
  if (!p) return { success: false, error: `不支持的平台：${platform}` }

  const text = String(rawCookie ?? '').trim()
  if (!text) {
    // 空内容视为「清除该平台账号」，保持与原行为一致
    return store.setCookie(platform, '') as SaveAccountResult
  }

  const parsed = normalizeCookieInput(text)
  if (!parsed.ok) {
    return {
      success: false,
      error: '没有从内容里解析出任何 Cookie。请粘贴「网络」面板里的 Cookie 请求头，或直接选择导出的 cookie.txt 文件',
    }
  }

  const warnings: string[] = []
  const hasLogin = hasLoginKey(parsed.cookie, p.loginKeys)
  if (!hasLogin) {
    warnings.push(`未发现登录字段（应为 ${p.loginKeys.join(' / ')} 之一），可能只复制到游客 Cookie`)
  }
  // 登录判据命中、但「决定音质的那一个字段」缺失时单独提醒。
  // 这种情况最容易被忽略：状态显示已登录，实际权益一点没吃到（酷我锁 128k 就是这么来的）
  if (hasLogin && p.essentialKey && !hasLoginKey(parsed.cookie, [p.essentialKey])) {
    warnings.push(p.essentialHint || `缺少 ${p.essentialKey}，可能拿不到该账号的音质权益`)
  }
  // 只有 1 个 Cookie 基本不可能是正常登录态（网易云最少也要 MUSIC_U + __csrf），
  // 2~3 个就不再提示了 —— 各平台精简登录确实可能就只有两三个，报多了是噪音
  if (parsed.count === 1) {
    warnings.push('只解析出 1 个 Cookie，几乎肯定不完整，建议用浏览器扩展一键同步')
  }
  if (parsed.dropped.length) {
    warnings.push(`已自动丢弃 ${parsed.dropped.length} 个过期 Cookie`)
  }

  const res = store.setCookie(platform, parsed.cookie)

  // 留一条可追溯的日志：用户反馈「同步了但后台没有」时，
  // 看日志就能分清「没送到」还是「送到了但平台/字段不对」
  console.log(
    `[平台账号] 保存 ${platform}：识别为${formatLabel(parsed.format)}，${parsed.count} 个字段`
    + `（${parsed.keys.slice(0, 14).join(', ')}${parsed.keys.length > 14 ? ' …' : ''}），`
    + `${parsed.cookie.length} 字符`
    + (warnings.length ? `；提示：${warnings.join('；')}` : ''),
  )

  return {
    ...res,
    format: parsed.format,
    formatText: formatLabel(parsed.format),
    count: parsed.count,
    keys: parsed.keys.slice(0, 30),
    cookieLength: parsed.cookie.length,
    warnings,
    dropped: parsed.dropped,
  }
}

// ---- 账号健康巡检 ----
//
// 为什么要有巡检：Cookie 失效是静默的。用户配置当天看到过一次绿色「已登录」，
// 之后不会再去点校验；等它过期，表现是「某些歌突然只能试听」——看着像音源坏了。
// 定时复查能把「过期」这个事实提前摆到界面上，而不是等用户来报「播不了」。

/**
 * 巡检间隔（小时）：默认 72h，可用 MUSIC_ACCOUNT_CHECK_HOURS 覆盖，范围 1 小时 ~ 7 天。
 *
 * 默认值取 72 而不是更短，是因为每轮巡检都要拿 Cookie 去打各平台「需要登录态」的接口，
 * 打得太勤容易被平台风控盯上（反而把正常账号搞成异常）。Cookie 失效本身不是分钟级事件，
 * 三天一次足够在用户察觉「怎么只能试听了」之前把红标摆到界面上。
 */
function checkIntervalHours(): number {
  const n = Number(process.env.MUSIC_ACCOUNT_CHECK_HOURS)
  if (!Number.isFinite(n) || n <= 0) return 72
  return Math.max(1, Math.min(24 * 7, Math.round(n)))
}

/** 当前账号健康度汇总（只读，不发请求） */
export function getAccountHealth(): HealthSummary {
  return summarize(store.listAccounts())
}

/**
 * 立即巡检所有已配置账号。
 *
 * @param opts.force 为 true 时忽略总开关（手动触发用；总开关关掉时定时巡检会跳过）
 */
export async function runAccountHealthCheck(opts: { force?: boolean } = {}): Promise<
  HealthSummary & { checkedAt: number; checked: number }
> {
  const rows = store.listAccounts().filter(a => a.configured)
  const checkedAt = Date.now()

  if (!rows.length) return { ...getAccountHealth(), checkedAt, checked: 0 }
  if (!opts.force && !isEnabled()) {
    // 账号通道整体关着时不做无谓请求，但把现状照常报出去
    return { ...getAccountHealth(), checkedAt, checked: 0 }
  }

  for (const a of rows) {
    try {
      await verifyAccount(a.id)
    } catch (e: any) {
      console.log(`[平台账号] 巡检 ${a.name} 出错（忽略）：${e?.message || e}`)
    }
    // 平台之间留点间隔：几个平台连打容易被各自的风控当成扫描
    await new Promise(r => setTimeout(r, 800))
  }

  const summary = getAccountHealth()
  console.log(
    `[平台账号] 巡检完成：已配置 ${summary.configured} 个，正常 ${summary.healthy}`
    + `，失效 ${summary.expired}${summary.expiredNames.length ? `（${summary.expiredNames.join('、')}）` : ''}`
    + `，待复查 ${summary.stale}，未校验 ${summary.unchecked}，字段待确认 ${summary.structural}`,
  )
  return { ...summary, checkedAt, checked: rows.length }
}

let healthTimer: ReturnType<typeof setInterval> | null = null

/**
 * 启动定时巡检。默认启动后等 90 秒再跑第一次：
 * 启动瞬间音源巡检、会话恢复都在抢网络，别在这时候再加一堆外部请求。
 */
export function startAccountHealthCheck(): void {
  if (healthTimer) return
  const hours = checkIntervalHours()
  const boot = setTimeout(() => {
    void runAccountHealthCheck()
    healthTimer = setInterval(() => void runAccountHealthCheck(), hours * 3600_000)
    if (typeof healthTimer.unref === 'function') healthTimer.unref()
  }, 90_000)
  if (typeof boot.unref === 'function') boot.unref()
  console.log(`[平台账号] 账号巡检已安排：每 ${hours} 小时复查一次 Cookie 有效性（首次 90 秒后）`)
}

// ---- 供接口层使用的 store 再导出，避免 API 直接依赖内部文件 ----
export const getAccounts = store.listAccounts
export const removeAccount = store.removeCookie
export const getStoreFilePath = store.getStoreFilePath

// ---- 扫码登录（网易云 / QQ / 微信 / 酷狗） ----
export const qrLoginStart = qrLogin.start
export const qrLoginPoll = qrLogin.poll
export const qrLoginClose = qrLogin.close

// ---- 浏览器扩展包（一键同步 Cookie） ----
export { buildExtensionZip } from './extensionZip'
