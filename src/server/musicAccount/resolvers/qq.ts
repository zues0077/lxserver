/**
 * QQ音乐 —— 带账号 Cookie 取链
 *
 * 走 `music.vkey.GetVkey` 的 `UrlGetVkey`，用 filename 指定音质档位，
 * 成功后把返回的 purl 拼到 `https://ws.stream.qqmusic.qq.com/` 前面。
 *
 * 关键点：请求体里的 `uin` 必须与 Cookie 里的登录 uin 一致，否则按游客处理，
 * 实测游客状态下 purl 恒为空 —— 这就是为什么必须把 uin 从 Cookie 里抠出来带上。
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
 */
async function getVkey(songmids: string[], filenames: string[], uin: string, cookie: string): Promise<string[]> {
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
      uin: Number(uin) || 0,
    },
    req_1: {
      module: 'music.vkey.GetVkey',
      method: 'UrlGetVkey',
      param: {
        guid: randomGuid(),
        songmid: songmids,
        songtype: songmids.map(() => 0),
        uin,
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
  // QQ音乐没有公开的「查当前登录用户」接口，只能用 uin + qm_keyst 的存在性判断，
  // 所以这里如实标 structural，不谎称已验证会员身份。
  return {
    ok: true,
    verified: 'structural',
    nickname: `QQ账号 ${uin}`,
    message: '已完成结构校验（uin + qm_keyst 均存在）；会员状态以实际取链音质为准',
  }
}

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const mid = String(songInfo?.songmid ?? songInfo?.meta?.songId ?? songInfo?.strMediaMid ?? '')
  if (!mid) return { ok: false, error: '歌曲缺少 QQ songmid，无法用账号取链' }

  const uin = uinOf(cookie)
  if (uin === '0') {
    return { ok: false, error: 'Cookie 未包含登录 uin，请先重新抓取登录后的 Cookie' }
  }

  // 组装候选：从请求音质往下退，直到 128k
  const wanted = QUALITY_TABLE.findIndex(q => q.quality === quality)
  const chain = wanted >= 0 ? QUALITY_TABLE.slice(wanted) : QUALITY_TABLE.slice(5)
  if (!chain.length) return { ok: false, error: `不支持的音质：${quality}` }

  const filenames = chain.map(q => `${q.prefix}${mid}${mid}.${q.ext}`)
  const songmids = chain.map(() => mid)

  let purls: string[] = []
  try {
    purls = await withTimeout(getVkey(songmids, filenames, uin, cookie), 15000, 'QQ vkey 取链')
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

  return { ok: false, error: 'QQ 未返回可用链接（多为版权受限、非会员或 Cookie 过期）' }
}
