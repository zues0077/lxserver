/**
 * P2-2（上游「后台仪表盘与明/暗主题重构」的 overview 数据口）单测。
 *
 * 锁住的不变式：按**本地 log4js 格式**解析（时间不带方括号）。
 * 上游 dashboard 的正则要求 `[时间] [级别]`，照抄到本仓库会全部匹配失败 → 看板全 0。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  parseLogLine,
  aggregateLogLines,
  readLogTail,
  DEFAULT_ERROR_WINDOW_MS,
} from '../src/server/utils/dashboardOverview'

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

// --- 17 项加固新增护栏 ---------------------------------------------------

// 17953 stdout.log 真实样本（14:00 报告：旧解析器 139/139 采样 stdout_parsed 恒 0）
const STDOUT_LINES = [
  '[2026-11-12 06:52:34.977] [TIMER] [定时器注册] timeout 间隔 645336ms @ stack',
  '[2026-11-12 05:54:39.410] [WARN] [worker:豆包定制[聚合音源]] 巡检开始',
  '[2026-11-12 06:05:22.941] [LOG] [平台账号] 咪咕音乐短期凭证已主动保温续期（主账号）',
  '[2026-11-12 06:10:00.000] [ERROR] [音源] 取链失败',
]

test('parseLogLine: stdoutBridge 格式能解析，app 格式不被误收', () => {
  assert.equal(LOCAL_LINES.filter(l => parseLogLine(l, 'stdout') !== null).length, 0)
  assert.equal(STDOUT_LINES.filter(l => parseLogLine(l, 'app') !== null).length, 0)
  assert.equal(STDOUT_LINES.filter(l => parseLogLine(l, 'stdout') !== null).length, 4)
  const item = parseLogLine(STDOUT_LINES[3], 'stdout')!
  assert.equal(item.level, 'ERROR')
  assert.equal(item.category, 'stdout')
  assert.equal(item.time, '2026-11-12 06:10:00.000')
})

test('aggregateLogLines: stdout 类型汇总出 levels / recentErrors / 时间窗', () => {
  const o = aggregateLogLines(STDOUT_LINES, 20, 'stdout')
  assert.equal(o.parsed, 4)
  assert.equal(o.levels.ERROR, 1)
  assert.equal(o.levels.LOG, 1)
  assert.equal(o.levels.TIMER, 1)
  assert.equal(o.recentErrors.length, 1)
  assert.ok(o.windowStart && o.windowEnd)
})

test('recentErrors: 1h 时间窗过滤掉跨轮次历史 ERROR', () => {
  const lines = [
    '2026-11-12 00:00:00.000 [ERROR] old - 九小时前的历史错误',
    '2026-11-12 09:00:00.000 [INFO] sync - 最近一条日志',
    '2026-11-12 09:00:01.000 [ERROR] now - 当前错误',
  ]
  const o = aggregateLogLines(lines, 20, 'app')
  assert.equal(o.parsed, 3)
  assert.equal(o.recentErrors.length, 1, '历史 ERROR 不应混进近期告警')
  assert.equal(o.recentErrors[0].category, 'now')
  assert.equal(o.recentErrors[0].time, '2026-11-12 09:00:01.000')
  assert.equal(o.windowEnd, '2026-11-12 09:00:01.000')
  assert.equal(o.windowStart, '2026-11-12 08:00:01.000')
  assert.equal(DEFAULT_ERROR_WINDOW_MS, 3_600_000)
})

test('readLogTail: 只读末尾 N 行；小 maxBytes 从中间截断时丢弃残行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-tail-'))
  try {
    const file = path.join(dir, 'stdout.log')
    const all = Array.from({ length: 100 }, (_, i) =>
      `2026-11-12 00:00:${String(i).padStart(2, '0')}.000 [INFO] sync - line ${i}`)
    fs.writeFileSync(file, all.join('\n') + '\n')
    const tail = await readLogTail(file, 10)
    assert.equal(tail.length, 10)
    assert.ok(tail[0].includes('line 90'))
    assert.ok(tail[9].includes('line 99'))
    const tiny = await readLogTail(file, 5, 200)
    assert.ok(tiny.length <= 5)
    assert.ok(tiny.length > 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
