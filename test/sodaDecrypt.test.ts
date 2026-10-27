/**
 * sodaDecrypt 自测（用 `npm run test:unit` 即 `tsx --test test/sodaDecrypt.test.ts` 运行）。
 *
 * 三块验证：
 *  1) spade_a → AES 密钥推导的正反 round-trip（自实现可逆编码器，验证 decryptSpadeA 能还原密钥）；
 *  2) 合成一个最小合法 CENC m4a（enca + senc + stsz/stsc/stco），用 AES-128-CTR 加密后用
 *     decryptAudioBuffer 还原，断言 mdat 载荷逐字节等于明文、enca→mp4a 改写正确；
 *  3) 与参考实现 guowenye/qishui-api 的 audioDecryptor.js 在同源输入上输出一致（查转录错误，
 *     参考文件不存在时自动跳过）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import {
  decryptSpadeA,
  isHexKey,
  resolveAudioKey,
  decryptAudioBuffer,
  isCencEncryptedBuffer,
} from '../src/server/utils/sodaDecrypt'

// ---- 工具：最小 MP4 box 构造 ----------------------------------------------

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}

function box(type: string, payload: Buffer): Buffer {
  return Buffer.concat([u32(8 + payload.length), Buffer.from(type, 'ascii'), payload])
}

function bitCount(n: number): number {
  let v = n - ((n >> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333)
  return (((v + (v >> 4)) & 0xf0f0f0f) * 0x1010101) >> 24
}

/**
 * 把 32 位十六进制密钥编码成可被 decryptSpadeA 还原的 spade_a（与 decryptSpade 互逆）。
 * 仅用于测试：skip 字节取 '0'，padding 取 0（即 b0^inner[0]^inner[1] = 48）。
 */
function encodeSpade(hex: string): string {
  const plaintext = Buffer.from('0' + hex, 'utf8') // skip(1) + 32 hex bytes
  const L = plaintext.length
  const inner = Buffer.alloc(L)
  for (let j = 0; j < L; j += 1) {
    const B = j < 2 ? (j === 0 ? 0xfa : 0x55) : inner[j - 2]
    const R = plaintext[j]
    const C = bitCount(j) + 21
    const y = R + C // 本测试 R∈[48,102]、C∈[21,26]，恒走分支1（y<=255-C）
    inner[j] = (y ^ B) & 0xff
  }
  const b0 = (48 ^ inner[0] ^ inner[1]) & 0xff
  return Buffer.concat([Buffer.from([b0]), inner]).toString('base64')
}

// ---- 工具：合成一个最小 CENC m4a，并用给定密钥加密 mdat --------------------

function buildEncryptedSample(hexKey: string, samples: number[][]): Buffer {
  const keyBytes = Buffer.from(hexKey, 'hex')

  // 加密每个样本：AES-128-CTR，IV = [8字节随机, 0*8]
  const ivs: Buffer[] = []
  const cipherSamples: Buffer[] = []
  for (let i = 0; i < samples.length; i += 1) {
    const iv8 = Buffer.alloc(8)
    iv8.writeUInt32BE(i + 1, 4) // 简单确定性 IV
    ivs.push(iv8)
    const iv16 = Buffer.concat([iv8, Buffer.alloc(8)])
    const c = createCipheriv('aes-128-ctr', keyBytes, iv16)
    c.setAutoPadding(false)
    cipherSamples.push(Buffer.concat([c.update(Buffer.from(samples[i])), c.final()]))
  }

  // stsd：一个 enca 样本项（内层放 frma(mp4a) 以贴近真实结构）
  const frma = box('frma', Buffer.from('mp4a', 'ascii'))
  const enca = box('enca', frma)
  const stsd = box('stsd', Buffer.concat([u32(0), u32(1), enca]))

  // stsz：[version+flags(4)][sample_size(4)][sample_count(4)][sizes...]
  const stszPayload = [u32(0), u32(0), u32(samples.length)]
  for (const s of samples) stszPayload.push(u32(s.length))
  const stsz = box('stsz', Buffer.concat(stszPayload))

  // stsc：[version+flags(4)][entry_count(4)][firstChunk,samplesPerChunk,id]...
  const stsc = box('stsc', Buffer.concat([u32(0), u32(1), u32(1), u32(samples.length), u32(1)]))

  // stco：[version+flags(4)][entry_count(4)][offset...]（offset 占位，解密时按新 mdat 偏移重算）
  const stco = box('stco', Buffer.concat([u32(0), u32(1), u32(0)]))

  // senc：flags=0，每个样本 8 字节 IV
  const sencPayload = [u32(0), u32(samples.length)]
  for (const iv of ivs) sencPayload.push(iv)
  const senc = box('senc', Buffer.concat(sencPayload))

  const stbl = box('stbl', Buffer.concat([stsd, stsz, stsc, stco, senc]))
  const minf = box('minf', stbl)
  const mdia = box('mdia', minf)
  const trak = box('trak', mdia)
  const moov = box('moov', trak)

  const ftyp = box('ftyp', Buffer.concat([
    Buffer.from('isom', 'ascii'),
    Buffer.from('isom', 'ascii'),
    Buffer.from('iso2', 'ascii'),
    Buffer.from('mp41', 'ascii'),
  ]))

  const mdatPayload = Buffer.concat(cipherSamples)
  const mdat = box('mdat', mdatPayload)

  return Buffer.concat([ftyp, moov, mdat])
}

// ---- 测试 1：spade_a 推导 round-trip ---------------------------------------

test('isHexKey 识别 32 位十六进制', () => {
  assert.equal(isHexKey('00112233445566778899aabbccddeeff'), true)
  assert.equal(isHexKey('00112233445566778899aabbccddeef'), false)
  assert.equal(isHexKey('ZZ'), false)
})

test('resolveAudioKey 优先用 hex_key', () => {
  const hex = '00112233445566778899aabbccddeeff'
  assert.equal(resolveAudioKey({ hex_key: hex }), hex)
  assert.equal(resolveAudioKey({ key: hex.toUpperCase() }), hex) // 转小写
})

test('decryptSpadeA 能还原 encodeSpade 生成的 spade_a', () => {
  const cases = [
    '00112233445566778899aabbccddeeff',
    'deadbeefdeadbeefdeadbeefdeadbeef',
    'ffffffffffffffffffffffffffffffff',
    '0123456789abcdef0123456789abcdef',
  ]
  for (const hex of cases) {
    const spade = encodeSpade(hex)
    const back = decryptSpadeA(spade)
    assert.equal(back, hex, `spade_a 还原失败: ${hex} -> ${back}`)
  }
})

// ---- 测试 2：合成 CENC m4a 加解密 round-trip -------------------------------

test('decryptAudioBuffer 还原 enca CENC 为可播 m4a', () => {
  const hexKey = '00112233445566778899aabbccddeeff'
  const samples = [
    Array.from({ length: 100 }, (_, k) => (k * 7 + 3) & 0xff),
    Array.from({ length: 200 }, (_, k) => (k * 13 + 5) & 0xff),
    Array.from({ length: 150 }, (_, k) => (k * 29 + 11) & 0xff),
  ]
  const encrypted = buildEncryptedSample(hexKey, samples)
  assert.equal(isCencEncryptedBuffer(encrypted), true, '合成文件应被识别为 CENC')

  const out = decryptAudioBuffer(encrypted, hexKey)
  assert.equal(out.extension, '.m4a')
  assert.equal(out.content_type, 'audio/mp4')

  // enca 应被改回 mp4a，且 moov 容器内不再出现 enca（只检查 mdat 之前的部分，
  // 避免被随机明文载荷里恰好出现的 'enca' 字节序列误判）
  const mdatIdx = out.buffer.indexOf('mdat')
  assert.ok(mdatIdx >= 0, '输出应包含 mdat')
  const head = out.buffer.subarray(0, mdatIdx).toString('latin1')
  assert.ok(head.includes('mp4a'), 'moov 应包含 mp4a')
  assert.ok(!head.includes('enca'), 'moov 不应再包含 enca')

  // mdat 载荷应等于各明文样本拼接
  // box 结构为 [size(4)][type(4)][payload]，'mdat' 4cc 位于 box 内偏移 4，故 payload 从 idx+4 起
  const idx = out.buffer.indexOf('mdat')
  assert.ok(idx >= 0, '输出应包含 mdat')
  const payload = out.buffer.subarray(idx + 4)
  const expected = Buffer.concat(samples.map((s) => Buffer.from(s)))
  assert.equal(payload.length, expected.length, 'mdat 载荷长度应等于明文总长')
  assert.ok(payload.equals(expected), 'mdat 载荷应逐字节等于明文')
  assert.equal(out.sample_count, samples.length)
})

test('decryptAudioBuffer 在明文 m4a 上抛错（防御：不应误用）', () => {
  // 一个没有 senc 的普通文件：应抛错而不是静默返回
  const plain = box('ftyp', Buffer.from('isom', 'ascii'))
  assert.throws(() => decryptAudioBuffer(plain, '00112233445566778899aabbccddeeff'))
})

// ---- 测试 3：与参考实现交叉验证（可选） -------------------------------------

test('与参考 audioDecryptor.js 在同源输入上一致', () => {
  const refPath = 'D:/Documents/Temp/qsref/audioDecryptor.js'
  if (!existsSync(refPath)) {
    console.log('[skip] 参考实现不存在，跳过交叉验证')
    return
  }
  const require = createRequire(import.meta.url)
  const ref = require(refPath)

  const hexKey = '00112233445566778899aabbccddeeff'
  const samples = [
    Array.from({ length: 137 }, (_, k) => (k * 7 + 3) & 0xff),
    Array.from({ length: 256 }, (_, k) => (k * 13 + 5) & 0xff),
    Array.from({ length: 99 }, (_, k) => (k * 29 + 11) & 0xff),
  ]
  const encrypted = buildEncryptedSample(hexKey, samples)

  const mine = decryptAudioBuffer(encrypted, hexKey)
  const theirs = ref.decryptAudioBuffer(encrypted, hexKey)

  // 解密后的音频载荷（mdat）应逐字节一致：这是算法转录正确性的核心判据。
  // 容器修复（enca→原始编码 4cc）是我们新增的正确步骤，参考实现未做，故只比对音频载荷。
  const mdatOf = (b: Buffer): Buffer => {
    const i = b.indexOf('mdat')
    return b.subarray(i + 4)
  }
  assert.ok(mdatOf(mine.buffer).equals(mdatOf(theirs.buffer)), '解密音频载荷应与参考实现逐字节一致')
  assert.equal(mine.sample_count, theirs.sample_count)
})

// ---- 测试 4：trackId 归一化与密钥登记簿 --------------------------------------

import {
  sodaTrackIdOf,
  registerSodaKey,
  getSodaKey,
} from '../src/server/utils/sodaDecrypt'

test('sodaTrackIdOf 归一化汽水 id（剥 soda_ 前缀、meta/id/songmid 任选）', () => {
  assert.equal(sodaTrackIdOf({ meta: { trackId: '1234567890' } }), '1234567890')
  assert.equal(sodaTrackIdOf({ id: 'soda_1234567890' }), '1234567890')
  assert.equal(sodaTrackIdOf({ songmid: '9876543210' }), '9876543210')
  assert.equal(sodaTrackIdOf({ meta: { trackId: 'soda_555' } }), '555')
  assert.equal(sodaTrackIdOf({}), '')
})

test('registerSodaKey / getSodaKey 按 trackId 暂存并反查密钥', () => {
  const hex = '00112233445566778899aabbccddeeff'
  registerSodaKey('1234567890', hex)
  assert.equal(getSodaKey('1234567890'), hex)
  // 大小写归一
  registerSodaKey('trackA', 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF')
  assert.equal(getSodaKey('trackA'), 'deadbeefdeadbeefdeadbeefdeadbeef')
  // 未知曲目返回 undefined
  assert.equal(getSodaKey('nope'), undefined)
  // 非法密钥不登记
  registerSodaKey('bad', 'not-a-key')
  assert.equal(getSodaKey('bad'), undefined)
})

test('isCencEncryptedBuffer 对明文返回 false', () => {
  const plain = box('ftyp', Buffer.from('isom', 'ascii'))
  assert.equal(isCencEncryptedBuffer(plain), false)
  assert.equal(isCencEncryptedBuffer(Buffer.alloc(16)), false)
})
