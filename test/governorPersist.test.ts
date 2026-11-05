/**
 * 慢源状态跨重启恢复（sourceGovernor 落盘）。
 *
 * 背景（246 实测 2026-11-06 02:12）：一份 3.18MB 搜索响应，西瓜聚合源脚本回调
 * 5420ms、非常刀 5251ms，串成 11934ms 主线程停转（深拷贝仅 2ms）。
 * 现有的 worker 提升是「实测卡一次才搬走」，于是每次重启后第一次搜索都要再卡一遍。
 * 把降速状态落盘、启动读回，加载完音源就能直接把已知慢源预置进独立线程。
 *
 * 三条恢复分支必须守住：
 *   1) TTL 内 → 原样恢复（重启后慢源互斥/单飞立刻生效）
 *   2) 过期但单次就严重 → 只作 worker 预置依据，不降速（不牺牲吞吐）
 *   3) 过期且没到严重档 → 丢弃（一次偶发不许永久戴帽子）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parsePersistedStates, type GovernorConfig } from '../src/server/sourceGovernor'

const CFG: GovernorConfig = {
    enabled: true,
    syncMs: 800,
    minHits: 2,
    severeSyncMs: 2500,
    ttlMs: 30 * 60 * 1000,
}

const NOW = 1_800_000_000_000

const entry = (over: Record<string, any> = {}) => ({
    owner: 'open',
    id: 'slow.js',
    name: '西瓜聚合源',
    hits: 3,
    since: NOW - 60_000,
    until: NOW + 10 * 60_000,
    worstSyncMs: 5420,
    lastAt: NOW - 60_000,
    scriptHash: 'hA',
    ...over,
})

test('TTL 内：原样恢复，降速状态一起回来', () => {
    const map = parsePersistedStates({ open_slow: entry() }, CFG, NOW)
    const st = map.get('open_slow')
    assert.ok(st, '应恢复该源')
    assert.equal(st!.worstSyncMs, 5420)
    assert.equal(st!.scriptHash, 'hA')
    assert.equal(st!.until, NOW + 10 * 60_000)
    assert.notEqual(st!.preset, true)
    assert.ok(st!.until > NOW, '重启后应立刻处于降速状态')
})

test('已过 TTL 但单次就严重：保留为 worker 预置依据，不再降速', () => {
    const old = entry({ lastAt: NOW - 5 * 60 * 60 * 1000, until: NOW - 4 * 60 * 60 * 1000 })
    const map = parsePersistedStates({ open_slow: old }, CFG, NOW)
    const st = map.get('open_slow')
    assert.ok(st, '严重档历史要留作预置依据')
    assert.equal(st!.preset, true)
    assert.equal(st!.until, 0, '不许继续降速，否则重启后吞吐被旧账拖住')
    assert.equal(st!.hits, 0, '窗口计数要重开')
    assert.equal(st!.worstSyncMs, 5420, '最坏耗时保留，用来决定搬 worker')
})

test('已过 TTL 且没到严重档：整条丢弃（一次偶发不永久戴帽子）', () => {
    const mild = entry({ lastAt: NOW - 5 * 60 * 60 * 1000, until: NOW - 4 * 60 * 60 * 1000, worstSyncMs: 900 })
    const map = parsePersistedStates({ open_slow: mild }, CFG, NOW)
    assert.equal(map.size, 0)
})

test('脏数据不影响其它条目：缺 owner/id、非对象、耗时非法都跳过', () => {
    const raw = {
        a: entry({ owner: '' }),
        b: entry({ id: '' }),
        c: 'not-an-object',
        d: null,
        e: entry({ id: 'ok.js', worstSyncMs: 6000 }),
    }
    const map = parsePersistedStates(raw, CFG, NOW)
    assert.equal(map.size, 1)
    assert.ok(map.has('e'))
})

test('落盘条目不带 scriptHash 时也能恢复（老文件兼容）', () => {
    const noHash = entry({ scriptHash: undefined })
    const map = parsePersistedStates({ open_slow: noHash }, CFG, NOW)
    const st = map.get('open_slow')
    assert.ok(st)
    assert.equal(st!.scriptHash, undefined)
})
