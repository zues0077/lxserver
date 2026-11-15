/**
 * P0 规格测试（2026-11-15）：`PROBE_TOP_MAX_FAILS` 必须是「**近期**不稳」而不是「一辈子失败过」
 *
 * 现状（修复前）：判据是 `topRec.attempts - topRec.successes > PROBE_TOP_MAX_FAILS(2)`，
 * 累计失败数只增不减（`notePlayResult` 只做 +1），唯一能减小的路径是
 * `noteProbeSuccessReset`（只在试探成功时调用）→ 试探被此条卡住时永远不成功 → **死锁**。
 * 所以本文件在修复前应当是「红」的，修复后应当全绿，作为 R5 的验收标准。
 *
 * 现实镜像（246，2026-11-15 09:40 实测）：
 *   A 容器 `收集の聚合接口.js:tx:320k` = attempts 28 / successes 24（差 4）→ 该平台试探 0 次/2h
 *   B 容器 同键 = 26 / 26（差 0）→ 每轮（16min）都试
 * 两个容器账本不同，所以 R3/R4 的 A/B 在该维度上并不是单变量。
 */
import test from 'node:test'
import assert from 'node:assert'
import {
    notePlayResult, planProbeCandidate, resetPlayRank, resetProbeState,
} from '../src/server/sourcePlayRank'

const NOW = 1794700000000
const DAY = 86400_000
const MIN = 60_000

const api = (id: string) => ({ info: { owner: 'open', id, name: id } })
const mkCandidates = () => [api('top.js'), api('unproven-1.js'), api('unproven-2.js')]
const top = { owner: 'open', id: 'top.js', platform: 'tx', quality: '320k' }

test('P0-1 历史有 4 次失败但近期全成功 → 资格应成立（对照 246 A 的 28/24）', () => {
    resetPlayRank(); resetProbeState()
    for (let i = 0; i < 4; i++) notePlayResult(top, false, 0, NOW - 30 * DAY + i)   // 一个月前的失败
    for (let i = 0; i < 24; i++) notePlayResult(top, true, 400, NOW - MIN + i)     // 近期 24 连成
    const r = planProbeCandidate(mkCandidates(), 'tx', '320k', NOW)
    assert.ok(r?.api, '队首近期稳定成功就该允许试探')
    assert.strictEqual(r!.api.info.id, 'unproven-1.js')
})

test('P0-2 近期全成功（26/26）→ 资格成立（对照 246 B，现状本来就过）', () => {
    resetPlayRank(); resetProbeState()
    for (let i = 0; i < 26; i++) notePlayResult(top, true, 400, NOW - MIN + i)
    const r = planProbeCandidate(mkCandidates(), 'tx', '320k', NOW)
    assert.ok(r?.api)
})

test('P0-3 队首刚刚失败过（5 分钟内）→ 必须否决（这条是原有语义，不能放宽）', () => {
    resetPlayRank(); resetProbeState()
    for (let i = 0; i < 20; i++) notePlayResult(top, true, 400, NOW - 60 * MIN + i)
    notePlayResult(top, false, 0, NOW - 5 * MIN)
    assert.strictEqual(planProbeCandidate(mkCandidates(), 'tx', '320k', NOW), undefined,
        '队首自己都不稳时不该拿预算去探别人')
})

test('P0-4 失败率被稀释到 3% 时也要能恢复（现状：永久关停）', () => {
    resetPlayRank(); resetProbeState()
    for (let i = 0; i < 4; i++) notePlayResult(top, false, 0, NOW - 3 * DAY + i)
    for (let i = 0; i < 100; i++) notePlayResult(top, true, 400, NOW - 30 * MIN + i)
    assert.ok(planProbeCandidate(mkCandidates(), 'tx', '320k', NOW)?.api)
})

test('P0-5 时间不长记性：7 天后同一账本仍应成立（差值不许自己消失，但语义要看近期）', () => {
    resetPlayRank(); resetProbeState()
    for (let i = 0; i < 4; i++) notePlayResult(top, false, 0, NOW - 30 * DAY + i)
    for (let i = 0; i < 30; i++) notePlayResult(top, true, 400, NOW - 10 * MIN + i)
    assert.ok(planProbeCandidate(mkCandidates(), 'tx', '320k', NOW + 7 * DAY)?.api)
})
