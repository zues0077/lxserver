import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { mp3CacheDir, mp3CacheKey } from './mp3Cache'
import { ffmpegPath, isMp3File } from './transcode'

/**
 * 拖动进度条用的「切片」。
 *
 * 小爱音箱没有 seek 指令（ubus 的 mediaplayer 里根本没有这个方法），它能做的只有
 * 「拿一个 URL 从头拉」。所以「跳到第 N 秒」在服务端只能表达成：
 *
 *   1. 产出一个**以第 N 秒开头**的音频文件（本地 mp3 用 `-ss` + `-c:a copy` 切，不重编码）
 *   2. 用指向它的新 token 重新投送一次（REPLACE_ALL）
 *
 * 这一步只处理「本地已有完整 mp3」的情况；远端源没法先切好再发（要等整段下载），
 * 那条路走 `transcode.createMp3Transcoder` 的流式 `-ss`，见 stream.ts 的说明。
 *
 * 产物落在 `<缓存根>/cache/<用户>/xiaoai/seek/`：
 *  - 和投送缓存同目录树，所以「权限与缓存限制」的容量统计、保留天数清理都管得到
 *  - 文件名带原曲 key + 目标秒数，同一个位置反复拖直接命中，不重复切
 */

/** 切片目录（不存在则创建） */
export const seekSliceDir = (username?: string): string => {
  const dir = path.join(mp3CacheDir(username), 'seek')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录创建失败交给上层报错 */
  }
  return dir
}

/** 某个跳转位置对应的切片文件路径 */
export const seekSlicePath = (
  username: string | undefined,
  songInfo: Record<string, any>,
  quality: string,
  seekSec: number,
): string => {
  const sec = Math.max(0, Math.floor(Number(seekSec) || 0))
  return path.join(seekSliceDir(username), `${mp3CacheKey(songInfo, quality)}_s${sec}.mp3`)
}

/** 同一首歌最多留几个切片：来回拖会产出很多，超过就淘汰最旧的 */
const MAX_SLICES_PER_TRACK = 6

/**
 * 清掉同一首歌多余的切片（按修改时间留最新 keep 个）。
 *
 * 只删已完成的 `.mp3`，`.part` 交给写它的那次请求自己收尾。
 * 失败一律忽略：清理是顺手做的事，不能让它影响这次跳转。
 */
export const pruneSeekSlices = (
  username: string | undefined,
  songInfo: Record<string, any>,
  quality: string,
  keep = MAX_SLICES_PER_TRACK,
): void => {
  try {
    const dir = seekSliceDir(username)
    const prefix = `${mp3CacheKey(songInfo, quality)}_s`
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.mp3'))
      .map((name) => {
        const full = path.join(dir, name)
        let mtime = 0
        try {
          mtime = fs.statSync(full).mtimeMs
        } catch {
          /* 刚被别的请求删掉 */
        }
        return { full, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const item of files.slice(Math.max(1, keep))) {
      try {
        fs.unlinkSync(item.full)
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 忽略 */
  }
}

export interface SliceResult {
  ok: boolean
  path?: string
  error?: string
  /** 命中了已有切片（同一位置反复拖不会重复切） */
  reused?: boolean
}

/**
 * 从本地 mp3 切出「从第 seekSec 秒开始」的一段，落到 destPath。
 *
 * 用 `-c:a copy`：mp3 → mp3 不重编码，一是快（几秒的歌只剩 IO 时间），二是没有二次音质损失。
 * `-ss` 放在 `-i` 前面是 input seek，ffmpeg 直接定位到最近的帧，不会把前面解一遍。
 *
 * 原子写：先写 `.part` 再 rename，半成品不会被音箱读到。
 */
export const sliceMp3FromFile = (sourcePath: string, seekSec: number, destPath: string): Promise<SliceResult> => {
  const sec = Math.max(0, Math.floor(Number(seekSec) || 0))
  if (!sourcePath || !fs.existsSync(sourcePath)) return Promise.resolve({ ok: false, error: '源文件不存在' })
  if (fs.existsSync(destPath) && isMp3File(destPath)) return Promise.resolve({ ok: true, path: destPath, reused: true })

  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
  } catch (error: any) {
    return Promise.resolve({ ok: false, error: `创建目录失败：${error?.message || error}` })
  }

  const partPath = `${destPath}.part`
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-ss',
    String(sec),
    '-i',
    sourcePath,
    '-vn',
    '-c:a',
    'copy',
    '-f',
    'mp3',
    '-y',
    partPath,
  ]

  return new Promise<SliceResult>((resolve) => {
    let stderr = ''
    let settled = false
    let proc: ReturnType<typeof spawn> | null = null
    const finish = (result: SliceResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    // 本地文件 copy 正常 100~400ms；卡住说明源有问题，别让请求一直挂着
    const timer = setTimeout(() => {
      try {
        proc?.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
      finish({ ok: false, error: '切片超时（30s）' })
    }, 30_000)

    try {
      proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error: any) {
      finish({ ok: false, error: error?.message || 'ffmpeg 启动失败' })
      return
    }
    if (!proc) {
      finish({ ok: false, error: 'ffmpeg 启动失败' })
      return
    }
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString()
    })
    proc.on('error', (error: any) => finish({ ok: false, error: error?.message || 'ffmpeg 启动失败' }))
    proc.on('close', (code) => {
      if (code !== 0) {
        try {
          if (fs.existsSync(partPath)) fs.unlinkSync(partPath)
        } catch {
          /* 忽略 */
        }
        finish({ ok: false, error: stderr.trim().slice(0, 300) || `ffmpeg 退出码 ${code}` })
        return
      }
      // ffmpeg 退出码 0 但产物可能是空的（seek 位置超出实际时长/源时长探测偏大），
      // 空文件发出去音箱会直接报播放失败，这里当成失败让上层退回原音源。
      let size = 0
      try {
        size = fs.statSync(partPath).size
      } catch {
        /* 产物没生成 */
      }
      if (size < 1024) {
        try {
          if (fs.existsSync(partPath)) fs.unlinkSync(partPath)
        } catch {
          /* 忽略 */
        }
        finish({ ok: false, error: `切片产物为空（${size}B），该位置可能超出音频实际时长` })
        return
      }
      try {
        fs.renameSync(partPath, destPath)
      } catch (error: any) {
        finish({ ok: false, error: `落盘失败：${error?.message || error}` })
        return
      }
      finish({ ok: true, path: destPath })
    })
  })
}
