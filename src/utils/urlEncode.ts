/**
 * 出站 URL 的中文编码
 *
 * 为什么需要：
 *   音乐平台/自定义音源返回的直链里常常直接嵌中文歌名或文件名，
 *   例如 `https://cdn.example.com/周杰伦 - 晴天.mp3?auth=abc`。
 *   Node 18+ 的 `http.get` 会自己编码，但 **needle 底层走 `url.parse()` 不会**，
 *   于是抛出 `Request path contains unescaped characters` —— 而且这不是 warning：
 *   在 `verifyUrlPlayable` / 重定向解析这类路径上，异常直接导致判定为「链接不可播」，
 *   把真能播的中文直链误杀（2026-10-27 / 10-30 两次实测同一现象）。
 *
 * 做法：
 *   只把非可见 ASCII（`\x21-\x7e` 之外，含空格、中文、全角符号）做百分号编码。
 *   已经编码好的 `%E4%B8%AD`、`+`、`=`、`&` 原样保留，不会二次编码，
 *   所以签名参数不受影响（签名看的是参数原值，编码发生在传输层）。
 *
 * 反例（别这么干）：
 *   - `encodeURI(url)` 整体编码 → 把 `%` 变成 `%25`，签名参数全废。
 *   - 只编码空格 → 中文照样炸。
 */
export const encodeRequestUrl = (url: string): string =>
  String(url || '').replace(/[^\x21-\x7e]/g, ch => encodeURIComponent(ch))

/**
 * 安全取 origin：URL 非法时返回空串，调用方拼 Referer 时不必各自 try/catch。
 * 注意这里用 WHATWG URL 解析原始 URL，编码过的 URL 同样能解析。
 */
export const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
