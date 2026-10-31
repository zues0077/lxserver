/**
 * 小米曲库匹配：把「我们这边的歌名 + 歌手」对到曲库里的 audioID。
 *
 * 为什么需要它：
 * 触屏音箱屏幕上的封面、歌名、滚动歌词**全部来自曲库**——
 * `player_play_music` 的 payload 只能给 audio_id 和 stream.url，带不了封面也带不了歌词。
 * 曲库搜不到就只能退回占位 audioID，屏幕会一直显示占位曲目（Theme Of Loft）那张默认封面、
 * 也没有歌词。所以「命中率」直接决定了投送的观感上限。
 *
 * 策略取舍（对比参考实现 songloft-plugin-miot / xiaomusic）：
 *  - 它们搜到就直接用第一条（`audioId = songList[0].audioID`），命中率高但会错配：
 *    屏幕可能显示另一首歌的封面和歌词，比默认封面更让人困惑。
 *  - 我们原来只在「歌名完全相等 + 歌手对得上」时才采用，宁可占位也不错配，
 *    代价是命中率明显偏低，用户看到的就是「很多都是默认封面」。
 *  - 这里取中间：分档放宽 + 打分择优，既明显提高命中，又不至于随便抓一条。
 *
 * 歌名归一化会把括号内容、feat./ft.、- Live/- Remastered 等装饰去掉，
 * 所以「夜曲」和「夜曲 (Live)」算同名，这样曲库名带后缀也能命中。
 */

/** 曲库搜索返回的单曲（只保留匹配需要的最小信息） */
export interface MusicCandidate {
  name: string
  artist: string
  audioId: string
}

/** 采用阈值：低于它的候选一律不用，宁可退占位封面 */
export const MUSIC_MATCH_MIN_SCORE = 60

/** 全角 → 半角（保留可读性，只处理 ASCII 可见区段） */
const toHalfWidth = (s: string): string =>
  s.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))

/** 括号内的内容（中英文方括圆括都算） */
const PAREN_PATTERNS = [
  /\([^)]*\)/g,
  /（[^）]*）/g,
  /\[[^\]]*\]/g,
  /【[^】]*】/g,
  /〔[^〕]*〕/g,
]

/** 版本/署名类尾巴，出现在破折号之后需要整段丢掉 */
const VERSION_TAIL =
  /\s*[-–—]\s*(live|remaster(ed)?|version|instrumental|karaoke|acoustic|remix|mix|edit|demo|伴奏|纯音乐|和声|片段)\b.*$/i

/** feat./ft./featuring 之后是同曲的另一位歌手，比较歌名时属于噪声 */
const FEAT_TAIL = /[-–—]?\s*(feat|ft|featuring)\.?\s.*$/i

/**
 * 出现在歌名末尾的版本标记。
 * 两侧（候选与目标）都走同一套归一化，所以削掉不会造成不对称误判；
 * 只锚定末尾是关键 —— Live Forever 这种以版本词开头的正常歌名不受影响。
 */
const TRAILING_VERSION_MARK =
  /(live|remaster(ed)?|instrumental|karaoke|acoustic|remix|cover|demo|伴奏|纯音乐|钢琴版|吉他版|dj版|女声版|男声版|翻唱|现场版|完整版|原唱|原版|高清|高音质|片段)$/i

/**
 * 去掉歌名里不影响「是不是同一首」的装饰，保留原样大小写与主体。
 * 用于二次搜索（曲库里的名字通常没有这些后缀）。
 */
export const stripSongDecorations = (raw: string): string => {
  let s = toHalfWidth(String(raw || '').trim())
  for (const re of PAREN_PATTERNS) s = s.replace(re, ' ')
  s = s.replace(FEAT_TAIL, ' ')
  s = s.replace(VERSION_TAIL, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/** 归一化歌名（只用于相等/包含判断，不能拿去搜索）。
 * 去装饰之外还要抹掉大小写、空白与标点，中日韩字符与字母数字保留。
 */
export const normalizeSongName = (raw: string): string => {
  const s = stripSongDecorations(raw).toLowerCase()
  // \p{L}\p{N} 覆盖中日韩与拉丁字母；问号等符号在歌名里没有区分意义
  const compact = s.replace(/[^\p{L}\p{N}]+/gu, '')
  // 再削一次「末尾版本词」：没写括号的「夜曲钢琴版」也该和「夜曲」算同一首。
  // 只锚定末尾，所以 Live Forever 这类以版本词开头的正常歌名不会被吃掉；
  // 削完为空（歌名本身就叫 Live）时保留原值，避免把所有同名歌归一成空串。
  const stripped = compact.replace(TRAILING_VERSION_MARK, '')
  return stripped || compact
}

/** 归一化歌手名（小写、去空白与标点），用于「互相包含」比较 */
export const normalizeArtistName = (raw: string): string => {
  const s = toHalfWidth(String(raw || '').trim()).toLowerCase()
  return s.replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 多歌手时取第一位：优先比主唱，避免「A;B」这种写法整体对不上 */
export const firstArtistName = (raw: string): string => {
  const s = String(raw || '').trim()
  if (!s) return ''
  const [first] = s.split(/[;；,，&、/｜|]/)
  return (first || '').trim() || s
}

/**
 * 构造搜索用的 query 列表（最多 3 条，按可信度从高到低）。
 *
 * 只发一条 `歌名-歌手` 是不够的：本地曲库的歌手写法经常和曲库不一样
 * （中文名/英文名、feat 署名、多歌手顺序），一带上就搜不到；
 * 歌名带 (Live)/(电视剧主题曲) 后缀时也会把结果带偏。
 * 所以逐级放宽，前一条有结果就不必再问后面。
 */
export const buildSearchQueries = (title: string, artist: string): string[] => {
  const t = String(title || '').trim()
  const a = String(artist || '').trim()
  if (!t) return []
  const out: string[] = []
  const push = (q: string): void => {
    const v = q.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  push(a ? `${t}-${a}` : t)
  push(t)
  const stripped = stripSongDecorations(t)
  if (stripped && stripped !== t) {
    push(a ? `${stripped}-${a}` : stripped)
    if (a) push(stripped)
  }
  return out.slice(0, 3)
}

/** 歌名相似档位 */
type NameLevel = 'exact' | 'partial' | 'none'

const nameLevel = (candNormalized: string, targetNormalized: string): NameLevel => {
  if (!candNormalized || !targetNormalized) return 'none'
  if (candNormalized === targetNormalized) return 'exact'
  const shorter = Math.min(candNormalized.length, targetNormalized.length)
  const longer = Math.max(candNormalized.length, targetNormalized.length)
  // 短名被长名包含时容易误判（「爱你」⊂「爱你一万年」），要求长度比过半
  if (shorter >= 2 && shorter / longer >= 0.5) {
    if (candNormalized.includes(targetNormalized) || targetNormalized.includes(candNormalized)) return 'partial'
  }
  return 'none'
}

/** 保留标点的小写串：判断「包含」时要看边界，所以不能先把分隔符抹掉 */
const artistFlat = (raw: string): string => toHalfWidth(String(raw || '').trim()).toLowerCase()

const isCJK = (ch: string): boolean => /[\u4e00-\u9fff]/.test(ch)

/**
 * 带边界的包含判断。
 *
 * 直接 `includes` 会把「王菲」当成「王菲菲」里的人（真机实测踩过：
 * 王菲的《如愿》被匹到王菲菲的同名曲，封面歌词全错）。
 * 所以要求命中位置的两侧不能「汉字贴汉字」——
 *  · 「Yamy郭颖」包含「郭颖」：左侧是字母 y，算边界 → 同一人（中英文连写是常见写法）
 *  · 「冯沁苑(买辣椒也用券)」包含「买辣椒也用券」：左侧是括号，算边界 → 同一人（别名）
 *  · 「王菲菲」包含「王菲」：右侧紧贴汉字「菲」→ 不是同一人
 */
const containsAtBoundary = (hay: string, needle: string): boolean => {
  if (!hay || !needle) return false
  if (hay === needle) return true
  let from = 0
  while (from <= hay.length - needle.length) {
    const i = hay.indexOf(needle, from)
    if (i < 0) return false
    const before = i > 0 ? hay[i - 1] : ''
    const after = i + needle.length < hay.length ? hay[i + needle.length] : ''
    const badBefore = !!before && isCJK(before) && isCJK(needle[0])
    const badAfter = !!after && isCJK(after) && isCJK(needle[needle.length - 1])
    if (!badBefore && !badAfter) return true
    from = i + 1
  }
  return false
}

/** 歌手相似档位 */
type ArtistLevel = 'match' | 'unknown' | 'mismatch'

const artistLevel = (candArtist: string, targetArtist: string): ArtistLevel => {
  const target = artistFlat(firstArtistName(targetArtist))
  const cand = artistFlat(candArtist)
  if (!target || !cand) return 'unknown'
  if (containsAtBoundary(cand, target) || containsAtBoundary(target, cand)) return 'match'
  return 'mismatch'
}

/** 候选名带「非原版」标记，而目标名没带时降权，优先选原版 */
const looksNonOriginal = (name: string, targetTitle: string): boolean => {
  const n = String(name || '').toLowerCase()
  const t = String(targetTitle || '').toLowerCase()
  const marks = [
    'live',
    '伴奏',
    '纯音乐',
    'instrumental',
    'karaoke',
    'remix',
    'cover',
    '翻唱',
    '片段',
    '钢琴版',
    '吉他版',
    'dj版',
    '女声',
    '男声',
    '现场',
  ]
  return marks.some(m => n.includes(m) && !t.includes(m))
}

/** 择优结果，reason 只用于日志排查 */
export interface MusicPick {
  candidate: MusicCandidate
  score: number
  reason: string
}

/**
 * 从候选里挑最可信的一条。挑不出来返回 null（调用方退回占位 audioID）。
 *
 * 分档（分数只用于内部比较，不代表概率）：
 *  - 100 歌名完全相等 + 歌手对得上        ← 最理想，封面歌词几乎肯定对
 *  - 92  歌名完全相等 + 候选没写歌手
 *  - 80  歌名完全相等 + 歌手不同（同名唯一）← 常见于曲库歌手名翻译/写法不同
 *  - 70  歌名互相包含 + 歌手对得上
 *  - 62  歌名互相包含 + 候选没写歌手
 *  - 歌名互相包含但歌手明确不同的不采用：那基本是另一首歌，错配比占位更糟。
 *
 * 「同名唯一」这条只在曲库里只有一首同名歌时才敢用 —— 有多首同名歌时，
 * 歌手又对不上，取谁都可能是别的版本（甚至别人的歌），不如留给占位。
 */
export const pickMusicCandidate = (
  candidates: MusicCandidate[],
  title: string,
  artist: string
): MusicPick | null => {
  const targetName = normalizeSongName(title)
  if (!targetName) return null
  const list = Array.isArray(candidates) ? candidates : []

  const exactCount = list.filter(c => c.audioId && nameLevel(normalizeSongName(c.name), targetName) === 'exact').length

  let best: MusicPick | null = null
  for (const c of list) {
    if (!c.audioId) continue
    const name = normalizeSongName(c.name)
    const level = nameLevel(name, targetName)
    if (level === 'none') continue
    const aLevel = artistLevel(c.artist, artist)

    let score = 0
    let reason = ''
    if (level === 'exact') {
      if (aLevel === 'match') {
        score = 100
        reason = '同名+歌手匹配'
      } else if (aLevel === 'unknown') {
        score = 92
        reason = '同名+候选无歌手'
      } else if (exactCount === 1) {
        score = 80
        reason = '同名唯一+歌手不同'
      } else {
        continue
      }
    } else {
      if (aLevel === 'match') {
        score = 70
        reason = '歌名近似+歌手匹配'
      } else if (aLevel === 'unknown') {
        score = 62
        reason = '歌名近似+候选无歌手'
      } else {
        continue
      }
    }

    if (looksNonOriginal(c.name, title)) score -= 12
    if (score < MUSIC_MATCH_MIN_SCORE) continue
    // 严格大于才替换：同分保留更靠前的那条（搜索结果自带相关度排序）
    if (!best || score > best.score) best = { candidate: c, score, reason }
  }
  return best
}
