import assert from 'node:assert/strict'
import test from 'node:test'

import { isStaleSeekPosition, resolveSeekOffsetSec } from '../src/server/xiaoai/seekGuard'

// ---- 残留位置守卫（P-1110）----

test('刚投送 3 秒就跳到 131 秒、从未拖过 → 判为残留（打回开头）', () => {
  const stale = isStaleSeekPosition({
    hasExpectName: false,
    seekSec: 131,
    sincePushSec: 3,
    sinceSeekSec: Number.POSITIVE_INFINITY,
  })
  assert.equal(stale, true)
})

test('刚投送 3 秒但 4 秒前用户刚拖过 → 放行（连拖第二次不能被打回 0 秒）', () => {
  const stale = isStaleSeekPosition({
    hasExpectName: false,
    seekSec: 100,
    sincePushSec: 4,
    sinceSeekSec: 4,
  })
  assert.equal(stale, false, '连续拖动属于用户主动跳转，判成残留会导致「拖了没反应」')
})

test('拖动冷却过后（超过 10 秒）守卫重新生效', () => {
  const stale = isStaleSeekPosition({
    hasExpectName: false,
    seekSec: 200,
    sincePushSec: 3,
    sinceSeekSec: 11,
  })
  assert.equal(stale, true)
})

test('断点续播（声明了期望歌名）一律放行', () => {
  const stale = isStaleSeekPosition({
    hasExpectName: true,
    seekSec: 300,
    sincePushSec: 1,
    sinceSeekSec: Number.POSITIVE_INFINITY,
  })
  assert.equal(stale, false)
})

test('投送已过 8 秒窗口 → 不再当残留', () => {
  const stale = isStaleSeekPosition({
    hasExpectName: false,
    seekSec: 220,
    sincePushSec: 30,
    sinceSeekSec: Number.POSITIVE_INFINITY,
  })
  assert.equal(stale, false)
})

test('只比已播多 3 秒 → 属于正常快进，不拦', () => {
  const stale = isStaleSeekPosition({
    hasExpectName: false,
    seekSec: 8,
    sincePushSec: 5,
    sinceSeekSec: Number.POSITIVE_INFINITY,
  })
  assert.equal(stale, false)
})

// ---- 前端时间轴偏移归一化 ----

test('服务端明确回 0（回到开头）→ 偏移必须是 0，不能退回请求的 100', () => {
  assert.equal(resolveSeekOffsetSec(0, 100), 0)
})

test('服务端回 85 → 用 85', () => {
  assert.equal(resolveSeekOffsetSec(85, 100), 85)
})

test('服务端字段缺失/非法 → 退回请求值', () => {
  assert.equal(resolveSeekOffsetSec(undefined, 100), 100)
  assert.equal(resolveSeekOffsetSec(null, 100), 100)
  assert.equal(resolveSeekOffsetSec('abc', 100), 100)
})

test('服务端与请求都无效 → 0', () => {
  assert.equal(resolveSeekOffsetSec(undefined, 0), 0)
  assert.equal(resolveSeekOffsetSec(Number.NaN, -5), 0)
})
