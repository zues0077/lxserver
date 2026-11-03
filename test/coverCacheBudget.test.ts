import test from 'node:test'
import assert from 'node:assert'
import { coverCacheEvictCount } from '../src/server/coverProxy'

// 2026-11-03：封面内存缓存原来只按 3000 条限制。一条封面 3KB 到 600KB 不等，
// 3000 条最坏能占 1.5GB（小内存 NAS 直接 OOM）。改成同时按字节封顶 96MB。

test('封面缓存字节淘汰：未超上限不淘汰', () => {
  const sizes = [{ key: 'a', bytes: 10 }, { key: 'b', bytes: 20 }]
  assert.equal(coverCacheEvictCount(sizes, 30, 30), 0)
  assert.equal(coverCacheEvictCount(sizes, 10, 30), 0)
})

test('封面缓存字节淘汰：按插入顺序从最旧开始算个数', () => {
  const sizes = [{ key: 'a', bytes: 10 }, { key: 'b', bytes: 20 }, { key: 'c', bytes: 30 }]
  // 超 5 字节：删掉最旧的 a（10 字节）就够
  assert.equal(coverCacheEvictCount(sizes, 65, 60), 1)
  // 超 25 字节：a(10)+b(20) 才够
  assert.equal(coverCacheEvictCount(sizes, 85, 60), 2)
  // 超 40 字节：三个都不够，全删
  assert.equal(coverCacheEvictCount(sizes, 100, 60), 3)
})

test('封面缓存字节淘汰：单张巨大图也要能算出来', () => {
  const sizes = [{ key: 'big', bytes: 200 * 1024 * 1024 }, { key: 's', bytes: 100 }]
  assert.equal(coverCacheEvictCount(sizes, 200 * 1024 * 1024 + 100, 96 * 1024 * 1024), 1)
})
