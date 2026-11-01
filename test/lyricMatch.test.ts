import { test } from 'node:test'
import assert from 'node:assert'
import {
  cleanTitle,
  durationSeconds,
  pickBest,
  plainToLrc,
  scoreCandidate,
  similarity,
  singerScore,
  parseSodaQrc,
} from '../src/utils/lyricMatch'

test('durationSeconds 兼容 mm:ss / 秒 / 毫秒 / hh:mm:ss', () => {
  assert.strictEqual(durationSeconds('04:12'), 252)
  assert.strictEqual(durationSeconds('4:12'), 252)
  assert.strictEqual(durationSeconds('252'), 252)
  // 毫秒：大于 3600 一律按毫秒处理
  assert.strictEqual(durationSeconds('252000'), 252)
  assert.strictEqual(durationSeconds('04:12.35'), 252)
  assert.strictEqual(durationSeconds('1:02:03'), 3723)
  assert.strictEqual(durationSeconds(''), 0)
  assert.strictEqual(durationSeconds(null), 0)
  assert.strictEqual(durationSeconds('abc'), 0)
})

test('cleanTitle 去掉版本/音质标注与标点', () => {
  assert.strictEqual(cleanTitle('【4K】晴天'), '晴天')
  assert.strictEqual(cleanTitle('晴天 (Live)'), '晴天')
  assert.strictEqual(cleanTitle('晴天（女声版）'), '晴天')
  assert.strictEqual(cleanTitle('有谱(Live)'), '有谱')
  // 空格也会被抹掉（匹配只比字面，不比排版）
  assert.strictEqual(cleanTitle('周杰伦 feat. 费玉清'), '周杰伦费玉清')
  assert.strictEqual(cleanTitle(''), '')
})

test('similarity：同曲不同版本仍高，异曲必须低', () => {
  assert.strictEqual(similarity('晴天', '晴天'), 1)
  assert.strictEqual(similarity('晴天', '晴天 (Live)'), 1)
  assert.ok(similarity('稻香', '晴天') < 0.3, '不同歌不应判为同曲')
  assert.ok(similarity('有谱', '有谱(Live)') >= 0.85)
  assert.ok(similarity('', '晴天') === 0)
})

test('singerScore：多人合唱与单人应算命中', () => {
  assert.strictEqual(singerScore('周杰伦', '周杰伦'), 1)
  assert.ok(singerScore('周杰伦', '周杰伦、费玉清') >= 0.9)
  assert.strictEqual(singerScore('周杰伦', '林俊杰'), 0)
  assert.strictEqual(singerScore('', '林俊杰'), 0.5)
})

test('scoreCandidate：时长相仿的同名曲接受，时长差太多拒绝', () => {
  const target = { name: '晴天', singer: '周杰伦', interval: '04:29' }
  const ok = scoreCandidate(target, { name: '晴天', singer: '周杰伦', interval: '04:30' })
  assert.ok(ok.accept, '同名同歌手 + 时长差 1s 应该接受')
  const wrong = scoreCandidate(target, { name: '晴天', singer: '周杰伦', interval: '06:20' })
  assert.ok(!wrong.accept, '时长差 111s 是演唱会版，不能拿它的词')
  const other = scoreCandidate(target, { name: '稻香', singer: '周杰伦', interval: '04:29' })
  assert.ok(!other.accept, '不同歌名不接受')
})

test('pickBest：多候选取最高分，没有合适就返回 null', () => {
  const target = { name: '有谱', singer: '李昂星', interval: '03:11' }
  const list = [
    { songmid: 'a', name: '有谱 (Live)', singer: '李昂星', interval: '03:12' },
    { songmid: 'b', name: '没谱', singer: '李昂星', interval: '03:11' },
    { songmid: 'c', name: '有谱', singer: '段炼', interval: '02:39' },
  ]
  const best = pickBest(target, list)
  assert.ok(best, '应该挑出一条')
  assert.strictEqual(best.songmid, 'a')
  assert.strictEqual(pickBest(target, [{ songmid: 'x', name: '完全无关', singer: '别人', interval: '03:11' }]), null)
})

test('plainToLrc：纯文本补 3 秒递进时间轴', () => {
  const out = plainToLrc('第一行\n\n第二行')
  assert.strictEqual(out, '[00:00.00]第一行\n[00:03.00]第二行')
  assert.strictEqual(plainToLrc(''), '')
})

test('parseSodaQrc：真实汽水歌词转标准 LRC + 逐字', () => {
  const raw = '[12270,1850]<0,330,0>穿<330,300,0>拖<630,300,0>鞋\n[15870,3090]<0,330,0>一<330,300,0>张'
  const { lyric, lxlyric } = parseSodaQrc(raw)
  assert.strictEqual(lyric, '[00:12.27]穿拖鞋\n[00:15.87]一张')
  assert.strictEqual(lxlyric.split('\n').length, 2)
  assert.ok(lxlyric.startsWith('[00:12.27]<0,330>穿<330,300>拖<630,300>鞋'))
  // 没时间轴的行直接丢弃，不生成脏歌词
  assert.strictEqual(parseSodaQrc('普通文本').lyric, '')
})
