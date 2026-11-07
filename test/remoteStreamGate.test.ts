import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeRemoteGate, parseIntervalSeconds } from '../src/server/remoteStreamGate'
import { judgeTailProbe } from '../src/server/decodeProbe'

// —— parseIntervalSeconds ——

test('parseIntervalSeconds: m:ss / hh:mm:ss / 纯秒数', () => {
    assert.strictEqual(parseIntervalSeconds('04:13'), 253)
    assert.strictEqual(parseIntervalSeconds('01:02:03'), 3723)
    assert.strictEqual(parseIntervalSeconds('217'), 217)
    assert.strictEqual(parseIntervalSeconds(''), 0)
    assert.strictEqual(parseIntervalSeconds(undefined), 0)
    assert.strictEqual(parseIntervalSeconds('abc'), 0)
})

// —— judgeRemoteGate ——

const okWindows = [
    { at: 'head' as const, errLines: 0, sampled: true },
    { at: 'tail' as const, errLines: 0, sampled: true },
]

test('judgeRemoteGate: 正常直链（时长吻合、两窗口干净）→ 放行', () => {
    assert.deepStrictEqual(judgeRemoteGate(okWindows, 253.4, 253), { ok: true, kind: 'ok' })
})

test('judgeRemoteGate: 60 秒试听片段冒充整曲 → 拦截', () => {
    const r = judgeRemoteGate(okWindows, 60.0, 205)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.kind, 'preview')
    assert.match(r.reason || '', /60 秒片段/)
})

test('judgeRemoteGate: 曲目不足 60 秒不做试听判定（避免误杀短片）', () => {
    assert.deepStrictEqual(judgeRemoteGate(okWindows, 31, 45), { ok: true, kind: 'ok' })
})

test('judgeRemoteGate: 流时长未知（ffprobe 失败）不判试听，只看解码', () => {
    assert.deepStrictEqual(judgeRemoteGate(okWindows, 0, 253), { ok: true, kind: 'ok' })
})

test('judgeRemoteGate: A 型乱序（头部 2805 行错误）→ 拦截', () => {
    const r = judgeRemoteGate([{ at: 'head', errLines: 2805, sampled: true }, { at: 'tail', errLines: 0, sampled: true }], 253.4, 253)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.kind, 'corrupt')
    assert.match(r.reason || '', /head 窗口/)
})

test('judgeRemoteGate: B 型尾部乱序（头部干净、尾部 8219 行）→ 拦截', () => {
    const r = judgeRemoteGate([{ at: 'head', errLines: 0, sampled: true }, { at: 'tail', errLines: 8219, sampled: true }], 217, 217)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.kind, 'corrupt')
    assert.match(r.reason || '', /tail 窗口/)
})

test('judgeRemoteGate: 截断伪误差（≤9 行）放行（宁可漏杀不误杀）', () => {
    assert.deepStrictEqual(
        judgeRemoteGate([{ at: 'head', errLines: 3, sampled: true }, { at: 'tail', errLines: 2, sampled: true }], 217, 217),
        { ok: true, kind: 'ok' },
    )
})

test('judgeRemoteGate: 采样失败窗口（sampled=false）不参与判定', () => {
    assert.deepStrictEqual(
        judgeRemoteGate([{ at: 'head', errLines: -1, sampled: false }, { at: 'tail', errLines: -1, sampled: false }], 0, 0),
        { ok: true, kind: 'ok' },
    )
})

// —— judgeTailProbe（B 型尾部乱序的落盘抽检口径）——

test('judgeTailProbe: 已知损坏特征 ≥2 行 → 拦截', () => {
    const stderr = [
        '[flac @ 0x7415c46a48c0] invalid sync code',
        '[flac @ 0x7415c46a48c0] invalid sync code',
    ].join('\n')
    const r = judgeTailProbe(stderr)
    assert.strictEqual(r.ok, false)
    assert.match(r.reason || '', /invalid sync code/)
})

test('judgeTailProbe: 错误行数 ≥10 → 拦截', () => {
    const r = judgeTailProbe(Array.from({ length: 10 }, (_, i) => `err ${i}`).join('\n'))
    assert.strictEqual(r.ok, false)
})

test('judgeTailProbe: 干净尾部 / 低频零散错误 → 放行', () => {
    assert.deepStrictEqual(judgeTailProbe(''), { ok: true })
    assert.deepStrictEqual(judgeTailProbe('[flac] minor warning'), { ok: true })
})
