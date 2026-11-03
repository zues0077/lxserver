/**
 * 歌词匹配用的纯函数（不联网、不引服务端依赖，便于单测）。
 *
 * 为什么单独一个文件：`lyricFallback.ts` 一被 import 就会顺带拉起 musicSdk +
 * 汽水解密 + 账号存储一大串服务端依赖，单测里跑不动。匹配算法这部分全是纯计算，
 * 抽出来既好测，也方便以后换匹配策略。
 */

export interface MatchTarget {
  name: string
  singer?: string
  interval?: string
}

export interface CandidateScore {
  score: number
  title: number
  singer: number
  duration: number
  accept: boolean
}

/**
 * 各种时长写法 → 秒。
 * 见过 "04:12"、"4:12"、"252"、"252000"（毫秒），还有带小数秒的 "04:12.35"。
 */
export function durationSeconds(raw: unknown): number {
  if (raw === null || raw === undefined) return 0
  const str = String(raw).trim()
  if (!str) return 0
  if (/^\d+(\.\d+)?$/.test(str)) {
    const num = parseFloat(str)
    if (!isFinite(num) || num <= 0) return 0
    // 大于 3600 基本可以确定是毫秒（1 小时以上的单曲极少）
    return num > 3600 ? Math.round(num / 1000) : Math.round(num)
  }
  const parts = str.split(':').map(x => parseFloat(x))
  if (parts.some(x => !isFinite(x))) return 0
  let sec = 0
  for (const part of parts) sec = sec * 60 + part
  return Math.round(sec)
}

const BRACKET_RXPS = [/【[^】]*】/g, /\[[^\]]*\]/g, /（[^）]*）/g, /\([^)]*\)/g, /〔[^〕]*〕/g, /〈[^〉]*〉/g]

/**
 * 歌名归一：去掉括号里的版本标注 / 音质标注，再抹掉标点空格。
 *
 * B 站和聚合来源的歌名常带「【4K】」「(Live)」「[官方MV]」这类前缀后缀，
 * 不洗掉就永远匹配不上正经平台的同名单曲。
 */
export function cleanTitle(raw: unknown): string {
  let str = String(raw ?? '')
  for (const rxp of BRACKET_RXPS) str = str.replace(rxp, ' ')
  return str
    .toLowerCase()
    .replace(/feat\.?|ft\.?/g, ' ')
    .replace(/[\s'"`~!@#$%^&*()+=\[\]{};:,.<>/?\\|、，。！？；：“”‘’（）《》【】…—\-_]/g, '')
    .trim()
}

function bigrams(str: string): Map<string, number> {
  const map = new Map<string, number>()
  if (str.length === 1) {
    map.set(str, 1)
    return map
  }
  for (let i = 0; i < str.length - 1; i++) {
    const gram = str.slice(i, i + 2)
    map.set(gram, (map.get(gram) || 0) + 1)
  }
  return map
}

/** Dice 系数（中文按二字组），0~1 */
export function similarity(a: unknown, b: unknown): number {
  const x = cleanTitle(a)
  const y = cleanTitle(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return 0.85
  const mx = bigrams(x)
  const my = bigrams(y)
  let inter = 0
  let total = 0
  for (const [gram, n] of mx) {
    total += n
    const m = my.get(gram)
    if (m) inter += Math.min(n, m)
  }
  for (const n of my.values()) total += n
  return total ? (2 * inter) / total : 0
}

const SINGER_SPLIT = /[、/&,;；|]|\s+feat\.?\s+|\s+ft\.?\s+/i

/** 歌手拆成独立名字（「周杰伦、费玉清」→ [周杰伦, 费玉清]） */
export function singerTokens(raw: unknown): string[] {
  return String(raw ?? '')
    .split(SINGER_SPLIT)
    .map(s => cleanTitle(s))
    .filter(Boolean)
}

/** 歌手匹配：任一方包含另一方即算（「周杰伦」vs「周杰伦、费玉清」应为命中） */
export function singerScore(a: unknown, b: unknown): number {
  const left = singerTokens(a)
  const right = singerTokens(b)
  if (!left.length || !right.length) return 0.5
  for (const x of left) {
    for (const y of right) {
      if (x === y) return 1
      if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return 0.9
    }
  }
  return 0
}

/** 给一个候选歌曲打分，决定它能不能拿来当「同一首歌」 */
export function scoreCandidate(target: MatchTarget, candidate: any): CandidateScore {
  const title = similarity(target.name, candidate?.name)
  const singer = singerScore(target.singer, candidate?.singer)
  const want = durationSeconds(target.interval)
  const got = durationSeconds(candidate?.interval)
  let duration = 0.5
  if (want && got) {
    const diff = Math.abs(want - got)
    duration = diff <= 4 ? 1 : diff <= 8 ? 0.7 : diff <= 15 ? 0.3 : 0
  }
  const score = title * 0.6 + singer * 0.25 + duration * 0.15
  // 时长对不上（>15s）说明是另一个版本，宁可没词也别给错词
  const accept = title >= 0.55 && score >= 0.62 && duration > 0
  return { score, title, singer, duration, accept }
}

/** 从候选里挑最高分；都不过线就返回 null */
export function pickBest(target: MatchTarget, list: any[]): any | null {
  let best: any = null
  let bestScore = 0
  for (const item of list || []) {
    if (!item) continue
    const s = scoreCandidate(target, item)
    if (!s.accept) continue
    if (s.score > bestScore) {
      bestScore = s.score
      best = item
    }
  }
  return best
}

/** 纯文本歌词补假时间轴（每行 3 秒），避免前端当成无时间轴歌词整段糊在一起 */
export function plainToLrc(text: string): string {
  const lines = String(text || '').replace(/\r/g, '').split('\n')
  let t = 0
  const out: string[] = []
  for (const line of lines) {
    const body = line.trim()
    if (!body) continue
    const m = Math.floor(t / 60)
    const s = t % 60
    out.push(`[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.00]${body}`)
    t += 3
  }
  return out.join('\n')
}

/**
 * 汽水逐字歌词（QRC 风格）→ 标准 LRC + 逐字 lxlyric。
 *
 * 汽水 `/luna/h5/track_v2` 的 `lyric.content` 形如：
 *   `[12270,1850]<0,330,0>穿<330,300,0>拖<630,300,0>鞋...`
 * 行首是「行起始毫秒」，每个 `<偏移,时长,0>` 是一个字的相对时间。
 * 这个格式与我们咪咕 MRC 的逐字结构同构，转成 `<偏移,时长>字` 就能给前端逐字滚动用。
 */
export interface LyricKeyParts {
  source: string
  name: string
  singer: string
  interval?: string
  songmid?: string
  hash?: string
}

/** 取词结果取决于平台 id 的源（其余源走「按名字跨源搜索」） */
const ID_SCOPED_LYRIC_SOURCES = new Set(['bili', 'soda', 'kglite'])

/**
 * 歌词兜底缓存的键。
 *
 * 只拼「源 + 歌名 + 歌手 + 时长」是不够的：bili 的字幕按 BV 号取、soda 按曲目 id 取、
 * kglite 按酷狗 hash 取 —— 这三级的**结果取决于平台 id**，同标题同歌手的两个曲目会共用
 * 同一条缓存。2026-11-03 实测：用同一个歌名查 5 个不同 BV，全部返回同一条 36 行字幕；
 * 换成 5 个不同歌名后各自正确（36 / 46 / 0 / 67 行）。
 *
 * 所以对这三个源把 id 一并拼进键；其余源不加 id，保住跨入口（搜索 / 歌单 / 播放列表）
 * 的缓存复用，也避免同一首歌因入口不同写法产生多份缓存。
 */
export function lyricCacheKey(t: LyricKeyParts): string {
  const source = String(t?.source || '').toLowerCase()
  const parts = [source, cleanTitle(t?.name), cleanTitle(t?.singer), durationSeconds(t?.interval)]
  if (ID_SCOPED_LYRIC_SOURCES.has(source)) {
    // kglite 的 songmid 本身就是酷狗 hash，两者取其一即可
    const id = String((source === 'kglite' ? t?.hash || t?.songmid : t?.songmid) || '').trim()
    if (id) parts.push(id)
  }
  return parts.join('|')
}

export function parseSodaQrc(raw: string): { lyric: string; lxlyric: string } {
  const lines = String(raw || '').replace(/\r/g, '').split('\n')
  const lrcLines: string[] = []
  const lxLines: string[] = []
  const timeTag = (ms: number) => {
    const total = Math.max(0, Math.round(ms))
    const m = Math.floor(total / 60000)
    const s = Math.floor((total % 60000) / 1000)
    const cs = Math.floor((total % 1000) / 10)
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
  }
  for (const line of lines) {
    const head = /^\s*\[(\d+),\d+\](.*)$/.exec(line)
    if (!head) continue
    const start = parseInt(head[1], 10)
    const body = head[2] || ''
    const words = Array.from(body.matchAll(/<(\d+),(\d+),\d+>([^<]*)/g))
    const text = words.length
      ? words.map(w => w[3]).join('')
      : body.replace(/<\d+,\d+,\d+>/g, '')
    if (!text.trim()) continue
    const tag = timeTag(start)
    lrcLines.push(`[${tag}]${text}`)
    if (words.length) {
      lxLines.push(`[${tag}]` + words.map(w => `<${w[1]},${w[2]}>${w[3]}`).join(''))
    }
  }
  return { lyric: lrcLines.join('\n'), lxlyric: lxLines.join('\n') }
}
