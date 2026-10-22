import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

/**
 * 音频转 mp3 封装（ffmpeg）。
 *
 * 为什么统一转 mp3：
 *  - 小爱音箱对 mp3 的兼容性最好，m4a/flac/ape 在部分固件上会出现「能拉流但不出声」「播一半停」
 *  - 统一格式后，缓存、流中转、切歌逻辑都只需处理一种容器，排查问题时变量更少
 *
 * 两条路径：
 *  1. 落盘转码（transcodeFileToMp3）：缓存命中但格式不是 mp3 时用，产物进歌曲缓存体系
 *  2. 流式转码（createMp3Transcoder）：直投远端地址时边转边发，首字节几乎无等待
 *
 * 已是 mp3 的源一律跳过，不做无损重编码（避免音质二次损失，也省 CPU）。
 */

/** ffmpeg 可执行文件路径（容器内一般就是 PATH 里的 ffmpeg，可用环境变量覆盖） */
export const ffmpegPath = (): string => String(process.env.FFMPEG_PATH || 'ffmpeg')

/** 默认转码码率：320k 对音箱而言已是上限，再高没有意义 */
export const DEFAULT_MP3_BITRATE = '320k'

let ffmpegAvailable: boolean | null = null

/**
 * ffmpeg 是否可用（带进程级缓存）。
 *
 * 镜像里没装 ffmpeg 时不能让整个投送链路跟着挂：
 * 探测失败就退回「原格式直投」，功能降级但播放可用。
 */
export const isFfmpegAvailable = async (): Promise<boolean> => {
  if (ffmpegAvailable !== null) return ffmpegAvailable
  ffmpegAvailable = await new Promise<boolean>(resolve => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      resolve(ok)
    }
    try {
      const proc = spawn(ffmpegPath(), ['-hide_banner', '-version'], { stdio: ['ignore', 'ignore', 'ignore'] })
      proc.on('error', () => finish(false))
      proc.on('close', code => finish(code === 0))
      setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* 忽略 */
        }
        finish(false)
      }, 5000)
    } catch {
      finish(false)
    }
  })
  if (!ffmpegAvailable) {
    console.warn(`[XiaoAi] 未找到 ffmpeg（${ffmpegPath()}），mp3 统一转码不可用，将按原格式投送`)
  }
  return ffmpegAvailable
}

/** 是否为 mp3 文件（先看扩展名，再看帧头，避免 .mp3 后缀装着 m4a 内容） */
export const isMp3File = (filePath: string): boolean => {
  if (path.extname(filePath).toLowerCase() !== '.mp3') return false
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(4)
    const read = fs.readSync(fd, buf, 0, 4, 0)
    if (read < 2) return false
    // ID3 标签
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true
    // MPEG 帧同步：0xFF 后接 0xE0 掩码
    return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 忽略 */
      }
    }
  }
}

export interface TranscodeOptions {
  bitrate?: string
  /** 尾部淡出秒数（0 = 不淡出）；需要同时给出 durationMs 才能算出起点 */
  fadeOutSec?: number
  /** 源音频总时长（毫秒），用于计算淡出起点 */
  durationMs?: number
  /**
   * 从第几秒开始产出（拖动进度条后的重新投送）。
   *
   * 小爱音箱没有 seek 指令，只能靠「产出一条以该位置开头的流 + 重新投送」实现跳转。
   * `-ss` 必须放在 `-i` **之前**（input seek）：放在后面是解码后再丢弃，等于把前面全部解一遍，
   * 一首 4 分钟的歌要多花几十秒。
   *
   * 注意：给了 seekSec 时，durationMs 要传「剩余时长」，淡出起点才会落在真正的曲尾。
   */
  seekSec?: number
}

/**
 * 组装 ffmpeg 参数。
 *
 * 淡出靠 afade 实现：`afade=t=out:st=<总时长-淡出> :d=<淡出>`。
 * 时长未知时不做淡出（宁可没有淡出，也不要把整首歌都压成渐弱）。
 */
export const buildFfmpegArgs = (source: string, options: TranscodeOptions = {}): string[] => {
  const bitrate = options.bitrate || DEFAULT_MP3_BITRATE
  const fadeSec = Math.max(0, Number(options.fadeOutSec) || 0)
  const durationMs = Number(options.durationMs) || 0
  const isRemote = /^https?:\/\//i.test(source)

  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error']
  // 降低探测开销：网络源默认要分析 5 秒/5MB 才出第一帧，音箱端就是「点了播放半天没声」
  args.push('-probesize', '1M', '-analyzeduration', '1000000')
  if (isRemote) {
    // 网络源偶发抖动时自动重连，避免转码中途断流（对本地文件无意义，故只给 http 源加）
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5')
  }
  // 起播位置：必须在 -i 之前才是「输入 seek」（直接跳到目标位置再解码），
  // 放在 -i 之后是「解码后丢弃」，本地文件尚可、远端源要多拉一大段数据。
  const seekSec = Math.max(0, Math.floor(Number(options.seekSec) || 0))
  if (seekSec > 0) args.push('-ss', String(seekSec))
  args.push('-i', source, '-vn')

  // 淡出至少要留 1 秒余量，短音频直接放弃淡出
  const durationSec = durationMs > 0 ? durationMs / 1000 : 0
  if (fadeSec > 0 && durationSec > fadeSec + 1) {
    const start = Math.max(0, durationSec - fadeSec)
    args.push('-af', `afade=t=out:st=${start.toFixed(2)}:d=${fadeSec.toFixed(2)}`)
  }
  args.push('-c:a', 'libmp3lame', '-b:a', bitrate, '-f', 'mp3')
  return args
}

export interface TranscodeResult {
  ok: boolean
  path?: string
  error?: string
  /** 本次真的调用了 ffmpeg（false 表示源本来就是 mp3，直接复用） */
  transcoded: boolean
}

/**
 * 把本地音频文件转成 mp3 并落盘（原子写：先写 .part 再 rename，避免半成品被读走）。
 * dest 已存在且是合法 mp3 时直接复用。
 */
export const transcodeFileToMp3 = async (
  sourcePath: string,
  destPath: string,
  options: TranscodeOptions = {},
): Promise<TranscodeResult> => {
  if (!fs.existsSync(sourcePath)) return { ok: false, error: '源文件不存在', transcoded: false }
  if (fs.existsSync(destPath) && isMp3File(destPath)) return { ok: true, path: destPath, transcoded: false }
  // 源本来就是 mp3：不必转码，直接告诉调用方复用源文件
  if (isMp3File(sourcePath)) return { ok: true, path: sourcePath, transcoded: false }
  if (!(await isFfmpegAvailable())) return { ok: false, error: 'ffmpeg 不可用', transcoded: false }

  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
  } catch (error: any) {
    return { ok: false, error: `创建目录失败：${error?.message || error}`, transcoded: false }
  }

  const partPath = `${destPath}.part`
  const args = [...buildFfmpegArgs(sourcePath, options), '-y', partPath]
  const startedAt = Date.now()

  return new Promise<TranscodeResult>(resolve => {
    let stderr = ''
    const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString()
    })
    proc.on('error', (error: any) => {
      resolve({ ok: false, error: error?.message || 'ffmpeg 启动失败', transcoded: false })
    })
    proc.on('close', code => {
      if (code !== 0) {
        try {
          if (fs.existsSync(partPath)) fs.unlinkSync(partPath)
        } catch {
          /* 忽略 */
        }
        resolve({ ok: false, error: stderr.trim().slice(0, 500) || `ffmpeg 退出码 ${code}`, transcoded: false })
        return
      }
      try {
        fs.renameSync(partPath, destPath)
      } catch (error: any) {
        resolve({ ok: false, error: `落盘失败：${error?.message || error}`, transcoded: false })
        return
      }
      const elapsed = Date.now() - startedAt
      console.log(`[XiaoAi] 转码完成 → ${path.basename(destPath)}（${(elapsed / 1000).toFixed(1)}s）`)
      resolve({ ok: true, path: destPath, transcoded: true })
    })
  })
}

export interface Mp3Transcoder {
  /** 转码后的 mp3 数据流 */
  stream: Readable
  /** 结束信息（含是否成功、ffmpeg 的错误输出） */
  done: Promise<{ ok: boolean; error?: string; bytes: number }>
  /** 中止转码 */
  kill: () => void
}

/**
 * 流式转码：ffmpeg 输出直连到 mp3 数据流。
 *
 * 用于「音箱直接按远端地址拉流」的场景——不必等整首转完，
 * 首个 mp3 帧出来就能往下发。同时把数据 tee 到磁盘（调用方负责），
 * 这样第二次拉流（音箱播完常会重拉）就能走本地文件 + Range。
 */
export const createMp3Transcoder = (source: string, options: TranscodeOptions = {}): Mp3Transcoder => {
  const args = [...buildFfmpegArgs(source, options), '-y', 'pipe:1']
  const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  let bytes = 0
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 4000) stderr += chunk.toString()
  })
  proc.stdout?.on('data', (chunk: Buffer) => {
    bytes += chunk.length
  })

  const done = new Promise<{ ok: boolean; error?: string; bytes: number }>(resolve => {
    let settled = false
    const finish = (result: { ok: boolean; error?: string; bytes: number }) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    proc.on('error', (error: any) => finish({ ok: false, error: error?.message || 'ffmpeg 启动失败', bytes }))
    proc.on('close', code => {
      if (code === 0) finish({ ok: true, bytes })
      else finish({ ok: false, error: stderr.trim().slice(0, 500) || `ffmpeg 退出码 ${code}`, bytes })
    })
  })

  return {
    stream: proc.stdout as unknown as Readable,
    done,
    kill: () => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
    },
  }
}
