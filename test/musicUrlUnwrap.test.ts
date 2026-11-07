/**
 * `musicUrl` 返回对象时的降级解包（回归）。
 *
 * 背景：宿主协议要求自定义源的 `musicUrl` 返回**字符串**。但「返回对象」是
 * 部分源自家 App 的私有扩展（豆包音源被禁用就是这么来的：对象 + 多声明 actions）。
 * 用户在意的其实是能不能出声，所以这里保守解包放行、同时留痕；
 * 认不出的对象仍然判失败——不能把 `{code:0}` 当成链接。
 *
 * 同时覆盖原有关卡没被破坏：404 链接、试听片段必须继续被拦。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateReturnedMusicUrl } from '../src/server/userApi'

test('字符串：原样返回，trim 掉首尾空白', () => {
  assert.equal(validateReturnedMusicUrl('https://a/b.mp3'), 'https://a/b.mp3')
  assert.equal(validateReturnedMusicUrl('  https://a/b.mp3  '), 'https://a/b.mp3')
})

test('返回对象：按 .url 解包（协议违规但可用，放行）', () => {
  assert.equal(validateReturnedMusicUrl({ url: 'https://a/b.mp3' }), 'https://a/b.mp3')
  assert.equal(validateReturnedMusicUrl({ musicUrl: 'https://a/b.mp3' }), 'https://a/b.mp3')
  assert.equal(validateReturnedMusicUrl({ link: 'https://a/b.mp3' }), 'https://a/b.mp3')
})

test('返回对象：嵌套一层也能解包', () => {
  assert.equal(validateReturnedMusicUrl({ data: { url: 'https://a/b.mp3' } }), 'https://a/b.mp3')
  assert.equal(validateReturnedMusicUrl({ result: { musicUrl: 'https://a/b.mp3' } }), 'https://a/b.mp3')
})

test('认不出的对象：失败，并在文案里点出实际字段（便于定位）', () => {
  assert.throws(() => validateReturnedMusicUrl({ code: 0, msg: 'ok' }), (e: any) => {
    assert.match(e.message, /未返回有效的链接字符串/)
    assert.match(e.message, /返回了对象/)
    assert.match(e.message, /code/)
    return true
  })
  assert.throws(() => validateReturnedMusicUrl({ url: 'not-a-url' }), /未返回有效的链接字符串/)
  assert.throws(() => validateReturnedMusicUrl(null), /未返回有效的链接字符串/)
  assert.throws(() => validateReturnedMusicUrl(undefined), /未返回有效的链接字符串/)
  assert.throws(() => validateReturnedMusicUrl(42), /未返回有效的链接字符串/)
})

test('非 http 字符串仍被拒', () => {
  // 非空但没有 http(s) 前缀 → 报「非播放链接内容」；空串 → 报「未返回有效的链接」
  assert.throws(() => validateReturnedMusicUrl('ftp://a/b.mp3'), /非播放链接内容/)
  assert.throws(() => validateReturnedMusicUrl(''), /未返回有效的链接字符串/)
})

test('回归：404 链接与试听片段仍被拦（解包路径也要拦）', () => {
  assert.throws(() => validateReturnedMusicUrl('https://a/404.html'), /404/)
  assert.throws(() => validateReturnedMusicUrl({ url: 'https://a/404.html' }), /404/)
  assert.throws(() => validateReturnedMusicUrl('https://a/x/jd-musicrep-ts/y.mp3'), /试听片段/)
  assert.throws(() => validateReturnedMusicUrl({ url: 'https://a/x/jd-musicrep-ts/y.mp3' }), /试听片段/)
  assert.throws(() => validateReturnedMusicUrl('https://a/rs02/x.mp3'), /试听片段/)
})

// ==================== /health 汇总口径 ====================

import { summarizeContractReports } from '../src/server/userApi'
import { inspectSourceContract } from '../src/server/sourceContract'

test('汇总：空列表全零，不产生 NaN', () => {
  assert.deepStrictEqual(summarizeContractReports([]), {
    checked: 0, compliant: 0, violating: 0, byIssue: {},
  })
})

test('汇总：合规源只计入 compliant，不进 byIssue', () => {
  const ok = inspectSourceContract({ kw: { name: 'a', actions: ['musicUrl'], qualitys: ['128k'] } })
  assert.deepStrictEqual(summarizeContractReports([ok]), {
    checked: 1, compliant: 1, violating: 0, byIssue: {},
  })
})

test('汇总：violating 按源计数，byIssue 按错误码计数且忽略 warn', () => {
  const bad = inspectSourceContract({ kw: { name: 'a', actions: ['musicUrl', 'lyric'], qualitys: ['128k'] } })
  const worse = inspectSourceContract({
    kw: { actions: ['lyric'], qualitys: [] },
    tx: { actions: ['pic'], qualitys: [] },
  })
  const warnOnly = inspectSourceContract({ kw: { actions: ['musicUrl'], qualitys: ['192k'] } })
  const s = summarizeContractReports([bad, worse, warnOnly])
  assert.strictEqual(s.checked, 3)
  assert.strictEqual(s.compliant, 1)
  assert.strictEqual(s.violating, 2)
  // bad: unsupported_actions ×1；worse: unsupported_actions ×2（两个平台）
  assert.strictEqual(s.byIssue.unsupported_actions, 3)
  // 未知音质档是 warn，不参与 byIssue
  assert.strictEqual(s.byIssue.unknown_quality, undefined)
})
