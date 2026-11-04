/**
 * 自检护栏：隔离原因转人话 + 运行期隔离 24h 自动放行
 *
 * 背景（2026-11-04 用户反馈）：
 *  1. 界面上直接显示机器码 `cpu_probe:16.7%`，用户看不懂「为什么把我关掉」；
 *  2. 运行期判定（CPU 复检 / 卡顿归因）是采样推断，一次误判就永久停用不合理，
 *     需要 24h 自动放行一次复核；但放行了还犯满 3 次就得当真凶，不能再放。
 *
 * 这里只测纯逻辑：翻译函数与到期判定。IO 写盘链路交给 246 集成验证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  describeIsolationReason,
  isIsolationExpired,
  ISOLATION_AUTO_RELEASE_MS,
  type IsolateRecord,
} from '../src/server/sourceGuard.ts'

const record = (over: Partial<IsolateRecord> = {}): IsolateRecord => ({
  owner: 'open',
  id: 'src1',
  name: '测试源',
  fingerprint: 'fp',
  level: 'A',
  reason: 'cpu_probe:16.7%',
  reasons: [],
  source: 'probe',
  at: new Date(Date.now() - 25 * 3600_000).toISOString(),
  ...over,
})

test('describeIsolationReason：CPU 复检结论翻成人话，并保留数值与「可能误判」', () => {
  const text = describeIsolationReason('cpu_probe:16.7%')
  assert.match(text, /疑似空转/)
  assert.match(text, /16\.7%/)
  assert.match(text, /误判/)
})

test('describeIsolationReason：卡顿归因的毫秒数换成可读时长', () => {
  assert.match(describeIsolationReason('stall:1200ms'), /1\.2 秒/)
  assert.match(describeIsolationReason('stall:12000ms'), /12 秒/)
  assert.match(describeIsolationReason('stall:800ms'), /800 毫秒/)
  assert.match(describeIsolationReason('stall:1200ms'), /事件循环/)
})

test('describeIsolationReason：静态特征码逐条翻译，多个用顿号连接', () => {
  const text = describeIsolationReason('infinite_loop+debugger_trap')
  assert.match(text, /死循环/)
  assert.match(text, /debugger/)
  assert.ok(text.includes('、'))
})

test('describeIsolationReason：带参数的静态码只按码翻译，不丢原文信息', () => {
  const text = describeIsolationReason('hex_identifiers:420+long_line')
  assert.match(text, /十六进制/)
  assert.match(text, /超长单行/)
})

test('describeIsolationReason：空值与未知码不能崩，也不能返回空串', () => {
  assert.equal(describeIsolationReason(''), '未知原因')
  assert.equal(describeIsolationReason('   '), '未知原因')
  assert.equal(describeIsolationReason('some_new_code'), 'some_new_code')
})

test('isIsolationExpired：运行期隔离满 24h 放行', () => {
  const now = Date.now()
  assert.equal(isIsolationExpired(record(), 0, now), true)
})

test('isIsolationExpired：不满 24h 不放行', () => {
  const fresh = record({ at: new Date(Date.now() - 3600_000).toISOString() })
  assert.equal(isIsolationExpired(fresh, 0), false)
})

test('isIsolationExpired：静态命中与人工隔离永不自动放行', () => {
  assert.equal(isIsolationExpired(record({ source: 'static' }), 0), false)
  assert.equal(isIsolationExpired(record({ source: 'manual' }), 0), false)
})

test('isIsolationExpired：放行满 3 次后再到期也不放行（认定真凶）', () => {
  assert.equal(isIsolationExpired(record(), 2), true)
  assert.equal(isIsolationExpired(record(), 3), false)
})

test('isIsolationExpired：时间戳损坏时按未到期处理，避免误放行', () => {
  assert.equal(isIsolationExpired(record({ at: 'not-a-date' }), 0), false)
})

test('自动放行窗口是 24 小时（接口文案与实现必须一致）', () => {
  assert.equal(ISOLATION_AUTO_RELEASE_MS, 24 * 3600_000)
})
