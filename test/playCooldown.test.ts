import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partitionByCooldown, notePlayCooldown, clearPlayFailure } from '../src/server/userApi'

const mkApi = (id: string, owner = 'open') => ({ info: { id, owner, name: id } })

test('无失败记录：全部候选都是 hot', () => {
  const a = mkApi('src-a')
  const b = mkApi('src-b')
  const { hot, cooled } = partitionByCooldown([a, b], 'mg')
  assert.strictEqual(hot.length, 2)
  assert.strictEqual(cooled.length, 0)
})

test('超时类失败进冷却：窗口内第一轮跳过、cooled 兜底轮保留', () => {
  const bad = mkApi('src-bad')
  const ok = mkApi('src-ok')
  notePlayCooldown(bad, 'mg', '音源日志：HYWmusic_公益版: 地址不可播（回源超时）')
  const { hot, cooled } = partitionByCooldown([bad, ok], 'mg')
  assert.deepStrictEqual(hot, [ok])
  assert.deepStrictEqual(cooled, [bad])
})

test('非超时类失败（无版权/下架）不进冷却', () => {
  const a = mkApi('src-soft')
  notePlayCooldown(a, 'mg', '音源日志：歌曲无版权或已下架')
  const { hot } = partitionByCooldown([a], 'mg')
  assert.strictEqual(hot.length, 1)
})

test('冷却窗口过期自动恢复', () => {
  const a = mkApi('src-expired')
  notePlayCooldown(a, 'kw', '音源日志：取链超时（超过 5000ms 未返回）')
  // 用 90s + 1ms 后的时间点判定
  const later = Date.now() + 90 * 1000 + 1
  const { hot } = partitionByCooldown([a], 'kw', later)
  assert.strictEqual(hot.length, 1)
})

test('单候选场景不冷却（跳过等于拒绝播放）', () => {
  const a = mkApi('src-only')
  notePlayCooldown(a, 'tx', '音源日志：地址不可播（回源超时）')
  const { hot, cooled } = partitionByCooldown([a], 'tx')
  assert.strictEqual(hot.length, 1)
  assert.strictEqual(cooled.length, 0)
})

test('成功即清除冷却（与沉底账本同步清账）', () => {
  const a = mkApi('src-recover')
  const b = mkApi('src-other')
  notePlayCooldown(a, 'kg', '音源日志：回源超时')
  assert.strictEqual(partitionByCooldown([a, b], 'kg').cooled.length, 1)
  clearPlayFailure(a, 'kg')
  const { cooled } = partitionByCooldown([a, b], 'kg')
  assert.strictEqual(cooled.length, 0)
})
