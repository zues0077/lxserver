/**
 * P2-4（上游「Subsonic 评分歌单 / 1–5 星虚拟评分歌单」）单测。
 *
 * 锁住的不变式：
 *   1. rating_1~5 才是合法虚拟歌单 id，rating_0/6/rating_lb_ 不认；
 *   2. 评分 key 就是歌曲 id（本地 subsonic-meta.json 事实），无需拼 source_songmid；
 *   3. 同一首歌只进一次、未评分/0/越界评分不进任何桶；
 *   4. 五个桶恒存在（空歌单也要能在 getPlaylists 里稳定列出）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RATING_PLAYLIST_PREFIX,
  parseRatingPlaylistId,
  isRatingPlaylistId,
  ratingPlaylistName,
  groupSongsByRating,
} from '../src/server/utils/ratingPlaylist'

test('parseRatingPlaylistId: 只认 rating_1 ~ rating_5', () => {
  for (let star = 1; star <= 5; star++) {
    assert.equal(parseRatingPlaylistId(`${RATING_PLAYLIST_PREFIX}${star}`), star)
  }
  assert.equal(parseRatingPlaylistId('rating_0'), null)
  assert.equal(parseRatingPlaylistId('rating_6'), null)
  assert.equal(parseRatingPlaylistId('lb_tx_1'), null)
  assert.equal(parseRatingPlaylistId('pl_wy_2'), null)
  assert.equal(parseRatingPlaylistId(''), null)
  assert.equal(isRatingPlaylistId('rating_3'), true)
  assert.equal(isRatingPlaylistId('default'), false)
})

test('ratingPlaylistName: 中文歌单名', () => {
  assert.equal(ratingPlaylistName(1), '评分 1 星')
  assert.equal(ratingPlaylistName(5), '评分 5 星')
})

test('groupSongsByRating: 用歌曲 id 直接反查评分', () => {
  const songs = [
    { id: 'kw_aaa' },
    { id: 'tx_bbb' },
    { id: 'mg_ccc' },
    { id: 'wy_ddd' },
    { id: 'kg_eee' },
  ]
  const ratings: Record<string, number> = {
    kw_aaa: 1, tx_bbb: 2, mg_ccc: 3, wy_ddd: 4, kg_eee: 5,
  }
  const groups = groupSongsByRating(songs, ratings)
  for (let star = 1; star <= 5; star++) {
    assert.equal(groups.get(star)!.length, 1, `${star} 星应恰好 1 首`)
  }
  assert.equal(groups.get(1)![0].id, 'kw_aaa')
  assert.equal(groups.get(5)![0].id, 'kg_eee')
})

test('groupSongsByRating: 去重 / 未评分 / 0 / 越界评分不进桶', () => {
  const songs = [
    { id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' },
  ]
  const ratings: Record<string, number> = { a: 3, b: 0, c: 6, d: -1, e: 2.5 }
  const groups = groupSongsByRating(songs, ratings)
  assert.equal(groups.get(3)!.length, 1, '重复 id 只保留一次')
  for (const star of [1, 2, 4, 5]) assert.equal(groups.get(star)!.length, 0)
  assert.equal([...groups.values()].reduce((s, arr) => s + arr.length, 0), 1)
})

test('groupSongsByRating: 空输入仍有 5 个桶', () => {
  const groups = groupSongsByRating([], {})
  assert.equal(groups.size, 5)
  for (let star = 1; star <= 5; star++) assert.deepEqual(groups.get(star), [])
})
