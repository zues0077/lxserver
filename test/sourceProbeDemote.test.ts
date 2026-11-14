/**
 * 「先降权、后关平台」的单元测试。
 *
 * 用户 2026-11-05 拍板的策略：同一个「音源 × 平台」第一次取链失败只**降权**
 * （排到换源队尾，不写 states.json），连续第二次失败才允许**关平台**。
 *
 * 这里守三件事：
 *   1. 阶梯顺序不能反 —— 第一次失败绝不能碰 autoDisabled；
 *   2. 阈值配置的边界（0 = 关闭；≥ 关闭阈值 = 没有观察窗口，按关闭处理）；
 *   3. 降权必须能撤销（成功一次 / 超过有效期 / 平台已关闭）。
 */
import test from 'node:test'
import assert from 'node:assert'
import {
    configOf,
    notePlatformFailure,
    clearPlatformDemote,
    isDemoteActive,
    type PlatformProbeState,
} from '../src/server/sourceProbe'

const withConfig = (cfg: Record<string, any>, fn: () => void) => {
    const g = global as any
    const prev = g.lx
    g.lx = { config: cfg }
    try {
        fn()
    } finally {
        if (prev === undefined) delete g.lx
        else g.lx = prev
    }
}

const ps = (over: Partial<PlatformProbeState> = {}): PlatformProbeState => ({
    status: 'unknown',
    failCount: 0,
    lastCheckAt: 0,
    lastOkAt: 0,
    lastError: '',
    autoDisabled: false,
    ...over,
})

test('默认阈值：1 次失败降权、2 次失败关平台', () => {
    withConfig({}, () => {
        const c = configOf()
        assert.strictEqual(c.failThreshold, 2)
        assert.strictEqual(c.demoteThreshold, 1)
    })
})

test('降权阈值填 0 = 关闭降权档，回到「到阈值直接关」的老行为', () => {
    withConfig({ 'customSource.probe.demoteThreshold': 0 }, () => {
        assert.strictEqual(configOf().demoteThreshold, 0)
    })
})

test('降权阈值 ≥ 关闭阈值 = 没有观察窗口，按关闭处理（不能等同触发）', () => {
    for (const v of [2, 3, 99]) {
        withConfig({ 'customSource.probe.demoteThreshold': v }, () => {
            assert.strictEqual(configOf().demoteThreshold, 0, `配 ${v} 时应关闭降权档`)
        })
    }
})

test('关闭阈值配成 1 时降权必然关闭（本来就没有第二次）', () => {
    withConfig({ 'customSource.probe.failThreshold': 1 }, () => {
        const c = configOf()
        assert.strictEqual(c.failThreshold, 1)
        assert.strictEqual(c.demoteThreshold, 0)
    })
})

test('第一次失败只降权：failCount=1、demotedAt 点亮、绝不 autoDisabled', () => {
    const p = ps()
    const r = notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, now: 1000 })
    assert.deepStrictEqual(r, { demoted: true, demoteStarted: true, counted: true })
    assert.strictEqual(p.failCount, 1)
    assert.strictEqual(p.demotedAt, 1000)
    assert.strictEqual(p.autoDisabled, false, '第一次失败绝不能关平台')
    assert.strictEqual(p.status, 'unknown')
})

test('第二次失败：计数到 2（够格关平台），但不是本函数关的', () => {
    const p = ps()
    notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, now: 1000 })
    const r = notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, now: 2000 })
    assert.strictEqual(p.failCount, 2)
    assert.strictEqual(r.demoteStarted, false, '已在降权中，不应重复打日志')
    assert.strictEqual(p.autoDisabled, false, '关闭由落定阶段执行，本函数只记证据')
})

test('降权阈值 0：任何失败都不降权（只计数）', () => {
    const p = ps()
    const r = notePlatformFailure(p, { demoteThreshold: 0, failThreshold: 2, now: 1000 })
    assert.strictEqual(r.demoted, false)
    assert.strictEqual(p.demotedAt, undefined)
    assert.strictEqual(p.failCount, 1)
})

test('已关闭的平台不再参与降权', () => {
    const p = ps({ autoDisabled: true, failCount: 0 })
    const r = notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, now: 1000 })
    assert.strictEqual(r.demoted, false)
    assert.strictEqual(p.demotedAt, undefined)
})

test('成功一次立刻撤销降权', () => {
    const p = ps()
    notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, now: 1000 })
    assert.strictEqual(isDemoteActive(p, 1000), true)
    clearPlatformDemote(p)
    assert.strictEqual(p.demotedAt, 0)
    assert.strictEqual(isDemoteActive(p, 1000), false)
})

test('降权有效期 6 小时：到期自动失效，不会永久粘住', () => {
    const at = 1_000_000
    const p = ps({ demotedAt: at })
    assert.strictEqual(isDemoteActive(p, at + 6 * 3600_000 - 1), true)
    assert.strictEqual(isDemoteActive(p, at + 6 * 3600_000), false)
    assert.strictEqual(isDemoteActive(undefined), false)
    assert.strictEqual(isDemoteActive({ demotedAt: 0 }), false)
})

test('失败次数上限 99，不会无限累加', () => {
    const p = ps({ failCount: 99 })
    notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2 })
    assert.strictEqual(p.failCount, 99)
})

// ---------------- 软失败降权的短窗口（2026-11-14） ----------------
// 依据 17950 实测：tx 上 K×H测试 只有 2 次软失败、failCount 仍为 0，却被压了整 6 小时队尾。
// 语义不变（软失败照样排队尾），只把软失败的惩罚时长收到 30 分钟。

test('软失败降权用 30 分钟短窗口；旧数据无 demoteSoft 仍按 6 小时（向后兼容）', () => {
    const at = 2_000_000
    const soft = ps({ demotedAt: at, demoteSoft: true })
    assert.strictEqual(isDemoteActive(soft, at + 30 * 60_000 - 1), true)
    assert.strictEqual(isDemoteActive(soft, at + 30 * 60_000), false)
    assert.strictEqual(isDemoteActive({ demotedAt: at }, at + 3600_000), true, '缺字段视为硬失败')
})

test('软失败点亮降权时打 demoteSoft；随后硬失败升级为 6 小时长窗口且不重复打日志', () => {
    const p = ps({ lastError: '403' })
    notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, hard: false, now: 1000 })
    assert.strictEqual(p.demotedAt, 1000)
    assert.strictEqual(p.demoteSoft, true)
    assert.strictEqual(isDemoteActive(p, 1000 + 30 * 60_000), false, '30 分钟后软窗口到期')

    const r = notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, hard: true, now: 2000 })
    assert.strictEqual(r.demoteStarted, false, '已在降权中，不重复打日志')
    assert.strictEqual(p.demoteSoft, false, '硬失败把软窗口升级为硬窗口')
    assert.strictEqual(isDemoteActive(p, 2000 + 6 * 3600_000 - 1), true)
    assert.strictEqual(isDemoteActive(p, 2000 + 6 * 3600_000), false)
})

test('clearPlatformDemote 同时清掉软失败标记', () => {
    const p = ps({ demotedAt: 1000, demoteSoft: true })
    clearPlatformDemote(p)
    assert.strictEqual(p.demotedAt, 0)
    assert.strictEqual(p.demoteSoft, false)
})
