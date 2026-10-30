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
import { extractAccountIdentity } from './identity'
import * as qrLogin from './qrLogin'
import { summarize, isSnapshotFromOtherVersion } from './health'
import type { HealthSummary, AccountHealth } from './health'
import { getAppVersion } from '../../utils/version'
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
 * 定时巡检开关（默认开）。
 *
 * 用户 2026-10-30 明确：账号每天被自动探测太频繁，希望能自己决定要不要自动巡检。
 * 关掉后**启动首查与定时巡检都不跑**，失效发现只剩两条路：
 *   ① 取链失败时的当场单账号复核（probeAccountAfterFailure）
 *   ② 面板上的手动「立即检查」
 * 手动检查走 force，不受这个开关影响 —— 用户点了按钮就应该真的去查。
 */
export function isHealthCheckEnabled(): boolean {
  return config()['musicAccount.healthCheckEnabled'] !== false
}

/** 是否有一轮巡检正在跑（前端据此轮询刷新，而不是干等一个长连接） */
let healthRunning = false

export function isHealthChecking(): boolean {
  return healthRunning
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
        // 取链过程中平台续了新证（咪咕 pacmtoken）：立刻写回主账号，下次播放就不用再换票
        if (result.refreshedCookie) {
          store.setCookie(id, result.refreshedCookie)
        }
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
      if (info.ok) {
        // 登录态是好的 —— 那是「非会员」还是「这首没版权」？只能如实区分到这一步：
        // 会员状态明确为 false 时给一条「非会员」提示（不进失效红标、不触发自动换号），
        // 否则什么也不说（一首没版权的歌不该留下任何账号痕迹）。
        if (info.isVip === false) {
          notVipHintAt.set(id, Date.now())
          console.log(`[平台账号] ${name} 取链失败，但登录态正常且为非会员 —— 按「会员权益不足」提示，不标失效、不换号`)
        }
        return
      }
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
  // 平台在校验过程中顺带续了新证（目前只有咪咕 pacmtoken）：必须立刻落库，
  // 否则这次续期等于白续 —— 下次请求还在用旧票，3 小时后照样失效。
  if (info.refreshedCookie && info.refreshedCookie !== cookie) {
    if (itemId) store.addCookie(id, info.refreshedCookie, { itemId })
    else store.setCookie(id, info.refreshedCookie)
    console.log(`[平台账号] ${platform.name} 短期凭证已自动续期并写回（${platform.name}账号「${itemId || '主账号'}」）`)
  }
  // 平台顺带把「这是哪个号」也答了（咪咕 queryUserInfo 的 userId）：
  // 老数据 / 浏览器 Cookie 存的号本来没有 uid，认过一次就落库，
  // 下次一键同步才能按号认领，而不是又变成「认不出 → 覆盖主账号」。
  if (info.ok && info.uid) {
    if (store.setAccountUid(id, itemId, info.uid)) {
      console.log(`[平台账号] ${platform.name}账号「${itemId || '主账号'}」已补记身份 uid（以后一键同步能按号认领）`)
    }
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
  /** 命中已有账号的依据（uid 同号 / 同一份 Cookie），用于界面提示「已更新」 */
  matchedBy?: 'itemId' | 'uid' | 'cookie'
  /** 落库方式：updated 更新已有账号 / created 新增账号（冷备） / replaced 覆盖主账号 */
  action?: SaveAccountAction
  /** 一句给用户看的结论（插件、后台提示直接显示） */
  message?: string
}

export type SaveAccountAction = 'updated' | 'created' | 'replaced'

const ACTION_LOG: Record<SaveAccountAction, string> = {
  updated: '更新已有账号',
  created: '新增账号（默认不抢主账号）',
  replaced: '覆盖主账号',
}

function actionMessage(
  action: SaveAccountAction,
  label: string | undefined,
  total: number | undefined,
  becamePrimary: boolean,
): string {
  if (action === 'updated') return `已更新已有账号「${label || '主账号'}」的 Cookie`
  if (action === 'created') {
    // 第一个号（或显式设为主账号）会成为主账号，这时不能说成「冷备」，否则用户以为没生效
    if (becamePrimary) return '已保存为该平台主账号的 Cookie'
    return `识别为一个新账号，已追加为冷备（共 ${total ?? 1} 个）；要用它取链请到后台点「设为主账号」`
  }
  return '已更新主账号的 Cookie'
}

// ---- 账号身份识别 ----
// 实现放在 identity.ts（qrLogin 也要用，放在这里会形成循环依赖），这里只做透传。
export { extractAccountIdentity } from './identity'
export type { AccountIdentity } from './identity'

/** 保存链路问平台要账号身份的预算：用户正在界面上等结果，不能为了认号把人卡住 */
const REMOTE_UID_TIMEOUT_MS = 6000
/** 顺手确认「没有身份的老条目」用的预算：纯迁移路径，值不值得多等这几秒要掂量 */
const ORPHAN_UID_TIMEOUT_MS = 3000

/**
 * 问平台「这份 Cookie 是哪个号」，取不到返回空串。
 *
 * 只有实现了 `resolveUid` 的 resolver 才会真发请求（目前只有咪咕）。
 * 不抛错 —— 认号是**优化**，不是保存的硬前置；失败由调用方决定怎么兜底。
 */
async function probeUid(platform: string, cookie: string, ms: number): Promise<string> {
  const fn = RESOLVERS[platform]?.resolveUid
  if (!fn) return ''
  try {
    return String(await withDeadline(fn(cookie), ms) || '').trim()
  } catch (e: any) {
    console.log(`[平台账号] ${getPlatform(platform)?.name ?? platform}：账号身份查询失败（${e?.message || e}）`)
    return ''
  }
}

/** 日志里露一半：uid 是账号标识，不是凭据，但没必要整串上日志 */
function maskUid(uid: string): string {
  return uid.length <= 8 ? uid : `${uid.slice(0, 4)}…${uid.slice(-4)}`
}

/**
 * 保存账号：先把用户粘进来的任意内容归一化成 Cookie 头再落库。
 *
 * 这一步必须放在保存侧而不是取链侧 —— 用户粘错的格式（cURL、Netscape 文件）
 * 也能保存成功，但取链时整串会被当成一个 Cookie，表现为「填了却播不了」，
 * 排查成本极高。保存时就识别并回显，问题当场就能看见。
 *
 * 多账号（2026-10-29 起改为自动认号）：
 *   不传 itemId / append 时，按 Cookie 里的稳定 uid 判断「这是不是存过的号」：
 *   同号更新那一条，新号追加为冷备（不抢主账号），平台没有稳定 uid 才覆盖主账号。
 *   显式传 `append: true`（界面「添加账号」）或 `itemId`（编辑某一条）时按调用方说的做。
 *   这样插件一键同步不用再问用户「要不要追加」，也不会一推就把主号覆盖掉。
 *
 * 2026-10-30 补：**「Cookie 里没有稳定 uid」不等于「平台认不出号」**。
 * 咪咕浏览器登录的 Cookie 只有会话字段（idmpauth / pacmtoken / migu-utoken-sessionid），
 * 没有 userid，于是老逻辑一律走 setCookie 覆盖主账号 —— 用户就踩到了这个数据损失。
 * 现在改为先问一次平台（resolver.resolveUid），问到 userId 就正常认号。
 */
export async function saveAccount(
  platform: string,
  rawCookie: string,
  opts: { itemId?: string; label?: string; primary?: boolean; append?: boolean } = {},
): Promise<SaveAccountResult> {
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

  // 自动认号（2026-10-29）：
  // 以前「插件推上来的是新号还是旧号」要用户自己勾「追加为新账号」，
  // 勾了怕多出账号、不勾怕覆盖主号。现在把这个判断交给 Cookie 本身：
  //   1. Cookie 里的稳定 uid / 指纹命中已有条目 → 只更新那一条（重推同一个号，列表不变长）
  //   2. 有稳定 uid 但没命中 = 没见过的号 → 追加为冷备，不动主账号
  //   3. Cookie 里没有稳定 uid 时**先问平台**（咪咕：queryUserInfo 的 userId），
  //      问到了就按第 1/2 条走；真问不出来才算「认不出」——
  //      此时若已有账号就拒收（否则覆盖主账号等于拿坏 Cookie 换掉好号），一个号都没有才照老语义存
  // 显式传 itemId / append 时仍按调用方说的做（后台「添加账号」「编辑账号」走这条）。
  const forcedItem = !!(opts.append || opts.itemId)
  const ident = extractAccountIdentity(platform, parsed.cookie)
  // 平台能不能「问出这是哪个号」—— 能问的平台才有后面那套保护
  const canIdentify = !!RESOLVERS[platform]?.resolveUid
  // Cookie 里没有稳定 uid 时，先问一次平台「这是哪个号」。
  // 这一步是「覆盖主账号」这个老问题的正解：认不出号才会走 setCookie，
  // 而 setCookie 会直接改写主账号的 Cookie —— 推一个别的号上来就是数据损失。
  let uidFromPlatform = ''
  if (!ident.uid && canIdentify) {
    uidFromPlatform = await probeUid(platform, parsed.cookie, REMOTE_UID_TIMEOUT_MS)
    if (uidFromPlatform) {
      ident.uid = uidFromPlatform
      console.log(`[平台账号] ${p.name}：Cookie 里没有稳定 uid，已向平台确认账号身份（${maskUid(uidFromPlatform)}）`)
    }
  }
  let matched = forcedItem ? null : store.findItemByIdentity(platform, ident)
  // 认出了号、但列表里没有 → 回头确认一次「没有身份记录的老条目」（最多 1 条，优先主账号）。
  // 不补这一步的后果：咪咕主账号本来就是用浏览器 Cookie 存的（没有 userid），
  // 再同步同一个号时按 uid 找不到人，就会平白多出一个一模一样的冷备号。
  if (!matched && !forcedItem && ident.uid) {
    const orphans = store.getCookies(platform).filter(c => !c.uid)
    const orphan = orphans.find(c => c.primary) || orphans[0]
    if (orphan) {
      const uid = await probeUid(platform, orphan.cookie, ORPHAN_UID_TIMEOUT_MS)
      if (uid && uid === ident.uid) {
        matched = { id: orphan.id, label: orphan.label, primary: orphan.primary }
        console.log(`[平台账号] ${p.name}：老条目「${orphan.label}」原来没有身份记录，已确认是同一个号，按更新处理`)
      }
    }
  }
  // 认不出号 + 没匹配 = 下一步必然走 setCookie 覆盖主账号。
  // 对能问出身份的平台，这基本意味着 Cookie 已失效（咪咕票过期就回 299999），
  // 拿一份坏 Cookie 换掉手上的号不划算：宁可拒收，让用户重新登录。
  // 平台一个号都没有时不拦 —— 没有可保护的对象，先存下来再说。
  if (!forcedItem && !matched && !ident.uid && canIdentify && store.listAccountItems(platform).length > 0) {
    console.log(`[平台账号] 保存 ${platform} 被拒：无法确认账号身份，为避免覆盖主账号`)
    return {
      success: false,
      error: `无法确认这份 Cookie 属于哪个号（${p.name}接口没有返回用户信息，通常是登录凭证已过期）。`
        + '为避免覆盖主账号，本次没有保存：请重新登录后再同步；如果确认这是另一个号，可以用「添加账号」显式追加',
    }
  }
  const res = forcedItem
    ? store.addCookie(platform, parsed.cookie, { itemId: opts.itemId, label: opts.label, primary: opts.primary, ...ident })
    : matched
      ? store.addCookie(platform, parsed.cookie, { itemId: matched.id, label: opts.label, primary: opts.primary, ...ident })
      : ident.uid
        ? store.addCookie(platform, parsed.cookie, { label: opts.label, primary: opts.primary, ...ident })
        : store.setCookie(platform, parsed.cookie, ident)

  const action: SaveAccountAction = (forcedItem || matched)
    ? ((res as any).created === false ? 'updated' : 'created')
    : (ident.uid ? 'created' : 'replaced')

  // 这次落库的条目是不是主账号（第一次存某个平台时就是它，界面文案要跟着变）
  // setCookie 不返回 total，统一在这里补齐，前端提示「共 N 个」才不会是空的
  const savedItems = store.listAccountItems(platform)
  if ((res as any).total === undefined) (res as any).total = savedItems.length
  const savedItemId = String((res as any).itemId || '')
  const becamePrimary = savedItemId
    ? !!savedItems.find(i => i.id === savedItemId && i.primary)
    : false

  // 覆盖主账号时 setCookie 不认 label，补一次改名；
  // 其余分支的 label 已经在 addCookie 里落库了。
  if (action === 'replaced' && opts.label) {
    const primary = store.listAccountItems(platform).find(i => i.primary)
    if (primary) store.renameAccount(platform, primary.id, opts.label)
  }

  // 留一条可追溯的日志：用户反馈「同步了但后台没有」时，
  // 看日志就能分清「没送到」还是「送到了但平台/字段不对」
  console.log(
    `[平台账号] 保存 ${platform}：识别为${formatLabel(parsed.format)}，${parsed.count} 个字段`
    + `（${parsed.keys.slice(0, 14).join(', ')}${parsed.keys.length > 14 ? ' …' : ''}），`
    + `${parsed.cookie.length} 字符`
    + `，${ACTION_LOG[action]}`
    + (uidFromPlatform ? '，账号身份取自平台接口（Cookie 里没有 userid）' : '')
    + ((res as any).total !== undefined ? `（共 ${(res as any).total} 个账号）` : '')
    + (matched ? `，命中${matched.primary ? '主账号' : '已有账号'}「${matched.label}」` : '')
    + (warnings.length ? `；提示：${warnings.join('；')}` : ''),
  )

  return {
    ...res,
    action,
    message: actionMessage(action, matched?.label, (res as any).total, becamePrimary),
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
 * 巡检两个账号之间的等待。
 *
 * 三种节奏，按「谁在等结果」区分：
 *   - 定时/启动巡检：10~120 秒随机。用户 2026-10-30 明确要求放宽到这一档（原 1~60 秒），
 *     理由是巡检本来就是低频兜底，没必要把请求打得那么密。一轮十几个号约 5~20 分钟，
 *     凌晨跑完没人感知。
 *   - 手动复查：5~60 秒随机。用户同样要求放宽（原 0.8~2.2 秒），宁可多等几分钟也不愿
 *     让平台侧看起来像脚本。代价是手动巡检一轮要几分钟 —— 所以 /accounts/check 改成了
 *     后台异步执行、前端轮询刷新，不再让浏览器干等一个长连接。
 *   - 上一次失败：120~300 秒。失败多半是限流或风控，此时继续按原节奏打只会越打越严；
 *     这个值必须明显大于正常间隔，否则「退避」等于没退。
 *
 * 全部用随机而不是固定值，因为「严格等间隔」的请求序列比人类操作更像脚本。
 */
const HEALTH_PAUSE = {
  scheduled: { base: 10000, span: 110000 },  // 10 ~ 120 秒
  manual: { base: 5000, span: 55000 },       // 5 ~ 60 秒
  backoff: { base: 120000, span: 180000 },   // 120 ~ 300 秒
}

/** 导出只为自测能断言区间，业务代码不要直接调 */
export const HEALTH_PAUSE_FOR_TEST = HEALTH_PAUSE

function healthCheckPause(lastFailed: boolean, manual: boolean): Promise<void> {
  const p = lastFailed ? HEALTH_PAUSE.backoff : manual ? HEALTH_PAUSE.manual : HEALTH_PAUSE.scheduled
  return new Promise(r => setTimeout(r, p.base + Math.floor(Math.random() * p.span)))
}

/**
 * 立即巡检所有已配置账号。
 *
 * @param opts.force  为 true 时忽略总开关（手动触发用；总开关关掉时定时巡检会跳过）
 * @param opts.manual 为 true 时用手动节奏（5~60 秒随机），默认走定时节奏（10~120 秒随机）
 * @param opts.boot   为 true 时只查「陈旧」账号（距上次校验 ≥ 巡检间隔）。启动首查用：
 *                    测试容器频繁重建时，刚查过的账号不再重复探测，避免每次重启都把
 *                    全平台账号重新打一遍（风控敏感平台尤其吃亏）。
 */
export async function runAccountHealthCheck(opts: { force?: boolean; manual?: boolean; boot?: boolean } = {}): Promise<
  HealthSummary & { checkedAt: number; checked: number }
> {
  const rows = store.listAccounts().filter(a => a.configured || a.accounts.some(i => i.configured))
  const checkedAt = Date.now()

  if (!rows.length) return { ...getAccountHealth(), checkedAt, checked: 0 }
  if (!opts.force && !isEnabled()) {
    // 账号通道整体关着时不做无谓请求，但把现状照常报出去
    return { ...getAccountHealth(), checkedAt, checked: 0 }
  }
  // 非手动（启动/定时）且巡检开关关着：什么都不做。手动走 force，用户点了就该真查。
  if (!opts.force && !isHealthCheckEnabled()) {
    return { ...getAccountHealth(), checkedAt, checked: 0 }
  }

  // 同一时刻只允许一轮巡检：定时器与用户点「立即检查」可能撞在一起。
  if (healthRunning) {
    console.log('[平台账号] 已有一轮巡检在进行，本次跳过')
    return { ...getAccountHealth(), checkedAt, checked: 0 }
  }
  healthRunning = true
  try {
    return await runHealthCheckLoop(opts, rows, checkedAt)
  } finally {
    healthRunning = false
  }
}

async function runHealthCheckLoop(
  opts: { force?: boolean; manual?: boolean; boot?: boolean },
  rows: ReturnType<typeof store.listAccounts>,
  checkedAt: number,
): Promise<HealthSummary & { checkedAt: number; checked: number }> {
  // 启动巡检的「陈旧」门槛：距上次校验不足一个巡检间隔的账号直接跳过。
  const boot = !!opts.boot
  const staleMs = checkIntervalHours() * 3600_000
  const ver = getAppVersion()
  const isStale = (item: { lastVerify?: { at?: number; byVersion?: string } | null }): boolean => {
    if (!boot) return true
    // 上一版写下的结论直接作废重查：校验口径会随版本变（1.5.49 才给 QQ/酷我/咪咕
    // 加了在线会员判定），沿用旧快照就会出现「升级后会员徽章退回结构校验」的假象。
    if (isSnapshotFromOtherVersion(item.lastVerify, ver)) return true
    const at = item.lastVerify?.at
    return !at || Date.now() - at >= staleMs
  }

  // 逐账号巡检：多账号平台（酷狗概念版）每个号都要单独确认登录态，
  // 只查主账号会出现「主号绿着，副号早失效了却没人知道」。
  //
  // 并发策略：**串行**，一个号查完再查下一个。这里刻意不做并发 ——
  // 巡检只是「确认登录态」，慢几分钟没有代价；而并发打同一平台的鉴权接口，
  // 恰恰是风控最容易识别成「批量扫号」的形态。间隔见 healthCheckPause：
  // 定时 10~120 秒随机，手动 5~60 秒，失败后统一退避 120~300 秒。
  const manual = !!opts.manual
  let checked = 0
  let lastFailed = false
  for (const a of rows) {
    const items = (a.accounts || []).filter(i => i.configured && isStale(i))
    // boot 模式下整平台都是新鲜的就整平台跳过（连间隔等待也省了）
    if (boot && !items.length) continue
    if (!items.length) {
      // 单账号平台（老数据形态，没有 accounts 细分）：用平台级 lastVerify 判陈旧
      if (!isStale(a)) continue
      try {
        await verifyAccount(a.id)
        checked++
        lastFailed = false
      } catch (e: any) {
        lastFailed = true
        console.log(`[平台账号] 巡检 ${a.name} 出错（忽略）：${e?.message || e}`)
      }
      await healthCheckPause(lastFailed, manual)
      continue
    }
    for (const item of items) {
      try {
        await verifyAccount(a.id, item.id)
        checked++
        lastFailed = false
      } catch (e: any) {
        lastFailed = true
        console.log(`[平台账号] 巡检 ${a.name}（${item.label}）出错（忽略）：${e?.message || e}`)
      }
      // 平台之间留点间隔：几个平台连打容易被各自的风控当成扫描
      await healthCheckPause(lastFailed, manual)
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
export function getHealthCheckState(): {
  intervalHours: number
  hour: number
  nextRunAt: number
  lastRunAt: number
  enabled: boolean
  running: boolean
} {
  return {
    intervalHours: checkIntervalHours(),
    hour: checkHourOfDay(),
    nextRunAt: healthNextRunAt,
    lastRunAt: healthLastRunAt,
    enabled: isHealthCheckEnabled(),
    running: healthRunning,
  }
}

function scheduleHealthCheck(): void {
  if (healthTimer) {
    clearTimeout(healthTimer)
    healthTimer = null
  }
  // 开关关着就不排程（下次打开时由 rescheduleAccountHealthCheck 重新拉起）
  if (!isHealthCheckEnabled()) {
    healthNextRunAt = 0
    console.log('[平台账号] 自动巡检已关闭，不再排程（失效靠取链失败复核与手动检查发现）')
    return
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
    `[平台账号] 账号巡检已排程：候选点每天 ${pad(checkHourOfDay())}:00，`
    + `且距上次不少于 ${checkIntervalHours()} 小时（间隔才是真实频率）；`
    + `下一轮 ${when.getMonth() + 1}/${when.getDate()} ${pad(when.getHours())}:${pad(when.getMinutes())}`,
  )
}

/** 配置改动（巡检间隔/时间点/开关）后重排定时器，不必重启进程 */
export function rescheduleAccountHealthCheck(): void {
  // 开关可能刚从「关」变「开」，此时没有 timer 也要重新排上
  scheduleHealthCheck()
}

/** 所有已配置账号里最早的一次校验时间；没有任何校验记录时回 0（=从未巡检） */
function oldestVerifiedAt(): number {
  const times: number[] = []
  const ver = getAppVersion()
  // 上一版写的快照不算「已验证」：它已经会被 isStale 判成需要重查，
  // 时间轴也不该拿它当基准，否则界面上「上次巡检」会一直停在旧版本的时间。
  const usable = (v: { at?: number; byVersion?: string } | null | undefined): number | null =>
    v && v.at && !isSnapshotFromOtherVersion(v, ver) ? v.at : null
  for (const a of store.listAccounts()) {
    const items = (a.accounts || []).filter(i => i.configured)
    if (items.length) {
      for (const i of items) {
        const at = usable(i.lastVerify)
        if (at) times.push(at)
      }
    } else {
      const at = usable(a.lastVerify)
      if (at) times.push(at)
    }
  }
  return times.length ? Math.min(...times) : 0
}

/**
 * 启动定时巡检（受 musicAccount.healthCheckEnabled 控制，默认开）：
 * 启动后等 90 秒再跑第一次，且只查「陈旧」账号（距上次校验 ≥ 巡检间隔）。
 * 启动瞬间音源巡检、会话恢复都在抢网络，别在这时候再加一堆外部请求。
 */
export function startAccountHealthCheck(): void {
  if (healthTimer) return
  if (!isHealthCheckEnabled()) {
    console.log('[平台账号] 自动巡检已关闭（musicAccount.healthCheckEnabled=false），启动不巡检')
    return
  }
  const boot = setTimeout(() => {
    // boot 模式：只补查陈旧的，刚查过的不重复探测
    void runAccountHealthCheck({ boot: true })
      .then(r => {
        // 一个都没查（全都很新）时不能把「上次巡检」记成现在 —— 那等于每次重启
        // 都把定时巡检往后推一个间隔，反复重建容器会让定时巡检永远不到点。
        // 这种情况把锚点回填成「最陈旧账号的实际校验时间」，排程继续按真实节奏走。
        healthLastRunAt = r.checked > 0 ? Date.now() : oldestVerifiedAt()
      })
      .catch(e => console.log(`[平台账号] 启动巡检出错（忽略）：${e?.message || e}`))
      .finally(() => {
        scheduleHealthCheck()
      })
  }, 90_000)
  if (typeof boot.unref === 'function') boot.unref()
  console.log(
    `[平台账号] 账号巡检已安排：启动 90 秒后补查陈旧账号，之后每天 ${String(checkHourOfDay()).padStart(2, '0')}:00 候选`
    + `且距上次不少于 ${checkIntervalHours()} 小时才真跑`,
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
  /** expired=登录态失效；notVip=登录正常但不是会员（取会员歌失败时记下） */
  kind?: 'expired' | 'notVip'
}

/**
 * 记录「某平台取链失败且当场复核确认是登录正常但非会员」的时刻。
 * 只用于提示，不影响健康度（非会员不是故障，标红会让用户白折腾重新登录）。
 */
const notVipHintAt = new Map<string, number>()
const NOT_VIP_HINT_TTL = 2 * 3600_000

/**
 * 播放端要主动提示的账号问题。
 *
 * 两类混在一起会让用户白忙：失效要「重新登录」，非会员「重新登录也没用」。
 *   - expired：Cookie 过期/被顶掉 —— 指引重新登录
 *   - notVip：登录正常但没会员权益 —— 指引开会员/换号（仅记录 2 小时内真实触发过的）
 * 待复查/未校验属于提醒，不该在播放时打断用户，不在此列。
 */
export function getAccountHints(): AccountHint[] {
  const hints: AccountHint[] = []
  for (const r of store.listAccounts()) {
    if (!r.configured) continue
    if (r.health === 'expired') {
      hints.push({
        platform: r.id,
        name: r.name,
        health: r.health,
        kind: 'expired',
        text: `${r.name}账号已失效，高音质会退回试听或匿名通道，请到后台「平台账号」重新登录或更新 Cookie`,
      })
      continue
    }
    const at = notVipHintAt.get(r.id) ?? 0
    if (at && Date.now() - at < NOT_VIP_HINT_TTL) {
      hints.push({
        platform: r.id,
        name: r.name,
        health: r.health,
        kind: 'notVip',
        text: `${r.name}账号登录正常，但当前不是会员 —— 会员歌曲取不到高音质（重新登录无效；需开通会员，或在后台把有会员的冷备号设为「主账号」）`,
      })
    }
  }
  return hints
}

// ---- 扫码登录（网易云 / QQ / 微信 / 酷狗 / 酷狗概念版） ----
export const qrLoginStart = qrLogin.start
export const qrLoginPoll = qrLogin.poll
export const qrLoginClose = qrLogin.close

// ---- 手机验证码登录（酷狗概念版 / 咪咕） ----
// 咪咕多发一步：通行证每次都要先答一道图形验证码，所以有 qrLoginSmsCaptcha。
export const qrLoginSmsCaptcha = qrLogin.smsCaptcha
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
  /** 账号之间的错峰间隔（秒），每次随机落在 [gapMinSeconds, gapMaxSeconds] 内 */
  gapMinSeconds: number
  gapMaxSeconds: number
  minRemainHours: number
  /** 下一轮自动领取的时间戳（毫秒），没有排程时为 0 */
  nextRunAt: number
  /** 手动「立即全部领取」的进度：running=true 时前端继续轮询 */
  claimAll: { running: boolean; startedAt: number; finishedAt: number; lastRound: LiteAutoClaimRound | null }
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
 * 当天额度已领满的账号（itemId → 日期串）。
 *
 * 目的：8 轮定时任务里，第 1 轮就把 8 次额度领完了，后面 7 轮不该再去打平台接口
 * （空转也要 1 次 play_report + 1 次听歌上报，纯属给风控添素材）。
 * 只放内存：重启后忘掉不要紧，下一轮第一次请求返回 30002 会重新记上。
 */
const liteAdExhaustedAt = new Map<string, string>()

function liteDayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 立即给某个账号领一次概念版 VIP（听歌 + 看广告）。
 * @param itemId 指定账号；省略时用主账号
 * @param opts.internal 自动连领模式（定时任务）：跳过 90 秒手动冷却、按额度连领
 */
export async function claimKugouLiteVip(
  itemId?: string,
  opts: { internal?: boolean; maxAdTimes?: number } = {},
): Promise<kglite.ClaimVipResult> {
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
    const adExhausted = liteAdExhaustedAt.get(acct.id) === liteDayKey()
    const res = await kglite.claimVip(acct.cookie, {
      internal: opts.internal,
      maxAdTimes: opts.maxAdTimes,
      adExhausted: opts.internal ? adExhausted : false,
    })
    // done >= total 说明今天额度用光，后续轮次直接跳过
    if (res.adDone !== undefined && res.adTotal !== undefined && res.adTotal > 0 && res.adDone >= res.adTotal) {
      liteAdExhaustedAt.set(acct.id, liteDayKey())
    }
    await refreshKugouLiteStatus(acct.cookie, acct.primary ? undefined : acct.id)
    return res
  } finally {
    vipInflight.delete(acct.id)
  }
}

/** 查所有账号的会员信息（供接口直接展示剩余时长） */
export async function getKugouLiteVip(): Promise<KugouLiteVipState> {
  const cfg = getKugouLiteAutoClaimConfig()
  const list = liteAccounts()
  const base = {
    configured: list.length > 0,
    autoClaim: cfg.autoClaim,
    startHour: cfg.startHour,
    gapMinSeconds: cfg.gapMinSeconds,
    gapMaxSeconds: cfg.gapMaxSeconds,
    minRemainHours: cfg.minRemainHours,
    nextRunAt: vipNextRunAt,
    claimAll: getKugouLiteClaimAllState(),
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
export function getKugouLiteAutoClaimConfig(): {
  autoClaim: boolean
  startHour: number
  gapMinSeconds: number
  gapMaxSeconds: number
  minRemainHours: number
} {
  const c = config()
  const num = (key: string, def: number, min: number, max: number) => {
    const v = Number(c[key])
    if (!Number.isFinite(v)) return def
    return Math.min(max, Math.max(min, Math.floor(v)))
  }
  const gap = liteGapRange(c)
  return {
    autoClaim: c['musicAccount.kglite.autoClaim'] !== false,
    startHour: num('musicAccount.kglite.startHour', 6, 0, 23),
    gapMinSeconds: gap.min,
    gapMaxSeconds: gap.max,
    // 0 = 不限阈值：不管还剩多久，每轮都补（填 0 是合法值，别再钳成 1）
    minRemainHours: num('musicAccount.kglite.minRemainHours', 24, 0, 24 * 30),
  }
}

/** 间隔允许的范围：下限 5 秒（再短就等于连打），上限 1 小时 */
const GAP_LIMIT = { min: 5, max: 3600 }

/**
 * 账号间的错峰间隔，从「固定值」改成「区间内随机」。
 *
 * 固定 N 秒意味着 4 个号在 N、2N、3N 秒的整点依次请求，时间戳摆出来是一条等差数列，
 * 比人工操作更像脚本。区间随机就好得多。
 *
 * 旧键 `musicAccount.kglite.gapSeconds`（v1.5.48 及以前）已由这一对键取代：
 * defaultConfig 会给新键兜底，所以即使老配置文件里还留着旧键，读到的是新默认值（60~600 秒），
 * 不需要写盘迁移。
 */
function liteGapRange(c: Record<string, any>): { min: number; max: number } {
  const read = (key: string): number | null => {
    const v = Number(c[key])
    if (!Number.isFinite(v)) return null
    return Math.min(GAP_LIMIT.max, Math.max(GAP_LIMIT.min, Math.floor(v)))
  }

  let lo = read('musicAccount.kglite.gapMinSeconds')
  let hi = read('musicAccount.kglite.gapMaxSeconds')

  if (lo === null && hi === null) return { min: 60, max: 600 }
  if (lo === null) lo = Math.max(GAP_LIMIT.min, Math.floor((hi as number) / 2))
  if (hi === null) hi = Math.max(lo, 600)
  if (lo > hi) [lo, hi] = [hi, lo]
  return { min: lo, max: hi }
}

/**
 * 在 [min, max] 闭区间里取一个整数秒。min === max 时退化成固定值。
 * 单独导出是为了能写单测：区间取值的边界最容易写错（差一、倒序、负数）。
 */
export function pickGapSeconds(min: number, max: number, rand: () => number = Math.random): number {
  const lo = Math.max(0, Math.floor(Number.isFinite(min) ? min : 0))
  const hi = Math.max(lo, Math.floor(Number.isFinite(max) ? max : lo))
  if (hi === lo) return lo
  return lo + Math.floor(rand() * (hi - lo + 1))
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
 * 手动「立即全部领取」的进度状态。
 *
 * 一轮最多可能跑几十分钟（账号之间要按 300~1200 秒错峰），挂在 HTTP 请求上等必然被
 * 浏览器/反代掐断，用户看到的是「领取失败」而后台其实还在跑 —— 所以改成后台跑、前端轮询。
 */
let claimAllRunning = false
let claimAllStartedAt = 0
let claimAllFinishedAt = 0
let claimAllLastRound: LiteAutoClaimRound | null = null

export function getKugouLiteClaimAllState(): {
  running: boolean
  startedAt: number
  finishedAt: number
  lastRound: LiteAutoClaimRound | null
} {
  return {
    running: claimAllRunning,
    startedAt: claimAllStartedAt,
    finishedAt: claimAllFinishedAt,
    lastRound: claimAllLastRound,
  }
}

/** 手动「立即全部领取」：后台开跑，立刻返回，结果靠轮询 claimAll 状态拿 */
export function startKugouLiteClaimAll(): { started: boolean; running: boolean; message: string } {
  if (claimAllRunning) {
    return { started: false, running: true, message: '上一轮「全部领取」还在进行中，完成后再点' }
  }
  claimAllRunning = true
  claimAllStartedAt = Date.now()
  claimAllFinishedAt = 0
  void runKugouLiteAutoClaim({ force: true })
    .then(round => {
      claimAllLastRound = round
    })
    .catch((e: any) => {
      console.log(`[平台账号] 概念版全部领取出错（忽略）：${e?.message || e}`)
      claimAllLastRound = { startedAt: claimAllStartedAt, halted: `出错：${e?.message || e}`, accounts: [] }
    })
    .finally(() => {
      claimAllRunning = false
      claimAllFinishedAt = Date.now()
    })
  return {
    started: true,
    running: true,
    message: '已在后台逐个领取（账号之间有错峰间隔），完成后自动出结果',
  }
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
  const cfg = getKugouLiteAutoClaimConfig()
  if (!cfg.autoClaim && !opts.force) return { startedAt, halted: '自动领取已关闭', accounts: [] }

  const list = liteAccounts()
  if (!list.length) return { startedAt, halted: '未配置酷狗概念版账号', accounts: [] }

  const accounts: LiteAutoClaimAccount[] = []
  for (let i = 0; i < list.length; i++) {
    const acct = list[i]
    // 账号之间错峰：多个号连着打同一个接口，很容易被平台按设备/网络维度风控。
    // 间隔在配置的区间里随机取，不要固定值（等间隔的请求序列更像脚本）。
    if (i > 0 && cfg.gapMaxSeconds > 0) {
      const gap = pickGapSeconds(cfg.gapMinSeconds, cfg.gapMaxSeconds)
      if (gap > 0) {
        console.log(`[平台账号] 概念版自动补领｜下一个账号等 ${gap} 秒（区间 ${cfg.gapMinSeconds}~${cfg.gapMaxSeconds} 秒随机）`)
        await sleep(gap * 1000)
      }
    }

    const vip = await kglite.getVipInfo(acct.cookie)
    if (!vip.ok) {
      // 查不到会员状态时不动手：盲领可能把额度浪费在已经垫了很多天的情况下
      console.log(`[平台账号] 概念版自动补领｜${acct.label}：会员状态查询失败，本轮跳过（${vip.error || '未知原因'}）`)
      accounts.push({ id: acct.id, label: acct.label, primary: acct.primary, skipped: true, reason: `会员信息查询失败：${vip.error || '未知原因'}` })
      continue
    }
    // minRemainHours = 0 表示用户主动关掉了「够用就跳过」：不看剩余，每轮都补。
    if (!opts.force && cfg.minRemainHours > 0 && vip.remainHours >= cfg.minRemainHours) {
      // 跳过也要留一行：否则定时器到底有没有在跑，只能靠猜
      console.log(`[平台账号] 概念版自动补领｜${acct.label}：剩余 ${vip.remainHours} 小时（≥${cfg.minRemainHours}），本轮跳过`)
      accounts.push({ id: acct.id, label: acct.label, primary: acct.primary, skipped: true, reason: `剩余 ${vip.remainHours} 小时，暂不需要补领` })
      continue
    }

    // 一轮内把当天额度领满（平台 8 次 × 3 小时 = 24 小时，刚好覆盖一天）；
    // 之后的轮次会因为 done>=total 自动空转，只留一行日志，不再打扰平台。
    const res = await claimKugouLiteVip(acct.id, { internal: true, maxAdTimes: kglite.DAILY_CLAIM_LIMIT })
    const quota = res.adDone !== undefined ? `，今日额度 ${res.adDone}/${res.adTotal ?? kglite.DAILY_CLAIM_LIMIT}` : ''
    console.log(
      `[平台账号] 概念版自动补领｜${acct.label}（领取前剩余 ${vip.remainHours} 小时）：`
      + `${res.ok ? `获得 ${res.gainedHours} 小时` : '未获得'}${quota}`
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
  const cfg = getKugouLiteAutoClaimConfig()
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
    `[平台账号] 酷狗概念版 VIP 自动领取已排程：每天 ${pad(cfg.startHour)}:00 起，每 ${AUTO_CLAIM_ROUND_GAP_HOURS} 小时一轮（共 ${AUTO_CLAIM_ROUNDS} 轮，每轮把当日额度连领到满）；`
    + `${cfg.minRemainHours > 0 ? `剩余不足 ${cfg.minRemainHours} 小时才领` : '不看剩余、每轮都补'}，账号间隔 ${cfg.gapMinSeconds}~${cfg.gapMaxSeconds} 秒随机；`
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
