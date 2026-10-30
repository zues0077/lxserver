import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * 换源候选排序是纯前端逻辑（public/music/app.js），没有构建步骤，
 * 这里按「切片 + vm 求值」把它拉出来跑用例，避免为了测试去改打包结构。
 */
const root = path.resolve(import.meta.dirname, '..')
const src = fs.readFileSync(path.join(root, 'public/music/app.js'), 'utf8')

const slice = (from: string, to: string): string => {
  // 用 lastIndexOf：这个文件里 normalizeSongMatchText 等函数有「下载换源」和「自动换源」两套同名实现，
  // 我们要的是靠后那套（跟着 EXTRA_SOURCE_PLATFORMS / rankSourceCandidates 一起的）
  const start = src.lastIndexOf(from)
  const end = src.indexOf(to, start + from.length)
  assert.ok(start >= 0, `切片起点没找到：${from}`)
  assert.ok(end > start, `切片终点没找到：${to}`)
  return src.slice(start, end)
}

const code = [
  // normalizeSongMatchText / isSingerMatch / 平台序 / 会员加权 / 版本词 / 排序器 / 聚合缓存 / getSongMatchScore
  slice('function normalizeSongMatchText', 'function getSongDurationDiff'),
  slice('function timeToSeconds', 'function getSourceName'),
].join('\n')

const sandbox: any = { console, Map, Set, Date, Math, String, Number, Array, Object, JSON }
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

const { rankSourceCandidates, rememberAggregatedResults, lookupAggregatedCandidates } = sandbox

const target = { name: '晴天', singer: '周杰伦', interval: '04:29', albumName: '叶惠美', source: 'soda' }

const song = (over: any = {}) => ({
  name: '晴天',
  singer: '周杰伦',
  interval: '04:29',
  albumName: '叶惠美',
  source: 'wy',
  ...over,
})

test('rankSourceCandidates：层级压过分数（bili 高分也要排在常规平台之后）', () => {
  const out = rankSourceCandidates([
    song({ source: 'bili', name: '晴天', interval: '04:30' }),
    song({ source: 'wy', name: '晴天 周杰伦', interval: '04:35' }),
  ], target)
  assert.equal(out[0].source, 'wy', '常规平台必须排在 B 站视频音轨前面')
  assert.equal(out[1].source, 'bili')
})

test('rankSourceCandidates：soda/kglite 属于账号通道层，排在常规平台之后、B站之前', () => {
  const out = rankSourceCandidates([
    song({ source: 'bili' }),
    song({ source: 'kglite' }),
    song({ source: 'mg' }),
  ], target)
  assert.deepEqual(out.map((x: any) => x.source), ['mg', 'kglite', 'bili'])
})

test('rankSourceCandidates：Live/伴奏版本降级，哪怕时长卡在 8 秒容差内', () => {
  const out = rankSourceCandidates([
    song({ source: 'wy', name: '晴天 (Live)', interval: '04:33' }),
    song({ source: 'tx', name: '晴天', interval: '04:29' }),
  ], target)
  assert.equal(out[0].source, 'tx', '录音室版必须先试')
})

test('rankSourceCandidates：原曲本身就是 Live 时不降级', () => {
  const liveTarget = { ...target, name: '晴天 (Live)' }
  const out = rankSourceCandidates([
    song({ source: 'wy', name: '晴天 (Live)', interval: '04:33' }),
  ], liveTarget)
  assert.equal(out.length, 1)
  assert.equal(out[0]._tier, 0)
})

test('rankSourceCandidates：会员加权 +4 能翻掉 3 分以内的分差', () => {
  const candidates = [
    // tx 时长差 5 秒 → 24 分；wy 差 2 秒 → 27 分。wy 是会员时应当胜出
    song({ source: 'tx', name: '晴天', interval: '04:24' }),
    song({ source: 'wy', name: '晴天', interval: '04:27' }),
  ]
  const plain = rankSourceCandidates(candidates, target)
  assert.equal(plain[0].source, 'wy', '无会员加权时也按时长差选 wy')

  const member = rankSourceCandidates(candidates, target, { memberSources: new Set(['tx']) })
  assert.equal(member[0].source, 'tx', 'tx 会员 +4 后应压过 3 分的时长差')
})

test('rankSourceCandidates：会员加权压不过「完全同名 vs 仅包含」的 10 分差', () => {
  const out = rankSourceCandidates([
    // 会员平台只有「仅包含」的版本（曲名多了一段）
    song({ source: 'tx', name: '晴天娃娃', singer: '周杰伦', interval: '04:29' }),
    song({ source: 'wy', name: '晴天', interval: '04:29' }),
  ], target, { memberSources: new Set(['tx']) })
  assert.equal(out[0].source, 'wy', '名字完全一致的非会员平台仍要优先')
})

test('rankSourceCandidates：同分同层时按固定平台序，不依赖 sort 稳定性', () => {
  const out = rankSourceCandidates([
    song({ source: 'mg' }),
    song({ source: 'kw' }),
    song({ source: 'wy' }),
    song({ source: 'kg' }),
    song({ source: 'tx' }),
  ], target)
  assert.deepEqual(out.map((x: any) => x.source), ['wy', 'tx', 'kw', 'kg', 'mg'])
})

test('rankSourceCandidates：同一平台最多留 2 条', () => {
  const out = rankSourceCandidates([
    song({ source: 'wy', name: '晴天', interval: '04:29' }),
    song({ source: 'wy', name: '晴天', interval: '04:28', id: 'b' }),
    song({ source: 'wy', name: '晴天', interval: '04:27', id: 'c' }),
    song({ source: 'tx', name: '晴天', interval: '04:29' }),
  ], target)
  const wyCount = out.filter((x: any) => x.source === 'wy').length
  assert.equal(wyCount, 2)
  assert.equal(out.filter((x: any) => x.source === 'tx').length, 1)
})

test('rankSourceCandidates：不匹配的候选直接丢弃（负分不进池）', () => {
  const out = rankSourceCandidates([
    song({ source: 'wy', name: '稻香', singer: '周杰伦' }),
    song({ source: 'tx', name: '晴天', singer: '五月天' }),
  ], target)
  assert.equal(out.length, 0)
})

test('聚合缓存：放进来的条目能被同一首歌捞回来，且不返回原平台', () => {
  rememberAggregatedResults([
    { source: 'wy', name: '晴天', singer: '周杰伦', interval: '04:29', albumName: '叶惠美', id: 'w1' },
    { source: 'tx', name: '晴天', singer: '周杰伦', interval: '04:29', albumName: '叶惠美', id: 't1' },
    { source: 'soda', name: '晴天', singer: '周杰伦', interval: '04:29', id: 's1' },
  ])
  const found = lookupAggregatedCandidates(target)
  const sources = found.map((x: any) => x.source).sort()
  assert.deepEqual(sources, ['tx', 'wy'], '当前平台是 soda，缓存里其余平台都要能复用')
  assert.ok(found.every((x: any) => typeof x._matchScore === 'number' && x._matchScore >= 0))
})

test('聚合缓存：不相关的歌不会被捞出来', () => {
  rememberAggregatedResults([
    { source: 'wy', name: '稻香', singer: '周杰伦', interval: '03:43', id: 'x1' },
  ])
  const found = lookupAggregatedCandidates(target)
  assert.equal(found.filter((x: any) => x.name === '稻香').length, 0)
})
