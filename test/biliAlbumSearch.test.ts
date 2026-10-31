import test from 'node:test'
import assert from 'node:assert'
import {
  cleanAlbumKeyword,
  extractTitlePrefix,
  subsequenceCoverage,
  albumMatchScore,
} from '../src/server/extraSources/bilibili'

// 真实用例来自 2026-10-31 的实测：
// 用户把 B站合集标题整行粘进「专辑」搜索框，旧实现搜出「中国唱诗班--《相思》」，
// 而少吆名下明明有合集「合集·【神仙唱诗班】丨神仙唱歌给你听还不够你拽的」。

test('专辑关键词清洗：整行合集标题只留最前面的核心词', () => {
  assert.equal(
    cleanAlbumKeyword('合集：『神仙诗班』｜『神仙唱歌给你听还不够你拽的'),
    '神仙诗班',
  )
})

test('专辑关键词清洗：剥掉「合集·」前缀与【】包裹', () => {
  assert.equal(cleanAlbumKeyword('合集·【神仙唱诗班】丨杜甫《石壕吏》'), '神仙唱诗班')
  assert.equal(cleanAlbumKeyword('【周杰伦】范特西'), '周杰伦')
})

test('专辑关键词清洗：普通词原样保留，空串返回空串', () => {
  assert.equal(cleanAlbumKeyword('范特西'), '范特西')
  assert.equal(cleanAlbumKeyword('  八度空间  '), '八度空间')
  assert.equal(cleanAlbumKeyword(''), '')
})

test('专辑关键词清洗：只有标记没有内容时不会把标记当关键词', () => {
  const out = cleanAlbumKeyword('合集·')
  assert.ok(!out.startsWith('合集'), `out=${out}`)
})

test('字符覆盖率：漏字也算命中（神仙诗班 ⊂ 神仙唱诗班），无关词为 0', () => {
  assert.equal(subsequenceCoverage('神仙诗班', '神仙唱诗班'), 1)
  assert.equal(subsequenceCoverage('范特西', '合集·周杰伦范特西'), 1)
  assert.equal(subsequenceCoverage('范特西', '合集·真人快快打'), 0)
})

test('标题前缀：优先取方括号里的系列名', () => {
  assert.equal(extractTitlePrefix('【神仙唱诗班】丨杜甫《石壕吏》——【AI MV大赛】'), '神仙唱诗班')
  assert.equal(extractTitlePrefix('<em class="keyword">【神仙唱诗班】</em>丨李白'), '神仙唱诗班')
  assert.equal(extractTitlePrefix('《真仙歌》纯乐版——无字幕'), '真仙歌')
})

test('标题前缀：没有括号时按分隔符取第一段', () => {
  assert.equal(extractTitlePrefix('诗班献唱'), '诗班献唱')
  assert.equal(extractTitlePrefix('晴天 丨 翻唱版'), '晴天')
})

test('合集匹配：少吆的真合集要能被「神仙诗班」匹配上（旧 bigram 只有 0.2）', () => {
  const album = '合集·【神仙唱诗班】丨神仙唱歌给你听还不够你拽的'
  assert.ok(albumMatchScore('神仙诗班', album) >= 0.4, `score=${albumMatchScore('神仙诗班', album)}`)
  // 走「视频标题前缀」通道时更高
  assert.ok(albumMatchScore('神仙唱诗班', album) >= 0.8)
})

test('合集匹配：无关合集不得过门槛（否则会把别人合集当专辑塞给用户）', () => {
  assert.ok(albumMatchScore('神仙诗班', '合集·【真人快快打】系列丨影像模型动作类测试') < 0.4)
  assert.ok(albumMatchScore('范特西', '合集·【三分钟致郁你】丨爱别离，怨憎会，求不得') < 0.4)
  assert.ok(albumMatchScore('周杰伦', '合集·111') < 0.4)
})

test('合集匹配：完全一致给 1，包含关系给高分', () => {
  assert.equal(albumMatchScore('范特西', '范特西'), 1)
  assert.ok(albumMatchScore('范特西', '周杰伦 范特西') >= 0.8)
})
