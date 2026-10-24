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
 */

import { request, withTimeout, extFromUrl, hasLoginKey } from '../http'
import { getPlatform } from '../platforms'
import type { AccountResolveResult, AccountInfo } from '../types'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MOBI_API = 'https://mobi.kuwo.cn/mobi.s'
const SOURCE = 'kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk'

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
  // 酷我没有可靠的「查询当前登录用户」接口（/api/user/info 已 404），
  // 拿公开榜单接口试探是无效判据 —— 不带 Cookie 也照样 200，会把游客判成已登录。
  // 字段清单读平台定义，避免这里另写一份导致前后两套判据
  const keys = getPlatform('kw')?.loginKeys ?? ['kw_token', 'userid']
  if (!hasLoginKey(cookie, keys)) {
    return { ok: false, verified: 'structural', message: `Cookie 里没有找到 ${keys.join(' / ')}，请确认已登录酷我后再复制` }
  }
  return {
    ok: true,
    verified: 'structural',
    message: '已完成结构校验；酷我不提供可用的登录态查询接口，会员状态以实际取链音质为准',
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
