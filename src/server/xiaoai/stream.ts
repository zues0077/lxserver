import fs from 'node:fs'
import { Readable } from 'node:stream'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getProxyAgent } from '../../modules/utils/proxy.js'
import { syncLog } from '../../utils/log4js'
import { buildStreamHeaders } from '../utils/streamHeaders'
import { audioDurationNeedsTail, detectAudioDurationMs, type AudioFormat } from './audioMeta'
import type { StreamTokenPayload } from './streamToken'
import { createMp3Transcoder, isFfmpegAvailable, isMp3File, transcodeFileToMp3 } from './transcode'

export type { AudioFormat }

/**
 * 把小爱音箱要播放的音频流转发出去。
 *
 * 音箱只会照 URL 拉流，所以：
 *  - 在线歌曲：由本服务做中转（带上 Referer/UA 回源），绕开音源防盗链与 http/https 混用问题
 *  - 本地文件：直接读盘返回
 * 两种目标都由签名 token 授权，token 过期即失效。
 */

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape',
}

const parseRange = (range: string | undefined, size: number) => {
  if (!range) return null
  const match = /bytes=(\d*)-(\d*)/.exec(range)
  if (!match) return null
  const start = match[1] ? Number(match[1]) : 0
  const end = match[2] ? Number(match[2]) : size - 1
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return null
  return { start, end: Math.min(end, size - 1) }
}

/** 每路流的传输统计：sid → 完整放过几遍（音箱播完会重拉同一 URL） */
const streamRounds = new Map<string, { full: number; bytes: number; total: number; replay: boolean; complete: boolean }>()

/** 读某一路流被拉过几遍（供 /status 下发给前端做「播完」判定） */
export const getStreamRounds = (sid?: string) =>
  sid
    ? streamRounds.get(sid) || { full: 0, bytes: 0, total: 0, replay: false, complete: false }
    : { full: 0, bytes: 0, total: 0, replay: false, complete: false }

/**
 * 传输过程中增量记字节。
 *
 * 之前只在整首传完后由 recordStreamRound 一次性累加，导致 5 分钟的长歌在播到第 1 分钟时
 * /status 的 streamBytes 恒为 0，排障时看不出「音箱到底有没有在拉」。这里按块累加。
 */
export const addStreamBytes = (sid: string | undefined, n: number) => {
  if (!sid || !n) return
  const current = streamRounds.get(sid)
  if (!current) return
  current.bytes += n
  if (streamRounds.size > 300) streamRounds.clear()
  streamRounds.set(sid, current)
}

/**
 * 已经「被换掉」的流。
 *
 * 音箱播完一首会立刻拿同一个 URL 再拉一遍（songloft-plugin-miot #437），
 * 而我们的 URL 半小时内都有效，于是它会真的把**上一首**从头再放一遍——
 * 前端这时候才投送下一首，耳朵里听到的就是「切歌前又响起上一首的头一两秒」。
 *
 * 所以每次投送新歌时，把此前所有流登记为作废：作废的 sid 再来拉，
 * 直接 410 打发掉。音箱拿不到数据就只能去切新地址，不会再重放旧歌。
 */
const retiredStreams = new Set<string>()

/**
 * 「放完这一遍就停」的流。
 *
 * 场景：用户在投送中途点「切回本机播放」。播放器不再投送下一首，于是音箱播完
 * 拿同一个 URL 重拉时，既等不到新歌（`retireStreams` 不触发），又会把整首再放一遍——
 * 实测会一直循环下去（217.6s 传输 + 4s 等待，无限重复）。
 *
 * 所以切回本机时把当前这一路标成 drainOnly：正在传的这次不受影响（这首照常完整播完），
 * 播完来重拉时直接 410，音箱就停住了。
 */
const drainOnlyStreams = new Set<string>()

/** 正在传输的连接：投送新歌时一并收尾，避免旧连接继续往音箱送旧歌数据 */
const liveStreams = new Map<string, Set<ServerResponse>>()

const rememberLive = (sid: string | undefined, res: ServerResponse) => {
  if (!sid) return
  const set = liveStreams.get(sid) || new Set<ServerResponse>()
  set.add(res)
  liveStreams.set(sid, set)
  // 连接收尾（正常结束 / 客户端断开）后就不再需要它了
  const forget = () => {
    const current = liveStreams.get(sid)
    if (!current) return
    current.delete(res)
    if (!current.size) liveStreams.delete(sid)
  }
  res.once('finish', forget)
  res.once('close', forget)
}

/**
 * 投送新歌前调用：作废旧流并收尾它们的连接。
 *
 * 返回被作废的流数量，供日志判断「切歌时是不是真的掐掉了上一首的重拉」。
 */
export const retireStreams = (keepSid?: string): number => {
  let killed = 0
  for (const [sid, responses] of liveStreams) {
    if (sid === keepSid) continue
    retiredStreams.add(sid)
    for (const res of responses) {
      try {
        // 还没开始发数据（正在「按住等切歌」的等待期）：由那条处理逻辑自己回 410，
        // 这里直接 end 的话客户端会收到一个 200 空响应，音箱会当成「没内容」而卡住。
        if (!res.headersSent) continue
        res.end()
      } catch {
        /* 已经断开了 */
      }
    }
    liveStreams.delete(sid)
    killed += 1
  }
  // 只要被换掉过的流，重拉请求一律拒绝；顺手把上限掐住，别无限涨
  if (retiredStreams.size > 500) {
    const drop = retiredStreams.size - 400
    let index = 0
    for (const sid of retiredStreams) {
      if (index++ >= drop) break
      retiredStreams.delete(sid)
    }
  }
  return killed
}

/** 这一路流是不是已经被换掉了（音箱在重拉旧歌） */
export const isRetiredStream = (sid?: string) => (sid ? retiredStreams.has(sid) : false)

/**
 * 把某一路流标成「放完即止」（切回本机播放时调用）。
 *
 * 与 retire 的区别：retire 是**立刻**断掉（切歌时用），drain 是让手上这首播完再停。
 * 返回 false 表示没有可标的 sid（还没投送过）。
 */
export const markDrainOnly = (sid?: string): boolean => {
  if (!sid) return false
  drainOnlyStreams.add(sid)
  if (drainOnlyStreams.size > 500) {
    const drop = drainOnlyStreams.size - 400
    let index = 0
    for (const item of drainOnlyStreams) {
      if (index++ >= drop) break
      drainOnlyStreams.delete(item)
    }
  }
  return true
}

/** 这一路流是不是处于「放完即止」状态 */
export const isDrainOnly = (sid?: string) => (sid ? drainOnlyStreams.has(sid) : false)

/**
 * 当前是否还有音频正在往音箱下发。
 *
 * 音源「自检护栏」在排查空闲 CPU 异常时会逐个卸载/重载自定义源脚本，
 * 而重载要在主线程里同步 eval 一整个（混淆过的）音源脚本，实测 2~3 秒——
 * 期间整个事件循环被卡住，正在下发的音频流会断流，音箱缓冲被抽干，
 * 听感就是「每隔几十秒断断续续 / 突然静音一两秒」。
 *
 * 所以护栏在有音频下发时必须让路。
 */
export const hasActiveStream = (): boolean => liveStreams.size > 0

/**
 * 标记「这一路流又开了一轮请求」。
 *
 * 音箱播完一遍后会立刻重拉同一个 URL（songloft-plugin-miot 的 issue #437 记录过同一现象）。
 * 重拉的**开始**就是最准的「已播完」信号，比等它把这轮传完（几十秒）快得多，
 * 所以这里在建立连接时就把 replay 置上，前端拿到就能马上切歌。
 * 前提是这一路已经完整传过一遍，否则投送后音箱的 Range 探测也会被当成重拉。
 */
/**
 * 这次请求是不是「从头拉整首」。
 *
 * 音箱的 Range 探测（bytes=0-63）、从中间续传（bytes=1000-）都不是重新放一遍，
 * 只有不带 Range 或从头覆盖大半首的请求，才算「这一轮开始重放」。
 */
const pullsFromStart = (rangeHeader: string | undefined, total: number): boolean => {
  if (!rangeHeader) return true
  const matched = /bytes=(\d*)-(\d*)/.exec(String(rangeHeader))
  if (!matched) return true
  const start = Number(matched[1] || 0)
  const end = matched[2] ? Number(matched[2]) : total - 1
  if (start !== 0) return false
  if (total <= 0) return true
  return end - start + 1 >= total * 0.5
}

const beginStreamRound = (sid: string | undefined, total: number, rangeHeader?: string) => {
  if (!sid) return
  const fromStart = pullsFromStart(rangeHeader, total)
  const current = streamRounds.get(sid) || { full: 0, bytes: 0, total: 0, replay: false, complete: false }
  // 「音箱又来拉同一首」= 它觉得歌放完了。这是切歌信号。
  // 关键：不能只看「是否从头拉」——音箱续拉时带的是 Range（起点不是 0），
  // 那样就永远判不出来，前端只能等墙钟，歌会被反复重放一大段。
  if (current.complete || (current.full >= 1 && fromStart)) current.replay = true
  if (total > 0) current.total = total
  if (streamRounds.size > 300) streamRounds.clear()
  streamRounds.set(sid, current)
}

/**
 * 记下「音箱又来拉同一首了」，并返回它是不是「整首放完后又来拉」。
 *
 * 整首放完后再来拉 = 音箱认为歌结束了 = 前端该切下一首了。
 * 这时如果马上把数据喂给它，音箱会把这一段**再播一遍**，
 * 听感就是「切歌的时候回放上一首的一部分」。
 */
const noteReplayRequest = (sid?: string): boolean => {
  if (!sid) return false
  const current = streamRounds.get(sid)
  if (!current) return false
  if (current.complete === true) {
    current.replay = true
    return true
  }
  return false
}

/**
 * 记录一次传输。
 *
 * 判据：单次传输量达到整首的一半，才算「放过一遍」。音箱偶尔会用 Range 分片拉，
 * 那种只补一小段的请求不能算，否则会把一首歌误判成播完。
 */
const recordStreamRound = (sid: string | undefined, sent: number, total: number, fromStart = true, countBytes = true) => {
  if (!sid || !sent || !total) return
  const current = streamRounds.get(sid) || { full: 0, bytes: 0, total: 0, replay: false, complete: false }
  // countBytes=false 用于「传输期间已按块累加过字节」的路径，避免结束时重复计数
  if (countBytes) current.bytes += sent
  current.total = total
  // 只认「从头开始且传够半首」的传输：中途 Range 续传可能也传了半首以上，但那是补片段
  if (fromStart && sent >= total * 0.5) current.full += 1
  // 整首都送出去了 → 音箱下一次再来拉就是「它觉得歌放完了」
  if (sent >= total * 0.98) current.complete = true
  if (streamRounds.size > 300) streamRounds.clear()
  streamRounds.set(sid, current)
}

/** 本地文件流 */
const serveLocalFile = (
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  filename?: string,
  sid?: string,
  durationMs = 0,
) => {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, message: '文件不存在' }))
    return
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, message: '不是有效文件' }))
    return
  }

  const contentType = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  const range = parseRange(req.headers.range as string | undefined, stat.size)
  beginStreamRound(sid, stat.size, req.headers.range as string | undefined)

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  if (filename) headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`

  const fromStart = pullsFromStart(req.headers.range as string | undefined, stat.size)

  /**
   * 本地文件也走「平滑下发」，和远端中转同一套逻辑。
   *
   * 原因：音箱的 TCP 接收窗口很小，服务器端哪怕停顿几秒，
   * 音箱手里的缓冲就会被抽干 → 听感是「突然静音一两秒 / 断断续续」。
   * （NAS 上实测存在「每 20 秒一次、持续约 3.2 秒」的整机卡顿，
   *   连 fnOS 原生 Web 接口都会被卡住，明显不是我们代码的问题。）
   *
   * 所以先把整首歌读进内存，再按码率匀速喂：
   * 起播先垫 PACING_LEAD_MS（30s）的量，之后按 1.1 倍实时慢慢给——
   * 音箱手里始终有几十秒余量，NAS 再怎么卡，它也听不出来。
   */
  const send = async () => {
    const startedAt = Date.now()
    let firstByteMs = -1
    let sent = 0
    /** 已统计但还没计入 streamRounds 的字节（按块累加） */
    let pendingBytes = 0
    try {
      const buf = await fs.promises.readFile(filePath)
      const total = buf.length
      const start = range ? range.start : 0
      const end = range ? range.end : total - 1
      const slice = buf.subarray(start, end + 1)

      res.writeHead(range ? 206 : 200, {
        ...headers,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
        'Content-Length': String(slice.length),
      })

      // 复用远端中转的 pumpDownstream：起播垫 30s，之后按 1.1 倍实时。
      // 必须切成小块：整首当一个 chunk 的话，节流预算只在写之前判断一次，
      // 一次性就全灌出去了（等于没有节流）。
      const CHUNK_SIZE = 64 * 1024
      const chunks: Buffer[] = []
      for (let i = 0; i < slice.length; i += CHUNK_SIZE) {
        chunks.push(slice.subarray(i, Math.min(i + CHUNK_SIZE, slice.length)))
      }
      const readable = Readable.from(chunks) as unknown as http.IncomingMessage
      ;(readable as any).headers = { 'content-length': String(slice.length) }
      readable.on('data', (chunk: Buffer) => {
        if (firstByteMs < 0) firstByteMs = Date.now() - startedAt
        sent += chunk.length
        // 按 256KB 粒度增量记账：/status 的 streamBytes 在长歌播放期间也能看到增长
        pendingBytes += chunk.length
        if (pendingBytes >= 256 * 1024) {
          addStreamBytes(sid, pendingBytes)
          pendingBytes = 0
        }
      })
      // Range 只传了整首的一部分，码率要按比例折算，否则节流会把这一段摊到整首的时长上
      const scaledMs = durationMs > 0 && total > 0 ? (durationMs * slice.length) / total : 0
      const stats = await pumpDownstream(readable, res, Math.round(scaledMs))
      if (pendingBytes > 0) {
        addStreamBytes(sid, pendingBytes)
        pendingBytes = 0
      }
      // 字节已在上面按块累加，这里只更新「拉了几遍 / 是否传完」
      recordStreamRound(sid, stats.sent || sent, total, fromStart, false)
      const pace = stats.paceLeadMs ? `（平滑 ${Math.round(stats.paceLeadMs / 1000)}s）` : '（无平滑/无时长）'
      syncLog.info(
        `[XiaoAi] 本地直发 ${filename || path.basename(filePath)}：已发 ${stats.sent}B / 总 ${total}B` +
          `${range ? `（${req.headers.range}）` : ''} ｜首字节 ${stats.firstByteMs}ms` +
          ` ｜耗时 ${(stats.elapsedMs / 1000).toFixed(1)}s${pace}`,
      )
    } catch (error: any) {
      try {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: error?.message || '本地文件读取失败' }))
      } catch {
        /* 客户端已断开 */
      }
    }
  }

  void send()
}

/**
 * 统一 mp3 中转：不管源是本地缓存还是远端地址，最终都以 mp3 发给音箱。
 *
 * 三种情况：
 *  1. 转码产物已存在 → 直接当本地文件发（支持 Range，最稳）
 *  2. 源是本地文件   → 先转码落盘，再按本地文件发（能拿到完整时长做尾部淡出）
 *  3. 源是远端地址   → 边转边发（首字节几乎无等待），同时 tee 到磁盘供下次复用
 *
 * ffmpeg 不可用时一律退回原格式直发：宁可没有 mp3，也不能让播放挂掉。
 */
const serveTranscodedMp3 = async (
  req: IncomingMessage,
  res: ServerResponse,
  payload: StreamTokenPayload,
) => {
  const durationMs = Number(payload.durationMs) || 0
  const fadeOutSec = Number(payload.fadeOutSec) || 0
  const seekSec = Math.max(0, Math.floor(Number(payload.seekSec) || 0))
  const filename = payload.filename || 'track.mp3'

  // 1. 已有转码产物
  //
  // seek 场景要额外校验：切片产物只认 seek 目录下的文件。否则 token 里若沿用了
  // `<缓存>/xiaoai/<key>.mp3`（整首），这里会命中它并从第 0 秒发出去 —— 拖动进度条
  // 看起来"没反应"，实际上是被这份完整缓存截胡了。
  const cachedMp3 = String(payload.mp3Path || '')
  const seekDirMark = `${path.sep}seek${path.sep}`
  const cachedUsable =
    !!cachedMp3 &&
    fs.existsSync(cachedMp3) &&
    isMp3File(cachedMp3) &&
    (seekSec <= 0 || cachedMp3.includes(seekDirMark))
  if (cachedUsable) {
    syncLog.info(`[XiaoAi] mp3 缓存命中，本地直发：${filename}${seekSec > 0 ? `（seek ${seekSec}s 切片）` : ''}`)
    serveLocalFile(req, res, cachedMp3, filename, payload.sid, durationMs)
    return
  }

  // 2. 源是本地文件
  if (payload.path) {
    // seek 时不能直接发整首：必须让 ffmpeg 带 `-ss` 重新产出一份，否则等于没跳。
    if (isMp3File(payload.path) && seekSec <= 0) {
      serveLocalFile(req, res, payload.path, filename, payload.sid, durationMs)
      return
    }
    const dest = cachedMp3 || `${payload.path}.mp3`
    const result = await transcodeFileToMp3(payload.path, dest, { fadeOutSec, durationMs, seekSec })

    if (result.ok && result.path) {
      serveLocalFile(req, res, result.path, filename, payload.sid, durationMs)
      return
    }
    console.warn(`[XiaoAi] 转码失败，按原格式直投：${filename}（${result.error || '未知原因'}）`)
    serveLocalFile(req, res, payload.path, filename, payload.sid, durationMs)
    return
  }

  const url = String(payload.url || '')
  if (!url) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, message: 'token 缺少播放目标' }))
    return
  }

  // 3. 远端地址：没有 ffmpeg 就原样中转
  if (!(await isFfmpegAvailable())) {
    await serveRemoteUrl(req, res, url, filename, payload.contentType, payload.sid, durationMs)
    return
  }

  beginStreamRound(payload.sid, 0, req.headers.range as string | undefined)
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store',
    // 转码是「边转边发」，总量未知，因此不支持断点续传
    'Accept-Ranges': 'none',
    'X-Accel-Buffering': 'no',
  })
  // 立刻把响应头推给音箱：ffmpeg 从网络源拉流要几秒才出第一帧，
  // 不先 flush 的话音箱在「收到响应」这一步就超时了（听感就是点了没反应）。
  res.flushHeaders?.()

  // tee：转码数据同时落盘，音箱播完重拉同一 URL 时就能命中本地文件
  let fileStream: fs.WriteStream | null = null
  let partPath = ''
  if (payload.mp3Path) {
    try {
      fs.mkdirSync(path.dirname(payload.mp3Path), { recursive: true })
      partPath = `${payload.mp3Path}.part`
      fileStream = fs.createWriteStream(partPath)
    } catch (error: any) {
      console.warn(`[XiaoAi] 转码产物落盘不可用：${error?.message || error}`)
      fileStream = null
    }
  }

  const startedAt = Date.now()
  let sent = 0
  const transcoder = createMp3Transcoder(url, { fadeOutSec, durationMs, seekSec })

  // 首字节迟迟不来时给一条可读告警：音箱端表现是「点了播放没声音」，
  // 光看「已发 0B」不知道是源慢还是 ffmpeg 出错，这里把两种信息都记下来。
  const firstByteTimer = setTimeout(() => {
    if (sent === 0) {
      syncLog.warn(`[XiaoAi] mp3 转码 12 秒仍无输出，源可能很慢或不可达：${filename}`)
    }
  }, 12000)
  ;(firstByteTimer as unknown as { unref?: () => void }).unref?.()

  // 注意：不能用 req 的 close 事件——IncomingMessage 的 close 在请求体读完就会触发，
  // 不是「客户端断开」，用它会在转码刚开始时就把 ffmpeg 杀掉。
  res.on('close', () => {
    if (!res.writableEnded) transcoder.kill()
  })

  transcoder.stream.on('data', (chunk: Buffer) => {
    sent += chunk.length
    if (fileStream) {
      // 磁盘背压不阻塞音箱：写不进去就丢掉这一段，宁可少一次缓存命中也不能卡播放
      try {
        fileStream.write(chunk)
      } catch {
        /* 忽略 */
      }
    }
    if (!res.write(chunk)) transcoder.stream.pause()
  })
  res.on('drain', () => transcoder.stream.resume())

  const finish = async () => {
    const outcome = await transcoder.done
    clearTimeout(firstByteTimer)
    try {
      if (fileStream) {
        await new Promise<void>(resolve => fileStream!.end(resolve))
      }
    } catch {
      /* 忽略 */
    }
    // 只有完整转完才把 .part 转正，中途失败的下次会重新转
    if (outcome.ok && partPath && payload.mp3Path) {
      try {
        fs.renameSync(partPath, payload.mp3Path)
      } catch (error: any) {
        console.warn(`[XiaoAi] 转码产物改名失败：${error?.message || error}`)
      }
    } else if (partPath) {
      try {
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath)
      } catch {
        /* 忽略 */
      }
    }
    if (!res.writableEnded) res.end()
    recordStreamRound(payload.sid, sent, sent, true)
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    if (outcome.ok) {
      syncLog.info(
        `[XiaoAi] mp3 流式转码完成 ${filename}：已发 ${sent}B ｜耗时 ${elapsed}s` +
          `${outcome.bytes !== sent ? `（ffmpeg 产出 ${outcome.bytes}B）` : ''}`,
      )
    } else {
      syncLog.warn(`[XiaoAi] mp3 流式转码中断 ${filename}：已发 ${sent}B ｜${outcome.error || '未知原因'}`)
    }
  }
  void finish()
}

/** 远端音频中转 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
/** 回源拿到的不是音频时，视为失败（音源失效或防盗链拦截） */
const NON_AUDIO_CONTENT = /^(application\/json|text\/html|text\/plain|application\/xml)/i

/**
 * 回源取流，遇到 3xx 时跟随 Location。
 *
 * 很多音源的接口本身就是个跳转器（例如 kw.php 直接 302 到 CDN），
 * 不跟随的话拿到的是空 body，音箱会提示「播放遇到问题稍后再试」。
 * 每一跳都要重新取代理（跳转后域名可能落在不同的代理规则里），Referer 也按当跳来源重设。
 */
const fetchUpstream = async (url: string, range?: string, timeoutMs = 30000) => {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // 部分音源按 UA/Referer 防盗链，伪装成浏览器取流；
    // Referer 必须按域名分流（B站要 bilibili.com，抖音系不能带），见 utils/streamHeaders
    const headers: Record<string, string> = buildStreamHeaders(current, {
      Accept: '*/*',
      'Accept-Encoding': 'identity',
    })
    if (range) headers.Range = range

    const agent = await getProxyAgent(current, 'music')
    const client = current.startsWith('https:') ? https : http
    let request!: http.ClientRequest
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request = client.get(current, { headers, agent: (agent as any) || undefined }, resolve)
      request.on('error', reject)
      request.setTimeout(timeoutMs, () => request.destroy(new Error('回源超时')))
    })

    const status = Number(response.statusCode) || 0
    const location = response.headers.location
    if (REDIRECT_STATUS.has(status) && location) {
      response.resume()
      try {
        current = new URL(location, current).toString()
      } catch {
        throw new Error(`回源跳转地址非法: ${location}`)
      }
      continue
    }
    return { response, finalUrl: current, status, request }
  }
  throw new Error(`回源跳转次数超过 ${MAX_REDIRECTS} 次`)
}

/** 读掉一小段非音频响应体，方便把音源的真实报错带进日志 */
const peekText = (upstream: http.IncomingMessage, limit = 160) =>
  new Promise<string>(resolve => {
    let text = ''
    upstream.setEncoding('utf8')
    upstream.on('data', (chunk: string) => {
      if (text.length < limit) text += chunk
    })
    upstream.on('end', () => resolve(text.slice(0, limit)))
    upstream.on('error', () => resolve(text.slice(0, limit)))
  })

/** 常见音频容器/编码的魔数判定（content-type 常常不可信） */
const looksLikeAudio = (head: Buffer) => {
  if (head.length < 4) return false
  const ascii = (start: number, end: number) => head.toString('latin1', start, end)
  if (ascii(0, 3) === 'ID3') return true // mp3 带 ID3 标签
  if (ascii(0, 4) === 'fLaC') return true // flac
  if (ascii(0, 4) === 'OggS') return true // ogg / opus
  if (ascii(0, 4) === 'RIFF') return true // wav
  if (ascii(0, 4) === 'MAC ') return true // ape
  if (head.length >= 8 && ascii(4, 8) === 'ftyp') return true // m4a / mp4
  if (ascii(0, 4) === 'ADIF') return true // aac
  // mp3 / aac 裸帧同步字：11 位全 1
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return true
  return false
}

/**
 * 从头部字节推断音频格式。
 *
 * 为什么要猜：音源站点经常把 AAC/MP4 的音频挂在 `?type=mp3` 这种地址上返回
 * `application/octet-stream`，而小爱音箱会按 URL 后缀和 Content-Type 决定怎么解码。
 * 交给它一个「.mp3 后缀 + m4a 内容」或者「octet-stream」的地址，它倾向于放弃外链、
 * 回退去播云端音源（听感上就是「一直在播同一首」），所以这里先把真实格式认出来。
 */
export const detectAudioFormat = (head: Buffer): AudioFormat => {
  if (head.length < 4) return ''
  const ascii = (start: number, end: number) => head.toString('latin1', start, end)
  if (ascii(0, 3) === 'ID3') return 'mp3'
  if (ascii(0, 4) === 'fLaC') return 'flac'
  if (ascii(0, 4) === 'OggS') return 'ogg'
  if (ascii(0, 4) === 'RIFF') return 'wav'
  if (ascii(0, 4) === 'MAC ') return 'ape'
  if (head.length >= 8 && ascii(4, 8) === 'ftyp') return 'mp4'
  if (ascii(0, 4) === 'ADIF') return 'aac'
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    // 帧同步字同时被 mp3 和 ADTS-AAC 使用，靠 layer 位区分
    const layerBits = (head[1] >> 1) & 0x03
    return layerBits === 0x01 ? 'mp3' : 'aac'
  }
  return ''
}

/** 格式 → Content-Type / URL 后缀 */
const AUDIO_META: Record<string, { mime: string; ext: string }> = {
  mp3: { mime: 'audio/mpeg', ext: '.mp3' },
  flac: { mime: 'audio/flac', ext: '.flac' },
  ogg: { mime: 'audio/ogg', ext: '.ogg' },
  wav: { mime: 'audio/wav', ext: '.wav' },
  mp4: { mime: 'audio/mp4', ext: '.m4a' },
  aac: { mime: 'audio/aac', ext: '.aac' },
  ape: { mime: 'audio/x-ape', ext: '.ape' },
}

/** 通用的「不知道具体类型」响应头，需要按真实格式覆盖 */
const GENERIC_CONTENT = /^(application\/(octet-stream|download|unknown)|binary\/octet-stream|text\/plain)?$/i

/** 由格式取 Content-Type（未知时回退 audio/mpeg） */
export const audioMimeOf = (format?: string) => AUDIO_META[String(format || '')]?.mime || 'audio/mpeg'

/** 由格式取 URL 后缀（未知时回退 .mp3） */
export const audioExtOf = (format?: string) => AUDIO_META[String(format || '')]?.ext || '.mp3'

const readHead = (upstream: http.IncomingMessage, limit = 64) =>
  new Promise<Buffer>(resolve => {
    let buffered = Buffer.alloc(0)
    const finish = () => {
      upstream.removeListener('data', onData)
      try {
        upstream.destroy()
      } catch {
        /* 已断开 */
      }
      resolve(buffered.subarray(0, limit))
    }
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length >= limit) finish()
    }
    upstream.on('data', onData)
    upstream.once('end', finish)
    upstream.once('close', finish)
    upstream.once('error', finish)
  })

export interface AudioProbeResult {
  ok: boolean
  status: number
  contentType: string
  /** 由文件头推断的真实封装格式（mp3 / mp4 / flac …），便于给出正确的后缀与 Content-Type */
  format: AudioFormat
  /** 由文件头解析出的真实时长（毫秒）；0 表示这份格式/这个源算不出来，调用方回退元数据 */
  durationMs: number
  /** 失败原因；成功时是 content-type + 实际字节数 */
  detail: string
  finalUrl: string
}

/** 探测时读取的头部字节数：既要够判断格式，也要够解析 MP3 帧头 / M4A 的 mvhd */
const HEAD_PROBE_BYTES = 8192
/** M4A 的 moov 在文件尾时，再补读这么多尾部字节 */
const TAIL_PROBE_BYTES = 64 * 1024

/** 取指定 Range 的若干字节（解析 moov 这类位于尾部的 box 用） */
const fetchRangeBytes = async (url: string, range: string, limit: number, timeoutMs: number) => {
  let response: http.IncomingMessage | null = null
  try {
    const result = await fetchUpstream(url, range, timeoutMs)
    response = result.response
    if (result.status >= 400) {
      response.resume()
      return { head: Buffer.alloc(0), totalBytes: 0 }
    }
    const totalBytes = Number(
      /\/(\d+)\s*$/.exec(String(response.headers['content-range'] || ''))?.[1] ||
        response.headers['content-length'] ||
        0,
    )
    const head = await readHead(response, limit)
    return { head, totalBytes }
  } catch {
    try {
      response?.destroy()
    } catch {
      /* 已断开 */
    }
    return { head: Buffer.alloc(0), totalBytes: 0 }
  }
}

/**
 * 投送前先探一下这个地址到底能不能出音频。
 *
 * 音源脚本只要解析出字符串就算「成功返回链接」，它不会去验证对方是不是还活着：
 * 比如 `music.nxinxz.com/wy.php` 整条接口已经 404，脚本照样返回一个看起来正常的 URL。
 * 把这种地址交给音箱，音箱只会提示「播放遇到问题，请稍后再试」——
 * 所以在投送前用 Range 取前 64 字节做一次判定，坏链直接换源，而不是丢给音箱试错。
 */
export const probeAudioSource = async (targetUrl: string, timeoutMs = 8000): Promise<AudioProbeResult> => {
  let response: http.IncomingMessage | null = null
  try {
    const result = await fetchUpstream(targetUrl, `bytes=0-${HEAD_PROBE_BYTES - 1}`, timeoutMs)
    response = result.response
    const status = result.status
    const contentType = String(response.headers['content-type'] || '')
    if (status >= 400) {
      response.resume()
      return {
        ok: false,
        status,
        contentType,
        format: '' as AudioFormat,
        durationMs: 0,
        detail: `HTTP ${status}`,
        finalUrl: result.finalUrl,
      }
    }
    if (NON_AUDIO_CONTENT.test(contentType)) {
      const detail = (await peekText(response)).replace(/\s+/g, ' ').trim().slice(0, 120)
      return {
        ok: false,
        status,
        contentType,
        format: '' as AudioFormat,
        durationMs: 0,
        detail: `${contentType || '非音频响应'}${detail ? `：${detail}` : ''}`,
        finalUrl: result.finalUrl,
      }
    }
    // 整首字节数：Range 响应里在 content-range 的 «/总长» 上，没有 Range 时才看 content-length
    const totalBytes = Number(
      /\/(\d+)\s*$/.exec(String(response.headers['content-range'] || ''))?.[1] ||
        response.headers['content-length'] ||
        0,
    )
    const head = await readHead(response, HEAD_PROBE_BYTES)
    if (!head.length) {
      return {
        ok: false,
        status,
        contentType,
        format: '' as AudioFormat,
        durationMs: 0,
        detail: '响应体为空',
        finalUrl: result.finalUrl,
      }
    }
    const format = detectAudioFormat(head)
    if (!format) {
      return {
        ok: false,
        status,
        contentType,
        format: '' as AudioFormat,
        durationMs: 0,
        detail: `不是音频字节（${contentType || '无 content-type'}）`,
        finalUrl: result.finalUrl,
      }
    }
    // 时长：切歌时机靠它，能算出来就用真实的，算不出返回 0 让调用方回退元数据
    let durationMs = detectAudioDurationMs(head, format, totalBytes)
    if (!durationMs && totalBytes > head.length && audioDurationNeedsTail(format, head)) {
      // M4A 的 moov 不一定在文件头（非 faststart），补读一次尾部再解析
      const tail = await fetchRangeBytes(
        result.finalUrl,
        `bytes=${Math.max(0, totalBytes - TAIL_PROBE_BYTES)}-${totalBytes - 1}`,
        TAIL_PROBE_BYTES,
        timeoutMs,
      )
      if (tail.head.length) durationMs = detectAudioDurationMs(tail.head, format, totalBytes)
    }
    return {
      ok: true,
      status,
      // 上游给 octet-stream / 空时，按真实格式归一化，后面拼 URL 与响应头都用这个值
      contentType: GENERIC_CONTENT.test(contentType) ? audioMimeOf(format) : contentType,
      format,
      durationMs,
      detail: `ok/${format}/${head.length}B${durationMs ? `/${Math.round(durationMs / 1000)}s` : ''}`,
      finalUrl: result.finalUrl,
    }
  } catch (error: any) {
    try {
      response?.destroy()
    } catch {
      /* 已断开 */
    }
    return {
      ok: false,
      status: 0,
      contentType: '',
      format: '' as AudioFormat,
      durationMs: 0,
      detail: error?.message || String(error),
      finalUrl: targetUrl,
    }
  }
}

/**
 * 下行预读窗口。
 *
 * 音箱读流是「慢慢读」的：它自己按播放节奏读，缓冲区满了就把 TCP 窗口关上。
 * 如果直接 `upstream.pipe(res)`，Node 的默认高水位只有 16KB，于是整首歌里会反复
 * 出现「暂停回源 → 缓冲区见底 → 恢复回源」，一次 274 秒的歌能有上千次这样的循环。
 * 每次恢复回源都要重新等 CDN 的 TCP 窗口展开（慢启动），音源那边稍微抖一下，
 * 这个抖动会原样传到音箱，听感就是「断断续续、卡一下」。
 *
 * 这里改成服务端先尽量把上游数据读进内存（最多 DOWNSTREAM_BUFFER_HIGH），
 * 再按音箱的节奏慢慢发：音源抖动被我们的缓冲吸收，回源也不会被反复掐断。
 */
const DOWNSTREAM_BUFFER_HIGH = 16 * 1024 * 1024
const DOWNSTREAM_BUFFER_LOW = 4 * 1024 * 1024
/** 队列里积压超过这个量、且长时间不消化，说明是音箱那头不读了 */
const DOWNSTREAM_STALL_BYTES = 256 * 1024
const DOWNSTREAM_STALL_MS = 6000
/** 上游连续这么久一个字节都没有（且不是我们主动暂停的）→ 判定回源死了 */
const UPSTREAM_SILENCE_MS = 60 * 1000

/**
 * 平滑下发的目标倍速。
 *
 * 实测小米音箱的播放缓冲只有二十秒上下，缓冲一空就断音（听感是「断断续续」）。
 * 所以策略不是「压到刚好实时」，而是**先把缓冲垫厚再略快维持**：
 * 起播时预灌 PACING_LEAD_MS 的音频，之后按 1.1 倍实时慢慢喂，
 * 缓冲只会往上涨不会掉，设备侧再怎么抖都还在安全区里。
 */
const PACING_FACTOR = 1.1
/** 起播预灌多少音频：这是设备抗抖动的安全垫，太小（3s）一点风浪就断 */
const PACING_LEAD_MS = 30000
/** 上限：设备明显跟不上时，允许把垫子抬到这么厚 */
const PACING_LEAD_MAX_MS = 90000
/** 队列剩余不足这么多字节，说明我们把音箱饿着了（节流压太狠），需要放宽 */
const PACING_HUNGRY_BYTES = 64 * 1024
/** 上游读完了但下游一直没读完（音箱不再读也不断开）：超过这么久强制收尾 */
const DOWNSTREAM_IDLE_GIVEUP_MS = 3 * 60 * 1000

/**
 * 「音箱不读了」的判定阈值（毫秒）。
 *
 * 判据是「多久没能往 res 写出数据」，不是「上游什么时候读完」——
 * 后者在本地缓存路径里是瞬间的事，早先按它计时会把正常播放的歌误杀
 * （表现为每首超过 180 秒的歌都在第 180 秒被掐断，尾巴丢掉 → 音箱重拉 → 回放）。
 */
const downstreamGiveupMs = (): number => {
  const v = Number(process.env.XIAOAI_DOWNSTREAM_GIVEUP_MS)
  return Number.isFinite(v) && v > 0 ? v : DOWNSTREAM_IDLE_GIVEUP_MS
}

/**
 * 按预算算出「还要等多久才能继续下发」。
 *
 * 预算 = (提前量 + 已过时间) × 码率 × 倍速。已经发出去的字节超过预算，就得等。
 * 抽成纯函数是为了能直接拿它做测试——真实链路上这里的错会让音箱饿着或一下被灌满。
 */
export const paceWaitMs = (
  bytes: number,
  elapsedMs: number,
  ratePerMs: number,
  leadMs: number,
  factor = PACING_FACTOR,
): number => {
  if (!leadMs || !ratePerMs) return 0
  const rate = ratePerMs * factor
  const allowed = (leadMs + Math.max(0, elapsedMs)) * rate
  if (bytes <= allowed) return 0
  return Math.max(0, bytes / rate - leadMs - Math.max(0, elapsedMs))
}

interface PumpStats {
  bytes: number
  /** 实际上写进 res（交给音箱）的字节；和上游字节一比就知道是不是被节流/没发完 */
  sent: number
  /** 拿到上游首字节花了多久（音箱起播前的等待主要在这里） */
  firstByteMs: number
  /** 音箱侧最长一次「不读」持续了多久；有值就说明卡顿发生在设备侧 */
  maxStallMs: number
  /** 整段传输耗时（到最后一段数据交给内核）：和音频时长一比就知道谁慢 */
  elapsedMs: number
  /** 上游读完用了多久；远小于 elapsedMs 说明音源很快、慢的是音箱在按播放节奏读 */
  upstreamMs: number
  /** 实际生效的提前量（毫秒），0 表示这首没做平滑（没有可信时长） */
  paceLeadMs: number
  /** 因为设备跟不上而放宽过几次 */
  paceRelaxed: number
}

/**
 * 把回源数据交给音箱。
 *
 * 两个关键点：
 *  1. 服务端要跑在音箱前面——先把音源尽量读进内存，后续音箱怎么慢读都不再受音源抖动影响。
 *  2. 交出去的时候要「平滑」——按音频码率匀速喂，而不是能塞多少塞多少。
 *     音箱的接收缓冲一满就关 TCP 窗口、一空就猛读，这种一冷一热的节奏很容易让它
 *     解码器下溢，听感就是「突然静音一两秒」。
 */
/**
 * 把回源数据交给音箱。
 *
 * 三件事必须同时做到，缺一样听感就会坏：
 *
 *  1. **音源要尽快读进内存**：音箱按播放节奏慢读，如果直接拿它的节奏去拉音源，
 *     音源一抖就直传到耳朵里，而且长时间挂着不动还会被 CDN 判空闲断开（下首歌直接没声）。
 *  2. **写下游要平滑**：音箱的接收缓冲很小，网络一股脑灌进来它来不及消费，
 *     中途就会「吃掉一段 → 静音一两秒 → 重连重拉」。按码率匀速喂（1.15 倍实时）
 *     能让它一直保持有货、又不至于被灌爆。
 *  3. **两边要分开算**：读上游按「攒够多少」，写下游按「过了多少时间」。
 */
const pumpDownstream = (upstream: http.IncomingMessage, res: ServerResponse, durationMs = 0) =>
  new Promise<PumpStats>(resolve => {
    const startedAt = Date.now()
    /** 从上游收到的总字节（日志与 Range 统计用） */
    let bytes = 0
    /** 已经写进 res 的字节（节流预算按它算） */
    let sentBytes = 0
    let firstByteMs = -1
    let pausedByBuffer = false
    let maxStallMs = 0
    let stalledSince: number | null = null
    let lastConsumedAt = Date.now()
    let lastDataAt = Date.now()
    let upstreamMs = -1
    let upstreamEnded = false
    let settled = false
    let writeBusy = false
    let paceTimer: NodeJS.Timeout | null = null
    let paceLeadMs = 0
    let paceRelaxed = 0
    /** 待下发的数据（服务端自己的缓冲区，和 res 的写队列分开算） */
    const pending: Buffer[] = []
    let pendingBytes = 0

    // 只有拿到「总字节 + 真实时长」才谈得上匀速喂；否则退回纯背压
    const totalBytes = Number(
      /\/(\d+)\s*$/.exec(String(upstream.headers['content-range'] || ''))?.[1] ||
        upstream.headers['content-length'] ||
        0,
    )
    const ratePerMs = durationMs > 0 && totalBytes > 0 ? totalBytes / durationMs : 0
    // 真实音频是几十 bytes/ms（320kbps≈40），原来写的 `ratePerMs < 1` 会把所有真歌都挡在节流之外，
    // 退化成纯背压，于是「断断续续」。这里只挡住 0 与明显异常的超大值（>2000≈1.6Mbps，远超任何音源）。
    if (ratePerMs > 0.001 && ratePerMs < 2000) paceLeadMs = PACING_LEAD_MS

    const settle = () => {
      if (settled) return
      settled = true
      clearInterval(monitor)
      if (paceTimer) clearTimeout(paceTimer)
      upstream.removeListener('data', onData)
      res.removeListener('finish', onFinish)
      res.removeListener('drain', onDrain)
      for (const event of ['end', 'close', 'error']) upstream.removeListener(event, onUpstreamGone)
      res.removeListener('close', settle)
      resolve({
        bytes,
        sent: sentBytes,
        firstByteMs,
        maxStallMs,
        elapsedMs: Date.now() - startedAt,
        upstreamMs: upstreamMs >= 0 ? upstreamMs : Date.now() - startedAt,
        paceLeadMs,
        paceRelaxed,
      })
    }

    const syncUpstreamPause = () => {
      // 自己的缓冲攒够了就暂停回源，消化一部分再放开；下游写阻塞由 pumpWrites 自己等
      if (pausedByBuffer) upstream.pause()
      else upstream.resume()
    }

    /** 尽力把缓冲里的数据按预算写出去；预算用完就定个闹钟，一有 drain 也立刻续上 */
    const pumpWrites = () => {
      if (settled || writeBusy) return
      while (pending.length) {
        const wait = paceWaitMs(sentBytes, Date.now() - startedAt, ratePerMs, paceLeadMs)
        if (wait > 5) {
          if (paceTimer) clearTimeout(paceTimer)
          paceTimer = setTimeout(() => {
            paceTimer = null
            // 缓冲快见底说明我们把音箱饿着了：不是设备慢，是我们压太狠
            if (!res.writableEnded && pendingBytes < PACING_HUNGRY_BYTES && paceLeadMs && paceLeadMs < PACING_LEAD_MAX_MS) {
              paceLeadMs = Math.min(PACING_LEAD_MAX_MS, paceLeadMs + 2000)
              paceRelaxed += 1
            }
            pumpWrites()
          }, Math.max(50, Math.min(500, Math.ceil(wait))))
          return
        }
        const chunk = pending.shift() as Buffer
        pendingBytes -= chunk.length
        if (pendingBytes <= DOWNSTREAM_BUFFER_LOW && pausedByBuffer) {
          pausedByBuffer = false
          syncUpstreamPause()
        }
        sentBytes += chunk.length
        lastConsumedAt = Date.now()
        let ok = true
        try {
          ok = res.write(chunk)
        } catch {
          return
        }
        if (!ok) {
          // 写缓冲满了：等 drain 再继续。这里必须挂上监听再返回，
          // 否则「既没有 timer 也没有 drain」时数据会永远停住（听感就是彻底静音）
          writeBusy = true
          res.once('drain', onDrain)
          return
        }
      }
      if (upstreamEnded && !res.writableEnded) {
        try {
          res.end()
        } catch {
          /* 下游已断开 */
        }
      }
    }

    const onData = (chunk: Buffer) => {
      if (firstByteMs < 0) firstByteMs = Date.now() - startedAt
      lastDataAt = Date.now()
      bytes += chunk.length
      pending.push(chunk)
      pendingBytes += chunk.length
      if (!pausedByBuffer && pendingBytes >= DOWNSTREAM_BUFFER_HIGH) {
        pausedByBuffer = true
        syncUpstreamPause()
      }
      pumpWrites()
    }
    const onDrain = () => {
      writeBusy = false
      pumpWrites()
    }
    const onFinish = () => settle()
    const onUpstreamGone = () => {
      if (upstreamMs < 0) upstreamMs = Date.now() - startedAt
      upstreamEnded = true
      pumpWrites()
      if (res.writableFinished) {
        settle()
        return
      }
      // 这里**不能**因为「上游读完了」就上放弃计时器。
      // 本地缓存路径的上游是一段内存流、瞬间就读完了，而音箱还在按实时节奏慢慢听，
      // 之前无脑计时 → 每一首超过 180 秒的歌都在第 180 秒被掐断，尾巴丢掉，
      // 音箱随后重拉那一段 → 听感就是「切歌时回放上一首的一部分」。
      // 真正的「音箱不听了」要看「多久没能写出数据」，由下面的 monitor 判定。
    }
    // 每秒看一眼：缓冲长期不消化 = 音箱那头没在读；上游长期不出数 = 回源死了
    const monitor = setInterval(() => {
      if (!pausedByBuffer && !upstreamEnded && Date.now() - lastDataAt > UPSTREAM_SILENCE_MS) {
        upstream.destroy(new Error('回源长时间无数据'))
        return
      }
      // 上游已经读完、还有数据没发出去，而我们已经很久没能写出任何东西
      // → 音箱那边不读了（或连接已经半死）：这时才放弃，别白占着连接。
      // 判据是「多久没写出数据」，而不是「上游什么时候读完」——
      // 后者在本地缓存路径里是瞬间的事，会把正常播放的歌误杀（曾导致每首 180s 被掐断）。
      if (upstreamEnded && pendingBytes > 0 && Date.now() - lastConsumedAt > downstreamGiveupMs()) {
        try {
          res.destroy()
        } catch {
          /* 已断开 */
        }
        settle()
        return
      }
      // 音箱是分块读的，偶尔一两秒不动很正常；看的是「连续多久一点都没消化」
      if (pendingBytes < DOWNSTREAM_STALL_BYTES || Date.now() - lastConsumedAt < DOWNSTREAM_STALL_MS) {
        if (stalledSince !== null) {
          maxStallMs = Math.max(maxStallMs, Date.now() - stalledSince)
          stalledSince = null
        }
        return
      }
      if (stalledSince === null) stalledSince = Date.now()
      else maxStallMs = Math.max(maxStallMs, Date.now() - stalledSince)
    }, 1000)

    upstream.on('data', onData)
    upstream.on('end', onUpstreamGone)
    upstream.on('close', onUpstreamGone)
    upstream.on('error', onUpstreamGone)
    res.on('finish', onFinish)
    res.on('close', settle)
  })

const serveRemoteUrl = async (
  req: IncomingMessage,
  res: ServerResponse,
  upstreamUrl: string,
  filename?: string,
  declaredType?: string,
  sid?: string,
  durationMs?: number,
) => {
  const range = req.headers.range ? String(req.headers.range) : undefined
  const durMs = Number(durationMs) || 0
  try {
    const { response: upstream, status, request: upstreamRequest } = await fetchUpstream(upstreamUrl, range)
    // 关掉这条连接的 30 秒空闲超时。音箱读得慢，缓冲写满后我们会主动暂停回源，
    // 暂停时长很容易超过 30 秒——那时连接本身是好的，被超时掐断就变成音箱断流。
    // 真正的死连接交给 pumpDownstream 的静默检测（60 秒没有任何字节）处理。
    try {
      upstreamRequest.setTimeout(0)
    } catch {
      /* 已结束的连接忽略 */
    }
    if (status >= 400) {
      upstream.resume()
      throw new Error(`HTTP ${status}`)
    }

    const contentType = String(upstream.headers['content-type'] || '')
    if (NON_AUDIO_CONTENT.test(contentType)) {
      const detail = (await peekText(upstream)).trim()
      throw new Error(`回源返回的不是音频（${contentType}）：${detail || '空响应'}`)
    }

    // 上游常给 application/octet-stream（甚至不给），直接透传会让音箱按「未知文件」处理，
    // 这里优先用投送前探测到的真实格式，其次按文件名后缀，最后才回退 audio/mpeg
    const effectiveType = GENERIC_CONTENT.test(contentType)
      ? (declaredType || MIME_BY_EXT[path.extname(String(filename || '')).toLowerCase()] || 'audio/mpeg')
      : contentType

    const outHeaders: Record<string, string> = {
      'Content-Type': effectiveType,
      'Accept-Ranges': String(upstream.headers['accept-ranges'] || 'bytes'),
      'Cache-Control': 'no-store',
    }
    if (upstream.headers['content-length']) outHeaders['Content-Length'] = String(upstream.headers['content-length'])
    if (upstream.headers['content-range']) outHeaders['Content-Range'] = String(upstream.headers['content-range'])
    if (filename) outHeaders['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`

    // Range 请求的 content-length 只是这一段，得从 content-range 的 «/总长» 取整首大小
    const fullSize = Number(
      /\/(\d+)\s*$/.exec(String(upstream.headers['content-range'] || ''))?.[1] ||
        upstream.headers['content-length'] ||
        0,
    )
    beginStreamRound(sid, fullSize, range)

    res.writeHead(status === 206 ? 206 : 200, outHeaders)
    const stats = await pumpDownstream(upstream, res, Number(durationMs) || 0)
    // Range 请求的这一段传完就结束，计数用上面算好的整首大小
    recordStreamRound(sid, stats.bytes, fullSize, pullsFromStart(range, fullSize))
    const stall = stats.maxStallMs >= DOWNSTREAM_STALL_MS ? ` ｜音箱侧最长停顿 ${Math.round(stats.maxStallMs / 1000)}s` : ''
    // 两个时间必须分开写：上游读完很快而下发完成很慢 = 慢在音箱按实时节奏读，这是正常的；
    // 只写一个「用时」时，上游 0 秒读完就打出「用时 0s」，会彻底掩盖真实情况。
    const pace = stats.paceLeadMs ? `（平滑 ${Math.round(stats.paceLeadMs / 1000)}s${stats.paceRelaxed ? ` 放宽${stats.paceRelaxed}次` : ''}）` : '（无平滑/无时长）'
    const rate = durMs > 0 && fullSize > 0 ? (fullSize / durMs).toFixed(0) : '?'
    syncLog.info(
      `[XiaoAi] 中转完成 ${filename || ''}：上游拉 ${stats.bytes}B / 已发 ${stats.sent}B${fullSize ? ` / 总 ${fullSize}B` : ''}` +
        `${req.headers.range ? `（${req.headers.range}）` : ''}` +
        ` ｜时长 ${durMs ? Math.round(durMs / 1000) + 's' : '?'} ｜码率 ${rate}B/ms` +
        ` ｜首字节 ${stats.firstByteMs}ms ｜上游读完 ${(stats.upstreamMs / 1000).toFixed(1)}s` +
        ` ｜下发完成 ${(stats.elapsedMs / 1000).toFixed(1)}s${pace}${stall}`,
    )
  } catch (error: any) {
    if (res.headersSent) {
      try {
        res.destroy()
      } catch {
        /* 已经断开了 */
      }
      return
    }
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, message: `回源失败: ${error?.message || error}` }))
  }
}

/**
 * 音箱「整首放完后又来拉一次」时，先按住多久再给数据。
 *
 * 背景：小爱音箱播完一首会立刻拿同一个 URL 再拉一遍（songloft-plugin-miot #437）。
 * 我们的 URL 半小时内都有效，于是它会真的把**这一段再放一遍**——
 * 听感就是「切歌的时候回放上一首的一部分」。
 *
 * 做法：这次请求先按住几秒。前端一收到 replay 信号就会立刻投送下一首，
 * 新的一首会把这一路 retire 掉（连接被掐断），音箱就听不到这段回放。
 * 期间前端没投新歌（队列到头 / 网页已关）也只多等这几秒，期满直接 410 停住，
 * 不把整首重发——否则关掉网页后就是无限单曲循环（2026-10-24 实测坐实）。
 */
const REPLAY_HOLD_MS = 4000

/** 实际按住时长：允许用环境变量调短（测试用，避免每个用例都等 4 秒） */
const replayHoldMs = (): number => {
  const v = Number(process.env.XIAOAI_REPLAY_HOLD_MS)
  return Number.isFinite(v) && v >= 0 ? v : REPLAY_HOLD_MS
}

/** 统一入口 */
export const serveXiaoAiStream = async (req: IncomingMessage, res: ServerResponse, payload: StreamTokenPayload) => {
  // 已经换掉的流：音箱播完上一首后拿旧 URL 重拉，这里直接拒绝，
  // 否则它会真的把上一首从头再放一遍（听起来就是「切歌前先响上一首」）
  if (isRetiredStream(payload.sid)) {
    res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ success: false, message: 'stream retired' }))
    return
  }
  // 先登记再等待：等待期里前端若投了新歌，retire 才能把这路掐断
  rememberLive(payload.sid, res)

  // 「整首放完后又来拉」= 音箱觉得歌放完了 → 这是切歌信号，
  // 必须**立刻**置位（前端轮询 /status 有 1.5s 间隔，晚一点就多播一段）。
  if (noteReplayRequest(payload.sid)) {
    // 切回本机播放后（drainOnly）：这首已经完整放完，用户也不要小爱继续播了。
    // 不能走下面的 hold 逻辑——那是在等前端投下一首，而这时前端已经不管小爱了，
    // 等不到就会把整首从头再发一遍，实测会无限循环（见 drainOnlyStreams 注释）。
    if (isDrainOnly(payload.sid)) {
      syncLog.info('[XiaoAi] 已切回本机播放，这首放完即止：拒绝重拉，音箱停止播放')
      if (!res.headersSent) {
        res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ success: false, message: 'stream drained' }))
      }
      return
    }
    const holdMs = replayHoldMs()
    syncLog.info(`[XiaoAi] 音箱重拉已放完的流，先按住 ${holdMs}ms 等前端切歌（避免回放上一首）`)
    await new Promise((resolve) => setTimeout(resolve, holdMs))
    // 等���期间前端投了新歌 → 旧流已作废，直接回 410，音箱就会停掉这一首
    if (isRetiredStream(payload.sid)) {
      if (!res.headersSent) {
        res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ success: false, message: 'stream retired' }))
      }
      return
    }
    // 按住期满仍没有新投送：前端不会再切歌了（队列到头 / 网页已关 / 前端掉线）。
    // 原实现这里掉下去把整首重发一遍，音箱播完又重拉 → 实测无限单曲循环
    // （2026-10-24 无页面投送：18:59/19:03/19:06 每隔约一个歌长整首重发一次）。
    // 直接 410 让音箱停住；要继续听由前端重新投送（新流新 token）。
    if (!res.headersSent) {
      syncLog.info('[XiaoAi] 按住期满无前端切歌：拒绝重放上一首，音箱停止（防无限单曲循环）')
      res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ success: false, message: 'replay hold expired without takeover' }))
    }
    return
  }

  // 统一 mp3：本地缓存、远端直投都收口到同一条转码通道
  if (payload.format === 'mp3') {
    await serveTranscodedMp3(req, res, payload)
    return
  }

  if (payload.path) {
    serveLocalFile(req, res, payload.path, payload.filename, payload.sid, Number(payload.durationMs) || 0)
    return
  }
  if (payload.url) {
    await serveRemoteUrl(
      req,
      res,
      payload.url,
      payload.filename,
      payload.contentType,
      payload.sid,
      Number(payload.durationMs) || 0,
    )
    return
  }
  res.writeHead(400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ success: false, message: 'token 缺少播放目标' }))
}
