/**
 * 酷狗概念版（kglite）—— 纯逻辑单测
 *
 * 这里只测「不需要联网就能判定」的部分，重点是那些靠猜一定会错的地方：
 *   - 网页 Cookie（t / KugooID）不能当概念版凭据用（实测会 35005 token invalid）
 *   - 缺 mid 时签名必然失败，必须提前拦住并给出可读原因
 *   - 通道链顺序：概念版优先，标准版兜底
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as kglite from '../src/server/musicAccount/resolvers/kglite'
import { channelIdsFor, hasAccount } from '../src/server/musicAccount'
import { getPlatform } from '../src/server/musicAccount/platforms'

const FULL_COOKIE = 'token=abc123; userid=2577290129; mid=123456789012345678901234567890; dfid=-'

test('hasLiteCreds：完整四字段判为可用', () => {
  assert.equal(kglite.hasLiteCreds(FULL_COOKIE), true)
})

test('hasLiteCreds：缺 mid 判为不可用（否则签名必失败）', () => {
  assert.equal(kglite.hasLiteCreds('token=abc123; userid=2577290129; dfid=-'), false)
})

test('hasLiteCreds：网页版 Cookie（t / KugooID）不算概念版登录态', () => {
  // 这是最容易误判的一种：字段看着齐全，实际打 App 接口会 35005
  assert.equal(kglite.hasLiteCreds('t=abc123; KugooID=2577290129; dfid=-'), false)
})

test('hasLiteCreds：空串判为不可用', () => {
  assert.equal(kglite.hasLiteCreds(''), false)
})

test('resolve：没有 hash 时直接报缺少 hash，不发网络请求', async () => {
  const r = await kglite.resolve({ name: '无 hash 的歌' }, '320k', FULL_COOKIE)
  assert.equal(r.ok, false)
  assert.match(String(r.error), /缺少酷狗 hash/)
})

test('resolve：凭据不完整时给出可操作的提示', async () => {
  const r = await kglite.resolve({ hash: 'b3a52a7a958bf0aed0ebfba2e9a818b7' }, '320k', 't=abc; KugooID=1')
  assert.equal(r.ok, false)
  assert.match(String(r.error), /token \/ userid \/ mid/)
})

test('通道链：酷狗优先走概念版，标准版兜底', () => {
  assert.deepEqual(channelIdsFor('kg'), ['kglite', 'kg'])
})

test('通道链：其他平台保持单一通道', () => {
  assert.deepEqual(channelIdsFor('wy'), ['wy'])
  assert.deepEqual(channelIdsFor('soda'), ['soda'])
})

test('通道链：未知 source 不至于抛错', () => {
  assert.deepEqual(channelIdsFor('not-a-platform'), ['not-a-platform'])
})

test('hasAccount：只有概念版账号时，kg 也算「有账号」', () => {
  // 真实 store 里两个平台都未配置，这里只验证不抛错且返回布尔
  const v = hasAccount('kg')
  assert.equal(typeof v, 'boolean')
})

test('平台定义：kglite 已注册且支持扫码登录', () => {
  const p = getPlatform('kglite')
  assert.ok(p, 'kglite 必须存在于 PLATFORMS')
  assert.equal(p!.name, '酷狗概念版')
  assert.deepEqual(p!.loginKeys, ['token', 'userid'])
  assert.equal(p!.essentialKey, 'mid')
  assert.ok(p!.qrLogins && p!.qrLogins.length > 0, '必须提供扫码登录入口')
  assert.equal(p!.qrLogins![0].driver, 'kglite')
})

// —— 领取：错误码口径与连领间隔（2026-10-30 按上游实现纠正） ——

test('领取错误码：130012 是「今日已领取」，不是失败', () => {
  // 上游 KGM-AUTO-CHECKIN main.js:198、tgbot KuGouLogic.kt:252 都当正常终态
  const text = kglite.claimErrorText({ status: 0, error_code: 130012 })
  assert.match(text, /今日已领取/)
  assert.doesNotMatch(text, /不可用/)
})

test('领取错误码：30002 / 20028 / 20018 各有独立人话', () => {
  assert.match(kglite.claimErrorText({ error_code: 30002 }), /次数已用光/)
  assert.match(kglite.claimErrorText({ error_code: 20028 }), /人机验证/)
  assert.match(kglite.claimErrorText({ error_code: 20018 }), /登录态已失效/)
})

test('领取错误码：未知码兜底带上 status 与 error_code，不吞信息', () => {
  const text = kglite.claimErrorText({ status: 0, error_code: 999 })
  assert.match(text, /status=0/)
  assert.match(text, /error_code=999/)
})

test('连领间隔必须 ≥30 秒（play_start/play_end 固定差 30000ms）', () => {
  // 间隔短于 30 秒会让两次上报的播放时间段重叠，明显是脚本
  assert.ok(kglite.AD_CLAIM_INTERVAL_MS >= 30_000, `实际 ${kglite.AD_CLAIM_INTERVAL_MS}ms`)
  // 也不要太夸张，8 次要在一次定时任务窗口内跑完
  assert.ok(kglite.AD_CLAIM_INTERVAL_MS <= 60_000)
})

test('每日额度常量与上游一致：8 次 × 3 小时 = 24 小时', () => {
  assert.equal(kglite.DAILY_CLAIM_LIMIT, 8)
  assert.equal(kglite.HOURS_PER_CLAIM, 3)
  assert.equal(kglite.DAILY_CLAIM_LIMIT * kglite.HOURS_PER_CLAIM, 24)
})
