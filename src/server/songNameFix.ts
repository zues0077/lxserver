/**
 * 修复上游音源返回的「丢失反斜杠的 unicode 转义残留」歌名。
 *
 * 症状（2026-11-07 五小时长跑实测）：双层 JSON 编码只解了一层，搜索结果歌名里
 * 出现 `u5b8cu6574u7248`（= 完整版）这类乱码：
 *   - 音箱屏幕直接显示脏歌名（用户可见缺陷）；
 *   - 与已缓存的干净歌名对不上 → seek 的 expectName 守卫 409 → 整首重新投送。
 *
 * 修复策略：只处理「连续 2 个以上」的 uXXXX 转义残留（含带反斜杠的 \uXXXX 过度转义）。
 * 单个序列一律不碰——正常歌名里出现 u+4 位十六进制的概率极低，但连续出现基本只能是
 * 转义残留，这个阈值把误伤风险压到可忽略。
 */

/** 连续 2+ 个 uXXXX（允许混入带反斜杠的 \uXXXX），命中才动手 */
const ESCAPE_RUN_RE = /(?:(?:\\{1,2}u|u)[0-9a-fA-F]{4}){2,}/g

const decodeEscapeRun = (run: string): string => {
  const cleaned = run.replace(/\\/g, '')
  const re = /u([0-9a-fA-F]{4})/g
  let out = ''
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    const code = parseInt(m[1], 16)
    // 只接受常见可见字符区间，拒掉控制字符，避免把乱码变成不可见字符
    if (code >= 0x20) out += String.fromCharCode(code)
    else out += m[0]
  }
  return out
}

export const fixBrokenUnicodeEscapes = (name: string): string => {
  if (!name || typeof name !== 'string' || name.indexOf('u') === -1) return name
  return name.replace(ESCAPE_RUN_RE, decodeEscapeRun)
}

/** 搜索结果条目的文本字段统一过一遍（name/singer 之外的字段不碰） */
export const fixTrackListNames = (list: any[]): any[] => {
  if (!Array.isArray(list)) return list
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    if (typeof it.name === 'string') it.name = fixBrokenUnicodeEscapes(it.name)
    if (typeof it.singer === 'string') it.singer = fixBrokenUnicodeEscapes(it.singer)
  }
  return list
}
