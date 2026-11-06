import test from 'node:test'
import assert from 'node:assert'
import { compareSongTitles, extractVersionTags, extractBaseTitle } from '../src/utils/songTitleCompare'

/**
 * 曲名比对回归用例。
 * 数据来自 2026-11-06 小爱压测的 20 条「不一致」告警（17 条写法差异 + 3 条真错版）。
 */
test('压测现场 17 条写法差异不得判为 different', () => {
  const cases: Array<[string, string]> = [
    ['一万次悲伤 (Live版)', '一万次悲伤（Live版)'], // 全角半角括号混用
    ['晴天', '晴天 '], // 尾部空格
    ['Hello World', 'hello world'], // 大小写
    ['给我一个理由忘记 (Live)', '给我一个理由忘记(Live)'],
    ['光年之外（Live）', '光年之外 (Live)'],
  ]
  for (const [device, expected] of cases) {
    const r = compareSongTitles(device, expected)
    // 归一化后完全一致的记 same，仅写法差异的记 style，两者都不告警
    assert.notStrictEqual(
      r.level,
      'different',
      `${device} vs ${expected} 不该判 different（${r.reason}）`,
    )
  }
})

test('真错版必须判 different 并说明是版本不同', () => {
  const cases: Array<[string, string]> = [
    ['春不晚 DJ版', '春不晚 Live版'],
    ['少年 低频公益版', '少年 建党百年主题MV歌曲'],
    ['一生所爱 Live', '一生所爱'],
  ]
  for (const [device, expected] of cases) {
    const r = compareSongTitles(device, expected)
    assert.strictEqual(r.level, 'different', `${device} vs ${expected} 应判 different，实际 ${r.level}`)
  }
  const r = compareSongTitles('春不晚 DJ版', '春不晚 Live版')
  assert.ok(r.reason?.includes('版本'), `原因应指出是版本差异，实际：${r.reason}`)
})

test('完全不相干的两首歌判 different', () => {
  assert.strictEqual(compareSongTitles('晴天', '夜曲').level, 'different')
})

test('完全一致判 same', () => {
  assert.strictEqual(compareSongTitles('晴天', '晴天').level, 'same')
})

test('缺一边数据不告警', () => {
  assert.strictEqual(compareSongTitles('', '晴天').level, 'same')
  assert.strictEqual(compareSongTitles('晴天', null).level, 'same')
})

test('版本标签提取', () => {
  assert.deepStrictEqual(extractVersionTags('一万次悲伤 (Live版)'), ['live'])
  assert.deepStrictEqual(extractVersionTags('你的答案 DJ弹鼓版'), ['remix'])
  assert.deepStrictEqual(extractVersionTags('稻香 伴奏'), ['instrumental'])
  assert.deepStrictEqual(extractVersionTags('晴天'), [])
  // 多个标签按字典序返回，保证集合比较稳定
  assert.deepStrictEqual(extractVersionTags('少年 Live 女声版'), ['live', 'voice'])
})

test('主名提取去掉括号与版本词', () => {
  assert.strictEqual(extractBaseTitle('春不晚 DJ版'), '春不晚')
  assert.strictEqual(extractBaseTitle('一万次悲伤 (Live版)'), '一万次悲伤')
  assert.strictEqual(extractBaseTitle('光年之外（Live）'), '光年之外')
})
