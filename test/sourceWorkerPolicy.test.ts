/**
 * 慢源 worker 隔离：启用策略与失败回退的单元测试。
 * 不启动真 Worker，只验证「哪些源该进 worker、失败后怎么退」。
 */
import test from 'node:test'
import assert from 'node:assert'
import { WorkerPolicy } from '../src/server/sourceWorkerHost'

const baseCfg = (over: Record<string, any> = {}) => ({
    'customSource.governor.worker.enabled': true,
    'customSource.governor.worker.fallbackToMain': true,
    ...over,
})

test('方案 A：未降速的源不进 worker，降速后才进', () => {
    let throttled = false
    const p = new WorkerPolicy(() => baseCfg(), () => throttled)
    assert.equal(p.shouldUse('u', 'fast'), false)
    assert.equal(p.isWorkerSource('u', 'fast'), false)
    throttled = true
    assert.equal(p.shouldUse('u', 'fast'), true)
    assert.equal(p.isWorkerSource('u', 'fast'), true)
})

test('进入 worker 后常驻：降速状态过期也不会反复重启 worker', () => {
    let throttled = true
    const p = new WorkerPolicy(() => baseCfg(), () => throttled)
    assert.equal(p.shouldUse('u', 'slow'), true)
    throttled = false // 模拟 sourceGovernor 的 30 分钟 TTL 到期
    assert.equal(p.shouldUse('u', 'slow'), true)
})

test('总开关关闭：已进 worker 的源也立刻回到主线程', () => {
    const p = new WorkerPolicy(() => baseCfg({ 'customSource.governor.worker.enabled': false }), () => true)
    assert.equal(p.enabled, false)
    assert.equal(p.shouldUse('u', 'slow'), false)
})

test('连续失败 2 次熔断：该源本次进程内不再尝试 worker', () => {
    const p = new WorkerPolicy(() => baseCfg(), () => true)
    assert.equal(p.shouldUse('u', 'bad'), true)
    assert.equal(p.noteFailure('u', 'bad'), false)
    assert.equal(p.isDisabled('u', 'bad'), false)
    assert.equal(p.noteFailure('u', 'bad'), true)
    assert.equal(p.isDisabled('u', 'bad'), true)
    assert.equal(p.shouldUse('u', 'bad'), false)
})

test('成功一次会把失败计数清零', () => {
    const p = new WorkerPolicy(() => baseCfg(), () => true)
    p.noteFailure('u', 'x')
    p.noteSuccess('u', 'x')
    assert.equal(p.noteFailure('u', 'x'), false)
    assert.equal(p.isDisabled('u', 'x'), false)
})

test('release 后重新按降速判定（源重载/卸载语义）', () => {
    let throttled = true
    const p = new WorkerPolicy(() => baseCfg(), () => throttled)
    p.shouldUse('u', 'x')
    p.noteFailure('u', 'x'); p.noteFailure('u', 'x')
    assert.equal(p.isDisabled('u', 'x'), true)
    throttled = false
    p.release('u', 'x')
    assert.equal(p.snapshot().workerKeys.length, 0)
    assert.equal(p.snapshot().disabledKeys.length, 0)
    assert.equal(p.shouldUse('u', 'x'), false)
})

test('fallbackToMain 关闭时，失败不再回退主线程', () => {
    const p = new WorkerPolicy(() => baseCfg({ 'customSource.governor.worker.fallbackToMain': false }), () => true)
    assert.equal(p.fallbackToMain, false)
})

test('配置读取：老配置缺键时按默认 true', () => {
    const p = new WorkerPolicy(() => ({}), () => true)
    assert.equal(p.enabled, true)
    assert.equal(p.fallbackToMain, true)
    assert.equal(p.shouldUse('u', 'x'), true)
})

test('markEligible: 降速当场登记，开关关闭/已熔断时不登记', () => {
    const p = new WorkerPolicy(() => baseCfg(), () => false)
    assert.equal(p.markEligible('u', 'slow'), true)
    assert.equal(p.markEligible('u', 'slow'), false) // 幂等
    assert.equal(p.isWorkerSource('u', 'slow'), true)

    const off = new WorkerPolicy(() => baseCfg({ 'customSource.governor.worker.enabled': false }), () => true)
    assert.equal(off.markEligible('u', 'x'), false)
    assert.equal(off.isWorkerSource('u', 'x'), false)

    const burnt = new WorkerPolicy(() => baseCfg(), () => true)
    burnt.noteFailure('u', 'y'); burnt.noteFailure('u', 'y')
    assert.equal(burnt.markEligible('u', 'y'), false)
})

test('test-r44 回归：降速后无后续调用、governor TTL 过期，worker 仍常驻', () => {
    let throttled = false
    const p = new WorkerPolicy(() => baseCfg(), () => throttled)
    // 模拟一次主线程同步块把源判成降速，随后立刻登记
    throttled = true
    p.markEligible('u', 'feidao')
    // 30 分钟后 governor 的 throttle 过期（巡检又会带上该源）
    throttled = false
    assert.equal(p.shouldUse('u', 'feidao'), true)
    assert.equal(p.isWorkerSource('u', 'feidao'), true)
    // 且这次巡检调用会直接走 worker，不会再回主线程卡事件循环
})

test('snapshot 可用于 /health 观测', () => {
    const p = new WorkerPolicy(() => baseCfg(), () => true)
    p.shouldUse('a', '1'); p.shouldUse('b', '2')
    p.noteFailure('b', '2'); p.noteFailure('b', '2')
    assert.deepEqual(p.snapshot().workerKeys.sort(), ['a_1', 'b_2'])
    assert.deepEqual(p.snapshot().disabledKeys, ['b_2'])
    p.resetForTest()
    assert.deepEqual(p.snapshot(), { workerKeys: [], disabledKeys: [] })
})
