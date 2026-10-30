/**
 * 概念版「领取成功但剩余时长没涨」的展示校正（手册 P-0986）。
 *
 * 真实成因：平台 batch_union_vipinfo 有缓存，领完立刻查会少 2~3 小时，
 * 半小时后再查就追平。时长并没有丢，是我们的展示拿了滞后值。
 * 这里把这个校正逻辑钉住，免得以后有人把它改回「直接显示实测值」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reconcileRemain } from '../src/server/musicAccount/resolvers/kglite'

test('reconcileRemain：领完立刻查少 3 小时 → 按推算值展示并标记延迟', () => {
  // 2026-10-30 246 实测：「我的小号」领前 2420、报 +12、领完立刻查 2429
  const r = reconcileRemain(2420, 12, 2429)
  assert.equal(r.remainHours, 2432)
  assert.equal(r.balanceDelayed, true)
})

test('reconcileRemain：半小时后追平 → 不再标记延迟', () => {
  // 同一账号 16:37 再查就是 2432，与「领前 + 获得」一致
  const r = reconcileRemain(2420, 12, 2432)
  assert.equal(r.remainHours, 2432)
  assert.equal(r.balanceDelayed, false)
})

test('reconcileRemain：实测比推算大（期间还有别处到账）→ 用实测值', () => {
  const r = reconcileRemain(100, 3, 120)
  assert.equal(r.remainHours, 120)
  assert.equal(r.balanceDelayed, false)
})

test('reconcileRemain：领取前余额查不到 → 只信实测值，不乱推算', () => {
  const r = reconcileRemain(null, 12, 2429)
  assert.equal(r.remainHours, 2429)
  assert.equal(r.balanceDelayed, false)
})

test('reconcileRemain：领完查不到 → 退回推算值', () => {
  const r = reconcileRemain(2420, 12, null)
  assert.equal(r.remainHours, 2432)
  assert.equal(r.balanceDelayed, false)
})

test('reconcileRemain：本次没领到（今日额度已满）→ 未被推算污染', () => {
  const r = reconcileRemain(2420, 0, 2419)
  assert.equal(r.remainHours, 2419)
  assert.equal(r.balanceDelayed, false)
})

test('reconcileRemain：两边都拿不到 → 不给剩余时长，界面不瞎猜', () => {
  const r = reconcileRemain(null, 0, null)
  assert.equal(r.remainHours, undefined)
  assert.equal(r.balanceDelayed, false)
})

test('reconcileRemain：领取前已过期（余额 ≤0）按 0 起算，不把负数带进推算', () => {
  const r = reconcileRemain(0, 12, 9)
  assert.equal(r.remainHours, 12)
  assert.equal(r.balanceDelayed, true)

  const expired = reconcileRemain(-30, 12, 9)
  assert.equal(expired.remainHours, 12)
})
