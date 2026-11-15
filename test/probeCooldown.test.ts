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
    PROBE_FAIL_BUDGET_MAX, PROBE_PAUSE_MS,
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
const probeFailAt = (id: string, t: number): { source?: string; budget?: string } => {
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
    assert.ok(cooled.source, `第 ${PROBE_FAIL_STREAK_MAX} 次连续失败应触发该源冷却`)

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
    assert.strictEqual(cooled.source, undefined, '清零后要从 1 重新数，不能接着上次的 2')
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

// ============ 三、整体试探预算：连续全败就停一段时间（与候选数无关）============

test('预算-1 连续 4 次试探失败（**不同源**也累加）→ 整体暂停，即使队首健康、候选充足也不再试探', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    // 四个互不相同的源各失败一次：按源冷却一个都不会触发（各自才 1 次），但整体预算是 4
    const ids = ['d1.js', 'd2.js', 'd3.js', 'd4.js']
    let last: { source?: string; budget?: string } = {}
    ids.forEach((id, i) => { last = probeFailAt(id, NOW - (50 - i * 10) * MIN) })
    assert.ok(last.budget, `第 ${PROBE_FAIL_BUDGET_MAX} 次连续全败应触发整体暂停`)
    assert.strictEqual(last.source, undefined, '这四个源各自只失败 1 次，不该触发按源冷却')

    const cand = [api('top.js'), api('u1.js'), api('u2.js')]
    assert.strictEqual(planProbeCandidate(cand, 'tx', '320k', NOW), undefined,
        '整体暂停期间不该再花预算试探')
})

test('预算-2 暂停 30min 后自动恢复（不许退化成永久关停）', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    ;['d1.js', 'd2.js', 'd3.js', 'd4.js'].forEach((id, i) => probeFailAt(id, NOW - (50 - i * 10) * MIN))
    const cand = [api('top.js'), api('u1.js'), api('u2.js')]
    assert.strictEqual(planProbeCandidate(cand, 'tx', '320k', NOW), undefined, '前置：应在暂停中')
    assert.ok(planProbeCandidate(cand, 'tx', '320k', NOW + PROBE_PAUSE_MS + MIN)?.api,
        '暂停到期后必须重新允许试探')
})

test('预算-3 中间成功一次就清零连败（3 败 + 1 成 + 2 败 ≠ 5）', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    probeFailAt('d1.js', NOW - 60 * MIN)
    probeFailAt('d2.js', NOW - 50 * MIN)
    probeFailAt('d3.js', NOW - 40 * MIN)
    noteProbeSuccessReset(T('d9.js'), 120, NOW - 30 * MIN)   // 试探成功打断连败
    probeFailAt('d4.js', NOW - 20 * MIN)
    const last = probeFailAt('d5.js', NOW - 10 * MIN)        // 累计才 2
    assert.strictEqual(last.budget, undefined, '成功后应重新计数，不能在 5 次失败时误判')
})

test('预算-4 按源冷却与整体暂停互不干扰（同源 3 连败只锁该源，不停整体）', () => {
    resetPlayRank(); resetProbeState()
    seedStableTop()
    notePlayResult(T('dead.js'), false, 0, NOW - 2 * HOUR)
    probeFailAt('dead.js', NOW - 50 * MIN)
    probeFailAt('dead.js', NOW - 40 * MIN)
    const third = probeFailAt('dead.js', NOW - 30 * MIN)
    assert.ok(third.source, '同源第 3 次应锁该源')
    assert.strictEqual(third.budget, undefined, '才 3 次连败，不该触发整体暂停（阈值是 4）')
    const cand = [api('top.js'), api('dead.js'), api('alive.js')]
    assert.strictEqual(planProbeCandidate(cand, 'tx', '320k', NOW)?.api?.info?.id, 'alive.js',
        '整体未暂停，仍应挑别的合格候选')
})

// ============ 四、判稳口径：尝试数下限 + 成功率（替代旧的「累计成功次数 ≥ 10」）============

test('判稳-1 kg 场景：成功率 80%、但累计成功只有 8 次 → 必须放行（旧口径会卡死）', () => {
    resetPlayRank(); resetProbeState()
    // 10 次尝试、8 次成功 = 80%，且最后一次是成功（避免落进「近期失败未恢复」那条）
    notePlayResult(T('top.js', 'kg'), false, 0, NOW - 60 * MIN)
    notePlayResult(T('top.js', 'kg'), false, 0, NOW - 59 * MIN)
    for (let i = 0; i < 8; i++) notePlayResult(T('top.js', 'kg'), true, 400, NOW - 58 * MIN + i)
    const rec = getPlayRankRecord(T('top.js', 'kg'))
    assert.strictEqual(rec?.successes, 8, '前置：累计成功 8 次，按旧口径 <10 会被卡')
    assert.ok(planProbeCandidate([api('top.js'), api('u1.js'), api('u2.js')], 'kg', '320k', NOW)?.api,
        '成功率 80% 已经算稳，不该因为只成功 8 次就不给试探机会')
})

test('判稳-2 跑得多但成功率低（10/20 = 50%）→ 必须拦住（旧口径会放行）', () => {
    resetPlayRank(); resetProbeState()
    for (let i = 0; i < 10; i++) notePlayResult(T('top.js'), false, 0, NOW - 60 * MIN + i)
    for (let i = 0; i < 10; i++) notePlayResult(T('top.js'), true, 400, NOW - 50 * MIN + i)
    const rec = getPlayRankRecord(T('top.js'))
    assert.strictEqual(rec?.successes, 10, '前置：累计成功 10 次，旧口径正好放行')
    assert.strictEqual(planProbeCandidate([api('top.js'), api('u1.js'), api('u2.js')], 'tx', '320k', NOW), undefined,
        '成功率只有 50%，说明队首自己就不稳，不该花预算探别人')
})

test('判稳-3 证据量不足：4 次尝试 4 次成功（100%）→ 仍要拦（防「1 次成功 = 100%」误判）', () => {
    resetPlayRank(); resetProbeState()
    for (let i = 0; i < 4; i++) notePlayResult(T('top.js'), true, 400, NOW - 10 * MIN + i)
    assert.strictEqual(planProbeCandidate([api('top.js'), api('u1.js'), api('u2.js')], 'tx', '320k', NOW), undefined,
        '才 4 次样本，成功率再高也不算「稳」')
})

test('判稳-4 边界：5 次尝试 4 次成功（80%）→ 放行', () => {
    resetPlayRank(); resetProbeState()
    notePlayResult(T('top.js'), false, 0, NOW - 20 * MIN)
    for (let i = 0; i < 4; i++) notePlayResult(T('top.js'), true, 400, NOW - 19 * MIN + i)
    assert.ok(planProbeCandidate([api('top.js'), api('u1.js'), api('u2.js')], 'tx', '320k', NOW)?.api,
        '刚好达到 5 次尝试下限、成功率 80%，应放行')
})
