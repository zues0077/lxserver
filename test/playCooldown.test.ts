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

// ---- 冷却源兜底提前（2026-11-08 soak c18/c77/c80：最高 7.4s）----
// 背景：冷却源原先必须等全部常规源失败才上场，而那三次「同源却更慢」样本里，
// 冷却中的源其实已经恢复，却要陪跑完前面所有失败。
import { planCooldownSequence, isPlatformSinkWindow } from '../src/server/userApi'

test('冷却源兜底提前：常规源 >2 个时，有历史成功记录的冷却源插到倒数第 2 个之前', () => {
  const hot = ['a', 'b', 'c', 'd', 'e'].map(id => mkApi(id))
  const good = mkApi('cooled-good')
  const bad = mkApi('cooled-bad')
  const plan = planCooldownSequence(hot, [good, bad], (api: any) => api.info.id === 'cooled-good', 2)
  assert.deepStrictEqual(plan.head.map((a: any) => a.info.id), ['a', 'b', 'c'])
  assert.deepStrictEqual(plan.promoted.map((a: any) => a.info.id), ['cooled-good'])
  assert.deepStrictEqual(plan.tail.map((a: any) => a.info.id), ['d', 'e'])
  assert.deepStrictEqual(plan.restCooled.map((a: any) => a.info.id), ['cooled-bad'],
    '从没成功过的冷却源不提前，仍留队尾')
  // 拼起来 = 实际尝试顺序：所有源都保留，只改顺序（可用性不变）
  const seq = [...plan.head, ...plan.promoted, ...plan.tail, ...plan.restCooled].map((a: any) => a.info.id)
  assert.deepStrictEqual(seq, ['a', 'b', 'c', 'cooled-good', 'd', 'e', 'cooled-bad'])
})

test('冷却源兜底提前：常规源 ≤2 个时保持原顺序（不把冷却源顶到最前）', () => {
  const hot = ['a', 'b'].map(id => mkApi(id))
  const good = mkApi('cooled-good')
  const plan = planCooldownSequence(hot, [good], () => true, 2)
  assert.deepStrictEqual(plan.head.map((a: any) => a.info.id), ['a', 'b'])
  assert.strictEqual(plan.promoted.length, 0)
})

test('冷却源兜底提前：无可提前的源时等价于原 hot+cooled', () => {
  const hot = ['a', 'b', 'c', 'd'].map(id => mkApi(id))
  const cooled = [mkApi('x'), mkApi('y')]
  const plan = planCooldownSequence(hot, cooled, () => false, 2)
  assert.deepStrictEqual([...plan.head, ...plan.tail].map((a: any) => a.info.id), ['a', 'b', 'c', 'd'])
  assert.deepStrictEqual(plan.restCooled.map((a: any) => a.info.id), ['x', 'y'])
})

// ---- 平台级故障窗口：沉底名单收敛（3h soak 出现「15 个源排到队尾」）----
test('平台级故障窗口：15/39 判为平台级故障（kg 风控窗口实测值）', () => {
  assert.strictEqual(isPlatformSinkWindow(15, 39), true)
  assert.strictEqual(isPlatformSinkWindow(13, 39), true)
  assert.strictEqual(isPlatformSinkWindow(12, 39), false, '不足候选 1/3 时仍按单源沉底')
  assert.strictEqual(isPlatformSinkWindow(7, 39), false)
  assert.strictEqual(isPlatformSinkWindow(8, 20), true)
  assert.strictEqual(isPlatformSinkWindow(0, 0), false)
})
