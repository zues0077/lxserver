import test from 'node:test'
import assert from 'node:assert'
import { judgePlaybackDuration, PLAYBACK_MIN_PLAUSIBLE_SEC } from '../src/utils/audioGuard'

/**
 * 投送前时长判据（L1）的回归用例。
 *
 * 数据全部来自 2026-11-06 小爱 3 小时压测的现场样本，每个 case 都写明来源，
 * 产品判据一改这里就会红。
 *
 * 两条底线：
 *  1. 真残片必须被抓出来（否则用户听到 11 秒就没了）
 *  2. 真短音频绝不能被误杀（`一万次悲伤 (54秒片段)` 是用户真想听的，被换掉就是 bug）
 */
test('压测现场 6 个残片样本必须判 suspect', () => {
  // 曲目 / 残片时长 / 同曲其它平台的正常时长（作为 expected）
  const samples: Array<[string, number, number]> = [
    ['光年之外', 11.311, 277], // kw 裤佬SVIP，同曲 tx 277s
    ['南山南', 11.311, 316], // kw 裤佬SVIP，同曲 kw 316s
    ['你的答案 (Live）', 60.7, 277], // wy，同曲 mg 277s
    ['一万次悲伤', 51, 264], // mg，同曲 wy 264s
    ['岁月神偷 (Live)', 19.752, 244], // tx 墨澜，同曲 wy 244s
  ]
  for (const [name, actual, expected] of samples) {
    const r = judgePlaybackDuration({ expectedSec: expected, actualSec: actual, name })
    assert.strictEqual(r.level, 'suspect', `${name} ${actual}s / 预期 ${expected}s 应判 suspect，实际 ${r.level}`)
    assert.ok(r.reason, `${name} 应给出原因`)
  }
})

test('真短音频必须放行，不能被当成残片换掉', () => {
  // 压测里唯一一个真短音频：曲名自带「54秒片段」，实际 54.7s
  const r = judgePlaybackDuration({ expectedSec: 337, actualSec: 54.7, name: '一万次悲伤 (54秒片段)' })
  assert.strictEqual(r.level, 'unknown', '曲名自带秒数的片段必须交白卷，不能参与换源判定')

  // 曲名声明 54 秒、实际 54.7 秒，即便 expected 是别的值也放行
  const r2 = judgePlaybackDuration({ expectedSec: 0, actualSec: 54.7, name: '一万次悲伤 54秒片段' })
  assert.strictEqual(r2.level, 'unknown')
})

test('铃声/纯音乐/伴奏等短内容豁免', () => {
  for (const name of ['起床铃声', '小星星 纯音乐', '稻香 伴奏', '雨声白噪音', 'Interlude']) {
    const r = judgePlaybackDuration({ expectedSec: 240, actualSec: 15, name })
    assert.strictEqual(r.level, 'unknown', `${name} 应被豁免，实际 ${r.level}`)
  }
})

test('正常歌曲判 ok', () => {
  const r = judgePlaybackDuration({ expectedSec: 243, actualSec: 243.5, name: '说散就散' })
  assert.strictEqual(r.level, 'ok')
})

test('expected 未知时用 30 秒绝对下限兜底', () => {
  // 压测里 11.3s / 19.8s 这类占位音，即使拿不到 expected 也要拦
  const short = judgePlaybackDuration({ actualSec: 11.311, name: '光年之外' })
  assert.strictEqual(short.level, 'suspect')
  assert.ok(short.reason?.includes('11'))
  assert.strictEqual(PLAYBACK_MIN_PLAUSIBLE_SEC, 30)

  // 正常长度但 expected 未知 → 不判定（unknown，放行），避免误伤
  const normal = judgePlaybackDuration({ actualSec: 240, name: '晴天' })
  assert.strictEqual(normal.level, 'unknown')
})

test('探不到时长（0）一律不判定', () => {
  assert.strictEqual(judgePlaybackDuration({ expectedSec: 240, actualSec: 0, name: '晴天' }).level, 'unknown')
})

test('短音频按相对比例判，不套长曲阈值', () => {
  // 预期 60s 的儿歌实际 55s：正常
  assert.strictEqual(judgePlaybackDuration({ expectedSec: 60, actualSec: 55, name: '小星星' }).level, 'ok')
  // 预期 60s 实际 20s：残片
  assert.strictEqual(judgePlaybackDuration({ expectedSec: 60, actualSec: 20, name: '小星星' }).level, 'suspect')
})

test('刚好一半边界放行（阈值取宽，宁漏不误杀）', () => {
  const r = judgePlaybackDuration({ expectedSec: 240, actualSec: 120, name: '测试曲' })
  assert.strictEqual(r.level, 'ok', '恰好 50% 不判残片，避免误伤正常的前奏较长版本')
})
