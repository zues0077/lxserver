import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTranscodePartPath } from '../src/server/xiaoai/transcode'
import { inflightCount, runSingleFlight } from '../src/server/xiaoai/singleFlight'
import {
  buildTrackKey,
  deleteCachedTrackBySong,
  getCachedTrack,
  setCachedTrackUrl,
} from '../src/server/xiaoai/playCache'

// ---- 转码单飞与临时文件唯一性（P-1140）----
// 2026-11-06 复现：两个并发 transcodeFileToMp3 抢同一个 `.part`，
// 第二个报 ENOENT 后触发整首重转，把已经投送给设备的文件覆盖掉。

test('同 key 并发只真正执行一次（其余复用同一结果）', async () => {
  let calls = 0
  const task = async () => {
    calls += 1
    await new Promise(r => setTimeout(r, 30))
    return 'done'
  }
  const results = await Promise.all([
    runSingleFlight('k1', task),
    runSingleFlight('k1', task),
    runSingleFlight('k1', task),
  ])
  assert.equal(calls, 1, '三个并发调用只应起一个任务')
  assert.deepEqual(results, ['done', 'done', 'done'])
  assert.equal(inflightCount(), 0, '任务结束后必须从在飞表里移除')
})

test('不同 key 各自执行，不互相影响', async () => {
  let calls = 0
  const task = async () => {
    calls += 1
    await new Promise(r => setTimeout(r, 10))
    return calls
  }
  await Promise.all([runSingleFlight('a', task), runSingleFlight('b', task)])
  assert.equal(calls, 2)
})

test('任务失败会释放 key，下一次可以重试', async () => {
  await assert.rejects(
    runSingleFlight('k2', async () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(inflightCount(), 0, '失败也必须清掉在飞记录，否则这首歌永远转不出来')
  const value = await runSingleFlight('k2', async () => 'ok')
  assert.equal(value, 'ok')
})

test('转码临时文件路径每次唯一，且落在目标同目录', () => {
  const dest = '/server/cache/_open/xiaoai/kg_123_ab.mp3'
  const first = buildTranscodePartPath(dest)
  const second = buildTranscodePartPath(dest)
  assert.notEqual(first, second, '两次转码不能共用同一个 .part')
  assert.ok(first.startsWith(dest), '临时文件必须与产物同目录，rename 才是原子的')
  assert.ok(first.endsWith('.part'))
  assert.ok(second.startsWith(dest) && second.endsWith('.part'))
})

// ---- 预解析地址缓存：坏地址必须能被清掉（P-1137）----

test('删掉单曲预解析缓存后不再命中', () => {
  const song = { source: 'wy', songmid: '3396958976', name: '梦的翅膀受了伤' }
  const key = buildTrackKey(song, '320k')
  setCachedTrackUrl(key, 'http://example.com/bad.m4a', 133000)
  assert.equal(getCachedTrack(key).url, 'http://example.com/bad.m4a')

  assert.equal(deleteCachedTrackBySong(song, '320k'), true)
  assert.equal(getCachedTrack(key).url, '', '坏地址被清后必须回到「需要重新解析」')
})

test('缓存有硬上限：一直被命中也不能永远不过期', () => {
  const realNow = Date.now
  let fake = realNow()
  const key = 'test|hard-ttl|320k'
  try {
    Date.now = () => fake
    setCachedTrackUrl(key, 'http://example.com/a.mp3', 1000)

    // 每 9 分钟命中一次，期间 TTL 一直被续期
    for (const step of [9, 18, 27]) {
      fake = realNow() + step * 60 * 1000
      assert.equal(getCachedTrack(key).url, 'http://example.com/a.mp3', `${step} 分钟时应仍然命中`)
    }

    // 距首次写入已 31 分钟：超过 30 分钟硬上限，即使刚被续期也必须作废
    fake = realNow() + 31 * 60 * 1000
    assert.equal(getCachedTrack(key).url, '', '硬上限到期必须作废，否则坏地址永远不淘汰')
  } finally {
    Date.now = realNow
  }
})
