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
import * as kglite from './resolvers/kglite'
import { PLATFORMS, isSupportedSource, getPlatform } from './platforms'
import { hasLoginKey, parseCookie } from './http'
import { normalizeCookieInput, formatLabel } from './cookieParse'
import * as store from './store'
import * as qrLogin from './qrLogin'
import { summarize } from './health'
import type { HealthSummary, AccountHealth } from './health'
import { isUserAllowed } from './permission'
import type { AccountResolveResult, AccountInfo, PlatformResolver } from './types'

export { PLATFORMS, getPlatform, isSupportedSource } from './platforms'
/** 概念版搜索直接复用 resolver 的实现（与取链同签名体系） */
export { kglite }
/** 取主账号 Cookie（搜索用，与取链同凭据） */
export const getCookie = store.getCookie
export type { AccountResolveResult, AccountInfo } from './types'

/** 平台 id → 解析器。新增平台时在这里补一行即可。 */
const RESOLVERS: Record<string, PlatformResolver> = {
  wy: netease,
  tx: qq,
  kw: kuwo,
  kg: kugou,
  kglite: kglite,
  mg: migu,
  bili: bilibili,
  soda: soda,
}

/**
 * 一个 source 可以走多个账号通道，按顺序尝试。
 *
 * 酷狗特例：概念版（kglite）与标准版（kg）是同一套曲库、两套登录态与两套取链协议。
 * 概念版能拿 OGG 320k 与 16/24bit 无损（标准版自定义源最高只有 320k 有损），
 * 所以放在前面优先尝试；失败再退回标准版账号，最后才交给自定义源。
 * 两个通道各自独立配置，互不影响。
 */
const CHANNEL_CHAIN: Record<string, string[]> = {
  kg: ['kglite', 'kg'],
}

/** 该 source 的账号通道尝试顺序 */
export function channelIdsFor(source: string): string[] {
  const chain = CHANNEL_CHAIN[source]
  return chain && chain.length ? chain : [source]
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
 *
 * 按通道链判断：酷狗配了概念版账号也算「有账号」，
 * 否则会出现「明明配了概念版却提示没账号」的误判。
 */
export function hasAccount(source: string): boolean {
  return channelIdsFor(source).some(id => store.hasAccount(id))
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
  opts: { allowPromote?: boolean } = {},
): Promise<AccountResolveResult | null> {
  if (!isEnabled()) return null
  if (!isSupportedSource(source)) return null

  const ids = channelIdsFor(source).filter(id => RESOLVERS[id] && store.getCookie(id))
  if (!ids.length) return null

  // 通道链上可能有多个平台，各分一份预算，避免第一个卡住把整首歌的取链预算吃干
  const total = timeoutMs()
  const perChannel = ids.length > 1 ? Math.max(5000, Math.floor(total / ids.length)) : total

  for (const id of ids) {
    const resolver = RESOLVERS[id]
    const cookie = store.getCookie(id)
    const name = getPlatform(id)?.name ?? id
    try {
      const result = await withDeadline(resolver.resolve(songInfo, quality, cookie), perChannel)
      if (result?.ok && result.url) {
        // 汽水特有：签名器通道（signer:*）才是「真的用上了账号」。
        // 命中 h5/seo 明文通道说明账号没起作用 —— 要么这首歌本来就免费，
        // 要么账号已经过期。交给 noteSodaAnonymousLink 统一判断并复核（30 分钟冷却）。
        if (id === 'soda') noteSodaAnonymousLink(result.via)
        console.log(`[平台账号] ✓ ${name} 取链成功（通道 ${result.via ?? '-'}，音质 ${result.quality ?? quality}${result.isVip ? '，会员' : ''}）`)
        // 让上层显示实际命中的平台（概念版 vs 标准版），而不是拿 source 反查
        return { ...result, accountName: name }
      }
      if (result?.error) {
        console.log(`[平台账号] ${name} 未取到链接：${result.error}`)
        probeAccountAfterFailure(id)
      }
    } catch (e: any) {
      const msg = e?.message || String(e)
      console.log(`[平台账号] ${name} 取链异常：${msg}`)
      probeAccountAfterFailure(id)
    }
  }

  // 所有通道都失败：若用户为该平台开了「主号失效自动切换」，再给自己一次机会。
  // 只在 allowPromote 时尝试，且内部有 10 分钟冷却 + 「先确认主号真的坏了」两道闸，
  // 避免唱到一首没版权的歌就把账号换掉（那会让后续播放整体漂移）。
  if (opts.allowPromote !== false) {
    let promoted = false
    for (const id of ids) {
      const res = await autoPromotePrimary(id)
      if (res.promoted) promoted = true
    }
    if (promoted) {
      return tryResolveByAccount(source, songInfo, quality, { allowPromote: false })
    }
  }
  return null
}

// ---- 主号失效自动切换 ----
//
// 为什么默认关：多账号之间来回漂移会让「同一首歌这次能播下次不能播」，排查成本极高。
// 所以只有用户给某个平台显式勾了「主号失效自动切换」才生效，且必须确认主号真的失效
// （调一次需登录接口），不能因为「这首歌没版权」就换号。

const lastPromoteAt = new Map<string, number>()
const PROMOTE_COOLDOWN_MS = 10 * 60 * 1000

export interface PromoteResult {
  promoted: boolean
  from?: string
  to?: string
}

export async function autoPromotePrimary(id: string): Promise<PromoteResult> {
  if (!store.isAutoSwitchEnabled(id)) return { promoted: false }
  if (!store.hasAccount(id)) return { promoted: false }

  const last = lastPromoteAt.get(id) ?? 0
  if (Date.now() - last < PROMOTE_COOLDOWN_MS) return { promoted: false }
  lastPromoteAt.set(id, Date.now())

  const items = store.listAccountItems(id)
  const primary = items.find(i => i.primary)
  if (!primary || items.length < 2) return { promoted: false }

  const name = getPlatform(id)?.name ?? id
  // 第一道闸：先确认主号是不是真的失效。主号正常还换号，属于把好号换掉。
  // 每次校验都给 6 秒上限 —— 这段跑在「取链失败」的路径上，不能让它把整首歌的等待时间拖长。
  const info = await withDeadline(verifyAccount(id, primary.id), 6000).catch(() => null)
  if (info?.ok) return { promoted: false }

  // 候选：已配置、没有明确坏掉（结构不对/已失效的不选），有 VIP 的排前面
  const candidates = items
    .filter(i => !i.primary && i.configured && i.health !== 'expired' && i.health !== 'structural')
    .sort((a, b) => {
      const vip = Number(!!b.lastVerify?.isVip) - Number(!!a.lastVerify?.isVip)
      if (vip) return vip
      return Number(b.health === 'ok') - Number(a.health === 'ok')
    })

  // 第二道闸：候选也必须现场验证通过才晋升，避免把另一个坏号扶正。
  // 最多试 2 个、每个 6 秒，避免「全平台都坏」时在这一步耗掉几十秒。
  for (const c of candidates.slice(0, 2)) {
    const ci = await withDeadline(verifyAccount(id, c.id), 6000).catch(() => null)
    if (!ci?.ok) continue
    const ok = store.setPrimaryAccount(id, c.id)
    if (!ok.success) return { promoted: false }
    // 会员缓存是按平台存的，换号后必须清掉，否则会拿旧号的 VIP 状态去判断音质
    vipCache.delete(id)
    console.log(`[平台账号] 自动切换｜${name}：主账号「${primary.label}」已失效，改用「${c.label}」`)
    return { promoted: true, from: primary.label, to: c.label }
  }
  console.log(`[平台账号] 自动切换｜${name}：主账号「${primary.label}」可能已失效，但没有可用的备号`)
  return { promoted: false }
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

/**
 * 记录一次「汽水这次没走账号签名器」的取链结果，并按需复核登录态。
 *
 * 为什么需要由外部（server.ts）回调进来：汽水的实际取链走的是 extraSources 分支 ——
 * `/api/music/url` 里 `extraSources.isExtraSource('soda')` 会先命中并直接返回，
 * **根本不会进入 tryResolveByAccount**。所以把复核写在那里等于死代码（v1.5.46 就是这样，
 * 实测停掉签名器走匿名通道时，日志里连一条 [平台账号] 汽水 记录都没有）。
 *
 * 现在改为：extraSources 把 `via` 透出 → server.ts 取链成功后调本函数。
 */
export function noteSodaAnonymousLink(via?: string): void {
  if (!isEnabled()) return
  const channel = String(via || '').trim()
  // 没有 via 说明不是汽水的通道信息（或老版本 resolver），不做判断
  if (!channel || channel.startsWith('signer')) return
  console.log(`[平台账号] 汽水本次命中匿名通道（${channel}），未用上账号签名器；已触发登录态复核（30 分钟内不重复）`)
  probeAccountAfterFailure('soda')
}

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

/**
 * 验证某平台账号：先做结构校验，再做（有把握的）在线校验。
 *
 * @param itemId 指定具体账号（多账号平台用）；省略时校验主账号
 */
export async function verifyAccount(id: string, itemId?: string): Promise<AccountInfo> {
  const resolver = RESOLVERS[id]
  const platform = getPlatform(id)
  if (!resolver || !platform) return { ok: false, message: `不支持的平台：${id}` }

  const cookie = itemId ? store.getCookieOf(id, itemId) : store.getCookie(id)
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

  // 会员缓存只记主账号的：它服务于「取链时判断能不能上无损」，多账号平台的副账号不参与取链
  if (!itemId && info.ok && typeof info.isVip === 'boolean') {
    vipCache.set(id, { at: Date.now(), isVip: info.isVip })
  }
  store.saveVerifyResult(id, {
    at: Date.now(),
    ok: info.ok,
    isVip: info.isVip,
    message: info.message,
    nickname: info.nickname,
    verified: info.verified ?? 'online',
  }, itemId)
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
  /** 落库后的账号 id（多账号界面用它定位） */
  itemId?: string
  /** 是否新建了账号（false = 覆盖已有账号） */
  created?: boolean
  /** 该平台当前账号总数 */
  total?: number
}

/**
 * 保存账号：先把用户粘进来的任意内容归一化成 Cookie 头再落库。
 *
 * 这一步必须放在保存侧而不是取链侧 —— 用户粘错的格式（cURL、Netscape 文件）
 * 也能保存成功，但取链时整串会被当成一个 Cookie，表现为「填了却播不了」，
 * 排查成本极高。保存时就识别并回显，问题当场就能看见。
 *
 * 多账号：
 *   默认行为仍然是「更新主账号」（老界面、浏览器扩展同步都按这个语义走）。
 *   只有显式传 `append: true`（界面上点「添加账号」）才会追加一个新账号，
 *   避免用户只是想换个 Cookie，结果列表里多出一堆重复条目。
 */
export function saveAccount(
  platform: string,
  rawCookie: string,
  opts: { itemId?: string; label?: string; primary?: boolean; append?: boolean } = {},
): SaveAccountResult {
  const p = getPlatform(platform)
  if (!p) return { success: false, error: `不支持的平台：${platform}` }

  const text = String(rawCookie ?? '').trim()
  if (!text) {
    // 指定了账号 → 只删这一个；否则保持老语义「清空该平台全部账号」
    if (opts.itemId) return store.removeAccountItem(platform, opts.itemId) as SaveAccountResult
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

  const res = opts.append || opts.itemId
    ? store.addCookie(platform, parsed.cookie, { itemId: opts.itemId, label: opts.label, primary: opts.primary })
    : store.setCookie(platform, parsed.cookie)

  // 老语义（只更新主账号）也允许顺手改备注：setCookie 不认 label，
  // 所以这里补一次改名。注意**不能**改成走 addCookie —— 那会把「换个 Cookie」
  // 变成「追加一个新账号」，用户重登一次就多出一个不参与取链的冷备号。
  if (!opts.append && !opts.itemId && opts.label) {
    const primary = store.listAccountItems(platform).find(i => i.primary)
    if (primary) store.renameAccount(platform, primary.id, opts.label)
  }

  // 留一条可追溯的日志：用户反馈「同步了但后台没有」时，
  // 看日志就能分清「没送到」还是「送到了但平台/字段不对」
  console.log(
    `[平台账号] 保存 ${platform}：识别为${formatLabel(parsed.format)}，${parsed.count} 个字段`
    + `（${parsed.keys.slice(0, 14).join(', ')}${parsed.keys.length > 14 ? ' …' : ''}），`
    + `${parsed.cookie.length} 字符`
    + (opts.append || opts.itemId ? `，${(res as any).created === false ? '更新已有账号' : '新增账号'}${opts.label ? `「${opts.label}」` : ''}（共 ${(res as any).total ?? '?'} 个）` : '')
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
  const n = Number(config()['musicAccount.checkHours'])
  if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(24 * 7, Math.round(n)))
  const env = Number(process.env.MUSIC_ACCOUNT_CHECK_HOURS)
  if (!Number.isFinite(env) || env <= 0) return 72
  return Math.max(1, Math.min(24 * 7, Math.round(env)))
}

/**
 * 巡检在每天的几点执行（0-23，默认 03:00）。
 *
 * 为什么改成「定点」而不是「固定间隔」：固定间隔会在启动后 72 小时整再跑，
 * 时间点跟着重启漂移；落到凌晨固定小时，既能和「领 VIP」等任务错峰，
 * 也不会在用户白天听歌时去打各家接口（风控最容易被触发的就是「边播边扫」）。
 */
function checkHourOfDay(): number {
  const n = Number(config()['musicAccount.checkHour'])
  if (!Number.isFinite(n)) return 3
  return Math.min(23, Math.max(0, Math.floor(n)))
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
  const rows = store.listAccounts().filter(a => a.configured || a.accounts.some(i => i.configured))
  const checkedAt = Date.now()

  if (!rows.length) return { ...getAccountHealth(), checkedAt, checked: 0 }
  if (!opts.force && !isEnabled()) {
    // 账号通道整体关着时不做无谓请求，但把现状照常报出去
    return { ...getAccountHealth(), checkedAt, checked: 0 }
  }

  // 逐账号巡检：多账号平台（酷狗概念版）每个号都要单独确认登录态，
  // 只查主账号会出现「主号绿着，副号早失效了却没人知道」。
  let checked = 0
  for (const a of rows) {
    const items = (a.accounts || []).filter(i => i.configured)
    if (!items.length) {
      try {
        await verifyAccount(a.id)
        checked++
      } catch (e: any) {
        console.log(`[平台账号] 巡检 ${a.name} 出错（忽略）：${e?.message || e}`)
      }
      await new Promise(r => setTimeout(r, 800))
      continue
    }
    for (const item of items) {
      try {
        await verifyAccount(a.id, item.id)
        checked++
      } catch (e: any) {
        console.log(`[平台账号] 巡检 ${a.name}（${item.label}）出错（忽略）：${e?.message || e}`)
      }
      // 平台之间留点间隔：几个平台连打容易被各自的风控当成扫描
      await new Promise(r => setTimeout(r, 800))
    }
  }

  const summary = getAccountHealth()
  console.log(
    `[平台账号] 巡检完成：已配置 ${summary.configured} 个，正常 ${summary.healthy}`
    + `，失效 ${summary.expired}${summary.expiredNames.length ? `（${summary.expiredNames.join('、')}）` : ''}`
    + `，待复查 ${summary.stale}，未校验 ${summary.unchecked}，字段待确认 ${summary.structural}`,
  )
  return { ...summary, checkedAt, checked }
}

let healthTimer: ReturnType<typeof setTimeout> | null = null
let healthNextRunAt = 0
let healthLastRunAt = 0

/**
 * 算出下一次巡检时间：下一个 checkHour 整点，且距上次巡检不少于 checkHours 小时。
 *
 * 单独导出便于单测：跨天与「间隔未到就顺延」这两处最容易算错，
 * 算错的表现是「再也不巡检了」或「每小时都在打接口」，都很难从界面看出来。
 */
export function nextHealthCheckAt(
  hour: number,
  intervalHours: number,
  lastRunAt: number,
  now = Date.now(),
): number {
  const h = Math.min(23, Math.max(0, Math.floor(Number.isFinite(hour) ? hour : 3)))
  const base = new Date(now)
  base.setHours(h, 0, 0, 0)
  let at = base.getTime()
  if (at <= now) at += 24 * 3600_000
  const earliest = lastRunAt > 0 ? lastRunAt + Math.max(1, intervalHours) * 3600_000 : 0
  // 间隔没到就一天一天往后推，直到既落在整点、又满足最小间隔
  let guard = 0
  while (at < earliest && guard++ < 400) at += 24 * 3600_000
  return at
}

/** 当前巡检排程状态（前端回填表单用） */
export function getHealthCheckState(): { intervalHours: number; hour: number; nextRunAt: number; lastRunAt: number } {
  return {
    intervalHours: checkIntervalHours(),
    hour: checkHourOfDay(),
    nextRunAt: healthNextRunAt,
    lastRunAt: healthLastRunAt,
  }
}

function scheduleHealthCheck(): void {
  if (healthTimer) {
    clearTimeout(healthTimer)
    healthTimer = null
  }
  const at = nextHealthCheckAt(checkHourOfDay(), checkIntervalHours(), healthLastRunAt)
  healthNextRunAt = at
  const timer = setTimeout(() => {
    healthTimer = null
    healthNextRunAt = 0
    void runAccountHealthCheck()
      .catch(e => console.log(`[平台账号] 巡检出错（忽略）：${e?.message || e}`))
      .finally(() => {
        healthLastRunAt = Date.now()
        scheduleHealthCheck()
      })
  }, Math.max(1000, at - Date.now()))
  if (typeof timer.unref === 'function') timer.unref()
  healthTimer = timer

  const when = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  console.log(
    `[平台账号] 账号巡检已排程：每天 ${pad(checkHourOfDay())}:00 检查一次，`
    + `且距上次不少于 ${checkIntervalHours()} 小时；`
    + `下一轮 ${when.getMonth() + 1}/${when.getDate()} ${pad(when.getHours())}:${pad(when.getMinutes())}`,
  )
}

/** 配置改动（巡检间隔/时间点）后重排定时器，不必重启进程 */
export function rescheduleAccountHealthCheck(): void {
  if (!healthTimer) return
  scheduleHealthCheck()
}

/**
 * 启动定时巡检。默认启动后等 90 秒再跑第一次：
 * 启动瞬间音源巡检、会话恢复都在抢网络，别在这时候再加一堆外部请求。
 */
export function startAccountHealthCheck(): void {
  if (healthTimer) return
  const boot = setTimeout(() => {
    void runAccountHealthCheck()
      .catch(e => console.log(`[平台账号] 启动巡检出错（忽略）：${e?.message || e}`))
      .finally(() => {
        healthLastRunAt = Date.now()
        scheduleHealthCheck()
      })
  }, 90_000)
  if (typeof boot.unref === 'function') boot.unref()
  console.log(
    `[平台账号] 账号巡检已安排：启动 90 秒后先查一次，之后每天 ${String(checkHourOfDay()).padStart(2, '0')}:00 起`
    + `按不少于 ${checkIntervalHours()} 小时的间隔复查`,
  )
}

// ---- 供接口层使用的 store 再导出，避免 API 直接依赖内部文件 ----
export const getAccounts = store.listAccounts
export const removeAccount = store.removeCookie
export const removeAccountItem = store.removeAccountItem
export const setPrimaryAccount = store.setPrimaryAccount
export const getStoreFilePath = store.getStoreFilePath
export const renameAccount = store.renameAccount
export const setAutoSwitchEnabled = store.setAutoSwitchEnabled
export const isAutoSwitchEnabled = store.isAutoSwitchEnabled

// ---- 换源能力探测 / 播放端失效提示 ----
//
// 跨平台换源是**前端**在决策（public/music/app.js），但「这个用户到底能不能用账号」
// 只有后端知道（总开关、是否配了号、是否在白名单里）。所以这里提供一个纯读接口，
// 前端据此动态决定汽水/酷狗概念版要不要进候选池。
//
// 安全边界：只回布尔值，绝不带 Cookie、昵称等任何账号内容。

/**
 * 匿名（不登录）也能拿到可播直链的源。
 *   soda  ：h5/seo 明文通道，非版权曲给整曲、版权曲只给 60 秒；
 *   bili  ：视频音轨，公开可播（但有 412 风控）；
 *   kglite：纯账号源（概念版 App token），没账号必然取不到链。
 */
const ANONYMOUS_CAPABLE: Record<string, boolean> = {
  soda: true,
  bili: true,
  kglite: false,
}

export interface SourceCapability {
  /** 此刻能否走「自己的账号」取链（总开关 + 平台受支持 + 已配账号 + 该用户在白名单内） */
  account: boolean
  /** 是否匿名也能取到链（无需账号） */
  anonymous: boolean
}

export function getSourceCapabilities(username?: string): Record<string, SourceCapability> {
  const allowed = isUserAllowed(username)
  const enabled = isEnabled()
  const out: Record<string, SourceCapability> = {}
  for (const p of PLATFORMS) {
    let account = false
    try {
      account = enabled && allowed && isSupportedSource(p.id) && hasAccount(p.id)
    } catch {
      account = false
    }
    out[p.id] = { account, anonymous: ANONYMOUS_CAPABLE[p.id] === true }
  }
  return out
}

export interface AccountHint {
  platform: string
  name: string
  health: AccountHealth
  text: string
}

/**
 * 播放端要主动提示的账号问题。
 * 只挑「已失效」——待复查/未校验属于提醒，不该在播放时打断用户；
 * 失效则是「正在掉音质」的确定事实，值得弹一次。
 */
export function getAccountHints(): AccountHint[] {
  return store.listAccounts()
    .filter(r => r.configured && r.health === 'expired')
    .map(r => ({
      platform: r.id,
      name: r.name,
      health: r.health,
      text: `${r.name}账号已失效，高音质会退回试听或匿名通道，请到后台「平台账号」重新登录或更新 Cookie`,
    }))
}

// ---- 扫码登录（网易云 / QQ / 微信 / 酷狗 / 酷狗概念版） ----
export const qrLoginStart = qrLogin.start
export const qrLoginPoll = qrLogin.poll
export const qrLoginClose = qrLogin.close

// ---- 手机验证码登录（酷狗概念版） ----
export const qrLoginSendSms = qrLogin.sendSms
export const qrLoginLoginSms = qrLogin.loginSms

// ---- 酷狗概念版：VIP 领取（多账号） ----
//
// 概念版是唯一需要「一个平台挂多个号」的场景：每个号每天看广告能领 8×3 小时会员，
// 多开几个号能把会员时长叠起来、也更耐得住某个号被风控。所以这里的语义是：
//   · 取链只走**主账号**（store.getCookie 的定义），避免多号之间来回漂移导致播放失败；
//   · 领 VIP 走**所有账号**，账号之间错峰，一个号失败不影响其他号。

/** 单个账号的会员状态（前端按账号逐行展示） */
export interface LiteAccountVip {
  id: string
  label: string
  primary: boolean
  ok: boolean
  isVip: boolean
  expireAt: number
  remainHours: number
  error?: string
}

/** 概念版状态汇总：主账号字段与旧版一致，另附每个账号的明细与自动领取配置 */
export type KugouLiteVipState = kglite.LiteVipInfo & {
  configured: boolean
  accounts: LiteAccountVip[]
  /** 以下为自动领取配置的生效值，前端表单直接回填 */
  autoClaim: boolean
  startHour: number
  gapSeconds: number
  minRemainHours: number
  /** 下一轮自动领取的时间戳（毫秒），没有排程时为 0 */
  nextRunAt: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 概念版账号列表，主账号排在最前面（界面与日志都按这个顺序看） */
function liteAccounts(): Array<{ id: string; label: string; primary: boolean; cookie: string }> {
  const list = store.getCookies('kglite')
  return [...list].sort((a, b) => Number(b.primary) - Number(a.primary))
}

function findLiteAccount(itemId?: string) {
  const list = liteAccounts()
  if (!list.length) return undefined
  if (!itemId) return list[0] // 已按主账号优先排序
  return list.find(a => a.id === itemId)
}

const vipInflight = new Set<string>()

/**
 * 立即给某个账号领一次概念版 VIP（听歌 + 看广告）。
 * @param itemId 指定账号；省略时用主账号
 */
export async function claimKugouLiteVip(itemId?: string): Promise<kglite.ClaimVipResult> {
  const acct = findLiteAccount(itemId)
  if (!acct) {
    return { ok: false, gainedHours: 0, steps: [], error: '尚未配置酷狗概念版账号，请先扫码或短信登录' }
  }
  // 防连点：界面上的按钮很容易被按两下，连发会把当日额度白白吃掉。
  // 按账号加锁，A 号在领的时候手动去领 B 号不该被挡。
  if (vipInflight.has(acct.id)) {
    return { ok: false, gainedHours: 0, steps: [], error: `${acct.label} 的上次领取还在进行中，请稍候` }
  }
  vipInflight.add(acct.id)
  try {
    const res = await kglite.claimVip(acct.cookie)
    await refreshKugouLiteStatus(acct.cookie, acct.primary ? undefined : acct.id)
    return res
  } finally {
    vipInflight.delete(acct.id)
  }
}

/** 查所有账号的会员信息（供接口直接展示剩余时长） */
export async function getKugouLiteVip(): Promise<KugouLiteVipState> {
  const cfg = liteAutoClaimConfig()
  const list = liteAccounts()
  const base = {
    configured: list.length > 0,
    autoClaim: cfg.autoClaim,
    startHour: cfg.startHour,
    gapSeconds: cfg.gapSeconds,
    minRemainHours: cfg.minRemainHours,
    nextRunAt: vipNextRunAt,
  }
  if (!list.length) {
    return { ok: false, isVip: false, expireAt: 0, remainHours: 0, error: '尚未配置账号', ...base, accounts: [] }
  }

  const accounts: LiteAccountVip[] = []
  for (const a of list) {
    const info = await kglite.getVipInfo(a.cookie)
    accounts.push({
      id: a.id,
      label: a.label,
      primary: a.primary,
      ok: info.ok,
      isVip: info.isVip,
      expireAt: info.expireAt,
      remainHours: info.remainHours,
      error: info.error,
    })
  }
  const main = accounts[0]
  return {
    ok: main.ok,
    isVip: main.isVip,
    expireAt: main.expireAt,
    remainHours: main.remainHours,
    error: main.ok ? undefined : main.error,
    ...base,
    accounts,
  }
}

/** 把最新会员状态写进缓存与校验记录，界面刷新后立刻能看到 */
async function refreshKugouLiteStatus(cookie: string, itemId?: string): Promise<void> {
  try {
    const info = await kglite.getAccountInfo(cookie)
    if (!itemId && info.ok && typeof info.isVip === 'boolean') {
      vipCache.set('kglite', { at: Date.now(), isVip: info.isVip })
    }
    store.saveVerifyResult('kglite', {
      at: Date.now(),
      ok: info.ok,
      isVip: info.isVip,
      message: info.message,
      nickname: info.nickname,
      verified: info.verified ?? 'online',
    }, itemId)
  } catch (e: any) {
    console.log(`[平台账号] 刷新酷狗概念版状态失败（忽略）：${e?.message || e}`)
  }
}

// ---- 酷狗概念版：每日自动领取（多账号 · 自定义开始时间 · 错峰） ----
//
// 为什么不做「到点就把额度领满」：一次领取给 3 小时，每天 8 次额度刚好覆盖 24 小时，
// 领满会让到期时间一路累加到几个月后——用户看到「VIP 到 2027 年」只会怀疑是不是出错了，
// 而且一旦平台调整规则，攒下的天数未必作数。所以按需续期：剩余不足一天才补，
// 既不断档，也把额度留在真正要紧的时候。
//
// 排程方式：不是「固定间隔的 setInterval」，而是每轮结束后按「开始时间 + 3 小时 × N」
// 重算下一次。这样进程重启也不会漂移，用户把开始时间从 6 点改到 22 点就真的 22 点跑。

/** 每天从开始时间起跑几轮 */
const AUTO_CLAIM_ROUNDS = 8
/** 轮与轮之间隔几小时（8 轮 × 3 小时 = 覆盖全天） */
const AUTO_CLAIM_ROUND_GAP_HOURS = 3

/** 读到一份「钳过范围」的自动领取配置，防止手改配置文件把定时器打死 */
function liteAutoClaimConfig(): { autoClaim: boolean; startHour: number; gapSeconds: number; minRemainHours: number } {
  const c = config()
  const num = (key: string, def: number, min: number, max: number) => {
    const v = Number(c[key])
    if (!Number.isFinite(v)) return def
    return Math.min(max, Math.max(min, Math.floor(v)))
  }
  return {
    autoClaim: c['musicAccount.kglite.autoClaim'] !== false,
    startHour: num('musicAccount.kglite.startHour', 6, 0, 23),
    gapSeconds: num('musicAccount.kglite.gapSeconds', 60, 0, 600),
    minRemainHours: num('musicAccount.kglite.minRemainHours', 24, 1, 24 * 30),
  }
}

let vipTimer: ReturnType<typeof setTimeout> | null = null
let vipNextRunAt = 0

/**
 * 算出下一次该跑的时间（毫秒时间戳）。
 *
 * 每天的轮次是「startHour 起每 3 小时一轮、共 8 轮」，8×3=24 小时正好铺满一天，
 * 所以跨过 0 点之后还有 00:00 / 03:00 这种「属于上一天周期」的轮次 —— 计算时必须
 * 把昨天、今天、明天三个周期的刻度一起算进去取最小值，否则进程如果在凌晨重启，
 * 03:00 那一轮会被整轮跳过，会员就可能断档。
 *
 * 单独导出是为了能写单测：时区与跨天边界最容易错，而错了只会表现为「会员莫名其妙到期」。
 */
export function nextAutoClaimAt(startHour: number, now = Date.now()): number {
  const hour = Math.min(23, Math.max(0, Math.floor(Number.isFinite(startHour) ? startHour : 6)))
  const stepMs = AUTO_CLAIM_ROUND_GAP_HOURS * 3600_000
  let next = Number.POSITIVE_INFINITY
  for (let dayOffset = -1; dayOffset <= 1; dayOffset++) {
    const base = new Date(now)
    base.setDate(base.getDate() + dayOffset)
    base.setHours(hour, 0, 0, 0)
    for (let k = 0; k < AUTO_CLAIM_ROUNDS; k++) {
      const t = base.getTime() + k * stepMs
      if (t > now && t < next) next = t
    }
  }
  // 正常不会走到这里（三个周期足以覆盖前后各一天），留个安全值免得定时器变成 0 延迟狂转
  return Number.isFinite(next) ? next : now + stepMs
}

export interface LiteAutoClaimAccount {
  id: string
  label: string
  primary: boolean
  skipped: boolean
  reason?: string
  gainedHours?: number
  remainHours?: number
  error?: string
}

export interface LiteAutoClaimRound {
  startedAt: number
  /** 整轮没跑的原因（总开关关 / 自动领取关 / 没账号） */
  halted?: string
  accounts: LiteAutoClaimAccount[]
}

/**
 * 跑一轮自动补领：逐个账号判定剩余时长，够用就跳过，不够就领。
 *
 * @param opts.force 忽略「剩余时长阈值」，无条件给每个账号领一次（手动「全部领取」用）
 */
export async function runKugouLiteAutoClaim(opts: { force?: boolean } = {}): Promise<LiteAutoClaimRound> {
  const startedAt = Date.now()
  // 总开关只管「账号通道要不要参与取链」，不该拦住用户手动点的「全部领取」；
  // 定时任务（非 force）才需要跟着总开关走。
  if (!isEnabled() && !opts.force) return { startedAt, halted: '账号通道总开关未开启', accounts: [] }
  const cfg = liteAutoClaimConfig()
  if (!cfg.autoClaim && !opts.force) return { startedAt, halted: '自动领取已关闭', accounts: [] }

  const list = liteAccounts()
  if (!list.length) return { startedAt, halted: '未配置酷狗概念版账号', accounts: [] }

  const accounts: LiteAutoClaimAccount[] = []
  for (let i = 0; i < list.length; i++) {
    const acct = list[i]
    // 账号之间错峰：多个号连着打同一个接口，很容易被平台按设备/网络维度风控
    if (i > 0 && cfg.gapSeconds > 0) await sleep(cfg.gapSeconds * 1000)

    const vip = await kglite.getVipInfo(acct.cookie)
    if (!vip.ok) {
      // 查不到会员状态时不动手：盲领可能把额度浪费在已经垫了很多天的情况下
      console.log(`[平台账号] 概念版自动补领｜${acct.label}：会员状态查询失败，本轮跳过（${vip.error || '未知原因'}）`)
      accounts.push({ id: acct.id, label: acct.label, primary: acct.primary, skipped: true, reason: `会员信息查询失败：${vip.error || '未知原因'}` })
      continue
    }
    if (!opts.force && vip.remainHours >= cfg.minRemainHours) {
      // 跳过也要留一行：否则定时器到底有没有在跑，只能靠猜
      console.log(`[平台账号] 概念版自动补领｜${acct.label}：剩余 ${vip.remainHours} 小时（≥${cfg.minRemainHours}），本轮跳过`)
      accounts.push({ id: acct.id, label: acct.label, primary: acct.primary, skipped: true, reason: `剩余 ${vip.remainHours} 小时，暂不需要补领` })
      continue
    }

    const res = await claimKugouLiteVip(acct.id)
    console.log(
      `[平台账号] 概念版自动补领｜${acct.label}（领取前剩余 ${vip.remainHours} 小时）：`
      + `${res.ok ? `获得 ${res.gainedHours} 小时` : '未获得'}`
      + `${res.remainHours !== undefined ? `，现剩余 ${res.remainHours} 小时` : ''}`
      + `${res.ok ? '' : `（${res.error || ''}）`}`,
    )
    accounts.push({
      id: acct.id,
      label: acct.label,
      primary: acct.primary,
      skipped: false,
      gainedHours: res.gainedHours,
      remainHours: res.remainHours,
      error: res.ok ? undefined : res.error,
    })
  }

  const gained = accounts.reduce((sum, a) => sum + (a.gainedHours || 0), 0)
  console.log(`[平台账号] 概念版自动补领本轮结束：${accounts.filter(a => !a.skipped).length} 个账号执行领取，合计 ${gained} 小时`)
  return { startedAt, accounts }
}

/** 按「开始时间 + 3 小时」重算并挂上下一次定时器 */
function scheduleNextAutoClaim(): void {
  if (vipTimer) return
  const cfg = liteAutoClaimConfig()
  if (!cfg.autoClaim) {
    vipNextRunAt = 0
    console.log('[平台账号] 酷狗概念版 VIP 自动领取处于关闭状态（后台开启后会自动排程，无需重启）')
    return
  }
  const at = nextAutoClaimAt(cfg.startHour)
  vipNextRunAt = at
  const delay = Math.max(1000, at - Date.now())
  const timer = setTimeout(() => {
    vipTimer = null
    vipNextRunAt = 0
    void runKugouLiteAutoClaim()
      .catch(e => console.log(`[平台账号] 概念版自动领取出错（忽略）：${e?.message || e}`))
      .finally(() => scheduleNextAutoClaim())
  }, delay)
  if (typeof timer.unref === 'function') timer.unref()
  vipTimer = timer

  const pad = (n: number) => String(n).padStart(2, '0')
  const when = new Date(at)
  console.log(
    `[平台账号] 酷狗概念版 VIP 自动领取已排程：每天 ${pad(cfg.startHour)}:00 起，每 ${AUTO_CLAIM_ROUND_GAP_HOURS} 小时一轮（共 ${AUTO_CLAIM_ROUNDS} 轮）；`
    + `剩余不足 ${cfg.minRemainHours} 小时才领，账号间隔 ${cfg.gapSeconds} 秒；`
    + `下一轮 ${when.getMonth() + 1}/${when.getDate()} ${pad(when.getHours())}:${pad(when.getMinutes())}`,
  )
}

/** 启动概念版 VIP 自动领取（按开始时间排第一轮） */
export function startKugouLiteVipAutoClaim(): void {
  scheduleNextAutoClaim()
}

/** 配置改动（开始时间 / 开关 / 间隔）后重排定时器，不必重启进程 */
export function rescheduleKugouLiteVipAutoClaim(): void {
  if (vipTimer) {
    clearTimeout(vipTimer)
    vipTimer = null
  }
  vipNextRunAt = 0
  scheduleNextAutoClaim()
}

// ---- 浏览器扩展包（一键同步 Cookie） ----
export { buildExtensionZip } from './extensionZip'
