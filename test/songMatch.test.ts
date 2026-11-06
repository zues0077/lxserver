/**
 * 歌曲匹配打分（换源候选）单测 —— 含 2026-11-06 新增的「救援模式」。
 *
 * 数据全部来自 2026-11-06 20:09 实机复现（红昭愿 (DJ版) kw 坏条目，元数据 00:28）：
 * 旧打分把坏元数据当正常基准，导致所有完整版都进不了换源候选，最终只能投 29s + 提示。
 * 每个用例标注当时的实际得分/死因，改判据导致行为变化时这里会红。
 */
import test from 'node:test'
import assert from 'node:assert'
import {
    getSongMatchScore,
    normalizeSongMatchText,
    normalizeSongNameText,
    isSingerMatch,
    getSongDurationSeconds,
} from '../src/utils/songMatch'

// ---------- 救援模式：target 元数据 <30s（坏元数据） ----------

const BAD_TARGET = { name: '红昭愿 (DJ版)', singer: '音阙诗听', interval: '00:28' }

test('救援模式：剥括号后同名同歌手的完整版必须进候选（现场死因：名字互不含）', () => {
    // 「红昭愿（氛围DJ版）153s」旧打分 -1（normalizeSongNameText 不剥括号）
    const a = getSongMatchScore(
        { name: '红昭愿（氛围DJ版）', singer: '音阙诗听', interval: '02:33' }, BAD_TARGET)
    assert.equal(a, 20, `氛围DJ版应得剥括号满分 20，实际 ${a}`)

    // 「红昭愿 (DJ阿lo版|高音质版) 96s」同样死在名字互不含
    const b = getSongMatchScore(
        { name: '红昭愿 (DJ阿lo版|高音质版)', singer: '音阙诗听、王梓钰', interval: '01:36' }, BAD_TARGET)
    assert.equal(b, 20, `DJ阿lo版应得 20，实际 ${b}`)
})

test('救援模式：时长差闸门跳过（坏元数据不配当基准；现场死因：227s > 8s）', () => {
    // 完整版 255s vs 坏元数据 28s：旧打分 -1
    const s = getSongMatchScore(
        { name: '红昭愿 (DJ版)', singer: '音阙诗听', interval: '04:15' }, BAD_TARGET)
    assert.equal(s, 20, `完整版应得 20，实际 ${s}`)
})

test('救援模式：歌手闸门仍然生效（不同歌手的版本不该自动换）', () => {
    const s = getSongMatchScore(
        { name: '红昭愿 (DJ版)', singer: 'DJ半夏', interval: '03:23' }, BAD_TARGET)
    assert.equal(s, -1, 'DJ半夏版是另一首作品，歌手闸门不能松')
})

test('救援模式：无关歌名仍然 -1', () => {
    const s = getSongMatchScore(
        { name: '晴天', singer: '音阙诗听', interval: '04:29' }, BAD_TARGET)
    assert.equal(s, -1)
})

// ---------- 正常路径：target 元数据 ≥30s，行为逐字节不变 ----------

const GOOD_TARGET = { name: '红昭愿 (DJ版)', singer: '音阙诗听', interval: '03:23' }

test('正常路径：remix 后缀名字互不含仍 -1（宁可不换也别放错）', () => {
    const s = getSongMatchScore(
        { name: '红昭愿（氛围DJ版）', singer: '音阙诗听', interval: '02:33' }, GOOD_TARGET)
    assert.equal(s, -1, '正常路径不启用剥括号匹配，与旧行为一致')
})

test('正常路径：时长差 >8s 仍 -1', () => {
    const s = getSongMatchScore(
        { name: '红昭愿 (DJ版)', singer: '音阙诗听', interval: '04:15' }, GOOD_TARGET)
    assert.equal(s, -1, '227s→52s 都不行，时长闸门照旧')
})

test('正常路径：同名差 3 秒 → 20+5=25', () => {
    const s = getSongMatchScore(
        { name: '红昭愿 (DJ版)', singer: '音阙诗听', interval: '03:26' }, GOOD_TARGET)
    assert.equal(s, 25)
})

test('正常路径：时长未知候选 → 名分 20、时长分 0', () => {
    const s = getSongMatchScore(
        { name: '红昭愿 (DJ版)', singer: '音阙诗听', interval: '' }, GOOD_TARGET)
    assert.equal(s, 20)
})

// ---------- 基础纯函数回归 ----------

test('normalizeSongMatchText 剥括号 / normalizeSongNameText 不剥', () => {
    assert.equal(normalizeSongMatchText('红昭愿（氛围DJ版）'), '红昭愿')
    assert.equal(normalizeSongNameText('红昭愿（氛围DJ版）'), '红昭愿氛围dj版')
})

test('isSingerMatch：多歌手拆分互含', () => {
    assert.equal(isSingerMatch('音阙诗听、王梓钰', '音阙诗听'), true)
    assert.equal(isSingerMatch('DJ半夏', '音阙诗听'), false)
})

test('getSongDurationSeconds：mm:ss / 秒数 / 毫秒数', () => {
    assert.equal(getSongDurationSeconds('03:23'), 203)
    assert.equal(getSongDurationSeconds('203'), 203)
    assert.equal(getSongDurationSeconds(203000), 203)
    assert.equal(getSongDurationSeconds(''), 0)
})
