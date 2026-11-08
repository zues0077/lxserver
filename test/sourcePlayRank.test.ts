/**
 * 按历史成绩正向排序（sourcePlayRank）。
 *
 * 背景：沉底/短路都只做减法，好源之间谁先上仍然由 order.json / 加载顺序决定，
 * 而实测同一平台同档位的源快慢差 17 倍（110ms vs 1.9s）。这里钉住三条规则：
 * 样本不足不动手、从没成功过垫底、分数相同保持原顺序。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
    NEUTRAL_MS,
    MIN_TRUST,
    FAIL_PENALTY_MS,
    notePlayResult,
    playRankScore,
    rankCandidatesByHistory,
    resetPlayRank,
    playRankSize,
    playRankSnapshot,
    adaptiveTimeoutMs,
    ADAPTIVE_TIMEOUT_MIN_MS,
    ADAPTIVE_TIMEOUT_MAX_MS,
} from '../src/server/sourcePlayRank'

const T = (id: string, platform = 'wy', quality = '320k') => ({ owner: 'open', id, platform, quality })
const api = (id: string) => ({ info: { id, name: id, owner: 'open' } })
const ids = (list: any[]) => list.map((x: any) => x.info.id)

test('没有样本 → 中性分，不参与重排', () => {
    resetPlayRank()
    assert.strictEqual(playRankScore(T('a')), NEUTRAL_MS)
})

test(`样本不足（< ${MIN_TRUST} 次）也保持中性：一次偶然快慢不能重排`, () => {
    resetPlayRank()
    notePlayResult(T('a'), true, 50)
    assert.strictEqual(playRankScore(T('a')), NEUTRAL_MS)
})

test('成功且够样本 → 按耗时升序；快的排前面', () => {
    resetPlayRank()
    for (let i = 0; i < 3; i++) notePlayResult(T('slow'), true, 2000)
    for (let i = 0; i < 3; i++) notePlayResult(T('fast'), true, 200)
    const ranked = rankCandidatesByHistory([api('slow'), api('fast')], 'wy', '320k')
    assert.deepStrictEqual(ids(ranked), ['fast', 'slow'])
})

test('从没成功过的源垫底，即使它"很快"失败', () => {
    resetPlayRank()
    notePlayResult(T('always-fail'), false, 10)
    notePlayResult(T('always-fail'), false, 10)
    notePlayResult(T('ok'), true, 1500)
    notePlayResult(T('ok'), true, 1500)
    const ranked = rankCandidatesByHistory([api('always-fail'), api('ok')], 'wy', '320k')
    assert.deepStrictEqual(ids(ranked), ['ok', 'always-fail'])
})

test('成功率折算：快但一半失败的源，不如慢一点但稳定的源', () => {
    resetPlayRank()
    // flaky：300ms 平均，6 次里 3 次失败
    for (let i = 0; i < 6; i++) notePlayResult(T('flaky'), i % 2 === 0, 300)
    // steady：700ms，全成功
    for (let i = 0; i < 4; i++) notePlayResult(T('steady'), true, 700)
    assert.ok(playRankScore(T('steady')) < playRankScore(T('flaky')))
})

test('同分保持原相对顺序（稳定排序）', () => {
    resetPlayRank()
    const ranked = rankCandidatesByHistory([api('c'), api('a'), api('b')], 'wy', '320k')
    assert.deepStrictEqual(ids(ranked), ['c', 'a', 'b'])
})

test('不改入参', () => {
    resetPlayRank()
    notePlayResult(T('slow'), true, 2000)
    notePlayResult(T('slow'), true, 2000)
    notePlayResult(T('fast'), true, 100)
    notePlayResult(T('fast'), true, 100)
    const list = [api('slow'), api('fast')]
    rankCandidatesByHistory(list, 'wy', '320k')
    assert.deepStrictEqual(ids(list), ['slow', 'fast'])
})

test('不同档位分开统计：320k 快不代表 flac 快', () => {
    resetPlayRank()
    notePlayResult(T('a', 'wy', '320k'), true, 100)
    notePlayResult(T('a', 'wy', '320k'), true, 100)
    assert.ok(playRankScore(T('a', 'wy', '320k')) < NEUTRAL_MS)
    assert.strictEqual(playRankScore(T('a', 'wy', 'flac')), NEUTRAL_MS)
})

test('没有音质档不记（无从区分，记了只会互相污染）', () => {
    resetPlayRank()
    notePlayResult(T('a', 'wy', ''), true, 100)
    assert.strictEqual(playRankSize(), 0)
})

test('单次异常大值被夹住，不会把均值带飞', () => {
    resetPlayRank()
    notePlayResult(T('a'), true, 100)
    notePlayResult(T('a'), true, 100)
    const before = playRankScore(T('a'))
    notePlayResult(T('a'), true, 6 * 60 * 60 * 1000) // 6 小时的荒谬值
    assert.ok(playRankScore(T('a')) < before * 10)
})

test('诊断快照：只列有成功样本的源，按分数升序，分数与 ewma+失败惩罚同口径', () => {
    resetPlayRank()
    notePlayResult(T('slow'), true, 1800)
    notePlayResult(T('slow'), true, 1800)
    notePlayResult(T('fast'), true, 100)
    notePlayResult(T('fast'), true, 100)
    notePlayResult(T('half'), true, 200)
    notePlayResult(T('half'), false)
    notePlayResult(T('dead'), false)
    notePlayResult(T('dead'), false)
    const snap = playRankSnapshot()
    assert.deepStrictEqual(snap.top.map(r => r.key.split(':')[1]), ['fast', 'half', 'slow'])
    assert.strictEqual(snap.total, 4)
    // half：200 + 0.5*FAIL_PENALTY，应当落在 fast(100) 与 slow(1800) 之间
    assert.strictEqual(snap.top[1].score, 200 + 0.5 * FAIL_PENALTY_MS)
    assert.ok(!snap.top.some(r => r.key.indexOf('dead') >= 0), '从未成功的源不该出现在快照里')
})

test('诊断快照 limit 生效，空账本不报错', () => {
    resetPlayRank()
    assert.deepStrictEqual(playRankSnapshot().top, [])
    for (const id of ['a', 'b', 'c']) {
        notePlayResult(T(id), true, 100)
        notePlayResult(T(id), true, 100)
    }
    assert.strictEqual(playRankSnapshot(2).top.length, 2)
})

test('换位要过门槛：差距不够明显时保持原顺序（避免顺序在两套之间摆动）', () => {
    resetPlayRank()
    // 1000ms vs 900ms：只差 100ms、10%，换位没有意义
    notePlayResult(T('a'), true, 1000)
    notePlayResult(T('a'), true, 1000)
    notePlayResult(T('b'), true, 900)
    notePlayResult(T('b'), true, 900)
    const ranked = rankCandidatesByHistory([api('a'), api('b')], 'wy', '320k')
    assert.deepStrictEqual(ids(ranked), ['a', 'b'])
})

test('换位要过门槛：明显更快（>300ms 且 >25%）才换到前面', () => {
    resetPlayRank()
    notePlayResult(T('slow'), true, 1800)
    notePlayResult(T('slow'), true, 1800)
    notePlayResult(T('fast'), true, 100)
    notePlayResult(T('fast'), true, 100)
    const ranked = rankCandidatesByHistory([api('slow'), api('fast')], 'wy', '320k')
    assert.deepStrictEqual(ids(ranked), ['fast', 'slow'])
})

test('只有 25% 相对优势但仍差 300ms 以上时才换位（两个门槛都要满足）', () => {
    resetPlayRank()
    // 400 -> 250：差 150ms（<300），相对 37%，仍不换
    notePlayResult(T('a'), true, 400)
    notePlayResult(T('a'), true, 400)
    notePlayResult(T('b'), true, 250)
    notePlayResult(T('b'), true, 250)
    assert.deepStrictEqual(ids(rankCandidatesByHistory([api('a'), api('b')], 'wy', '320k')), ['a', 'b'])
    // 1600 -> 1100：差 500ms 且相对 31%，两个门槛都过 → 换
    resetPlayRank()
    notePlayResult(T('a'), true, 1600)
    notePlayResult(T('a'), true, 1600)
    notePlayResult(T('b'), true, 1100)
    notePlayResult(T('b'), true, 1100)
    assert.deepStrictEqual(ids(rankCandidatesByHistory([api('a'), api('b')], 'wy', '320k')), ['b', 'a'])
})

test('自适应单源超时：无样本 / 样本不足 / 从未成功 → 保持 5s（不猜）', () => {
    resetPlayRank()
    assert.strictEqual(adaptiveTimeoutMs(T('unknown')), ADAPTIVE_TIMEOUT_MAX_MS)
    // 只有 1 次尝试：低于 MIN_TRUST
    notePlayResult(T('once'), true, 120)
    assert.strictEqual(adaptiveTimeoutMs(T('once')), ADAPTIVE_TIMEOUT_MAX_MS)
    // 两次都失败：没有成功样本，无从判断快慢
    notePlayResult(T('dead'), false)
    notePlayResult(T('dead'), false)
    assert.strictEqual(adaptiveTimeoutMs(T('dead')), ADAPTIVE_TIMEOUT_MAX_MS)
})

test('自适应单源超时：已知快源压到 3s（挂死时少等 2 秒）', () => {
    resetPlayRank()
    notePlayResult(T('fast'), true, 140)
    notePlayResult(T('fast'), true, 150)
    // EWMA≈150 → 4×150=600 < 3000，夹到下限
    assert.strictEqual(adaptiveTimeoutMs(T('fast')), ADAPTIVE_TIMEOUT_MIN_MS)
})

test('自适应单源超时：慢源（EWMA 1.6s）仍是 5s，行为与改动前一致', () => {
    resetPlayRank()
    notePlayResult(T('slow'), true, 1600)
    notePlayResult(T('slow'), true, 1600)
    assert.strictEqual(adaptiveTimeoutMs(T('slow')), ADAPTIVE_TIMEOUT_MAX_MS)
})

test('自适应单源超时：中间档给 4 倍 EWMA，且不超过 5s', () => {
    resetPlayRank()
    notePlayResult(T('mid'), true, 900)
    notePlayResult(T('mid'), true, 900)
    assert.strictEqual(adaptiveTimeoutMs(T('mid')), 3600)
    resetPlayRank()
    for (let i = 0; i < 3; i++) notePlayResult(T('mid2'), true, 5000)
    assert.strictEqual(adaptiveTimeoutMs(T('mid2')), ADAPTIVE_TIMEOUT_MAX_MS)
})

test('自适应单源超时按「源 × 平台 × 档」隔离：别的档位的成绩不影响这一档', () => {
    resetPlayRank()
    notePlayResult(T('dual', 'wy', '128k'), true, 120)
    notePlayResult(T('dual', 'wy', '128k'), true, 120)
    assert.strictEqual(adaptiveTimeoutMs(T('dual', 'wy', '128k')), ADAPTIVE_TIMEOUT_MIN_MS)
    assert.strictEqual(adaptiveTimeoutMs(T('dual', 'wy', '320k')), ADAPTIVE_TIMEOUT_MAX_MS)
})

// ---- 跨档先验（2026-11-08）：本档没样本时，用同源别的键的成绩提前 ----
// 背景：重启后账本清零，裤佬 wy 先攒到 9 次样本（EWMA 1798ms）排第一，
// 墨澜 wy 只被试了 1 次（160ms）→ 样本不足给中性 1200ms → 160ms 的源排在 1798ms 之后，
// 同一首歌 17952 要 728~2661ms、17950 只要 136~239ms。而墨澜在 mg 上早有 4 次样本（426ms）。
test('跨档先验：本档样本不足时，用同源别的平台的成绩把它提前', () => {
    resetPlayRank()
    // 裤佬：wy 本档 9 次成功 1798ms
    for (let i = 0; i < MIN_TRUST; i++) notePlayResult(T('kulao'), true, 1798)
    // 墨澜：mg 4 次 426ms（别的平台），wy 只有 1 次 160ms（不够 MIN_TRUST）
    for (let i = 0; i < 4; i++) notePlayResult(T('molan', 'mg'), true, 426)
    notePlayResult(T('molan', 'wy'), true, 160)
    const ranked = rankCandidatesByHistory([api('kulao'), api('molan')], 'wy', '320k')
    assert.deepStrictEqual(ids(ranked), ['molan', 'kulao'],
        '160ms(1 次) + 同源 426ms 先验 = 426，应当胜过 1798ms')
})

test('跨档先验只提前、不惩罚：同源别档很慢时，本档仍按中性分算', () => {
    resetPlayRank()
    for (let i = 0; i < 4; i++) notePlayResult(T('slowelsewhere', 'mg'), true, 4000)
    // 本档无样本：先验 4000 > 中性 1200 → 取 1200，不因为别的平台慢就沉底
    assert.strictEqual(playRankScore(T('slowelsewhere')), NEUTRAL_MS)
})

test('跨档先验在本档攒到 2 次样本后自动失效', () => {
    resetPlayRank()
    for (let i = 0; i < 4; i++) notePlayResult(T('dual', 'mg'), true, 100)
    notePlayResult(T('dual', 'wy'), true, 2500)
    notePlayResult(T('dual', 'wy'), true, 2500)
    assert.strictEqual(playRankScore(T('dual', 'wy')), 2500, '本档自己的 2500ms 说了算，不再借用 100ms 先验')
})

test('从未成功的记录不参与先验：别的键再快也抬不动它', () => {
    resetPlayRank()
    for (let i = 0; i < 4; i++) notePlayResult(T('mixed', 'mg'), true, 100)
    notePlayResult(T('mixed', 'wy'), false) // 本档失败一次、从未成功
    assert.strictEqual(playRankScore(T('mixed', 'wy')), NEUTRAL_MS)
})

// ---- 失败惩罚上调（2026-11-08 soak：排前源连续失败两轮才让位）----
test('失败惩罚 3000ms：快但一半失败的源落到健康源之后', () => {
    resetPlayRank()
    // 300ms 级 EWMA + 50% 失败率 = 300 + 1500 = 1800 > 中性 1200
    notePlayResult(T('flaky'), true, 300)
    notePlayResult(T('flaky'), false)
    assert.strictEqual(playRankScore(T('flaky')), 300 + 0.5 * FAIL_PENALTY_MS)
    assert.ok(playRankScore(T('flaky')) > NEUTRAL_MS,
        '第一轮失败就该落到中性分之下，不必等第二轮超时把它打进冷却')
})

test('失败惩罚不误伤全成功的快源：300ms 全成功仍远优于中性分', () => {
    resetPlayRank()
    notePlayResult(T('clean'), true, 300)
    notePlayResult(T('clean'), true, 300)
    assert.strictEqual(playRankScore(T('clean')), 300)
    assert.ok(playRankScore(T('clean')) < NEUTRAL_MS)
})
