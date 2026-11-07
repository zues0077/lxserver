/**
 * 「源 × 平台 × 音质档」账本的行为回归。
 *
 * 重点不是"能不能记账"，而是三条容易写错的性质：
 *   1. 只有**零成功**的档才允许短路（偶然连败的正常档不能被杀）；
 *   2. 短路必须**自动放行探路**（否则源修好了也永远轮不到它）；
 *   3. 全被短路时调用方必须能放行（账本不能造成无源可用）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearQualityLedger,
  filterByQualityLedger,
  getQualityLedgerOptions,
  isQualityBlocked,
  noteQualityResult,
  qualityLedgerSize,
  qualityLedgerSnapshot,
  resetQualityLedger,
  setQualityLedgerOptions,
} from '../src/server/sourceQualityLedger'

const T0 = 1_700_000_000_000
const HOUR = 3600_000
const api = (owner: string, id: string) => ({ info: { owner, id, name: id } })
const target = (quality = 'flac', id = 's1') => ({ owner: 'open', id, platform: 'kw', quality })

test.beforeEach(() => resetQualityLedger())

test('默认阈值：3 次样本、1 小时短路、6 小时过期', () => {
  assert.deepStrictEqual(getQualityLedgerOptions(), {
    minSamples: 3, blockMs: HOUR, idleResetMs: 6 * HOUR,
  })
})

test('样本不足不短路（前两次失败照常尝试）', () => {
  const t = target()
  noteQualityResult(t, false, T0)
  assert.strictEqual(isQualityBlocked(t, T0), false)
  noteQualityResult(t, false, T0 + 1000)
  assert.strictEqual(isQualityBlocked(t, T0 + 1000), false)
})

test('三次失败且零成功 → 短路一小时', () => {
  const t = target()
  noteQualityResult(t, false, T0)
  noteQualityResult(t, false, T0 + 1000)
  const rec = noteQualityResult(t, false, T0 + 2000)!
  assert.strictEqual(rec.attempts, 3)
  assert.strictEqual(rec.successes, 0)
  assert.strictEqual(rec.blockedUntil, T0 + 2000 + HOUR)
  assert.strictEqual(isQualityBlocked(t, T0 + 3000), true)
  assert.strictEqual(isQualityBlocked(t, T0 + 2000 + HOUR), false, '到期即放行')
})

test('成功过一次的档永不短路（连败 6 次也不行）', () => {
  const t = target()
  noteQualityResult(t, true, T0)
  for (let i = 0; i < 6; i++) noteQualityResult(t, false, T0 + i * 1000)
  assert.strictEqual(isQualityBlocked(t, T0 + 6000), false)
})

test('短路期间继续失败不重复计时；到期探路失败则重新短路且 blocks+1', () => {
  const t = target()
  for (let i = 0; i < 3; i++) noteQualityResult(t, false, T0 + i * 1000)
  const blockedAt = T0 + 2000 + HOUR
  // 短路期内再失败一次：不应延长（blockedUntil 不变），否则偶尔一次探路就把自己钉死
  const inBlock = noteQualityResult(t, false, T0 + 100_000)!
  assert.strictEqual(inBlock.blockedUntil, T0 + 2000 + HOUR)
  assert.strictEqual(inBlock.blocks, 1)
  // 到期后探路失败 → 重新短路一小时
  const probeFail = noteQualityResult(t, false, blockedAt)!
  assert.strictEqual(probeFail.blocks, 2)
  assert.strictEqual(probeFail.blockedUntil, blockedAt + HOUR)
})

test('到期探路成功 → 解除短路并永久恢复', () => {
  const t = target()
  for (let i = 0; i < 3; i++) noteQualityResult(t, false, T0 + i * 1000)
  const blockedAt = T0 + 2000 + HOUR
  const rec = noteQualityResult(t, true, blockedAt)!
  assert.strictEqual(rec.blockedUntil, 0)
  assert.strictEqual(rec.successes, 1)
  assert.strictEqual(isQualityBlocked(t, blockedAt), false)
})

test('长时间未触碰的记录视为过期，重新从头计数', () => {
  const t = target()
  noteQualityResult(t, false, T0)
  noteQualityResult(t, false, T0 + 1000)
  // 超过 idleResetMs 后再失败一次：应重置为 1 次，而不是凑满 3 次直接短路
  const rec = noteQualityResult(t, false, T0 + 7 * HOUR)!
  assert.strictEqual(rec.attempts, 1)
  assert.strictEqual(isQualityBlocked(t, T0 + 7 * HOUR), false)
})

test('音质档为空时不记账（无从区分，只会污染账本）', () => {
  assert.strictEqual(noteQualityResult({ owner: 'open', id: 's1', platform: 'kw', quality: '' }, false, T0), undefined)
  assert.strictEqual(qualityLedgerSize(), 0)
  assert.strictEqual(isQualityBlocked({ owner: 'open', id: 's1', platform: 'kw', quality: '' }, T0), false)
})

test('filterByQualityLedger：按档分开，只有被短路的进 blocked', () => {
  const a = api('open', 'a')
  const b = api('open', 'b')
  for (let i = 0; i < 3; i++) noteQualityResult({ owner: 'open', id: 'a', platform: 'kw', quality: 'flac' }, false, T0 + i)
  const r = filterByQualityLedger([a, b], 'kw', 'flac', T0 + 10)
  assert.deepStrictEqual(r.blocked.map((x: any) => x.info.id), ['a'])
  assert.deepStrictEqual(r.usable.map((x: any) => x.info.id), ['b'])
  // 换一个档位：账本不串档
  const r128 = filterByQualityLedger([a, b], 'kw', '128k', T0 + 10)
  assert.strictEqual(r128.blocked.length, 0)
})

test('filterByQualityLedger：无音质档时全放行', () => {
  const a = api('open', 'a')
  const r = filterByQualityLedger([a], 'kw', '', T0)
  assert.deepStrictEqual(r.usable, [a])
  assert.strictEqual(r.blocked.length, 0)
})

test('clearQualityLedger：按平台清 / 按源全清', () => {
  noteQualityResult({ owner: 'open', id: 'a', platform: 'kw', quality: 'flac' }, false, T0)
  noteQualityResult({ owner: 'open', id: 'a', platform: 'kw', quality: '128k' }, false, T0)
  noteQualityResult({ owner: 'open', id: 'a', platform: 'tx', quality: 'flac' }, false, T0)
  assert.strictEqual(qualityLedgerSize(), 3)
  assert.strictEqual(clearQualityLedger('open', 'a', 'kw'), 2)
  assert.strictEqual(qualityLedgerSize(), 1)
  assert.strictEqual(clearQualityLedger('open', 'a'), 1)
  assert.strictEqual(qualityLedgerSize(), 0)
  assert.strictEqual(clearQualityLedger('open', 'nobody'), 0)
})

test('快照只列仍在短路的条目，其余只计总数', () => {
  noteQualityResult({ owner: 'open', id: 'a', platform: 'kw', quality: 'flac' }, false, T0)
  noteQualityResult({ owner: 'open', id: 'a', platform: 'kw', quality: 'flac' }, false, T0 + 1)
  noteQualityResult({ owner: 'open', id: 'a', platform: 'kw', quality: 'flac' }, false, T0 + 2)
  noteQualityResult({ owner: 'open', id: 'b', platform: 'kw', quality: '128k' }, true, T0 + 3)
  const snap = qualityLedgerSnapshot(T0 + 10)
  assert.strictEqual(snap.total, 2)
  assert.strictEqual(snap.blocked.length, 1)
  assert.match(snap.blocked[0].key, /a:kw:flac/)
  assert.ok(snap.blocked[0].until.endsWith('Z'))
})

test('阈值可覆盖（配置项/单测用）', () => {
  setQualityLedgerOptions({ minSamples: 1, blockMs: 1000 })
  const t = target()
  noteQualityResult(t, false, T0)
  assert.strictEqual(isQualityBlocked(t, T0), true)
  assert.strictEqual(isQualityBlocked(t, T0 + 1000), false)
})

// ==================== 死局兜底（applyQualityLedger） ====================

import { applyQualityLedger } from '../src/server/sourceQualityLedger'

test('applyQualityLedger：无人短路时原样返回，不新建数组', () => {
  const list = [api('open', 'a'), api('open', 'b')]
  const r = applyQualityLedger(list, 'kw', 'flac', T0)
  assert.strictEqual(r.candidates, list)
  assert.strictEqual(r.blocked.length, 0)
  assert.strictEqual(r.rescuedAll, false)
})

test('applyQualityLedger：部分短路 → 只剔除被短路的', () => {
  const a = api('open', 'a')
  const b = api('open', 'b')
  for (let i = 0; i < 3; i++) noteQualityResult({ owner: 'open', id: 'a', platform: 'kw', quality: 'flac' }, false, T0 + i)
  const r = applyQualityLedger([a, b], 'kw', 'flac', T0 + 10)
  assert.deepStrictEqual(r.candidates.map((x: any) => x.info.id), ['b'])
  assert.deepStrictEqual(r.blocked.map((x: any) => x.info.id), ['a'])
  assert.strictEqual(r.rescuedAll, false)
})

test('applyQualityLedger：全部短路 → 全体放行探路（账本不允许造成无源可用）', () => {
  const a = api('open', 'a')
  for (let i = 0; i < 3; i++) noteQualityResult({ owner: 'open', id: 'a', platform: 'kw', quality: 'flac' }, false, T0 + i)
  const r = applyQualityLedger([a], 'kw', 'flac', T0 + 10)
  assert.deepStrictEqual(r.candidates, [a])
  assert.strictEqual(r.blocked.length, 1)
  assert.strictEqual(r.rescuedAll, true)
})
