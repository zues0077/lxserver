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
const WWW = 'https://www.kuwo.cn'

/**
 * 会员信息候选路径。
 *
 * 酷我 www 接口的鉴权是 Cookie 里的 kw_token + 请求头 csrf（两者同值）+ reqId，
 * 缺任一都会被网关回 `{"success":false,"message":"The request is illegal!"}`。
 * 注意这个 illegal 是**风控层**的回包：连不存在的路径也回它，所以不能拿它判断
 * 接口是否存在（wapi.kuwo.cn 才会给真 404）。这里按优先级排，逐个试到有数据为止。
 */
const VIP_PATHS = [
  '/api/v1/www/user/getVipInfo',
  '/api/v1/www/user/getUserInfo',
  '/api/v1/www/vip/getVipInfo',
  '/api/www/user/getVipInfo',
  '/api/www/user/getUserInfo',
]

/** 平台返回体里"是不是会员"的字段名五花八门，宽松取一个真值即可 */
const VIP_FIELDS = ['isVip', 'vip', 'vipFlag', 'isVipFlag', 'vipType', 'vipLevel', 'isVipUser', 'vipStatus']

function pickVipFlag(data: any): boolean | null {
  if (!data || typeof data !== 'object') return null
  let saw = false
  let vip = false
  for (const k of VIP_FIELDS) {
    const raw = (data as any)[k]
    if (raw === undefined || raw === null || raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      // 字符串型（如 "1" / "true" / "vip"）也认
      const s = String(raw).trim().toLowerCase()
      if (s === 'true' || s === 'vip' || s === 'yes') { saw = true; vip = true }
      continue
    }
    saw = true
    if (n > 0) vip = true
  }
  return saw ? vip : null
}

/**
 * 在线查酷我会员。拿不到就返回 null，由调用方退化为结构校验。
 * 命中的原始响应会记进日志，便于平台改字段后快速定位。
 */
async function probeVip(cookie: string): Promise<{ isVip: boolean; nickname?: string; raw?: string } | null> {
  const map = parseCookie(cookie)
  const csrf = map['kw_token'] || ''
  if (!csrf) {
    console.warn('[KW-VIP] Cookie 里没有 kw_token，无法构造 csrf 头，跳过在线会员查询')
    return null
  }
  const reqId = `${Date.now().toString(16)}-${Math.floor(Math.random() * 1e9).toString(16)}`
  for (const path of VIP_PATHS) {
    try {
      const resp = await withTimeout(request(`${WWW}${path}?reqId=${reqId}`, {
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.kuwo.cn/',
          csrf,
          Cookie: cookie,
        },
        timeout: 12000,
      }), 13000, '酷我会员查询')
      const body: any = resp?.body
      const brief = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 220)
      if (body && body.success === true && body.data) {
        const isVip = pickVipFlag(body.data)
        const nickname = (body.data.nickname || body.data.name || body.data.uname || body.data.userName || body.data.username) as string | undefined
        console.warn(`[KW-VIP] ${path} 命中 → isVip=${isVip} nickname=${nickname || '-'}`)
        if (typeof isVip === 'boolean') return { isVip, nickname, raw: brief }
        console.warn(`[KW-VIP] ${path} 返回成功但认不出会员字段 → ${brief}`)
      } else {
        console.warn(`[KW-VIP] ${path} → ${brief}`)
      }
    } catch (e: any) {
      console.warn(`[KW-VIP] ${path} 请求异常: ${e?.message || e}`)
    }
  }
  return null
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
export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  const keys = getPlatform('kw')?.loginKeys ?? ['kw_token', 'userid']
  if (!hasLoginKey(cookie, keys)) {
    return { ok: false, verified: 'structural', message: `Cookie 里没有找到 ${keys.join(' / ')}，请确认已登录酷我后再复制` }
  }

  // 先在线查会员：www 接口 + csrf 头能拿到权益字段就如实标注，
  // 拿不到再退回结构校验（不猜、不谎报）。
  try {
    const vip = await probeVip(cookie)
    if (vip) {
      const uid = parseCookie(cookie)['userid'] || parseCookie(cookie)['user_id'] || ''
      return {
        ok: true,
        verified: 'online',
        isVip: vip.isVip,
        nickname: vip.nickname || (uid ? `酷我账号 ${uid}` : '酷我账号'),
        message: vip.isVip
          ? '已登录，会员身份有效（酷我取链暂不校验账号，音质仍取决于曲目本身）'
          : '已登录，当前非会员（普通账号）',
      }
    }
  } catch (e: any) {
    console.warn('[KW-VIP] 会员查询异常，退化为结构校验:', e?.message || e)
  }

  return {
    ok: true,
    verified: 'structural',
    message: '已完成结构校验；酷我会员信息接口不可用（网关拦截或字段变更），且取链接口目前不校验账号，音质取决于曲目本身',
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
