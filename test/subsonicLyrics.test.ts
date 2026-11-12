/**
 * Subsonic 歌词覆盖不全回归（14:00 报告第 9 节，⑤ 项）。
 *
 * 8 首 id 全部取自 17950 `lxserver-verify` 的 access.log
 * （客户端 Amcfy Music，2026-11-12 10:44~10:58 +0800）：
 * 5 首 soda_、2 首 bili_、1 首 wy_109545。修复前 7 首后 3 源 id 一律
 * 落到 `error 70 Song or source not supported`，只有 wy_ 那首出词。
 *
 * 这里只锁**纯适配层**（零运行时依赖、不联网）：id 能被拆成可兜底的
 * LyricTarget、歌名/歌手不丢、元数据优先级正确。真正的取词效果在 17953
 * 实机打补丁验证（阶段 1 验证方案第 2 项）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  splitSubsonicLyricId,
  buildSubsonicLyricTarget,
} from '../src/server/utils/subsonicLyricTarget'

const REAL_IDS = [
  'soda_6986933802921560065',
  'soda_6733425931592943618',
  'soda_6733495678481205249',
  'soda_7158655475783829506',
  'soda_7170027026647091212',
  'bili_2804067',
  'bili_BV1XAnJzyEWQ',
  'wy_109545',
]

test('8 首真实 id 都能拆出 source / songmid', () => {
  const sources = REAL_IDS.map(id => splitSubsonicLyricId(id).source)
  assert.equal(sources.filter(s => s === 'soda').length, 5)
  assert.equal(sources.filter(s => s === 'bili').length, 2)
  assert.equal(sources.filter(s => s === 'wy').length, 1)
  for (const id of REAL_IDS) {
    const { source, songmid } = splitSubsonicLyricId(id)
    assert.ok(source, `${id} 应有 source`)
    assert.ok(songmid, `${id} 应有 songmid`)
  }
})

test('后 3 源不在 musicSdk 也能构造出带 name/singer 的兜底目标', () => {
  for (const id of REAL_IDS.filter(x => !x.startsWith('wy_'))) {
    const t = buildSubsonicLyricTarget(id, '王菲', '执迷不悔（国语）', null)
    assert.equal(t.source, id.split('_')[0])
    // getFallbackLyric 对 name 为空直接返回 null，歌名必须保住
    assert.equal(t.name, '执迷不悔（国语）', `${id} 兜底目标必须有歌名`)
    assert.equal(t.singer, '王菲')
  }
  // 之前 error 70 的两个现场 id 尤其要能过
  for (const id of ['soda_6986933802921560065', 'bili_BV1XAnJzyEWQ']) {
    assert.ok(buildSubsonicLyricTarget(id, 'a', 'b', null).name)
  }
})

test('findMusicById 补到的真实元数据优先于请求 title/artist', () => {
  const t = buildSubsonicLyricTarget('soda_6986933802921560065', '错误歌手', '错误歌名', {
    name: '执迷不悔（国语）',
    singer: '王菲',
    interval: '265',
    hash: 'ABC',
    meta: { albumId: 'ALB1', copyrightId: 'CP1' },
  })
  assert.equal(t.name, '执迷不悔（国语）')
  assert.equal(t.singer, '王菲')
  assert.equal(t.interval, '265')
  assert.equal(t.hash, 'ABC')
  assert.equal(t.albumId, 'ALB1')
  assert.equal(t.copyrightId, 'CP1')
})

test('无 id / local / 无下划线：source 为空但不伪造平台，title 仍可用于跨源', () => {
  assert.deepEqual(splitSubsonicLyricId('local_abc'), { source: 'local', songmid: 'abc' })
  assert.deepEqual(splitSubsonicLyricId('abc'), { source: '', songmid: 'abc' })
  assert.deepEqual(splitSubsonicLyricId(''), { source: '', songmid: '' })
  const t = buildSubsonicLyricTarget('', '周华健', '有没有一首歌会让你想起我', null)
  assert.equal(t.source, '')
  assert.equal(t.name, '有没有一首歌会让你想起我')
  assert.equal(t.singer, '周华健')
})

test('无歌名时目标 name 为空：getFallbackLyric 会直接返回 null（不会误搜）', () => {
  const t = buildSubsonicLyricTarget('soda_123', '', '', null)
  assert.equal(t.name, '')
  assert.equal(t.singer, '')
})
