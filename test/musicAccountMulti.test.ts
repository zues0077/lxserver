/**
 * 平台账号：多账号 / 主账号 / 概念版定时排程 —— 纯逻辑单测
 *
 * 重点覆盖「靠猜一定会错」的地方：
 *   - 第一个账号必须自动成为主账号，否则取链会找不到账号
 *   - 追加小号不能把主账号顶掉（取链只走主账号）
 *   - 删掉主账号后必须有人自动接任，不能出现「有账号但没有主账号」
 *   - 旧数据（只有单个 cookie 字段）要能被读出并迁移
 *   - 概念版自动领取的时间计算要跨得过去 0 点（8 轮 × 3 小时 = 覆盖全天）
 *
 * 这里必须先把 DATA_PATH 指到临时目录再动态 import store：
 * 否则会读写仓库里真实的 data/music-accounts.json，把用户账号搅进测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as store from '../src/server/musicAccount/store'
import { nextAutoClaimAt } from '../src/server/musicAccount'

// 必须在任何 store 函数被调用之前把数据目录指到临时目录：
// store 用的是「首次调用时确定目录」的策略（不在 import 时求值），所以这里赋值来得及。
// 不这么做会读写仓库里真实的 data/music-accounts.json，把用户账号搅进测试。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-acc-test-'))
process.env.DATA_PATH = tmpDir

const COOKIE_A = 'token=aaa; userid=111; mid=mid111; dfid=-'
const COOKIE_B = 'token=bbb; userid=222; mid=mid222; dfid=-'

function reset(): void {
  store.removeCookie('kglite')
}

test('第一个账号自动成为主账号', () => {
  reset()
  const r = store.addCookie('kglite', COOKIE_A)
  assert.equal(r.success, true)
  assert.equal(r.created, true)
  assert.equal(r.total, 1)
  const items = store.listAccountItems('kglite')
  assert.equal(items.length, 1)
  assert.equal(items[0].primary, true)
  assert.equal(items[0].label, '主账号')
  // 取链只认主账号：没有主账号标记时整条链路就废了
  assert.equal(store.getCookie('kglite'), COOKIE_A)
})

test('追加第二个账号不会顶掉主账号，取链仍走主账号', () => {
  const first = store.listAccountItems('kglite')[0].id
  const r = store.addCookie('kglite', COOKIE_B)
  assert.equal(r.created, true)
  assert.equal(r.total, 2)

  const items = store.listAccountItems('kglite')
  assert.equal(items.length, 2)
  assert.equal(items[0].primary, true, '主账号必须排在最前面')
  assert.equal(items[0].id, first)
  // 这是整个多账号设计的核心：小号再也不能影响播放取链
  assert.equal(store.getCookie('kglite'), COOKIE_A)
  // 但领 VIP 要拿到全部账号
  assert.equal(store.getCookies('kglite').length, 2)
})

test('设为主账号后，取链换到新账号', () => {
  const second = store.listAccountItems('kglite').find(i => !i.primary)!
  const r = store.setPrimaryAccount('kglite', second.id)
  assert.equal(r.success, true)

  const items = store.listAccountItems('kglite')
  assert.equal(items.filter(i => i.primary).length, 1, '主账号有且只有一个')
  assert.equal(items.find(i => i.primary)!.id, second.id)
  assert.equal(store.getCookie('kglite'), COOKIE_B)
})

test('删除主账号后，剩下的账号自动接任主账号', () => {
  const primary = store.listAccountItems('kglite').find(i => i.primary)!
  const r = store.removeAccountItem('kglite', primary.id)
  assert.equal(r.success, true)

  const items = store.listAccountItems('kglite')
  assert.equal(items.length, 1)
  assert.equal(items[0].primary, true)
  assert.equal(store.getCookie('kglite'), COOKIE_A)
})

test('更新指定账号的 Cookie 不会新建条目', () => {
  const target = store.listAccountItems('kglite')[0]
  const r = store.addCookie('kglite', 'token=ccc; userid=111; mid=mid111; dfid=-', { itemId: target.id })
  assert.equal(r.success, true)
  assert.equal(r.created, false)
  assert.equal(store.getCookies('kglite').length, 1)
  assert.equal(store.getCookieOf('kglite', target.id), 'token=ccc; userid=111; mid=mid111; dfid=-')
})

test('旧数据迁移：只有 cookie 字段时自动补成单账号', () => {
  reset()
  store.addCookie('kglite', COOKIE_A)
  const file = store.getStoreFilePath()
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  // 模拟上一版写下的结构：只有 cookie，没有 items
  delete raw.accounts.kglite.items
  fs.writeFileSync(file, JSON.stringify(raw), 'utf-8')

  const items = store.listAccountItems('kglite')
  assert.equal(items.length, 1)
  assert.equal(items[0].primary, true)
  assert.equal(store.getCookie('kglite'), COOKIE_A, '迁移后必须还能解出原来的 Cookie')
})

test('删掉最后一个账号后，该平台从账号文件里消失', () => {
  const only = store.listAccountItems('kglite')[0]
  store.removeAccountItem('kglite', only.id)
  assert.equal(store.listAccounts().find(a => a.id === 'kglite')!.configured, false)
  assert.equal(store.getCookie('kglite'), '')
})

test('store 里只有密文：明文 Cookie 不落盘', () => {
  reset()
  store.addCookie('kglite', COOKIE_A)
  const raw = fs.readFileSync(store.getStoreFilePath(), 'utf-8')
  assert.ok(!raw.includes('token=aaa'), '明文 Cookie 不能出现在账号文件里')
  reset()
})

// ---- 概念版自动领取：时间计算 ----
// 8 轮 × 3 小时，从 startHour 起对齐；跨 0 点最容易算错，单测专门盯这里

test('nextAutoClaimAt：开始时间未到 → 返回当天该点', () => {
  const now = new Date(2026, 9, 28, 4, 20).getTime()
  assert.equal(nextAutoClaimAt(6, now), new Date(2026, 9, 28, 6, 0, 0, 0).getTime())
})

test('nextAutoClaimAt：开始时间已过 → 返回下一个 3 小时刻度', () => {
  const now = new Date(2026, 9, 28, 7, 30).getTime()
  assert.equal(nextAutoClaimAt(6, now), new Date(2026, 9, 28, 9, 0, 0, 0).getTime())

  const now2 = new Date(2026, 9, 28, 13, 5).getTime()
  assert.equal(nextAutoClaimAt(6, now2), new Date(2026, 9, 28, 15, 0, 0, 0).getTime())
})

test('nextAutoClaimAt：深夜越过的 0 点轮次也算数', () => {
  const now = new Date(2026, 9, 28, 23, 30).getTime()
  // 6 点起每 3 小时：21:00 之后是次日 00:00
  assert.equal(nextAutoClaimAt(6, now), new Date(2026, 9, 29, 0, 0, 0, 0).getTime())
})

test('nextAutoClaimAt：凌晨重启时不跳过「上一天周期的最后一轮」', () => {
  // 6 点起跑时，10/28 03:00 属于 10/27 那个周期（06:00 起 21 小时后）。
  // 若只看当天刻度，这里会算成 06:00，07:00~09:00 之间就会空出一大段没人补领。
  const now = new Date(2026, 9, 28, 1, 0).getTime()
  assert.equal(nextAutoClaimAt(6, now), new Date(2026, 9, 28, 3, 0, 0, 0).getTime())
})

test('nextAutoClaimAt：0 点起跑时，23:30 的下一轮是明天 0 点', () => {
  const now = new Date(2026, 9, 28, 23, 30).getTime()
  assert.equal(nextAutoClaimAt(0, now), new Date(2026, 9, 29, 0, 0, 0, 0).getTime())
})

test('nextAutoClaimAt：非法开始时间不抛错，越界值钳进 0-23', () => {
  const now = new Date(2026, 9, 28, 1, 0).getTime()
  // NaN → 兜底 6 点，凌晨 1 点时最近的刻度仍是当天 03:00
  assert.equal(nextAutoClaimAt(NaN, now), new Date(2026, 9, 28, 3, 0, 0, 0).getTime())
  // 99 点钳成 23 点：上一周期是 10/27 23:00 起，下一刻度是 10/28 02:00
  assert.equal(nextAutoClaimAt(99, now), new Date(2026, 9, 28, 2, 0, 0, 0).getTime())
  assert.equal(nextAutoClaimAt(-5, now), new Date(2026, 9, 28, 3, 0, 0, 0).getTime())
})

test('nextAutoClaimAt：结果一定晚于当前时刻', () => {
  const base = new Date(2026, 9, 28, 0, 0).getTime()
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 17) {
      const now = base + h * 3600_000 + m * 60_000
      const at = nextAutoClaimAt(6, now)
      assert.ok(at > now, `startHour=6 now=${new Date(now).toISOString()} 算出的 ${new Date(at).toISOString()} 不晚于现在`)
    }
  }
})

test('旧版本回写 cookie 时，以旧字段为准（降级一致性）', () => {
  reset()
  // 存 A，记下 items 里主账号的密文（模拟「多账号结构里的副本」）
  store.addCookie('kglite', COOKIE_A)
  const file = store.getStoreFilePath()
  const cipherA = JSON.parse(fs.readFileSync(file, 'utf-8')).accounts.kglite.items[0].cookie

  // 换成 B 之后，把 items 里的密文改回 A 的 —— 等价于「旧版本只在 cookie 字段里写了 B」
  reset()
  store.addCookie('kglite', COOKIE_B)
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  raw.accounts.kglite.items[0].cookie = cipherA
  fs.writeFileSync(file, JSON.stringify(raw), 'utf-8')

  assert.equal(store.getCookie('kglite'), COOKIE_B, '旧字段更新过，主账号必须跟着换')
  assert.equal(store.listAccountItems('kglite').length, 1)
  reset()
})

// ---- setAccountUid：把「平台接口问出来的身份」补进库 ----
//
// 场景：咪咕浏览器 Cookie 没有 userid，保存时是「按 Cookie 指纹」或「覆盖主账号」落的库，
// 巡检时 queryUserInfo 答出 userId，必须补记下来，否则下次同步还是认不出号。

test('setAccountUid：原本没有 uid 时补上（主账号）', () => {
  reset()
  store.addCookie('kglite', COOKIE_A)
  assert.equal(store.setAccountUid('kglite', undefined, '98765432109876543210987'), true)
  // 补身份不能把 Cookie 弄丢
  assert.equal(store.getCookie('kglite'), COOKIE_A)
  const file = JSON.parse(fs.readFileSync(store.getStoreFilePath(), 'utf-8'))
  assert.equal(file.accounts.kglite.items[0].uid, '98765432109876543210987')
  reset()
})

test('setAccountUid：已有相同 uid 时不重复写（幂等）', () => {
  reset()
  store.addCookie('kglite', COOKIE_A, { uid: '98765432109876543210987' })
  assert.equal(store.setAccountUid('kglite', undefined, '98765432109876543210987'), false)
  reset()
})

test('setAccountUid：已有不同 uid 时不覆盖（那是另一个号，静默改写会抹掉身份）', () => {
  reset()
  store.addCookie('kglite', COOKIE_A, { uid: 'old-uid-111' })
  assert.equal(store.setAccountUid('kglite', undefined, 'new-uid-222'), false)
  const file = JSON.parse(fs.readFileSync(store.getStoreFilePath(), 'utf-8'))
  assert.equal(file.accounts.kglite.items[0].uid, 'old-uid-111')
  reset()
})

test('setAccountUid：指定 itemId 只动那一条，不碰主账号', () => {
  reset()
  store.addCookie('kglite', COOKIE_A)
  const second = store.addCookie('kglite', COOKIE_B)
  assert.equal(store.setAccountUid('kglite', second.itemId, 'uid-bbb'), true)
  const file = JSON.parse(fs.readFileSync(store.getStoreFilePath(), 'utf-8'))
  const items = file.accounts.kglite.items
  assert.equal(items.find((i: any) => i.id === second.itemId).uid, 'uid-bbb')
  assert.equal(items.find((i: any) => i.primary).uid, undefined, '主账号不该被顺带写身份')
  reset()
})

test('setAccountUid：空 uid 或未知平台直接拒绝', () => {
  reset()
  store.addCookie('kglite', COOKIE_A)
  assert.equal(store.setAccountUid('kglite', undefined, ''), false)
  assert.equal(store.setAccountUid('kglite', undefined, '   '), false)
  assert.equal(store.setAccountUid('nope', undefined, '123456789'), false)
  reset()
})
