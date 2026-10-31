import test from 'node:test'
import assert from 'node:assert'
import { parseBiliVideoId, decodeKeywordId } from '../src/server/extraSources/bilibili'

test('B站合集 id：bili-season|<mid>|<season_id> 能解析出 mid 与合集 id', () => {
  assert.deepEqual(parseBiliVideoId('bili-season|1745584728|7702729'), {
    kind: 'season', mid: '1745584728', cid: '7702729',
  })
})

test('B站系列 id：bili-series|<mid>|<series_id> 走系列接口', () => {
  assert.deepEqual(parseBiliVideoId('bili-series|1745584728|3874211'), {
    kind: 'series', mid: '1745584728', cid: '3874211',
  })
})

test('B站合集 id：字段缺失/非数字一律返回 null（不往下游发坏请求）', () => {
  assert.equal(parseBiliVideoId('bili-season|1745584728'), null)
  assert.equal(parseBiliVideoId('bili-season|abc|7702729'), null)
  assert.equal(parseBiliVideoId('bili-season|1745584728|'), null)
  assert.equal(parseBiliVideoId('bili-series||1'), null)
})

test('B站合集 id：bvid / 关键词专辑不会被误判成合集', () => {
  assert.equal(parseBiliVideoId('BV1xx411c7mD'), null)
  assert.equal(parseBiliVideoId('bili-kw|5pm05aSp'), null)
  assert.equal(decodeKeywordId('bili-kw|5pm05aSp'), '晴天')
})
