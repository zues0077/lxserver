import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 聚合搜索（渐进渲染 / 结果缓存 / 收尾只画一次）的回归用例。
 *
 * 这几段逻辑全在 `public/music/app.js` 的 doSearch 里，没有独立模块可 import，
 * 所以按现有做法「切片 + 桩 DOM」把真实代码拉出来跑：切的是文件里的原文，
 * 产品代码一改这里立刻会红。
 */
const root = path.resolve(import.meta.dirname, '..')
const src = fs.readFileSync(path.join(root, 'public/music/app.js'), 'utf8')

const cut = (from: string, to: string): string => {
  const start = src.indexOf(from)
  const end = src.indexOf(to, start + from.length)
  assert.ok(start >= 0, `切片起点没找到：${from}`)
  assert.ok(end > start, `切片终点没找到：${to}`)
  return src.slice(start, end)
}

// findScrollParent 在模块作用域里直接用 document / getComputedStyle，
// readSearchCache 用 Date.now() —— 都注入不到内层函数，只能改写成持有者访问。
const prelude = cut('/** 同一关键词 60 秒内再搜一次直接复用上次结果', '//搜索歌曲')
  .replace(/\bgetComputedStyle\b/g, '__dom.getComputedStyle')
  .replace(/\bdocument\b/g, '__dom.document')

let agg = cut(
  'const cacheKey = searchCacheKey(type, source, input);',
  "        } else {\n            if (pageInfoEl && type === 'song')",
)
// searchSeq 是模块级 let，替换成持有物后才能模拟「搜索途中又搜了别的词」
agg = agg.replace(/\bsearchSeq\b/g, '__seq.seq')

const factorySrc = `
${prelude}
return async function (input, type, source, pageInfoEl, document, window, fetch,
                      renderResults, rememberAggregatedResults, SOURCES, API_BASE, headers,
                      currentPage, mySeq, __seq, Date, setTimeout, clearTimeout, encodeURIComponent, console) {
${agg}
}
`

const INNER = ['input', 'type', 'source', 'pageInfoEl', 'document', 'window', 'fetch',
  'renderResults', 'rememberAggregatedResults', 'SOURCES', 'API_BASE', 'headers', 'currentPage',
  'mySeq', '__seq', 'Date', 'setTimeout', 'clearTimeout', 'encodeURIComponent', 'console']

const __dom: any = {}
const runner: any = new Function('AGGREGATE_MAX_ITEMS', 'SEARCH_PAINT_INTERVAL_MS', '__dom', factorySrc)(300, 200, __dom)

const SOURCES = ['kw', 'kg', 'tx', 'wy']
const API_BASE = '/api/music'

/** 桩 DOM：只需要 search-results（挂一个可滚动的父节点）和 page-info */
function makeEnv(scrollTop = 0) {
  const scroller: any = { scrollTop, parentElement: null, style: { overflowY: 'auto' } }
  const results: any = { innerHTML: '', parentElement: scroller }
  const pageInfo: any = { innerText: '' }
  const document = {
    body: { parentElement: null },
    documentElement: { parentElement: null },
    getElementById: (id: string) => (id === 'search-results' ? results : id === 'page-info' ? pageInfo : null),
  }
  const win: any = { savedNetworkSearchState: null, sortSearchResults: (l: any[]) => l.slice() }
  return { document, win, results, pageInfo, scroller }
}

/** 桩 fetch：按源给不同延迟，模拟「谁先回来谁先渲染」 */
function makeFetch(delays: Record<string, number>, calls: string[]) {
  return async (url: string) => {
    calls.push(url)
    const source = /source=(\w+)/.exec(url)?.[1] || ''
    const delay = delays[source] ?? 5
    await new Promise(r => setTimeout(r, delay))
    const list = [
      { name: `${source}-song-1`, singer: 'x', source },
      { name: `${source}-song-2`, singer: 'y', source },
    ]
    return { ok: true, status: 200, json: async () => ({ list }) }
  }
}

interface RunOpts {
  keyword: string
  delays?: Record<string, number>
  scrollTop?: number
  mySeq?: number
}

function runSearch(opts: RunOpts) {
  const env = makeEnv(opts.scrollTop ?? 0)
  const calls: string[] = []
  const renders: Array<{ len: number; msg: string }> = []
  __dom.document = env.document
  __dom.getComputedStyle = (el: any) => ({ overflowY: el && el.scrollTop !== undefined ? 'auto' : 'visible' })
  const t0 = Date.now()
  const p = runner.call(
    null,
    opts.keyword, 'song', 'all', env.pageInfo, env.document, env.win,
    makeFetch(opts.delays ?? {}, calls),
    (list: any[]) => { renders.push({ len: list.length, msg: env.pageInfo.innerText }) },
    () => { },
    SOURCES, API_BASE, {}, 1, opts.mySeq ?? 1, { seq: opts.mySeq ?? 1 },
    Date, setTimeout, clearTimeout, encodeURIComponent, console,
  )
  return { promise: p, env, calls, renders, elapsed: () => Date.now() - t0 }
}

test('聚合搜索：8 个源并发，先回来的先渲染，不等最慢的', async () => {
  const r = runSearch({ keyword: '渐进渲染-甲', delays: { kw: 5, kg: 40, tx: 120, wy: 350 } })
  await r.promise
  assert.equal(r.calls.length, SOURCES.length)
  // 每个源都带上了 maxItems=300（载荷瘦身）
  assert.ok(r.calls.every(u => u.includes('maxItems=300')), '每个源都应带 maxItems=300')
  // 首屏必须早于「最后一个源到齐」，否则等于还是 Promise.all 干等
  assert.ok(r.renders.length >= 2, `渐进渲染至少要出两批，实际 ${r.renders.length} 次`)
  const firstLen = r.renders[0].len
  const finalLen = r.renders[r.renders.length - 1].len
  assert.ok(firstLen < finalLen, `首批 ${firstLen} 条应少于最终 ${finalLen} 条`)
  assert.equal(finalLen, SOURCES.length * 2)
})

test('聚合搜索：收尾只做一次全量重绘（不能 schedulePaint(true) 之后再 paint(true) 重画一遍）', async () => {
  const r = runSearch({ keyword: '收尾去重-乙', delays: { kw: 5, kg: 30, tx: 60, wy: 150 } })
  await r.promise
  const total = SOURCES.length * 2
  const fullRenders = r.renders.filter(x => x.len === total).length
  assert.equal(fullRenders, 1, `最终全量渲染应只有 1 次，实际 ${fullRenders} 次（重复渲染会白白重排上千条）`)
  // 最后一次渲染拿到的就是全量
  assert.equal(r.renders[r.renders.length - 1].len, total)
})

test('聚合搜索：同一关键词 60 秒内再搜直接复用，不再发请求', async () => {
  const first = runSearch({ keyword: '缓存命中-丙' })
  await first.promise
  assert.equal(first.calls.length, SOURCES.length)

  const second = runSearch({ keyword: '  缓存命中-丙  ' })
  await second.promise
  assert.equal(second.calls.length, 0, '第二次搜索不应再打任何请求')
  assert.match(second.env.pageInfo.innerText, /复用/)
  assert.equal(second.renders.length, 1)
  assert.equal(second.renders[0].len, SOURCES.length * 2)
})

test('聚合搜索：用户已经往下滚了就不再流式重排，只在收尾重排一次', async () => {
  const r = runSearch({ keyword: '滚动保持-丁', scrollTop: 600, delays: { kw: 5, kg: 20, tx: 40, wy: 120 } })
  await r.promise
  assert.equal(r.renders.length, 1, `滚动中应只重排 1 次，实际 ${r.renders.length} 次`)
  assert.equal(r.renders[0].len, SOURCES.length * 2)
})

test('聚合搜索：旧搜索的慢请求回来时不改写新搜索的结果', async () => {
  const seq = { seq: 1 }
  const env = makeEnv(0)
  const renders: any[] = []
  const calls: string[] = []
  __dom.document = env.document
  __dom.getComputedStyle = () => ({ overflowY: 'auto' })
  const p = runner.call(
    null, '序号守卫-戊', 'song', 'all', env.pageInfo, env.document, env.win,
    makeFetch({ kw: 5, kg: 40, tx: 80, wy: 400 }, calls),
    (list: any[]) => { renders.push(list.length) },
    () => { }, SOURCES, API_BASE, {}, 1, 1, seq, Date, setTimeout, clearTimeout, encodeURIComponent, console,
  )
  await new Promise(r => setTimeout(r, 120))
  const before = renders.length
  seq.seq += 1 // 用户此刻搜了别的词
  await p
  assert.equal(renders.length, before, '序号变了之后旧请求不应再渲染')
})
