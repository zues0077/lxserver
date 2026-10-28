/**
 * 平台账号健康度：状态分级 + 失效关键词判据。
 *
 * 这一层是纯函数，测试重点不是「跑通」，而是**别误报**：
 * 把「该曲无版权」误判成「账号失效」，用户会去重导一个本来完好的 Cookie，
 * 比不提示更糟。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  STALE_AFTER_DAYS,
  classifyHealth,
  looksLikeAuthFailure,
  summarize,
} from '../src/server/musicAccount/health'

const HOUR = 3600_000
const now = Date.UTC(2026, 9, 28, 12, 0, 0)

test('classifyHealth：没配置 / 没校验过', () => {
  assert.equal(classifyHealth(false, null, now).health, 'none')
  assert.equal(classifyHealth(true, null, now).health, 'unchecked')
  assert.equal(classifyHealth(true, null, now).ageHours, null)
})

test('classifyHealth：在线校验失败 = 已失效；结构校验失败 = 待确认（不是过期）', () => {
  const expired = classifyHealth(true, { at: now - HOUR, ok: false, verified: 'online' }, now)
  assert.equal(expired.health, 'expired')
  assert.equal(expired.text, '已失效')

  // 结构校验没过多半是平台换了字段名或压根没登录，标红会误导
  const structural = classifyHealth(true, { at: now - HOUR, ok: false, verified: 'structural' }, now)
  assert.equal(structural.health, 'structural')
  assert.notEqual(structural.text, '已失效')
})

test('classifyHealth：新鲜的绿灯是 ok，过期的绿灯降级为待复查', () => {
  const fresh = classifyHealth(true, { at: now - 3 * HOUR, ok: true, verified: 'online' }, now)
  assert.equal(fresh.health, 'ok')
  assert.equal(fresh.ageHours, 3)

  const stale = classifyHealth(true, { at: now - (STALE_AFTER_DAYS + 1) * 24 * HOUR, ok: true, verified: 'online' }, now)
  assert.equal(stale.health, 'stale')
  assert.equal(stale.text, '待复查')
})

test('classifyHealth：只做结构校验通过的平台不冒充「已登录」', () => {
  const r = classifyHealth(true, { at: now - HOUR, ok: true, verified: 'structural' }, now)
  assert.equal(r.health, 'ok')
  assert.equal(r.text, '结构校验通过')
})

test('looksLikeAuthFailure：登录态失效的常见说法都要命中', () => {
  const yes = [
    '未登录',
    '登录态已失效，请重新登录',
    'Cookie 已失效（/luna/pc/me 没有返回账号信息），请重新登录',
    'cookie 无效',
    'token 已过期',
    '鉴权失败：401',
    'HTTP 403 Forbidden',
    'Unauthorized',
    'not logged in',
    'login required',
    'session expired',
  ]
  for (const msg of yes) {
    assert.equal(looksLikeAuthFailure(msg), true, `应判定为登录失败：${msg}`)
  }
})

test('looksLikeAuthFailure：正常取链失败不能被误判成账号失效', () => {
  const no = [
    '',
    undefined,
    '该曲目无版权，平台未返回播放地址',
    '需要会员权益才能播放',
    '连接被拒绝',
    'ETIMEDOUT',
    '未找到支持 soda 平台的自定义源',
    '签名器返回的是 CENC 加密流且无密钥',
    '只拿到 60 秒试听片段',
  ]
  for (const msg of no) {
    assert.equal(looksLikeAuthFailure(msg as any), false, `不应判定为登录失败：${String(msg)}`)
  }
})

test('summarize：汇总数出失效平台名，并给出一句话提示', () => {
  const s = summarize([
    { name: '网易云', configured: true, health: 'ok' },
    { name: 'QQ音乐', configured: true, health: 'expired' },
    { name: '酷狗', configured: true, health: 'stale' },
    { name: '汽水音乐', configured: false, health: 'none' },
  ])
  assert.equal(s.configured, 3)
  assert.equal(s.healthy, 1)
  assert.equal(s.expired, 1)
  assert.deepEqual(s.expiredNames, ['QQ音乐'])
  assert.match(s.message, /QQ音乐/)
  assert.match(s.message, /已失效/)
})

test('summarize：全部正常时不给提示语（避免常驻黄条）', () => {
  const s = summarize([
    { name: '网易云', configured: true, health: 'ok' },
    { name: 'QQ音乐', configured: false, health: 'none' },
  ])
  assert.equal(s.expired, 0)
  assert.equal(s.message, '')
})
