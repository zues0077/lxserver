import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

// 背景（2026-11-01 r16 压测发现）：
// Subsonic 取链的 in-flight 去重用了 `promise.finally(cleanup)`。
// finally() 返回的**派生 Promise 会继承拒绝状态**，而返回值被丢弃，
// 于是调用方虽然 catch 了原 Promise 并正确返回 502，派生 Promise 仍然无人处理，
// 每次取链失败都会多抛一条「[异步警告] 未捕获异常: Could not resolve music URL」。
// 这组用例守住「不产生游离拒绝」的两处写法。

const repoRoot = path.resolve(import.meta.dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8')

test('subsonic 取链去重：清理必须用 then(成功,失败) 双分支，不能用 promise.finally', () => {
  const src = read('src/server/subsonic.ts')
  assert.match(src, /promise\.then\(cleanupInflight,\s*cleanupInflight\)/, '去重清理应使用 then 双分支')
  // 只扫代码行，注释里提到这个写法是允许的
  const codeLines = src
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  const offenders = codeLines.filter(line => /\bpromise\.finally\(/.test(line))
  assert.deepStrictEqual(
    offenders,
    [],
    'promise.finally() 的派生 Promise 被丢弃会在取链失败时抛未捕获异常',
  )
})

test('同步下载任务：void 出去的 Promise 链必须带 catch，finally 前不能裸奔', () => {
  const src = read('src/server/task/syncDownloadTask.ts')
  const idx = src.indexOf('void syncUserPlaylists(')
  assert.ok(idx > 0, '应能找到 startSync 里的异步调度点')
  const seg = src.slice(idx, idx + 600)
  assert.match(seg, /\.catch\(/, 'void 出去的链必须有 catch，否则拒绝变成全局未捕获异常')
  // catch 必须出现在 finally 之前，否则 finally 派生 Promise 仍可能拒绝
  const catchPos = seg.indexOf('.catch(')
  const finallyPos = seg.indexOf('.finally(')
  if (finallyPos >= 0) assert.ok(catchPos < finallyPos, 'catch 需排在 finally 之前')
})

test('机制验证：finally 的派生 Promise 继承拒绝，then 双分支恒为 resolve', async () => {
  // 不去监听 unhandledRejection（test runner 会拦截事件），
  // 直接断言「派生 Promise 最终是否拒绝」这一根因本身。
  const oldOriginal = Promise.reject(new Error('old-style'))
  const oldDerived = oldOriginal.finally(() => { /* cleanup */ })
  await oldOriginal.catch(() => { /* 调用方处理原 Promise */ })
  let oldDerivedRejected = false
  await oldDerived.catch(() => { oldDerivedRejected = true })
  assert.strictEqual(oldDerivedRejected, true, 'finally 派生 Promise 会继承拒绝（这正是游离拒绝的来源）')

  const newOriginal = Promise.reject(new Error('new-style'))
  const cleanup = () => { /* cleanup */ }
  const newDerived = newOriginal.then(cleanup, cleanup)
  await newOriginal.catch(() => { /* 调用方处理原 Promise */ })
  let newDerivedRejected = false
  await newDerived.catch(() => { newDerivedRejected = true })
  assert.strictEqual(newDerivedRejected, false, 'then 双分支派生 Promise 必须恒为 resolve')
})

test('机制验证：去重表在 Promise 拒绝后仍被正确清理', async () => {
  const inflight = new Map<string, Promise<unknown>>()
  const key = 'wy_abc_0_user'

  const run = (shouldFail: boolean) => {
    if (inflight.has(key)) return inflight.get(key)!
    const p = shouldFail ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
    inflight.set(key, p)
    const cleanup = () => { inflight.delete(key) }
    p.then(cleanup, cleanup)
    return p
  }

  await assert.rejects(() => run(true))
  await new Promise(r => setTimeout(r, 10))
  assert.strictEqual(inflight.has(key), false, '失败后应清掉去重表，否则后续同曲永远复用失败的 Promise')

  await assert.doesNotReject(() => run(false))
  await new Promise(r => setTimeout(r, 10))
  assert.strictEqual(inflight.has(key), false, '成功后也应清理')
})
