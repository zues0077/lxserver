/**
 * stdout 桥接与长定时器追踪（诊断版）。
 *
 * 两个目的，都围绕「610 秒周期的静默爆发」这类问题：
 *
 * 1. **把 console.* 写进日志目录**。
 *    容器里 console.log/info/warn/error 只进 Docker stdout，而 app.log 只有
 *    log4js 的输出——音源重载、文件监控、巡检明细这些关键信息在 app.log 里
 *    完全看不到，只能登到 NAS 上翻 Docker 运行日志。这里给每个 console 调用
 *    补一份落到 `<LOG_PATH>/stdout.log`，于是 /api/logs?type=stdout 就能
 *    在面板里直接看，排查不再有盲区。
 *
 * 2. **登记所有「长定时器」（>=5 分钟）**。
 *    自我调度的周期任务（setTimeout(fn, 600000) 干完活再排一个）是事件循环
 *    周期性卡顿的常见根因，但它在代码里往往只有一行、且日志静默。这里在定时器
 *    创建的瞬间记下它的间隔与调用栈，并维护一份「当前活动的长定时器」清单：
 *      - 创建即记录（含栈）→ 谁注册的一目了然；
 *      - /health 可拉活动清单 → 与卡顿时刻对照即知是谁在周期性地烧 CPU。
 *
 * 注意：本模块要尽早执行（index.ts 的第一个 import），才能捕获后续所有注册。
 */

import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// stdout -> 文件桥接
// ---------------------------------------------------------------------------

const LOG_PATH = process.env.LOG_PATH || path.join(process.cwd(), 'data', 'logs')
const STDOUT_LOG_FILE = path.join(LOG_PATH, 'stdout.log')
/** 单个日志文件上限（诊断用途，超限截断重来，避免无界增长占满磁盘） */
const STDOUT_LOG_MAX_BYTES = 8 * 1024 * 1024

let stdoutLogSize = 0
try {
  fs.mkdirSync(LOG_PATH, { recursive: true })
  stdoutLogSize = fs.statSync(STDOUT_LOG_FILE).size
} catch {
  /* 目录不可写时静默降级：不影响主流程，只是没有桥接日志 */
}

const stringifyArg = (arg: unknown): string => {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ''}`
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

/** 写一行到 stdout.log（绝不调用 console.*，避免递归） */
const appendStdoutLog = (level: string, args: unknown[]): void => {
  if (stdoutLogSize < 0) return // 初始化失败，已降级
  try {
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(stringifyArg).join(' ')}\n`
    if (stdoutLogSize > STDOUT_LOG_MAX_BYTES) {
      fs.truncateSync(STDOUT_LOG_FILE, 0)
      stdoutLogSize = 0
    }
    fs.appendFileSync(STDOUT_LOG_FILE, line)
    stdoutLogSize += Buffer.byteLength(line)
  } catch {
    /* 忽略写失败 */
  }
}

// ---------------------------------------------------------------------------
// 长定时器登记
// ---------------------------------------------------------------------------

/** 间隔达到该值的定时器才登记（毫秒）。5 分钟：覆盖 10 分钟周期任务，滤掉正常短定时器 */
const LONG_TIMER_MS = 5 * 60 * 1000
/** 注册日志里保留的栈帧数 */
const STACK_FRAMES = 5

export interface LongTimerInfo {
  kind: 'timeout' | 'interval'
  delayMs: number
  createdAt: string
  /** 注册处的调用栈（前几帧） */
  stack: string
}

const activeLongTimers = new Map<unknown, LongTimerInfo>()

const captureStack = (): string => {
  const stack = new Error().stack
  if (!stack) return ''
  return stack
    .split('\n')
    .slice(1)
    // 滤掉本模块自身的帧，只留真正的注册处
    .filter(line => !line.includes('stdoutBridge'))
    .slice(0, STACK_FRAMES)
    .map(line => line.trim())
    .join(' <- ')
}

const noteLongTimer = (kind: 'timeout' | 'interval', delayMs: number): void => {
  const stack = captureStack()
  appendStdoutLog('TIMER', [`[定时器注册] ${kind} 间隔 ${delayMs}ms（${(delayMs / 1000).toFixed(0)}s）@ ${stack}`])
}

/** 当前活动的长定时器清单（/health 与卡顿归因用） */
export const getActiveLongTimers = (): LongTimerInfo[] => {
  return Array.from(activeLongTimers.values()).map(info => ({ ...info }))
}

/** 供 eventLoopMonitor 在卡顿日志里附上「当时有哪些长定时器」 */
export const describeActiveLongTimers = (): string => {
  const timers = getActiveLongTimers()
  if (timers.length === 0) return '无长定时器(>=5min)'
  return timers
    .map(t => `${t.kind} ${(t.delayMs / 1000).toFixed(0)}s@${t.createdAt.slice(11, 19)}[${t.stack.split(' <- ')[0]?.slice(-40) ?? ''}]`)
    .join(' ; ')
}

// ---------------------------------------------------------------------------
// 安装补丁（幂等）
// ---------------------------------------------------------------------------

let installed = false

export const installStdoutBridge = (): void => {
  if (installed) return
  installed = true

  // ---- console.* -> stdout.log ----
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const
  for (const level of levels) {
    const original = (console[level] as (...args: unknown[]) => void)?.bind(console)
    if (!original) continue
    ;(console as unknown as Record<string, (...args: unknown[]) => void>)[level] = (...args: unknown[]) => {
      appendStdoutLog(level.toUpperCase(), args)
      original(...args)
    }
  }

  // ---- setTimeout / setInterval 长定时器登记 ----
  const originalSetTimeout = global.setTimeout
  const originalSetInterval = global.setInterval
  const originalClearTimeout = global.clearTimeout
  const originalClearInterval = global.clearInterval

  const register = <T>(timer: T, info: LongTimerInfo): T => {
    activeLongTimers.set(timer, info)
    return timer
  }

  const patchedSetTimeout = function (callback: (...args: any[]) => void, delay?: number, ...rest: unknown[]): NodeJS.Timeout {
    if (typeof delay === 'number' && delay >= LONG_TIMER_MS) {
      const info: LongTimerInfo = {
        kind: 'timeout',
        delayMs: delay,
        createdAt: new Date().toISOString(),
        stack: captureStack(),
      }
      noteLongTimer('timeout', delay)
      // 包一层：触发时把自己从清单移除，避免清单里堆一堆已执行完的 timeout。
      // 用 function + apply 保留 Node 定时器回调的 this（Time 对象）语义。
      const wrapped = function (this: unknown, ...args: unknown[]) {
        activeLongTimers.delete(timer)
        return (callback as (...a: unknown[]) => unknown).apply(this, args)
      }
      const timer = originalSetTimeout(wrapped as typeof callback, delay, ...(rest as []))
      return register(timer, info)
    }
    return originalSetTimeout(callback, delay, ...(rest as []))
  }

  const patchedSetInterval = function (callback: (...args: any[]) => void, delay?: number, ...rest: unknown[]): NodeJS.Timeout {
    if (typeof delay === 'number' && delay >= LONG_TIMER_MS) {
      const info: LongTimerInfo = {
        kind: 'interval',
        delayMs: delay,
        createdAt: new Date().toISOString(),
        stack: captureStack(),
      }
      noteLongTimer('interval', delay)
      const timer = originalSetInterval(callback, delay, ...(rest as []))
      return register(timer, info)
    }
    return originalSetInterval(callback, delay, ...(rest as []))
  }

  global.setTimeout = patchedSetTimeout as typeof global.setTimeout
  global.setInterval = patchedSetInterval as typeof global.setInterval
  global.clearTimeout = ((timer: NodeJS.Timeout) => {
    activeLongTimers.delete(timer)
    return originalClearTimeout(timer)
  }) as typeof global.clearTimeout
  global.clearInterval = ((timer: NodeJS.Timeout) => {
    activeLongTimers.delete(timer)
    return originalClearInterval(timer)
  }) as typeof global.clearInterval

  appendStdoutLog('INFO', ['[stdout 桥接] 已启用：console.* 写入 stdout.log；>=5min 的定时器注册将被登记（含调用栈）'])
}

/** 立即安装（模块被 import 即生效，先于 index.ts 主体与其它 import 的副作用） */
installStdoutBridge()
