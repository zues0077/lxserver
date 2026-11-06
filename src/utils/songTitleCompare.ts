/**
 * 曲名比对：区分「写法差异」与「真错版」。
 *
 * 现场样本（2026-11-06 小爱压测，20 条「音箱当前曲目与投送的不一致」告警）：
 *  - 17 条是写法差异：`一万次悲伤 (Live版)` vs `一万次悲伤（Live版)`——全角半角括号
 *  - 3 条是真错版：`春不晚 DJ版` vs `春不晚 Live版`——版本根本不同
 *
 * 原实现是 `title.includes(expected) || expected.includes(title)` 直接比原文，
 * 括号差一个全角就报警。噪音把真错版淹没，等于这条守门形同虚设。
 *
 * 三态输出：
 *  - same      ：归一化后完全一致
 *  - style     ：主名与版本标签都一致，只是写法（全角/空白/标点）不同 → 记 INFO
 *  - different ：主名不同，或版本标签不同（DJ vs Live）→ 记 WARN
 */

/** 全角 → 半角，去空白与标点，统一小写 */
export const normalizeTitleForCompare = (value: unknown): string =>
  String(value ?? '')
    .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/[\s\-_/·,，.。!！?？'"“”‘’、:：;；&+]/g, '')
    .trim()

/** 会改变「听到的是什么」的版本关键词：不同即真错版，必须上报 */
const VERSION_TAGS: Array<[RegExp, string]> = [
  [/\blive\b|现场|演唱会/i, 'live'],
  [/\bdj\b|弹鼓|慢摇|remix|混音/i, 'remix'],
  [/伴奏|instrumental|karaoke/i, 'instrumental'],
  [/纯音乐|钢琴版|吉他版|八音盒/i, 'instrumental'],
  [/翻唱|cover/i, 'cover'],
  [/女声|男声|童声|童音/i, 'voice'],
  [/片段|试听|剪辑|铃声/i, 'clip'],
  [/\bdemo\b/i, 'demo'],
  [/acoustic|不插电/i, 'acoustic'],
  [/remaster|重制|修复版/i, 'remaster'],
  [/加速|降速|升调|降调/i, 'speed'],
]

/** 提取曲名里的版本标签集合（顺序无关，用于集合比较） */
export const extractVersionTags = (value: unknown): string[] => {
  const text = String(value ?? '')
  const tags = new Set<string>()
  for (const [pattern, tag] of VERSION_TAGS) {
    if (pattern.test(text)) tags.add(tag)
  }
  return [...tags].sort()
}

/** 去掉括号内容与版本词后的「主名」：`春不晚 DJ版` → `春不晚` */
export const extractBaseTitle = (value: unknown): string => {
  let base = normalizeTitleForCompare(
    String(value ?? '').replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）|【[^】]*】/g, ''),
  )
  // 版本词常常叠着出现（`dj版`、`live女声版`），单次 replace 只剥掉最外层一个，
  // 必须反复剥到稳定为止，否则 `春不晚dj` 会留在主名里，两首不同的歌被判成「主名不同」。
  const tail = /(live|dj|remix|cover|demo|acoustic|instrumental|版|片段|伴奏|女声|男声|童声)$/
  let prev = ''
  while (base !== prev) {
    prev = base
    base = base.replace(tail, '')
  }
  return base
}

export type TitleCompareLevel = 'same' | 'style' | 'different'

export interface TitleCompareResult {
  level: TitleCompareLevel
  reason?: string
}

export const compareSongTitles = (deviceTitle: unknown, expectedTitle: unknown): TitleCompareResult => {
  const a = String(deviceTitle ?? '').trim()
  const b = String(expectedTitle ?? '').trim()
  if (!a || !b) return { level: 'same' } // 缺一边无法判断，不作为告警依据
  if (a === b) return { level: 'same' }

  const na = normalizeTitleForCompare(a)
  const nb = normalizeTitleForCompare(b)
  if (na === nb) return { level: 'style', reason: '仅全角/空白/标点写法差异' }
  if (na.includes(nb) || nb.includes(na)) {
    // 互相包含但归一化后不等：常见于音箱在曲名后追加了「Live」等后缀
    const extra = na.length > nb.length ? na : nb
    const shorter = na.length > nb.length ? nb : na
    const rest = extra.replace(shorter, '')
    // 追加部分只有版本词 → 仍属同一版本家族，交给下面的版本标签比较
    if (!rest || extractVersionTags(rest).length > 0 || normalizeTitleForCompare(rest) === '') {
      const ta = extractVersionTags(a)
      const tb = extractVersionTags(b)
      if (ta.join(',') === tb.join(',')) return { level: 'style', reason: '一方名称包含另一方，版本标签一致' }
    }
  }

  const baseA = extractBaseTitle(a)
  const baseB = extractBaseTitle(b)
  const tagsA = extractVersionTags(a)
  const tagsB = extractVersionTags(b)

  if (baseA && baseB && baseA === baseB) {
    if (tagsA.join(',') === tagsB.join(',')) {
      return { level: 'style', reason: '主名一致，仅版本写法不同' }
    }
    return {
      level: 'different',
      reason: `版本不同（${tagsA.join('+') || '原版'} vs ${tagsB.join('+') || '原版'}）`,
    }
  }

  return { level: 'different', reason: '主名不同' }
}
