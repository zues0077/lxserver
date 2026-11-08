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

// ---- 阶梯冷却（2026-11-08）：连续超时逐档拉长，成功归零 ----
// 背景：固定 90 秒窗口下，裤佬这类「时好时坏」的源 8 小时里 8 次 5 秒满超时，
// 每次都是「超时 → 90 秒后再试 → 又超时」，同一个坑反复踩。
test('阶梯冷却：第二次超时窗口拉到 5 分钟（90 秒后不该恢复）', () => {
  const a = mkApi('src-ladder-2')
  notePlayCooldown(a, 'wy', '音源日志：取链超时（超过 5000ms 未返回）')
  notePlayCooldown(a, 'wy', '音源日志：取链超时（超过 5000ms 未返回）')
  const b = mkApi('src-ladder-2-other') // 单候选不冷却，必须凑两个才能验窗口
  const at90s = Date.now() + 90 * 1000 + 1
  assert.strictEqual(partitionByCooldown([a, b], 'wy', at90s).cooled.length, 1, '90 秒后应仍在冷却')
  const at5m = Date.now() + 5 * 60 * 1000 + 1
  assert.strictEqual(partitionByCooldown([a, b], 'wy', at5m).hot.length, 2, '5 分钟后应恢复')
})

test('阶梯冷却：第三次起封顶 15 分钟，不会无限增长', () => {
  const a = mkApi('src-ladder-3')
  for (let i = 0; i < 5; i++) notePlayCooldown(a, 'wy', '音源日志：回源超时')
  const b = mkApi('src-ladder-3-other')
  const at10m = Date.now() + 10 * 60 * 1000
  assert.strictEqual(partitionByCooldown([a, b], 'wy', at10m).cooled.length, 1, '15 分钟封顶内仍冷却')
  const at15m = Date.now() + 15 * 60 * 1000 + 1
  assert.strictEqual(partitionByCooldown([a, b], 'wy', at15m).hot.length, 2, '封顶 15 分钟后恢复')
})

test('阶梯冷却：成功一次立刻归零，下次超时回到最短的 90 秒', () => {
  const a = mkApi('src-ladder-reset')
  for (let i = 0; i < 3; i++) notePlayCooldown(a, 'kw', '音源日志：回源超时')
  clearPlayFailure(a, 'kw')
  notePlayCooldown(a, 'kw', '音源日志：回源超时')
  const b = mkApi('src-ladder-reset-other')
  const at90s = Date.now() + 90 * 1000 + 1
  assert.strictEqual(partitionByCooldown([a, b], 'kw', at90s).hot.length, 2,
    '成功过一次后，单次超时只冷却 90 秒（不因为历史挂过就长期缩短机会）')
})
