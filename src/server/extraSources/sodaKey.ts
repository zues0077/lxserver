/**
 * 汽水解密密钥抓取。
 *
 * 单独成模块的理由：这里只依赖 crypto（`utils/sodaDecrypt`），不碰 signer / store / request，
 * 于是可以被单元测试直接 import —— 而 `extraSources/soda.ts` 一 import 就会连带拉起
 * 那些有副作用的网络与配置依赖，没法在测试里用。
 *
 * 背景（完整推导见 `utils/sodaDecrypt.ts` 头部）：
 * 汽水正式版权曲下发的是 CENC 加密 MP4，其 AES-128 密钥按参考实现应随取链响应以
 * `play_auth` → `spade_a`（Base64）下发。
 *
 * ⚠️ 2026-10-28 在 246 的实测结论（重要，别重复试错）：
 * 在「汽水账号已登录且 VIP + 签名器在线 + 能取到 lossless 902k 整曲」的条件下，
 * 把两个候选端点都把**响应里出现过的全部键名**打出来核对过：
 *   - `/luna/pc/track_v2`：121 个字段，无 play_auth / 无 spade_a / 无任何凭证类字段；
 *   - `/luna/media-player`：12 个字段（player_infos / url_player_info / video_model /
 *     video_model_type / audio_effects / intelligent …），同样一个凭证字段都没有。
 * 即**平台根本不下发密钥**，不是字段改名、也不是我们解析器的问题（解析器有 9 个单测兜底）。
 * 所以目前 `extractSodaKey` 恒返回空串，解密链路（`fileCache` 里的解密分支）跑不到；
 * 一旦哪天平台又开始下发，`downloadAndCache`/`checkCache` 那套是现成可用的，别删。
 */

import { resolveAudioKey } from '../utils/sodaDecrypt'

/**
 * 递归查找第一个「键名匹配（大小写不敏感）」的值。
 * 先扫自身层，再往下钻；数组也遍历。取链响应的嵌套层级与命名风格都不固定，必须这样搜。
 */
function findDeep(obj: any, names: string[], depth = 0): any {
  if (!obj || typeof obj !== 'object' || depth > 12) return undefined
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findDeep(item, names, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const name of names) {
    const lower = name.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(obj, name) && obj[name] !== undefined && obj[name] !== null) return obj[name]
    for (const k of Object.keys(obj)) {
      if (k.toLowerCase() === lower && obj[k] !== undefined && obj[k] !== null) return obj[k]
    }
  }
  for (const k of Object.keys(obj)) {
    const found = findDeep(obj[k], names, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 从取链响应里取出汽水版权曲的解密密钥（32 位小写十六进制）；抓不到返回空串。
 *
 * 按参考实现（qishuiClient.js:339-340）的口径：`findFirstByKeys({playAuth, raw}, ['spade_a'])`，
 * 即**先在 play_auth 子树里找、找不到再在整个原始响应里找**。
 *
 * 早期版本找到 play_auth 后只扫描它的直接子键，漏掉了「spade_a 在响应顶层 / 更深层级 /
 * 另一个 play_auth 分支」三种情况，表现为「明明是 CENC 加密流却捕获不到密钥」，
 * 于是继续命中旧的 DRM 拦截 —— 新增的解密链路一行都跑不到。246 实测复现过，别再改回去。
 */
export function extractSodaKey(parsed: any): string {
  const auth = findDeep(parsed, ['play_auth', 'playAuth'])
  const candidates: any[] = []
  if (auth !== undefined) candidates.push(findDeep(auth, ['spade_a', 'spadeA']))
  candidates.push(findDeep(parsed, ['spade_a', 'spadeA']))

  let sawCandidate = false
  for (const c of candidates) {
    const spade = typeof c === 'string' ? c.trim() : ''
    if (!spade) continue
    sawCandidate = true
    try {
      return resolveAudioKey({ spade_a: spade }).toLowerCase()
    } catch {
      // 这个候选推导失败（可能是别处的同名字段），换下一个
    }
  }

  // 抓不到就留证据：区分「响应里根本没有 spade_a」和「有但推导失败」，
  // 否则线上只剩一句「未拿到密钥」，没法继续往下定位。
  const topKeys = parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 12).join(',') : '(非对象)'
  console.warn(
    `[汽水解密] 未捕获到密钥（play_auth存在=${auth !== undefined}, 找到同名字段=${sawCandidate}, 顶层键=${topKeys}）`
  )
  return ''
}
