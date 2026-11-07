import { spawnSync } from 'node:child_process'
import { ffmpegPath } from './xiaoai/transcode'

/**
 * 下载落盘前的解码抽检（r74）。
 *
 * 背景：AAC 流损坏的坏文件（实测汽水源侧《胡广生》：`Decode error rate 0.998522`、
 * `Prediction is not allowed in AAC-LC`）靠时长/码率/标签判不出来——元数据是明文的，
 * 而音频帧是乱的。文件一旦落进缓存，之后每次点播都命中它（前端智能换源也不绕
 * 文件缓存），变成「已缓存但死活播不出」的死循环。
 *
 * 独立成模块的原因：fileCache.ts 依赖链在单测环境有副作用（global.lx.dataPath），
 * 判定逻辑要可单测就必须无副作用依赖。
 */

/**
 * 解码抽检的判定逻辑（纯函数，供单测）。
 *
 * 判定口径（宁可漏杀不误杀，正常文件在 `-v error` 下 stderr 为空）：
 *  - 出现明确的解码错误特征 → 坏
 *  - 错误行数 ≥ 3 → 坏（大量零散 decode error 也是坏）
 *  - 退出码非 0 → 坏
 */
export const judgeDecodeProbe = (stderr: string, code: number): { ok: boolean; reason?: string } => {
    const lines = String(stderr || '').split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.some(l => /Decode error rate|Error submitting packet|Invalid data found when processing input|Prediction is not allowed|channel element .* is not allocated|Number of bands .* exceeds limit/i.test(l))) {
        return { ok: false, reason: lines[0].slice(0, 140) }
    }
    if (lines.length >= 3) {
        return { ok: false, reason: `解码错误 ${lines.length} 行: ${lines[0].slice(0, 120)}` }
    }
    if (code !== 0) {
        return { ok: false, reason: `ffmpeg 退出码 ${code}: ${lines[0]?.slice(0, 120) || '无错误输出'}` }
    }
    return { ok: true }
}

/**
 * 用 ffmpeg 真实解码前 8 秒（元数据正常但音频流损坏的文件在这里现形）。
 * ffmpeg 不存在（ENOENT）时放行——镜像没装 ffmpeg 时沿用原有判据。
 */
export const probeAudioDecodable = (filePath: string): { ok: boolean; reason?: string } => {
    try {
        const r = spawnSync(
            ffmpegPath(),
            ['-v', 'error', '-t', '8', '-i', filePath, '-f', 'null', '-'],
            { timeout: 15000, encoding: 'utf8' },
        )
        if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true }
        return judgeDecodeProbe(String(r.stderr || ''), r.status ?? (r.error ? 1 : 0))
    } catch (e: any) {
        // 抽检自身异常按放行处理：抽检是增强判据，不能让它把正常下载全拦死
        console.warn(`[文件缓存] 解码抽检异常: ${e?.message || e}`)
        return { ok: true }
    }
}
