import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * /api/music/url 的并发合并键、/api/music/search 的条数上限都是纯逻辑，
 * 按现有做法「切片 + vm」从 server.ts 里拉出来跑用例（这两个文件没有更细的模块划分）。
 * 切出来的片段带 TS 类型注解，vm 只吃 JS，先按「类型注解」这个唯一的 TS 语法把注解抹掉
 * （typescript 7.x 的包不再导出 transpileModule，不能指望它做这层转换）。
 */
const root = path.resolve(import.meta.dirname, '..')
const src = fs.readFileSync(path.join(root, 'src/server/server.ts'), 'utf8')

const slice = (from: string, to: string): string => {
  const start = src.indexOf(from)
  const end = src.indexOf(to, start + from.length)
  assert.ok(start >= 0, `切片起点没找到：${from}`)
  assert.ok(end > start, `切片终点没找到：${to}`)
  return src.slice(start, end)
}

const raw = slice('const buildMusicUrlFlightKey', 'const readMusicUrlFailure')
// const 声明是词法作用域，不会自动挂到 vm 的全局对象上，手动导出一下
const js = raw.replace(/:\s*(any|string|number|boolean)\b/g, '')
  + '\nglobalThis.buildMusicUrlFlightKey = buildMusicUrlFlightKey'
  + '\nglobalThis.clampSearchMaxItems = clampSearchMaxItems'

const sandbox: any = { console, Math, String, Number, Array, Object, JSON }
vm.createContext(sandbox)
vm.runInContext(js, sandbox)

const { buildMusicUrlFlightKey, clampSearchMaxItems } = sandbox

const payload = (over: any = {}) => ({
  songInfo: {
    name: '苦咖啡·唯一',
    singer: '某某',
    source: 'soda',
    songmid: 'abc123',
    ...(over.songInfo || {}),
  },
  quality: '320k',
  ...over,
})

test('flightKey：同一首歌、同用户、同音质 → 键完全一致（可以合并）', () => {
  assert.equal(buildMusicUrlFlightKey(payload(), 'alice'), buildMusicUrlFlightKey(payload(), 'alice'))
})

test('flightKey：排除清单顺序不同也要合并（否则日志里两条重试永远撞不上）', () => {
  const a = payload({ excludeApiSources: ['汽水音乐', 'bili', '网易云'] })
  const b = payload({ excludeApiSources: ['网易云', '汽水音乐', 'bili'] })
  assert.equal(buildMusicUrlFlightKey(a, 'alice'), buildMusicUrlFlightKey(b, 'alice'))
})

test('flightKey：排除清单内容不同不能合并（带排除的是重试，语义不同）', () => {
  const a = payload({ excludeApiSources: ['汽水音乐'] })
  const b = payload({ excludeApiSources: ['汽水音乐', 'bili'] })
  assert.notEqual(buildMusicUrlFlightKey(a, 'alice'), buildMusicUrlFlightKey(b, 'alice'))
})

test('flightKey：noCache / 音质 / 用户不同都不能合并', () => {
  const base = buildMusicUrlFlightKey(payload(), 'alice')
  assert.notEqual(base, buildMusicUrlFlightKey(payload({ noCache: true }), 'alice'))
  assert.notEqual(base, buildMusicUrlFlightKey(payload({ quality: '128k' }), 'alice'))
  assert.notEqual(base, buildMusicUrlFlightKey(payload(), 'bob'))
})

test('flightKey：拿不到曲 ID 时返回空串 —— 宁可各走一遍，也不把无名请求撮到一起', () => {
  const noId = payload({ songInfo: { songmid: '', id: '', hash: '' } })
  assert.equal(buildMusicUrlFlightKey(noId, 'alice'), '')
  assert.equal(buildMusicUrlFlightKey({}, 'alice'), '')
  assert.equal(buildMusicUrlFlightKey(null, 'alice'), '')
})

test('flightKey：id 字段优先取 songmid，其次 id/hash', () => {
  const k1 = buildMusicUrlFlightKey(payload(), 'alice')
  const k2 = buildMusicUrlFlightKey(payload({ songInfo: { source: 'soda', songmid: undefined, id: 'abc123' } }), 'alice')
  assert.equal(k1, k2, 'songmid 与 id 指向同一首时必须合并')
})

test('maxItems：不传 / 0 / 非数字 → 默认 1200（单平台搜索行为不变）', () => {
  assert.equal(clampSearchMaxItems(undefined), 1200)
  assert.equal(clampSearchMaxItems(null), 1200)
  assert.equal(clampSearchMaxItems(''), 1200)
  assert.equal(clampSearchMaxItems('0'), 1200)
  assert.equal(clampSearchMaxItems('abc'), 1200)
  assert.equal(clampSearchMaxItems('-5'), 1200)
})

test('maxItems：正常值原样返回，上下限夹紧', () => {
  assert.equal(clampSearchMaxItems('300'), 300)
  assert.equal(clampSearchMaxItems(300), 300)
  assert.equal(clampSearchMaxItems('300.7'), 301)
  assert.equal(clampSearchMaxItems('10'), 50, '下限 50：聚合搜索每源至少也要够一屏')
  assert.equal(clampSearchMaxItems('5000'), 1200, '上限 1200：不能比原来的全量口径还大')
})
