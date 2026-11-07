import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixBrokenUnicodeEscapes, fixTrackListNames } from '../src/server/songNameFix'

test('长跑实锤案例：完整版 转义残留被还原', () => {
  // 2026-11-07 五小时长跑：kw 搜索返回「一万次悲伤 (u5b8cu6574u7248)」
  assert.strictEqual(fixBrokenUnicodeEscapes('一万次悲伤 (u5b8cu6574u7248)'), '一万次悲伤 (完整版)')
})

test('多段残留还原：纯转义残留歌名', () => {
  assert.strictEqual(fixBrokenUnicodeEscapes('u4e00u4e07u6b21u60b2u4f24'), '一万次悲伤')
})

test('带反斜杠的过度转义（\\uXXXX 字面文本）也还原', () => {
  assert.strictEqual(fixBrokenUnicodeEscapes('一万次悲伤 (\\u5b8c\\u6574\\u7248)'), '一万次悲伤 (完整版)')
})

test('单个 u 序列不碰（防误伤）', () => {
  assert.strictEqual(fixBrokenUnicodeEscapes('U2 u4e00'), 'U2 u4e00')
  assert.strictEqual(fixBrokenUnicodeEscapes('u5b8c'), 'u5b8c')
})

test('正常歌名原样返回', () => {
  assert.strictEqual(fixBrokenUnicodeEscapes('后来 - 半吨兄弟'), '后来 - 半吨兄弟')
  assert.strictEqual(fixBrokenUnicodeEscapes('夜曲 (Live)'), '夜曲 (Live)')
  // url 编码类内容不受影响
  assert.strictEqual(fixBrokenUnicodeEscapes('DJ版(高清)'), 'DJ版(高清)')
})

test('非法输入原样返回', () => {
  const x = undefined as unknown as string
  assert.strictEqual(fixBrokenUnicodeEscapes(x), x)
  assert.strictEqual(fixBrokenUnicodeEscapes(''), '')
})

test('fixTrackListNames 只动 name/singer 字段', () => {
  const list = [
    { name: 'u4e00u4e07u6b21u60b2u4f24', singer: 'u90d1u6e90', songmid: 'abc', img: 'http://x' },
    { name: '正常歌', singer: '正常歌手' },
    null,
  ]
  const out = fixTrackListNames(list)
  assert.strictEqual(out[0].name, '一万次悲伤')
  assert.strictEqual(out[0].singer, '郑源')
  assert.strictEqual(out[0].songmid, 'abc')
  assert.strictEqual(out[0].img, 'http://x')
  assert.strictEqual(out[1].name, '正常歌')
  assert.strictEqual(out[2], null)
})
