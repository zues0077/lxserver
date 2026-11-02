/**
 * 小爱状态里的时间单位换算 —— 纯逻辑单测
 *
 * 背景（2026-11-02 真机实测）：酷狗/QQ 部分歌的 status 里
 * `position=2979`（毫秒）与 `duration=1`（秒）**单位不一致**，
 * 旧逻辑按 duration 判档位再套 position，得到 pos=2979000ms / dur=1000ms，
 * progressRatio 恒为 1 → watchdog 判「临近结尾」→ 自动切歌。
 *
 * 这里守的就是「position 按自己的样子换算、duration 不可信时回落到已知时长」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDurationMs, resolvePositionMs } from '../src/server/xiaoai/service'

test('resolvePositionMs：上报毫秒时原样返回（正常机型）', () => {
  assert.equal(resolvePositionMs(5465, 270768), 5465)
})

test('resolvePositionMs：上报秒时乘 1000（老固件）', () => {
  assert.equal(resolvePositionMs(5, 270768), 5000)
})

test('resolvePositionMs：真机踩过的组合 position=2979 / duration=1', () => {
  // 关键：2979 是毫秒，不能被当成 2979 秒
  assert.equal(resolvePositionMs(2979, 341000), 2979)
})

test('resolvePositionMs：没有已知时长时沿用旧规则（小于 10000 当秒）', () => {
  assert.equal(resolvePositionMs(5), 5000)
  assert.equal(resolvePositionMs(270768), 270768)
  assert.equal(resolvePositionMs(0), 0)
  assert.equal(resolvePositionMs(-1), 0)
})

test('resolvePositionMs：接近结尾的秒制值也能正确换算', () => {
  assert.equal(resolvePositionMs(330, 341000), 330000)
})

test('resolveDurationMs：上报毫秒时原样返回', () => {
  assert.equal(resolveDurationMs(270768, 270768), 270768)
})

test('resolveDurationMs：上报秒时乘 1000', () => {
  assert.equal(resolveDurationMs(341, 341000), 341000)
})

test('resolveDurationMs：真机垃圾值 duration=1 时回落到已知时长', () => {
  // 不回落的后果：dur=1000ms，播 2 秒就被判「已播完」
  assert.equal(resolveDurationMs(1, 341000), 341000)
})

test('resolveDurationMs：没有已知时长时按原值判档', () => {
  assert.equal(resolveDurationMs(341), 341000)
  assert.equal(resolveDurationMs(270768), 270768)
  assert.equal(resolveDurationMs(0, 0), 0)
  assert.equal(resolveDurationMs(0, 120000), 120000)
})

test('组合：真机那条脏数据经换算后进度比例回到正常区间', () => {
  const expected = 341000
  const pos = resolvePositionMs(2979, expected)
  const dur = resolveDurationMs(1, expected)
  const ratio = Math.min(1, pos / dur)
  assert.ok(Math.abs(ratio - 2979 / 341000) < 1e-9)
  assert.ok(ratio < 0.05)
})
