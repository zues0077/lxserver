/**
 * 咪咕音乐 —— 带账号 Cookie 取链
 *
 * ⚠️ 必须记住的实测事实（2026-10-24，别再凭想象改）：
 *
 * 1) **端点要用 v2.0 + netType=00 + songId=数字内容id。**
 *    旧实现走的 `v2.1/content/listen-url?netType=01&contentId=xx` 会对所有歌统一返回
 *    `code=200000 歌曲下线暂不支持播放` —— 那不是歌真下线了，是请求形态不对被软拒。
 *    换成 `v2.0/content/listen-url?netType=00&resourceType=2&songId={contentId}&toneFlag=SQ`
 *    后全部正常出链（实测 孤勇者/起风了/月亮之上/七里香 全过）。
 *
 * 2) **头必须带全套，最小头（只有 UA+Referer）会被拒 299999「channel不能为空」。**
 *    实测需要：UA + Referer(m.music.migu.cn/v4) + By(设备id) + channel + pacmtoken + Cookie。
 *
 * 3) **toneFlag 是被尊重的，音质标签可以直接按请求档落。**
 *    实测 孤勇者 1139098751：PQ 3.9MB mp3 / HQ 9.8MB mp3 / SQ 27.3MB x-flac（真无损）。
 */

import { request, withTimeout, extFromUrl, hasLoginKey, parseCookie } from '../http'
import { getPlatform } from '../platforms'
import type { AccountResolveResult, AccountInfo } from '../types'

const LISTEN_URL = 'https://c.musicapp.migu.cn/MIGUM2.0/v2.0/content/listen-url'
// 登录态查询（GitHub 实证：Domdkw/miguMusic-api-enhanced user_queryInfo.ts，2026-10-30）。
// 网页 Cookie 里的 pacmtoken 就是凭证；匿名请求回 299999「uid不能为空」，登录后回 000000 + 用户信息。
const USER_INFO_URL = 'https://app.c.nf.migu.cn/pc/user/h5/queryUserInfo/v1.0'
const USER_INFO_CHANNEL = '014X031'
const MIGU_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const CHANNEL = '0146921'
const VERSION = '7.41.13'

/**
 * 咪咕的登录凭证不止在 Cookie 里，接口还认请求头里的 pacmtoken，
 * By 要带设备 id（cookieId / migu-device-uuid 都行），channel 是固定值。
 * 缺任意一个都可能被软拒（299999 / 200000）。
 */
export function authHeaders(cookie: string): Record<string, string> {
  const map = parseCookie(cookie)
  const headers: Record<string, string> = {}
  // 只发 pacmtoken。以前这里还兜底过 migu-utoken-sessionid / LTToken，那是错的：
  // 这两个值格式和用途都不同，拿去冒充 pacmtoken 请求头必然被拒，
  // 而且会掩盖「票真的过期了」这个事实 —— 日志里看不出该刷新，只会一直以为账号坏了。
  const token = map.pacmtoken || ''
  if (token) headers.pacmtoken = token
  const uid = map.mg_auth_uid || map.userid || map.userId || map.uid || ''
  if (uid) headers.uid = uid
  // 设备 id：浏览器 Cookie 自带 cookieId / mgAppH5CookieId；短信登录补的是 migu-device-uuid。
  // 两个都为同一个设备标识服务，但咪咕不同接口认的字段不一样：
  //   - listen-url 这类接口实测认 By 头（旧 lx-music 系实现）
  //   - 真实咪咕 App（geek-server 抓包、Domdkw 实现）统一用 deviceId 请求头
  // 之前短信登录只发了 By，会员档被当成陌生设备软拒（By=有却取不到 SQ）。
  // 两个头都发、值用同一个设备 id，覆盖两种认字段方式。
  const by = map.cookieId || map['migu-device-uuid'] || map['mgAppH5CookieId'] || ''
  if (by) {
    headers.By = by
    headers.deviceId = by
  }
  return headers
}

/**
 * 大小写不敏感地取一个响应头。
 * needle 返回的 headers 本来是小写键，但不同代理/网关改造过大小写，逐键比对更保险。
 */
function pickHeaderCI(headers: any, name: string): string {
  if (!headers || typeof headers !== 'object') return ''
  const want = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() !== want) continue
    const v = (headers as any)[k]
    const s = Array.isArray(v) ? v[0] : v
    if (typeof s === 'string' && s.trim()) return s
  }
  return ''
}

/**
 * 从响应头里取平台刚下发的新 pacmtoken。
 *
 * 这是咪咕保活的核心：平台**每发一次请求都会在响应头里续一张新票**，
 * 浏览器就是靠这个一直不掉线；我们以前把响应头整个丢掉了，所以存的永远是导入那一刻的旧票，
 * 固定 3 小时后失效（2026-10-30 实测：10:07 导入 → 13:06:24 失效，2h59m11s）。
 *
 * 响应头里确有凭据的依据：`Access-Control-Expose-Headers: signature,timestamp,pacmtoken`
 * —— 浏览器 JS 被明确允许读 pacmtoken，说明这就是给客户端拿去续期的。
 */
export function pickPacmTokenFromHeaders(headers: any): string {
  // 两条读法都要支持，实测（2026-10-30，真 Cookie）两种都可能出现：
  //   ① 独立响应头 `pacmtoken:` —— 平台用 Access-Control-Expose-Headers: signature,timestamp,pacmtoken
  //      明确允许前端读，说明这是个可选下发通道；
  //   ② **Set-Cookie: pacmtoken=...; Expires=<签发+2 小时>** —— 实测 queryUserInfo 与
  //      listen-url 都在走这条，是真正在用的主通道。
  // 只认其中一种都可能漏票，漏一次就等于把票冻在旧值上。
  const direct = pickHeaderCI(headers, 'pacmtoken')
  if (direct) {
    let v = direct.trim()
    try { v = decodeURIComponent(v) } catch { /* 编码异常就按原样用 */ }
    if (v) return v
  }

  // ② 兜底：部分网关把新票写在 Set-Cookie 里
  const raw = headers?.['set-cookie']
  const list: string[] = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : [])
  for (const line of list) {
    const text = String(line || '')
    const m = text.match(/(?:^|;\s*)pacmtoken=([^;]*)/i)
    if (!m) continue
    // Max-Age=0 / 值为空 = 平台在「清空」这张票（凭证无效时的标准回法），不是新票
    if (/max-age\s*=\s*0/i.test(text)) continue
    let v = m[1] || ''
    try { v = decodeURIComponent(v) } catch { /* 编码异常就按原样用 */ }
    v = v.trim()
    if (v) return v
  }
  return ''
}

/** 把新票并回 Cookie 串：只替换 pacmtoken 这一项，其余字段原样保留 */
export function mergePacmToken(cookie: string, token: string): string {
  if (!token) return cookie
  const parts = String(cookie || '').split(';').map(s => s.trim()).filter(Boolean)
  let replaced = false
  const out = parts.map((p) => {
    const i = p.indexOf('=')
    if (i > 0 && p.slice(0, i).trim().toLowerCase() === 'pacmtoken') {
      replaced = true
      return `pacmtoken=${token}`
    }
    return p
  })
  if (!replaced) out.push(`pacmtoken=${token}`)
  return out.join('; ')
}

const TOKEN_VALIDATE_URL = 'https://c.musicapp.migu.cn/user/h5/token-validate/v3.0'

/**
 * 用长期凭证 LTToken 换一张新的 pacmtoken —— 「票已经过期、保温断了」时的兜底。
 *
 * 注意别把它当主路径：实测（2026-10-30）浏览器重新登录后导出的 Cookie 里**没有 LTToken**，
 * 只有 pacmtoken + migu-utoken-sessionid + mg_auth_sid 等会话字段。
 * 也就是说绝大多数账号根本走不到这条路，真正撑住不掉线的是保温：
 * 平台每响应一次就下发一张新票（Set-Cookie，签发 +2 小时），接住就永不到期。
 * 本函数只在「老 Cookie 恰好带 LTToken」时才有用，缺了也不代表账号已失效。
 *
 * 接口实证：Domdkw/miguMusic-api-enhanced `passport_pacmToken.ts`；
 * 参数 type=2 / sourceId=220029 / activityId=MUSIC-WWW，Cookie 只需 idmpauth 标记。
 */
export async function refreshPacmToken(cookie: string): Promise<{ ok: boolean; cookie?: string; error?: string }> {
  const map = parseCookie(cookie)
  const ltToken = map.LTToken || map.lttoken || map.LtToken || ''
  if (!ltToken) {
    // 这不是错误：浏览器登录本来就不一定下发 LTToken。
    // 写成「无法续期」而不写「请重新登录」，避免把「没这条兜底」误报成「账号失效」。
    return { ok: false, error: '这份 Cookie 没有 LTToken，走不了换票兜底（只能靠每次响应续票保温）' }
  }
  const qs = new URLSearchParams({
    token: ltToken,
    type: '2',
    sourceId: '220029',
    activityId: 'MUSIC-WWW',
  })
  try {
    const resp = await withTimeout(request(`${TOKEN_VALIDATE_URL}?${qs.toString()}`, {
      headers: {
        'User-Agent': MIGU_UA,
        Origin: 'https://music.migu.cn',
        Referer: 'https://music.migu.cn/',
        Cookie: 'idmpauth=true@passport.migu.cn',
      },
    }), 8000, '咪咕换票')
    const fresh = pickPacmTokenFromHeaders(resp.headers)
    if (!fresh) {
      return { ok: false, error: `平台未下发新 pacmtoken（HTTP ${resp.statusCode}），LTToken 可能也已失效` }
    }
    return { ok: true, cookie: mergePacmToken(cookie, fresh) }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** LX 音质 → 咪咕 toneFlag（从高到低） */
const TONE_CHAIN: Array<{ tone: string; quality: string; vip: boolean }> = [
  { tone: 'ZQ', quality: 'flac24bit', vip: true },
  { tone: 'SQ', quality: 'flac', vip: true },
  { tone: 'HQ', quality: '320k', vip: true },
  { tone: 'PQ', quality: '128k', vip: false },
]

function pickIds(songInfo: any): { contentId: string; copyrightId: string } {
  return {
    contentId: String(songInfo?.songmid ?? songInfo?.meta?.songId ?? songInfo?.id ?? ''),
    copyrightId: String(songInfo?.copyrightId ?? songInfo?.meta?.copyrightId ?? ''),
  }
}

/**
 * 会员权益探针。
 *
 * 咪咕没有可用的「查我是谁 / 我是不是会员」接口（userInfo.do 返回「路由请求不支持」），
 * 所以退一步用**取链行为**反推：同一首热门曲，匿名请求 SQ/HQ 会返回
 * `code=000000 操作成功` 但 **data.url 为空**，只有带上会员 Cookie 才给 url（2026-10-29 实测）。
 * PQ(128k) 匿名也能拿到 url —— 用它区分「确实没会员」和「探针曲本身失效」，
 * 避免把「这首歌下架了」误报成「你没有会员」。
 */
const PROBE_CONTENT_ID = '1139098751' // 孤勇者（陈奕迅），SQ 需会员

async function probeTone(cookie: string, tone: string, ms: number): Promise<{ ok: boolean; cannotCode?: string; dialogText?: string; newPacmToken?: string }> {
  const params = new URLSearchParams({
    netType: '00',
    resourceType: '2',
    songId: PROBE_CONTENT_ID,
    toneFlag: tone,
  })
  try {
    const resp = await withTimeout(request(`${LISTEN_URL}?${params.toString()}`, {
      headers: {
        'User-Agent': MIGU_UA,
        Referer: 'https://m.music.migu.cn/v4',
        channel: CHANNEL,
        version: VERSION,
        Cookie: cookie,
        ...authHeaders(cookie),
      },
    }), ms, `咪咕${tone}探针`)
    const body: any = resp.body
    const code = String(body?.code ?? '')
    const url = String(body?.data?.url || '')
    const newPacmToken = pickPacmTokenFromHeaders(resp.headers)
    if (!url) {
      // 打一行诊断：区分「设备 id 缺失被软拒」和「真的没有会员权益 / 是试用会员」。
      // By 来自 Cookie 里的设备字段，浏览器 Cookie 天然有，短信登录要自己补。
      // 把完整返回体也带上（截断），便于看咪咕到底是「无权益」还是「试用不含无损」。
      const cannotCode = String(body?.data?.cannotCode ?? '')
      const dialogText = String(body?.data?.dialogInfo?.text ?? '')
      console.log(
        `[平台账号] 咪咕${tone}探针未出 url：code=${code || '-'} info=${body?.info || body?.message || '-'} ` +
          `By=${authHeaders(cookie).By ? '有' : '缺'} cannotCode=${cannotCode || '-'} body=${JSON.stringify(body)?.slice(0, 400)}`,
      )
      return { ok: false, cannotCode, dialogText, ...(newPacmToken ? { newPacmToken } : {}) }
    }
    if (code && code !== '000000') {
      return { ok: false, ...(newPacmToken ? { newPacmToken } : {}) }
    }
    return { ok: true, ...(newPacmToken ? { newPacmToken } : {}) }
  } catch {
    return { ok: false }
  }
}

/**
 * 三档探测：SQ(无损) → HQ(320k) → PQ(128k)。
 * 用来区分「真·无损会员 / 试用受限会员 / 无会员」三态：
 *   - SQ 出链：完整会员，无损可听；
 *   - SQ 空但 HQ 出链：多半是**试用 / 受限会员**（咪咕试用通常不含无损，只到 320k），
 *     这种情况账号确实「有权限」，只是不到无损档，UI 要如实说清楚，别误报成「完全没会员」；
 *   - HQ 也空、仅 PQ 出链：账号没有任何音频会员权益（咪咕会回 cannotCode=440008「需开通会员」）。
 * 三档全空：探针曲本次不可用，不要误报。
 */
async function probeVip(cookie: string): Promise<{ vip: boolean | null; tier: string; note: string; cannotCode?: string; newPacmToken?: string }> {
  // 探针请求同样会带回新票，逐档收集最近一次拿到的（后面的档位票更新）
  let freshToken = ''
  const sq = await probeTone(cookie, 'SQ', 4500)
  if (sq.newPacmToken) freshToken = sq.newPacmToken
  const tail = () => (freshToken ? { newPacmToken: freshToken } : {})
  if (sq.ok) {
    return { vip: true, tier: 'SQ', note: '会员权益生效，实测可取 SQ 无损', ...tail() }
  }
  const hq = await probeTone(cookie, 'HQ', 4500)
  if (hq.newPacmToken) freshToken = hq.newPacmToken
  if (hq.ok) {
    return {
      vip: true,
      tier: 'HQ',
      note: '检测到受限/试用会员：可取 HQ 320k，但 SQ 无损被拒（咪咕试用会员通常不含无损）',
      ...tail(),
    }
  }
  const pq = await probeTone(cookie, 'PQ', 4500)
  if (pq.newPacmToken) freshToken = pq.newPacmToken
  if (pq.ok) {
    // SQ/HQ 都被 440008 拒 → 账号确实没有高品质/无损音频权益。
    // 把咪咕的原始 cannotCode + 文案透出来，用户一眼知道是「权益不足」而非「登录故障」。
    const reason = sq.cannotCode || hq.cannotCode
    const text = sq.dialogText || hq.dialogText
    const extra = reason ? `（咪咕返回 ${reason}${text ? '：' + text : ''}）` : ''
    return {
      vip: false,
      tier: 'PQ',
      note: `账号没有可用音频会员权益（或试用不含音频特权），实测最高只到 PQ 128k${extra}`,
      ...(reason ? { cannotCode: reason } : {}),
      ...tail(),
    }
  }
  return { vip: null, tier: 'unknown', note: '探针曲本次不可用，会员状态以实际播放音质为准', ...tail() }
}

/**
 * 从 queryUserInfo 响应体里取平台侧用户 id。
 *
 * 为什么单拎成纯函数：这是「认号」的唯一依据，写错了不会报错、只会静默认错号，
 * 必须能被单测钉住。取值口径对照 MuLiuSaMa/NexBox `music_api/migu.rs::login_info`：
 * 读 `userInfoItem.userId`，`data` 包一层时也认。
 *
 * 为什么需要它：咪咕网页登录后的 Cookie 里**没有 userid**（实测 15 个字段全是
 * idmpauth / pacmtoken / migu-utoken-sessionid 这类会话字段），
 * 于是「一键同步推上来的是新号还是老号」认不出来，只能落回「覆盖主账号」的老语义 ——
 * 推一个浏览器登录的号就把主账号顶掉了（用户 2026-10-30 报的就是这个）。
 */
export function pickUserIdFromBody(body: any): string {
  const u = body?.userInfoItem || body?.data?.userInfoItem || body?.data
  const raw = u?.userId ?? u?.userid
  if (raw == null) return ''
  const v = String(raw).trim()
  // 咪咕的 userId 是 23 位纯数字长串（实测形如 1568…9108）。
  // 非数字/过短一律不认 —— 避免把占位值（0、''、'null'）当成身份，
  // 那种情况比「没有 uid」更糟：会把正经账号认成一个共同的假号。
  return /^\d{6,32}$/.test(v) ? v : ''
}

/**
 * 登录态 + 会员档位查询：官方 H5 用户信息接口。
 *
 * 实证来源（2026-10-30 对照两处开源实现）：
 *   - Domdkw/miguMusic-api-enhanced `user_queryInfo.ts`：凭证只放 Cookie 里的 pacmtoken；
 *   - MuLiuSaMa/NexBox `music_api/migu.rs::login_info`：**只发 Cookie 头**（连 channel 都不带），
 *     响应里读 `userInfoItem`（userId / nickName / vipFlag / vipStatus / vipLevel / vipEndTime），
 *     判定成功与否看 `userInfoItem.userId` 是否为空，**不看 code**。
 *
 * 之前踩的坑（别再犯）：
 *   1) 去读 `body.data` —— 实际字段是 `body.userInfoItem`，登录成功也读不到 → 误报「查询不可用」；
 *   2) 加了一堆 header（channel/pacmtoken/By/uid）反而可能被网关拒；
 *      匿名或凭证无效时网关统一回 `299999 uid不能为空`，那不是「缺 uid 参数」，是「没解出登录态」。
 */
async function queryUserInfo(
  cookie: string,
  timeoutMs = 8000,
): Promise<{ online: boolean; uid?: string; nickname?: string; isVip?: boolean; newPacmToken?: string }> {
  const attempts: Array<Record<string, string>> = [
    // ① 照 NexBox：最小头，只要有 Cookie（实测最稳）
    { 'User-Agent': MIGU_UA, Cookie: cookie },
    // ② 兜底：补上 channel/Referer 与解析出的 token 头
    {
      'User-Agent': MIGU_UA,
      Referer: 'https://music.migu.cn/',
      channel: USER_INFO_CHANNEL,
      Cookie: cookie,
      ...authHeaders(cookie),
    },
  ]
  // 两次尝试里任何一次带回新票都留着：票还有效时平台会顺手续期，这就是「保温」的入口
  let freshToken = ''
  for (const headers of attempts) {
    try {
      const resp = await withTimeout(request(USER_INFO_URL, { headers }), timeoutMs, '咪咕用户信息')
      const rotated = pickPacmTokenFromHeaders(resp.headers)
      if (rotated) freshToken = rotated
      const body: any = resp.body
      const uid = pickUserIdFromBody(body)
      if (!uid) {
        console.log(`[平台账号] 咪咕用户信息未解析出 uid：code=${body?.code ?? '-'} info=${body?.info || body?.message || '-'} body=${JSON.stringify(body)?.slice(0, 240)}`)
        continue
      }
      const u = body?.userInfoItem || body?.data?.userInfoItem || body?.data || {}
      const nickname = String(u.nickName || u.nickname || '').trim()
      // VIP 判定：字段名各家实现都在猜，这里按「出现任一 VIP 字段才下结论」，
      // 全都没有则返回 undefined（交给取链探针），绝不默默算成会员。
      const truthy = (v: any) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'
      const hasVipField = ['vipFlag', 'vipStatus', 'isVip', 'vipLevel', 'vipEndTime'].some(k => u[k] != null && u[k] !== '')
      let isVip: boolean | undefined
      if (hasVipField) {
        const level = Number(u.vipLevel ?? 0)
        const end = Number(u.vipEndTime ?? 0)
        isVip = truthy(u.vipFlag) || truthy(u.vipStatus) || truthy(u.isVip) || level > 0 || (end > 0 && end > Date.now())
      }
      return { online: true, uid, ...(nickname ? { nickname } : {}), ...(isVip === undefined ? {} : { isVip }), ...(freshToken ? { newPacmToken: freshToken } : {}) }
    } catch (e: any) {
      console.log(`[平台账号] 咪咕用户信息请求失败：${e?.message || e}`)
    }
  }
  return { online: false, ...(freshToken ? { newPacmToken: freshToken } : {}) }
}

/**
 * 问一次平台「这份 Cookie 是哪个号」，返回稳定 user id。
 *
 * 用途只有一个：**保存账号时认号**。咪咕浏览器 Cookie 没有 userid，
 * 认不出号就会走「覆盖主账号」，这是用户实际踩到的数据损失
 * （推一个浏览器登录的号，把主账号整个顶掉）。
 *
 * 刻意只给短预算：这是保存链路，用户在界面上等结果，不能为了认号卡 8 秒。
 * 认不出来就返回空串，调用方退回老语义（并把这件事写进日志，便于排查）。
 */
export async function resolveUid(cookie: string): Promise<string> {
  if (!String(cookie || '').trim()) return ''
  const keys = getPlatform('mg')?.loginKeys ?? ['*pacmtoken*', '*utoken*']
  if (!hasLoginKey(cookie, keys)) return ''
  const info = await queryUserInfo(cookie, 3500)
  return info.uid || ''
}

export async function getAccountInfo(cookie: string): Promise<AccountInfo> {
  // 字段清单必须读平台定义，不能在这里另写一份：
  // 网页版登录后的字段是 idmpauth / pacmtoken / migu-utoken-sessionid / LTToken，
  // 早先这里写死成 migu_music / USERTICKET / pusk，结果登录了也一律判「没找到登录字段」。
  const keys = getPlatform('mg')?.loginKeys ?? ['*pacmtoken*', '*utoken*']
  if (!hasLoginKey(cookie, keys)) {
    return { ok: false, verified: 'structural', message: `Cookie 里没有找到登录字段（${keys.join(' / ')}），请确认已登录咪咕后再复制` }
  }
  // 两步实测：
  // ① queryUserInfo —— 登录态是否被服务端承认，并直接读出 VIP 字段（权威信号）；
  // ② 取链探针 —— 实测能拿到哪一档音质（用户真正关心的）。
  // 注意：探针不能单独当会员判据。实测（2026-10-30）非会员号登录后也能取 SQ
  // （咪咕对「登录用户」就放开了这首探针曲），只看探针会把非会员误标成会员。
  //
  // 咪咕特有：这两条请求的响应头都会顺带下发新 pacmtoken，拿到就立刻落回 current，
  // 最后由 refreshedCookie 交给编排层写库 —— 不接这个，票就永远停在导入那一刻。
  let current = cookie
  const absorb = (t?: string) => {
    if (t) current = mergePacmToken(current, t)
  }

  let probe = await probeVip(current)
  let user = await queryUserInfo(current)
  absorb(user.newPacmToken)
  absorb(probe.newPacmToken)

  // 认不到登录态 = 票大概率已过期（实测固定 3 小时）。趁手里还有 LTToken，
  // 立刻换一张新票再判一次：能救活就说明只是票过期，而不是账号真失效。
  if (!user.online) {
    const renewed = await refreshPacmToken(current)
    if (renewed.ok && renewed.cookie) {
      console.log('[平台账号] 咪咕 pacmtoken 已用 LTToken 续期，重新校验一次')
      current = renewed.cookie
      probe = await probeVip(current)
      user = await queryUserInfo(current)
      absorb(user.newPacmToken)
      absorb(probe.newPacmToken)
    } else {
      console.log(`[平台账号] 咪咕续期未成功：${renewed.error || '未知原因'}`)
    }
  }

  const refreshedCookie = current !== cookie ? current : undefined
  const withRefresh = <T extends object>(o: T): T => (refreshedCookie ? { ...o, refreshedCookie } : o)

  if (user.online) {
    const vip = user.isVip === undefined ? probe.vip : user.isVip
    const nick = user.nickname ? `（${user.nickname}）` : ''
    const vipText = vip === true ? '会员（VIP）有效' : vip === false ? '已登录，当前非会员（VIP）' : '会员档位未识别'
    return withRefresh({
      ok: true,
      verified: 'online',
      ...(user.nickname ? { nickname: user.nickname } : {}),
      ...(vip === null || vip === undefined ? {} : { isVip: vip }),
      // 顺手把平台侧 userId 透出去：编排层会把它补进账号条目，
      // 以后一键同步就能按号认领，不会再出现「推个新号覆盖主账号」。
      ...(user.uid ? { uid: user.uid } : {}),
      message: `登录态有效${nick}，${vipText}；${probe.note}`,
    })
  }
  // 查不到登录态。若探针表现与匿名请求一致（VIP 曲同样回 440006「请先登录」），
  // 说明服务端没把我们当登录用户 —— Cookie 疑似失效，用 ok:false 让健康度亮「待确认」。
  if (probe.tier === 'PQ' && probe.cannotCode === '440006') {
    return withRefresh({
      ok: false,
      verified: 'structural' as const,
      ...(probe.vip === null ? {} : { isVip: probe.vip }),
      message: '结构校验通过；但服务端未识别登录态（取链表现与匿名请求一致，咪咕回 440006「请先登录」），Cookie 疑似已失效，请重新获取',
    })
  }
  // 探针也判不出来（如探针曲不可用）：如实只说结构校验，不妄下结论。
  // 不把 probe.vip 写进 isVip —— 探针只能证明「能取到哪档音质」，不能证明会员身份。
  return withRefresh({
    ok: true,
    verified: 'structural' as const,
    message: `结构校验通过；登录态查询未返回用户信息，会员档位无法确认（${probe.note}）`,
  })
}

/** 单轮取链（不刷新）。抽出来是为了让外层「票过期 → 换票 → 重试一次」的逻辑干净。 */
async function resolveOnce(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const { contentId } = pickIds(songInfo)
  if (!contentId) return { ok: false, error: '歌曲缺少咪咕 contentId，无法用账号取链' }

  const start = TONE_CHAIN.findIndex(t => t.quality === quality)
  const chain = start >= 0 ? TONE_CHAIN.slice(start) : TONE_CHAIN.slice(2)

  let lastError = ''
  let rotated = ''
  for (const item of chain) {
    // v2.0 形态：netType=00 + songId=数字内容id（contentId/copyrightId 形态都会被「下线」软拒）
    const params = new URLSearchParams({
      netType: '00',
      resourceType: '2',
      songId: contentId,
      toneFlag: item.tone,
    })

    try {
      const resp = await withTimeout(request(`${LISTEN_URL}?${params.toString()}`, {
        headers: {
          'User-Agent': MIGU_UA,
          Referer: 'https://m.music.migu.cn/v4',
          channel: CHANNEL,
          version: VERSION,
          Cookie: cookie,
          ...authHeaders(cookie),
        },
      }), 12000, '咪咕取链')

      const body: any = resp.body
      // 取链请求同样会顺手把新票带回来，攒着交给编排层写库
      const fresh = pickPacmTokenFromHeaders(resp.headers)
      if (fresh) rotated = fresh
      const cannotCode = String(body?.data?.cannotCode ?? '')
      // 咪咕用字符串 code，'000000' 才是成功；单档失败降级继续，不中断整个链
      if (body?.code && body.code !== '000000') {
        lastError = `${item.tone}:${body.info || body.code}${cannotCode ? `(${cannotCode})` : ''}`
        continue
      }
      const url = String(body?.data?.url || '')
      if (url) {
        return {
          ok: true,
          url,
          quality: item.quality,
          isVip: item.vip,
          via: `listen-url:${item.tone}`,
          ext: extFromUrl(url),
          ...(rotated ? { refreshedCookie: mergePacmToken(cookie, rotated) } : {}),
        }
      }
      // code 是 000000 但没出 url：把 cannotCode 也记下来，
      // 外层靠它判断是「票过期（440006）」还是「版权受限」，只把前者送去换票重试。
      lastError = `${item.tone}:无 url${cannotCode ? `(${cannotCode})` : ''}`
    } catch (e: any) {
      lastError = `${item.tone}:${e.message}`
    }
  }

  return { ok: false, error: `咪咕未返回可用链接（${lastError || '多为版权受限'}）` }
}

export async function resolve(songInfo: any, quality: string, cookie: string): Promise<AccountResolveResult> {
  const first = await resolveOnce(songInfo, quality, cookie)
  if (first.ok) return first

  // 只有「登录态没被认」才值得换票重试：440006 = 请先登录，299999 = uid不能为空。
  // 版权受限（440008 等）换票也没用，反而白刷一次接口。
  if (!/440006|299999|请先登录/.test(first.error || '')) return first

  const renewed = await refreshPacmToken(cookie)
  if (!renewed.ok || !renewed.cookie) {
    console.log(`[平台账号] 咪咕取链失败后换票未成功：${renewed.error || '未知原因'}`)
    return first
  }
  console.log('[平台账号] 咪咕取链遇登录态失效，已用 LTToken 换票后重试一次')
  const second = await resolveOnce(songInfo, quality, renewed.cookie)
  if (second.ok) return { ...second, refreshedCookie: second.refreshedCookie || renewed.cookie }
  return first
}
