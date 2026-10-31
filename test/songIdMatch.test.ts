import test from 'node:test'
import assert from 'node:assert'
import { hasPlatformSongId, collectSongIdCandidates } from '../src/server/songIdMatch'

test('网易/酷我/咪咕：纯数字 ID 才算有 ID', () => {
  assert.equal(hasPlatformSongId({ source: 'wy', songmid: 186016 }), true)
  assert.equal(hasPlatformSongId({ source: 'wy', songmid: '186016' }), true)
  assert.equal(hasPlatformSongId({ source: 'kw', id: 'MUSIC_123' }), false)
  assert.equal(hasPlatformSongId({ source: 'mg', copyrightId: '60090508157' }), true)
})

test('只有歌名和歌手（歌单导入 / 本地文件那种）算没有 ID', () => {
  assert.equal(hasPlatformSongId({ source: 'wy', name: '晴天', singer: '周杰伦' }), false)
  assert.equal(hasPlatformSongId({ source: 'tx', name: '孤勇者', singer: '陈奕迅' }), false)
  assert.equal(hasPlatformSongId({ source: 'kg', name: '画', singer: '邓紫棋' }), false)
})

test('宿主拼的占位 ID（sl_/lb_）一律按没有 ID 处理', () => {
  assert.equal(hasPlatformSongId({ source: 'wy', id: 'sl_3778678_12', songmid: 'sl_3778678_12' }), false)
  assert.equal(hasPlatformSongId({ source: 'tx', id: 'lb_151_3' }), false)
  assert.equal(hasPlatformSongId({ source: 'mg', id: 'lb_151_3', copyrightId: 'lb_151_3' }), false)
})

test('带平台前缀的真 ID 去前缀后仍算有效', () => {
  assert.equal(hasPlatformSongId({ source: 'wy', id: 'wy_186016' }), true)
  assert.equal(hasPlatformSongId({ source: 'kg', id: 'kg_64b39a6828913e58e1ed1f7f6061a380' }), true)
})

test('酷狗/概念版要 hash 形态（32 位左右），QQ 要 6 位以上的字母数字', () => {
  assert.equal(hasPlatformSongId({ source: 'kg', hash: '64b39a6828913e58e1ed1f7f6061a380' }), true)
  assert.equal(hasPlatformSongId({ source: 'kg', hash: 'abc' }), false)
  assert.equal(hasPlatformSongId({ source: 'kglite', hash: '7d56b4481524e34de0841779bbaa0d33' }), true)
  assert.equal(hasPlatformSongId({ source: 'tx', songmid: '0039MnYb0qxYhV' }), true)
  assert.equal(hasPlatformSongId({ source: 'tx', songmid: 'sl_1_2' }), false)
})

test('extraSources（B站/汽水）与未知平台不参与判定，直接放行', () => {
  assert.equal(hasPlatformSongId({ source: 'bili', name: '孤勇者' }), true)
  assert.equal(hasPlatformSongId({ source: 'soda', name: '孤勇者' }), true)
  assert.equal(hasPlatformSongId({ source: 'my-custom-source', name: '孤勇者' }), true)
})

test('候选 ID 会从 meta 里捞，并按平台前缀去重前缀', () => {
  assert.deepEqual(
    collectSongIdCandidates({ source: 'wy', meta: { songId: 12345 } }),
    ['12345'],
  )
  assert.ok(collectSongIdCandidates({ source: 'kg', meta: { hash: 'deadbeefdeadbeef' } }).includes('deadbeefdeadbeef'))
})
