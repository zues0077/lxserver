import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * 聚合搜索的 60 秒结果缓存是纯逻辑（public/music/app.js 里没有构建步骤），
 * 按现有做法「切片 + vm」拉出来跑，Date 换成可控时钟来验证过期与淘汰。
 */
const root = path.resolve(import.meta.dirname, '..')
const src = fs.readFileSync(path.join(root, 'public/music/app.js'), 'utf8')

const start = src.indexOf('const SEARCH_CACHE_TTL_MS')
const end = src.indexOf('/** 找到元素真正在滚动的祖先容器', start)
assert.ok(start >= 0 && end > start, '搜索缓存切片没找到')

const clock = { now: 1_700_000_000_000 }
const sandbox: any = {
  console,
  Map,
  Set,
  String,
  Number,
  Array,
  Object,
  Math,
  // 缓存只用 Date.now()
  Date: { now: () => clock.now },
  JSON,
}
vm.createContext(sandbox)
vm.runInContext(src.slice(start, end), sandbox)

const { searchCacheKey, readSearchCache, writeSearchCache } = sandbox

const songs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `歌${i}`, source: 'wy' }))

test('key：大小写与首尾空格归一，同一次搜索只占一份缓存', () => {
  assert.equal(searchCacheKey('song', 'all', '  晴天 '), searchCacheKey('song', 'all', '晴天'))
  assert.equal(searchCacheKey('song', 'all', 'ABC'), searchCacheKey('song', 'all', 'abc'))
})

test('key：类型 / 源不同不能混用（歌名相同但搜的是专辑就是另一份结果）', () => {
  assert.notEqual(searchCacheKey('song', 'all', '晴天'), searchCacheKey('album', 'all', '晴天'))
  assert.notEqual(searchCacheKey('song', 'all', '晴天'), searchCacheKey('song', 'wy', '晴天'))
})

test('写入后 60 秒内可命中，且拿到的是同一份列表', () => {
  const key = searchCacheKey('song', 'all', '缓存命中测试')
  writeSearchCache(key, songs(3))
  const hit = readSearchCache(key)
  assert.ok(hit, '刚写进去必须能读到')
  assert.equal(hit.list.length, 3)
  assert.equal(hit.at, clock.now)
})

test('超过 60 秒即失效，并顺手把这条删掉（别让过期项一直占着容量）', () => {
  const key = searchCacheKey('song', 'all', '过期测试')
  writeSearchCache(key, songs(2))
  clock.now += 59_000
  assert.ok(readSearchCache(key), '59 秒还算新鲜')
  clock.now += 1_500
  assert.equal(readSearchCache(key), null, '61.5 秒必须失效')
  assert.equal(readSearchCache(key), null)
})

test('空结果不写缓存（搜不到就老老实实再搜一次，别把「没有结果」钉 60 秒）', () => {
  const key = searchCacheKey('song', 'all', '空结果测试')
  writeSearchCache(key, [])
  assert.equal(readSearchCache(key), null)
})

test('容量上限 8：写第 9 个词时淘汰最旧的（Map 插入序即 LRU 序）', () => {
  const keys = []
  for (let i = 0; i < 9; i++) {
    const k = searchCacheKey('song', 'all', `容量测试${i}`)
    keys.push(k)
    writeSearchCache(k, songs(1))
    clock.now += 10
  }
  assert.equal(readSearchCache(keys[0]), null, '最早写入的应被淘汰')
  for (let i = 1; i < 9; i++) {
    assert.ok(readSearchCache(keys[i]), `第 ${i + 1} 个词应该在缓存里`)
  }
})

test('重复写同一个词只占一个位置，并把它的新旧程度顶到最新', () => {
  const keeper = searchCacheKey('song', 'all', '重复写测试')
  writeSearchCache(keeper, songs(1))
  clock.now += 10
  writeSearchCache(keeper, songs(4))
  assert.equal(readSearchCache(keeper).list.length, 4, '后者覆盖前者')
})
