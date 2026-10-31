/**
 * 前端「点作者 → 进歌手主页」的纯逻辑用例。
 *
 * public/music/app.js 是浏览器脚本，不能直接 import。这里把它里面
 * 「按名字反查歌手 id」那一段原样切出来，放进 vm 里跑：
 *   - 同平台歌手搜索，只认名字对得上的那条；
 *   - 名字不是完全相同但明显是同一个（包含关系）也认；
 *   - 对不上就返回 null（调用方会退化成「歌手」类型的搜索）；
 *   - 同一个歌手点第二次不再发请求（内存缓存）。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert'
import vm from 'node:vm'

const appSource = readFileSync('public/music/app.js', 'utf8')

const sliceByMarkers = (startMarker: string, endMarker: string): string => {
  const start = appSource.indexOf(startMarker)
  const end = appSource.indexOf(endMarker)
  assert.ok(start > 0, `找不到起点标记：${startMarker}`)
  assert.ok(end > start, `找不到终点标记：${endMarker}`)
  return appSource.slice(start, end)
}

type FetchCall = { url: string }

function buildResolver(payloads: any[]): {
  resolve: (name: string, source: string) => Promise<any>
  calls: FetchCall[]
} {
  const code = sliceByMarkers('const ARTIST_DETAIL_SOURCES', '/** 打开一首歌的作者')
  const calls: FetchCall[] = []
  const sandbox: any = {
    API_BASE: '/api/music',
    console,
    fetch: async (url: string) => {
      calls.push({ url })
      const payload = payloads[Math.min(calls.length - 1, payloads.length - 1)]
      return { ok: true, json: async () => payload }
    },
  }
  // 变量与函数都挂到同一个 vm 上下文里，最后把 resolveArtistId 导出来
  vm.createContext(sandbox)
  vm.runInContext(`${code}\n;globalThis.__resolveArtistId = resolveArtistId;`, sandbox)
  return { resolve: sandbox.__resolveArtistId, calls }
}

test('名字完全一致 → 拿到歌手 id', async () => {
  const { resolve, calls } = buildResolver([
    { list: [{ id: '182387562', name: '日系少男吆西君' }, { id: '356556830', name: '少吆' }] },
  ])
  const hit = await resolve('少吆', 'bili')
  assert.deepEqual(hit, { id: '356556830', name: '少吆' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /type=singer/)
  assert.match(calls[0].url, /source=bili/)
})

test('包含关系（少吆 vs 少吆Official）也认', async () => {
  const { resolve } = buildResolver([{ list: [{ id: '9001', name: '少吆Official' }] }])
  const hit = await resolve('少吆', 'wy')
  assert.deepEqual(hit, { id: '9001', name: '少吆Official' })
})

test('名字对不上 → null，调用方退化成歌手搜索', async () => {
  const { resolve } = buildResolver([{ list: [{ id: '1', name: '完全无关的人' }] }])
  assert.equal(await resolve('少吆', 'wy'), null)
})

test('结果缓存：同一个歌手第二次点击不再请求', async () => {
  const { resolve, calls } = buildResolver([{ list: [{ id: '42', name: '晴天娃娃' }] }])
  await resolve('晴天娃娃', 'kg')
  await resolve('晴天 娃娃', 'kg') // 归一化后同一个 key
  assert.equal(calls.length, 1)
})

test('不支持歌手维度的源直接返回 null，不发请求', async () => {
  const { resolve, calls } = buildResolver([{ list: [] }])
  assert.equal(await resolve('少吆', 'local'), null)
  assert.equal(calls.length, 0)
})

test('接口报错时安静返回 null', async () => {
  const code = sliceByMarkers('const ARTIST_DETAIL_SOURCES', '/** 打开一首歌的作者')
  const sandbox: any = {
    API_BASE: '/api/music',
    console,
    fetch: async () => { throw new Error('network down') },
  }
  vm.createContext(sandbox)
  vm.runInContext(`${code}\n;globalThis.__resolveArtistId = resolveArtistId;`, sandbox)
  assert.equal(await sandbox.__resolveArtistId('少吆', 'bili'), null)
})
