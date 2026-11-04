/**
 * 降速运行与隔离护栏共存（2026-11-04 246 实机暴露）
 *
 * 实机日志：
 *   20:59:35 [音源调度] 非常刀 脚本同步块 6651ms（第 2 次），转为「降速运行」
 *   20:59:43 [自检护栏][归因] ✓ 连续 3 次归因同一音源，已隔离: 非常刀
 * 降速 8 秒后被旧规则停掉 —— 用户要的是「兼容慢源、别造成不良影响」，
 * 结果还是被停用。两条处置链必须归一：源一旦在降速，卡顿就是已知代价，
 * 不再累计隔离计数，也不走熔断停用。
 *
 * 同时补一档「单次严重卡顿即降速」：巡检 180 分钟一轮、每轮只给每个源一次命中，
 * 「30 分钟内 2 次」在日常巡检下永远攒不满，严重档必须一次就认。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as governor from '../src/server/sourceGovernor'
import * as guard from '../src/server/sourceGuard'

const { noteSyncBlock, isThrottled, getGovernorConfig, clearThrottle, resetGovernorForTest } = governor
const { attributeStall, startSourceGuard, stopSourceGuard, resetGuardConfig } = guard

process.env.SOURCE_GUARD_STALL_ISOLATE_ENABLED = 'true'
process.env.SOURCE_GUARD_STALL_ISOLATE_STREAK = '3'
process.env.SOURCE_GUARD_STALL_MIN_MS = '2000'
process.env.SOURCE_GUARD_ATTRIBUTION_DEDUP_MS = '0'

const unloaded: string[] = []
const guardDeps = {
    isBusy: () => false,
    unload: (owner: string, id: string) => { unloaded.push(`${owner}_${id}`) },
    getRecentActivity: () => [{ owner: 'open', id: 'slow.js', name: '慢源', kinds: ['callback'], agoMs: 0 }],
    getRecentSlowTimers: () => [],
    getTrackedTimers: () => [],
    reload: () => { },
} as any

test('单次严重同步块（≥ severeSyncMs）首次即降速，不等第二次', () => {
    resetGovernorForTest()
    const cfg = getGovernorConfig()
    assert.ok(cfg.severeSyncMs > 0)
    const res = noteSyncBlock('open', 'severe.js', '严重慢源', cfg.severeSyncMs + 100)
    assert.equal(res.justThrottled, true)
    assert.equal(isThrottled('open', 'severe.js'), true)
    // 未到严重档、又没攒够次数 → 不动
    const small = noteSyncBlock('open', 'mild.js', '轻慢源', cfg.syncMs + 10)
    assert.equal(small.justThrottled, false)
    assert.equal(isThrottled('open', 'mild.js'), false)
})

test('已降速的源被归因时不再累计隔离计数、也不卸载', () => {
    resetGovernorForTest()
    resetGuardConfig()
    unloaded.length = 0
    startSourceGuard(guardDeps)

    noteSyncBlock('open', 'slow.js', '慢源', 6000)
    assert.equal(isThrottled('open', 'slow.js'), true)

    for (let i = 0; i < 5; i++) {
        const a = attributeStall(6000)
        assert.ok(a)
        assert.equal(a!.action, 'throttled')
    }
    assert.deepEqual(unloaded, [], '降速中的源不应被卸载')

    stopSourceGuard()
})

test('解除降速后仍反复卡顿 → 恢复原有隔离路径', () => {
    resetGovernorForTest()
    resetGuardConfig()
    unloaded.length = 0
    startSourceGuard(guardDeps)
    clearThrottle('open', 'slow.js')

    let isolated = false
    for (let i = 0; i < 4; i++) {
        const a = attributeStall(6000)
        if (a?.action === 'isolated') isolated = true
    }
    assert.equal(isolated, true)
    assert.ok(unloaded.includes('open_slow.js'))

    stopSourceGuard()
})
