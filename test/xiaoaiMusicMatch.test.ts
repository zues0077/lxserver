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
  extractBracketArtist,
  normalizeSongName,
  pickMusicCandidate,
  resolveMatchTarget,
  splitBookTitle,
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

test('buildSearchQueries：歌名带后缀时追加清洗后的查询', () => {
  const qs = buildSearchQueries('夜曲 (Live)', '周杰伦')
  assert.equal(qs[0], '夜曲 (Live)-周杰伦')
  assert.equal(qs[1], '夜曲 (Live)')
  assert.equal(qs[2], '夜曲-周杰伦')
  assert.equal(qs[3], '夜曲')
})

test('buildSearchQueries：无歌手时只发歌名，清洗后不同则补一条', () => {
  assert.deepEqual(buildSearchQueries('晴天', ''), ['晴天'])
  assert.deepEqual(buildSearchQueries('晴天 (Live)', ''), ['晴天 (Live)', '晴天'])
})

test('buildSearchQueries：空歌名返回空数组（不再白打接口）', () => {
  assert.deepEqual(buildSearchQueries('', '周杰伦'), [])
  assert.deepEqual(buildSearchQueries('   ', ''), [])
})

test('splitBookTitle：书名号后接空格+歌手（B站第二种写法）', () => {
  // 真机踩过：《海底》 一支榴莲 原版 配唯美mv —— 旧逻辑只认破折号，歌手取不到 → 退占位
  assert.deepEqual(splitBookTitle('《海底》 一支榴莲 原版 配唯美mv'), { title: '海底', artist: '一支榴莲' })
  assert.deepEqual(splitBookTitle('《晴天》 周杰伦'), { title: '晴天', artist: '周杰伦' })
  // 空格后是版本标签时不能当歌手
  assert.equal(splitBookTitle('《晴天》 原版').artist, '')
  assert.equal(splitBookTitle('《晴天》 高清').artist, '')
})

test('splitBookTitle：视频站标题拆出真歌名与紧跟其后的真歌手', () => {
  // 真机实测的 B站标题（2026-11-02）：外部歌手是 UP 主，曲库根本不认识
  const real = '【无损音质】《起风了》-买辣椒也用券  “起风了，也让我想起了那年夏天”'
  assert.deepEqual(splitBookTitle(real), { title: '起风了', artist: '买辣椒也用券' })
  assert.deepEqual(splitBookTitle('《夜曲》_周杰伦'), { title: '夜曲', artist: '周杰伦' })
  // 没有书名号就是普通标题，交给别的分支处理
  assert.equal(splitBookTitle('夜曲 (Live)'), null)
})

test('stripSongDecorations：引号感想整段丢弃，书名号只丢符号', () => {
  const real = '【无损音质】《起风了》-买辣椒也用券  “起风了，也让我想起了那年夏天”'
  assert.equal(stripSongDecorations(real), '起风了 -买辣椒也用券')
})

test('extractBracketArtist：括号里是歌手就取出来，是音质/版本标签就返回空', () => {
  assert.equal(extractBracketArtist('稻香（杰伦）'), '杰伦')
  assert.equal(extractBracketArtist('夜曲 (周杰伦)'), '周杰伦')
  assert.equal(extractBracketArtist('【无损音质】起风了'), '')
  assert.equal(extractBracketArtist('夜曲 (Live)'), '')
  assert.equal(extractBracketArtist('稻香（伴奏）'), '')
  assert.equal(extractBracketArtist('夜曲'), '')
})

test('extractBracketArtist：「原唱 XXX」前缀要剥掉，取后面的人名', () => {
  // 网易云翻唱命名的通用形态（真机踩过：晴天 (原唱 周杰伦) 取不到歌手，退成占位封面）
  assert.equal(extractBracketArtist('晴天 (原唱 周杰伦)'), '周杰伦')
  assert.equal(extractBracketArtist('后来（原唱：刘若英）'), '刘若英')
  assert.equal(extractBracketArtist('演员 (翻自 薛之谦)'), '薛之谦')
  // 只有标签没有名字时仍返回空
  assert.equal(extractBracketArtist('晴天 (原唱)'), '')
})

test('buildSearchQueries：网易云翻唱命名能拆成干净 query', () => {
  const qs = buildSearchQueries('晴天 (原唱 周杰伦)', 'RyaVocal')
  assert.equal(qs[0], '晴天-周杰伦')
  assert.equal(qs[1], '晴天')
})

test('buildSearchQueries：视频站标题不再拿 UP 主当歌手搜（真机 0 命中场景）', () => {
  const real = '【无损音质】《起风了》-买辣椒也用券  “起风了，也让我想起了那年夏天”'
  const qs = buildSearchQueries(real, '西伯利亚麻雀')
  assert.equal(qs[0], '起风了-买辣椒也用券')
  assert.equal(qs[1], '起风了')
  // UP 主名只作最后备选
  assert.ok(qs.includes('起风了-西伯利亚麻雀'))
})

test('buildSearchQueries：歌名括号里带歌手时，用清洗后的歌名 + 括号里的歌手', () => {
  const qs = buildSearchQueries('稻香（杰伦）', '哇欣')
  assert.equal(qs[0], '稻香-杰伦')
  assert.equal(qs[1], '稻香')
  assert.ok(qs.includes('稻香-哇欣'))
})

test('pickMusicCandidate：歌手用后缀称呼也算同一人（杰伦 = 周杰伦）', () => {
  const pick = pickMusicCandidate([cand('稻香', '周杰伦', 'A1')], '稻香', '杰伦')
  assert.ok(pick)
  assert.equal(pick.score, 100)
})

test('pickMusicCandidate：下划线/标点差异不算不同人（Yamy_郭颖 = Yamy郭颖）', () => {
  // 真机踩过：本地曲库歌手是 Yamy_郭颖，云端曲库是 Yamy郭颖，
  // 旧逻辑判 mismatch + 同名多版本 → 拒绝 → 屏显退回 Theme Of Loft
  const pick = pickMusicCandidate([cand('问爱', 'Yamy郭颖', 'A1')], '问爱', 'Yamy_郭颖')
  assert.ok(pick)
  assert.equal(pick.candidate.audioId, 'A1')
  assert.equal(pick.score, 100)
})

test('resolveMatchTarget：搜索与择优必须用同一个基准（否则搜到了也会被拒）', () => {
  const real = '【无损音质】《起风了》-买辣椒也用券  “起风了，也让我想起了那年夏天”'
  assert.deepEqual(resolveMatchTarget(real, '西伯利亚麻雀'), { title: '起风了', artist: '买辣椒也用券' })
  assert.deepEqual(resolveMatchTarget('稻香（杰伦）', '哇欣'), { title: '稻香', artist: '杰伦' })
  // 普通歌名原样保留
  assert.deepEqual(resolveMatchTarget('夜曲', '周杰伦'), { title: '夜曲', artist: '周杰伦' })
})

test('端到端：视频站标题经 resolveMatchTarget 后能匹配到曲库干净歌名', () => {
  const real = '【无损音质】《起风了》-买辣椒也用券  “起风了，也让我想起了那年夏天”'
  const target = resolveMatchTarget(real, '西伯利亚麻雀')
  const pick = pickMusicCandidate([cand('起风了', '冯沁苑(买辣椒也用券)', 'HIT')], target.title, target.artist)
  assert.ok(pick)
  assert.equal(pick.candidate.audioId, 'HIT')
  assert.equal(pick.score, 100)
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
