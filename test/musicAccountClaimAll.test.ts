import { test } from 'node:test'
import assert from 'node:assert/strict'

// index.ts 的 config() 自己有 `global.lx?.config || {}` 兜底，不用预置
import { getKugouLiteClaimAllState } from '../src/server/musicAccount/index'

// 「立即全部领取」改成后台跑 + 前端轮询后，接口依赖这份进度状态：
// running 一开始必须是 false，否则按钮会永远提示「上一轮还在进行中」。
test('全部领取：初始状态是「没在跑、没有历史明细」', () => {
  const st = getKugouLiteClaimAllState()
  assert.equal(st.running, false)
  assert.equal(typeof st.startedAt, 'number')
  assert.equal(typeof st.finishedAt, 'number')
  assert.equal(st.lastRound, null)
})

test('全部领取：轮询读状态是纯读，不会因为被轮询就把 running 置真', () => {
  getKugouLiteClaimAllState()
  getKugouLiteClaimAllState()
  assert.equal(getKugouLiteClaimAllState().running, false)
})
