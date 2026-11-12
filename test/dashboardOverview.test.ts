/**
 * P2-2（上游「后台仪表盘与明/暗主题重构」的 overview 数据口）单测。
 *
 * 锁住的不变式：按**本地 log4js 格式**解析（时间不带方括号）。
 * 上游 dashboard 的正则要求 `[时间] [级别]`，照抄到本仓库会全部匹配失败 → 看板全 0。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseLogLine, aggregateLogLines } from '../src/server/utils/dashboardOverview'

const LOCAL_LINES = [
  '2026-11-12 00:06:34.657 [INFO] sync - [音源巡检] 本轮完成（9490ms）：巡检 44 个音源',
  '2026-11-12 00:06:35.001 [WARN] subsonic - 缓存目录歌曲索引待同步',
  '2026-11-12 00:06:36.120 [ERROR] userApi - 取链失败: timeout',
  '2026-11-12 00:06:37.000 [DEBUG] sync - 跳过',
  '',
  '这是一行无格式的日志',
]

test('parseLogLine: 本地 log4js 格式（时间无方括号）必须能解析', () => {
  const item = parseLogLine(LOCAL_LINES[0])
  assert.ok(item)
  assert.equal(item!.time, '2026-11-12 00:06:34.657')
  assert.equal(item!.level, 'INFO')
  assert.equal(item!.category, 'sync')
  assert.ok(item!.message.includes('音源巡检'))
})

test('parseLogLine: 上游旧正则在本格式下会全 0（回归护栏）', () => {
  const upstreamRe = /^\[([^\]]+)\]\s+\[?(INFO|WARN|WARNING|ERROR|DEBUG)\]?\s+(.*)$/
  const parsedByUpstream = LOCAL_LINES.filter(l => upstreamRe.test(l))
  assert.equal(parsedByUpstream.length, 0, '上游正则对本地格式确实全不匹配')
  assert.equal(LOCAL_LINES.filter(l => parseLogLine(l) !== null).length, 4, '本地解析器应解析出 4 条')
})

test('parseLogLine: 空行/非字符串/无格式行返回 null', () => {
  assert.equal(parseLogLine(''), null)
  assert.equal(parseLogLine('这是一行无格式的日志'), null)
  assert.equal(parseLogLine(null as any), null)
})

test('aggregateLogLines: 级别计数 / 分类 topN / recentErrors', () => {
  const o = aggregateLogLines(LOCAL_LINES)
  assert.equal(o.scanned, 6)
  assert.equal(o.parsed, 4)
  assert.deepEqual(o.levels, { INFO: 1, WARN: 1, ERROR: 1, DEBUG: 1 })
  assert.equal(o.firstTime, '2026-11-12 00:06:34.657')
  assert.equal(o.lastTime, '2026-11-12 00:06:37.000')
  assert.equal(o.recentErrors.length, 1)
  assert.equal(o.recentErrors[0].category, 'userApi')
  assert.ok(o.categories[0].count >= 1)
})

test('aggregateLogLines: recentErrors 最多保留 maxErrors 条', () => {
  const lines = Array.from({ length: 30 }, (_, i) =>
    `2026-11-12 00:00:00.00${i % 10} [ERROR] sync - err ${i}`)
  assert.equal(aggregateLogLines(lines, 5).recentErrors.length, 5)
  assert.equal(aggregateLogLines([], 5).parsed, 0)
})
