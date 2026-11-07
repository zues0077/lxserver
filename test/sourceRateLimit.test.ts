/**
 * 限流独立通道：判定特征与 30 秒退避。
 *
 * 两条都是「误判代价不对称」的地方：
 *   - 该判没判 → 限流被当成源坏了 → 健康源被降权/关闭；
 *   - 不该判判了 → 真坏源得到豁免 → 一直白等。
 * 所以特征词只收明确的限流表述，宁少不多。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RATE_LIMIT_BACKOFF_MS,
  clearRateLimit,
  clearRateLimitForSource,
  isRateLimitFailure,
  isRateLimited,
  noteRateLimit,
  rateLimitSnapshot,
  resetRateLimit,
} from '../src/server/sourceRateLimit'

const T0 = 1_700_000_000_000

test.beforeEach(() => resetRateLimit())

test('命中：429 与常见限流表述', () => {
  const hits = [
    'HTTP 429',
    'status: 429 Too Many Requests',
    'Error: too many requests',
    'rate limit exceeded',
    'rate_limit',
    'ratelimit hit',
    'request throttled',
    '接口限流',
    '请求过于频繁，请稍后再试',
    '访问过于频繁',
    '操作过于频繁',
    '触发请求频率限制',
    '接口调用超限',
  ]
  for (const msg of hits) {
    assert.strictEqual(isRateLimitFailure(msg), true, `应命中: ${msg}`)
  }
})

test('不命中：普通失败与「没有过于的频繁」', () => {
  const misses = [
    '音源未返回有效的链接字符串',
    'HTTP 500 内部错误',
    'ENOTFOUND',
    '404 not found',
    '取链超时（超过 20000ms 未返回）',
    '该歌曲无版权',
    '切换频繁',            // 缺「过于」，不算限流
    '请求次数 12',
    '',
    undefined,
    null,
    42,
    {},
  ]
  for (const msg of misses) {
    assert.strictEqual(isRateLimitFailure(msg as any), false, `不应命中: ${String(msg)}`)
  }
})

test('退避窗口：30 秒内为 true，之后自动恢复', () => {
  noteRateLimit('open', 'a', 'kw', T0)
  assert.strictEqual(isRateLimited('open', 'a', 'kw', T0), true)
  assert.strictEqual(isRateLimited('open', 'a', 'kw', T0 + RATE_LIMIT_BACKOFF_MS - 1), true)
  assert.strictEqual(isRateLimited('open', 'a', 'kw', T0 + RATE_LIMIT_BACKOFF_MS), false)
  // 不同源、不同平台互不影响
  assert.strictEqual(isRateLimited('open', 'b', 'kw', T0), false)
  assert.strictEqual(isRateLimited('open', 'a', 'tx', T0), false)
})

test('clearRateLimit 立刻解除', () => {
  noteRateLimit('open', 'a', 'kw', T0)
  clearRateLimit('open', 'a', 'kw')
  assert.strictEqual(isRateLimited('open', 'a', 'kw', T0), false)
})

test('快照只列仍在退避期的条目', () => {
  noteRateLimit('open', 'a', 'kw', T0)
  noteRateLimit('open', 'b', 'kw', T0 - RATE_LIMIT_BACKOFF_MS * 2)
  const snap = rateLimitSnapshot(T0)
  assert.strictEqual(snap.length, 1)
  assert.match(snap[0].key, /a:kw/)
})

test('重复限流不会无限增长（同键覆盖）', () => {
  for (let i = 0; i < 5; i++) noteRateLimit('open', 'a', 'kw', T0 + i)
  assert.strictEqual(rateLimitSnapshot(T0 + 10).length, 1)
})

// ---------------- 源重载时整体清退避 ----------------
// 脚本换新后，针对旧实现记的限流不该继续压着新实现（否则「已经修好了」还要白等 30 秒）。

test('clearRateLimitForSource 只清该源，不动别的源与别的平台', () => {
  resetRateLimit()
  const now = Date.now()
  noteRateLimit('open', 'doubao', 'tx', now)
  noteRateLimit('open', 'doubao', 'wy', now)
  noteRateLimit('open', 'other', 'tx', now)
  noteRateLimit('admin', 'doubao', 'tx', now)
  assert.strictEqual(isRateLimited('open', 'doubao', 'tx', now), true)

  const removed = clearRateLimitForSource('open', 'doubao')
  assert.strictEqual(removed, 2)
  assert.strictEqual(isRateLimited('open', 'doubao', 'tx', now), false)
  assert.strictEqual(isRateLimited('open', 'doubao', 'wy', now), false)
  // 同名 id 属于不同 owner：不能一起清
  assert.strictEqual(isRateLimited('admin', 'doubao', 'tx', now), true)
  assert.strictEqual(isRateLimited('open', 'other', 'tx', now), true)
  resetRateLimit()
})
