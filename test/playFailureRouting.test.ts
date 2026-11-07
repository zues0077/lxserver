/**
 * 取链失败的分流：限流走 30 秒退避，其余走沉底账本。
 *
 * 这是本次改动里唯一可能「悄悄改错」的地方——分流判反了，健康源会被当成坏源
 * 排到队尾，而日志上看不出任何异常。所以直接用真实的 notePlayFailure →
 * partitionByPlaySink 链路验证，不去测内部实现细节。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-route-'))
const g = global as any
g.lx = { ...(g.lx || {}), dataPath: tmp, config: { 'debug.enabled': false } }

import { partitionByPlaySink, notePlayFailure, clearPlayFailure } from '../src/server/userApi'
import { isRateLimited, resetRateLimit } from '../src/server/sourceRateLimit'
import { qualityLedgerSize, resetQualityLedger } from '../src/server/sourceQualityLedger'

const api = (id: string) => ({ info: { owner: 'open', id, name: id } })

test.beforeEach(() => {
  resetRateLimit()
  resetQualityLedger()
})

test('限流失败：进 30 秒退避，并被排到队尾', () => {
  const a = api('a')
  notePlayFailure(a, 'kw', 'HTTP 429 Too Many Requests')
  assert.strictEqual(isRateLimited('open', 'a', 'kw'), true)
  const { fresh, sunk } = partitionByPlaySink([a], 'kw')
  assert.deepStrictEqual(fresh, [])
  assert.deepStrictEqual(sunk, [a])
})

test('限流不进沉底账本：退避解除后立刻回到 fresh（不需要等 15 分钟窗口）', () => {
  const a = api('a')
  notePlayFailure(a, 'kw', '接口限流')
  // 把 now 推到退避之后（30s），沉底账本若被污染会仍然命中 15 分钟窗口
  const later = Date.now() + 31_000
  const { fresh, sunk } = partitionByPlaySink([a], 'kw', later)
  assert.deepStrictEqual(fresh, [a], '限流解除后应立刻恢复，说明它没进沉底账本')
  assert.deepStrictEqual(sunk, [])
})

test('普通失败：进沉底账本，15 分钟内都排队尾', () => {
  const a = api('a')
  notePlayFailure(a, 'kw', '音源未返回有效的链接字符串')
  assert.strictEqual(isRateLimited('open', 'a', 'kw'), false)
  assert.deepStrictEqual(partitionByPlaySink([a], 'kw').sunk, [a])
  // 退避窗口过了也还在沉底窗口内
  assert.deepStrictEqual(partitionByPlaySink([a], 'kw', Date.now() + 31_000).sunk, [a])
})

test('不带失败原因时按普通失败处理（向后兼容旧调用）', () => {
  const a = api('a')
  notePlayFailure(a, 'kw')
  assert.strictEqual(isRateLimited('open', 'a', 'kw'), false)
  assert.deepStrictEqual(partitionByPlaySink([a], 'kw').sunk, [a])
})

test('取链成功：沉底、限流一起撤销，回到 fresh', () => {
  const a = api('a')
  notePlayFailure(a, 'kw', 'HTTP 429')
  notePlayFailure(a, 'kw', '超时')
  clearPlayFailure(a, 'kw')
  assert.strictEqual(isRateLimited('open', 'a', 'kw'), false)
  const { fresh, sunk } = partitionByPlaySink([a], 'kw')
  assert.deepStrictEqual(fresh, [a])
  assert.deepStrictEqual(sunk, [])
})

test('限流不碰「源 × 档」账本（否则会把能用的档误判成必败档）', () => {
  const a = api('a')
  for (let i = 0; i < 5; i++) notePlayFailure(a, 'kw', 'HTTP 429')
  assert.strictEqual(qualityLedgerSize(), 0)
})

test('普通失败也不由 notePlayFailure 记档（档位记账只发生在真实取链结果处）', () => {
  const a = api('a')
  for (let i = 0; i < 5; i++) notePlayFailure(a, 'kw', '取链超时')
  assert.strictEqual(qualityLedgerSize(), 0)
})

test('不同平台互不影响：kw 被限流不影响 tx 的排序', () => {
  const a = api('a')
  notePlayFailure(a, 'kw', 'HTTP 429')
  assert.deepStrictEqual(partitionByPlaySink([a], 'tx').sunk, [])
})
