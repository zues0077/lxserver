import test from 'node:test'
import assert from 'node:assert'
import { decodeLooseUnicode, decodeSongText } from '../src/utils/textDecode'

/**
 * 曲名 \uXXXX 残留还原的回归用例。
 * 现场样本来自 2026-11-06 小爱压测：kw 平台返回 `一万次悲伤 (u5b8cu6574u7248)`。
 */
test('还原压测现场样本', () => {
  assert.strictEqual(decodeLooseUnicode('一万次悲伤 (u5b8cu6574u7248)'), '一万次悲伤 (完整版)')
})

test('多个连续转义一起还原', () => {
  // 完(U+5B8C) 整(U+6574) 版(U+7248)
  assert.strictEqual(decodeLooseUnicode('u4e2du6587'), '中文')
})

test('前面是字母的不动，避免拆坏正常单词', () => {
  // Menu1234 里的 u1234 前面是字母 n，不能当成转义
  assert.strictEqual(decodeLooseUnicode('Menu1234'), 'Menu1234')
  assert.strictEqual(decodeLooseUnicode('U571'), 'U571') // 大写 U 不匹配
})

test('解出来不是合理字符的原样保留', () => {
  // u1234 = 埃塞俄比亚文 ሴ，不在允许范围，属于误判，保留原文
  assert.strictEqual(decodeLooseUnicode('曲目u1234'), '曲目u1234')
})

test('没有残留时原样返回（不做任何改写）', () => {
  for (const name of ['晴天', 'Hello World', 'A-Lin《给我一个理由忘记》', '光年之外 (Live)']) {
    assert.strictEqual(decodeLooseUnicode(name), name)
  }
})

test('空值/非字符串安全', () => {
  assert.strictEqual(decodeLooseUnicode(''), '')
  assert.strictEqual(decodeLooseUnicode(null), '')
  assert.strictEqual(decodeLooseUnicode(undefined), '')
  assert.strictEqual(decodeLooseUnicode(123), '123')
})

test('decodeSongText 就地修复多个字段并报告改动', () => {
  const song: Record<string, any> = {
    name: '一万次悲伤 (u5b8cu6574u7248)',
    singer: 'u5468u6770u4f26', // 周杰伦
    albumName: '叶惠美',
    songmid: 'abc123',
  }
  const changed = decodeSongText(song)
  assert.strictEqual(changed, true)
  assert.strictEqual(song.name, '一万次悲伤 (完整版)')
  assert.strictEqual(song.singer, '周杰伦')
  assert.strictEqual(song.albumName, '叶惠美', '干净字段不该被改动')
  assert.strictEqual(song.songmid, 'abc123', 'ID 字段不参与解码')
})

test('decodeSongText 无改动时返回 false', () => {
  const song = { name: '晴天', singer: '周杰伦' }
  assert.strictEqual(decodeSongText(song), false)
  assert.strictEqual(decodeSongText(null), false)
})
