/**
 * 慢源独立线程运行时（由 sourceWorkerHost 用 new Worker 启动，不要在主线程 import 执行）。
 *
 * 为什么 lx.request 必须留在本线程发 HTTP：手册 P-1046 实测主线程卡顿的根因是
 * 「一批响应同时回来时，每个回调在 vm2 边界做 decontextify 同步深拷贝 + JSON.parse」。
 * 若把 request 做成 RPC 转发回主线程，深拷贝与结构化克隆双份开销仍压在主线程上，
 * 隔离就白做了。因此这里自带一份精简的 lx 兼容层：脚本、网络、响应解析、回调
 * 全部留在本 worker，只有「调用请求」与「最终结果」跨线程。
 *
 * 沙箱用原生 vm 而非 vm2：worker 本身已是独立线程，且 worker 内不挂 global.lx 之外的
 * 凭据（配置是白名单快照），去掉 vm2 代理层正好消掉 decontextify 这段同步开销。
 */

import { parentPort, workerData } from 'worker_threads'
import * as vm from 'vm'
import * as crypto from 'crypto'
import * as zlib from 'zlib'
import { promisify } from 'util'
import needle from 'needle'
import { getProxyAgent } from '../modules/utils/proxy.js'
import { encodeRequestUrl } from '../utils/urlEncode.js'
import { checkLiteralTarget, createGuardedLookup } from './requestGuard.js'
import {
    type MainToWorkerMessage,
    type SourceWorkerData,
    type WorkerToMainMessage,
    WORKER_DEFAULTS,
    buildRequestOptions,
    configBool,
    pickRequestParts,
    plainify,
    toTransferable,
} from './sourceWorkerProtocol.js'

const inflate = promisify(zlib.inflate)
const deflate = promisify(zlib.deflate)

function post(msg: WorkerToMainMessage) {
    try { parentPort?.postMessage(msg) } catch { /* 主线程已退出 */ }
}

async function boot(data: SourceWorkerData) {
    const port = parentPort!
    // 代理模块与护栏模块都从 global.lx.config 读配置，这里注入最小只读快照
    ;(global as any).lx = { config: data.config || {} }
    const cfg = data.config || {}
    const name = data.name || data.id
    const debug = configBool(cfg, 'debug.enabled', false)
    const guardedLookup = createGuardedLookup(() => configBool(cfg, 'customSource.blockPrivateNetwork', true))

    let agentHttps: any
    let agentHttp: any
    try {
        agentHttps = await getProxyAgent('https://lx-proxy-probe.invalid', 'customSource')
        if (agentHttps) agentHttp = await getProxyAgent('http://lx-proxy-probe.invalid', 'customSource')
    } catch { /* 代理不可用就直连，脚本自己会失败并回退 */ }

    let disposed = false
    const timers = new Set<any>()
    const pendingAborts = new Set<() => void>()
    let requestHandler: Function | null = null
    let registeredSources: Record<string, any> = {}

    let initResolve: (() => void) | null = null
    let initReject: ((e: Error) => void) | null = null
    const initPromise = new Promise<void>((resolve, reject) => {
        initResolve = resolve
        initReject = reject
    })

    const track = (id: any) => { timers.add(id); return id }
    const untrack = (id: any) => { timers.delete(id) }
    const setT = (fn: Function, ms?: number, ...args: any[]) => {
        let id: any
        id = setTimeout(() => {
            untrack(id)
            if (!disposed) { try { fn(...args) } catch (e: any) { post({ type: 'log', level: 'warn', text: `[worker:${name}] 定时器回调异常: ${e?.message || e}` }) } }
        }, typeof ms === 'number' ? ms : 0)
        return track(id)
    }
    const setI = (fn: Function, ms?: number, ...args: any[]) => track(setInterval(() => {
        if (disposed) return
        try { fn(...args) } catch (e: any) { post({ type: 'log', level: 'warn', text: `[worker:${name}] 间隔定时器异常: ${e?.message || e}` }) }
    }, typeof ms === 'number' ? ms : 0))
    const clearT = (t: any) => { untrack(t); clearTimeout(t); clearInterval(t) }

    const sandboxConsole: Record<string, any> = {}
    for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
        sandboxConsole[level] = (...args: any[]) => {
            if (level !== 'warn' && level !== 'error' && !debug) return
            post({ type: 'log', level, text: `[worker:${name}] ${args.map(a => {
                if (typeof a === 'string') return a
                try { return JSON.stringify(a) } catch { return String(a) }
            }).join(' ')}` })
        }
    }

    // ---- lx.utils：worker 内自跑，Buffer 不出线程，无需跨边界编码 ----
    const lxUtils = {
        buffer: {
            from: (d: any, e: any) => Buffer.from(plainify(d), plainify(e)),
            bufToString: (b: any, f: any) => Buffer.isBuffer(b) ? b.toString(f) : Buffer.from(b, 'binary').toString(f),
        },
        crypto: {
            md5: (str: string) => crypto.createHash('md5').update(String(plainify(str) || '')).digest('hex'),
            aesEncrypt: (buffer: any, mode: string, key: any, iv: any) => {
                const dKey = plainify(key)
                const dIv = plainify(iv)
                const algorithm = `aes-${(dKey as any).length * 8}-${mode}`
                const cipher = crypto.createCipheriv(algorithm as any, dKey as any, dIv as any)
                return Buffer.concat([cipher.update(plainify(buffer) as any) as any, cipher.final() as any])
            },
            rsaEncrypt: (buffer: any, key: any) => crypto.publicEncrypt(plainify(key) as any, plainify(buffer) as any),
            randomBytes: (size: number) => crypto.randomBytes(size),
        },
        zlib: {
            inflate: (buffer: any) => inflate(plainify(buffer) as any),
            deflate: (buffer: any) => deflate(plainify(buffer) as any),
        },
    }

    // ---- lx.request：HTTP 全程留在本 worker ----
    const lxRequest = (url: string, options: any, callback: Function) => {
        const requestOptions = buildRequestOptions(options, {
            requestMaxMs: data.requestMaxMs || WORKER_DEFAULTS.requestMaxMs,
            blockPrivateNetwork: configBool(cfg, 'customSource.blockPrivateNetwork', true),
            lookup: guardedLookup,
        })
        const { method, data: reqData, json } = pickRequestParts(options)
        if (json === false) requestOptions.json = false
        if (agentHttps && /^https:/i.test(String(url))) requestOptions.agent = agentHttps
        else if (agentHttp) requestOptions.agent = agentHttp

        let cancelled = false
        let currentReq: any = null
        const abort = () => {
            try { const r = currentReq?.request; if (r && !r.aborted) r.abort() } catch { /* ignore */ }
        }
        const abortFn = () => { cancelled = true; abort(); pendingAborts.delete(abortFn) }

        const handleResponse = (err: any, resp: any, body: any) => {
            if (cancelled || disposed) return
            if (err) {
                try { callback.call(null, plainify(err), null, null) } catch { /* ignore */ }
                return
            }
            const bodyBytes = typeof body === 'string' ? Buffer.byteLength(body) : (Buffer.isBuffer(body) ? body.length : 0)
            if (bodyBytes > (data.maxBodyBytes || WORKER_DEFAULTS.maxBodyBytes)) {
                const e: any = new Error(`响应体过大（${bodyBytes} 字节），已按失败处理`)
                e.code = 'EBODYTOOLARGE'
                try { callback.call(null, e, null, null) } catch { /* ignore */ }
                return
            }
            let parsedBody = body
            if (typeof body === 'string') { try { parsedBody = JSON.parse(body) } catch { /* 非 JSON 原样给脚本 */ } }
            const safeResp: any = plainify({
                statusCode: resp?.statusCode,
                statusMessage: resp?.statusMessage,
                headers: resp?.headers,
            })
            safeResp.body = plainify(parsedBody)
            try { callback.call(null, null, safeResp, safeResp.body) } catch (e: any) {
                post({ type: 'log', level: 'warn', text: `[worker:${name}] lx.request 回调异常: ${e?.message || e}` })
            }
        }

        // 逐跳自己做 302：needle 的自动跳转目标不经 checkLiteralTarget，会绕开内网护栏
        const follow = (target: string, verb: string, payload: any, hops: number) => {
            if (cancelled || disposed) return
            const blocked = checkLiteralTarget(target)
            if (!blocked.ok) {
                const e: any = new Error(`目标地址属于内网保留网段（${blocked.reason}），已被自定义源出站护栏拦截: ${blocked.host}`)
                e.code = 'EBLOCKEDPRIVATE'
                try { callback.call(null, e, null, null) } catch { /* ignore */ }
                return
            }
            currentReq = needle.request(verb as any, encodeRequestUrl(target), payload, requestOptions, (err: any, resp: any, body: any) => {
                if (!err && resp && resp.statusCode >= 300 && resp.statusCode < 400 && hops < 5) {
                    const raw = Array.isArray(resp.headers?.location) ? resp.headers.location[0] : resp.headers?.location
                    let next = ''
                    if (raw) { try { next = new URL(String(raw), target).toString() } catch { /* 非法 Location 当普通响应 */ } }
                    if (next) {
                        const keep = resp.statusCode === 307 || resp.statusCode === 308
                        const bodyless = /^(get|head)$/i.test(verb)
                        follow(next, keep || bodyless ? verb : 'get', keep || bodyless ? payload : null, hops + 1)
                        return
                    }
                }
                handleResponse(err, resp, body)
            })
            if (cancelled) abort()
        }

        pendingAborts.add(abortFn)
        follow(String(url), method, reqData as any, 0)
        return abortFn
    }

    const lxObject: Record<string, any> = {
        version: '2.0.0',
        env: 'desktop',
        platform: 'web',
        currentScriptInfo: {
            name: data.name,
            rawScript: data.script,
        },
        EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
        utils: lxUtils,
        request: lxRequest,
        send: (eventName: string, payload: any) => {
            if (disposed) return
            const d = plainify(payload)
            if (eventName === 'inited') {
                if (d && d.sources) registeredSources = d.sources
                initResolve?.()
            } else if (eventName === 'updateAlert') {
                const text = typeof d === 'string' ? d : String(d?.log || d?.updateMsg || d?.msg || '')
                initReject?.(new Error(`发现新版本, 需要更新: ${text}`))
            }
        },
        on: (eventName: string, handler: Function) => {
            if (eventName === 'request') requestHandler = handler
        },
        // 主线程 lx 没有 off；worker 侧补空实现，避免原本靠「脚本不调」侥幸没炸的源直接 TypeError
        off: (eventName: string) => { if (eventName === 'request') requestHandler = null },
    }

    const sandbox: any = {
        console: sandboxConsole,
        setTimeout: setT,
        clearTimeout: clearT,
        setInterval: setI,
        clearInterval: clearT,
        setImmediate: (fn: Function, ...args: any[]) => setT(() => fn(...args), 0),
        clearImmediate: clearT,
        queueMicrotask: (fn: Function) => setT(() => fn(), 0),
        Buffer,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        process: {
            nextTick: (fn: Function, ...args: any[]) => setT(() => fn(...args), 0),
            env: { NODE_ENV: data.nodeEnv || 'production' },
        },
        lx: lxObject,
        global: null,
        window: null,
        globalThis: null,
        atob: (s: string) => Buffer.from(String(s), 'base64').toString('binary'),
        btoa: (s: string) => Buffer.from(String(s), 'binary').toString('base64'),
        crypto,
    }
    sandbox.global = sandbox
    sandbox.window = sandbox
    sandbox.globalThis = sandbox

    const dispose = () => {
        if (disposed) return
        disposed = true
        for (const t of timers) { clearTimeout(t); clearInterval(t) }
        timers.clear()
        for (const fn of pendingAborts) { try { fn() } catch { /* ignore */ } }
        pendingAborts.clear()
        requestHandler = null
    }

    process.on('uncaughtException', (e: any) => {
        post({ type: 'log', level: 'error', text: `[worker:${name}] 未捕获异常: ${e?.message || e}` })
    })
    process.on('unhandledRejection', (e: any) => {
        post({ type: 'log', level: 'warn', text: `[worker:${name}] 未处理拒绝: ${e?.message || e}` })
    })

    port.on('message', (msg: MainToWorkerMessage) => {
        if (msg.type === 'dispose') { dispose(); process.exit(0); return }
        if (msg.type !== 'call') return
        const { callId } = msg
        const handler = requestHandler
        if (!handler) {
            post({ type: 'result', callId, ok: false, error: `源 ${name} 未注册 request 处理器` })
            return
        }
        // 纯净化原型链：原生 vm 下脚本对宿主 realm 对象做 instanceof 会失败
        let input: any
        try { input = JSON.parse(JSON.stringify({ action: msg.action, source: msg.source, info: msg.info ?? null })) } catch {
            input = { action: msg.action, source: msg.source, info: null }
        }
        try {
            Promise.resolve(handler(input))
                .then(value => post({ type: 'result', callId, ok: true, value: toTransferable(value) }))
                .catch(e => post({ type: 'result', callId, ok: false, fromScript: true, error: String(e?.message || e) }))
        } catch (e: any) {
            // 脚本同步抛错同样是业务失败，不是 worker 故障
            post({ type: 'result', callId, ok: false, fromScript: true, error: String(e?.message || e) })
        }
    })

    try {
        const context = vm.createContext(sandbox)
        vm.runInContext(data.script, context, {
            filename: `custom_source_worker_${data.id}.js`,
            timeout: WORKER_DEFAULTS.vmTimeoutMs,
        })
        let initTimer: any
        await Promise.race([
            initPromise,
            new Promise((_, reject) => {
                initTimer = track(setTimeout(() => reject(new Error('worker 内脚本初始化超时')), data.initTimeoutMs || WORKER_DEFAULTS.initTimeoutMs))
            }),
        ]).finally(() => { untrack(initTimer); clearTimeout(initTimer) })
        post({ type: 'ready', sources: toTransferable(registeredSources) })
    } catch (e: any) {
        post({ type: 'fatal', message: String(e?.message || e) })
        dispose()
        process.exit(1)
    }
}

if (parentPort) {
    void boot(workerData as SourceWorkerData).catch((e: any) => {
        post({ type: 'fatal', message: String(e?.message || e) })
        process.exit(1)
    })
}
