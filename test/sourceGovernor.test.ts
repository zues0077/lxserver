/**
 * 慢源「降速运行」：兼容可用但会拖慢主线程的音源，而不是直接停用它。
 *
 * 背景（2026-11-04，246 实测）：「非常刀」「西瓜聚合源」单条响应里脚本自身同步跑 4.8~5.6 秒。
 * 这类源往往真能出链（可用性没问题），停用等于拿可用性换稳定。
 * 降速运行把它关进单间：
 *   - 慢源之间互斥（全局同时只跑 1 个），两个 5 秒的同步块不会叠成 10 秒；
 *   - 同一慢源单飞（1 个在跑 + 最多 1 个排队），连点三次不会叠成 15 秒；
 *   - 正常源完全直通，不能为了慢源牺牲快源；
 *   - 30 分钟无新慢记录自动恢复，一次偶发不算数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
    clearThrottle,
    getGovernorConfig,
    getGovernorQueueDepth,
    isThrottled,
    listThrottled,
    noteSyncBlock,
    resetGovernorForTest,
    runWithGovernor,
} from '../src/server/sourceGovernor.ts'

/** 每个用例都从干净状态开始：状态表是模块级单例 */
test.beforeEach(() => {
    resetGovernorForTest()
    ;(global as any).lx = { config: {} }
})

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

test('默认阈值 800ms / 2 次：单次慢不降速，第二次才降', () => {
    const cfg = getGovernorConfig()
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.syncMs, 800)
    assert.equal(cfg.minHits, 2)

    const first = noteSyncBlock('open', 'a.js', '源A', 5200)
    assert.equal(first.justThrottled, false, '偶发一次不该戴帽子')
    assert.equal(isThrottled('open', 'a.js'), false)

    const second = noteSyncBlock('open', 'a.js', '源A', 5100)
    assert.equal(second.justThrottled, true)
    assert.equal(isThrottled('open', 'a.js'), true)
    assert.equal(second.hits, 2)
})

test('快请求不累计：几十毫秒的同步块永远进不了降速', () => {
    for (let i = 0; i < 10; i++) noteSyncBlock('open', 'fast.js', '快源', 60)
    assert.equal(isThrottled('open', 'fast.js'), false)
    assert.equal(listThrottled().length, 0)
})

test('正常源直通：不排队、不延迟、不被别的慢源拖住', async () => {
    // 先把一个源打成降速，并让它占住慢源闸
    noteSyncBlock('open', 'slow.js', '慢源', 5000)
    noteSyncBlock('open', 'slow.js', '慢源', 5000)

    let slotFree = false
    const slowTask = runWithGovernor('open', 'slow.js', '慢源', async () => {
        await sleep(120)
        return 'slow-done'
    })

    // 慢源还在跑的时候，正常源必须立刻返回
    const startedAt = Date.now()
    const fast = await runWithGovernor('open', 'fast.js', '快源', async () => 'fast-done')
    const cost = Date.now() - startedAt
    assert.equal(fast, 'fast-done')
    assert.ok(cost < 60, `正常源应直通，实测等了 ${cost}ms`)
    assert.ok(slotFree === false)

    assert.equal(await slowTask, 'slow-done')
    slotFree = true
})

test('同一慢源单飞：1 个在跑 + 1 个排队，第 3 个直接失败让上层换源', async () => {
    noteSyncBlock('open', 'slow.js', '慢源', 5000)
    noteSyncBlock('open', 'slow.js', '慢源', 5000)
    assert.equal(isThrottled('open', 'slow.js'), true)

    const running = runWithGovernor('open', 'slow.js', '慢源', async () => {
        await sleep(100)
        return 1
    })
    const queued = runWithGovernor('open', 'slow.js', '慢源', async () => {
        await sleep(10)
        return 2
    })

    await assert.rejects(
        () => runWithGovernor('open', 'slow.js', '慢源', async () => 3),
        /降速运行/,
        '第 3 个必须立刻失败，不能无限堆积',
    )

    assert.equal(getGovernorQueueDepth('open', 'slow.js'), 2)
    assert.equal(await running, 1)
    assert.equal(await queued, 2)
})

test('慢源之间互斥：两个不同的慢源不会同时执行（不叠成 10 秒阻塞）', async () => {
    for (const id of ['s1.js', 's2.js']) {
        noteSyncBlock('open', id, id, 5000)
        noteSyncBlock('open', id, id, 5000)
    }
    const events: string[] = []
    const job = (id: string) => runWithGovernor('open', id, id, async () => {
        events.push(`${id}:start`)
        await sleep(80)
        events.push(`${id}:end`)
    })

    await Promise.all([job('s1.js'), job('s2.js')])

    // 互斥的判据：任何时刻最多只有 1 个慢源在跑
    let concurrent = 0
    let maxConcurrent = 0
    for (const e of events) {
        concurrent += e.endsWith(':start') ? 1 : -1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
    }
    assert.equal(maxConcurrent, 1, `慢源并发峰值应为 1，实测 ${maxConcurrent}`)
    assert.equal(events.length, 4)
})

test('降速状态自动过期：30 分钟后回到正常，不用手动干预', async () => {
    noteSyncBlock('open', 'slow.js', '慢源', 5000)
    noteSyncBlock('open', 'slow.js', '慢源', 5000)
    assert.equal(isThrottled('open', 'slow.js'), true)

    // 把时钟推到 TTL 之后：状态按 lastAt 判定过期
    const realNow = Date.now
    try {
        Date.now = () => realNow() + 31 * 60 * 1000
        assert.equal(isThrottled('open', 'slow.js'), false, '过期后必须自动恢复')
        assert.equal(listThrottled().length, 0)
    } finally {
        Date.now = realNow
    }
})

test('总开关关闭后完全直通：连降速源也不再排队', async () => {
    noteSyncBlock('open', 'slow.js', '慢源', 5000)
    noteSyncBlock('open', 'slow.js', '慢源', 5000)
    ;(global as any).lx = { config: { 'customSource.governor.enabled': false } }

    const startedAt = Date.now()
    const results = await Promise.all([
        runWithGovernor('open', 'slow.js', '慢源', async () => { await sleep(80); return 1 }),
        runWithGovernor('open', 'slow.js', '慢源', async () => { await sleep(80); return 2 }),
        runWithGovernor('open', 'slow.js', '慢源', async () => { await sleep(80); return 3 }),
    ])
    assert.deepEqual(results, [1, 2, 3])
    assert.ok(Date.now() - startedAt < 200, '关闭后应并发执行，不该被单飞串起来')
})

test('手动解除降速后立刻恢复直通', () => {
    noteSyncBlock('open', 'slow.js', '慢源', 5000)
    noteSyncBlock('open', 'slow.js', '慢源', 5000)
    assert.equal(isThrottled('open', 'slow.js'), true)
    assert.equal(clearThrottle('open', 'slow.js'), true)
    assert.equal(isThrottled('open', 'slow.js'), false)
})
