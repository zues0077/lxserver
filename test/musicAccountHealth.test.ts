/**
 * 平台账号健康度：状态分级 + 汇总提示。
 *
 * 这里**故意没有**「按报错文案判断是否失效」的测试——那条路已经废弃了。
 * 原因写在这里，避免以后有人又想加回去：
 * 各平台 resolver 的兜底文案是含糊的，酷我是「多为版权受限、需要会员或 Cookie 失效」，
 * QQ 是「多为付费/版权受限曲目（当前账号无绿钻权益拿不到），或 Cookie 已过期」。
 * 同一句话既可能是歌的问题也可能是账号的问题，按关键词判定等于「唱一首没版权的歌
 * 就把好账号标成已失效」，比不提示更糟。现在改成取链失败后调平台自己的
 * getAccountInfo 复核（见 index.ts probeAccountAfterFailure），由接口说话。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  STALE_AFTER_DAYS,
  classifyHealth,
  isSnapshotFromOtherVersion,
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

// —— 快照版本戳：跨版本升级后旧口径自动作废（手册 P-0983 / P-0985）——

test('isSnapshotFromOtherVersion：同版本、无版本参数、读不到版本时都不算过期', () => {
  const snap = { at: now - HOUR, ok: true, verified: 'online' as const, byVersion: '1.5.49' }
  assert.equal(isSnapshotFromOtherVersion(snap, '1.5.49'), false)
  // 没有当前版本可比（老调用点）→ 不判，保持原行为
  assert.equal(isSnapshotFromOtherVersion(snap, undefined), false)
  // 版本号读不出来时不能一刀切全判过期，否则环境异常会天天全量重查
  assert.equal(isSnapshotFromOtherVersion(snap, 'unknown'), false)
  // 根本没有快照 → 交给「未校验」分支处理，不算「版本不符」
  assert.equal(isSnapshotFromOtherVersion(null, '1.5.49'), false)
})

test('isSnapshotFromOtherVersion：版本不同、或老数据没版本戳，都算过期', () => {
  const older = { at: now - HOUR, ok: true, verified: 'online' as const, byVersion: '1.5.48' }
  assert.equal(isSnapshotFromOtherVersion(older, '1.5.49'), true)
  // 升级前的历史数据没有 byVersion —— 正是这次要治的场景
  const legacy = { at: now - HOUR, ok: true, verified: 'structural' as const }
  assert.equal(isSnapshotFromOtherVersion(legacy, '1.5.49'), true)
})

test('classifyHealth：上一版写的在线结论也降级成「待重新校验」', () => {
  const snap = { at: now - HOUR, ok: true, verified: 'online' as const, byVersion: '1.5.48' }
  const r = classifyHealth(true, snap, now, '1.5.49')
  assert.equal(r.health, 'unchecked')
  assert.equal(r.text, '待重新校验')
  // 时间也别再沿用旧快照，前端不会显示「3 小时前校验过」
  assert.equal(r.ageHours, null)
})

test('classifyHealth：同版本快照照旧走正常分类', () => {
  const snap = { at: now - 3 * HOUR, ok: true, verified: 'online' as const, byVersion: '1.5.49' }
  const r = classifyHealth(true, snap, now, '1.5.49')
  assert.equal(r.health, 'ok')
  assert.equal(r.text, '正常')
  assert.equal(r.ageHours, 3)
})
