/**
 * 汽水免签名明文通道（h5 + SEO 兜底）自测 —— 用 `tsx --test test/sodaSeo.test.ts` 运行。
 *
 * 覆盖两件事：
 *   1) **解析分支要齐** —— `video_model`（snake_case）与 `url_player_info → 火山
 *      PlayInfoList`（PascalCase）两条路都得能出流。原实现只有前一条，
 *      于是「上游只给 url_player_info」的曲目会被误报成「未返回可用音频流」。
 *   2) **试听判定要准** —— 优先信平台声明的 `track.preview.duration`，
 *      拿不到才退回「流时长明显短于整曲」。
 *
 * 用例里的 `fixtures_seo_track.json` 是线上真实抓包（VIP 曲，明文通道只给 60 秒），
 * 用它兜住「字段结构变了但代码没跟着变」这种静默失效。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHint,
  chooseStream,
  isPreviewStream,
  mapPlayerInfoItems,
  parseJsonBody,
  parseVideoModel,
  shapePlainFetch,
  videoItems,
} from '../src/server/extraSources/soda'
import type { SodaStreamDiagnosis } from '../src/server/extraSources/soda'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures_seo_track.json'), 'utf-8'))

// ---- parseJsonBody：三种响应体形态都要认 ----

test('parseJsonBody 支持对象 / JSON 字符串 / Buffer', () => {
  assert.deepEqual(parseJsonBody({ body: { a: 1 } }), { a: 1 })
  assert.deepEqual(parseJsonBody({ body: '{"a":2}' }), { a: 2 })
  assert.deepEqual(parseJsonBody({ body: Buffer.from('{"a":3}') }), { a: 3 })
})

test('parseJsonBody 对非 JSON / 空响应返回 null 而不是抛异常', () => {
  assert.equal(parseJsonBody({ body: '<html>502</html>' }), null)
  assert.equal(parseJsonBody({ body: '' }), null)
  assert.equal(parseJsonBody({}), null)
  assert.equal(parseJsonBody(null), null)
})

// ---- parseVideoModel ----

test('parseVideoModel 同时认对象与 JSON 字符串', () => {
  assert.deepEqual(parseVideoModel({ video_list: [] }), { video_list: [] })
  assert.deepEqual(parseVideoModel('{"video_duration":30}'), { video_duration: 30 })
  assert.deepEqual(parseVideoModel('null'), {})
  assert.deepEqual(parseVideoModel(''), {})
  assert.deepEqual(parseVideoModel(undefined), {})
})

// ---- videoItems：只有真能用的直链才算候选 ----

test('videoItems 过滤掉没有可用地址的条目', () => {
  const items = videoItems({
    video_list: [
      { main_url: 'https://v26-luna.douyinvod.com/a' },
      { main_url: '', backup_url: 'https://v5-luna.douyinvod.com/b' },
      { main_url: 'null' },
      {},
    ],
  })
  assert.equal(items.length, 2)
  assert.equal(items[0].main_url, 'https://v26-luna.douyinvod.com/a')
  assert.equal(items[1].backup_url, 'https://v5-luna.douyinvod.com/b')
})

// ---- chooseStream：尊重用户选的音质（原实现恒取最高） ----

const threeTiers = [
  { main_url: 'https://x/high', video_meta: { quality: 'highest', bitrate: 257723 } },
  { main_url: 'https://x/mid', video_meta: { quality: 'medium', bitrate: 65675 } },
  { main_url: 'https://x/higher', video_meta: { quality: 'higher', bitrate: 129679 } },
]

test('chooseStream 按请求音质封顶', () => {
  assert.equal(chooseStream(threeTiers, '128k')?.video_meta?.quality, 'medium')
  assert.equal(chooseStream(threeTiers, '320k')?.video_meta?.quality, 'highest')
  assert.equal(chooseStream(threeTiers, 'flac')?.video_meta?.quality, 'highest')
  assert.equal(chooseStream(threeTiers, 'unknown-quality')?.video_meta?.quality, 'highest')
})

test('chooseStream 没有符合档位时退回最低档，空列表返回 null', () => {
  const onlyHigh = [{ main_url: 'https://x/highest', video_meta: { quality: 'highest', bitrate: 257723 } }]
  assert.equal(chooseStream(onlyHigh, '128k')?.video_meta?.quality, 'highest')
  assert.equal(chooseStream([], '320k'), null)
})

// ---- isPreviewStream ----

function fetchOf(streamDuration: number, trackDuration: number, previewDuration = 0) {
  return { tag: 'x', parsed: {}, items: [], streamDuration, trackDuration, previewDuration }
}

test('isPreviewStream 命中平台声明的试听时长', () => {
  assert.equal(isPreviewStream(fetchOf(60.001, 236.62, 60.001)), true)
  assert.equal(isPreviewStream(fetchOf(30, 240, 30)), true)
})

test('isPreviewStream 退回「流明显短于整曲」判据', () => {
  assert.equal(isPreviewStream(fetchOf(30, 240)), true)
  assert.equal(isPreviewStream(fetchOf(236, 236.62)), false)
})

test('isPreviewStream 缺时长信息时不误判为试听', () => {
  assert.equal(isPreviewStream(fetchOf(0, 0)), false)
  assert.equal(isPreviewStream(fetchOf(0, 240)), false)
  assert.equal(isPreviewStream(fetchOf(120, 0)), false)
})

// ---- 真实抓包样本：端到端走一遍 shapePlainFetch ----

test('真实样本（VIP 曲）→ 解析出 3 条候选流且判定为 60 秒试听', () => {
  const got = shapePlainFetch('seo', fixture)
  assert.equal(got.tag, 'seo')
  assert.equal(got.items.length, 3)
  assert.equal(got.streamDuration, 60.001)
  assert.equal(Math.round(got.trackDuration), 237)
  assert.equal(got.previewDuration, 60.001)
  assert.equal(isPreviewStream(got), true)

  // 即便用户选了无损，明文通道能给的也只是试听最高档
  const chosen = chooseStream(got.items, 'flac')
  assert.equal(chosen?.video_meta?.quality, 'highest')
  assert.equal(String(chosen?.main_url).startsWith('https://'), true)
})

test('整曲样本（流时长≈整曲）→ 判定为非试听', () => {
  const full = {
    ...fixture,
    track_player: {
      ...fixture.track_player,
      video_model: JSON.stringify({
        video_duration: 236.62,
        video_list: [
          { main_url: 'https://v26-luna.douyinvod.com/full', video_meta: { quality: 'lossless', vtype: 'flac', bitrate: 852000 } },
        ],
      }),
    },
  }
  const got = shapePlainFetch('seo', full)
  assert.equal(isPreviewStream(got), false)
  const chosen = chooseStream(got.items, 'flac')
  assert.equal(chosen?.video_meta?.quality, 'lossless')
  assert.equal(chosen?.video_meta?.vtype, 'flac')
})

// ---- 火山 VOD 分支（url_player_info） ----

test('mapPlayerInfoItems 把 PascalCase 字段映射成统一结构', () => {
  const items = mapPlayerInfoItems([
    { MainPlayUrl: 'https://v26-luna.douyinvod.com/p1', BackupPlayUrl: 'https://v5-luna.douyinvod.com/b1', Quality: 'lossless', Format: 'flac', Bitrate: '852000', Size: '30000000', Duration: '236.62', Codec: 'flac' },
    { MainPlayUrl: '', BackupPlayUrl: '' },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].main_url, 'https://v26-luna.douyinvod.com/p1')
  assert.equal(items[0].video_meta?.quality, 'lossless')
  assert.equal(items[0].video_meta?.vtype, 'flac')
  assert.equal(items[0].video_meta?.bitrate, 852000)
  assert.equal(items[0].video_meta?.size, 30000000)
})

test('mapPlayerInfoItems 兼容小写字段名与空输入', () => {
  const items = mapPlayerInfoItems([{ main_play_url: 'https://x/y', quality: 'higher', format: 'm4a', bitrate: 132000 }])
  assert.equal(items.length, 1)
  assert.equal(items[0].video_meta?.quality, 'higher')
  assert.deepEqual(mapPlayerInfoItems([]), [])
  assert.deepEqual(mapPlayerInfoItems(undefined as any), [])
})

// ---- 真实样本的「两个挂载点」都要认：h5 用 track，SEO 用 seo_track.track ----

test('shapePlainFetch 同时认 track 与 seo_track.track 两处元数据', () => {
  const h5Shape = { track_player: fixture.track_player, track: fixture.seo_track.track }
  const a = shapePlainFetch('h5', h5Shape)
  assert.equal(Math.round(a.trackDuration), 237)
  assert.equal(a.previewDuration, 60.001)

  const b = shapePlainFetch('seo', fixture)
  assert.equal(Math.round(b.trackDuration), 237)
  assert.equal(b.previewDuration, 60.001)
})

// ---- buildHint：诊断提示必须能区分四种失败原因 ----
//
// 这是 Task 5 的核心。原实现失败时只有一句「未返回可用音频流」，
// 用户既分不清是签名器没配还是这曲本来就没权益，也不知道下一步该干嘛。

function diagnosis(patch: Partial<SodaStreamDiagnosis>): SodaStreamDiagnosis {
  return {
    trackId: '7501674235158431760',
    trackDurationSeconds: 237,
    streamDurationSeconds: 0,
    source: '',
    quality: '',
    url: '',
    isPreview: false,
    isLossless: false,
    requiresVip: false,
    hasCookie: false,
    hasSigner: false,
    signerOnline: false,
    signerError: '',
    channels: [],
    hint: '',
    ...patch,
  }
}

test('buildHint：整曲 / 整曲无损 / 有流但是试听', () => {
  assert.match(buildHint(diagnosis({ url: 'https://x/a', source: 'h5', quality: '320k' })), /整曲/)
  assert.match(
    buildHint(diagnosis({ url: 'https://x/a', source: 'signer', quality: 'flac', isLossless: true })),
    /整曲无损流/,
  )
  assert.match(
    buildHint(diagnosis({ url: 'https://x/a', source: 'seo', isPreview: true, streamDurationSeconds: 60 })),
    /试听/,
  )
})

test('buildHint：会员曲 + 签名器未配 → 提示去配签名器', () => {
  const hint = buildHint(diagnosis({
    url: 'https://x/a', source: 'seo', isPreview: true, requiresVip: true,
    streamDurationSeconds: 60, signerError: '未配置签名器地址（qishui.signerUrl）',
  }))
  assert.match(hint, /会员/)
  assert.match(hint, /签名器/)
})

test('buildHint：会员曲 + 签名器在线仍试听 → 指向设备指纹/权益不匹配', () => {
  const hint = buildHint(diagnosis({
    url: 'https://x/a', source: 'seo', isPreview: true, requiresVip: true,
    hasSigner: true, signerOnline: true, streamDurationSeconds: 60,
  }))
  assert.match(hint, /设备指纹|权益/)
})

test('buildHint：什么流都没有 → 区分「通道都没解析到」与「签名器离线」', () => {
  assert.match(buildHint(diagnosis({})), /没解析到播放流/)
  assert.match(
    buildHint(diagnosis({ hasSigner: true, signerOnline: false, signerError: '连接被拒绝' })),
    /签名器离线/,
  )
})

