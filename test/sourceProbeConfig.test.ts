/**
 * 巡检「时间频次 / 安全性」相关配置的单元测试。
 *
 * 重点守护两条容易写错、写错代价又很大的语义：
 *
 * 1. `restoreIntervalMinutes` / `throttleMs` 的 **0 是合法值**（表示关闭该功能），
 *    不能被「0 当成没填」的通用数值函数悄悄换回默认值 —— 否则用户以为关了，实际还在跑。
 * 2. `maxDurationMs` / `restoreBatch` 的下限与上限：预算写小会让巡检永远跑不完，
 *    节流写大会把一轮巡检拖成几小时。
 */
import test from 'node:test'
import assert from 'node:assert'
import { configOf, PROBE_TASK_ID, PROBE_RESTORE_TASK_ID } from '../src/server/sourceProbe'

const withConfig = (cfg: Record<string, any>, fn: () => void) => {
  const g = global as any
  const prev = g.lx
  g.lx = { config: cfg }
  try {
    fn()
  } finally {
    if (prev === undefined) delete g.lx
    else g.lx = prev
  }
}

test('新增配置的默认值：复检 30 分钟 / 每轮 16 个 / 节流 250ms / 预算 8 分钟', () => {
  withConfig({}, () => {
    const c = configOf()
    assert.strictEqual(c.restoreIntervalMinutes, 30)
    assert.strictEqual(c.restoreBatch, 16)
    assert.strictEqual(c.throttleMs, 250)
    assert.strictEqual(c.maxDurationMs, 8 * 60 * 1000)
  })
})

test('复检间隔与节流允许 0（0 = 关闭），不能被当成「没填」回落默认值', () => {
  withConfig({
    'customSource.probe.restoreIntervalMinutes': 0,
    'customSource.probe.throttleMs': 0,
  }, () => {
    const c = configOf()
    assert.strictEqual(c.restoreIntervalMinutes, 0, '0 必须原样保留，否则关不掉复检')
    assert.strictEqual(c.throttleMs, 0, '0 必须原样保留，否则节流关不掉')
  })
})

test('节流上限 5000ms：配置写错也不会把巡检拖成几小时', () => {
  withConfig({ 'customSource.probe.throttleMs': 999999 }, () => {
    assert.strictEqual(configOf().throttleMs, 5000)
  })
})

test('restoreBatch 最小 1，避免 0 导致复检永远不探任何平台', () => {
  withConfig({ 'customSource.probe.restoreBatch': 0 }, () => {
    assert.ok(configOf().restoreBatch >= 1)
  })
})

test('maxDurationMs 非法（0/负数/非数字）时回落到 8 分钟', () => {
  for (const bad of [0, -1, 'abc', null]) {
    withConfig({ 'customSource.probe.maxDurationMs': bad }, () => {
      assert.strictEqual(configOf().maxDurationMs, 8 * 60 * 1000, `非法值 ${String(bad)} 必须回落默认`)
    })
  }
})

test('两个任务 id 必须不同，否则后注册的会覆盖前一个', () => {
  assert.notStrictEqual(PROBE_TASK_ID, PROBE_RESTORE_TASK_ID)
})
