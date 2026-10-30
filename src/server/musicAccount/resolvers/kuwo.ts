/**
 * 酷我音乐 —— 带账号 Cookie 取链
 *
 * 走移动端 `mobi.kuwo.cn/mobi.s` 的 `convert_url_with_sign`，用 br 指定音质。
 *
 * ⚠️ 两个必须记住的实测事实（2026-10-24，别再凭想象改）：
 *
 * 1) **音质只能看响应里的 `data.bitrate` / `data.format`，不能看请求的 br。**
 *    rid 440618（有高音质资源）：
 *        br=2000kflac → 2000 / flac
 *        br=flac      → 20501 / mflac
 *        br=320kmp3   → 320 / mp3
 *        br=128kmp3   → 128 / mp3
 *    rid 351583919（只有普通资源）五档全部返回 128 / mp3 —— 也就是没有无损就是没有，
 *    br 怎么求都换不来。早期版本直接拿请求参数当音质标签，会把 128k mp3
 *    标成 flac24bit 写进缓存文件名，导致「按音质升级」「缓存判重」全部失真。
 *
 * 2) **br 与音质不是单调关系，高档位反而可能更差。**
 *    rid 256484839：br=flac/320kmp3 → 48k aac（垃圾），br=192kmp3 → 128k mp3。
 *    所以「从高到低试，拿到第一个就收」会把 aac 当成功返回。
 *    这里改成**并行探完各档再择优**，既避开这个坑，也只用一次往返的时间。
 *
 * 3) **这个接口目前不校验账号权益，Cookie 带不带结果一样。**
 *    2026-10-24 在 120 上用真实酷我账号 Cookie 做过三组对照（免费曲 / PAY≠0 付费曲 /
 *    时长完整性），无 Cookie 与有 Cookie 拿到的 bitrate、format、duration 完全一致，
 *    也不存在「试听片段」（duration 与曲目真实时长逐首对上）。
 *    所以「配了账号音质更好」在酷我身上暂时**不成立** —— 别拿 Cookie 去解释音质差，
 *    该看的是这首歌本身有没有那个档位的资源。Cookie 仍然照发，等平台收紧时才会用到。
 */

import { request, withTimeout, extFromUrl, hasLoginKey, parseCookie } from '../http'
import { getPlatform } from '../platforms'
import type { AccountResolveResult, AccountInfo } from '../types'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MOBI_API = 'https://mobi.kuwo.cn/mobi.s'
const SOURCE = 'kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk'

/**
 * 会员信息候选路径。
 *
 * 酷我 www 接口的鉴权是 Cookie 里的 kw_token + 请求头 csrf（两者同值）+ reqId，
 * 缺任一都会被网关回 `{"success":false,"message":"The request is illegal!"}`。
 * 注意这个 illegal 是**风控层**的回包：连不存在的路径也回它，所以不能拿它判断
 * 接口是否存在（wapi.kuwo.cn 才会给真 404）。这里按优先级排，逐个试到有数据为止。
 */
/**
 * 酷我会员信息接口（2026-10-30 从 GitHub 上的酷我签到脚本找到，不是猜的）：
 *   GET https://vip1.kuwo.cn/vip/v2/user/vip?op=ui
 * 响应：{ data: {...}, meta: { code: 200, desc: "成功" } }
 *   data 里的会员到期字段：vipExpire / vipmExpire / vip3Expire / vipLuxuryExpire /
 *   svipExpire / vipOverSeasExpire，毫秒时间戳字符串，"0" 表示没开。
 *
 * ⚠️ 踩过的坑（别再走一遍）：
 *   - www.kuwo.cn 的 /api/** 要 Cookie 里的 kw_token + 同名 csrf 头 + reqId，
 *     缺任一是风控层的 "The request is illegal!"（连不存在的路径也回这句，
 *     所以不能拿它判断接口是否存在）。会员中心复制的 Cookie 根本没有 kw_token，
 *     那条路对登录态 Cookie 是死的。
 *   - wapi.kuwo.cn /api/pc/** 下没有用户信息路径（全 404）；
 *     mobileinterfaces er.s（回 {"result":"error"}）、mobi.s（回空）也试不出 type。
 *   - vip1.kuwo.cn 才是会员中心自己的域，认 userid/websid/sid，不需要 kw_token。
 *   - 匿名调它也回 code=200，只是 data 是空对象 —— 所以**不能只看 code**，
 *     要用 data 里有没有身份字段来确认这次请求确实带上了登录态。
 */
const VIP1_API = 'https://vip1.kuwo.cn/vip/v2/user/vip?op=ui'

/** 会员到期时间字段，任一 > 当前时间即视为有会员 */
const VIP_EXPIRE_FIELDS = ['vipExpire', 'vipmExpire', 'vip3Expire', 'vipLuxuryExpire', 'svipExpire', 'vipOverSeasExpire']

/** 用来确认「这次请求真的是登录态」的字段；匿名时 data 为空对象 */
const VIP_ID_FIELDS = ['uid', 'userid', 'userId', 'uname', 'nickname', 'username', 'userName', 'loginId']

/**
 * 在线查酷我会员。返回 null 表示没拿到可信结果，由调用方退化为结构校验，不猜不报。
 */
async function probeVip(cookie: string): Promise<{ isVip: boolean; nickname?: string; tier?: string } | null> {
  try {
    // 酷我 App（手机短信登录的账号就属于这类）的登录态靠 uid + sid 参数传，
    // 不是纯靠 Cookie 头 —— 见上方注释里的实证脚本形态。
    // 网页 Cookie 里的 userid/sid 也一并带上，两种机制都覆盖，多发的参数在网页侧无害。
    const map = parseCookie(cookie)
    const uid = map['userid'] || map['user_id'] || map['loginUid'] || ''
    const sid = map['sid'] || map['loginSid'] || map['websid'] || ''
    const extra: string[] = []
    if (uid) extra.push(`uid=${encodeURIComponent(uid)}`)
    if (sid) extra.push(`sid=${encodeURIComponent(sid)}`)
    extra.push('signver=new')
    const url = `${VIP1_API}&${extra.join('&')}`
    console.warn(`[KW-VIP] 请求形态: op=ui${uid ? ' +uid' : ''}${sid ? ' +sid' : ''} +signver=new`)
    const resp = await withTimeout(request(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://vip1.kuwo.cn/',
        Cookie: cookie,
      },
      timeout: 12000,
    }), 13000, '酷我会员查询')
    const body: any = resp?.body
    const code = Number(body?.meta?.code)
    const data: any = body?.data || {}
    const keys = Object.keys(data || {})
    console.warn(`[KW-VIP] code=${code} dataKeys=[${keys.join(',')}]`)
    if (code !== 200) return null

    // data 为空 = 这次请求没带上有效登录态（Cookie 失效或压根没登录），
    // 不能当成「非会员」报出去，否则失效账号会被显示成正常非会员。
    const hasIdentity = VIP_ID_FIELDS.some(k => data[k] !== undefined && String(data[k]) !== '')
    if (!hasIdentity && !keys.length) {
      console.warn('[KW-VIP] 响应 data 为空，无法确认登录态，退化为结构校验')
      return null
    }

    const now = Date.now()
    let isVip = false
    for (const k of VIP_EXPIRE_FIELDS) {
      const v = Number(data[k])
      if (Number.isFinite(v) && v > now) { isVip = true; break }
    }
    const nickname = [data.uname, data.nickname, data.username, data.userName].find(v => !!v)
    const tier = data.vipTag || (isVip ? 'VIP' : undefined)
    console.warn(`[KW-VIP] 判定 → isVip=${isVip} tier=${tier || '-'} nickname=${nickname || '-'}`)
    return { isVip, nickname: nickname ? String(nickname) : undefined, tier: tier ? String(tier) : undefined }
  } catch (e: any) {
    console.warn('[KW-VIP] 会员查询异常:', e?.message || e)
    return null
  }
}

/**
 * 并行探测的档位。192kmp3 单独留着：它是「只有 aac 资源」的曲目能拿到
 * mp3 的唯一入口，去掉它会让那批歌退回 48k aac。
 */
const PROBE_TIERS: Array<{ br: string; rank: number }> = [
  { br: '2000kflac', rank: 60 },
  { br: 'flac', rank: 50 },
  { br: '320kmp3', rank: 40 },
  { br: '192kmp3', rank: 30 },
  { br: '128kmp3', rank: 20 },
]

/** rank 越高音质越好 */
const RANK_BY_QUALITY: Record<string, number> = {
  flac24bit: 60,
  flac: 50,
  '320k': 40,
  '192k': 30,
  '128k': 20,
}

/** 同码率时优先选容器更好的（无损 > mp3 > aac） */
function formatScore(format: string): number {
  const f = format.toLowerCase()
  if (f.includes('flac') || f.includes('ape') || f.includes('wav')) return 3
  if (f.includes('mp3')) return 2
  return 1
}

/**
 * 把响应里的 bitrate / format 翻译成 LX 认识的音质标签。
 *
 * 只能用 QUALITY_TOKENS 里的取值（flac24bit / flac / 320k / 192k / 128k…），
 * 因为 `type` 会变成缓存文件名里的音质段，写个 `aac` 进去会让文件名
 * 匹配不上 QUALITY_TOKENS，缓存升级/判重就瞎了。
 */
function qualityFromResponse(bitrate: number, format: string): { quality: string; rank: number } {
  const fmt = String(format || '').toLowerCase()
  const br = Number.isFinite(bitrate) ? bitrate : 0

  if (fmt.includes('flac') || fmt.includes('ape') || fmt.includes('wav')) {
    // mflac 是酷我的母带级 flac；普通 flac 一般 900~1100kbps，
    // 1400 以上才算 hi-res（实测 2000kflac 给 2000，"flac" 档给 20501）
    const quality = fmt.includes('mflac') || br >= 1400 ? 'flac24bit' : 'flac'
    return { quality, rank: RANK_BY_QUALITY[quality] }
  }
  // mp3 / aac / 其他有损：按实际码率分档
  let quality = '128k'
  if (br >= 300) quality = '320k'
  else if (br >= 180) quality = '192k'
  return { quality, rank: RANK_BY_QUALITY[quality] }
}

/**
 * 真实的登录态探测：酷我没有独立的会员信息接口，
 * 这里只做结构校验，会员状态以实际取链拿到的音质为准。
 */
/** Cookie 里的 username 常被 URL 编码，解码失败就原样用 */
function decodeName(v?: string): string {
  if (!v) return ''
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  const keys = getPlatform('kw')?.loginKeys ?? ['kw_token', 'userid']
  if (!hasLoginKey(cookie, keys)) {
    return { ok: false, verified: 'structural', message: `Cookie 里没有找到 ${keys.join(' / ')}，请确认已登录酷我后再复制` }
  }
  const map = parseCookie(cookie)
  const nickname = decodeName(map['username']) || (map['userid'] ? `酷我账号 ${map['userid']}` : '')

  // 先在线查会员：会员中心 vip1.kuwo.cn 认 userid/websid/sid，拿到到期时间就如实标注。
  try {
    const vip = await probeVip(cookie)
    if (vip) {
      return {
        ok: true,
        verified: 'online',
        isVip: vip.isVip,
        nickname: vip.nickname || nickname || '酷我账号',
        message: vip.isVip
          ? `已登录，${vip.tier ? `会员（${vip.tier}）` : '会员'}有效（酷我取链暂不校验账号，音质仍取决于曲目本身）`
          : '已登录，当前非会员（普通账号）',
      }
    }
  } catch (e: any) {
    console.warn('[KW-VIP] 会员查询异常，退化为结构校验:', e?.message || e)
  }

  return {
    ok: true,
    verified: 'structural',
    nickname: nickname || undefined,
    message: '已登录（结构校验）；会员在线查询未拿到可信结果（多为 Cookie 已失效），请重新复制酷我 Cookie 后再校验',
  }
}

/** 探测一个档位；失败/无链接一律返回 null，不抛 */
async function probe(rid: string, br: string, cookie: string): Promise<{ br: string; url: string; bitrate: number; format: string } | null> {
  const user = `C_APK_guanwang_${Date.now()}${Math.floor(Math.random() * 1_000_000)}`
  const params = new URLSearchParams({
    f: 'web',
    source: SOURCE,
    from: 'PC',
    type: 'convert_url_with_sign',
    br,
    rid,
    user,
  })
  try {
    const resp = await withTimeout(request(`${MOBI_API}?${params.toString()}`, {
      headers: { 'User-Agent': UA, Cookie: cookie },
    }), 12000, '酷我取链')
    // body 可能是对象，也可能是 "refuse request!" 这类纯文本
    const data = typeof resp?.body === 'object' ? (resp?.body as any)?.data : null
    const url = String(data?.url || '')
    if (!url) return null
    // mobi 对「查无此歌 / 无权限」有时不返空，而是把 Python 的 None 原样序列化成字符串 "None"。
    // 不校验的话它会被当成取链成功，前端拿 "None" 当 src，播不出来还查不到原因。
    if (!/^https?:\/\//i.test(url)) return null
    return { br, url, bitrate: Number(data?.bitrate), format: String(data?.format || '') }
  } catch {
    return null
  }
}

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const rid = String(songInfo?.songmid ?? songInfo?.meta?.songId ?? songInfo?.id ?? '')
  if (!rid) return { ok: false, error: '歌曲缺少酷我 rid，无法用账号取链' }

  const probes = await Promise.all(PROBE_TIERS.map(t => probe(rid, t.br, cookie)))
  const list = probes.filter((x): x is NonNullable<typeof x> => !!x)

  if (!list.length) {
    return { ok: false, error: '酷我未返回可用链接（多为版权受限、需要会员或 Cookie 失效）' }
  }

  const candidates = list.map(p => {
    const actual = qualityFromResponse(p.bitrate, p.format)
    return { ...p, quality: actual.quality, rank: actual.rank, fmtScore: formatScore(p.format) }
  })

  // 尊重请求的音质上限：要 320k 就不硬塞 flac 给用户白耗流量。
  // 但「上限内没有候选」时（比如这首歌只有无损）就退回全量择优。
  const ceiling = RANK_BY_QUALITY[quality]
  let pool = candidates.filter(c => c.rank <= ceiling)
  if (!pool.length) pool = candidates

  pool.sort((a, b) => (b.rank - a.rank) || (b.fmtScore - a.fmtScore))
  const best = pool[0]

  // 只有真的拿到 320k 及以上才算走了会员通道；128k 是免费档，别冒充会员
  return {
    ok: true,
    url: best.url,
    quality: best.quality,
    isVip: best.rank >= RANK_BY_QUALITY['320k'],
    // 通道名带上「哪一档请求 → 实际拿到什么」，日志里一眼看出是否被降级
    via: `mobi:${best.br}→${best.quality}`,
    ext: extFromUrl(best.url),
  }
}
