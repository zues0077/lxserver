/**
 * 音源巡检「半截禁用态」自愈的单元测试。
 *
 * 背景（246 实测）：probe-status.json 里躺着 18 条 autoDisabled=true 但
 * disabledAt=0、disabledFailCount 缺失、failCount 卡在 99 的条目。它们出自旧版
 * 写入路径（关闭时只写 autoDisabled，不归档、不清零），新版只补写不回溯，
 * 于是永远对不上：/health 的 since 退化成 lastCheckAt（看着像今天刚关），
 * failCount 显示 99（看着像还在涨）。normalizeStatus 就是把这个态补成新版同构。
 */
import test from 'node:test'
import assert from 'node:assert'
import { normalizeStatus, type ProbeStatusFile } from '../src/server/sourceProbe'

const wrap = (platform: Record<string, unknown>, updatedAt = 1000): ProbeStatusFile => ({
    version: 1,
    updatedAt,
    sources: { src: { name: '某源', platforms: { kg: platform as any } } },
})

test('半截禁用态：补齐 disabledAt 与归档次数，并把实时计数清零', () => {
    const st = wrap({ status: 'down', failCount: 99, lastCheckAt: 5000, lastOkAt: 0, lastError: 'x', autoDisabled: true })
    const fixed = normalizeStatus(st)
    const ps: any = st.sources.src.platforms.kg
    assert.equal(ps.disabledAt, 5000, '关闭时刻用最后一次巡检时刻兜底')
    assert.equal(ps.disabledFailCount, 99, '归档值取当时的连续失败次数')
    assert.equal(ps.failCount, 0, '实时计数必须归零，否则展示成「99 次还在涨」')
    assert.ok(fixed >= 1)
})

test('没有 lastCheckAt 时退到文件 updatedAt，不能补成 0', () => {
    const st = wrap({ status: 'down', failCount: 40, lastCheckAt: 0, lastOkAt: 0, lastError: '', autoDisabled: true }, 8888)
    normalizeStatus(st)
    assert.equal((st.sources.src.platforms.kg as any).disabledAt, 8888)
})

test('已经自洽的条目零改动，且重复调用幂等', () => {
    const st = wrap({
        status: 'down', failCount: 0, lastCheckAt: 5000, lastOkAt: 0, lastError: 'x',
        autoDisabled: true, disabledAt: 777, disabledFailCount: 12,
    })
    assert.equal(normalizeStatus(st), 0)
    assert.equal(normalizeStatus(st), 0)
    const ps: any = st.sources.src.platforms.kg
    assert.equal(ps.disabledAt, 777)
    assert.equal(ps.disabledFailCount, 12)
    assert.equal(ps.failCount, 0)
})

test('未禁用的平台完全不动（不能把正常失败计数抹掉）', () => {
    const st = wrap({ status: 'unknown', failCount: 3, lastCheckAt: 5000, lastOkAt: 0, lastError: 'e', autoDisabled: false })
    assert.equal(normalizeStatus(st), 0)
    const ps: any = st.sources.src.platforms.kg
    assert.equal(ps.failCount, 3)
    assert.equal(ps.disabledAt, undefined)
    assert.equal(ps.disabledFailCount, undefined)
})

test('多个源 / 多个平台批量修复时只碰禁用中的那些', () => {
    const st: ProbeStatusFile = {
        version: 1,
        updatedAt: 1,
        sources: {
            a: {
                name: 'A', platforms: {
                    kg: { status: 'down', failCount: 99, lastCheckAt: 100, lastOkAt: 0, lastError: '', autoDisabled: true } as any,
                    wy: { status: 'ok', failCount: 0, lastCheckAt: 100, lastOkAt: 100, lastError: '', autoDisabled: false } as any,
                },
            },
            b: {
                name: 'B', platforms: {
                    tx: { status: 'down', failCount: 8, lastCheckAt: 200, lastOkAt: 0, lastError: '', autoDisabled: true } as any,
                },
            },
        },
    }
    normalizeStatus(st)
    assert.equal((st.sources.a.platforms.kg as any).disabledFailCount, 99)
    assert.equal((st.sources.b.platforms.tx as any).disabledFailCount, 8)
    assert.equal((st.sources.a.platforms.wy as any).failCount, 0, '正常平台保持原样（本来就是 0）')
    assert.equal((st.sources.a.platforms.wy as any).disabledAt, undefined, '正常平台不能被塞 disabledAt')
})
