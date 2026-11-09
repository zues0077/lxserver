/**
 * T9 · 八源聚合（source=all）跨源 ID 碰撞回归。
 *
 * 上游 any-listen v2.2.0 changelog 提到「聚合排序（含跨源 ID 碰撞修复）」：
 * 聚合多源结果时若歌的 id 不带 source 前缀，wy/tx/kw/kg/mg/bili/soda/kglite
 * 里恰好同 songmid 的两首歌会撞 id，前端去重 / 反查会串到错误源。
 *
 * 我们的不变式（由 src/server/utils/aggregateId.ts 的 makeAggregateSongId 保证，
 * subsonic.ts 的 fetchOnlineSearchSongs 调用它生成每首歌的 id）：
 *   1. id 必须带 source 前缀 → 跨源永不匹配；
 *   2. 单源内同 songmid 幂等 → 配单源 existingIds 去重不会丢歌；
 *   3. 空 songmid 不崩、跨源仍不撞。
 *
 * 另用既有严格匹配判据（src/utils/songMatch.ts 的 getSongMatchScore，即
 * 时长闸门 + 归一化歌名/歌手）做「换源回归对照」：聚合靠 id 前缀区分源，
 * 换源时仍要靠元数据严格匹配到正确版本，二者互补。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeAggregateSongId } from '../src/server/utils/aggregateId'
import {
    getSongMatchScore,
    normalizeSongMatchText,
    isSingerMatch,
} from '../src/utils/songMatch'

// ---------- 不变式 1：跨源命名空间隔离（防碰撞核心） ----------

test('跨源同 songmid → id 不碰撞（wy 与 tx 各一首 songmid=123 是不同歌）', () => {
    const wy = makeAggregateSongId('wy', '123')
    const tx = makeAggregateSongId('tx', '123')
    assert.notEqual(wy, tx, '跨源必须不同 id，否则前端按 id 去重会把两源串在一起')
    assert.equal(wy, 'wy_123')
    assert.equal(tx, 'tx_123')
})

test('八源里任意两源的同 songmid 都不碰撞', () => {
    const sources = ['wy', 'tx', 'kw', 'kg', 'mg', 'bili', 'soda', 'kglite']
    const ids = sources.map(s => makeAggregateSongId(s, 'same-mid-xyz'))
    const uniq = new Set(ids)
    assert.equal(uniq.size, sources.length, `应有 ${sources.length} 个不同 id，实际 ${uniq.size}`)
})

// ---------- 不变式 2：单源内幂等（配合 existingIds 去重） ----------

test('单源同 songmid → 幂等同 id（单源内去重依赖此性质）', () => {
    const a = makeAggregateSongId('wy', '1955')
    const b = makeAggregateSongId('wy', '1955')
    assert.equal(a, b)
})

// ---------- 不变式 3：空 songmid 兜底 ----------

test('空 songmid 不崩、跨源仍不撞', () => {
    const wy = makeAggregateSongId('wy', '')
    const tx = makeAggregateSongId('tx', '')
    assert.equal(wy, 'wy_')
    assert.equal(tx, 'tx_')
    assert.notEqual(wy, tx, '空 songmid 也必须有 source 前缀区分，否则两源空 id 会撞')
})

// ---------- 换源回归对照：严格匹配判据（时长/归一化歌名/歌手） ----------

const TARGET = { name: '晴天', singer: '周杰伦', interval: '04:29' }

test('严格匹配对照：同曲跨源（tx 版 vs wy 版元数据相同）→ 判为匹配', () => {
    // 聚合把两源的同名歌各生成独立 id 后，换源用元数据严格匹配仍应认出是同一首
    const txVer = { name: '晴天', singer: '周杰伦', interval: '04:29' }
    const score = getSongMatchScore(txVer, TARGET)
    assert.ok(score > 0, `同曲跨源应判匹配，score=${score}`)
})

test('严格匹配对照：异曲（不同歌名）跨源 → 不判匹配', () => {
    const other = { name: '稻香', singer: '周杰伦', interval: '03:43' }
    const score = getSongMatchScore(other, TARGET)
    assert.equal(score, -1, '不同歌名必须 -1，换源绝不能把《稻香》当《晴天》的源')
})

test('严格匹配对照：同名不同歌手 → 不判匹配（宁可不换也别播错歌）', () => {
    const diffSinger = { name: '晴天', singer: '某翻唱组合', interval: '04:29' }
    const score = getSongMatchScore(diffSinger, TARGET)
    assert.equal(score, -1)
})

test('严格匹配对照：时长差过大（>8s）→ 不判匹配', () => {
    const diffDur = { name: '晴天', singer: '周杰伦', interval: '05:10' }
    const score = getSongMatchScore(diffDur, TARGET)
    assert.equal(score, -1)
})

test('对照工具：normalizeSongMatchText 剥括号 / isSingerMatch 多歌手互含', () => {
    assert.equal(normalizeSongMatchText('晴天（Live版）'), '晴天')
    assert.equal(isSingerMatch('周杰伦、杨瑞代', '周杰伦'), true)
    assert.equal(isSingerMatch('林俊杰', '周杰伦'), false)
})
