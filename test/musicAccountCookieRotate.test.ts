/**
 * 平台账号「轮换 Cookie 被动保活」—— 纯逻辑单测
 *
 * 背景（2026-10-31）：用户追问「除了咪咕还有哪些平台需要保活」。逐个核对后结论是
 * 只有咪咕有 2 小时短期票需要主动心跳；其余七家都是长效登录态、平台也没有换票接口。
 * 但有个共通风险：平台若在响应头 Set-Cookie 里轮换了会话/设备字段，我们只存导入快照，
 * 轮换一次就永久落后。这里守的就是「接住轮换」这条链路的两个纯函数：
 *   pickRotatedFromSetCookie  从 Set-Cookie 里挑出「存储里已有字段」的新值
 *   mergeRotatedCookie        把新值并回 Cookie 串
 *
 * 收口原则：宁可漏接，也绝不能写坏账号。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickRotatedFromSetCookie, mergeRotatedCookie } from '../src/server/musicAccount/http'

test('pickRotatedFromSetCookie：只收「存储里已存在」的字段，平台新加的埋点字段不进串', () => {
  const current = { MUSIC_U: 'old', __csrf: 'cs', NMTID: 'n1' }
  const picked = pickRotatedFromSetCookie(
    ['MUSIC_U=newu; Path=/; Domain=.music.163.com', 'AB_TRACK=xyz; Path=/', 'NMTID=n2; Path=/'],
    current,
  )
  assert.deepEqual(picked, { MUSIC_U: 'newu', NMTID: 'n2' }, '未知字段 AB_TRACK 必须被丢掉')
})

test('pickRotatedFromSetCookie：Max-Age=0 是删除语义，不能当成新值接住', () => {
  const current = { MUSIC_U: 'old' }
  const picked = pickRotatedFromSetCookie('MUSIC_U=; Max-Age=0; Path=/', current)
  assert.deepEqual(picked, {}, '删除指令接住就等于把账号清空')
})

test('pickRotatedFromSetCookie：空值与没有等号的属性不接', () => {
  const current = { token: 't0', userid: '1' }
  assert.deepEqual(pickRotatedFromSetCookie('token=; Path=/', current), {})
  assert.deepEqual(pickRotatedFromSetCookie('Secure; HttpOnly', current), {})
  assert.deepEqual(pickRotatedFromSetCookie(undefined, current), {})
})

test('pickRotatedFromSetCookie：单条字符串与数组两种形态都要兼容（needle 行为不一致）', () => {
  const current = { kw_token: 'k0' }
  assert.deepEqual(pickRotatedFromSetCookie('kw_token=k1; Path=/', current), { kw_token: 'k1' })
})

test('pickRotatedFromSetCookie：值没变时不算轮换（否则每次取链都会无谓写库）', () => {
  const current = { MUSIC_U: 'same', __csrf: 'cs' }
  assert.deepEqual(pickRotatedFromSetCookie('MUSIC_U=same; Path=/', current), {})
})

test('mergeRotatedCookie：只替换值，字段顺序与其余字段原样保留', () => {
  const cookie = 'MUSIC_U=old; __csrf=cs; NMTID=n1'
  const merged = mergeRotatedCookie(cookie, { MUSIC_U: 'newu' })
  assert.equal(merged, 'MUSIC_U=newu; __csrf=cs; NMTID=n1', '顺序变了会让部分平台的签名校验失败')
})

test('mergeRotatedCookie：值里的等号不能被当成分隔符截断', () => {
  const cookie = 'qm_keyst=abc==; uin=o123'
  const merged = mergeRotatedCookie(cookie, { qm_keyst: 'xyz==' })
  assert.equal(merged, 'qm_keyst=xyz==; uin=o123')
})

test('mergeRotatedCookie：没有实际变化时原样返回（避免无谓落库）', () => {
  const cookie = 'MUSIC_U=old; __csrf=cs'
  assert.equal(mergeRotatedCookie(cookie, { MUSIC_U: 'old' }), cookie)
  assert.equal(mergeRotatedCookie(cookie, {}), cookie)
})

test('mergeRotatedCookie：原串带空格风格的能保持', () => {
  const merged = mergeRotatedCookie('a=1; b=2', { b: '3' })
  assert.equal(merged, 'a=1; b=3')
})
