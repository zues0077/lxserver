/**
 * 热搜兜底判定（2026-11-05 test-r42 实机回归守护）。
 *
 * 背景：兜底代码曾把 SDK 返回的 `{source,list}` 当成「空结果」，
 * 246 实测日志 `mg: 空结果；kw: 空结果；kg: 空结果；tx: 空结果；wy: 空结果`，
 * 界面热搜恒为空。这组用例锁住对象形态必须与数组形态一样被认作有效。
 */
import test from 'node:test'
import assert from 'node:assert'
import { hotSearchItems, hasHotSearchItems } from '../src/server/hotSearchFallback'

test('SDK 现行形态 {source,list} 必须判定为有效', () => {
  const payload = { source: 'mg', list: ['晴天', '稻香'] }
  assert.deepStrictEqual(hotSearchItems(payload), ['晴天', '稻香'])
  assert.strictEqual(hasHotSearchItems(payload), true)
})

test('list 为空数组时才是真的空结果', () => {
  assert.strictEqual(hasHotSearchItems({ source: 'mg', list: [] }), false)
  assert.strictEqual(hasHotSearchItems([]), false)
})

test('纯数组形态同样兼容', () => {
  const payload = ['晴天', '稻香']
  assert.deepStrictEqual(hotSearchItems(payload), payload)
  assert.strictEqual(hasHotSearchItems(payload), true)
})

test('异常/脏值不得被当成有效结果', () => {
  for (const v of [null, undefined, '', 0, {}, { list: 'not-array' }, { source: 'wy' }]) {
    assert.deepStrictEqual(hotSearchItems(v), [], `输入 ${JSON.stringify(v)} 应视为空`)
    assert.strictEqual(hasHotSearchItems(v), false)
  }
})
