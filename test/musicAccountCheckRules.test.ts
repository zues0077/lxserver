/**
 * 账号巡检规则：节奏区间 + 排程算法。
 *
 * 背景（2026-10-30 用户要求）：
 *   ① 定时/启动巡检的账号间隔放宽到 10~120 秒随机（原 1~60 秒）
 *   ② 手动巡检放宽到 5~60 秒随机（原 0.8~2.2 秒）—— 宁可多等几分钟也不让平台侧像脚本
 *   ③ 失败退避必须明显长于正常间隔，否则等于没退（120~300 秒）
 *   ④ 启动首查只补查「陈旧」账号，频繁重建容器不再全量探测
 *
 * 这里只测纯逻辑（排程算法 + 常数区间），不碰网络与存储。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// index.ts 的 config() 自己有 `global.lx?.config || {}` 兜底，不用预置
import {
  nextHealthCheckAt,
  HEALTH_PAUSE_FOR_TEST,
} from '../src/server/musicAccount/index'

const HOUR = 3600_000
const DAY = 24 * HOUR

/** 把本地时间拼成时间戳，避免用 UTC 算「每天几点」算出时区偏差 */
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime()

test('巡检节奏区间：定时 10~120s、手动 5~60s、退避 120~300s', () => {
  const s = HEALTH_PAUSE_FOR_TEST.scheduled
  const m = HEALTH_PAUSE_FOR_TEST.manual
  const b = HEALTH_PAUSE_FOR_TEST.backoff

  assert.equal(s.base, 10_000, '定时巡检最短 10 秒')
  assert.equal(s.base + s.span, 120_000, '定时巡检最长 120 秒')

  assert.equal(m.base, 5_000, '手动巡检最短 5 秒')
  assert.equal(m.base + m.span, 60_000, '手动巡检最长 60 秒')

  assert.equal(b.base, 120_000, '失败退避最短 120 秒')
  assert.equal(b.base + b.span, 300_000, '失败退避最长 300 秒')

  // 退避必须长于正常间隔，否则「退避」没有意义
  assert.ok(b.base >= s.base + s.span, '退避下限要不小于定时的上限')
})

test('排程：从未巡检过 → 下一个整点就跑', () => {
  const now = at(2026, 10, 30, 11, 0)
  const next = nextHealthCheckAt(5, 101, 0, now)
  assert.equal(next, at(2026, 10, 31, 5, 0), '11 点时看，下一个 05:00 是明天')
})

test('排程：间隔未到就一天一天顺延（101 小时约 4 天 19 小时）', () => {
  // 今天 10:00 刚查过，间隔 101 小时 → 最早 11-03 15:00
  const lastRun = at(2026, 10, 30, 10, 0)
  const now = lastRun + 60_000
  const next = nextHealthCheckAt(5, 101, lastRun, now)
  assert.ok(next >= lastRun + 101 * HOUR, '必须满足最小间隔')
  assert.equal(new Date(next).getHours(), 5, '必须落在巡检时间点 05:00')
  // 101h ≈ 4.2 天 → 顺延到 11-04 05:00（距上次 4 天 19 小时）
  assert.equal(next, at(2026, 11, 4, 5, 0), '应为 11-04 05:00')
})

test('排程：间隔刚好落在整点上时不再白等一天', () => {
  // 上次 10-30 00:00 查过，间隔 5 天整 → 最早 11-04 00:00，05:00 已满足
  const lastRun = at(2026, 10, 30, 0, 0)
  const next = nextHealthCheckAt(5, 120, lastRun, lastRun + 60_000)
  assert.equal(next, at(2026, 11, 4, 5, 0), '120h 后当天 05:00 即可')
})

test('排程：默认 72 小时 ≈ 3 天 19 小时一轮（不是每天）', () => {
  const lastRun = at(2026, 10, 30, 10, 0)
  const next = nextHealthCheckAt(3, 72, lastRun, lastRun + 60_000)
  const gapHours = (next - lastRun) / HOUR
  assert.ok(gapHours >= 72, '至少 72 小时')
  assert.ok(gapHours < 96, '但不该拖到 4 天以上')
})

test('排程：小时参数越界会被夹住，不会算出非法时间', () => {
  const now = at(2026, 10, 30, 11, 0)
  assert.equal(new Date(nextHealthCheckAt(99, 1, 0, now)).getHours(), 23)
  assert.equal(new Date(nextHealthCheckAt(-5, 1, 0, now)).getHours(), 0)
})
