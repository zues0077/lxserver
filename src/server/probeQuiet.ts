/**
 * 巡检静默器 —— 巡检期间的日志降噪。
 *
 * 一轮巡检会对「音源 × 平台 × 候选曲目」发起成百上千次解析，其中绝大多数失败
 * 都是**预期内的**（源后端下线、限流、风控、测试曲目无版权）。每一次失败会由两个
 * 地方各打一行日志：
 *   1. 宿主侧 userApi.callRequest 的 catch（`[自定义源-xxx] 调用请求异常: ...`）
 *   2. 源脚本自身的 console.error（`[某音源] tx musicUrl 错误: ...`）
 * 单轮轻松刷出数百行，把真正有价值的日志（改配置、上传源、播放失败）淹没，
 * 用户贴日志排障时几乎没法看。
 *
 * 这里提供一个全局静默开关：
 *   - 巡检开始 → beginProbeQuiet()
 *   - 巡检结束 → endProbeQuiet()，返回聚合摘要（按源计数 + 保留样本）
 *   - 静默期间的日志被 recordSuppressed() 吞掉并计数，**不是丢弃**，结束后一次性汇总输出。
 *
 * 注意：静默是全局的，因为它挂在「源调用」这一层；巡检期间用户恰好播放失败时，
 * 那一条源错误也会被聚合（但样本仍保留在摘要里，可追溯）。宿主其它模块
 * （[歌曲播放]、[文件缓存]、[任务调度] 等）不受影响。
 */

interface Bucket {
    count: number
    samples: Map<string, number>
}

/** 允许嵌套调用（例如「新音源立即巡检」在周期巡检期间排队执行），因此用深度计数 */
let quietDepth = 0
let buckets = new Map<string, Bucket>()
let suppressedTotal = 0

export const isProbeQuiet = (): boolean => quietDepth > 0

export function beginProbeQuiet(): void {
    quietDepth++
    if (quietDepth === 1) {
        buckets = new Map()
        suppressedTotal = 0
    }
}

/** 抑制一条日志并计入聚合；scope 一般是音源名 */
export function recordSuppressed(scope: string, message: string): void {
    suppressedTotal++
    const key = scope || '(未知源)'
    let b = buckets.get(key)
    if (!b) {
        b = { count: 0, samples: new Map() }
        buckets.set(key, b)
    }
    b.count++
    const sample = (message || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    b.samples.set(sample, (b.samples.get(sample) || 0) + 1)
}

export interface ProbeQuietSummary {
    /** 本次静默期被抑制的日志总条数 */
    total: number
    /** 每个来源一行摘要（已按条数降序，最多 12 条） */
    lines: string[]
}

export function endProbeQuiet(): ProbeQuietSummary {
    if (quietDepth > 0) quietDepth--
    if (quietDepth > 0) return { total: suppressedTotal, lines: [] }

    const total = suppressedTotal
    const lines: string[] = []
    if (total > 0) {
        const ranked = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count)
        for (const [scope, b] of ranked.slice(0, 12)) {
            const top = [...b.samples.entries()].sort((x, y) => y[1] - x[1])[0]
            lines.push(`${scope} × ${b.count}（例：${top ? top[0] : ''}）`)
        }
    }
    buckets = new Map()
    suppressedTotal = 0
    return { total, lines }
}
