/**
 * 账本落盘（sourceLedgerStore）。
 *
 * 钉住三件事：
 *  1. 落盘 → 清空 → 重新加载后，排序/沉底/冷却/档位短路的证据都还在；
 *  2. 过期数据不恢复（6 小时前的成绩、「只对当时的网络成立」的证据不能长期生效）；
 *  3. 文件损坏/不存在只让账本从零开始，绝不抛错挡住启动。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
    flushSourceLedgers,
    startSourceLedgerPersist,
    __resetSourceLedgerPersist,
} from '../src/server/sourceLedgerStore'
import { markLedgerDirty } from '../src/server/sourceLedgerDirty'
import {
    notePlayResult,
    resetPlayRank,
    playRankScore,
    exportPlayRankState,
    importPlayRankState,
    PLAY_RANK_STATE_TTL_MS,
} from '../src/server/sourcePlayRank'
import {
    noteQualityResult,
    resetQualityLedger,
    isQualityBlocked,
    exportQualityLedgerState,
    importQualityLedgerState,
} from '../src/server/sourceQualityLedger'
import {
    notePlayFailure,
    notePlayCooldown,
    clearPlayFailure,
    partitionByPlaySink,
    partitionByCooldown,
    exportPlaySinkState,
    importPlaySinkState,
} from '../src/server/userApi'

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lx-ledger-'))
const T = (id: string, platform = 'wy', quality = '320k') => ({ owner: 'open', id, platform, quality })
const api = (id: string) => ({ info: { owner: 'open', id, name: id } })

const resetAll = (): void => {
    resetPlayRank()
    resetQualityLedger()
}

test('落盘→清空→加载：排序账本原样恢复', () => {
    const dir = tmpDir()
    resetAll()
    __resetSourceLedgerPersist()
    startSourceLedgerPersist(dir)
    notePlayResult(T('fast'), true, 120)
    notePlayResult(T('fast'), true, 130)
    assert.strictEqual(flushSourceLedgers(), true)
    const file = path.join(dir, 'source-ledger.json')
    assert.ok(fs.existsSync(file), '应当写出 source-ledger.json')

    resetPlayRank()
    assert.strictEqual(playRankScore(T('fast')), 1200, '清空后回到中性分')
    __resetSourceLedgerPersist()
    startSourceLedgerPersist(dir)
    const score = playRankScore(T('fast'))
    assert.ok(score < 200, `恢复后应看到 EWMA≈125，实际 ${score}`)
    __resetSourceLedgerPersist()
})

test('落盘→清空→加载：沉底与超时冷却都恢复（重启后首播不会又踩回挂死的源）', () => {
    const dir = tmpDir()
    resetAll()
    __resetSourceLedgerPersist()
    startSourceLedgerPersist(dir)
    const bad = api('bad-source')
    notePlayFailure(bad, 'wy', '所有接口均失败')
    notePlayCooldown(bad, 'wy', '音源日志：取链超时（超过 5000ms 未返回）')
    flushSourceLedgers()

    clearPlayFailure(bad, 'wy') // 模拟重启：内存全清
    assert.strictEqual(partitionByPlaySink([bad, api('other')], 'wy').sunk.length, 0)
    __resetSourceLedgerPersist()
    startSourceLedgerPersist(dir)
    const { sunk } = partitionByPlaySink([bad, api('other')], 'wy')
    assert.strictEqual(sunk.length, 1, '沉底记录应恢复')
    const { cooled } = partitionByCooldown([bad, api('other')], 'wy')
    assert.strictEqual(cooled.length, 1, '超时冷却应恢复')
    __resetSourceLedgerPersist()
})

test('落盘→清空→加载：档位短路恢复后仍然挡住必败档', () => {
    const dir = tmpDir()
    resetAll()
    __resetSourceLedgerPersist()
    startSourceLedgerPersist(dir)
    for (let i = 0; i < 3; i++) noteQualityResult(T('flac-only', 'wy', 'flac'), false)
    assert.strictEqual(isQualityBlocked(T('flac-only', 'wy', 'flac')), true)
    flushSourceLedgers()

    resetQualityLedger()
    assert.strictEqual(isQualityBlocked(T('flac-only', 'wy', 'flac')), false)
    __resetSourceLedgerPersist()
    startSourceLedgerPersist(dir)
    assert.strictEqual(isQualityBlocked(T('flac-only', 'wy', 'flac')), true, '短路状态应恢复')
    __resetSourceLedgerPersist()
})

test('过期数据不恢复：6 小时前的排序成绩被丢弃', () => {
    const now = Date.now()
    const state = {
        v: 1,
        records: [
            ['open:old:wy:320k', { attempts: 5, successes: 5, ewmaMs: 100, lastAt: now - PLAY_RANK_STATE_TTL_MS - 1000 }],
            ['open:fresh:wy:320k', { attempts: 5, successes: 5, ewmaMs: 200, lastAt: now - 1000 }],
        ],
    }
    resetPlayRank()
    const n = importPlayRankState(state, now)
    assert.strictEqual(n, 1, '只恢复新鲜的那条')
    assert.strictEqual(playRankScore(T('old')), 1200)
    assert.ok(playRankScore(T('fresh')) < 300)
})

test('过期数据不恢复：沉底超过 15 分钟窗口的不再算失败', () => {
    const now = Date.now()
    const n = importPlaySinkState({
        v: 1,
        fails: [['open:stale:wy', { fails: 3, lastFailAt: now - 16 * 60 * 1000 }]],
        cooldowns: [['open:stale:wy', now - 1000]],
        streaks: [],
    }, now)
    assert.strictEqual(n, 0)
})

test('脏标记为空时不写盘（正常请求路径不该有 IO）', () => {
    const dir = tmpDir()
    __resetSourceLedgerPersist()
    startSourceLedgerPersist(dir)
    assert.strictEqual(flushSourceLedgers(), false, '没有变更就不写')
    markLedgerDirty()
    assert.strictEqual(flushSourceLedgers(), true)
    __resetSourceLedgerPersist()
})

test('文件损坏 / 不存在都只从零开始，不抛错', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'source-ledger.json'), '{ not json', 'utf-8')
    resetAll()
    assert.doesNotThrow(() => {
        __resetSourceLedgerPersist()
        startSourceLedgerPersist(dir)
    })
    assert.strictEqual(playRankScore(T('anything')), 1200)
    __resetSourceLedgerPersist()
})

test('导出结构带版本号，缺字段的旧文件也能安全加载', () => {
    resetAll()
    notePlayResult(T('x'), true, 500)
    const st = exportPlayRankState()
    assert.strictEqual(st.v, 1)
    assert.ok(Array.isArray(st.records))
    // 只有一半字段的脏数据：该条被跳过，不写进账本
    const n = importPlayRankState({ v: 1, records: [['open:half:wy:320k', { attempts: 3 }]] })
    assert.strictEqual(n, 0)
    const q = exportQualityLedgerState()
    assert.ok(q.options && q.options.minSamples > 0)
    assert.ok(Array.isArray(q.records))
    const sink = exportPlaySinkState()
    assert.ok(Array.isArray(sink.fails) && Array.isArray(sink.cooldowns) && Array.isArray(sink.streaks))
    assert.doesNotThrow(() => importQualityLedgerState({}))
})
