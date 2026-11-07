import { spawn } from 'node:child_process'
import { ffmpegPath } from './xiaoai/transcode'

/**
 * R75-1: 汽水直链「可播性门禁」（取链出口拦截，2026-11-07）。
 *
 * 背景（任素汐-汽水 140 次取链全量审计，test-r73 实测）：
 *  - 49% 的直链是「容器元数据明文、音频数据整段乱序」的流：无 `enca`/`senc` CENC
 *    特征（isEncryptedRemoteStream 抓不到），与下载 UA 无关（三种 UA 字节完全一致），
 *    浏览器与音箱都放不出来——这就是「缓存显示成功但死活播不出」的主因之一；
 *  - 17% 是 60/45 秒试听片段冒充整曲（明文、可解码，只有时长能识破）；
 *  - 乱序有两种分布：A 型从头乱、B 型「前 85% 完好、尾部乱」（dl_4_flac 实测），
 *    所以采样必须覆盖头部与尾部。
 *
 * 实现：直接对远程 URL 起三个异步探测（ffmpeg 自带 Range 请求，能跨 moov 寻址）：
 *  1) ffprobe 远程读流时长 → 试听判定；
 *  2) ffmpeg 解码前 8 秒 → A 型乱序；
 *  3) 头部干净时再解码最后 10 秒 → B 型尾部乱序。
 *
 * 判定口径（宁可漏杀不误杀）：
 *  - 探测自身失败（网络抖动 / ffprobe 缺失 / 不支持 seek）→ 放行；
 *  - 任一采样窗口解码错误行数 ≥ 10 → 乱序流，拦截（实测好文件单窗口 ≤3 行）。
 *
 * 结果按 URL 缓存 10 分钟并做 single-flight 合并，避免同一首重播反复探测。
 */

const GATE_CACHE_TTL_MS = 10 * 60 * 1000
const FFPROBE_TIMEOUT_MS = 6000
const DECODE_TIMEOUT_MS = 10000

/** 单窗口判定阈值：实测好文件 ≤3 行（截断/重同步误差），乱序窗口 280+ 行 */
const WINDOW_ERR_LINES_LIMIT = 10

const ffprobePath = (): string => String(process.env.FFPROBE_PATH || 'ffprobe')

export interface RemoteGateVerdict {
    ok: boolean
    kind: 'ok' | 'preview' | 'corrupt'
    reason?: string
}

interface WindowResult {
    at: 'head' | 'tail'
    errLines: number
    sampled: boolean
}

const gateCache = new Map<string, { at: number; verdict: RemoteGateVerdict }>()
const inflight = new Map<string, Promise<RemoteGateVerdict>>()

/**
 * 解析曲目时长字符串（m:ss / hh:mm:ss / 纯秒数）。
 * 独立小实现，避免把 fileCache 的副作用依赖链拖进单测环境。
 */
export const parseIntervalSeconds = (value: unknown): number => {
    const s = String(value ?? '').trim()
    if (!s) return 0
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s))
    const parts = s.split(':').map(p => Number(p) || 0)
    if (!parts.length || parts.some(p => !Number.isFinite(p))) return 0
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return 0
}

/** 统计解码 stderr 的错误行数（空行过滤） */
const countErrLines = (stderr: string): number =>
    String(stderr || '').split('\n').map(l => l.trim()).filter(Boolean).length

/**
 * 门禁判定（纯函数，供单测）。
 * @param windows 头/尾采样结果（sampled=false 表示该窗口探测失败，不参与判定）
 * @param streamDurationSec ffprobe 读到的流时长（0 = 未知）
 * @param expectedSec 曲目元数据时长（0 = 未知）
 */
export const judgeRemoteGate = (
    windows: WindowResult[],
    streamDurationSec: number,
    expectedSec: number,
): RemoteGateVerdict => {
    if (expectedSec >= 60 && streamDurationSec > 0 && streamDurationSec < expectedSec * 0.85) {
        return {
            ok: false,
            kind: 'preview',
            reason: `汽水返回的是 ${Math.round(streamDurationSec)} 秒片段（该曲完整 ${expectedSec} 秒），按试听拦截`,
        }
    }
    for (const w of windows) {
        if (w.sampled && w.errLines >= WINDOW_ERR_LINES_LIMIT) {
            return {
                ok: false,
                kind: 'corrupt',
                reason: `汽水直链音频数据乱序（${w.at} 窗口解码错误 ${w.errLines} 行）`,
            }
        }
    }
    return { ok: true, kind: 'ok' }
}

const spawnOut = (bin: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string; stdout: string; failed: boolean }> =>
    new Promise(resolve => {
        let stderr = ''
        let stdout = ''
        let settled = false
        let proc: import('node:child_process').ChildProcess
        try {
            proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        } catch {
            resolve({ code: -1, stderr: '', stdout: '', failed: true })
            return
        }
        const finish = (code: number, failed: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({ code, stderr, stdout, failed })
        }
        const timer = setTimeout(() => {
            try { proc.kill('SIGKILL') } catch { }
            finish(-1, true)
        }, timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
        proc.stdout?.on('data', (d: Buffer) => { stdout += String(d) })
        proc.stderr?.on('data', (d: Buffer) => { stderr += String(d) })
        proc.on('error', () => finish(-1, true))
        proc.on('close', code => finish(code ?? -1, false))
    })

/** ffprobe 远程读流时长（秒；失败返回 0） */
const probeRemoteDuration = async (url: string): Promise<number> => {
    const r = await spawnOut(ffprobePath(), [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        url,
    ], FFPROBE_TIMEOUT_MS)
    if (r.failed || r.code !== 0) return 0
    const n = Number(String(r.stdout || '').trim())
    return Number.isFinite(n) && n > 0 ? n : 0
}

/** 解码远程 URL 的一段（-ss 前向 / -sseof 尾部），返回错误行数（探测失败返回 -1） */
const decodeRemoteWindow = async (url: string, seekArgs: string[]): Promise<number> => {
    const r = await spawnOut(ffmpegPath(), ['-v', 'error', ...seekArgs, '-i', url, '-f', 'null', '-'], DECODE_TIMEOUT_MS)
    if (r.failed) return -1
    return countErrLines(r.stderr)
}

/**
 * 对直链做可播性探测。任何一步探测失败都按「放行」处理——
 * 门禁是增强判据，不能让它把本来能播的歌判死。
 */
export const probeRemoteStream = async (url: string, expectedSec: number): Promise<RemoteGateVerdict> => {
    const u = String(url || '')
    if (!/^https?:\/\//i.test(u)) return { ok: true, kind: 'ok' }

    const hit = gateCache.get(u)
    if (hit && Date.now() - hit.at < GATE_CACHE_TTL_MS) return hit.verdict
    const pending = inflight.get(u)
    if (pending) return pending

    const flight = (async (): Promise<RemoteGateVerdict> => {
        // ① 时长（试听判定）
        const durationSec = await probeRemoteDuration(u)
        // ② 头部解码（A 型乱序）
        const headErrs = await decodeRemoteWindow(u, ['-t', '8'])
        if (headErrs >= 0) {
            const early = judgeRemoteGate([{ at: 'head', errLines: headErrs, sampled: true }], durationSec, expectedSec)
            if (!early.ok) return early
        }
        // ③ 尾部解码（B 型「尾部乱序」）——头部已拦截时不必再花这一步
        const tailErrs = await decodeRemoteWindow(u, ['-sseof', '10'])
        const windows: WindowResult[] = [
            { at: 'head', errLines: headErrs, sampled: headErrs >= 0 },
            { at: 'tail', errLines: tailErrs, sampled: tailErrs >= 0 },
        ]
        return judgeRemoteGate(windows, durationSec, expectedSec)
    })()

    inflight.set(u, flight)
    try {
        const verdict = await flight
        gateCache.set(u, { at: Date.now(), verdict })
        if (gateCache.size > 500) {
            const cutoff = Date.now() - GATE_CACHE_TTL_MS
            for (const [k, v] of gateCache) if (v.at <= cutoff) gateCache.delete(k)
        }
        return verdict
    } finally {
        if (inflight.get(u) === flight) inflight.delete(u)
    }
}

/** 测试/运维用：清空判定缓存 */
export const clearRemoteGateCache = (): void => {
    gateCache.clear()
    inflight.clear()
}
