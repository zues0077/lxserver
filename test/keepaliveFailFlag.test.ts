/**
 * 保温连续失败 → 标记「需重新登录」（2026-11-04）
 *
 * 背景：咪咕 pacmtoken 约 2 小时有效，保温每小时续一次。但保温只会「续活票」，
 * 票一旦真的过期（例如容器停了 6 小时），它会每小时失败一次，而面板依旧显示「正常」——
 * 用户只能从「播不了」倒推。这里把连续失败记下来，到阈值就把健康度改成 expired、
 * 文案写「需重新登录」，并通过 /api/music/account-hints 置顶提示。
 *
 * 只测纯存储层：不联网、不碰调度。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as store from '../src/server/musicAccount/store'

// DATA_PATH 在每次读写时现取（getMusicAccountDataDir 是函数），import 之后再设也生效
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-keepalive-'))
process.env.DATA_PATH = root

const COOKIE = 'idmpauth=true@passport.migu.cn; pacmtoken=AAAA; LTToken=BBBB'

test('保温成功会清零失败计数，失败从 1 开始累加', () => {
  store.setCookie('mg', COOKIE, { label: '主号' })
  const first = store.noteKeepaliveResult('mg', undefined, false)
  assert.equal(first.failCount, 1)
  assert.equal(first.justFlagged, false)

  const ok = store.noteKeepaliveResult('mg', undefined, true)
  assert.equal(ok.failCount, 0, '成功一次就清零，不需要连续成功')

  // 再失败两次，仍不到阈值
  store.noteKeepaliveResult('mg', undefined, false)
  const third = store.noteKeepaliveResult('mg', undefined, false)
  assert.equal(third.failCount, 2)
  assert.equal(third.justFlagged, false)
})

test('连续 3 次失败 → justFlagged 恰好触发一次，视图健康度变 expired', () => {
  store.setCookie('mg', COOKIE, { label: '主号' })
  store.noteKeepaliveResult('mg', undefined, true) // 先把上一条用例留下的计数清零
  const a = store.noteKeepaliveResult('mg', undefined, false)
  const b = store.noteKeepaliveResult('mg', undefined, false)
  const c = store.noteKeepaliveResult('mg', undefined, false)

  assert.deepEqual([a.failCount, b.failCount, c.failCount], [1, 2, 3])
  assert.equal(c.justFlagged, true, '跨过阈值时只提示一次')
  assert.equal(store.noteKeepaliveResult('mg', undefined, false).justFlagged, false, '第 4 次不再重复提示')

  const view = store.listAccounts().find(p => p.id === 'mg')!
  const item = view.accounts[0]
  assert.equal(item.needsRelogin, true)
  assert.equal(item.keepaliveFailCount, 4)
  assert.equal(view.health, 'expired')
  assert.match(view.healthText, /需重新登录/)
})

test('失败计数清零后健康度恢复', () => {
  store.noteKeepaliveResult('mg', undefined, true)
  const view = store.listAccounts().find(p => p.id === 'mg')!
  assert.equal(view.accounts[0].needsRelogin, false)
  assert.equal(view.accounts[0].keepaliveFailCount, 0)
})

test('未知平台不抛错', () => {
  const r = store.noteKeepaliveResult('not-a-platform', undefined, false)
  assert.deepEqual(r, { failCount: 0, justFlagged: false })
})
