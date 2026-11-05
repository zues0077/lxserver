/**
 * 慢源 worker 隔离：跨线程协议纯函数的单元测试。
 *
 * 这些函数不依赖真 worker，但一旦写错就是线上「取链结果变 undefined /
 * 二进制 body 变 {} / 超时帽失效」这类难查的问题，所以单独守住。
 */
import test from 'node:test'
import assert from 'node:assert'
import {
    WORKER_DEFAULTS,
    buildRequestOptions,
    configBool,
    configNumber,
    fromTransferable,
    pickRequestParts,
    pickWorkerConfig,
    plainify,
    scriptFingerprint,
    toTransferable,
    workerFailureDecision,
} from '../src/server/sourceWorkerProtocol'

test('pickWorkerConfig: 只带白名单键，凭据类键一律不带', () => {
    const cfg = {
        'proxy.all.enable': true,
        'proxy.all.address': 'http://127.0.0.1:7890',
        'customSource.governor.worker.enabled': true,
        'customSource.callTimeoutMs': 20000,
        'debug.enabled': false,
        'system.allowUnsafeVM': false,
        'system.frontendAuth': '123456',          // 不在白名单
        'customSource.accessToken': 'SECRET',     // 白名单前缀但命中凭据规则
        'musicAccount.token': 'SECRET',           // 不在白名单
    }
    const out = pickWorkerConfig(cfg)
    assert.equal(out['proxy.all.enable'], true)
    assert.equal(out['customSource.governor.worker.enabled'], true)
    assert.equal(out['customSource.callTimeoutMs'], 20000)
    assert.equal(out['system.allowUnsafeVM'], false)
    assert.equal('system.frontendAuth' in out, false)
    assert.equal('customSource.accessToken' in out, false)
    assert.equal('musicAccount.token' in out, false)
    assert.deepEqual(pickWorkerConfig(undefined), {})
})

test('pickWorkerConfig: 循环引用不会抛错也不会带进 worker', () => {
    const cyc: any = { a: 1 }
    cyc.self = cyc
    const out = pickWorkerConfig({ 'proxy.loop': cyc, 'proxy.ok': 'x' })
    assert.equal('proxy.loop' in out, false)
    assert.equal(out['proxy.ok'], 'x')
})

test('scriptFingerprint: 同脚本稳定、改一个字符即变化', () => {
    const a = 'lx.send("inited", {sources:{}})'
    assert.equal(scriptFingerprint(a), scriptFingerprint(a))
    assert.notEqual(scriptFingerprint(a), scriptFingerprint(a + ' '))
})

test('toTransferable/fromTransferable: Buffer、Error、嵌套与函数', () => {
    const src = {
        url: 'http://x/y.mp3',
        buf: Buffer.from([1, 2, 3, 255]),
        nested: { ok: true, nothing: undefined, fn: () => 1, list: [1, 'a', null] },
        err: new Error('boom'),
    }
    const moved = JSON.parse(JSON.stringify(toTransferable(src)))
    const back = fromTransferable(moved)
    assert.equal(back.url, 'http://x/y.mp3')
    assert.ok(Buffer.isBuffer(back.buf))
    assert.deepEqual([...back.buf], [1, 2, 3, 255])
    assert.equal(back.nested.ok, true)
    assert.equal(back.nested.nothing, null)
    assert.equal(back.nested.fn, null)
    assert.deepEqual(back.nested.list, [1, 'a', null])
    assert.ok(back.err instanceof Error)
    assert.equal(back.err.message, 'boom')
})

test('toTransferable: 循环引用与超深对象被截断，不会无限递归', () => {
    const cyc: any = { a: 1 }
    cyc.self = cyc
    const out = toTransferable(cyc)
    assert.equal(out.a, 1)
    let deep: any = 1
    for (let i = 0; i < 30; i++) deep = { deep }
    assert.doesNotThrow(() => toTransferable(deep))
})

test('plainify: 保留 Buffer，纯化嵌套对象', () => {
    const buf = Buffer.from('abc')
    const out = plainify({ body: buf, headers: { a: 'b' }, list: [1, 2] })
    assert.ok(Buffer.isBuffer(out.body))
    assert.equal(out.body.toString(), 'abc')
    assert.deepEqual(out.headers, { a: 'b' })
    assert.deepEqual(out.list, [1, 2])
})

test('buildRequestOptions: 超时帽生效、follow_max 必须为 -1', () => {
    const lookup = () => { }
    const a = buildRequestOptions({ method: 'get', timeout: 999999, headers: { h: '1' } }, {
        requestMaxMs: 30000, blockPrivateNetwork: true, lookup,
    })
    assert.equal(a.response_timeout, 30000)
    assert.equal(a.follow_max, -1)
    assert.equal(a.lookup, lookup)
    assert.deepEqual(a.headers, { h: '1' })

    const b = buildRequestOptions({ timeout: 1200 }, { requestMaxMs: 30000, blockPrivateNetwork: false })
    assert.equal(b.response_timeout, 1200)
    const c = buildRequestOptions({}, { requestMaxMs: 5000, blockPrivateNetwork: true })
    assert.equal(c.response_timeout, 5000)
    assert.equal(WORKER_DEFAULTS.maxBodyBytes, 8 * 1024 * 1024)

    // read_timeout 必须显式设：needle 默认 0 = 永不超时，响应头回来但 body 断流就永久挂起
    // （246 实测 Hei Music inflight 卡 65 不动、rss 1.07GB）
    assert.equal(a.read_timeout, 30000)
    assert.equal(b.read_timeout, 1200)
    assert.equal(c.read_timeout, 5000)
})

test('pickRequestParts: form / formData 优先于 body，且关闭 json', () => {
    assert.deepEqual(pickRequestParts({ method: 'post', body: 'b' }), { method: 'post', data: 'b', json: true })
    const f = pickRequestParts({ method: 'post', body: 'b', form: { k: 'v' } })
    assert.equal(f.json, false)
    assert.deepEqual(f.data, { k: 'v' })
    const fd = pickRequestParts({ form: { a: 1 }, formData: { b: 2 } })
    assert.deepEqual(fd.data, { a: 1 }) // form 优先，与主实现一致
    assert.equal(pickRequestParts({}).method, 'get')
})

test('configBool/configNumber: 缺失与非法值走默认', () => {
    const cfg = { a: false, b: 0, c: 'oops', d: 42 }
    assert.equal(configBool(cfg, 'a', true), false)
    assert.equal(configBool(cfg, 'missing', true), true)
    assert.equal(configNumber(cfg, 'd', 7), 42)
    assert.equal(configNumber(cfg, 'b', 7), 7)
    assert.equal(configNumber(cfg, 'c', 7), 7)
})

// test-r43 实机回归：脚本 reject('所有音源均失败') 是业务取链失败，
// 曾被误计为 worker 故障 → 连败 2 次熔断 → 回退主线程继续卡 13s。
test('workerFailureDecision: 脚本业务失败不熔断、不回退，原样交给上层换源', () => {
    const scriptErr = Object.assign(new Error('所有音源均失败'), { fromScript: true })
    for (const fallback of [true, false]) {
        const d = workerFailureDecision(scriptErr, fallback)
        assert.deepEqual(d, { handled: true, countFailure: false, fallback: false })
    }
})

test('workerFailureDecision: worker 基础设施故障才计入熔断', () => {
    const infra = new Error('worker 调用超时')
    assert.deepEqual(workerFailureDecision(infra, true), { handled: false, countFailure: true, fallback: true })
    assert.deepEqual(workerFailureDecision(infra, false), { handled: true, countFailure: true, fallback: false })
    // 纯字符串/undefined 抛出物也按基础设施故障处理，不能被误认成业务失败
    assert.equal(workerFailureDecision(undefined, true).countFailure, true)
    assert.equal(workerFailureDecision('boom', true).countFailure, true)
    assert.equal(workerFailureDecision({ fromScript: 1 }, true).countFailure, true)
})
