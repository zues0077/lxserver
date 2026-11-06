import test from 'node:test'
import assert from 'node:assert'
import { judgeAudioMismatch } from '../src/utils/audioGuard'

/**
 * fileCache 防投毒判据（judgeAudioMismatch）的回归用例。
 *
 * 现场样本（2026-11-06 观察项深度测试，实机两次复现）：
 *   坏元数据条目「红昭愿 (DJ版) 音阙诗听 00:28」换源/直链拿到 173s 完整版，
 *   旧判据用 2×28+60=116s 当上限 →「明显长于预期 (173s / 预期 28s)」拒绝写入缓存，
 *   之后每次重播都要全链路重解析 + 整首 6.9MB 下载再丢弃。
 *
 * 两条底线：
 *  1. 元数据本身不可信（<30s 且曲名无豁免）时，好文件不得被「长上限」误杀
 *  2. 元数据可信（>=30s / 真铃声豁免词 / 曲名声明秒数吻合）时，串成长混音仍要拦
 */
test('观察项 1 现场：坏元数据 28s 不得拒掉 173s 好文件（修复点）', () => {
  const r = judgeAudioMismatch({ expectedSec: 28, actualSec: 173, name: '红昭愿 (DJ版)' })
  assert.strictEqual(r, null, `173s 好文件应放行，实际 ${r}`)
})

test('元数据 <30s 时不同长度的正常音频都放行（上限判据跳过）', () => {
  for (const actual of [35, 60, 116, 173, 240, 400]) {
    const r = judgeAudioMismatch({ expectedSec: 28, actualSec: actual, name: '红昭愿 (DJ版)' })
    assert.strictEqual(r, null, `actual=${actual}s 应放行，实际 ${r}`)
  }
})

test('真铃声豁免词：元数据可信，串成长音频仍拦（上限保持）', () => {
  const r = judgeAudioMismatch({ expectedSec: 28, actualSec: 173, name: '起床铃声' })
  assert.ok(r && r.includes('明显长于预期'), `真铃声串 173s 应拦，实际 ${r}`)
})

test('曲名自带秒数且与元数据吻合：元数据可信，上限保持', () => {
  // 「30秒铃声」声明 30s 与元数据 28s 在容差内 → 可信 → 173s > 116s 应拦
  const r = judgeAudioMismatch({ expectedSec: 28, actualSec: 173, name: '30秒铃声' })
  assert.ok(r && r.includes('明显长于预期'), `声明吻合时上限应保持，实际 ${r}`)
})

test('元数据 >=30s（可信）：长上限照常生效', () => {
  // 45*2+60=150 < 200 → 拦
  const r = judgeAudioMismatch({ expectedSec: 45, actualSec: 200, name: '测试曲' })
  assert.ok(r && r.includes('明显长于预期'), `expected=45 actual=200 应拦，实际 ${r}`)
  // 45*2+60=150 >= 145 → 放行
  assert.strictEqual(judgeAudioMismatch({ expectedSec: 45, actualSec: 145, name: '测试曲' }), null)
})

test('短下限判据不受影响：残片仍拦', () => {
  const r = judgeAudioMismatch({ expectedSec: 28, actualSec: 10, name: '红昭愿 (DJ版)' })
  assert.ok(r && r.includes('明显短于预期'), `10s 残片应拦，实际 ${r}`)
  assert.strictEqual(judgeAudioMismatch({ expectedSec: 28, actualSec: 26, name: '红昭愿 (DJ版)' }), null)
})

test('正常长曲分支（expected>60）回归：不受本次改动影响', () => {
  assert.strictEqual(judgeAudioMismatch({ expectedSec: 203, actualSec: 203, name: '红昭愿 (DJ版)' }), null)
  assert.strictEqual(judgeAudioMismatch({ expectedSec: 240, actualSec: 54, name: '岁月神偷' }), '音频过短 (54s / 预期 240s)')
  // 串成整张专辑：actual - expected > max(120, expected*0.6)
  assert.ok(judgeAudioMismatch({ expectedSec: 240, actualSec: 500, name: '岁月神偷' })?.includes('时长与曲目严重不符'))
})

test('不传 name（旧调用兼容）：<30s 元数据同样跳过长上限', () => {
  assert.strictEqual(judgeAudioMismatch({ expectedSec: 28, actualSec: 173 }), null)
})
