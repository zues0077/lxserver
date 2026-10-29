/**
 * 账号身份识别
 *
 * 解决的问题：「扫码登录算新号还是老号」不能靠用户先点「添加账号」来区分 ——
 * 那是把判断责任推给用户，他自己也未必记得列表里存过哪些号。
 *
 * 做法：从 Cookie 里取平台的**稳定用户 id**（uid），同号就更新那一条、不同号才新增。
 *
 * 关键约束：只认「不会变」的字段。
 *   - 酷狗 KugooID / 酷我 userid / 咪咕 userid / B站 DedeUserID / QQ uin：用户维度唯一且稳定 → 认。
 *   - 网易 MUSIC_U、汽水 sessionid：每次登录都会换新值 → 不认，
 *     否则重登一次就多出一个不参与取链的冷备号。这两个平台退回「覆盖主账号」的老语义。
 *
 * 独立成模块（不放在 index.ts）是为了让 qrLogin 能直接引用：
 * qrLogin ← index 已经是一条依赖边，反过来再引 index 就成环了。
 */

import * as crypto from 'node:crypto'
import { getPlatform } from './platforms'
import { parseCookie } from './http'

export interface AccountIdentity {
  /** 平台稳定用户 id，取不到就没有 */
  uid?: string
  /** Cookie 整体指纹：同一份 Cookie 再次导入时能认出来 */
  cookieHash: string
}

/** QQ 的 uin 常带 o 前缀（o0123456789），统一去掉再小写比较 */
function normalizeUid(raw: string): string {
  return String(raw || '').trim().replace(/^o(?=\d)/i, '').toLowerCase()
}

export function extractAccountIdentity(platform: string, cookie: string): AccountIdentity {
  const pairs = parseCookie(cookie)
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(pairs)) lower[k.toLowerCase()] = v

  let uid = ''
  for (const key of getPlatform(platform)?.uidKeys || []) {
    const v = normalizeUid(lower[String(key).toLowerCase()] || '')
    if (v) { uid = v; break }
  }

  // 指纹用「排序后的 k=v」算：同一份 Cookie 换个顺序粘贴不该被算成两个账号
  const canonical = Object.keys(pairs).sort()
    .map(k => `${k.toLowerCase()}=${pairs[k]}`).join('&')
  const cookieHash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)

  return uid ? { uid, cookieHash } : { cookieHash }
}
