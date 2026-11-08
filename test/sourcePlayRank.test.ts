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
    notePlayResult,
    playRankScore,
    rankCandidatesByHistory,
    resetPlayRank,
    playRankSize,
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
