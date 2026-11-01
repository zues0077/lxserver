import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLibraryPreview, runPullGuard, sampleFromStatus } from '../src/server/xiaoai/pullGuard'

/** 曲库 VIP：设备上报 92s、本曲 256s、进度还在往前 */
const VIP_STATUS = {
  playing: true,
  durationMs: 92055,
  positionMs: 21000,
  raw: { play_song_detail: { audio_id: '1674527082656325388', duration: 92055, unplayableCode: 2, vip: 1 } },
}
/** 正常播放我们的流：时长与本曲一致 */
const NORMAL_STATUS = {
  playing: true,
  durationMs: 256000,
  positionMs: 8000,
  raw: { play_song_detail: { audio_id: 'x', duration: 256000 } },
}

const sample = (status: any, pulled: boolean, positionMs?: number) => {
  const s = sampleFromStatus(status, pulled)
  return positionMs === undefined ? s : { ...s, positionMs }
}

test('sampleFromStatus 从 /status 摘出守门字段', () => {
  const s = sampleFromStatus(VIP_STATUS, false)
  assert.equal(s.durationMs, 92055)
  assert.equal(s.audioId, '1674527082656325388')
  assert.equal(s.unplayableCode, 2)
  assert.equal(s.playing, true)
})

test('设备上报时长明显短于本曲 → 判为在播曲库试听', () => {
  const r = detectLibraryPreview(sample(VIP_STATUS, false), sample(VIP_STATUS, false), 256000)
  assert.equal(r.hit, true)
  assert.match(r.reason, /短|试听/)
})

test('已拉流时永不判定（宁可不动手）', () => {
  const r = detectLibraryPreview(sample(VIP_STATUS, true), sample(VIP_STATUS, true), 256000)
  assert.equal(r.hit, false)
})

test('时长接近本曲时不判定，避免慢启动误伤', () => {
  const r = detectLibraryPreview(sample(NORMAL_STATUS, false), sample(NORMAL_STATUS, false), 256000)
  assert.equal(r.hit, false)
})

test('两次采样进度在推进 → 确实在出声，但不是我们的流', () => {
  const noDur = { playing: true, durationMs: 0, raw: { play_song_detail: {} } }
  const r = detectLibraryPreview(sample(noDur, false, 5000), sample(noDur, false, 6800), 256000)
  assert.equal(r.hit, true)
  assert.match(r.reason, /进度推进/)
})

test('进度没动也没有时长证据 → 不判定（可能只是还没起播）', () => {
  const idle = { playing: false, durationMs: 0, positionMs: 0, raw: {} }
  const r = detectLibraryPreview(sample(idle, false, 0), sample(idle, false, 0), 256000)
  assert.equal(r.hit, false)
})

const runGuard = (opts: {
  pulled: () => boolean
  stale?: () => boolean
  status: any
  expected?: number
  retried?: string[]
}) =>
  runPullGuard({
    isPulled: opts.pulled,
    isStale: opts.stale || (() => false),
    getStatus: async () => opts.status,
    expectedDurationMs: opts.expected ?? 256000,
    retry: async mode => { (opts.retried || []).push(mode) },
    log: () => {},
    delays: { probe: 0, gap: 0, after: 0 },
  })

test('已正常拉流：守门不动手', async () => {
  const retried: string[] = []
  const action = await runGuard({ pulled: () => true, status: VIP_STATUS, retried })
  assert.equal(action, 'none')
  assert.deepEqual(retried, [])
})

test('未拉流且是曲库试听：先换默认封面，重发后拉到流就停在这一级', async () => {
  const retried: string[] = []
  let pulled = false
  const action = await runPullGuard({
    isPulled: () => pulled,
    isStale: () => false,
    getStatus: async () => VIP_STATUS,
    expectedDurationMs: 256000,
    retry: async mode => {
      retried.push(mode)
      pulled = true
    },
    log: () => {},
    delays: { probe: 0, gap: 0, after: 0 },
  })
  assert.equal(action, 'placeholder')
  assert.deepEqual(retried, ['placeholder'])
})

test('换默认封面仍不拉流：升级到纯直链 player_play_url', async () => {
  const retried: string[] = []
  const action = await runGuard({ pulled: () => false, status: VIP_STATUS, retried })
  assert.equal(action, 'url')
  assert.deepEqual(retried, ['placeholder', 'url'])
})

test('状态正常（不是曲库试听）时不打扰：宁可等慢启动', async () => {
  const retried: string[] = []
  const action = await runGuard({ pulled: () => false, status: NORMAL_STATUS, retried })
  assert.equal(action, 'none')
  assert.deepEqual(retried, [])
})

test('期间已经切歌：直接放弃，不干扰新投送', async () => {
  const retried: string[] = []
  const action = await runGuard({ pulled: () => false, stale: () => true, status: VIP_STATUS, retried })
  assert.equal(action, 'none')
  assert.deepEqual(retried, [])
})

test('读状态失败时不判定（避免把云抖动画成故障）', async () => {
  const retried: string[] = []
  const action = await runPullGuard({
    isPulled: () => false,
    isStale: () => false,
    getStatus: async () => { throw new Error('MINA timeout') },
    expectedDurationMs: 256000,
    retry: async mode => { retried.push(mode) },
    log: () => {},
    delays: { probe: 0, gap: 0, after: 0 },
  })
  assert.equal(action, 'none')
  assert.deepEqual(retried, [])
})
