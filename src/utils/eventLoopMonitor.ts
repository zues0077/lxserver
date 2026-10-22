/**
 * 事件循环卡顿监控与归因。
 *
 * 背景：容器里任何「同步重活」都会让事件循环停转——在主线程 eval 几 MB 的
 * 混淆音源脚本、一次几秒的 V8 全量 GC、某个音源自己注册的定时器回调里跑
 * 重计算——表现为「所有 HTTP 请求与音频下发集体停顿」。
 *
 * 此前的自检只打印一句「主线程卡顿 Xms」，看完仍然不知道是谁占的。
 * 这个模块在报卡顿的同一行给出可归因的数据：
 *
 *   1. GC 暂停明细（perf_hooks PerformanceObserver，>=300ms 单独记一行）——
 *      卡顿若来自 GC，这里会出现与卡顿时刻重合的大额暂停；
 *   2. 卡顿时刻的进程内存与 V8 堆统计（堆已用/堆上限一眼看出是不是大堆 GC）；
 *   3. 事件循环延迟直方图（monitorEventLoopDelay 常开，供 /health 拉取）。
 *
 * 与另外两处日志互相印证即可定位真凶：
 *   - userApi：`[自定义源-<源名>] 定时器回调耗时 Xms`（音源注册的定时器在烧 CPU）
 *   - sourceGuard：`[自检护栏] CPU 尖峰：单次采样 X%`（窗口均值稀释掉的短尖峰）
 *
 * 卡顿超过 3s 时还会自动调用 sourceGuard.attributeStall() 做联动归因：
 * 慢定时器回调耗时与卡顿时长严格对应（同步执行），比 CPU 采样更可靠。
 */

import { PerformanceObserver, monitorEventLoopDelay } from 'node:perf_hooks'
import v8 from 'node:v8'
import { syncLog } from './log4js'
import { describeActiveLongTimers } from './stdoutBridge'
import { attributeStall } from '../server/sourceGuard'

export interface GcPauseRecord {
  kind: string
  durationMs: number
  at: string
}

export interface EventLoopStats {
  memory: {
    rss: number
    heapTotal: number
    heapUsed: number
    external: number
    arrayBuffers: number
  }
  heap: {
    usedHeapSize: number
    heapSizeLimit: number
    totalAvailableSize: number
    mallocedMemory: number
    peakMallocedMemory: number
  }
  /** 事件循环延迟直方图（毫秒） */
  eventLoopDelay: {
    min: number
    max: number
    mean: number
    p50: number
    p90: number
    p99: number
  }
  gc: {
    count: number
    totalPauseMs: number
    maxPauseMs: number
    /** 最近几次 >=100ms 的 GC 暂停（最多保留 10 条，/health 只取后 5 条） */
    recentPauses: GcPauseRecord[]
  }
}

/**
 * 卡顿采样周期（毫秒）。
 *
 * 这里有个容易踩的坑：测的是「定时器被推迟了多久」，而不是「阻塞了多久」。
 * 如果阻塞的起点恰好在两次采样中间，那么阻塞的前半段根本不会被算进延迟——
 *   采样周期 2000ms，阻塞 3500ms，最坏只报 1500ms（实测 1732ms / 2612ms），
 *   直接掉到归因阈值以下，真凶就这么漏掉了。
 * 周期越短，这部分「相位损失」的上界越小，因此取 250ms（可用环境变量调）。
 * 注意：不要用 histogram.max 直接当卡顿时长——它是**累计**最大值，
 * 一旦出现过 3.5 秒的卡顿，之后同等规模的卡顿就再也不会刷新它。
 */
const SAMPLE_INTERVAL_MS = (() => {
  const raw = Number(process.env.EVENT_LOOP_SAMPLE_INTERVAL_MS)
  return Number.isFinite(raw) && raw >= 50 ? raw : 250
})()

/** 卡顿超过该值才记录（毫秒） */
const STALL_LOG_THRESHOLD_MS = 500
/** GC 暂停超过该值单独记一行（毫秒） */
const GC_LOG_THRESHOLD_MS = 300
/** 进入 recentPauses 的最低暂停（毫秒） */
const RECENT_PAUSE_THRESHOLD_MS = 100
const MAX_RECENT_PAUSES = 10
/** 卡顿日志最小间隔，避免卡顿本身把日志刷爆（毫秒） */
const STALL_LOG_COOLDOWN_MS = 1000

let started = false
let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null
let gcCount = 0
let gcTotalPauseMs = 0
let gcMaxPauseMs = 0
const recentPauses: GcPauseRecord[] = []
let lastStallLogAt = 0

const fmtMb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`

const noteGcPause = (kind: string, durationMs: number): void => {
  gcCount++
  gcTotalPauseMs += durationMs
  if (durationMs > gcMaxPauseMs) gcMaxPauseMs = durationMs
  if (durationMs >= RECENT_PAUSE_THRESHOLD_MS) {
    recentPauses.push({ kind, durationMs: Math.round(durationMs), at: new Date().toISOString() })
    if (recentPauses.length > MAX_RECENT_PAUSES) recentPauses.shift()
  }
  if (durationMs >= GC_LOG_THRESHOLD_MS) {
    const msg = `[GC] ${kind} 暂停 ${Math.round(durationMs)}ms` +
      `（累计 ${gcCount} 次共 ${Math.round(gcTotalPauseMs)}ms，堆已用 ${fmtMb(process.memoryUsage().heapUsed)}）`
    console.warn(msg)
    syncLog.warn(msg)
  }
}

const describeMemory = (): string => {
  const mem = process.memoryUsage()
  const heap = v8.getHeapStatistics()
  return `rss ${fmtMb(mem.rss)} / 堆已用 ${fmtMb(mem.heapUsed)} / 堆上限 ${fmtMb(heap.heap_size_limit)} / 外部内存 ${fmtMb(mem.external)}`
}

const describeLoop = (): string => {
  if (!histogram) return '循环延迟直方图不可用'
  const ms = (ns: number) => Math.round(ns / 1e6)
  return `循环延迟 p50 ${ms(histogram.percentile(50))}ms / p99 ${ms(histogram.percentile(99))}ms / 最大 ${ms(histogram.max)}ms`
}

/** 卡顿时刻的完整快照：同时写 stdout（docker logs）与 app.log */
const logStall = (lagMs: number): void => {
  const now = Date.now()
  if (now - lastStallLogAt < STALL_LOG_COOLDOWN_MS) return
  lastStallLogAt = now
  const msg = `[事件循环] 主线程卡顿 ${lagMs}ms（期间所有 HTTP 请求与音频下发都会停顿）` +
    ` | ${describeMemory()} | ${describeLoop()}` +
    (gcCount > 0 ? ` | GC 累计 ${gcCount} 次共 ${Math.round(gcTotalPauseMs)}ms（单次最大 ${Math.round(gcMaxPauseMs)}ms）` : '') +
    ` | 活动长定时器: ${describeActiveLongTimers()}`
  console.error(msg)
  syncLog.error(msg)
  // 卡顿联动归因：直接从「慢定时器回调 + 定时器登记」锁定候选音源。
  // 默认 warn 模式只告警不隔离；连续归因同一源且显式开启开关才隔离。
  try {
    attributeStall(lagMs)
  } catch (e: any) {
    console.warn('[自检护栏][归因] 归因过程异常（不影响卡顿记录）:', e?.message || e)
  }
}

/**
 * 启动事件循环监控（幂等）。
 *
 * 定时器漂移检测：被推迟多久，就说明主线程被占了多久。
 * 服务里任何同步重活都会在这里被记下来，并带上一堆归因数据。
 */
export function startEventLoopMonitor(): void {
  if (started) return
  started = true

  // ---- GC 暂停观察：>=300ms 的暂停单独记一行，卡顿是不是 GC 一眼可判 ----
  try {
    const gcObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const kind = String((entry as { detail?: { kind?: string } }).detail?.kind || 'unknown')
        noteGcPause(kind, Number(entry.duration) || 0)
      }
    })
    gcObserver.observe({ entryTypes: ['gc'] })
  } catch (e: any) {
    console.warn('[事件循环] GC 观察器启动失败（不影响卡顿监控）:', e?.message || e)
  }

  // ---- 事件循环延迟直方图：常开，供 /health 读取 ----
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()
  } catch (e: any) {
    console.warn('[事件循环] 延迟直方图启动失败（不影响卡顿监控）:', e?.message || e)
  }

  // 用「实际间隔 - 采样周期」衡量卡顿：定时器被推迟多久，主线程就被占了多久。
  // 采样周期越短，相位损失越小，卡顿时长越接近真实值（见 SAMPLE_INTERVAL_MS 的注释）。
  let lastTickAt = Date.now()
  const tick = () => {
    const now = Date.now()
    const lag = (now - lastTickAt) - SAMPLE_INTERVAL_MS
    lastTickAt = now
    if (lag > STALL_LOG_THRESHOLD_MS) logStall(lag)
    const timer = setTimeout(tick, SAMPLE_INTERVAL_MS)
    timer.unref?.()
  }
  const timer = setTimeout(tick, SAMPLE_INTERVAL_MS)
  timer.unref?.()
}

/** /health 与诊断接口用的快照 */
export function getEventLoopStats(): EventLoopStats {
  const mem = process.memoryUsage()
  const heap = v8.getHeapStatistics()
  const ms = (ns: number) => Math.round(ns / 1e6)
  return {
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
    heap: {
      usedHeapSize: heap.used_heap_size,
      heapSizeLimit: heap.heap_size_limit,
      totalAvailableSize: heap.total_available_size,
      mallocedMemory: heap.malloced_memory,
      peakMallocedMemory: heap.peak_malloced_memory,
    },
    eventLoopDelay: histogram
      ? {
        min: ms(histogram.min),
        max: ms(histogram.max),
        mean: Number((histogram.mean / 1e6).toFixed(1)),
        p50: ms(histogram.percentile(50)),
        p90: ms(histogram.percentile(90)),
        p99: ms(histogram.percentile(99)),
      }
      : { min: 0, max: 0, mean: 0, p50: 0, p90: 0, p99: 0 },
    gc: {
      count: gcCount,
      totalPauseMs: Math.round(gcTotalPauseMs),
      maxPauseMs: Math.round(gcMaxPauseMs),
      recentPauses: recentPauses.slice(-5),
    },
  }
}
