/**
 * sodaKey（extractSodaKey）自测 —— 用 `tsx --test test/sodaKey.test.ts` 运行。
 *
 * 为什么单独测它：246 实测出现过「签名通道明明返回了完整 CENC 加密整曲，却抓不到密钥」，
 * 排查时无法判断到底是「响应里真没有 spade_a」还是「自己写的解析器有 bug 导致误报」。
 * 后者尤其危险 —— 会把“能解密”误判成“不能解密”。所以这些用例专门用于证明解析器是好的。
 *
 * 覆盖点中最关键的一条：**spade_a 位于响应顶层 / 不在 play_auth 直接子键**。
 * 旧实现找到 play_auth 后只扫它的直接子键，正好漏掉这种形状（线上就是这么失败的）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractSodaKey } from '../src/server/extraSources/sodaKey'

// ---- 工具：把 32 位十六进制密钥编码成合法 spade_a（与 decryptSpadeA 互逆） ----

function bitCount(n: number): number {
  let v = n - ((n >> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333)
  return (((v + (v >> 4)) & 0xf0f0f0f) * 0x1010101) >> 24
}

function encodeSpade(hex: string): string {
  const plaintext = Buffer.from('0' + hex, 'utf8') // skip(1) + 32 hex bytes
  const L = plaintext.length
  const inner = Buffer.alloc(L)
  for (let j = 0; j < L; j += 1) {
    const B = j < 2 ? (j === 0 ? 0xfa : 0x55) : inner[j - 2]
    const R = plaintext[j]
    const C = bitCount(j) + 21
    inner[j] = ((R + C) ^ B) & 0xff
  }
  const b0 = (48 ^ inner[0] ^ inner[1]) & 0xff
  return Buffer.concat([Buffer.from([b0]), inner]).toString('base64')
}

const KEY = '00112233445566778899aabbccddeeff'
const SPADE = encodeSpade(KEY)

/** 失败路径会打 console.warn，测试里静音以免污染输出 */
function silenceWarn<T>(fn: () => T): T {
  const original = console.warn
  console.warn = () => { }
  try {
    return fn()
  } finally {
    console.warn = original
  }
}

test('extractSodaKey: play_auth.spade_a 标准形状能解出密钥', () => {
  const parsed = {
    status_info: { status_code: 0 },
    track_player: { video_model: { video_list: [{ main_url: 'https://cdn/1.m4a' }] } },
    play_auth: { spade_a: SPADE, other: 1 },
  }
  assert.equal(extractSodaKey(parsed), KEY)
})

test('extractSodaKey: spade_a 在 play_auth 更深层也能解出（旧实现只扫直接子键，会漏）', () => {
  const parsed = {
    play_auth: {
      nested: {
        deeper: { spade_a: SPADE },
      },
    },
  }
  assert.equal(extractSodaKey(parsed), KEY)
})

test('extractSodaKey: spade_a 在响应顶层（无 play_auth）也能解出（旧实现会漏）', () => {
  const parsed = {
    status_info: { status_code: 0 },
    track: { id: '123' },
    spade_a: SPADE,
  }
  assert.equal(extractSodaKey(parsed), KEY)
})

test('extractSodaKey: spade_a 藏在数组里也能解出', () => {
  const parsed = {
    items: [{ noop: true }, { play_auth: [{ spade_a: SPADE }] }],
  }
  assert.equal(extractSodaKey(parsed), KEY)
})

test('extractSodaKey: 键名大小写变体（playAuth / spadeA）能识别', () => {
  const parsedUpper = { PlayAuth: { SpadeA: SPADE } }
  assert.equal(extractSodaKey(parsedUpper), KEY)
  const parsedMixed = { playAuth: { spadeA: SPADE } }
  assert.equal(extractSodaKey(parsedMixed), KEY)
})

test('extractSodaKey: play_auth 里没有 spade_a、但响应别处有时仍能解出', () => {
  const parsed = {
    play_auth: { token: 'abc' }, // 同名但无用
    track_player: { extra: { spade_a: SPADE } },
  }
  assert.equal(extractSodaKey(parsed), KEY)
})

test('extractSodaKey: 真实无密钥响应（246 实测顶层键形状）返回空串，不是解析器失效', () => {
  // 这条用于确认「没抓到」确实等于「响应里没有」，避免把自己的 bug 误判成平台行为。
  const realWorldShape = {
    status_info: { status_code: 0, message: 'success' },
    lyric: {},
    track: { id: '7676337516358617115', duration: 237000 },
    track_player: { video_model: { video_list: [{ main_url: 'https://cdn/x.m4a' }] } },
    risk_result: {},
    expire_at: 1234567890,
  }
  const got = silenceWarn(() => extractSodaKey(realWorldShape))
  assert.equal(got, '', '无 play_auth / 无 spade_a 时应返回空串')
})

test('extractSodaKey: 同名字段存在但不是合法 spade_a 时返回空串', () => {
  const parsed = { play_auth: { spade_a: 'not-a-real-spade' } }
  const got = silenceWarn(() => extractSodaKey(parsed))
  assert.equal(got, '', '非法 spade_a 推导失败应返回空串而不是抛异常')
})

test('extractSodaKey: 畸形输入不抛异常', () => {
  for (const bad of [null, undefined, 42, 'string', [], {}]) {
    const got = silenceWarn(() => extractSodaKey(bad))
    assert.equal(got, '')
  }
})
