import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWithConcurrency, sleep } from '@/server/utils/concurrency'

test('runWithConcurrency 每个 item 都恰好处理一次', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8]
  const seen = new Set<number>()
  await runWithConcurrency(items, 3, async (n) => {
    seen.add(n)
    await sleep(5)
  })
  assert.equal(seen.size, 8)
  for (const n of items) assert.ok(seen.has(n), `missing ${n}`)
})

test('runWithConcurrency 并发数不超过 limit', async () => {
  const limit = 2
  let active = 0
  let maxActive = 0
  await runWithConcurrency([1, 2, 3, 4, 5], limit, async () => {
    active++
    maxActive = Math.max(maxActive, active)
    await sleep(10)
    active--
  })
  assert.ok(maxActive <= limit, `maxActive ${maxActive} 超过 limit ${limit}`)
})

test('runWithConcurrency 空输入不抛错', async () => {
  await runWithConcurrency([], 3, async () => {
    throw new Error('不应执行')
  })
  assert.ok(true)
})

test('runWithConcurrency worker 内 try/catch 可隔离错误（贴近 subsonic 用法）', async () => {
  const ok: number[] = []
  const failed: number[] = []
  // subsonic 的 worker 自带 try/catch，错误不会逃出；这里模拟同样形态
  await runWithConcurrency([1, 2, 3], 2, async (n) => {
    try {
      if (n === 2) throw new Error('boom')
      ok.push(n)
    } catch {
      failed.push(n)
    }
  })
  assert.deepEqual(ok.sort(), [1, 3])
  assert.deepEqual(failed, [2])
})

test('runWithConcurrency 单 item 也能跑', async () => {
  let ran = 0
  await runWithConcurrency([42], 3, async (n) => {
    ran = n
  })
  assert.equal(ran, 42)
})
