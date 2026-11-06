import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSeekKnownMs } from '../src/server/xiaoai/seekDuration'

const R = (i: Parameters<typeof resolveSeekKnownMs>[0]) => resolveSeekKnownMs(i)

test('投送时锁定值优先：durationMs 残值不影响', () => {
  const r = R({ lockedTotalMs: 227000, trackDurationMs: 133000, probedMs: 0, deviceDurationMs: 133000, deviceOnFullStream: false })
  assert.strictEqual(r.knownMs, 227000)
  assert.strictEqual(r.trusted, true)
  assert.strictEqual(r.lockedTotalMs, 227000)
})

test('锁定值缺失 → durationMs 兜底且可信、锁定', () => {
  const r = R({ lockedTotalMs: 0, trackDurationMs: 261000, probedMs: 0, deviceDurationMs: 0, deviceOnFullStream: false })
  assert.strictEqual(r.knownMs, 261000)
  assert.strictEqual(r.lockedTotalMs, 261000)
})

test('本地补探兜底：探测值锁定（target.path 恒为整曲文件）', () => {
  const r = R({ lockedTotalMs: 0, trackDurationMs: 0, probedMs: 261000, deviceDurationMs: 0, deviceOnFullStream: false })
  assert.strictEqual(r.knownMs, 261000)
  assert.strictEqual(r.lockedTotalMs, 261000)
})

test('死亡螺旋主修：完整流首次设备上报可信并锁定，此后切片上报不再退化', () => {
  // 富士山下复刻：远端中转投送 totalDurationMs=0，第一次 seek 时音箱还在播完整流
  const first = R({ lockedTotalMs: 0, trackDurationMs: 0, probedMs: 0, deviceDurationMs: 261000, deviceOnFullStream: true })
  assert.strictEqual(first.knownMs, 261000)
  assert.strictEqual(first.lockedTotalMs, 261000)
  // 第二次 seek：音箱已播切片流（deviceOnFullStream=false），上报缩水到 33s
  const second = R({ lockedTotalMs: first.lockedTotalMs, trackDurationMs: 0, probedMs: 0, deviceDurationMs: 33000, deviceOnFullStream: false })
  assert.strictEqual(second.knownMs, 261000, '已锁定的整曲时长不被切片上报退化')
  assert.strictEqual(second.lockedTotalMs, 261000)
  // 连拖到底：上报掉到 4s、0s 也不退化
  const third = R({ lockedTotalMs: second.lockedTotalMs, trackDurationMs: 0, probedMs: 0, deviceDurationMs: 4000, deviceOnFullStream: false })
  assert.strictEqual(third.knownMs, 261000)
})

test('切片流上的设备上报不可信：不锁定、但可作为 knownMs 兜底使用', () => {
  const r = R({ lockedTotalMs: 0, trackDurationMs: 0, probedMs: 0, deviceDurationMs: 33000, deviceOnFullStream: false })
  assert.strictEqual(r.knownMs, 33000, '没有任何更可信来源时仍可兜底使用')
  assert.strictEqual(r.trusted, false)
  assert.strictEqual(r.lockedTotalMs, 0, '不可信值绝不粘性锁定')
})

test('上界校正：knownMs 掉成切片剩余时用明显更大的整曲上报拉回并锁定', () => {
  const r = R({ lockedTotalMs: 34000, trackDurationMs: 34000, probedMs: 0, deviceDurationMs: 259000, deviceOnFullStream: false })
  assert.strictEqual(r.knownMs, 259000)
  assert.strictEqual(r.trusted, true)
  assert.strictEqual(r.lockedTotalMs, 259000)
})

test('上界校正不误触：设备值不足已知值 1.5 倍时保持原值', () => {
  const r = R({ lockedTotalMs: 227000, trackDurationMs: 227000, probedMs: 0, deviceDurationMs: 230000, deviceOnFullStream: false })
  assert.strictEqual(r.knownMs, 227000)
  assert.strictEqual(r.lockedTotalMs, 227000)
})

test('全部缺失：knownMs=0 不夹取、不锁定', () => {
  const r = R({ lockedTotalMs: 0, trackDurationMs: 0, probedMs: 0, deviceDurationMs: 0, deviceOnFullStream: true })
  assert.strictEqual(r.knownMs, 0)
  assert.strictEqual(r.trusted, false)
  assert.strictEqual(r.lockedTotalMs, 0)
})
