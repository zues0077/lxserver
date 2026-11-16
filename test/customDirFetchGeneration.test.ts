import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

/**
 * public/music/js/customDir.js 是浏览器脚本，不能直接 import。与 artistClick.test.ts
 * 同一套路：把真实的 fetchData 方法体切出来挂到 mock manager 上，在 vm 里跑，
 * 验证的确实是线上代码而不是复制品。用 import.meta.url 定位，保证 cwd 无关。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '../public/music/js/customDir.js'), 'utf8')

const sliceByMarkers = (start: string, end: string): string => {
    const s = source.indexOf(start)
    const e = source.indexOf(end, s)
    assert.ok(s > 0, `找不到起点标记：${start}`)
    assert.ok(e > s, `找不到终点标记：${end}`)
    return source.slice(s, e)
}

const methodSrc = sliceByMarkers('    async fetchData(silent = false) {', '\n    async refresh() {')

type Payload = { data: any[], delay: number, allow?: Record<string, any> }

const buildManager = (payloads: Payload[], honorAbort = true) => {
    const applied: any[][] = []
    const errors: string[] = []
    let calls = 0
    const sandbox: any = {
        console,
        AbortController,
        setTimeout,
        clearTimeout,
        document: { getElementById: () => null },
        window: {},
        showError: (msg: string) => { errors.push(msg) },
        fetch: (_url: string, opts: any) => {
            const p = payloads[Math.min(calls++, payloads.length - 1)]
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    resolve({ ok: true, json: async () => ({ success: true, data: p.data, ...p.allow }) })
                }, p.delay)
                if (honorAbort) {
                    opts?.signal?.addEventListener('abort', () => {
                        clearTimeout(timer)
                        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
                    })
                }
            })
        },
    }
    sandbox.__applied = applied
    vm.createContext(sandbox)
    vm.runInContext(`
        const manager = {
            fetchGeneration: 0,
            pendingFetch: null,
            originalData: [],
            getAuthHeaders() { return {} },
            syncBatchButtonsVisibility() {},
            escapeHtml(s) { return String(s) },
            applyFilters() { globalThis.__applied.push(this.originalData.slice()) },
            ${methodSrc}
        };
        globalThis.__manager = manager;
    `, sandbox)
    return {
        manager: sandbox.__manager,
        applied,
        errors,
        windowRef: sandbox.window,
        getCalls: () => calls,
    }
}

test('慢旧请求后返回不覆盖新请求（generation 判废，即使不 abort）', async () => {
    const { manager, applied } = buildManager([
        { data: [{ filename: 'old.mp3' }], delay: 30 },
        { data: [{ filename: 'new.mp3' }], delay: 5 },
    ], false)

    await Promise.all([manager.fetchData(), manager.fetchData()])

    assert.equal(applied.length, 1, '旧请求结果必须被判废，只允许一次写回')
    assert.deepEqual(applied[0], [{ filename: 'new.mp3' }])
})

test('被取消的旧请求不弹错误提示', async () => {
    const { manager, applied, errors } = buildManager([
        { data: [{ filename: 'old.mp3' }], delay: 50 },
        { data: [{ filename: 'new.mp3' }], delay: 1 },
    ])

    await Promise.all([manager.fetchData(), manager.fetchData()])

    assert.deepEqual(errors, [], 'AbortError 不应触发 toast')
    assert.equal(applied.length, 1)
    assert.deepEqual(applied[0], [{ filename: 'new.mp3' }])
})

test('单次请求正常写回，权限标志写入 window', async () => {
    const m = buildManager([{
        data: [{ filename: 'a.mp3' }],
        delay: 1,
        allow: { allowOperateCustomMusicDir: true, allowWriteCustomMusicDir: false },
    }])

    await m.manager.fetchData()

    assert.equal(m.getCalls(), 1)
    assert.deepEqual(m.applied[0], [{ filename: 'a.mp3' }])
    assert.equal(m.windowRef.userAllowOperateCustomDir, true)
    assert.equal(m.windowRef.userAllowWriteCustomDir, false)
    assert.deepEqual(m.errors, [])
    assert.equal(m.manager.pendingFetch, null, '请求结束后应清空在飞 controller')
})
