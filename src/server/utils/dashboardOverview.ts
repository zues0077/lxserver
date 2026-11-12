/**
 * 后台看板数据聚合（P2-2，对标上游「后台仪表盘与明/暗主题重构」里的
 * `GET /api/dashboard/overview` 数据口）。
 *
 * 本地事实（改动前盘点，勿套上游实现）：
 * - src/utils/log4js.ts 的 FILE_LAYOUT =
 *     `%d{yyyy-MM-dd hh:mm:ss.SSS} [%p] %c - %m`
 *   实际 app.log 形如：
 *     `2026-11-12 00:06:34.657 [INFO] sync - [音源巡检] 本轮完成（9490ms）...`
 *   **时间不带方括号**。上游 dashboard 的 `/^\[([^\]]+)\]\s+\[?(INFO|WARN|...)\]?/`
 *   正则在这里会全部匹配失败、看板全是 0。
 * - console.* 由 src/utils/stdoutBridge.ts 额外写进 stdout.log，
 *   格式为 `[时间] [级别] 消息`（**时间带方括号、没有 category 段**）。
 *   14:00 长周期采样实测 139/139 次 `stdout_parsed` 恒 0，就是因为只用了
 *   app.log 那套正则去解 stdout.log。本轮按文件类型选解析器。
 * - 鉴权沿用 /api/logs 的 `x-frontend-auth === admin.password`。
 *
 * 加固（2026-11-12，P2 深度评测 17 项之 #1/#2/#3）：
 * - parseLogLine 支持 'app' / 'stdout' 两种格式；
 * - recentErrors 加 1 小时时间窗，并返回 windowStart / windowEnd；
 * - readLogTail 流式只读末尾字节（上限 2MB），不再整文件 readFile + split。
 *
 * 本轮只加后端只读端点，前端不接线（不碰 public/index.html / public/app.js，
 * 不引入上游 6000+ 行的看板与主题重构）。
 */

import fs from 'node:fs'

export type LogFormat = 'app' | 'stdout'

export interface ParsedLogLine {
  time: string
  level: string
  category: string
  message: string
}

/** 严格按本地 log4js 的 FILE_LAYOUT 写，时间无方括号、有 `category - ` 段。 */
const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[([A-Z]+)\] (.+?) - (.*)$/

/**
 * stdoutBridge 写出的格式：
 *   `[2026-11-12 06:05:22.941] [LOG] [平台账号] 咪咕音乐短期凭证已主动保温续期（主账号）`
 *   `[2026-11-12 06:52:34.977] [TIMER] [定时器注册] timeout 间隔 645336ms ...`
 *   `[2026-11-12 05:54:39.410] [WARN] [worker:豆包定制[聚合音源]] ...`
 * 级别由 console 方法名大写而来（log→LOG、info→INFO、warn→WARN、error→ERROR），
 * 另有 TIMER 一类；消息里可能自带方括号，故用 `(.*)` 兜住，不贪心拆 category。
 */
const STDOUT_LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[([A-Z]+)\] (.*)$/

export const parseLogLine = (line: string, format: LogFormat = 'app'): ParsedLogLine | null => {
  if (typeof line !== 'string') return null
  if (format === 'stdout') {
    const m = STDOUT_LINE_RE.exec(line)
    if (!m) return null
    // stdout 没有 category 分隔符，统一归到 'stdout' 一类，保持分类字典简单可解释
    return { time: m[1], level: m[2], category: 'stdout', message: m[3] }
  }
  const m = LINE_RE.exec(line)
  if (!m) return null
  return { time: m[1], level: m[2], category: m[3].trim(), message: m[4] }
}

export interface LogOverview {
  scanned: number
  parsed: number
  levels: Record<string, number>
  categories: Array<{ name: string, count: number }>
  recentErrors: ParsedLogLine[]
  firstTime: string | null
  lastTime: string | null
  /** 近期告警窗口（与日志时间同为本地墙上时间字符串，便于直接对照日志） */
  windowStart: string | null
  windowEnd: string | null
}

/** 近期告警默认时间窗：1 小时。 */
export const DEFAULT_ERROR_WINDOW_MS = 60 * 60 * 1000

/** '2026-11-12 00:06:34.657' → 本地时区毫秒戳（不带 Z，Date.parse 按本地时区解析）。 */
const parseLogTime = (time: string): number | null => {
  const ts = Date.parse(time.replace(' ', 'T'))
  return Number.isFinite(ts) ? ts : null
}

const formatLogTime = (ts: number): string => {
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export const aggregateLogLines = (
  lines: string[],
  maxErrors = 20,
  format: LogFormat = 'app',
  windowMs = DEFAULT_ERROR_WINDOW_MS,
): LogOverview => {
  const levels: Record<string, number> = {}
  const categoryCounts = new Map<string, number>()
  const recentErrors: ParsedLogLine[] = []
  let parsed = 0
  let firstTime: string | null = null
  let lastTime: string | null = null

  // 先解析出全部有效行，再以「最后一条日志时间」为基准算时间窗。
  // 用日志自身时间而不是 Date.now()，与容器时区 / 系统时钟漂移无关。
  const items: ParsedLogLine[] = []
  for (const line of lines) {
    const item = parseLogLine(line, format)
    if (!item) continue
    items.push(item)
  }

  const lastTs = items.length ? parseLogTime(items[items.length - 1].time) : null
  const windowEnd = lastTs
  const windowStart = lastTs === null ? null : lastTs - Math.max(0, windowMs)

  for (const item of items) {
    parsed++
    if (!firstTime) firstTime = item.time
    lastTime = item.time
    levels[item.level] = (levels[item.level] || 0) + 1
    categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1)
    if (item.level === 'ERROR' || item.level === 'FATAL') {
      const ts = parseLogTime(item.time)
      // 跨轮次的历史 ERROR 不再混进「近期告警」
      if (windowStart !== null && ts !== null && ts < windowStart) continue
      recentErrors.push(item)
      if (recentErrors.length > maxErrors) recentErrors.shift()
    }
  }

  const categories = [...categoryCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 10)

  return {
    scanned: lines.length,
    parsed,
    levels,
    categories,
    recentErrors,
    firstTime,
    lastTime,
    windowStart: windowStart === null ? null : formatLogTime(windowStart),
    windowEnd: windowEnd === null ? null : formatLogTime(windowEnd),
  }
}

/** 单次 tail 最多读的字节数，避免生产日志几百 MB 时把事件循环堵住。 */
export const TAIL_MAX_BYTES = 2 * 1024 * 1024

/**
 * 只读日志文件末尾若干行：open + stat + 一次性 read 末尾 maxBytes，
 * 而不是 readFile 整文件再 split('\n')。从文件中间截断时第一行可能不完整，丢弃即可。
 */
export const readLogTail = async (
  filePath: string,
  maxLines: number,
  maxBytes: number = TAIL_MAX_BYTES,
): Promise<string[]> => {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    const size = Math.min(stat.size, Math.max(1, maxBytes))
    if (size <= 0 || stat.size === 0) return []
    const start = stat.size - size
    const buf = Buffer.allocUnsafe(size)
    await handle.read(buf, 0, size, start)
    const parts = buf.toString('utf-8').split('\n')
    if (start > 0) parts.shift()
    while (parts.length && parts[parts.length - 1] === '') parts.pop()
    return parts.slice(-Math.max(1, maxLines))
  } finally {
    await handle.close()
  }
}
