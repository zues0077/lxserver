/**
 * 自定义源错误描述兜底（回归：源抛 undefined 导致取链 500 且无提示）
 *
 * 背景：`/api/music/url` 里自定义源全部失败时，若某个源 `throw undefined`，
 * 旧代码在 catch 里拼 `音源日志：${error.message}` 会二次抛 TypeError，
 * 整个轮询循环被中断，最终返回 500 + "Cannot read properties of undefined"。
 * 修复后统一走 describeError()，任何抛出物都能拿到可读文案。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { describeError } from '../src/server/userApi'

test('describeError: undefined / null 不再产生空文案', () => {
  // 旧实现读 e.message → 直接抛 TypeError；这里必须安全返回
  const u = describeError(undefined)
  const n = describeError(null)
  assert.ok(typeof u === 'string' && u.length > 0)
  assert.ok(typeof n === 'string' && n.length > 0)
  assert.match(u, /未提供错误信息/)
})

test('describeError: 标准 Error 取 message', () => {
  assert.equal(describeError(new Error('酷狗歌曲ID不存在')), '酷狗歌曲ID不存在')
})

test('describeError: 纯字符串 / 数字 / 布尔', () => {
  assert.equal(describeError('取链超时'), '取链超时')
  assert.equal(describeError(404), '404')
  assert.equal(describeError(false), 'false')
  assert.ok(describeError('').length > 0) // 空字符串也要有占位，不能是空
})

test('describeError: 跨 vm 丢 message 的对象走 JSON / 类型标签', () => {
  assert.match(describeError({ code: 'E_FAIL' }), /E_FAIL/)
  assert.ok(describeError({}).length > 0)
  const circular: any = {}
  circular.self = circular
  assert.ok(describeError(circular).length > 0) // 循环引用不能抛
})

test('回归：模板拼接「音源日志：xxx」对任意抛出物都不抛异常', () => {
  const thrown: any[] = [undefined, null, '', 'err', 0, false, {}, new Error('boom')]
  for (const t of thrown) {
    assert.doesNotThrow(() => {
      const msg = `音源日志：${describeError(t)}`
      assert.ok(msg.startsWith('音源日志：'))
      assert.ok(msg.length > '音源日志：'.length)
    })
  }
})
