import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paceWaitMs, resolvePacingRate } from '../src/server/xiaoai/stream'

/**
 * 平滑下发码率校正。
 *
 * 2026-11-05 实机故障：上限曾写成 0.1 B/ms（本意 800bps），
 * 把所有正常歌曲（≈40 B/ms）判成「时长不可信」夹到 0.04 B/ms，
 * 一路流只发得出 1 个 64KB 分块（≈1.6 秒音频），之后要等 25 分钟才轮到下一块。
 * 设备等到超时断开 → Range 续传 → 又只拿到 1.6 秒，听感就是「响一两秒、断断续续」。
 *
 * 这里的用例锁死单位（B/ms），任何把上限写小三个数量级的改动都会立刻转红。
 */

/** 320kbps ≈ 40.96 B/ms */
const RATE_320K = 40.96

test('320kbps 的原始码率必须被原样放行（不被当成不可信夹掉）', () => {
  const raw = 8261004 / 197000 // 真实样本：悬溺 8.26MB / 197s
  const rate = resolvePacingRate(raw)
  assert.ok(Math.abs(rate - raw) < 0.001, `应原样放行，实际 ${rate}`)
  assert.ok(rate > 40 && rate < 43, `应落在 320k 区间，实际 ${rate}`)
})

test('常见码率档位都放行', () => {
  for (const [label, raw] of [
    ['128k', 16],
    ['192k', 24],
    ['256k', 32],
    ['320k', 40.96],
  ] as const) {
    assert.strictEqual(resolvePacingRate(raw), raw, `${label} 不应被改写`)
  }
})

test('时长不可信导致码率被放大时，夹回 320k 兜底（防灌爆）', () => {
  // 225s 的歌被算成剩 36s：8261004 / 36000 ≈ 229 B/ms，放大 5.6 倍
  assert.strictEqual(resolvePacingRate(8261004 / 36000), (320 * 1024) / 8 / 1000)
  // 更夸张的错值也一样兜底
  assert.strictEqual(resolvePacingRate(5000), (320 * 1024) / 8 / 1000)
})

test('上限本身必须大于任何真实音源（> 40.96 B/ms）', () => {
  // 直接断言数值区间：如果上限又被人写小，这里先红
  const justAbove320k = RATE_320K * 1.5
  assert.strictEqual(resolvePacingRate(justAbove320k), justAbove320k, '1.5 倍 320k 仍应放行')
})

test('无时长 / 非法输入退回纯背压（返回 0，不节流）', () => {
  assert.strictEqual(resolvePacingRate(0), 0)
  assert.strictEqual(resolvePacingRate(-1), 0)
  assert.strictEqual(resolvePacingRate(Number.NaN), 0)
  assert.strictEqual(resolvePacingRate(Number.POSITIVE_INFINITY), 0)
  assert.strictEqual(resolvePacingRate(0.0005), 0)
})

test('起播第一个 64KB 分块不需要等待（垫子 30s 足够覆盖）', () => {
  const rate = resolvePacingRate(8261004 / 197000)
  const wait = paceWaitMs(64 * 1024, 0, rate, 30000)
  assert.strictEqual(wait, 0, `起播不应等待，实际 ${wait}ms`)
})

test('正常码率下第 10 个分块也只等秒级，不会卡成分钟', () => {
  const rate = resolvePacingRate(8261004 / 197000)
  const sent = 10 * 64 * 1024
  const wait = paceWaitMs(sent, 0, rate, 30000)
  // 640KB / 41.9 ≈ 15.3s，已用 0ms，垫子 30s → 预算内，仍为 0
  assert.strictEqual(wait, 0, `垫子内不应等待，实际 ${wait}ms`)
})

test('发到超出垫子后，等待时长按 1.1 倍实时节奏收敛（不是分钟级）', () => {
  const rate = resolvePacingRate(8261004 / 197000)
  // 假设已过 60 秒，发了 60 秒的量
  const sentBytes = Math.round(60 * 1000 * rate)
  const wait = paceWaitMs(sentBytes, 60000, rate, 30000)
  assert.ok(wait >= 0 && wait < 5000, `应按秒级微调，实际 ${wait}ms`)
})

test('回归：若码率被误夹到 0.04 B/ms，起播会卡到分钟级（复现旧 bug 的判据）', () => {
  const broken = paceWaitMs(64 * 1024, 0, 0.04, 30000)
  assert.ok(broken > 60_000, `旧 bug 下应出现分钟级等待，实际 ${broken}ms`)
})
