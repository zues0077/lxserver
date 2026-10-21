/**
 * 从音频头部推断「这首歌到底有多长」。
 *
 * 为什么需要它：
 * 「播放完自动下一首」的时机完全靠时长判定，而手边能拿到的时长两个都不可靠——
 *  - 走 `player_play_music` 的机型上报的 duration 是**云端曲目元数据**，不是我们推的这首；
 *  - 播放器列表里的 `interval` 字段来自音源搜索接口，实测偏差很大（214 秒的歌标成 48 秒）。
 * 早了会截歌，晚了音箱已经把上一首重头播出来，听感就是「切歌不流畅」。
 *
 * 所以这里直接读文件头算时长：
 *  - MP3：有 Xing/Info 头用帧数，否则按「体积 ÷ 码率」（CBR）；
 *  - M4A/MP4：读 moov 里 mvhd 的 duration / timescale；
 *  - FLAC：读 STREAMINFO 的 totalSamples / sampleRate；
 *  - WAV：data chunk 大小 ÷ byteRate。
 * 局域网实测（320kbps CBR MP3）误差 < 1 秒，足够决定提前几秒切歌。
 */

export type AudioFormat = 'mp3' | 'flac' | 'ogg' | 'wav' | 'mp4' | 'aac' | 'ape' | ''

/** MPEG1 / MPEG2(2.5) Layer III 的码率表（kbps，index 1..14） */
const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]

/** 采样率表：3=MPEG1、2=MPEG2、0=MPEG2.5 */
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
}

const ascii = (buf: Buffer, start: number, end: number) => buf.toString('latin1', start, end)

/** ID3v2 标签总长度（含 10 字节头，可能有 10 字节 footer） */
export const id3v2Size = (head: Buffer): number => {
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return 0
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
  const footer = (head[5] & 0x10) !== 0 ? 10 : 0
  return 10 + size + footer
}

/**
 * MP3 时长。
 *
 * 优先 Xing/Info 里的总帧数（VBR 也准）；没有就按体积算——CBR 下准确，
 * VBR 无 Xing 头是罕见情况（说明这文件本身就不规范），此时宁可退回估算。
 */
const mp3DurationMs = (head: Buffer, totalBytes: number): number => {
  const tagSize = id3v2Size(head)
  let offset = tagSize
  while (offset + 4 < head.length) {
    if (head[offset] !== 0xff || (head[offset + 1] & 0xe0) !== 0xe0) {
      offset++
      continue
    }
    const b1 = head[offset + 1]
    const b2 = head[offset + 2]
    const versionBits = (b1 >> 3) & 0x03
    const layerBits = (b1 >> 1) & 0x03
    const bitrateIndex = (b2 >> 4) & 0x0f
    const sampleRateIndex = (b2 >> 2) & 0x03
    if (
      versionBits === 1 ||
      layerBits !== 1 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      sampleRateIndex === 3
    ) {
      offset++
      continue
    }
    const isMpeg1 = versionBits === 3
    const bitrate = (isMpeg1 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES)[bitrateIndex] * 1000
    const sampleRate = SAMPLE_RATES[isMpeg1 ? 3 : versionBits === 2 ? 2 : 0][sampleRateIndex]
    if (!bitrate || !sampleRate) {
      offset++
      continue
    }
    const samplesPerFrame = isMpeg1 ? 1152 : 576
    const mono = (head[offset + 3] >> 6) === 3
    const sideInfo = isMpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17)
    const xingAt = offset + 4 + sideInfo
    if (xingAt + 12 <= head.length) {
      const tag = ascii(head, xingAt, xingAt + 4)
      if (tag === 'Xing' || tag === 'Info') {
        const flags = head.readUInt32BE(xingAt + 4)
        if (flags & 0x01) {
          const frames = head.readUInt32BE(xingAt + 8)
          if (frames > 0) return Math.round((frames * samplesPerFrame * 1000) / sampleRate)
        }
      }
    }
    if (totalBytes > tagSize) return Math.round(((totalBytes - tagSize) * 8 * 1000) / bitrate)
    return 0
  }
  return 0
}

/** MP4/M4A 时长：遍历 box 找 moov → mvhd */
const mp4DurationMs = (head: Buffer): number => {
  const walk = (start: number, end: number): number => {
    let p = start
    while (p + 8 <= end) {
      let size = head.readUInt32BE(p)
      const type = ascii(head, p + 4, p + 8)
      let headerSize = 8
      if (size === 1) {
        if (p + 16 > end) return 0
        size = Number(head.readBigUInt64BE(p + 8))
        headerSize = 16
      }
      if (size === 0) size = end - p
      if (type === 'mvhd' && p + headerSize + 20 <= end) {
        const version = head[p + headerSize]
        const timescale =
          version === 0 ? head.readUInt32BE(p + headerSize + 12) : head.readUInt32BE(p + headerSize + 20)
        const duration =
          version === 0
            ? head.readUInt32BE(p + headerSize + 16)
            : Number(head.readBigUInt64BE(p + headerSize + 24))
        if (timescale > 0 && duration > 0) return Math.round((duration / timescale) * 1000)
      }
      if (type === 'moov' || type === 'trak' || type === 'mdia') {
        const inner = walk(p + headerSize, Math.min(p + size, end))
        if (inner) return inner
      }
      if (size <= 0) return 0
      p += size
    }
    return 0
  }
  return walk(0, head.length)
}

/** FLAC 时长：STREAMINFO 里的 totalSamples / sampleRate */
const flacDurationMs = (head: Buffer): number => {
  if (head.length < 8 + 18 || ascii(head, 0, 4) !== 'fLaC') return 0
  if ((head[4] & 0x7f) !== 0) return 0
  const p = 8
  const sampleRate = (head[p + 10] << 12) | (head[p + 11] << 4) | (head[p + 12] >> 4)
  const totalSamples = (head[p + 13] & 0x0f) * 2 ** 32 + head.readUInt32BE(p + 14)
  if (!sampleRate || !totalSamples) return 0
  return Math.round((totalSamples / sampleRate) * 1000)
}

/** WAV 时长：data chunk 大小 ÷ byteRate */
const wavDurationMs = (head: Buffer, totalBytes: number): number => {
  if (ascii(head, 0, 4) !== 'RIFF' || ascii(head, 8, 12) !== 'WAVE') return 0
  let byteRate = 0
  let dataSize = 0
  let p = 12
  while (p + 8 <= head.length) {
    const type = ascii(head, p, p + 4)
    const size = head.readUInt32LE(p + 4)
    if (type === 'fmt ' && p + 8 + 12 <= head.length) byteRate = head.readUInt32LE(p + 16)
    if (type === 'data') {
      // data size 有时被写成 0 / 0xFFFFFFFF（边录边写），此时用文件总长兜底
      dataSize = size > 0 ? size : Math.max(0, totalBytes - p - 8)
      break
    }
    p += 8 + size + (size % 2)
  }
  if (!byteRate || !dataSize) return 0
  return Math.round((dataSize / byteRate) * 1000)
}

/**
 * 由头部字节 + 整首体积推算时长（毫秒）。算不出来返回 0，调用方自行回退。
 */
export const detectAudioDurationMs = (head: Buffer, format: AudioFormat, totalBytes: number): number => {
  if (!head || head.length < 16) return 0
  try {
    switch (format) {
      case 'mp3':
        return mp3DurationMs(head, totalBytes)
      case 'mp4':
        return mp4DurationMs(head)
      case 'flac':
        return flacDurationMs(head)
      case 'wav':
        return wavDurationMs(head, totalBytes)
      default:
        return 0
    }
  } catch {
    return 0
  }
}

/** 头部解析不出时长时，是否值得再取一次文件尾部（MP4 的 moov 可能在尾部） */
export const audioDurationNeedsTail = (format: AudioFormat, head: Buffer): boolean =>
  format === 'mp4' && head.length >= 8 && mp4DurationMs(head) === 0 && id3v2Size(head) === 0
