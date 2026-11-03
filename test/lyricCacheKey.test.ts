import { test } from 'node:test'
import assert from 'node:assert'
import { lyricCacheKey } from '../src/utils/lyricMatch'

const base = { source: 'bili', name: '夜曲', singer: '周杰伦', interval: '04:47' }

test('bili：同标题同歌手的两个视频必须分开缓存（BV 并进键）', () => {
  const a = lyricCacheKey({ ...base, songmid: 'BV1yr4c67Eef' })
  const b = lyricCacheKey({ ...base, songmid: 'BV1q4FTeBEMj' })
  assert.notStrictEqual(a, b, '不同 BV 不能共用同一条兜底缓存')
  assert.ok(a.includes('BV1yr4c67Eef'))
})

test('bili：同一个 BV 从不同入口进来要复用缓存', () => {
  const fromSearch = lyricCacheKey({ ...base, songmid: 'BV1yr4c67Eef' })
  const fromPlaylist = lyricCacheKey({ ...base, songmid: 'BV1yr4c67Eef', albumId: '123', copyrightId: 'x' })
  assert.strictEqual(fromSearch, fromPlaylist)
})

test('soda：曲目 id 不同的两首同名歌分开缓存', () => {
  const a = lyricCacheKey({ source: 'soda', name: '晴天', singer: '周杰伦', songmid: 'soda_001' })
  const b = lyricCacheKey({ source: 'soda', name: '晴天', singer: '周杰伦', songmid: 'soda_002' })
  assert.notStrictEqual(a, b)
})

test('kglite：优先用酷狗 hash，缺失时回落 songmid', () => {
  const byHash = lyricCacheKey({ source: 'kglite', name: '稻香', singer: '周杰伦', hash: 'HASHAAA' })
  const sameHash = lyricCacheKey({ source: 'kglite', name: '稻香', singer: '周杰伦', hash: 'HASHAAA', songmid: 'HASHAAA' })
  assert.strictEqual(byHash, sameHash)
  const another = lyricCacheKey({ source: 'kglite', name: '稻香', singer: '周杰伦', hash: 'HASHBBB' })
  assert.notStrictEqual(byHash, another)
  assert.ok(byHash.includes('HASHAAA'))
  const fallback = lyricCacheKey({ source: 'kglite', name: '稻香', singer: '周杰伦', songmid: 'HASHCCC' })
  assert.ok(fallback.includes('HASHCCC'))
})

test('普通源不加 id：不同 songmid 仍共用缓存（跨源搜索只认名字）', () => {
  const a = lyricCacheKey({ source: 'wy', name: '晴天', singer: '周杰伦', interval: '269', songmid: '111' })
  const b = lyricCacheKey({ source: 'wy', name: '晴天', singer: '周杰伦', interval: '269', songmid: '222' })
  assert.strictEqual(a, b)
})

test('id 缺失时退化为「源|歌名|歌手|时长」，不抛错', () => {
  const key = lyricCacheKey({ source: 'bili', name: '夜曲', singer: '周杰伦', interval: '04:47' })
  assert.strictEqual(key, 'bili|夜曲|周杰伦|287')
})

test('歌名归一与时长仍参与判断', () => {
  const plain = lyricCacheKey({ ...base, songmid: 'BV1yr4c67Eef' })
  const decorated = lyricCacheKey({ ...base, name: '【4K】夜曲 (Live)', songmid: 'BV1yr4c67Eef' })
  assert.strictEqual(plain, decorated, '版本/音质标注应被 cleanTitle 抹平')
  const longer = lyricCacheKey({ ...base, songmid: 'BV1yr4c67Eef', interval: '05:12' })
  assert.notStrictEqual(plain, longer, '时长不同是不同曲目')
})

test('source 大小写不敏感', () => {
  const lower = lyricCacheKey({ ...base, songmid: 'BV1yr4c67Eef' })
  const upper = lyricCacheKey({ ...base, source: 'BILI', songmid: 'BV1yr4c67Eef' })
  assert.strictEqual(lower, upper)
})
