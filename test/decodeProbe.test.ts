import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeDecodeProbe } from '../src/server/decodeProbe'

// 实测《胡广生》坏 m4a（汽水源侧，2026-11-07）的 ffmpeg -v error 输出
const BAD_AAC_STDERR = [
    '[aac @ 0x5ff4fdcd2d00] Prediction is not allowed in AAC-LC.',
    '[aist#0:0/aac] [dec:aac] Error submitting packet to decoder: Invalid data found when processing input',
    '[aac @ 0x5ff4fdcd2d00] Number of bands (20) exceeds limit (16).',
    '[aist#0:0/aac] Decode error rate 0.998522 exceeds maximum 0.666667',
].join('\n')

test('judgeDecodeProbe: 已知 AAC 流损坏特征 → 拦截', () => {
    const r = judgeDecodeProbe(BAD_AAC_STDERR, 0)
    assert.strictEqual(r.ok, false)
    assert.match(r.reason || '', /Prediction is not allowed/)
})

test('judgeDecodeProbe: channel element / bands 越界特征 → 拦截', () => {
    assert.strictEqual(judgeDecodeProbe('[aac] channel element 3.10 is not allocated', 0).ok, false)
    assert.strictEqual(judgeDecodeProbe('[aac] Number of bands (20) exceeds limit (16).', 0).ok, false)
    assert.strictEqual(judgeDecodeProbe('[mp3] Invalid data found when processing input', 0).ok, false)
})

test('judgeDecodeProbe: 大量零散解码错误（≥3 行）→ 拦截', () => {
    const r = judgeDecodeProbe('error one\nerror two\nerror three', 0)
    assert.strictEqual(r.ok, false)
    assert.match(r.reason || '', /3 行/)
})

test('judgeDecodeProbe: 正常文件（stderr 空、退出码 0）→ 放行', () => {
    assert.deepStrictEqual(judgeDecodeProbe('', 0), { ok: true })
})

test('judgeDecodeProbe: 单行轻微警告（<3 行且无已知特征）→ 放行（宁可漏杀不误杀）', () => {
    assert.deepStrictEqual(judgeDecodeProbe('[mov,mp4,m4a] minor header warning', 0), { ok: true })
})

test('judgeDecodeProbe: 退出码非 0（无特征输出）→ 拦截', () => {
    const r = judgeDecodeProbe('Unknown format', 1)
    assert.strictEqual(r.ok, false)
    assert.match(r.reason || '', /退出码 1/)
})

test('judgeDecodeProbe: 空 stderr + 退出码 0 + null 输入 → 放行', () => {
    assert.deepStrictEqual(judgeDecodeProbe('', 0), { ok: true })
    assert.deepStrictEqual(judgeDecodeProbe(String(undefined), 0), { ok: true })
})
