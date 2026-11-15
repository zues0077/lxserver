/**
 * 酷狗概念版「今日额度已到底」的落账与跳过判据（2026-11-16，手册 P-1513）。
 *
 * 背景（17950 实证）：同一天三轮里有两轮 5 个账号合计 0 小时，日志里 7 条
 * 「广告领取未成功」= 20028×4 + 30000×2 + 30002×1。根因不是间隔太短
 * （主号 32 秒连领 8 次全成功），而是「今天已经领满」这个结论**从来没落过账**：
 *   - 原判断 `res.adDone >= res.adTotal`，但 30002 时 adDone 是 undefined，
 *     `adDone` 只在成功分支赋过值 → 这一路永远不成立；
 *   - 唯一的替代品 `liteAdExhaustedAt` 是进程内 Map，重启即忘。
 * 于是后续每一轮都重新打 8 次，全撞 30002/20028/30000。
 *
 * 这里钉住三件事：标记能落盘、按账号隔离、跨天自动失效。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 必须在第一次调用 getMusicAccountDataDir() 之前设置：store.ts 内部有 cachedDir，
// 首次取值后就固定了。本文件的 import 不会触发它（dataDir 是惰性调用）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kglite-exh-'))
process.env.DATA_PATH = TMP

import {
  markKugouLiteAdExhausted,
  isKugouLiteAdExhaustedToday,
  recordKugouLiteClaim,
  dayKey,
} from '../src/server/musicAccount/kgliteLedger'

const LEDGER = () => path.join(TMP, 'kglite-claim-ledger.json')

function readLedgerFile(): any {
  return JSON.parse(fs.readFileSync(LEDGER(), 'utf-8'))
}

test('额度-1 从没标记过 → 判为「未到底」（宁可多打一轮，也不能不给领）', () => {
  assert.equal(isKugouLiteAdExhaustedToday('acc-none'), false)
})

test('额度-2 标记后 → 当天判到底，且确实写进账本文件（重启可读回）', () => {
  markKugouLiteAdExhausted({ id: 'acc-1', label: '我的主号', adDone: 8 })
  assert.equal(isKugouLiteAdExhaustedToday('acc-1'), true)

  const entry = readLedgerFile().days[dayKey()].accounts.find((a: any) => a.id === 'acc-1')
  assert.ok(entry, '标记必须落盘：内存 Map 重启即忘，正是原来的 bug')
  assert.equal(entry.adExhausted, true)
  assert.equal(entry.adDone, 8)
  assert.equal(entry.gainedHours, 0, '额度到底时没有新增时长，账本小时数仍为 0')
})

test('额度-3 按账号隔离：标记 A 不影响 B（多账号轮流领时不能一票否决）', () => {
  markKugouLiteAdExhausted({ id: 'acc-A', label: 'A' })
  assert.equal(isKugouLiteAdExhaustedToday('acc-A'), true)
  assert.equal(isKugouLiteAdExhaustedToday('acc-B'), false)
})

test('额度-4 原有「gained=0 不写账本」的保护没被破坏（别让 0 小时记录挤掉有意义的日期）', () => {
  recordKugouLiteClaim({ id: 'acc-zero', label: '零号', gainedHours: 0 })
  const day = readLedgerFile().days[dayKey()]
  assert.equal(
    day.accounts.find((a: any) => a.id === 'acc-zero'),
    undefined,
    'recordKugouLiteClaim 仍然只在真的拿到时长时记账',
  )
})

test('额度-5 跨天自动失效：昨天的标记不能挡住今天（不需要额外清理）', () => {
  const y = new Date(Date.now() - 24 * 3600 * 1000)
  const yKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
  const data = readLedgerFile()
  data.days[yKey] = {
    date: yKey, totalHours: 0, updatedAt: Date.now(),
    accounts: [{ id: 'acc-y', label: '昨天', gainedHours: 0, rounds: 0, adExhausted: true }],
  }
  fs.writeFileSync(LEDGER(), JSON.stringify(data))

  assert.equal(isKugouLiteAdExhaustedToday('acc-y'), false, '昨天的标记今天必须失效')
})

test('额度-6 账本损坏时判为「未到底」而不是抛错（账本只是优化，不能拖垮领取）', () => {
  fs.writeFileSync(LEDGER(), '{ 这不是合法 JSON')
  assert.equal(isKugouLiteAdExhaustedToday('acc-1'), false)
})
