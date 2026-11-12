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
 *   只读 app.log 会漏掉这部分，故两个文件都聚合。
 * - 鉴权沿用 /api/logs 的 `x-frontend-auth === admin.password`。
 *
 * 本轮只加后端只读端点，前端不接线（不碰 public/index.html / public/app.js，
 * 不引入上游 6000+ 行的看板与主题重构）。
 */

export interface ParsedLogLine {
  time: string
  level: string
  category: string
  message: string
}

/** 严格按本地 log4js 的 FILE_LAYOUT 写，时间无方括号。 */
const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[([A-Z]+)\] (.+?) - (.*)$/

export const parseLogLine = (line: string): ParsedLogLine | null => {
  if (typeof line !== 'string') return null
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
}

export const aggregateLogLines = (lines: string[], maxErrors = 20): LogOverview => {
  const levels: Record<string, number> = {}
  const categoryCounts = new Map<string, number>()
  const recentErrors: ParsedLogLine[] = []
  let parsed = 0
  let firstTime: string | null = null
  let lastTime: string | null = null

  for (const line of lines) {
    const item = parseLogLine(line)
    if (!item) continue
    parsed++
    if (!firstTime) firstTime = item.time
    lastTime = item.time
    levels[item.level] = (levels[item.level] || 0) + 1
    categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1)
    if (item.level === 'ERROR' || item.level === 'FATAL') {
      recentErrors.push(item)
      if (recentErrors.length > maxErrors) recentErrors.shift()
    }
  }

  const categories = [...categoryCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 10)

  return { scanned: lines.length, parsed, levels, categories, recentErrors, firstTime, lastTime }
}
