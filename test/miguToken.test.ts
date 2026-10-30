/**
 * 咪咕 pacmtoken 续期 —— 纯逻辑单测
 *
 * 背景（2026-10-30 实测）：咪咕的 pacmtoken 是**滚动续期**的短期票，
 * 平台每发一次请求都在响应头里给一张新的；浏览器每请求都接住，所以一直不掉线。
 * 我们以前把响应头整个丢掉，票就冻结在「导入那一刻」，固定 3 小时失效
 * （10:07:13 导入 → 13:06:24 失效，2h59m11s）。
 *
 * 这里守的就是这条链路的三个纯函数，任何一处写错都会让「续期」变成静默失败：
 *   pickPacmTokenFromHeaders  从 Set-Cookie 里取新票
 *   mergePacmToken            把新票并回 Cookie 串
 *   authHeaders               只发 pacmtoken，不拿别的字段冒充
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as migu from '../src/server/musicAccount/resolvers/migu'

test('pickPacmTokenFromHeaders：优先读独立响应头 pacmtoken（这才是续期主通道）', () => {
  // 实测依据：咪咕响应头带 Access-Control-Expose-Headers: signature,timestamp,pacmtoken。
  // Set-Cookie 在浏览器里 JS 读不到、不需要 expose；平台既然 expose 了，
  // 说明续期走的是同名响应头。只读 set-cookie 会永远取不到票。
  const got = migu.pickPacmTokenFromHeaders({
    pacmtoken: 'HDR_TOKEN',
    'set-cookie': ['pacmtoken=COOKIE_TOKEN; Path=/'],
  })
  assert.equal(got, 'HDR_TOKEN', '独立响应头存在时必须优先，否则拿到的是旧通道的值')
})

test('pickPacmTokenFromHeaders：独立响应头大小写不敏感', () => {
  assert.equal(migu.pickPacmTokenFromHeaders({ PacmToken: 'MIXED_CASE' }), 'MIXED_CASE')
  assert.equal(migu.pickPacmTokenFromHeaders({ PACMTOKEN: 'ALL_CAPS' }), 'ALL_CAPS')
})

test('pickPacmTokenFromHeaders：独立响应头为空时回退 Set-Cookie', () => {
  const got = migu.pickPacmTokenFromHeaders({
    pacmtoken: '',
    'set-cookie': ['pacmtoken=FALLBACK; Path=/'],
  })
  assert.equal(got, 'FALLBACK')
})

test('pickPacmTokenFromHeaders：从 Set-Cookie 数组里取新票', () => {
  const got = migu.pickPacmTokenFromHeaders({
    'set-cookie': [
      'mgnd_session_id=abc; Path=/',
      'pacmtoken=NEW_TOKEN_123; Path=/; HttpOnly',
      'USessionID=xx; Path=/',
    ],
  })
  assert.equal(got, 'NEW_TOKEN_123')
})

test('pickPacmTokenFromHeaders：Set-Cookie 是单个字符串时也能取', () => {
  const got = migu.pickPacmTokenFromHeaders({ 'set-cookie': 'pacmtoken=SOLO_TOKEN; Path=/' })
  assert.equal(got, 'SOLO_TOKEN')
})

test('pickPacmTokenFromHeaders：Max-Age=0 是平台在清空凭证，不能当新票使用', () => {
  const got = migu.pickPacmTokenFromHeaders({
    'set-cookie': ['pacmtoken=; Max-Age=0; Path=/', 'pacmtoken=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
  })
  assert.equal(got, '', '清空指令必须被忽略，否则会把空值写回 Cookie')
})

test('pickPacmTokenFromHeaders：没有响应头 / 没有 pacmtoken 时返回空串', () => {
  assert.equal(migu.pickPacmTokenFromHeaders(undefined), '')
  assert.equal(migu.pickPacmTokenFromHeaders({}), '')
  assert.equal(migu.pickPacmTokenFromHeaders({ 'set-cookie': ['LTToken=xxx; Path=/'] }), '')
})

test('pickPacmTokenFromHeaders：URL 编码的票要解码后再用', () => {
  const got = migu.pickPacmTokenFromHeaders({ 'set-cookie': ['pacmtoken=a%2Bb%3Dc; Path=/'] })
  assert.equal(got, 'a+b=c')
})

test('mergePacmToken：替换已有的 pacmtoken，其它字段原样保留', () => {
  const cookie = 'idmpauth=true@passport.migu.cn; pacmtoken=OLD; LTToken=LT1; migu-utoken-sessionid=U1'
  const out = migu.mergePacmToken(cookie, 'NEW')
  assert.ok(out.includes('pacmtoken=NEW'), out)
  assert.ok(!out.includes('pacmtoken=OLD'), '旧票必须被替换掉，不能两份并存')
  assert.ok(out.includes('LTToken=LT1'), '长期凭证必须原样保留，否则下次没法续期')
  assert.ok(out.includes('idmpauth=true@passport.migu.cn'))
  assert.ok(out.includes('migu-utoken-sessionid=U1'))
})

test('mergePacmToken：原本没有 pacmtoken 时追加而不是丢弃', () => {
  const out = migu.mergePacmToken('idmpauth=true@passport.migu.cn; LTToken=LT1', 'NEW')
  assert.ok(out.includes('pacmtoken=NEW'), out)
  assert.ok(out.includes('LTToken=LT1'))
})

test('mergePacmToken：空票原样返回，绝不把空值写进去', () => {
  const cookie = 'pacmtoken=OLD; LTToken=LT1'
  assert.equal(migu.mergePacmToken(cookie, ''), cookie)
})

test('mergePacmToken：重复合并同一张票是幂等的（不会堆出多个 pacmtoken）', () => {
  const once = migu.mergePacmToken('LTToken=LT1; pacmtoken=OLD', 'NEW')
  const twice = migu.mergePacmToken(once, 'NEW')
  assert.equal(once, twice)
  assert.equal((twice.match(/pacmtoken=/g) || []).length, 1)
})

test('authHeaders：有 pacmtoken 就发 pacmtoken 头', () => {
  const h = migu.authHeaders('pacmtoken=TOK; cookieId=DEV1')
  assert.equal(h.pacmtoken, 'TOK')
  assert.equal(h.By, 'DEV1')
  assert.equal(h.deviceId, 'DEV1')
})

test('authHeaders：只有 migu-utoken-sessionid 时不得冒充 pacmtoken（关键回归）', () => {
  // 以前这里写 `pacmtoken || migu-utoken-sessionid || LTToken`，票一过期就拿会话 id 顶包，
  // 平台必然拒绝，还让日志看不出「该刷新了」。修复后必须一个都不发。
  const h = migu.authHeaders('migu-utoken-sessionid=SESS; LTToken=LT1')
  assert.equal(h.pacmtoken, undefined, '会话 id / 长期票都不能当 pacmtoken 用')
})

test('authHeaders：设备 id 优先取 cookieId，其次 migu-device-uuid', () => {
  assert.equal(migu.authHeaders('cookieId=C1; migu-device-uuid=D1').By, 'C1')
  assert.equal(migu.authHeaders('migu-device-uuid=D1').By, 'D1')
  assert.equal(migu.authHeaders('pacmtoken=T').By, undefined)
})
