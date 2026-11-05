import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLibraryPreview, detectPulledButSilent, runPullGuard, sampleFromStatus } from '../src/server/xiaoai/pullGuard'

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
/** 曲库那版时长不对，但**不是** VIP 闸门（unplayableCode≠2）：占位重发有机会救回 */
const SHORT_NOT_VIP = {
  playing: true,
  durationMs: 92055,
  positionMs: 21000,
  raw: { play_song_detail: { audio_id: 'A', duration: 92055 } },
}
/** 曲库明确判 VIP 不可播（unplayableCode=2），时长与本曲一致 → 应跳过占位直接纯直链 */
const GATE_VIP = {
  playing: true,
  durationMs: 256000,
  positionMs: 21000,
  raw: { play_song_detail: { audio_id: 'B', duration: 256000, unplayableCode: 2 } },
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

test('非 VIP 的曲库试听：先换默认封面，重发后拉到流就停在这一级', async () => {
  const retried: string[] = []
  let pulled = false
  const action = await runPullGuard({
    isPulled: () => pulled,
    isStale: () => false,
    getStatus: async () => SHORT_NOT_VIP,
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

test('非 VIP 换默认封面仍不拉流：升级到纯直链 player_play_url', async () => {
  const retried: string[] = []
  const action = await runGuard({ pulled: () => false, status: SHORT_NOT_VIP, retried })
  assert.equal(action, 'url')
  assert.deepEqual(retried, ['placeholder', 'url'])
})

test('曲库判 VIP（unplayableCode=2）：跳过默认封面，直接纯直链（省一轮 ~5s）', async () => {
  const retried: string[] = []
  const action = await runGuard({ pulled: () => false, status: GATE_VIP, retried })
  assert.equal(action, 'url')
  assert.deepEqual(retried, ['url'])
})

test('状态正常（不是曲库试听）时不打扰：宁可等慢启动', async () => {
  const retried: string[] = []
  const action = await runGuard({ pulled: () => false, status: NORMAL_STATUS, retried })
  assert.equal(action, 'none')
  assert.deepEqual(retried, [])
})

// ---- 2026-11-01 补判据：设备「干脆不动」类（soda 实测形态）----

/** 汽水那次的真实形态：设备冻在上一首，不播不报错、时长还比本曲长 */
const SODA_FROZEN = {
  playing: false,
  durationMs: 300329,
  positionMs: 54000,
  raw: { play_song_detail: { audio_id: 'OLDAUDIO0001', duration: 300329 } },
}

test('设备上报的 audio_id 与本次下发不一致 → 判为推送未生效', () => {
  const r = detectLibraryPreview(
    sample(SODA_FROZEN, false, 54000),
    sample(SODA_FROZEN, false, 54000),
    227000,
    'NEWAUDIO0002',
  )
  assert.equal(r.hit, true)
  assert.match(r.reason, /audio_id/)
})

test('设备上报时长明显长于本曲（在播上一首）→ 也判为在播其它曲目', () => {
  // audio_id 拿不到（空）时，只能靠时长兜底
  const noAudio = { playing: false, durationMs: 300329, positionMs: 54000, raw: { play_song_detail: {} } }
  const r = detectLibraryPreview(
    sample(noAudio, false, 54000),
    sample(noAudio, false, 54000),
    227000,
    '',
  )
  assert.equal(r.hit, true)
  assert.match(r.reason, /长于本曲/)
})

test('audio_id 一致且时长一致、只是还没起播 → 仍不判定（避免误伤）', () => {
  const pending = {
    playing: false,
    durationMs: 227000,
    positionMs: 0,
    raw: { play_song_detail: { audio_id: 'SAME', duration: 227000 } },
  }
  const r = detectLibraryPreview(sample(pending, false), sample(pending, false), 227000, 'SAME')
  assert.equal(r.hit, false)
})

test('设备没换曲（audio_id 不同）→ 守门触发补救重发', async () => {
  const retried: string[] = []
  let pulled = false
  const action = await runPullGuard({
    isPulled: () => pulled,
    isStale: () => false,
    getStatus: async () => SODA_FROZEN,
    expectedDurationMs: 227000,
    expectedAudioId: 'NEWAUDIO0002',
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

// ---- 拉了流但根本没播（2026-11-05 实测 LX04：只拉 1MB 起播缓冲就断开）----

/** 设备拉了流，但一直 paused / pos=0 */
const PULLED_SILENT = {
  playing: false,
  paused: true,
  durationMs: 0,
  positionMs: 0,
  raw: { play_song_detail: { audio_id: 'A', duration: 0, unplayableCode: 2 } },
}
/** 设备拉了流并正常播放 */
const PULLED_PLAYING = {
  playing: true,
  durationMs: 225000,
  positionMs: 12000,
  raw: { play_song_detail: { audio_id: 'A', duration: 225000 } },
}

test('detectPulledButSilent：拉过流、两次都 pos=0 且服务端已停推、过了窗口 → 命中', () => {
  const first = sample(PULLED_SILENT, true)
  const second = sample(PULLED_SILENT, true)
  const signal = detectPulledButSilent(first, second, {
    elapsedSincePushMs: 20000,
    streaming: false,
  })
  assert.equal(signal.hit, true)
})

test('detectPulledButSilent：还在起播窗口内不判定', () => {
  const signal = detectPulledButSilent(sample(PULLED_SILENT, true), sample(PULLED_SILENT, true), {
    elapsedSincePushMs: 6000,
    streaming: false,
  })
  assert.equal(signal.hit, false)
})

test('detectPulledButSilent：服务端还在推流（缓冲中）不判定', () => {
  const signal = detectPulledButSilent(sample(PULLED_SILENT, true), sample(PULLED_SILENT, true), {
    elapsedSincePushMs: 30000,
    streaming: true,
  })
  assert.equal(signal.hit, false)
})

test('detectPulledButSilent：播过（pos>0）就绝不判定，用户暂停不会被重发打断', () => {
  const pausedAfterPlay = { playing: false, durationMs: 225000, positionMs: 40000, raw: PULLED_SILENT.raw }
  const signal = detectPulledButSilent(sample(pausedAfterPlay, true), sample(pausedAfterPlay, true), {
    elapsedSincePushMs: 60000,
    streaming: false,
  })
  assert.equal(signal.hit, false)
})

test('拉流但不播 → 守门跳过占位，直接纯直链重发', async () => {
  const retried: string[] = []
  const action = await runPullGuard({
    isPulled: () => true,
    isStale: () => false,
    getStatus: async () => PULLED_SILENT,
    expectedDurationMs: 225000,
    expectedAudioId: 'A',
    isStreaming: () => false,
    pushedAt: Date.now() - 30000,
    retry: async mode => { retried.push(mode) },
    log: () => {},
    delays: { probe: 0, gap: 0, after: 0, silentWindow: 1 },
  })
  assert.equal(action, 'url')
  assert.deepEqual(retried, ['url'], '占位那一级对「拉了不播」无效，应直接走纯直链')
})

test('拉流且正常播放 → 守门不插手', async () => {
  const retried: string[] = []
  const action = await runPullGuard({
    isPulled: () => true,
    isStale: () => false,
    getStatus: async () => PULLED_PLAYING,
    expectedDurationMs: 225000,
    expectedAudioId: 'A',
    isStreaming: () => true,
    pushedAt: Date.now() - 30000,
    retry: async mode => { retried.push(mode) },
    log: () => {},
    delays: { probe: 0, gap: 0, after: 0, silentWindow: 1 },
  })
  assert.equal(action, 'none')
  assert.deepEqual(retried, [])
})
