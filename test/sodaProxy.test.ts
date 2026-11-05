/**
 * sodaProxy（取链代理客户端）自测 —— 用 `tsx --test test/sodaProxy.test.ts` 运行。
 *
 * 为什么单独测它：代理通道是「唯一能拿到整曲 + spade_a」的通道，一旦解析写错，
 * 表现是「明明取链成功却拿不到密钥」或「明明没配代理却每首歌多等 9 秒」，
 * 两种都很难从线上日志看出来。这里用本地假服务把协议边界钉死：
 *
 *   - 未配置时**一次请求都不该发**（否则等于给每首歌加超时风险）
 *   - `fast=1` 必须带上（少它就会走 60~90 秒的搜索兜底）
 *   - `spade_a` / `vtype` 要原样透出（决定能不能解密、落地什么扩展名）
 *   - 探活失败要快速返回，不能把异常抛给取流主链路
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import * as sodaProxy from '../src/server/extraSources/sodaProxy'

interface Hit {
  path: string
  query: URLSearchParams
}

/** 起一个假的 soda-proxy，返回地址与收到的请求列表 */
async function fakeProxy(handler: (hit: Hit) => { status: number; body: any }): Promise<{
  url: string
  hits: Hit[]
  close: () => Promise<void>
}> {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    const hit = { path: u.pathname, query: u.searchParams }
    hits.push(hit)
    const out = handler(hit)
    const body = JSON.stringify(out.body)
    res.writeHead(out.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function useProxy(url: string): void {
  if (url) process.env.QISHUI_PROXY_URL = url
  else delete process.env.QISHUI_PROXY_URL
  ;(global as any).lx = { config: {} }
  sodaProxy.resetStatusCache()
}

const TRACK = '7632155073128564782'

/** 一份贴近真实的响应：三档，含一档 lossless，一档非法 URL 应被丢弃 */
function sampleBody() {
  return {
    ok: true,
    trackId: TRACK,
    name: '花鸦',
    duration: 151.706,
    source: 'queue-cache',
    streams: [
      { quality: 'medium', bitrate: 132000, size: 2500000, main_url: 'https://v1.example/a.m4a', spade_a: 'K1', encrypt: true, kid: 'k1', vtype: 'm4a' },
      { quality: 'lossless', bitrate: 852000, size: 4935867, main_url: 'https://v3.example/c.flac', spade_a: 'K3', encrypt: true, kid: 'k3', vtype: 'flac' },
      { quality: 'highest', bitrate: 260285, size: 3800000, main_url: '', spade_a: 'KX', encrypt: true, kid: 'kx', vtype: 'm4a' },
    ],
  }
}

test('未配置代理时一次请求都不发，结果为空', async () => {
  const p = await fakeProxy(() => ({ status: 200, body: { ok: true } }))
  try {
    useProxy(p.url)
    useProxy('') // 清掉配置
    assert.equal(sodaProxy.isConfigured(), false)
    const r = await sodaProxy.resolveStreams(TRACK, { name: '花鸦', fast: true })
    assert.equal(r.ok, false)
    assert.match(r.error, /未配置/)
    assert.equal(p.hits.length, 0, '未配置时不应该打任何请求')
  } finally {
    await p.close()
  }
})

test('命中队列：带 fast=1 与 name，streams 按码率降序且丢弃非法 URL', async () => {
  const p = await fakeProxy(hit => {
    if (hit.path === '/health') return { status: 200, body: { ok: true, service: 'soda-proxy' } }
    return { status: 200, body: sampleBody() }
  })
  try {
    useProxy(p.url)
    assert.equal(sodaProxy.isConfigured(), true)
    const r = await sodaProxy.resolveStreams(TRACK, { name: '花鸦', fast: true })
    assert.equal(r.ok, true)
    assert.equal(r.name, '花鸦')
    assert.equal(r.duration, 151.706)
    assert.equal(r.source, 'queue-cache')

    // 空 main_url 的那档必须被丢掉
    assert.equal(r.streams.length, 2)
    assert.deepEqual(r.streams.map(s => s.quality), ['lossless', 'medium'])
    assert.equal(r.streams[0].spadeA, 'K3')
    assert.equal(r.streams[0].vtype, 'flac')
    assert.equal(r.streams[0].encrypt, true)

    const track = p.hits.find(h => h.path === `/track/${TRACK}`)
    assert.ok(track, '必须请求 /track/<id>')
    assert.equal(track!.query.get('fast'), '1', '主链路必须带 fast=1，否则会走 60~90 秒搜索兜底')
    assert.equal(track!.query.get('name'), '花鸦')
    assert.ok(Number(track!.query.get('timeout')) > 0, '要带预算让代理侧自己收手')
  } finally {
    await p.close()
  }
})

test('队列未命中（404）时有明确 error，不抛异常', async () => {
  const p = await fakeProxy(hit => {
    if (hit.path === '/health') return { status: 200, body: { ok: true } }
    return { status: 404, body: { ok: false, trackId: TRACK, error: '队列未命中（fast=1，不做搜索兜底）' } }
  })
  try {
    useProxy(p.url)
    const r = await sodaProxy.resolveStreams(TRACK, { name: '花鸦', fast: true })
    assert.equal(r.ok, false)
    assert.match(r.error, /队列未命中/)
    assert.equal(r.streams.length, 0)
  } finally {
    await p.close()
  }
})

test('返回 ok 但 streams 全非法时判为失败', async () => {
  const p = await fakeProxy(hit => {
    if (hit.path === '/health') return { status: 200, body: { ok: true } }
    return { status: 200, body: { ok: true, streams: [{ quality: 'lossless', main_url: 'ftp://x' }] } }
  })
  try {
    useProxy(p.url)
    const r = await sodaProxy.resolveStreams(TRACK, { fast: true })
    assert.equal(r.ok, false)
    assert.match(r.error, /video_list/)
  } finally {
    await p.close()
  }
})

test('服务不可达：探活判离线，取链返回 error 而不是抛出', async () => {
  const p = await fakeProxy(() => ({ status: 200, body: { ok: true } }))
  const url = p.url
  await p.close() // 端口关掉，模拟设备/服务掉线

  useProxy(url)
  const st = await sodaProxy.status(true)
  assert.equal(st.configured, true)
  assert.equal(st.online, false)
  assert.match(st.message, /不可达/)

  const r = await sodaProxy.resolveStreams(TRACK, { fast: true })
  assert.equal(r.ok, false)
  assert.ok(r.error.length > 0)
})

test('后台预热走慢路径（不带 fast=1），且 3 分钟内不重复触发', async () => {
  let resolveSlow: (() => void) | null = null
  const slowArrived = new Promise<void>(resolve => { resolveSlow = resolve })
  const p = await fakeProxy(hit => {
    if (hit.path === '/health') return { status: 200, body: { ok: true } }
    if (!hit.query.get('fast') && resolveSlow) {
      resolveSlow()
      resolveSlow = null
    }
    return { status: 200, body: { ...sampleBody(), source: 'search' } }
  })
  try {
    useProxy(p.url)
    sodaProxy.warmUp(TRACK, '花鸦')
    await slowArrived
    sodaProxy.warmUp(TRACK, '花鸦') // 去重窗口内，不该再发
    await new Promise(r => setTimeout(r, 150))

    const tracks = p.hits.filter(h => h.path === `/track/${TRACK}`)
    assert.equal(tracks.length, 1, '同一首在去重窗口内只预热一次')
    assert.equal(tracks[0].query.get('fast'), null, '预热必须走慢路径')
    assert.equal(sodaProxy.isWarming(TRACK), true)
  } finally {
    await p.close()
  }
})
