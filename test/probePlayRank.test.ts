/**
 * C+D 单测（v1.5.54，用户 2026-11-11 拍板）
 *
 * C. 真实播放数据优先：7 天内在真实播放链路成功取过链的「源 × 平台」，本轮不再拿测试曲去探。
 *    判据必须是 lastOkAt（最后一次**成功**），不能用 lastAt —— 后者每次尝试都刷新（含失败）。
 * D. CPU 归因：探测窗口 3s → 15s，且要求两次独立采样都达标才隔离
 *    （3s 窗口会把播放/下载收尾的 CPU 衰减误判成热点，2026-11-11 星澜聚合音源就是这类）。
 */
import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { notePlayResult, hasRecentSuccess, getPlayRankRecord } from '../src/server/sourcePlayRank'

const DAY = 86400_000
const NOW = 1794400000000

test('C1 近期真实播放成功 → 判活（按源×平台维度）', () => {
    const t = { owner: 'open', id: 'src-a.js', platform: 'kw', quality: '320k' }
    notePlayResult(t, true, 300, NOW - 2 * DAY)
    assert.strictEqual(hasRecentSuccess({ owner: 'open', id: 'src-a.js', platform: 'kw' }, 7 * DAY, NOW), true)
    assert.strictEqual(hasRecentSuccess({ owner: 'open', id: 'src-a.js', platform: 'kw' }, 1 * DAY, NOW), false, '超出窗口就不算')
    assert.strictEqual(hasRecentSuccess({ owner: 'open', id: 'src-a.js', platform: 'wy' }, 7 * DAY, NOW), false, '别的平台不串')
    assert.strictEqual(hasRecentSuccess({ owner: 'open', id: 'other.js', platform: 'kw' }, 7 * DAY, NOW), false, '别的源不串')
})

test('C2 只失败过（attempts>0、successes=0）→ 不能判活', () => {
    const t = { owner: 'open', id: 'src-b.js', platform: 'tx', quality: '128k' }
    notePlayResult(t, false, 0, NOW - 1000)
    notePlayResult(t, false, 0, NOW - 500)
    assert.strictEqual(getPlayRankRecord(t).attempts, 2)
    assert.strictEqual(hasRecentSuccess({ owner: 'open', id: 'src-b.js', platform: 'tx' }, 7 * DAY, NOW), false)
})

test('C3 很久以前成功、昨天又失败 → 不能判活（lastAt 会误导，必须用 lastOkAt）', () => {
    const t = { owner: 'open', id: 'src-c.js', platform: 'kg', quality: '128k' }
    notePlayResult(t, true, 200, NOW - 30 * DAY)   // 30 天前成功
    notePlayResult(t, false, 0, NOW - 1 * DAY)     // 昨天失败（lastAt 被刷新）
    assert.strictEqual(getPlayRankRecord(t).lastAt > NOW - 2 * DAY, true, 'lastAt 确实被失败刷新了')
    assert.strictEqual(hasRecentSuccess({ owner: 'open', id: 'src-c.js', platform: 'kg' }, 7 * DAY, NOW), false)
})

test('C4 无任何记录 → 不判活（保守，照常探测）', () => {
    assert.strictEqual(hasRecentSuccess({ owner: 'open', id: 'never.js', platform: 'mg' }, 7 * DAY, NOW), false)
})

test('D1 探测窗口默认 15s（3s 会误判成热点）', () => {
    // probeWindowMs 属 sourceGuard 的内部 config（envNum 读取），不在 configOf() 里，
    // 所以这里按源码断言默认值 —— 它是个「别被改回 3s」的守门测试。
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'sourceGuard.ts'), 'utf8')
    assert.ok(/envNum\('SOURCE_GUARD_PROBE_WINDOW_MS', 15000\)/.test(src), '默认窗口必须是 15000ms')
})

test('D2 归因必须做二次确认（源码守住这条，别被改回单次采样）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'sourceGuard.ts'), 'utf8')
    assert.ok(/const after2 = await sampleCpuOver\(current\.probeWindowMs\)/.test(src), '存在第二次采样')
    assert.ok(/if \(drop2 < need\)/.test(src), '第二次不达标要排除')
    assert.ok(/confirm=\$\{after2\.toFixed\(1\)\}/.test(src), '隔离原因里要带二次确认值')
    assert.ok(/PROBE_SETTLE_MS = 3000/.test(src), '沉降时间固定 3s')
})

test('C5 巡检侧真的用上了 hasRecentSuccess（防止「写了没人调」）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'sourceProbe.ts'), 'utf8')
    assert.ok(/hasRecentSuccess\(/.test(src))
    assert.ok(/conf\.preferPlayRank && hasRecentSuccess/.test(src))
    assert.ok(/skippedByPlayRank\+\+/.test(src))
})
