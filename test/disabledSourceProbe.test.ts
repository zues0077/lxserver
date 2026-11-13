/**
 * 停用源复检（sourceDisabledProbe）纯函数回归
 *
 * 背景：整源停用的源不在主巡检视野里（加载层直接跳过）。v1.5.55 引入
 * disableReason 标签机制。零成本策略（2026-11-13 二次修订）：after-import
 * （灌入后停用）不主动探测，等显式启用时清标签；probe-dead（判死态）低频
 * 复检自愈且满 allDownDays 进回收站；manual（含老数据无标签兜底）永不探测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDisableReason, shouldMarkDead, shouldTrashDisabled } from '../src/server/sourceDisabledProbe'

test('停用原因归一化：只有显式 after-import 被采纳，其余一律 manual', () => {
    assert.equal(normalizeDisableReason('after-import'), 'after-import')
    assert.equal(normalizeDisableReason('manual'), 'manual')
    assert.equal(normalizeDisableReason('probe-dead'), 'manual', '外部不能直接写 probe-dead，它只能由复检任务升级产生')
    assert.equal(normalizeDisableReason(undefined), 'manual')
    assert.equal(normalizeDisableReason(null), 'manual')
    assert.equal(normalizeDisableReason(''), 'manual')
    assert.equal(normalizeDisableReason(1), 'manual')
})

test('判死阈值：连续无效达到 failThreshold 才升级，阈值非法时不判死', () => {
    assert.equal(shouldMarkDead(2, 2), true, '默认阈值 2，第二次失败判死')
    assert.equal(shouldMarkDead(1, 2), false, '第一次失败只累计')
    assert.equal(shouldMarkDead(3, 2), true)
    assert.equal(shouldMarkDead(5, 1), true, '阈值 1 = 当轮即判死')
    assert.equal(shouldMarkDead(9, 0), false, '阈值 0 非法，永不判死')
    assert.equal(shouldMarkDead(9, NaN), false)
})

test('回收站清理：deadAt 满 allDownDays 才清理，0 = 关闭时间窗', () => {
    const now = Date.now()
    const threeDays = 3 * 24 * 60 * 60 * 1000
    assert.equal(shouldTrashDisabled(now - threeDays - 1000, 3, now), true, '满 3 天清理')
    assert.equal(shouldTrashDisabled(now - threeDays + 60 * 1000, 3, now), false, '差 1 分钟不满 3 天，不清理')
    assert.equal(shouldTrashDisabled(0, 3, now), false, '没有 deadAt（还没升级 probe-dead）不清理')
    assert.equal(shouldTrashDisabled(now - threeDays - 1000, 0, now), false, 'allDownDays=0 关闭时间窗，永不清理')
    assert.equal(shouldTrashDisabled(now - 1000, 90, now), false, '上限 90 天内不满不清理')
})
