import test from 'node:test'
import assert from 'node:assert'
import { decodeKeywordId, isKeywordAlbumId } from '../src/server/extraSources/bilibili'

test('B站虚拟专辑 id：中文关键词能完整往返（不会被 URL 编码吃掉）', () => {
  const id = `bili-kw|${Buffer.from('周杰伦 晴天', 'utf8').toString('base64url')}`
  assert.equal(isKeywordAlbumId(id), true)
  assert.equal(decodeKeywordId(id), '周杰伦 晴天')
})

test('B站虚拟专辑 id：真实 bvid 不会被误判成虚拟专辑', () => {
  assert.equal(isKeywordAlbumId('BV1xx411c7mD'), false)
  assert.equal(decodeKeywordId('BV1xx411c7mD'), '')
})

test('B站虚拟专辑 id：前缀对但内容坏了，返回空串而不是抛错', () => {
  assert.equal(decodeKeywordId('bili-kw|%%%'), '')
  assert.equal(decodeKeywordId(''), '')
})
