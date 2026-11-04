/**
 * 慢源 worker 隔离（主线程侧）。
 *
 * 启用策略（方案 A）：只有被 sourceGovernor 判定为「降速运行」的源才进 worker，
 * 且一旦进入就常驻（降速状态 30 分钟会过期，若跟着来回切会造成 worker 反复重启）。
 * 其余源继续走原来的主线程 vm2 路径；worker 启动/调用失败可自动回退主线程。
 */

import { Worker } from 'worker_threads'
import * as path from 'path'
import { isThrottled } from './sourceGovernor'
import {
    type MainToWorkerMessage,
    type SourceWorkerData,
    type WorkerToMainMessage,
    WORKER_DEFAULTS,
    configBool,
    configNumber,
    fromTransferable,
    pickWorkerConfig,
    scriptFingerprint,
    toTransferable,
    workerFailureDecision,
} from './sourceWorkerProtocol'

const WORKER_START_TIMEOUT_MS = 20000
const MAX_WORKER_FAILURES = 2

const keyOf = (owner: string, id: string) => `${owner}_${id}`
const readConfig = (): Record<string, any> => (global as any).lx?.config || {}

export interface WorkerSourceInfo {
    owner: string
    id: string
    name: string
    script: string
}

/**
 * 纯策略对象：资格判定、常驻名单、失败熔断。
 * 单独导出是为了不启动真 Worker 也能跑单测。
 */
export class WorkerPolicy {
    private workerKeys = new Set<string>()
    private disabledKeys = new Set<string>()
    private failures = new Map<string, number>()

    constructor(
        private readonly cfg: () => Record<string, any> = readConfig,
        private readonly throttled: (owner: string, id: string) => boolean = isThrottled,
    ) { }

    get enabled(): boolean {
        return configBool(this.cfg(), 'customSource.governor.worker.enabled', true)
    }

    get fallbackToMain(): boolean {
        return configBool(this.cfg(), 'customSource.governor.worker.fallbackToMain', true)
    }

    /** 仅慢源进 worker：首次由 isThrottled 触发，之后常驻，直到源被卸载或进程重启。 */
    shouldUse(owner: string, id: string): boolean {
        if (!this.enabled) return false
        const key = keyOf(owner, id)
        if (this.disabledKeys.has(key)) return false
        if (this.workerKeys.has(key)) return true
        if (!this.throttled(owner, id)) return false
        this.workerKeys.add(key)
        return true
    }

    isWorkerSource(owner: string, id: string): boolean { return this.workerKeys.has(keyOf(owner, id)) }
    isDisabled(owner: string, id: string): boolean { return this.disabledKeys.has(keyOf(owner, id)) }

    /** 返回 true 表示已连续失败到阈值，该源本次进程内不再尝试 worker。 */
    noteFailure(owner: string, id: string): boolean {
        const key = keyOf(owner, id)
        const n = (this.failures.get(key) || 0) + 1
        this.failures.set(key, n)
        if (n >= MAX_WORKER_FAILURES) {
            this.disabledKeys.add(key)
            return true
        }
        return false
    }

    noteSuccess(owner: string, id: string): void { this.failures.delete(keyOf(owner, id)) }
    release(owner: string, id: string): void {
        const key = keyOf(owner, id)
        this.workerKeys.delete(key)
        this.disabledKeys.delete(key)
        this.failures.delete(key)
    }
    /** 仅供单测与运维自检：当前被放进 worker 的源。 */
    snapshot(): { workerKeys: string[]; disabledKeys: string[] } {
        return { workerKeys: [...this.workerKeys], disabledKeys: [...this.disabledKeys] }
    }
    resetForTest(): void {
        this.workerKeys.clear(); this.disabledKeys.clear(); this.failures.clear()
    }
}

export const workerPolicy = new WorkerPolicy()

interface PendingCall {
    resolve: (v: any) => void
    reject: (e: Error) => void
    timer: any
}

export class SourceWorkerHost {
    readonly worker: Worker
    readonly ready: Promise<void>
    private pending = new Map<number, PendingCall>()
    private nextCallId = 0
    private disposed = false

    constructor(readonly data: SourceWorkerData, private readonly onDead: () => void) {
        const env: Record<string, string> = { NODE_ENV: process.env.NODE_ENV || 'production' }
        for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
            if (process.env[k]) env[k] = process.env[k] as string
        }
        this.worker = new Worker(path.join(__dirname, 'customSourceWorker.js'), {
            workerData: data,
            // 不把宿主全部环境变量（可能含 token）带进 worker
            env,
        })
        this.ready = new Promise<void>((resolve, reject) => {
            let settled = false
            const finish = (err?: Error) => {
                if (settled) return
                settled = true
                clearTimeout(startTimer)
                if (err) reject(err); else resolve()
            }
            const startTimer = setTimeout(
                () => finish(new Error('worker 启动超时（脚本初始化未完成）')),
                WORKER_START_TIMEOUT_MS,
            )
            this.worker.on('message', (msg: WorkerToMainMessage) => {
                if (msg.type === 'ready') { finish(); return }
                if (msg.type === 'fatal') { finish(new Error(`worker 启动失败: ${msg.message}`)); return }
                if (msg.type === 'log') {
                    const line = msg.text
                    if (msg.level === 'error') console.error(line)
                    else if (msg.level === 'warn') console.warn(line)
                    else if (configBool(readConfig(), 'debug.enabled', false)) console.log(line)
                    return
                }
                if (msg.type === 'result') {
                    const p = this.pending.get(msg.callId)
                    if (!p) return
                    this.pending.delete(msg.callId)
                    clearTimeout(p.timer)
                    if (msg.ok) p.resolve(fromTransferable(msg.value))
                    else p.reject(Object.assign(new Error(msg.error), { fromScript: msg.fromScript === true }))
                }
            })
            this.worker.on('error', e => finish(new Error(`worker 异常: ${(e as any)?.message || String(e)}`)))
            this.worker.on('exit', code => {
                this.rejectAll(new Error(`worker 已退出 (code=${code})`))
                finish(new Error(`worker 意外退出 (code=${code})`))
                if (!this.disposed) this.onDead()
            })
        })
    }

    private rejectAll(err: Error) {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
        this.pending.clear()
    }

    async call(action: string, source: string, info: any, timeoutMs: number): Promise<any> {
        await this.ready
        if (this.disposed) throw new Error('worker 已释放')
        const callId = ++this.nextCallId
        return new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(callId)
                reject(new Error('worker 调用超时'))
                // 脚本可能仍占着 worker 的事件循环；重建以免后续调用全部连锁超时
                this.dispose()
                this.onDead()
            }, timeoutMs)
            this.pending.set(callId, { resolve, reject, timer })
            try {
                this.worker.postMessage({ type: 'call', callId, action, source, info: toTransferable(info) } as MainToWorkerMessage)
            } catch (e: any) {
                clearTimeout(timer)
                this.pending.delete(callId)
                reject(new Error(`worker 消息发送失败: ${e?.message || e}`))
            }
        })
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.rejectAll(new Error('worker 已释放'))
        try { this.worker.postMessage({ type: 'dispose' } as MainToWorkerMessage) } catch { /* ignore */ }
        void this.worker.terminate()
    }
}

const hosts = new Map<string, SourceWorkerHost>()

function buildWorkerData(info: WorkerSourceInfo): SourceWorkerData {
    const cfg = readConfig()
    const mb = Number(process.env.CUSTOM_SOURCE_MAX_BODY_MB)
    const maxBodyBytes = Number.isFinite(mb) && mb > 0
        ? Math.round(mb * 1024 * 1024)
        : WORKER_DEFAULTS.maxBodyBytes
    const rawMs = Number(process.env.CUSTOM_SOURCE_REQUEST_MAX_MS)
    return {
        script: info.script,
        owner: info.owner,
        id: info.id,
        name: info.name,
        config: pickWorkerConfig(cfg),
        nodeEnv: process.env.NODE_ENV || 'production',
        maxBodyBytes,
        requestMaxMs: Number.isFinite(rawMs) && rawMs >= 5000 ? Math.round(rawMs) : WORKER_DEFAULTS.requestMaxMs,
        initTimeoutMs: WORKER_DEFAULTS.initTimeoutMs,
        scriptHash: scriptFingerprint(info.script),
    }
}

/** callRequest 前置判定：命中时完全脱离 governor 的慢源互斥闸，让多个慢源真正并行。 */
export function shouldRouteToWorker(owner: string, id: string): boolean {
    return workerPolicy.shouldUse(owner, id)
}

/** 取（或懒创建）该源的 worker；脚本指纹变化时先销毁旧的再重建。 */
export function getSourceWorker(info: WorkerSourceInfo): SourceWorkerHost {
    const key = keyOf(info.owner, info.id)
    const hash = scriptFingerprint(info.script)
    const old = hosts.get(key)
    if (old && old.data.scriptHash === hash) return old
    if (old) { old.dispose(); hosts.delete(key) }
    const host = new SourceWorkerHost(buildWorkerData(info), () => {
        // onDead 可能由 dispose 主动触发， only delete 仍指向自己的那个
        if (hosts.get(key) === host) hosts.delete(key)
    })
    hosts.set(key, host)
    console.log(`[自定义源-worker] ${info.name} 已进入独立线程（脚本同步块不再占用主线程）`)
    // 启动失败不能留在表里，否则后续调用会一直撞同一个坏 worker
    void host.ready.catch(() => { if (hosts.get(key) === host) hosts.delete(key) })
    return host
}

/** 只销毁 worker 实例，不动策略（用于失败熔断，避免下一轮又被判慢后重启坏 worker）。 */
function dropHost(owner: string, id: string): void {
    const key = keyOf(owner, id)
    const host = hosts.get(key)
    if (host) { host.dispose(); hosts.delete(key) }
}

/** 源被卸载/重载时调用，避免 worker 里残留旧脚本与定时器。 */
export function disposeSourceWorker(owner: string, id: string): void {
    dropHost(owner, id)
    workerPolicy.release(owner, id)
}

export interface WorkerCallResult {
    handled: boolean
    value?: any
    error?: Error
}

/**
 * 尝试用 worker 执行一次脚本调用。
 * handled=false 表示调用方应落回主线程 vm2 路径（未启用 / 已回退）。
 */
export async function tryWorkerCall(info: WorkerSourceInfo, action: string, source: string, rawInfo: any): Promise<WorkerCallResult> {
    if (!workerPolicy.shouldUse(info.owner, info.id)) return { handled: false }
    const timeoutMs = configNumber(readConfig(), 'customSource.callTimeoutMs', 20000)
    try {
        const host = getSourceWorker(info)
        const value = await host.call(action, source, rawInfo, timeoutMs)
        workerPolicy.noteSuccess(info.owner, info.id)
        return { handled: true, value }
    } catch (e: any) {
        const err = e instanceof Error ? e : new Error(String(e?.message || e))
        const decision = workerFailureDecision(err, workerPolicy.fallbackToMain)
        // 脚本业务失败（如「所有音源均失败」）等价于主线程路径的取链失败：
        // 原样抛给上层换源，不熔断、不回退重跑同一份脚本。
        if (!decision.countFailure) return { handled: true, error: err }
        const burnt = workerPolicy.noteFailure(info.owner, info.id)
        console.warn(`[自定义源-worker] ${info.name} 调用失败（${err.message}）${burnt ? '，已停用该源的 worker' : ''}${decision.fallback ? '，回退主线程' : ''}`)
        if (burnt) dropHost(info.owner, info.id)
        if (decision.fallback) return { handled: false, error: err }
        return { handled: true, error: err }
    }
}

/** /health 与面板可观测：当前哪些源跑在 worker、哪些已熔断。 */
export function getWorkerStatus() {
    return {
        enabled: workerPolicy.enabled,
        fallbackToMain: workerPolicy.fallbackToMain,
        active: [...hosts.keys()],
        ...workerPolicy.snapshot(),
    }
}
