/**
 * 咪咕「认号」链路 —— 纯逻辑单测
 *
 * 背景（2026-10-30，用户实际踩到的数据损失）：
 *   咪咕网页登录后的 Cookie 里**没有 userid**（15 个字段全是 idmpauth / pacmtoken /
 *   migu-utoken-sessionid 这类会话字段），于是「一键同步推上来的是新号还是老号」
 *   认不出来，老逻辑一律走 setCookie **覆盖主账号** —— 推一个浏览器登录的号
 *   就把主账号整个顶掉了。
 *
 * 修法：保存时先用平台自己的接口问一次身份（queryUserInfo 返回 userId），
 * 问到之后按 uid 认号，认不到才退回「覆盖主账号」。
 *
 * 这里守三件事：
 *   1) 响应体解析（pickUserIdFromBody）不能把占位值当成身份 —— 认错号比不认更糟；
 *   2) 没有登录字段的 Cookie 不去打接口（保存链路不能被无意义请求拖慢）；
 *   3) uid 语义与 identity 模块一致（Cookie 有 userid 就直接用，不需要请求）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as migu from '../src/server/musicAccount/resolvers/migu'
import { extractAccountIdentity } from '../src/server/musicAccount/identity'

test('pickUserIdFromBody：读 userInfoItem.userId（实证字段位置）', () => {
  const body = {
    code: '000000',
    userInfoItem: { userId: '98765432109876543210987', nickName: '测试号', vipFlag: '1' },
  }
  assert.equal(migu.pickUserIdFromBody(body), '98765432109876543210987')
})

test('pickUserIdFromBody：data.userInfoItem 包一层也认', () => {
  const body = { code: '000000', data: { userInfoItem: { userId: '123456789' } } }
  assert.equal(migu.pickUserIdFromBody(body), '123456789')
})

test('pickUserIdFromBody：userid 小写写法也认（不同实现命名不一致）', () => {
  assert.equal(migu.pickUserIdFromBody({ userInfoItem: { userid: '88888888' } }), '88888888')
})

test('pickUserIdFromBody：userId 是数字类型时转字符串', () => {
  assert.equal(migu.pickUserIdFromBody({ userInfoItem: { userId: 123456789 } }), '123456789')
})

test('pickUserIdFromBody：占位值一律不认（认错号比不认更糟）', () => {
  // 这些值如果被当成 uid，所有号都会被认成「同一个号」，
  // 表现为「同步什么都往一条里写」，比原来的「覆盖主账号」更难排查。
  for (const bad of [0, '0', '', ' ', 'null', 'undefined', 'abc', null, undefined]) {
    assert.equal(migu.pickUserIdFromBody({ userInfoItem: { userId: bad } }), '', `userId=${String(bad)} 不该被认成身份`)
  }
  assert.equal(migu.pickUserIdFromBody({}), '')
  assert.equal(migu.pickUserIdFromBody(null), '')
  assert.equal(migu.pickUserIdFromBody({ code: '299999', info: 'uid不能为空' }), '')
})

test('pickUserIdFromBody：过短的纯数字不认（避免把序号当身份）', () => {
  assert.equal(migu.pickUserIdFromBody({ userInfoItem: { userId: '123' } }), '')
})

test('resolveUid：没有登录字段的 Cookie 直接返回空，不打接口', async () => {
  // 保存链路不能为游客 Cookie 白等 3.5 秒 × 2 次
  const started = Date.now()
  assert.equal(await migu.resolveUid('a=1; b=2'), '')
  assert.equal(await migu.resolveUid(''), '')
  assert.ok(Date.now() - started < 500, '结构不符时应立刻返回')
})

test('identity：咪咕浏览器 Cookie 没有 userid → 没有静态 uid（所以才要问接口）', () => {
  const browserCookie = 'idmpauth=true@passport.migu.cn; pacmtoken=PK1; migu-utoken-sessionid=SID1; mg_auth_sid=X'
  const ident = extractAccountIdentity('mg', browserCookie)
  assert.equal(ident.uid, undefined)
  assert.equal(ident.cookieHash.length, 16)
})

test('identity：带 userid 的咪咕 Cookie 直接认号（不需要请求接口）', () => {
  const ident = extractAccountIdentity('mg', 'userid=98765432109876543210987; pacmtoken=PK1')
  assert.equal(ident.uid, '98765432109876543210987')
})

test('identity：Cookie 换序不影响指纹（同一份 Cookie 重推不该多出一个号）', () => {
  const a = extractAccountIdentity('mg', 'pacmtoken=PK1; migu-utoken-sessionid=SID1')
  const b = extractAccountIdentity('mg', 'migu-utoken-sessionid=SID1; pacmtoken=PK1')
  assert.equal(a.cookieHash, b.cookieHash)
})

test('identity：票轮换后指纹会变（所以只靠 cookieHash 认号是不够的）', () => {
  // 这正是必须问平台要 userId 的原因：咪咕每次响应都换票，
  // 同一份「同一个号」的 Cookie 每次同步过来 cookieHash 都不同。
  const a = extractAccountIdentity('mg', 'pacmtoken=PK1; mg_auth_sid=X')
  const b = extractAccountIdentity('mg', 'pacmtoken=PK2; mg_auth_sid=X')
  assert.notEqual(a.cookieHash, b.cookieHash)
})
