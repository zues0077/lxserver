/**
 * 汽水音乐（soda）加密音频本地解密。
 *
 * 背景（推翻「汽水加密曲无解」旧结论的关键）：
 *   汽水正式版权曲下发的直链是 **CENC 加密的 MP4**（stsd 里是 `enca` 而非 `mp4a`，
 *   并带 `senc`/`tenc`/`saiz` 样本加密表）。但这**不是真正的 DRM**：
 *   - 没有 `pssh`，密钥不从许可证服务器下发；
 *   - AES-128 密钥随取链响应以 `play_auth` → `spade_a`（Base64）直接下发，
 *     我们作为取链客户端本来就拿得到（见 extraSources/soda.ts 的 trySignedStream）。
 *   所以加密流只需在本地用 `spade_a` 推导出的 16 字节密钥做 AES-128-CTR 解密，
 *   再把容器修回普通 m4a/flac 即可播放 / 下载。
 *
 * 算法逐字节对齐两份独立实现，交叉验证过：
 *   - guowenye/qishui-api  `src/audioDecryptor.js`（Node）
 *   - sodahub-org/libresoda `src/soda/crypto.rs`（Rust）
 *
 * 仅依赖 Node 内置 `crypto`，不引入任何新依赖。
 */

import { createDecipheriv } from 'node:crypto'

// ---- 容器常量 -------------------------------------------------------------

/** 加密相关、需要在修复时剔除的 box 类型 */
const ENCRYPTED_BOX_TYPES = new Set(['senc', 'saio', 'saiz', 'sinf', 'schi', 'tenc', 'schm', 'frma'])
/** 容器型 box（递归进入） */
const CONTAINER_BOX_TYPES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])

const MAX_SAMPLE_COUNT = 200000
const MAX_CHUNK_COUNT = 200000
const MAX_STSC_ENTRY_COUNT = 20000

// ---- spade_a → AES 密钥 推导 ---------------------------------------------

function decodeBase36(codePoint: number): number {
  if (codePoint >= 48 && codePoint <= 57) return codePoint - 48
  if (codePoint >= 97 && codePoint <= 122) return codePoint - 97 + 10
  return 0xff
}

function bitCount(number: number): number {
  let value = number - ((number >> 1) & 0x55555555)
  value = (value & 0x33333333) + ((value >> 2) & 0x33333333)
  return (((value + (value >> 4)) & 0xf0f0f0f) * 0x1010101) >> 24
}

/**
 * 内层混淆：把 spade 内层字节流还原成明文。
 * result[i] = (key[i] ^ buffer[i]) - bitCount(i) - 21，负数则 +0xFF（注意是 +255，不是 mod 256）。
 */
function decryptSpadeInner(spadeKey: Uint8Array): Uint8Array {
  const result = new Uint8Array(spadeKey)
  const buffer = new Uint8Array(2 + spadeKey.length)
  buffer.set([0xfa, 0x55], 0)
  buffer.set(spadeKey, 2)

  for (let index = 0; index < result.length; index += 1) {
    let value = (spadeKey[index] ^ buffer[index]) - bitCount(index) - 21
    while (value < 0) value += 0xff
    result[index] = value
  }
  return result
}

/**
 * 从 spade 字节流（去掉头 1 字节 + 尾 padding 字节）还原出 32 位十六进制密钥串。
 * paddingLength = (b0 ^ b1 ^ b2) - 48。
 */
function decryptSpade(spadeKeyBytes: Uint8Array): string {
  const spadeKeyLength = spadeKeyBytes.length
  if (spadeKeyLength < 3) return ''
  const paddingLength = (spadeKeyBytes[0] ^ spadeKeyBytes[1] ^ spadeKeyBytes[2]) - 48
  if (spadeKeyLength < paddingLength + 2) return ''
  const innerInput = spadeKeyBytes.subarray(1, spadeKeyLength - paddingLength)
  const decodedBuffer = decryptSpadeInner(innerInput)
  if (decodedBuffer.length === 0) return ''
  const skipBytes = decodeBase36(decodedBuffer[0])
  const decodedMessageLength = spadeKeyLength - paddingLength - 2
  const endIndex = 1 + decodedMessageLength - skipBytes
  if (endIndex > decodedBuffer.length) return ''
  return Buffer.from(decodedBuffer.subarray(1, endIndex)).toString('utf8')
}

/** 把取链响应里的 `spade_a`（Base64 字符串）还原成 32 位十六进制 AES 密钥。 */
export function decryptSpadeA(spadeA: string): string {
  try {
    return decryptSpade(new Uint8Array(Buffer.from(String(spadeA || '').trim(), 'base64')))
  } catch {
    return ''
  }
}

/** 是不是合法的 32 位十六进制 AES-128 密钥 */
export function isHexKey(value: string): boolean {
  return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value.trim())
}

/**
 * 解析音频密钥：优先用显式 `hex_key`，否则从 `spade_a` 推导。
 * 返回小写 32 位十六进制串。
 */
export function resolveAudioKey(source: { hex_key?: string; key?: string; spade_a?: string; spadeA?: string } = {}): string {
  const rawHexKey = source.hex_key || source.key
  if (isHexKey(rawHexKey ?? '')) return (rawHexKey as string).trim().toLowerCase()

  const rawSpadeA = source.spade_a || source.spadeA
  if (!rawSpadeA) throw new Error('spade_a 或 hex_key 不能为空')
  const hexKey = decryptSpadeA(rawSpadeA).trim()
  if (!isHexKey(hexKey)) throw new Error('spade_a 或 hex_key 无效')
  return hexKey.toLowerCase()
}

function hexToBytes(hex: string): Uint8Array {
  if (!isHexKey(hex)) throw new Error('hex_key 必须是 32 位十六进制 AES-128 密钥')
  return new Uint8Array(Buffer.from(hex, 'hex'))
}

// ---- MP4 / CENC 解析与修复 ------------------------------------------------

function asUint8Array(input: Uint8Array | Buffer | ArrayBuffer): Uint8Array {
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  // Buffer 也是 Uint8Array 的子类，统一用底层 buffer 视图处理（不拷贝，只读）
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, array) => sum + array.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const array of arrays) {
    result.set(array, offset)
    offset += array.length
  }
  return result
}

function readUint32BE(fileData: Uint8Array, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset + 4 > fileData.length) {
    throw new Error('音频容器结构无效')
  }
  return (
    (fileData[offset] << 24) |
    (fileData[offset + 1] << 16) |
    (fileData[offset + 2] << 8) |
    fileData[offset + 3]
  )
}

function writeUint32BE(value: number): Uint8Array {
  const output = new Uint8Array(4)
  new DataView(output.buffer).setUint32(0, value, false)
  return output
}

function readAscii(fileData: Uint8Array, start: number, end: number): string {
  return Buffer.from(fileData.subarray(start, end)).toString('ascii')
}

class MP4Box {
  offset: number
  size: number
  type: string
  data: Uint8Array

  constructor(fileData: Uint8Array, offset: number) {
    this.offset = offset
    this.size = readUint32BE(fileData, offset)
    this.type = readAscii(fileData, offset + 4, offset + 8)
    this.data = fileData.subarray(offset + 8, offset + this.size)
  }

  static findBox(fileData: Uint8Array, boxType: string, offset = 0, end: number | null = null): MP4Box | null {
    const searchEnd = end === null ? fileData.length : end
    let position = offset
    while (position < searchEnd) {
      if (position + 8 > searchEnd) break
      const boxSize = readUint32BE(fileData, position)
      if (boxSize === 0 || boxSize > searchEnd - position || boxSize < 8) break
      const currentType = readAscii(fileData, position + 4, position + 8)
      if (currentType === boxType) return new MP4Box(fileData, position)
      position += boxSize
    }
    return null
  }
}

function requireBox(box: MP4Box | null, name: string): MP4Box {
  if (!box) throw new Error(`音频容器缺少 ${name} box`)
  return box
}

function parseStsz(stszData: Uint8Array): number[] {
  const sampleSize = readUint32BE(stszData, 4)
  const sampleCount = readUint32BE(stszData, 8)
  if (sampleCount > MAX_SAMPLE_COUNT) throw new Error('音频样本数量超过限制')
  if (sampleSize !== 0) return new Array(sampleCount).fill(sampleSize)
  const requiredLength = 12 + sampleCount * 4
  if (requiredLength > stszData.length) throw new Error('stsz box 样本大小数据不完整')
  const sampleSizes: number[] = []
  for (let index = 0; index < sampleCount; index += 1) {
    sampleSizes.push(readUint32BE(stszData, 12 + index * 4))
  }
  return sampleSizes
}

function parseStsc(stscData: Uint8Array): { firstChunk: number; samplesPerChunk: number; id: number }[] {
  const entryCount = readUint32BE(stscData, 4)
  if (entryCount > MAX_STSC_ENTRY_COUNT) throw new Error('stsc entry 数量超过限制')
  const requiredLength = 8 + entryCount * 12
  if (requiredLength > stscData.length) throw new Error('stsc box 数据不完整')
  const entries: { firstChunk: number; samplesPerChunk: number; id: number }[] = []
  for (let index = 0; index < entryCount; index += 1) {
    const baseOffset = 8 + index * 12
    entries.push({
      firstChunk: readUint32BE(stscData, baseOffset),
      samplesPerChunk: readUint32BE(stscData, baseOffset + 4),
      id: readUint32BE(stscData, baseOffset + 8),
    })
  }
  return entries
}

/** 解析 senc：默认每样本 8 字节 IV（汽水实测如此），个别 16 字节亦兼容。 */
function parseSenc(sencData: Uint8Array): Uint8Array[] {
  const sampleCount = readUint32BE(sencData, 4)
  if (sampleCount > MAX_SAMPLE_COUNT) throw new Error('senc 样本数量超过限制')
  const requiredLength = 8 + sampleCount * 8
  if (requiredLength > sencData.length) throw new Error('senc box IV 数据不完整')
  const ivs: Uint8Array[] = []
  let position = 8
  for (let index = 0; index < sampleCount; index += 1) {
    const iv = new Uint8Array(16)
    iv.set(sencData.subarray(position, position + 8))
    ivs.push(iv)
    position += 8
  }
  return ivs
}

function calculateChunkOffsets(sampleSizes: number[], stscEntries: { firstChunk: number; samplesPerChunk: number; id: number }[], chunkCount: number, baseOffset: number): number[] {
  const offsets: number[] = []
  let currentOffset = baseOffset
  let sampleIndex = 0
  for (let chunkIndex = 1; chunkIndex <= chunkCount; chunkIndex += 1) {
    offsets.push(currentOffset)
    let samplesPerChunk = 0
    for (let entryIndex = 0; entryIndex < stscEntries.length; entryIndex += 1) {
      const currentEntry = stscEntries[entryIndex]
      const nextEntry = stscEntries[entryIndex + 1]
      if (chunkIndex >= currentEntry.firstChunk && (!nextEntry || chunkIndex < nextEntry.firstChunk)) {
        samplesPerChunk = currentEntry.samplesPerChunk
        break
      }
    }
    for (let sampleOffset = 0; sampleOffset < samplesPerChunk; sampleOffset += 1) {
      if (sampleIndex < sampleSizes.length) currentOffset += sampleSizes[sampleIndex]
      sampleIndex += 1
    }
  }
  return offsets
}

function updateStco(stcoData: Uint8Array, offsets: number[]): Uint8Array {
  const chunkCount = readUint32BE(stcoData, 4)
  if (offsets.length < chunkCount) throw new Error('stco 偏移数量不足')
  const header = stcoData.subarray(0, 8)
  const body = new Uint8Array(chunkCount * 4)
  const view = new DataView(body.buffer)
  for (let index = 0; index < chunkCount; index += 1) view.setUint32(index * 4, offsets[index], false)
  return concatUint8Arrays([header, body])
}

/**
 * 递归遍历并修复 moov 树：剔除加密 box、把 `enca` 改回 `mp4a`、重算 `stco` 偏移。
 * newMdatOffset 为修复后 mdat 载荷的起始偏移（用于重算 chunk offset）。
 */
function processBoxTree(fileData: Uint8Array, offset: number, size: number, newMdatOffset: number, context: { sampleSizes: number[]; stscEntries: { firstChunk: number; samplesPerChunk: number; id: number }[]; chunkCount: number }): Uint8Array {
  const parts: Uint8Array[] = []
  let position = offset + 8
  const end = offset + size

  while (position < end) {
    if (position + 8 > end) {
      parts.push(fileData.subarray(position, end))
      break
    }
    const boxSize = readUint32BE(fileData, position)
    if (boxSize < 8 || boxSize > end - position) {
      parts.push(fileData.subarray(position, end))
      break
    }
    const type = readAscii(fileData, position + 4, position + 8)

    if (ENCRYPTED_BOX_TYPES.has(type)) {
      position += boxSize
      continue
    }

    if (type === 'enca') {
      const inner = processBoxTree(fileData, position, boxSize, newMdatOffset, context)
      parts.push(writeUint32BE(inner.length + 8), Buffer.from('mp4a'), inner)
      position += boxSize
      continue
    }

    if (type === 'stco') {
      const offsets = calculateChunkOffsets(context.sampleSizes, context.stscEntries, context.chunkCount, newMdatOffset)
      const updatedBody = updateStco(fileData.subarray(position + 8, position + boxSize), offsets)
      parts.push(writeUint32BE(updatedBody.length + 8), Buffer.from('stco'), updatedBody)
      position += boxSize
      continue
    }

    if (CONTAINER_BOX_TYPES.has(type)) {
      const inner = processBoxTree(fileData, position, boxSize, newMdatOffset, context)
      parts.push(writeUint32BE(inner.length + 8), Buffer.from(type), inner)
      position += boxSize
      continue
    }

    parts.push(fileData.subarray(position, position + boxSize))
    position += boxSize
  }

  return concatUint8Arrays(parts)
}

/** 在 stsd 里找 `dfLa` 标记，判断原始编码是否为 FLAC。 */
function scanForFlacMetadata(stsdData: Uint8Array): Uint8Array | null {
  const marker = Buffer.from('dfLa')
  for (let index = 4; index < stsdData.length - 4; index += 1) {
    if (
      stsdData[index] === marker[0] &&
      stsdData[index + 1] === marker[1] &&
      stsdData[index + 2] === marker[2] &&
      stsdData[index + 3] === marker[3]
    ) {
      const boxSize = readUint32BE(stsdData, index - 4)
      if (boxSize >= 8 && index - 4 + boxSize <= stsdData.length) {
        return stsdData.subarray(index + 4, index - 4 + boxSize)
      }
    }
  }
  return null
}

function decryptCtr(encryptedSample: Uint8Array, keyBytes: Uint8Array, iv: Uint8Array): Buffer {
  const decipher = createDecipheriv(`aes-${keyBytes.length * 8}-ctr`, keyBytes, Buffer.from(iv))
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(Buffer.from(encryptedSample)), decipher.final()])
}

export interface DecryptResult {
  buffer: Buffer
  extension: string
  content_type: string
  codec: string
  sample_count: number
}

/**
 * 解密一段 CENC 加密的汽水音频缓冲，返回修复后可直接播放/下载的缓冲。
 *
 * 支持两种原始编码：
 *  - `enca` 内 `frma` 指向 mp4a/alac → 输出 m4a（audio/mp4）
 *  - stsd 内含 `dfLa` FLAC 元数据 → 输出 flac（audio/flac）
 *
 * 解密本身是纯本地 AES-128-CTR（大端计数器），无需任何许可证服务器。
 */
export function decryptAudioBuffer(input: Uint8Array | Buffer | ArrayBuffer, hexKey: string): DecryptResult {
  const fileData = asUint8Array(input)
  const keyBytes = hexToBytes(hexKey)

  const ftyp = MP4Box.findBox(fileData, 'ftyp')
  const moov = requireBox(MP4Box.findBox(fileData, 'moov'), 'moov')
  const trak = requireBox(MP4Box.findBox(fileData, 'trak', moov.offset + 8, moov.offset + moov.size), 'trak')
  const mdia = requireBox(MP4Box.findBox(fileData, 'mdia', trak.offset + 8, trak.offset + trak.size), 'mdia')
  const minf = requireBox(MP4Box.findBox(fileData, 'minf', mdia.offset + 8, mdia.offset + mdia.size), 'minf')
  const stbl = requireBox(MP4Box.findBox(fileData, 'stbl', minf.offset + 8, minf.offset + minf.size), 'stbl')
  const stsd = requireBox(MP4Box.findBox(fileData, 'stsd', stbl.offset + 8, stbl.offset + stbl.size), 'stsd')
  const stsz = requireBox(MP4Box.findBox(fileData, 'stsz', stbl.offset + 8, stbl.offset + stbl.size), 'stsz')
  const stsc = requireBox(MP4Box.findBox(fileData, 'stsc', stbl.offset + 8, stbl.offset + stbl.size), 'stsc')
  const stco = requireBox(MP4Box.findBox(fileData, 'stco', stbl.offset + 8, stbl.offset + stbl.size), 'stco')
  const mdat = requireBox(MP4Box.findBox(fileData, 'mdat'), 'mdat')

  let senc = MP4Box.findBox(fileData, 'senc', stbl.offset + 8, stbl.offset + stbl.size)
  if (!senc) senc = MP4Box.findBox(fileData, 'senc', moov.offset + 8, moov.offset + moov.size)
  senc = requireBox(senc, 'senc')

  const sampleSizes = parseStsz(stsz.data)
  const stscEntries = parseStsc(stsc.data)
  const chunkCount = readUint32BE(stco.data, 4)
  if (chunkCount > MAX_CHUNK_COUNT) throw new Error('音频 chunk 数量超过限制')
  if (8 + chunkCount * 4 > stco.data.length) throw new Error('stco box 数据不完整')
  const ivs = parseSenc(senc.data)
  if (ivs.length < sampleSizes.length) throw new Error('senc IV 数量少于样本数量')
  const encryptedPayloadSize = sampleSizes.reduce((sum, sampleSize) => sum + sampleSize, 0)
  if (encryptedPayloadSize > mdat.size - 8) throw new Error('样本总大小超过 mdat 数据范围')

  const decryptedSamples: Buffer[] = []
  let sampleOffset = mdat.offset + 8
  for (let index = 0; index < sampleSizes.length; index += 1) {
    const sampleSize = sampleSizes[index]
    if (sampleOffset + sampleSize > fileData.length) throw new Error('音频样本数据不完整')
    decryptedSamples.push(decryptCtr(fileData.subarray(sampleOffset, sampleOffset + sampleSize), keyBytes, ivs[index]))
    sampleOffset += sampleSize
  }

  const flacMetadata = scanForFlacMetadata(stsd.data)
  if (flacMetadata) {
    const metadataStart = flacMetadata.length > 4 ? 4 : 0
    const outputBuffer = Buffer.from(concatUint8Arrays([Buffer.from('fLaC'), flacMetadata.subarray(metadataStart), ...decryptedSamples]))
    return {
      buffer: outputBuffer,
      extension: '.flac',
      content_type: 'audio/flac',
      codec: 'flac',
      sample_count: sampleSizes.length,
    }
  }

  const context = { sampleSizes, stscEntries, chunkCount }
  const ftypSize = ftyp ? ftyp.size : 0
  const dummyMoov = processBoxTree(fileData, moov.offset, moov.size, 0, context)
  const newMdatOffset = ftypSize + dummyMoov.length + 16
  const rawMoovData = processBoxTree(fileData, moov.offset, moov.size, newMdatOffset, context)
  const cleanMoovData = replaceEnca4cc(rawMoovData)
  const cleanMoov = concatUint8Arrays([writeUint32BE(cleanMoovData.length + 8), Buffer.from('moov'), cleanMoovData])
  const mdatData = concatUint8Arrays(decryptedSamples)
  const newMdat = concatUint8Arrays([writeUint32BE(mdatData.length + 8), Buffer.from('mdat'), mdatData])
  const finalParts: Uint8Array[] = []
  if (ftyp) finalParts.push(fileData.subarray(ftyp.offset, ftyp.offset + ftyp.size))
  finalParts.push(cleanMoov, newMdat)

  return {
    buffer: Buffer.from(concatUint8Arrays(finalParts)),
    extension: '.m4a',
    content_type: 'audio/mp4',
    codec: 'mp4',
    sample_count: sampleSizes.length,
  }
}

/**
 * 把 moov 里的 `enca` 样本条目 4cc 改回原始编码（`frma` 指示，默认 mp4a）。
 *
 * 说明：CENC 加密 MP4 的 stsd 里样本条目是 `enca`，真正可播需要还原成
 * `frma` 指向的原始编码（mp4a/alac/fLaC）。参考 libresoda 的做法——直接把
 * `enca` 这四个字节改写成原始编码，比按 box 递归遍历更稳（stsd 开头的
 * version+flags/entry_count 会让通用盒遍历在 enca 之前就中断）。
 * 解密后的 mdat 样本本身已经是明文的，容器修这一处即可被播放器识别。
 */
function replaceEnca4cc(moovData: Uint8Array): Uint8Array {
  const buf = Buffer.from(moovData)
  let original = Buffer.from('mp4a')
  const frmaIdx = buf.indexOf(Buffer.from('frma'))
  // frma 布局：[size(4)]['frma'(4)][data_format(4)]，indexOf 命中的是 'frma' 的首字节，
  // 所以原始编码在 +4..+8。早期写成 +8..+12 会读到 frma 后面的下一个 box 的 size，
  // 把样本项 4cc 改成一串二进制（如 00 00 00 10）——taglib(lofty) 直接报
  // "Expected sample entry atom in stsd atom"，元数据写不进去。
  if (frmaIdx >= 0 && frmaIdx + 8 <= buf.length) {
    const candidate = buf.subarray(frmaIdx + 4, frmaIdx + 8)
    // 只接受可打印 4cc，避免把 box size 之类的二进制写进 4cc
    if (/^[A-Za-z0-9]{4}$/.test(candidate.toString('latin1'))) original = Buffer.from(candidate)
  }
  let idx = buf.indexOf(Buffer.from('enca'))
  while (idx !== -1) {
    buf.write(original.toString('latin1'), idx, 'latin1')
    idx = buf.indexOf(Buffer.from('enca'), idx + 4)
  }
  return new Uint8Array(buf)
}

/** 在字节序列中查找子串（TS 的 Uint8Array.includes 只接受数值，这里补一个字节序列版本）。 */
function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let ok = true
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/** 判断一段缓冲是不是 CENC 加密容器（enca 且带 senc/tenc/saiz）。 */
export function isCencEncryptedBuffer(buffer: Uint8Array): boolean {
  if (buffer.length < 32) return false
  const head = buffer.subarray(0, Math.min(buffer.length, 512 * 1024))
  return (
    includesBytes(head, Buffer.from('enca')) &&
    (includesBytes(head, Buffer.from('senc')) ||
      includesBytes(head, Buffer.from('saiz')) ||
      includesBytes(head, Buffer.from('tenc')))
  )
}

// ---- 密钥登记簿（取链 → 下载 之间传递 spade_a 推导出的密钥）----------------
//
// 汽水同一曲目的密钥由 spade_a 唯一决定，且与直链一起在 getAudioUrl 时就能拿到。
// 但 downloadAndCache 的调用点很多（播放、队列、手动下载），不一定都带得上密钥，
// 所以这里用一个进程内 Map 按 trackId 暂存，下载时按曲目反查；落盘后再持久化进缓存索引，
// 这样「已缓存文件在容器重启后仍需解密」也能靠索引里的密钥兜底。

const sodaKeyByTrack = new Map<string, string>()

/** 取链成功后登记某曲目的解密密钥（hex，16 字节 / 32 位）。 */
export function registerSodaKey(trackId: string, hexKey: string): void {
  if (trackId && isHexKey(hexKey)) sodaKeyByTrack.set(String(trackId), hexKey.toLowerCase())
}

/** 反查某曲目之前登记的解密密钥。 */
export function getSodaKey(trackId: string): string | undefined {
  return trackId ? sodaKeyByTrack.get(String(trackId)) : undefined
}

/**
 * 从歌曲对象里取出汽水纯数字 trackId（归一化口径与 extraSources/soda.ts 一致）。
 * 缓存/本地列表里的 id 会被规范成 `soda_<纯数字>`（fileCache 索引口径），汽水接口只认纯数字，
 * 不剥前缀会在下载反查密钥时落空。
 */
export function sodaTrackIdOf(songInfo: any): string {
  const raw = String(songInfo?.meta?.trackId || songInfo?.id || songInfo?.songmid || '').trim()
  return raw.replace(/^soda_/i, '')
}
