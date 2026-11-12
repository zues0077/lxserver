/**
 * P2-1（上游「聚合搜索关键词联想」）单测。
 *
 * 锁住的不变式：
 *   1. 八源搜索 ≠ 八源联想：all 只并发 5 个 musicSdk 源，kglite 转 kg，
 *      bili/soda 诚实返回空；
 *   2. 合并是简单可解释的字典序（票数 → 精确/前缀 → 原排名 → 平台序），无权重；
 *   3. 缓存 60s TTL / 100 条容量 / 空结果不缓存；
 *   4. 单源超时返回 []，不拖垮其它源。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TIP_SOURCES,
  resolveTipProviders,
  mergeTipGroups,
  getCachedTips,
  setCachedTips,
  clearTipCache,
  fetchProviderTips,
} from '../src/server/utils/tipSearchSuggest'

test('resolveTipProviders: all 只展开 5 个 musicSdk 源', () => {
  assert.deepEqual(resolveTipProviders('all'), ['wy', 'tx', 'kw', 'kg', 'mg'])
  assert.equal(TIP_SOURCES.length, 5)
})

test('resolveTipProviders: kglite 转 kg，bili/soda 不伪造联想能力', () => {
  assert.deepEqual(resolveTipProviders('kglite'), ['kg'])
  assert.deepEqual(resolveTipProviders('bili'), [])
  assert.deepEqual(resolveTipProviders('soda'), [])
  assert.deepEqual(resolveTipProviders('unknown'), [])
})

test('resolveTipProviders: 选具体单源时只查该源', () => {
  for (const s of TIP_SOURCES) assert.deepEqual(resolveTipProviders(s), [s])
  assert.deepEqual(resolveTipProviders(''), ['kw'])
})

test('mergeTipGroups: 多源共推优先、精确匹配优先、去重、limit', () => {
  const groups = [
    ['周杰伦', '周杰伦 - 晴天', '林俊杰'],
    ['周杰伦', '周 杰 伦', '陈奕迅'],
    ['周杰伦 - 晴天'],
  ]
  const out = mergeTipGroups(groups, '周杰伦')
  assert.equal(out[0], '周杰伦', '三源共推 + 精确命中的词应排第一')
  assert.ok(out.includes('周杰伦 - 晴天'))
  assert.ok(!out.includes('林俊杰') || out.indexOf('林俊杰') > out.indexOf('周杰伦'))
  assert.equal(new Set(out).size, out.length, '不应有重复词')
  assert.ok(out.length <= 10)
})

test('mergeTipGroups: 非字符串与空串被丢弃', () => {
  const out = mergeTipGroups([['', '  ', 123 as any, '有效词'], []], '有效', 10)
  assert.deepEqual(out, ['有效词'])
})

test('缓存: 命中 / 60s 过期 / 容量 100 / 空结果不缓存', () => {
  clearTipCache()
  let now = 1000
  const clock = () => now
  assert.equal(getCachedTips('kw', '晴天', clock), null)
  setCachedTips('kw', '晴天', ['晴天', '晴天 - 周杰伦'], clock)
  assert.deepEqual(getCachedTips('kw', '晴天', clock), ['晴天', '晴天 - 周杰伦'])
  now = 1000 + 60_001
  assert.equal(getCachedTips('kw', '晴天', clock), null, '超过 60s 应过期')

  clearTipCache()
  now = 1000
  setCachedTips('kw', '', [], clock)
  assert.equal(getCachedTips('kw', '', clock), null, '空结果不缓存')

  for (let i = 0; i < 120; i++) setCachedTips('kw', `词${i}`, [`词${i}`], clock)
  assert.ok(true, '写入 120 条不抛异常')
  assert.deepEqual(getCachedTips('kw', '词119', clock), ['词119'])
  assert.equal(getCachedTips('kw', '词0', clock), null, '超出容量后最早条目被淘汰')
})

test('fetchProviderTips: 超时与异常都返回空数组，不拖垮其它源', async () => {
  const slow = () => new Promise(resolve => setTimeout(() => resolve(['慢词']), 50))
  assert.deepEqual(await fetchProviderTips('kw', 'x', slow, 5), [])
  assert.deepEqual(await fetchProviderTips('kw', 'x', async () => { throw new Error('boom') }, 50), [])
  assert.deepEqual(
    await fetchProviderTips('kw', 'x', async () => [' 有效 ', '', 42 as any, '第二条'], 50),
    [' 有效 ', '第二条'],
  )
})
