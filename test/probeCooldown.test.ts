/**
 * 2026-11-15 R5-a 收尾的两处修复的规格测试。
 *
 * 背景（246 第五轮 A/B，report5.csv 24 轮 × 双容器）：
 *  - A（旧判据）队首 03:03:58 失败 → 03:09:25 立刻试探（时间盲）；
 *  - B（新判据）两次失败后各静默 5 轮、约 30.2/30.7 分钟才恢复 —— 但两个窗口里
 *    队首在 03:09–03:29、04:00–04:15 **实际都成功**，11 次否决里 9 次是误伤，
 *    2 小时共约 50min（43% 窗口）白静默。根因：只写不清的 lastFailAt。
 *  - 试探命中率 1/17 = 5.9%，B 侧 4/7、A 侧 3/10 打在墨澜/裤佬两个死源上 ——
 *    挑「最久未试」必然反复挑中永不成功的源。
 *
 * 本文件锁两件事：
 *  一、队首判据必须是「最后一次失败之后没有成功过」才算不稳（成功即恢复）；
 *  二、同一源连续试探失败达上限后进冷却，冷却期内不再被挑。
 */
import test from 'node:test'
import assert from 'node:assert'
import {
    notePlayResult, planProbeCandidate, resetPlayRank, resetProbeState,
    noteProbeFail, noteProbeSuccessReset, getPlayRankRecord,
    exportPlayRankState, importPlayRankState,
    PROBE_INTERVAL_MS, PROBE_FAIL_STREAK_MAX, PROBE_COOLDOWN_MS,
    PROBE_TOP_RECENT_FAIL_MS, STALE_FAIL_MS,
} from '../src/server/sourcePlayRank'

const NOW = 1794700000000
const MIN = 60_000
const HOUR = 60 * MIN

const api = (id: string) => ({ info: { owner: 'open', id, name: id } })
const T = (id: string, platform = 'tx', quality = '320k') => ({ owner: 'open', id, platform, quality })

/** 队首：样本足、近期全成功 */
const seedStableTop = (now = NOW) => {
    for (let i = 0; i < 20; i++) notePlayResult(T('top.js'), true, 300, now - 60 * MIN + i)
}

/** 模拟一次「试探失败」在真实链路里的两步：先记账（建记录），再记试探失败 */
const probeFailAt = (id: string, t: number): string | undefined => {
    notePlayResult(T(id), false, 0, t)
    return noteProbeFail(T(id), t)
}

// ============ 一、队首判据：失败之后成功过 = 已恢复 ============

test('恢复-1 队首失败后同轮又成功 → 立刻恢复试探（对照 R5 的 03:04 失败 / 03:09 成功）', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    notePlayResult(T('top.js'), false, 0, NOW - 5 * MIN)   // 03:04 那次
    notePlayResult(T('top.js'), true, 300, NOW - 1 * MIN)  // 之后又成功了
    const r = planProbeCandidate([api('top.js'), api('u1.js'), api('u2.js')], 'tx', '320k', NOW)
    assert.ok(r?.api, '队首已经恢复，不该再按「近期失败」静默 30 分钟')
    assert.strictEqual(r!.api.info.id, 'u1.js')
})

test('恢复-2 队首失败后一直没成功 → 仍否决（这条是原有语义，不能被放宽掉）', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    notePlayResult(T('top.js'), false, 0, NOW - 5 * MIN)
    assert.strictEqual(
        planProbeCandidate([api('top.js'), api('u1.js'), api('u2.js')], 'tx', '320k', NOW), undefined,
        '队首自己都不稳时不该拿预算去探别人')
})

test('恢复-3 失败后没成功，但已超 30min → 按衰减放行', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    notePlayResult(T('top.js'), false, 0, NOW - PROBE_TOP_RECENT_FAIL_MS - MIN)
    assert.ok(planProbeCandidate([api('top.js'), api('u1.js'), api('u2.js')], 'tx', '320k', NOW)?.api,
        '失败证据 30min 后过期，不该永久关停（这是 P0 的老 bug）')
})

test('恢复-4 试探成功会写 lastOkAt，不能刚被验证健康又被旧失败卡住', () => {
    resetPlayRank(); resetProbeState()
    notePlayResult(T('x.js'), false, 0, NOW - 10 * MIN)
    noteProbeSuccessReset(T('x.js'), 120, NOW)
    const rec = getPlayRankRecord(T('x.js'))
    assert.strictEqual(Number(rec?.lastOkAt), NOW, '试探成功就是成功证据，必须落到 lastOkAt')
    assert.strictEqual(Number(rec?.lastFailAt) || 0, 0, '重置后的记录不该还挂着旧失败时间')
})

// ============ 二、试探冷却：连续失败达上限就不再挑它 ============

test('冷却-1 连续试探失败 3 次 → 进冷却，下一轮改挑别人（对照组同一账本不计数时会挑它）', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    // 让 dead.js 变成「失败证据已过期」的可试探候选，且三次失败后 lastAt 刚好不新鲜
    notePlayResult(T('dead.js'), false, 0, NOW - 2 * HOUR)
    probeFailAt('dead.js', NOW - 50 * MIN)
    probeFailAt('dead.js', NOW - 40 * MIN)
    const cooled = probeFailAt('dead.js', NOW - 30 * MIN)
    assert.ok(cooled, `第 ${PROBE_FAIL_STREAK_MAX} 次连续失败应触发冷却`)

    const cand = [api('top.js'), api('dead.js'), api('alive.js')]
    const r = planProbeCandidate(cand, 'tx', '320k', NOW)
    assert.strictEqual(r?.api?.info?.id, 'alive.js', '冷却中的死源不该再被挑中')
})

test('冷却-2 同一账本、不记试探失败时仍会挑中死源（证明差异来自冷却而不是别的条件）', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    notePlayResult(T('dead.js'), false, 0, NOW - 2 * HOUR)
    for (const t of [NOW - 50 * MIN, NOW - 40 * MIN, NOW - 30 * MIN]) notePlayResult(T('dead.js'), false, 0, t)
    const r = planProbeCandidate([api('top.js'), api('dead.js'), api('alive.js')], 'tx', '320k', NOW)
    assert.strictEqual(r?.api?.info?.id, 'dead.js', '这是修改前的行为：死源会被反复挑中')
})

test('冷却-3 冷却到期后重新可被挑中（不许退化成永久关停）', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    notePlayResult(T('dead.js'), false, 0, NOW - 2 * HOUR)
    probeFailAt('dead.js', NOW - 50 * MIN)
    probeFailAt('dead.js', NOW - 40 * MIN)
    probeFailAt('dead.js', NOW - 30 * MIN)
    const cand = [api('top.js'), api('dead.js'), api('alive.js')]
    const later = planProbeCandidate(cand, 'tx', '320k', NOW + PROBE_COOLDOWN_MS + MIN)
    assert.strictEqual(later?.api?.info?.id, 'dead.js',
        `冷却 ${PROBE_COOLDOWN_MS / HOUR}h 后应重新给一次机会，否则就是老 bug 复发`)
})

test('冷却-4 试探成功会清零连续失败计数（失败 2 次 + 成功 1 次 ≠ 3 次）', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    notePlayResult(T('flaky.js'), false, 0, NOW - 2 * HOUR)
    probeFailAt('flaky.js', NOW - 50 * MIN)
    probeFailAt('flaky.js', NOW - 40 * MIN)
    noteProbeSuccessReset(T('flaky.js'), 150, NOW - 30 * MIN)
    assert.strictEqual(Number(getPlayRankRecord(T('flaky.js'))?.probeFails) || 0, 0, '成功后计数应清零')
    notePlayResult(T('flaky.js'), false, 0, NOW - 20 * MIN)
    const cooled = probeFailAt('flaky.js', NOW - 10 * MIN)
    assert.strictEqual(cooled, undefined, '清零后要从 1 重新数，不能接着上次的 2')
})

test('冷却-5 冷却状态必须能落盘往返（否则重启即失效，同 lastFailAt 的教训）', () => {
    resetPlayRank(); resetProbeState()
    notePlayResult(T('dead.js'), false, 0, NOW - 50 * MIN)
    probeFailAt('dead.js', NOW - 45 * MIN)
    probeFailAt('dead.js', NOW - 40 * MIN)
    probeFailAt('dead.js', NOW - 30 * MIN)
    const skipUntil = Number(getPlayRankRecord(T('dead.js'))?.probeSkipUntil)
    assert.ok(skipUntil > NOW, '前置条件：应已在冷却中')

    const state = exportPlayRankState(NOW)
    resetPlayRank()
    const n = importPlayRankState(state, NOW)
    assert.ok(n > 0, '应至少载回 1 条')
    assert.strictEqual(Number(getPlayRankRecord(T('dead.js'))?.probeSkipUntil), skipUntil,
        'probeSkipUntil 必须跟着账本落盘，否则重启后死源又会被白试一遍')
})

test('冷却-6 节流仍优先：距上次试探不足 10min 时连冷却判断都不该走到', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    const cand = [api('top.js'), api('u1.js'), api('u2.js')]
    assert.ok(planProbeCandidate(cand, 'tx', '320k', NOW)?.api)
    assert.strictEqual(planProbeCandidate(cand, 'tx', '320k', NOW + MIN), undefined, '10min 节流不能被绕过')
    assert.ok(planProbeCandidate(cand, 'tx', '320k', NOW + PROBE_INTERVAL_MS)?.api)
})

test('冷却-7 新鲜失败优先于冷却（刚翻车的源不会因为条件顺序被放进来）', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    notePlayResult(T('dead.js'), false, 0, NOW - 2 * HOUR)   // 旧失败：可试
    notePlayResult(T('dead.js'), false, 0, NOW - 5 * MIN)    // 新失败：新鲜，必须跳过
    const r = planProbeCandidate([api('top.js'), api('dead.js'), api('alive.js')], 'tx', '320k', NOW)
    assert.strictEqual(r?.api?.info?.id, 'alive.js', '刚失败 5 分钟的源不该被推上队首')
    assert.ok(STALE_FAIL_MS > 5 * MIN)
})
