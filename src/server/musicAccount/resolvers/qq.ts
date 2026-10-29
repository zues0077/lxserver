/**
 * QQ音乐 —— 带账号 Cookie 取链
 *
 * 走 `music.vkey.GetVkey` 的 `UrlGetVkey`，用 filename 指定音质档位，
 * 成功后把返回的 purl 拼到 `https://ws.stream.qqmusic.qq.com/` 前面。
 *
 * ⚠️ 必须记住的实测事实（2026-10-24，别再凭想象改）：
 *
 * 1) **payload 里不能带真实 uin，鉴权完全靠 Cookie。**
 *    微信登录的 Cookie 里 uin 是 1152921504822229000 这种超出 JS 安全整数的数，
 *    一转 Number 就精度失真，整个请求被拒 `req_1.code=104009`（连免费歌都全灭）。
 *    实测 `comm.uin=0` + `param.uin=''` + Cookie 里带 qm_keyst：免费歌正常出链（HTTP 206），
 *    服务端还会把 filename 自动改写成歌曲真实的 media_mid。
 *
 * 2) **付费歌（pay_play=1）没有绿钻就是拿不到 purl**——midurlinfo 里 purl 为空串，
 *    这是权限问题不是代码问题，错误信息里要说清楚，让用户知道该换歌而不是去修 bug。
 */

import { request, withTimeout, parseCookie, extFromUrl } from '../http'
import type { AccountResolveResult, AccountInfo } from '../types'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const REFERER = 'https://y.qq.com/'
const STREAM_PREFIX = 'https://ws.stream.qqmusic.qq.com/'

/** 音质档位：前缀 + 扩展名 + 对应 LX 音质标识 */
const QUALITY_TABLE: Array<{ prefix: string; ext: string; quality: string; vip: boolean }> = [
  { prefix: 'AI00', ext: 'flac', quality: 'master', vip: true },     // 臻品母带
  { prefix: 'Q001', ext: 'flac', quality: 'atmos_plus', vip: true }, // 臻品全景声
  { prefix: 'Q000', ext: 'flac', quality: 'atmos', vip: true },      // 臻品音质
  { prefix: 'F000', ext: 'flac', quality: 'flac', vip: true },       // SQ 无损
  { prefix: 'O801', ext: 'ogg', quality: '320k', vip: true },        // 640k ogg
  { prefix: 'M800', ext: 'mp3', quality: '320k', vip: false },       // 320k
  { prefix: 'M500', ext: 'mp3', quality: '128k', vip: false },       // 128k
]

function randomGuid(): string {
  return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
}

/** 从 Cookie 提取登录 uin；取不到按游客 0 处理 */
function uinOf(cookie: string): string {
  const map = parseCookie(cookie)
  // 浏览器里的 QQ uin 常带前缀 o（如 uin=o0123456789），接口只认纯数字，先剥掉再校验
  const raw = String(map['uin'] || map['wxuin'] || '').trim().replace(/^[oO]/, '')
  return /^\d+$/.test(raw) ? (raw.replace(/^0+(?=\d)/, '') || '0') : '0'
}

/**
 * 批量查询 vkey。filenames 与 songmids 一一对应，
 * 返回与 filenames 同序的 purl 数组（拿不到则为空串）。
 *
 * uin 一律传 0 / ''：鉴权只认 Cookie（见文件头说明），
 * 真实 uin（尤其微信登录的超长数字）放进去反而触发 104009 全灭。
 */
async function getVkey(songmids: string[], filenames: string[], cookie: string): Promise<string[]> {
  const payload = {
    comm: {
      cv: 4747474,
      ct: 24,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 1,
      uin: 0,
    },
    req_1: {
      module: 'music.vkey.GetVkey',
      method: 'UrlGetVkey',
      param: {
        guid: randomGuid(),
        songmid: songmids,
        songtype: songmids.map(() => 0),
        uin: '',
        loginflag: 1,
        platform: '20',
        filename: filenames,
      },
    },
  }

  const resp = await request(MUSICU, {
    method: 'post',
    headers: { 'User-Agent': UA, Referer: REFERER, 'Content-Type': 'application/json', Cookie: cookie },
    json: payload,
  })

  const list: any[] = resp?.body?.req_1?.data?.midurlinfo || []
  // 按 filename 建索引，避免平台返回顺序与请求顺序不一致导致错配
  const byName = new Map<string, string>()
  for (const item of list) {
    if (item?.filename) byName.set(String(item.filename), String(item.purl || ''))
  }
  return filenames.map(f => byName.get(f) || '')
}

/**
 * VIP 探针：对一首确定收费的歌试取 vkey，拿到 purl 即账号有会员权益。
 *
 * 为什么不用 music.vipuser.vipUserInfo：实测（2026-10-30）用户信息类模块全部要求
 * App 级签名，网页 Cookie（qm_keyst）只对 vkey 通道有效——comm.uin 带真实值/置 0、
 * cv 换新版本号，一律 code=500003 subcode=860100001。
 * 所以照咪咕 probeVip 的思路：不问「我的会员状态」，直接验证「权益本身」。
 *
 * 选曲：周杰伦《晴天》songmid=0039MnYb0qxYhV（多年稳定收费），
 * mediaMid=003Qui1q2u1Zho（2026-10-30 从聚合源返回的真实文件名 C400003Qui1q2u1Zho.m4a 反查）。
 * 返回：true=有会员权益；false=探针正常返回但拿不到（大概率非会员）；
 *       null=探针自身失败（网络/超时），不能下结论。
 */
const VIP_PROBE_SONGMID = '0039MnYb0qxYhV'
const VIP_PROBE_MEDIA_MID = '003Qui1q2u1Zho'

async function probeVipByVkey(cookie: string): Promise<boolean | null> {
  const m = VIP_PROBE_MEDIA_MID
  const filenames = [`F000${m}${m}.flac`, `M800${m}${m}.mp3`, `M500${m}${m}.mp3`]
  const mids = filenames.map(() => VIP_PROBE_SONGMID)
  try {
    const purls = await withTimeout(getVkey(mids, filenames, cookie), 15000, 'QQ VIP 探针')
    return purls.some(p => !!p)
  } catch (e: any) {
    console.warn('[QQ] VIP 探针失败（不下结论）:', e?.message || e)
    return null
  }
}

export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  const map = parseCookie(cookie)
  const uin = uinOf(cookie)
  const hasKey = !!(map['qm_keyst'] || map['wxrefresh_token'])
  if (uin === '0') {
    return { ok: false, message: 'Cookie 中未找到 uin，无法确认登录态' }
  }
  if (!hasKey) {
    return { ok: false, message: 'Cookie 缺少 qm_keyst，QQ音乐会按游客处理，付费与无损将取不到' }
  }
  // 会员打标：付费曲 vkey 探针（见 probeVipByVkey 注释）。探针失败不阻断登录，退化为 structural。
  const probe = await probeVipByVkey(cookie)
  if (probe !== null) {
    return {
      ok: true,
      verified: 'online',
      isVip: probe,
      nickname: `QQ账号 ${uin}`,
      message: probe
        ? '已登录，会员权益有效（付费曲探针命中，可取 SQ/无损）'
        : '已登录，当前无会员权益（付费曲探针未命中）；以实际取链音质为准',
    }
  }
  return {
    ok: true,
    verified: 'structural',
    nickname: `QQ账号 ${uin}`,
    message: '已完成结构校验（uin + qm_keyst 均存在）；会员探针网络异常，会员状态以实际取链音质为准',
  }
}

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const mid = String(songInfo?.songmid ?? songInfo?.meta?.songId ?? songInfo?.strMediaMid ?? '')
  if (!mid) return { ok: false, error: '歌曲缺少 QQ songmid，无法用账号取链' }
  // filename 要用 strMediaMid（文件资源的 media_mid），songmid 只是歌曲 id；
  // 没有 strMediaMid 时先拿 songmid 顶着，服务端会对免费歌自动改写成真实 media_mid
  const mediaMid = String(songInfo?.strMediaMid ?? songInfo?.meta?.mediaMid ?? mid) || mid

  // uin 只用作「是否带登录态」的判断，不再参与请求（见文件头说明）
  const uin = uinOf(cookie)
  if (uin === '0') {
    return { ok: false, error: 'Cookie 未包含登录 uin，请先重新抓取登录后的 Cookie' }
  }

  // 组装候选：从请求音质往下退，直到 128k
  const wanted = QUALITY_TABLE.findIndex(q => q.quality === quality)
  const chain = wanted >= 0 ? QUALITY_TABLE.slice(wanted) : QUALITY_TABLE.slice(5)
  if (!chain.length) return { ok: false, error: `不支持的音质：${quality}` }

  const filenames = chain.map(q => `${q.prefix}${mediaMid}${mediaMid}.${q.ext}`)
  const songmids = chain.map(() => mid)

  let purls: string[] = []
  try {
    purls = await withTimeout(getVkey(songmids, filenames, cookie), 15000, 'QQ vkey 取链')
  } catch (e: any) {
    return { ok: false, error: `QQ 取链失败：${e.message}` }
  }

  for (let i = 0; i < chain.length; i++) {
    if (!purls[i]) continue
    const url = STREAM_PREFIX + purls[i]
    return {
      ok: true,
      url,
      quality: chain[i].quality,
      isVip: chain[i].vip,
      via: `vkey:${chain[i].prefix}`,
      ext: extFromUrl(url) || chain[i].ext,
    }
  }

  return { ok: false, error: 'QQ 未返回可用链接：该曲多为付费/版权受限曲目（当前账号无绿钻权益拿不到），或 Cookie 已过期' }
}
