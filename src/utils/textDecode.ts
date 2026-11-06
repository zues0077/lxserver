/**
 * 音源文本修复：把「丢掉反斜杠的 \uXXXX」还原成真正的字符。
 *
 * 现场样本（2026-11-06 小爱压测，kw 平台）：曲名变成
 * `一万次悲伤 (u5b8cu6574u7248)`，正确值是 `一万次悲伤 (完整版)`。
 * 音源在拼字符串时把 `\u5b8c` 的 `\` 吞掉了，于是 6 个字符原样进了曲名。
 *
 * 连带影响不只是显示难看：
 *  - 写 ID3 标签失败（非法字符），音箱屏显占位名
 *  - 歌词按错名字去搜，搜不到
 *  - 守门比对「音箱当前曲目 vs 投送曲目」永远不一致，刷告警
 *
 * 为什么不直接 `JSON.parse('"' + s + '"')`：
 *  - 曲名里可能有引号、反斜杠，JSON 解析会炸
 *  - 会把正常的 `\n`、`\t` 也解释掉，改坏原意
 *
 * 所以只做「定向最小修复」：仅替换 `u` + 4 位十六进制，且
 *  1. `u` 前面不能是字母数字（避免把 `Menu1234` 的 `u1234` 拆掉）
 *  2. 解出来的码点必须落在「中文 / 中文标点 / 可打印 ASCII」范围内，
 *     否则（例如 `u1234` = 埃塞俄比亚文）原样保留 —— 宁可漏解也不改坏
 */

/** 允许还原的码点范围：CJK 统一表意文字、CJK 标点、全角字符、可打印 ASCII */
const isReasonableCodePoint = (code: number): boolean => {
  if (!Number.isFinite(code) || code <= 0) return false
  if (code >= 0x20 && code <= 0x7e) return true // ASCII 可打印
  if (code >= 0x4e00 && code <= 0x9fff) return true // CJK 基本区（常用汉字）
  if (code >= 0x3000 && code <= 0x303f) return true // CJK 标点（、（）。等）
  if (code >= 0xff00 && code <= 0xffef) return true // 全角字符（，：！等）
  if (code >= 0x2000 && code <= 0x206f) return true // 常用标点（—…‘’“”）
  return false
}

export const decodeLooseUnicode = (input: unknown): string => {
  const text = typeof input === 'string' ? input : String(input ?? '')
  if (!text) return text
  // 快速短路：绝大多数曲名不含这种残留
  if (!/(?<![0-9a-zA-Z])u[0-9a-fA-F]{4}/.test(text)) return text

  let changed = false
  // 必须按「连续多段」整体匹配：`u5b8cu6574u7248` 里第二段的 u 前面是 hex 字符 c，
  // 若逐个匹配会被前置边界挡掉，只能还原第一段（实测踩过）。
  const replaced = text.replace(/(?<![0-9a-zA-Z])((?:u[0-9a-fA-F]{4})+)/g, (whole: string) => {
    const codes = (whole.match(/u[0-9a-fA-F]{4}/g) || []).map(seg => Number.parseInt(seg.slice(1), 16))
    // 整段里只要有一个码点不合理，就整段放弃，避免把混排的正常文本改坏
    if (!codes.length || !codes.every(isReasonableCodePoint)) return whole
    changed = true
    return codes.map(code => String.fromCharCode(code)).join('')
  })
  return changed ? replaced : text
}

/** 对一首歌的可读字段做同样的修复（就地修改，返回是否改动过） */
export const decodeSongText = (song: Record<string, any> | null | undefined): boolean => {
  if (!song || typeof song !== 'object') return false
  let changed = false
  for (const key of ['name', 'title', 'singer', 'albumName', 'album', 'artist'] as const) {
    const before = song[key]
    if (typeof before !== 'string' || !before) continue
    const after = decodeLooseUnicode(before)
    if (after !== before) {
      song[key] = after
      changed = true
    }
  }
  return changed
}
