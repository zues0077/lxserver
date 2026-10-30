/**
 * 出站 URL 编码的回归测试。
 *
 * 背景（2026-10-27 与 2026-10-30 两次实测）：音源与平台返回的直链常直接嵌中文
 * （`https://cdn/周杰伦 - 晴天.mp3`），needle 底层走 `url.parse()`，遇到未编码字符
 * 不是 warning 而是 throw —— 在 `verifyUrlPlayable` / 重定向解析里会被当成
 * 「链接不可播」，把能播的中文直链误杀；在日志里则表现为
 * `[异步警告] 脚本/网络未捕获异常: Request path contains unescaped characters`。
 *
 * 两条不变式：
 *   1. 编码只碰非可见 ASCII，已编码的 %XX 与保留字符原样保留（否则签名参数全废）；
 *   2. 源码里所有直接给 needle 传 URL 的调用点都必须先过 encodeRequestUrl。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { encodeRequestUrl, originOf } from '../src/utils/urlEncode'

test('中文路径与文件名被百分号编码', () => {
  assert.equal(
    encodeRequestUrl('https://cdn.example.com/周杰伦 - 晴天.mp3'),
    'https://cdn.example.com/%E5%91%A8%E6%9D%B0%E4%BC%A6%20-%20%E6%99%B4%E5%A4%A9.mp3',
  )
})

test('已编码的 %XX 与查询串保留字符不被二次编码', () => {
  const src = 'https://a/%E4%B8%AD%20x.mp3?auth=abc%2Fdef&t=1+2&s=%3D'
  assert.equal(encodeRequestUrl(src), src)
})

test('纯 ASCII URL 原样返回', () => {
  const src = 'https://a.example.com/path/to/file.flac?x=1&y=2'
  assert.equal(encodeRequestUrl(src), src)
})

test('全角符号 / 制表符等非可见 ASCII 一并编码', () => {
  assert.equal(encodeRequestUrl('https://a/歌.mp3?n=１'), 'https://a/%E6%AD%8C.mp3?n=%EF%BC%91')
  assert.equal(encodeRequestUrl('https://a/x\ty'), 'https://a/x%09y')
})

test('空值不抛异常（音源偶尔返回 undefined/null）', () => {
  assert.equal(encodeRequestUrl(''), '')
  assert.equal(encodeRequestUrl(undefined as any), '')
  assert.equal(encodeRequestUrl(null as any), '')
})

test('编码后的 URL 仍能被 WHATWG URL 解析（保证 Referer 推导不受影响）', () => {
  const url = encodeRequestUrl('https://cdn.example.com/中文/晴天.mp3')
  assert.doesNotThrow(() => new URL(url))
  assert.equal(originOf(url), 'https://cdn.example.com')
  assert.equal(originOf('not a url'), '')
})

/**
 * 守门断言：新增 needle 调用点必须显式编码。
 *
 * 允许的两种写法：
 *   needle('head', encodeRequestUrl(u), ...)   —— 就地编码
 *   const safeUrl = encodeRequestUrl(u); needle('head', safeUrl, ...)  —— 提前编码
 * 固定常量的接口地址（如身份识别用的 API_URL）走白名单。
 */
test('所有 needle 调用点都已编码', () => {
  const root = path.resolve(__dirname, '..')
  const files = [
    'src/server/server.ts',
    'src/server/userApi.ts',
    'src/server/coverProxy.ts',
    'src/server/customSourceHandlers.ts',
    'src/server/sourceProbe.ts',
    'src/server/musicAccount/http.ts',
    'src/server/utils/identify.ts',
  ]

  // 已经过编码的变量名 / 全 ASCII 固定常量
  const SAFE = new Set(['safeUrl', 'encoded', 'API_URL'])

  const offenders: string[] = []
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    // needle('<method>', <arg>, ...) / needle.request(...) / needle.get(<arg>, ...)
    const forms = [
      /needle(?:\.request)?\(\s*(?:'[a-z]+'|[A-Za-z_$][\w$]*)\s*,\s*([^,)\n]+)/g,
      /needle\.(?:get|head|post)\(\s*([^,)\n]+)/g,
    ]
    for (const re of forms) {
      for (const m of src.matchAll(re)) {
        const arg = m[1].trim()
        if (arg.startsWith('encodeRequestUrl(')) continue
        if (SAFE.has(arg)) continue
        // 源码里写死的字面量 URL，只要本身是纯 ASCII 就不必再过编码
        if (/^['"`]/.test(arg) && !/[^\x21-\x7e]/.test(arg)) continue
        offenders.push(`${rel}: ${arg}`)
      }
    }
  }

  assert.deepEqual(offenders, [], `以下 needle 调用未编码 URL，中文直链会抛 unescaped characters：\n${offenders.join('\n')}`)
})
