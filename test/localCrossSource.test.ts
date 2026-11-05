import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * 跨平台本地命中（换源第 0 档）是纯前端逻辑（public/music/app.js 的 pickLocalCachedCandidate），
 * 依赖缓存索引的 key 是 `source_原生ID` —— 本地有网易版本、从汽水点播时按 key 永远查不到，
 * 于是明明硬盘上有文件还要全网搜 + 取链（实测 4~7 秒）。
 *
 * 这里按「切片 + vm 求值」把判定逻辑拉出来跑用例，重点是**版本错配不能命中**：
 * 本地是 Live/伴奏、用户点的是原曲，宁可不命中也不能播错版本。
 */
const root = path.resolve(import.meta.dirname, '..')
const src = fs.readFileSync(path.join(root, 'public/music/app.js'), 'utf8')

const slice = (from: string, to: string): string => {
  const start = src.lastIndexOf(from)
  const end = src.indexOf(to, start + from.length)
  assert.ok(start >= 0, `切片起点没找到：${from}`)
  assert.ok(end > start, `切片终点没找到：${to}`)
  return src.slice(start, end)
}

const code = [
  // normalizeSongMatchText / isSingerMatch / VERSION_WORD_RE / isVersionMismatch / getSongMatchScore
  slice('function normalizeSongMatchText', 'function getSongDurationDiff'),
  // timeToSeconds 等时间工具
  slice('function timeToSeconds', 'function getSourceName'),
  // 被测函数本体
  slice('async function pickLocalCachedCandidate', 'async function findOtherSourceMatch'),
].join('\n')

/** 构造沙箱：ServerFileState 与 checkServerCache 都是可注入的桩 */
const buildSandbox = (entries: any[], cacheTable: Record<string, any> = {}) => {
  const sandbox: any = {
    console: { log() {}, warn() {}, info() {}, error() {} },
    Map, Set, Date, Math, String, Number, Array, Object, JSON, RegExp, Promise, parseInt, parseFloat, isNaN,
    window: {
      ServerFileState: {
        ensure: async () => true,
        all: () => entries,
      },
    },
    // 服务端 /api/music/cache/check 的桩：按 `source_原生ID` 给出结果
    checkServerCache: async (song: any) => {
      const key = `${song.source}_${song.songmid || song.id}`
      return cacheTable[key] || { exists: false }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return sandbox
}

const cachedItem = (over: any = {}) => ({
  id: 'wy_1955',
  songmid: '1955',
  source: 'wy',
  name: '晴天',
  singer: '周杰伦',
  interval: '04:29',
  quality: '320k',
  folder: 'cache',
  ...over,
})

// 用户从汽水歌单点这首歌；本地其实早就缓存过网易版本
const sodaSong = { source: 'soda', id: '7129', name: '晴天', singer: '周杰伦', interval: '04:29' }

test('本地有其它平台的同曲 → 命中，返回该条目自己的 source/id 与真实地址', async () => {
  const sb = buildSandbox(
    [cachedItem()],
    { wy_1955: { exists: true, url: '/api/music/cache/file/cache/%E6%99%B4%E5%A4%A9.mp3', quality: '320k', folder: 'cache' } },
  )
  const hit = await sb.pickLocalCachedCandidate(sodaSong)
  assert.ok(hit, '应该命中本地');
  assert.equal(hit.source, 'wy', '要换成缓存条目自己的平台，而不是沿用 soda');
  assert.equal(hit.songmid, '1955');
  assert.equal(hit.isLocal, true);
  assert.equal(hit._localHit, true);
  assert.equal(hit._tier, 0);
  assert.match(hit.url, /\/api\/music\/cache\/file\//);
})

test('本地是 Live 版、点的是原曲 → 不命中（版本错配必须拦住）', async () => {
  const sb = buildSandbox(
    [cachedItem({ name: '晴天 (Live)', interval: '04:32' })],
    { wy_1955: { exists: true, url: '/x.mp3', quality: '320k' } },
  )
  const hit = await sb.pickLocalCachedCandidate(sodaSong)
  assert.equal(hit, null)
})

test('本地是伴奏版 → 不命中', async () => {
  const sb = buildSandbox(
    [cachedItem({ name: '晴天 (伴奏)', interval: '04:29' })],
    { wy_1955: { exists: true, url: '/x.mp3', quality: '320k' } },
  )
  assert.equal(await sb.pickLocalCachedCandidate(sodaSong), null)
})

test('同名不同歌手 → 不命中（宁可不命中也不播错歌）', async () => {
  const sb = buildSandbox(
    [cachedItem({ singer: '某翻唱组合' })],
    { wy_1955: { exists: true, url: '/x.mp3', quality: '320k' } },
  )
  assert.equal(await sb.pickLocalCachedCandidate(sodaSong), null)
})

test('时长差超过 8 秒 → 不命中', async () => {
  const sb = buildSandbox(
    [cachedItem({ interval: '05:10' })],
    { wy_1955: { exists: true, url: '/x.mp3', quality: '320k' } },
  )
  assert.equal(await sb.pickLocalCachedCandidate(sodaSong), null)
})

test('条目在索引里但文件已不在（checkServerCache exists=false）→ 不命中', async () => {
  const sb = buildSandbox([cachedItem()], {})
  assert.equal(await sb.pickLocalCachedCandidate(sodaSong), null)
})

test('checkServerCache 判定为命名冲突 → 不命中', async () => {
  const sb = buildSandbox(
    [cachedItem()],
    { wy_1955: { exists: true, url: '/x.mp3', isCollision: true } },
  )
  assert.equal(await sb.pickLocalCachedCandidate(sodaSong), null)
})

test('本地只有 128k、偏好 320k → 仍命中，且音质如实回报（不谎报 320k）', async () => {
  const sb = buildSandbox(
    [cachedItem({ quality: '128k' })],
    { wy_1955: { exists: true, url: '/x.mp3', quality: '128k', folder: 'cache' } },
  )
  const hit = await sb.pickLocalCachedCandidate(sodaSong)
  assert.ok(hit)
  assert.equal(hit.quality, '128k')
})

test('同分时下载目录优先于缓存目录（缓存会被清理）', async () => {
  const sb = buildSandbox(
    [
      cachedItem({ songmid: '111', quality: '128k', folder: 'cache' }),
      cachedItem({ songmid: '222', quality: '128k', folder: 'music' }),
    ],
    {
      wy_111: { exists: true, url: '/cache.mp3', quality: '128k', folder: 'cache' },
      wy_222: { exists: true, url: '/music.mp3', quality: '128k', folder: 'music' },
    },
  )
  const hit = await sb.pickLocalCachedCandidate(sodaSong)
  assert.ok(hit)
  assert.equal(hit.songmid, '222', '应优先用 music 目录那份')
  assert.match(hit.url, /music\.mp3/)
})

test('完全没有本地条目 → 不命中（不影响后续全网搜索）', async () => {
  const sb = buildSandbox([])
  assert.equal(await sb.pickLocalCachedCandidate(sodaSong), null)
})

test('歌曲缺歌手名 → 直接不命中（换源主体要求 name+singer）', async () => {
  const sb = buildSandbox([cachedItem()], { wy_1955: { exists: true, url: '/x.mp3' } })
  assert.equal(await sb.pickLocalCachedCandidate({ source: 'soda', id: '1', name: '晴天' }), null)
})
