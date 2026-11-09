/**
 * 八源聚合（T9）回归：验证 aggregateSearch 的源路由与结果归一化。
 * 纯函数测试，不触发任何网络请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_AGGREGATE_SOURCES,
  MUSIC_SDK_SOURCES,
  EXTRA_SEARCH_SOURCES,
  isExtraSearchSource,
  searchExtraSource,
  adaptExtraSearchItem,
  secToInterval,
} from '../src/server/utils/aggregateSearch'
import { makeAggregateSongId } from '../src/server/utils/aggregateId'

// 代表三家 searchSongs 真实返回结构的样例项
const kgliteRaw = {
  id: 'kglite_abc123',
  source: 'kglite',
  name: '概念版歌',
  singer: '歌手A',
  album: '概念版专辑',
  albumId: 12345,
  hash: 'abc123',
  songmid: 'abc123',
  interval: 215, // 秒（数字）
  img: 'http://x/cover.jpg',
  quality: '128k',
}
const biliRaw = {
  source: 'bili',
  id: 'BV1xx',
  songmid: 'BV1xx',
  name: 'bili歌',
  singer: 'up主',
  albumName: '',
  albumId: '',
  interval: '04:20',
  img: 'http://x/b.jpg',
  types: [{ type: '128k' }, { type: '320k' }],
  _types: {},
  meta: { bvid: 'BV1xx', mid: '123' },
}
const sodaRaw = {
  source: 'soda',
  id: '1234567890',
  songmid: '1234567890',
  name: 'soda歌',
  singer: '歌手B',
  albumName: 's专辑',
  albumId: '999',
  interval: '03:00',
  img: 'http://x/s.jpg',
  types: [{ type: '128k' }, { type: '320k' }, { type: 'flac' }],
  _types: {},
  meta: { trackId: '1234567890' },
}

test('八源清单 = 五行 SDK 源 + 三家服务端源，共 8 个', () => {
  assert.equal(ALL_AGGREGATE_SOURCES.length, 8)
  assert.deepEqual(
    [...ALL_AGGREGATE_SOURCES].sort(),
    [...MUSIC_SDK_SOURCES, ...EXTRA_SEARCH_SOURCES].sort(),
  )
  for (const s of ['wy', 'tx', 'kw', 'kg', 'mg', 'bili', 'soda', 'kglite']) {
    assert.ok(ALL_AGGREGATE_SOURCES.includes(s as any), `应包含 ${s}`)
  }
})

test('isExtraSearchSource 只对 bili/soda/kglite 为真', () => {
  for (const s of EXTRA_SEARCH_SOURCES) assert.ok(isExtraSearchSource(s))
  for (const s of MUSIC_SDK_SOURCES) assert.ok(!isExtraSearchSource(s))
})

test('secToInterval 把秒数转成 mm:ss', () => {
  assert.equal(secToInterval(0), '00:00')
  assert.equal(secToInterval(215), '03:35')
  assert.equal(secToInterval(5), '00:05')
})

test('kglite 归一化：补 types / 专辑改名 / 秒数转 mm:ss / 保留 hash', () => {
  const item = adaptExtraSearchItem(kgliteRaw, 'kglite')
  assert.equal(item.interval, '03:35', '数字秒被标准化为 mm:ss')
  assert.equal(item.albumName, '概念版专辑', 'album -> albumName')
  assert.equal(item.albumId, 12345)
  assert.equal(item.types.length, 4, 'kglite 缺 types，应补 4 个占位音质')
  assert.equal(item.types[0].type, '128k')
  assert.equal(item.hash, 'abc123', 'hash 必须保留（取链依赖）')
  assert.equal(item.meta.hash, 'abc123')
  assert.equal(item.meta.albumName, '概念版专辑')
  assert.equal(item.meta.picUrl, 'http://x/cover.jpg')
})

test('bili 归一化：保留 types 数组 / 字符串 interval / meta.bvid', () => {
  const item = adaptExtraSearchItem(biliRaw, 'bili')
  assert.equal(item.interval, '04:20', '字符串 interval 原样保留')
  assert.equal(item.albumName, '', 'bili 无专辑，albumName 为空字符串')
  assert.deepEqual(item.types, [{ type: '128k' }, { type: '320k' }], 'types 数组原样保留')
  assert.equal(item.meta.bvid, 'BV1xx', 'meta.bvid 必须保留（播放解析依赖）')
  assert.equal(item.meta.mid, '123', 'meta.mid 必须保留')
  assert.equal(item.hash, '', 'bili 无 hash')
})

test('soda 归一化：保留 types / albumName / meta.trackId', () => {
  const item = adaptExtraSearchItem(sodaRaw, 'soda')
  assert.equal(item.albumName, 's专辑')
  assert.equal(item.albumId, '999')
  assert.deepEqual(item.types, [{ type: '128k' }, { type: '320k' }, { type: 'flac' }])
  assert.equal(item.meta.trackId, '1234567890', 'meta.trackId 必须保留')
})

test('musicSdk 五源不进 adapt（返回原对象，零变更）', () => {
  const wyRaw = {
    songmid: 'wymid',
    name: 'wy歌',
    singer: 's',
    img: '',
    interval: '03:00',
    types: [{ type: '128k' }],
    _types: {},
    meta: {},
  }
  const item = adaptExtraSearchItem(wyRaw, 'wy')
  assert.equal(item, wyRaw, '非 extra 源应原样返回同一引用')
})

test('makeAggregateSongId 对八源各生成稳定且唯一的聚合 id', () => {
  const songmid = 'sameMid'
  const ids = ALL_AGGREGATE_SOURCES.map((s) => makeAggregateSongId(s, songmid))
  // 唯一：八源同 songmid 不得撞 id
  assert.equal(new Set(ids).size, 8, '八源同 songmid 必须各不相同的 id')
  // kglite 的聚合 id 必须和搜索返回项自带的 id 形态一致
  assert.equal(makeAggregateSongId('kglite', 'abc123'), 'kglite_abc123')
  assert.equal(makeAggregateSongId('bili', 'BV1xx'), 'bili_BV1xx')
  assert.equal(makeAggregateSongId('soda', '1234567890'), 'soda_1234567890')
})

test('searchExtraSource 对未知源返回空 list 且不抛（不触发网络）', async () => {
  const res = await searchExtraSource('nope', 'q', 1, 20)
  assert.deepEqual(res, { list: [] })
})
