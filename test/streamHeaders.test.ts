import test from 'node:test'
import assert from 'node:assert'
import { buildStreamHeaders, needsBilibiliReferer, forbidsReferer } from '../src/server/utils/streamHeaders'

test('B站直链：带 bilibili Referer', () => {
  const h = buildStreamHeaders('https://upos-sz-mirrorbd.bilivideo.com/upgcxcode/a.m4s')
  assert.equal(h.Referer, 'https://www.bilibili.com/')
})

test('B站 302 落地域名（*.v.smtcdns.com）也算 B站系，不能拿自身域名当 Referer', () => {
  const hop = 'https://ad0e4d8e.v.smtcdns.com/upos-sz-mirrorbd.bilivideo.com/upgcxcode/a.m4s'
  assert.equal(needsBilibiliReferer(hop), true)
  assert.equal(buildStreamHeaders(hop).Referer, 'https://www.bilibili.com/')
})

test('跳转链沿用首个地址的策略：落地域名不认识时也不能退回自身域名', () => {
  const hop = 'https://some-cdn.example.net/a.m4s'
  const origin = 'https://upos-sz-mirrorbd.bilivideo.com/upgcxcode/a.m4s'
  assert.equal(buildStreamHeaders(hop, {}, origin).Referer, 'https://www.bilibili.com/')
})

test('抖音系（汽水）任何一跳都不带 Referer', () => {
  const h = buildStreamHeaders('https://v3-dy-o.douyinvod.com/abc.mp4')
  assert.equal(forbidsReferer('https://v3-dy-o.douyinvod.com/abc.mp4'), true)
  assert.equal(h.Referer, undefined)
  // 抖音源 302 到别的域名时，也不能因为「首个地址不能带」就补上 Referer
  assert.equal(buildStreamHeaders('https://cdn.example.org/a.mp4', {}, 'https://v3-dy-o.douyinvod.com/abc.mp4').Referer, undefined)
})

test('普通 CDN 仍按自身域名给 Referer（保持原行为）', () => {
  const h = buildStreamHeaders('https://music.example.com/a.mp3')
  assert.equal(h.Referer, 'https://music.example.com')
})
