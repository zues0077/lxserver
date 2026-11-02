import test from 'node:test'
import assert from 'node:assert'
import { bvidToAid } from '../src/server/extraSources/bilibili'

test('BV 号 → aid：已知对（B站官方示例）', () => {
  assert.equal(bvidToAid('BV1xx411c7mD'), 2)
  assert.equal(bvidToAid('BV17x411w7KC'), 170001)
})

test('BV 号 → aid：非法输入返回 0（交给调用方回落接口）', () => {
  assert.equal(bvidToAid(''), 0)
  assert.equal(bvidToAid('av170001'), 0)
  assert.equal(bvidToAid('BV1xx411c7m'), 0)          // 少一位
  assert.equal(bvidToAid('BV1xx411c7m@'), 0)         // 非法字符
  assert.equal(bvidToAid('BV1xx411c7mI'), 0)         // base58 表里没有 I/O/l/0
})
