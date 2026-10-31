import test from 'node:test'
import assert from 'node:assert'
import { titleSimilarity, pickClosestVideo } from '../src/server/extraSources/bilibili'

test('标题相似度：归一化后完全一致给 1（忽略标点/空格/全角）', () => {
  assert.equal(
    titleSimilarity('【推荐歌单】2026年最火的热门歌曲合集，好听的流行音乐合集', '【推荐歌单】2026年最火的热门歌曲合集, 好听的流行音乐合集'),
    1,
  )
})

test('标题相似度：包含关系给 0.8 以上（「标题｜分P版」这类）', () => {
  const score = titleSimilarity('2026年最火的热门歌曲合集｜分P版', '2026年最火的热门歌曲合集')
  assert.ok(score >= 0.8 && score < 1, `score=${score}`)
})

test('标题相似度：无关标题低于 0.5，空串给 0', () => {
  assert.ok(titleSimilarity('2026网络最好听100首热门歌曲，每一首都好听', '【推荐歌单】2026年最火的热门歌曲合集，好听的流行音乐合集') < 0.5)
  assert.equal(titleSimilarity('', '晴天'), 0)
  assert.equal(titleSimilarity('晴天', ''), 0)
})

test('标题相似度：搜索结果的 <em> 高亮标签不影响比对', () => {
  assert.equal(titleSimilarity('<em class="keyword">晴天</em>', '晴天'), 1)
})

test('挑最贴近的那条：跟 B站综合排序不同的真实场景（要第 2 条而不是第 1 条）', () => {
  const hits = [
    { name: '2026网络最好听100首热门歌曲，每一首都好听 🎧', id: 'BV1ANQqBTEVU' },
    { name: '<em class="keyword">【推荐歌单】2026年最火的热门歌曲合集，好听的流行音乐合集</em>', id: 'BV1R4HP6dEL3' },
    { name: '2026抖音爆火歌曲精选，全网最火的热门歌曲合集｜分P版', id: 'BV1PxeP6rEX9' },
  ]
  const { item, score } = pickClosestVideo(hits, '【推荐歌单】2026年最火的热门歌曲合集，好听的流行音乐合集')
  assert.equal(item?.id, 'BV1R4HP6dEL3')
  assert.equal(score, 1)
})

test('挑最贴近的那条：分数相同时保留靠前的（B站综合排序优先）', () => {
  const hits = [{ name: '晴天', id: 'A' }, { name: '晴天', id: 'B' }]
  assert.equal(pickClosestVideo(hits, '晴天').item?.id, 'A')
})

test('挑最贴近的那条：空列表返回 null 且分数 0', () => {
  const picked = pickClosestVideo([], '晴天')
  assert.equal(picked.item, null)
  assert.equal(picked.score, 0)
})
