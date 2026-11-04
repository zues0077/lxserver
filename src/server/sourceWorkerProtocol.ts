/**
 * 慢源 worker 隔离：主线程 <-> worker 的共享协议与纯函数。
 *
 * 抽成独立模块有两个目的：
 *  1. worker 内不 import 主线程的 userApi（那会拉进整条依赖链与 global.lx 单例）；
 *  2. 跨线程边界最易出错的「可序列化性 / 请求参数归一化」能脱离真线程单独跑单测。
 */

/** 主线程交给 worker 的启动参数（必须全部可结构化克隆）。 */
export interface SourceWorkerData {
    script: string
    owner: string
    id: string
    name: string
    /** 只读配置快照，仅含白名单键，绝不含凭据 */
    config: Record<string, any>
    nodeEnv: string
    maxBodyBytes: number
    requestMaxMs: number
    initTimeoutMs: number
    scriptHash: string
}

export type MainToWorkerMessage =
    | { type: 'call'; callId: number; action: string; source: string; info: any }
    | { type: 'dispose' }

export type WorkerToMainMessage =
    | { type: 'ready'; sources: Record<string, any> }
    | { type: 'fatal'; message: string }
    | { type: 'result'; callId: number; ok: true; value: any; fromScript?: false }
    | { type: 'result'; callId: number; ok: false; error: string; fromScript?: boolean }
    | { type: 'log'; level: 'log' | 'info' | 'debug' | 'warn' | 'error'; text: string }

export const WORKER_DEFAULTS = {
    initTimeoutMs: 3000,
    vmTimeoutMs: 10000,
    requestMaxMs: 30000,
    maxBodyBytes: 8 * 1024 * 1024,
} as const

/** 允许带进 worker 的配置前缀。配置文件里的鉴权/账号类键一律不带。 */
const CONFIG_ALLOW_PREFIXES = ['proxy.', 'customSource.', 'debug.']
const CONFIG_ALLOW_EXACT = ['system.allowUnsafeVM']
const CONFIG_DENY_RE = /(pass(word)?|token|secret|auth|cookie|credential|privatekey)/i

/**
 * 从主线程 global.lx.config 抽一份最小快照。
 * 明文库放在白名单前缀里、值需能安全 JSON 化（数组/普通对象也放行，代理规则常用）。
 */
export function pickWorkerConfig(cfg: Record<string, any> | undefined | null): Record<string, any> {
    const out: Record<string, any> = {}
    if (!cfg || typeof cfg !== 'object') return out
    for (const key of Object.keys(cfg)) {
        if (CONFIG_DENY_RE.test(key)) continue
        if (!CONFIG_ALLOW_EXACT.includes(key) && !CONFIG_ALLOW_PREFIXES.some(p => key.startsWith(p))) continue
        const value = cfg[key]
        const t = typeof value
        if (value === null || t === 'string' || t === 'number' || t === 'boolean') {
            out[key] = value
            continue
        }
        if (t === 'object') {
            try { out[key] = JSON.parse(JSON.stringify(value)) } catch { /* 循环引用/不可序列化 → 不带 */ }
        }
    }
    return out
}

/** 脚本内容指纹：用于源重载后自动重建 worker，避免 worker 里跑着旧脚本。 */
export function scriptFingerprint(script: string): string {
    let hash = 2166136261
    for (let i = 0; i < script.length; i++) {
        hash ^= script.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return `${(hash >>> 0).toString(16)}:${script.length}`
}

/**
 * 把任意值转成可安全 postMessage 的纯 JSON。
 * Buffer 用显式标记承载，Error 收敛成 message，函数/undefined/Symbol 丢弃，
 * 深层与超宽对象做截断，防止脚本返回巨对象把结构化克隆也拖成同步阻塞。
 */
export function toTransferable(value: any, depth = 0): any {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return null
    if (depth > 8) return null
    if (Buffer.isBuffer(value)) return { __lx_buffer__: value.toString('base64') }
    if (value instanceof Uint8Array) return { __lx_buffer__: Buffer.from(value).toString('base64') }
    if (value instanceof Error) return { __lx_error__: String(value?.message || value) }
    if (Array.isArray(value)) return value.slice(0, 10000).map(v => toTransferable(v, depth + 1))
    if (typeof value === 'object') {
        const out: Record<string, any> = {}
        let count = 0
        for (const key of Object.keys(value)) {
            if (count++ >= 2000) break
            try { out[key] = toTransferable(value[key], depth + 1) } catch { out[key] = null }
        }
        return out
    }
    return null
}

/** toTransferable 的逆变换：把 Buffer 标记还原成真实 Buffer。 */
export function fromTransferable(value: any): any {
    if (value === null || typeof value !== 'object') return value
    if (typeof value.__lx_buffer__ === 'string') {
        try { return Buffer.from(value.__lx_buffer__, 'base64') } catch { return Buffer.alloc(0) }
    }
    if (typeof value.__lx_error__ === 'string') return new Error(value.__lx_error__)
    if (Array.isArray(value)) return value.map(fromTransferable)
    const out: Record<string, any> = {}
    for (const key of Object.keys(value)) out[key] = fromTransferable(value[key])
    return out
}

/**
 * 原生 vm 的 contextified 对象 -> 宿主普通对象。
 * 主线程 vm2 用 decontextify；worker 内没有 vm2 代理，只需纯净化原型链，
 * 且必须保留 Buffer，否则 form/body 里的二进制会被误转成 {}。
 */
export function plainify(value: any, depth = 0): any {
    if (value === null || typeof value !== 'object') return value
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)
    if (depth > 8) return value
    if (Array.isArray(value)) return value.map(v => plainify(v, depth + 1))
    const out: Record<string, any> = {}
    for (const key of Object.keys(value)) {
        try { out[key] = plainify(value[key], depth + 1) } catch { /* getter 抛错就跳过 */ }
    }
    return out
}

/** lx.request 的 options -> needle options。超时帽与 body 上限在这里统一收口。 */
export function buildRequestOptions(options: any, cfg: { requestMaxMs: number; blockPrivateNetwork: boolean; lookup?: any }): any {
    const safe = plainify(options || {})
    const { headers } = safe
    const rawTimeout = Number(safe.timeout)
    return {
        headers,
        follow_max: -1, // 由 worker 自己逐跳校验后跟随，不让 needle 悄悄绕过内网护栏
        lookup: cfg.lookup,
        response_timeout: Math.min(
            Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : cfg.requestMaxMs,
            cfg.requestMaxMs,
        ),
        // 让 needle 按二进制返回，交给 worker 自行判体积/parse，避免它自己做一次深拷贝
        compressed: true,
    }
}

/** 从脚本 options 里取出 method / body（form 与 formData 优先级与原实现一致）。 */
export function pickRequestParts(options: any): { method: string; data: any; json: boolean } {
    const safe = plainify(options || {})
    const method = typeof safe.method === 'string' && safe.method ? safe.method : 'get'
    if (safe.form !== undefined) return { method, data: safe.form, json: false }
    if (safe.formData !== undefined) return { method, data: safe.formData, json: false }
    return { method, data: safe.body, json: true }
}

export interface WorkerFailureDecision {
    /** true = 结果由 worker 链路负责（抛给上层换源）；false = 落回主线程 vm2 路径 */
    handled: boolean
    /** 是否计入「worker 基础设施故障」熔断计数 */
    countFailure: boolean
    fallback: boolean
}

/**
 * 区分「脚本业务失败」与「worker 基础设施故障」。
 *
 * 实机教训（test-r43）：脚本 handler reject('所有音源均失败') 是取链失败的**正常业务结果**，
 * 与主线程 vm2 路径下抛出的错误完全等价。若把它算成 worker 故障，连续两次就会熔断并
 * 回退主线程，慢源又跑回主线程继续卡 13s —— 隔离等于白做。
 * 只有超时 / ready 失败 / worker 退出 / postMessage 失败才算基础设施故障。
 */
export function workerFailureDecision(err: any, fallbackToMain: boolean): WorkerFailureDecision {
    const fromScript = !!(err && typeof err === 'object' && (err as any).fromScript === true)
    if (fromScript) return { handled: true, countFailure: false, fallback: false }
    return { handled: !fallbackToMain, countFailure: true, fallback: fallbackToMain }
}

export function configBool(cfg: Record<string, any>, key: string, fallback: boolean): boolean {
    const raw = cfg?.[key]
    return typeof raw === 'boolean' ? raw : fallback
}

export function configNumber(cfg: Record<string, any>, key: string, fallback: number): number {
    const raw = Number(cfg?.[key])
    return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
