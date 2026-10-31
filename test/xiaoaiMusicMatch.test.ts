/**
 * 小爱投送「曲库命中」—— 纯逻辑单测
 *
 * 背景（2026-10-31）：用户反馈投送时「很多都是默认封面、也没有歌词」。
 * 查证结论：触屏屏幕的封面/歌名/滚动歌词**全部来自小米曲库**——
 * player_play_music 的 payload 只能带 audio_id 与 stream.url，带不了封面也带不了歌词
 * （songloft-plugin-miot 的官方文档也写明「触屏音箱本机歌词依赖设备的 Music API 及云端曲库匹配」）。
 * 所以曲库搜不到就必然退占位曲目（Theme Of Loft 那张默认封面）。
 *
 * 这里守的是「提高命中率但不瞎配」的判据：
 *   buildSearchQueries    多条 query 逐级放宽（歌手写法/歌名后缀不一致时救回来）
 *   pickMusicCandidate    分档打分择优（宁可退占位，也不拿同名不同歌手的一堆候选乱选）
 *
 * 最容易被改坏的两条底线：
 *   1) 歌名近似 + 歌手明确不同 → 绝不采用（那是另一首歌，错配比默认封面更糟）
 *   2) 同名多首 + 歌手对不上 → 不采用（取谁都可能错，留给占位）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSearchQueries,
  normalizeSongName,
  pickMusicCandidate,
  stripSongDecorations,
  type MusicCandidate,
} from '../src/server/xiaoai/musicMatch'

const cand = (name: string, artist: string, audioId: string): MusicCandidate => ({ name, artist, audioId })

test('normalizeSongName：括号内容 / feat. / - Live 尾巴都剥掉，繁简与大小写原样保留', () => {
  assert.equal(normalizeSongName('夜曲'), '夜曲')
  assert.equal(normalizeSongName('夜曲 (Live)'), '夜曲')
  assert.equal(normalizeSongName('夜曲（伴奏）'), '夜曲')
  assert.equal(normalizeSongName('晴天 - Remastered 2023'), '晴天')
  assert.equal(normalizeSongName('The Theme Of Loft'), 'thethemeofloft')
  assert.equal(normalizeSongName('稻香 feat. 某人'), '稻香')
  assert.equal(normalizeSongName('【纯音乐】River Flows in You'), 'riverflowsinyou')
})

test('normalizeSongName：全角字母数字转半角，标点与空白不参与比较', () => {
  assert.equal(normalizeSongName('Ｌｏｖｅ　Ｓｔｏｒｙ'), 'lovestory')
  assert.equal(normalizeSongName('Love-Story!!'), 'lovestory')
})

test('normalizeSongName：没写括号的末尾版本词也剥掉（夜曲钢琴版 = 夜曲）', () => {
  assert.equal(normalizeSongName('夜曲钢琴版'), '夜曲')
  assert.equal(normalizeSongName('稻香 完整版'), '稻香')
  // 以版本词开头的正常歌名不能被吃掉（只锚末尾）
  assert.equal(normalizeSongName('Live Forever'), 'liveforever')
})

test('normalizeSongName：空与空白返回空串（调用方据此直接退占位）', () => {
  assert.equal(normalizeSongName(''), '')
  assert.equal(normalizeSongName('   '), '')
  assert.equal(normalizeSongName(undefined as unknown as string), '')
})

test('stripSongDecorations：只去装饰，保留原样的大小写与主体（用于二次搜索）', () => {
  assert.equal(stripSongDecorations('夜曲 (Live)'), '夜曲')
  assert.equal(stripSongDecorations('Bohemian Rhapsody - Remastered 2011'), 'Bohemian Rhapsody')
  assert.equal(stripSongDecorations('Shape of You (feat. Someone)'), 'Shape of You')
  // 没有装饰时原样返回，不做大小写/全角改写以外的动作
  assert.equal(stripSongDecorations('Theme Of Loft'), 'Theme Of Loft')
})

test('buildSearchQueries：有歌手时先发「歌名-歌手」，再退「纯歌名」', () => {
  assert.deepEqual(buildSearchQueries('夜曲', '周杰伦'), ['夜曲-周杰伦', '夜曲'])
})

test('buildSearchQueries：歌名带后缀时追加清洗后的查询，最多 3 条', () => {
  const qs = buildSearchQueries('夜曲 (Live)', '周杰伦')
  assert.equal(qs.length, 3)
  assert.equal(qs[0], '夜曲 (Live)-周杰伦')
  assert.equal(qs[1], '夜曲 (Live)')
  assert.equal(qs[2], '夜曲-周杰伦')
})

test('buildSearchQueries：无歌手时只发歌名，清洗后不同则补一条', () => {
  assert.deepEqual(buildSearchQueries('晴天', ''), ['晴天'])
  assert.deepEqual(buildSearchQueries('晴天 (Live)', ''), ['晴天 (Live)', '晴天'])
})

test('buildSearchQueries：空歌名返回空数组（不再白打接口）', () => {
  assert.deepEqual(buildSearchQueries('', '周杰伦'), [])
  assert.deepEqual(buildSearchQueries('   ', ''), [])
})

test('pickMusicCandidate：同名 + 歌手匹配 → 采用（最理想档）', () => {
  const pick = pickMusicCandidate([cand('夜曲', '周杰伦', 'A1')], '夜曲', '周杰伦')
  assert.ok(pick)
  assert.equal(pick.candidate.audioId, 'A1')
  assert.equal(pick.score, 100)
})

test('pickMusicCandidate：曲库名带 (Live) 后缀也能认成同名（归一化后相等）', () => {
  const pick = pickMusicCandidate([cand('夜曲 (Live)', '周杰伦', 'A1')], '夜曲', '周杰伦')
  assert.ok(pick)
  assert.equal(pick.candidate.audioId, 'A1')
  // 目标本身不是 Live，候选是 Live → 降权但不至于弃用
  assert.ok(pick.score < 100 && pick.score >= 60)
})

test('pickMusicCandidate：同名 + 歌手写法不同但同名唯一 → 采用（翻译名/别名场景）', () => {
  const pick = pickMusicCandidate([cand('夜曲', 'Jay Chou', 'A1')], '夜曲', '周杰伦')
  assert.ok(pick)
  assert.equal(pick.candidate.audioId, 'A1')
  assert.equal(pick.score, 80)
})

test('pickMusicCandidate：同名多首且歌手全对不上 → 不采用（取谁都可能错，留给占位）', () => {
  const list = [cand('Alone', 'A 歌手', 'A1'), cand('Alone', 'B 歌手', 'A2')]
  assert.equal(pickMusicCandidate(list, 'Alone', '我们的歌手'), null)
})

test('pickMusicCandidate：歌名近似（一方多出词）+ 歌手匹配 → 采用', () => {
  const pick = pickMusicCandidate([cand('Theme Of Loft', 'Loft', 'A1')], 'The Theme Of Loft', 'Loft')
  assert.ok(pick)
  assert.equal(pick.candidate.audioId, 'A1')
  assert.equal(pick.score, 70)
})

test('pickMusicCandidate：歌名近似 + 歌手明确不同 → 绝不采用（那是另一首歌）', () => {
  const pick = pickMusicCandidate([cand('Theme Of Loft', '别的歌手', 'A1')], 'The Theme Of Loft', 'Loft')
  assert.equal(pick, null)
})

test('pickMusicCandidate：「爱你」与「爱你一万年」不算近似（短名包含长名必须过半）', () => {
  const pick = pickMusicCandidate([cand('爱你一万年', '刘德华', 'A1')], '爱你', '刘德华')
  assert.equal(pick, null)
})

test('pickMusicCandidate：同名同歌手有原版与 Live 版时优先原版', () => {
  const list = [cand('夜曲 (Live)', '周杰伦', 'LIVE'), cand('夜曲', '周杰伦', 'STUDIO')]
  const pick = pickMusicCandidate(list, '夜曲', '周杰伦')
  assert.ok(pick)
  assert.equal(pick.candidate.audioId, 'STUDIO')
})

test('pickMusicCandidate：同分时保留搜索排序更靠前的那条', () => {
  const list = [cand('夜曲', '周杰伦', 'FIRST'), cand('夜曲', '周杰伦', 'SECOND')]
  const pick = pickMusicCandidate(list, '夜曲', '周杰伦')
  assert.ok(pick)
  assert.equal(pick.candidate.audioId, 'FIRST')
})

test('pickMusicCandidate：没有 audioID 的候选一律跳过（拿去投送会变成别的歌）', () => {
  const pick = pickMusicCandidate([cand('夜曲', '周杰伦', '')], '夜曲', '周杰伦')
  assert.equal(pick, null)
})

test('pickMusicCandidate：歌手为空时按「候选无歌手」档处理，不误判成不匹配', () => {
  const pick = pickMusicCandidate([cand('夜曲', '周杰伦', 'A1')], '夜曲', '')
  assert.ok(pick)
  assert.equal(pick.candidate.audioId, 'A1')
  assert.equal(pick.score, 92)
})

test('pickMusicCandidate：歌手「王菲」不能被「王菲菲」当成同一人（真机踩过：如愿配错人）', () => {
  const pick = pickMusicCandidate([cand('如愿', '王菲菲', 'WRONG')], '如愿', '王菲')
  assert.ok(pick)
  // 同名唯一 → 仍可兜底采用（80），但绝不能算成「歌手匹配」（100）
  assert.equal(pick.score, 80)
})

test('pickMusicCandidate：中英文连写的歌手算同一人（Yamy郭颖 ⊃ 郭颖）', () => {
  const pick = pickMusicCandidate([cand('问爱', 'Yamy郭颖', 'A1')], '问爱', '郭颖')
  assert.ok(pick)
  assert.equal(pick.score, 100)
})

test('pickMusicCandidate：括号里的别名算同一人（冯沁苑(买辣椒也用券) ⊃ 买辣椒也用券）', () => {
  const pick = pickMusicCandidate([cand('起风了', '冯沁苑(买辣椒也用券)', 'A1')], '起风了', '买辣椒也用券')
  assert.ok(pick)
  assert.equal(pick.score, 100)
})

test('pickMusicCandidate：歌手全对得上时优先选对的，而不是同名但歌手相近的', () => {
  const list = [cand('如愿', '王菲菲', 'WRONG'), cand('如愿', '王菲', 'RIGHT')]
  const pick = pickMusicCandidate(list, '如愿', '王菲')
  assert.ok(pick)
  assert.equal(pick.candidate.audioId, 'RIGHT')
})

test('pickMusicCandidate：空候选 / 空歌名返回 null', () => {
  assert.equal(pickMusicCandidate([], '夜曲', '周杰伦'), null)
  assert.equal(pickMusicCandidate([cand('夜曲', '周杰伦', 'A1')], '', '周杰伦'), null)
  assert.equal(pickMusicCandidate(undefined as unknown as MusicCandidate[], '夜曲', ''), null)
})
