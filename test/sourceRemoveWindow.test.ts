/**
 * 「全平台失效满 N 天才移除音源」的单元测试（用户 2026-11-06 定调：满 3 天）。
 *
 * 这里守四件事：
 *   1. 判定口径 —— 全平台失败才算，单平台失败绝不能删整个源；
 *   2. unknown 也算失败证据 —— 被平台侧异常豁免的平台不再是移除的绊脚石（老死锁）；
 *   3. skipped 既不阻断也不定罪 —— 停探期没探到不能拿来续期计时；
 *   4. 时间窗是「连续」不是「累计」—— 中间恢复一次就重新计时。
 */
import test from 'node:test'
import assert from 'node:assert'
import {
    evalAllDown,
    decideAllDownRemoval,
    isHardFailure,
    type PlatformProbeState,
} from '../src/server/sourceProbe'

const ps = (patch: Partial<PlatformProbeState>): PlatformProbeState => ({
    status: 'unknown',
    failCount: 0,
    lastCheckAt: 0,
    lastOkAt: 0,
    lastError: '',
    autoDisabled: false,
    ...patch,
})

const mapOf = (entries: Record<string, PlatformProbeState>) =>
    (p: string) => entries[p]

const DAY = 86400_000

// ---------- evalAllDown ----------

test('全部平台 down → 判定全平台失效', () => {
    const v = evalAllDown(['tx', 'wy', 'kw'], mapOf({
        tx: ps({ status: 'down', failCount: 3 }),
        wy: ps({ status: 'down', failCount: 5 }),
        kw: ps({ status: 'down', failCount: 2 }),
    }))
    assert.equal(v.allDown, true)
    assert.equal(v.hasEvidence, true)
})

test('有任一平台 ok → 不是全平台失效（单平台坏不能删整个源）', () => {
    const v = evalAllDown(['tx', 'wy', 'kw'], mapOf({
        tx: ps({ status: 'down', failCount: 9 }),
        wy: ps({ status: 'ok', failCount: 0 }),
        kw: ps({ status: 'unknown', failCount: 99 }),
    }))
    assert.equal(v.allDown, false)
    assert.equal(v.hasEvidence, false)
})

test('unknown + failCount>0 算失败证据（老逻辑只认 down，导致永不移除）', () => {
    const v = evalAllDown(['tx', 'kg', 'mg'], mapOf({
        tx: ps({ status: 'down', failCount: 99 }),
        kg: ps({ status: 'unknown', failCount: 99 }),
        mg: ps({ status: 'unknown', failCount: 99 }),
    }))
    assert.equal(v.allDown, true)
    assert.equal(v.hasEvidence, true)
})

test('skipped 既不阻断也不定罪：down + skipped 仍算全失效', () => {
    const v = evalAllDown(['tx', 'qsvip'], mapOf({
        tx: ps({ status: 'down', failCount: 4 }),
        qsvip: ps({ status: 'skipped', failCount: 0 }),
    }))
    assert.equal(v.allDown, true)
    assert.equal(v.hasEvidence, true)
})

test('全部 skipped = 没有证据，不能判失效', () => {
    const v = evalAllDown(['tx', 'wy'], mapOf({
        tx: ps({ status: 'skipped', failCount: 0 }),
        wy: ps({ status: 'skipped', failCount: 0 }),
    }))
    assert.equal(v.allDown, true)
    assert.equal(v.hasEvidence, false)
})

test('状态缺失（新平台还没建档）→ 不算全失效', () => {
    const v = evalAllDown(['tx', 'wy'], mapOf({
        tx: ps({ status: 'down', failCount: 3 }),
    }))
    assert.equal(v.allDown, false)
})

test('unknown 但 failCount=0（只是没结论）→ 不算失败证据', () => {
    const v = evalAllDown(['tx', 'wy'], mapOf({
        tx: ps({ status: 'down', failCount: 3 }),
        wy: ps({ status: 'unknown', failCount: 0 }),
    }))
    assert.equal(v.allDown, false)
})

// ---------- decideAllDownRemoval ----------

test('首次判定全平台失效：只开始计时，不立刻移除', () => {
    const now = 1_700_000_000_000
    const d = decideAllDownRemoval(0, { allDown: true, hasEvidence: true, lastOkAt: 0 }, now, 3 * DAY)
    assert.deepEqual(d, { since: now, remove: false, started: true })
})

test('未满 3 天：继续计时，不移除', () => {
    const now = 1_700_000_000_000
    const since = now - 2 * DAY
    const d = decideAllDownRemoval(since, { allDown: true, hasEvidence: true, lastOkAt: 0 }, now, 3 * DAY)
    assert.equal(d.since, since)
    assert.equal(d.remove, false)
    assert.equal(d.started, false)
})

test('满 3 天：移除', () => {
    const now = 1_700_000_000_000
    const since = now - 3 * DAY
    const d = decideAllDownRemoval(since, { allDown: true, hasEvidence: true, lastOkAt: 0 }, now, 3 * DAY)
    assert.equal(d.remove, true)
})

test('中途有平台恢复：计时归零，不移除', () => {
    const now = 1_700_000_000_000
    const d = decideAllDownRemoval(now - 5 * DAY, { allDown: false, hasEvidence: false, lastOkAt: 0 }, now, 3 * DAY)
    assert.equal(d.since, 0)
    assert.equal(d.remove, false)
})

test('中途整轮没探到（无证据）：计时归零，删除不可逆不能拿脏数据当依据', () => {
    const now = 1_700_000_000_000
    const d = decideAllDownRemoval(now - 5 * DAY, { allDown: true, hasEvidence: false, lastOkAt: 0 }, now, 3 * DAY)
    assert.equal(d.since, 0)
    assert.equal(d.remove, false)
})

test('allDownDays=0：判定当轮即移除（老行为）', () => {
    const now = 1_700_000_000_000
    const d = decideAllDownRemoval(0, { allDown: true, hasEvidence: true, lastOkAt: 0 }, now, 0)
    assert.equal(d.remove, true)
})


test('存量坏源：最后一次成功在 4 天前 → 首轮判定即可移除（不必从部署起重等 3 天）', () => {
    const now = 1_700_000_000_000
    const d = decideAllDownRemoval(0, { allDown: true, hasEvidence: true, lastOkAt: now - 4 * DAY }, now, 3 * DAY)
    assert.equal(d.remove, true)
    assert.equal(d.since, now - 4 * DAY)
})

test('存量坏源：1 天前还成功过 → 从此刻起计时，不立即移除', () => {
    const now = 1_700_000_000_000
    const d = decideAllDownRemoval(0, { allDown: true, hasEvidence: true, lastOkAt: now - 1 * DAY }, now, 3 * DAY)
    assert.equal(d.remove, false)
    assert.equal(d.since, now)
    assert.equal(d.started, true)
})

test('从未成功过的新源：不能推断失效时长，从此刻起计时', () => {
    const now = 1_700_000_000_000
    const d = decideAllDownRemoval(0, { allDown: true, hasEvidence: true, lastOkAt: 0 }, now, 3 * DAY)
    assert.equal(d.remove, false)
    assert.equal(d.since, now)
})

// ---------- 硬故障特征 ----------

test('404 算硬故障（源站路径失效，与测试曲目无关）', () => {
    assert.equal(isHardFailure('链接返回 404/GET 404（music.haitangw.cc）'), true)
    assert.equal(isHardFailure('Not Found 404'), true)
})

test('403 不算硬故障（风控/版权限制，源本身可能没坏）', () => {
    assert.equal(isHardFailure('后端聚合接口返回403，已屏蔽'), false)
})

test('5xx 与网络错误仍是硬故障', () => {
    assert.equal(isHardFailure('HTTP 502 Bad Gateway'), true)
    assert.equal(isHardFailure('getaddrinfo ENOTFOUND api.example.com'), true)
})

test('软失败（测试曲目不可播）不算硬故障', () => {
    assert.equal(isHardFailure('所有音源均失败'), false)
    assert.equal(isHardFailure('不支持'), false)
})

// ---------- clearProbeRemoval（回收站恢复 / 同名重传后清「已移除」残留） ----------

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { clearProbeRemoval } from '../src/server/sourceProbe'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-removal-'))
const g = global as any
g.lx = { ...(g.lx || {}), dataPath: tmp }

const statusFile = (owner: string) =>
    path.join(tmp, 'users', 'source', owner === 'open' ? '_open' : owner, 'probe-status.json')

const seedStatus = (owner: string, sourceId: string, extra: Record<string, any>) => {
    const file = statusFile(owner)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const status = {
        version: 1,
        updatedAt: 0,
        sources: {
            [sourceId]: {
                name: sourceId,
                allDownSince: Date.now() - 86400_000,
                removedAt: Date.now() - 3600_000,
                removedReason: '全部平台持续失效超过 3 天',
                platforms: { wy: { status: 'down', failCount: 5, lastCheckAt: 1, lastOkAt: 0, lastError: 'x', autoDisabled: false } },
                ...extra,
            },
        },
    }
    fs.writeFileSync(file, JSON.stringify(status, null, 2), 'utf-8')
}

const readBack = (owner: string) => JSON.parse(fs.readFileSync(statusFile(owner), 'utf-8'))

test('clearProbeRemoval：清掉 removedAt/removedReason/allDownSince，其余字段保留', () => {
    seedStatus('clr-a', 'srcA.js', {})
    assert.equal(clearProbeRemoval('clr-a', 'srcA.js'), true)
    const s = readBack('clr-a').sources['srcA.js']
    assert.equal(s.removedAt, undefined)
    assert.equal(s.removedReason, undefined)
    assert.equal(s.allDownSince, undefined)
    // 巡检账本本身不能被误伤
    assert.equal(s.platforms.wy.status, 'down')
    assert.equal(s.platforms.wy.failCount, 5)
})

test('clearProbeRemoval：没有移除标记时返回 false 且不动文件', () => {
    seedStatus('clr-b', 'srcB.js', { removedAt: undefined, removedReason: undefined, allDownSince: undefined })
    const before = fs.readFileSync(statusFile('clr-b'), 'utf-8')
    assert.equal(clearProbeRemoval('clr-b', 'srcB.js'), false)
    assert.equal(fs.readFileSync(statusFile('clr-b'), 'utf-8'), before)
})

test('clearProbeRemoval：源或空间不存在时返回 false 不抛错', () => {
    assert.equal(clearProbeRemoval('clr-none', 'ghost.js'), false)
    assert.equal(clearProbeRemoval('', ''), false)
})

// ---------- removeProbeStatus（删除音源后剪除巡检账本条目，防 /health 幽灵行） ----------

import { removeProbeStatus } from '../src/server/sourceProbe'

test('removeProbeStatus：删掉该源条目，其他源不受牵连', () => {
    seedStatus('rmv-a', 'srcA.js', {})
    // 同一空间再种一个无辜源
    const file = statusFile('rmv-a')
    const before = JSON.parse(fs.readFileSync(file, 'utf-8'))
    before.sources['innocent.js'] = { name: 'innocent', platforms: {} }
    fs.writeFileSync(file, JSON.stringify(before, null, 2), 'utf-8')

    assert.equal(removeProbeStatus('rmv-a', 'srcA.js'), true)
    const after = readBack('rmv-a').sources
    assert.equal(after['srcA.js'], undefined)          // 幽灵行消失
    assert.notEqual(after['innocent.js'], undefined)   // 无辜源还在
})

test('removeProbeStatus：条目不存在时返回 false 且不动文件', () => {
    seedStatus('rmv-b', 'srcB.js', {})
    const before = fs.readFileSync(statusFile('rmv-b'), 'utf-8')
    assert.equal(removeProbeStatus('rmv-b', 'not-there.js'), false)
    assert.equal(fs.readFileSync(statusFile('rmv-b'), 'utf-8'), before)
})

test('removeProbeStatus：空间或源为空时返回 false 不抛错不落盘', () => {
    assert.equal(removeProbeStatus('rmv-none', 'ghost.js'), false)
    assert.equal(removeProbeStatus('', ''), false)
    // rmv-none 空间根本没建出来：读失败返回空账本，绝不能把空账本写回真路径
    assert.equal(fs.existsSync(statusFile('rmv-none')), false)
})

// ---------- selfHealProbeLedger（巡检启动时账本自愈：C1 反向幽灵 / C2 真孤儿） ----------

import { selfHealProbeLedger } from '../src/server/sourceProbe'

test('C1 反向幽灵：源文件在（active）但账本带 removedAt → 清标记恢复快照可见', () => {
    // 现场：幻音音源.js 文件在源目录，账本残留 11-02 的 removedAt，活源被快照跳过
    seedStatus('heal-a', 'live.js', {})
    const r = selfHealProbeLedger('heal-a', new Set(['live.js']), new Set())
    assert.deepEqual(r.healed, ['live.js'])
    const s = readBack('heal-a').sources['live.js']
    assert.equal(s.removedAt, undefined, 'removedAt 应被清掉')
    assert.equal(s.platforms.wy.failCount, 5, '巡检历史不能误伤')
})

test('C2 真孤儿：文件消失且不在回收站 → 剪除条目；.disabled 视为存在不剪', () => {
    // 现场：Appx64 Clear Music.js 文件彻底消失；豆包定制[聚合音源].js.disabled 是停用产物
    seedStatus('heal-b', 'gone.js', {})
    const file = statusFile('heal-b')
    const before = JSON.parse(fs.readFileSync(file, 'utf-8'))
    before.sources['stopped.js'] = { name: 'stopped', removedAt: undefined, platforms: {} }
    before.sources['trashed.js'] = { name: 'trashed', removedAt: undefined, platforms: {} }
    fs.writeFileSync(file, JSON.stringify(before, null, 2), 'utf-8')
    // stopped.js 以 .disabled 形式存在；gone.js 什么都不剩
    fs.mkdirSync(path.join(tmp, 'users', 'source', 'heal-b'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'users', 'source', 'heal-b', 'stopped.js.disabled'), '// disabled', 'utf-8')

    const r = selfHealProbeLedger('heal-b', new Set(), new Set(['trashed.js']))
    assert.deepEqual(r.pruned, ['gone.js'], `只该剪除真孤儿 gone.js，实际 ${JSON.stringify(r.pruned)}`)
    const after = readBack('heal-b').sources
    assert.equal(after['gone.js'], undefined)
    assert.notEqual(after['stopped.js'], undefined, '.disabled（停用）条目不能剪')
    assert.notEqual(after['trashed.js'], undefined, '回收站里的条目不能剪')
})

test('自愈：活跃源没 removedAt / 账本为空 → 原样返回，不写盘', () => {
    seedStatus('heal-c', 'ok.js', { removedAt: undefined, removedReason: undefined, allDownSince: undefined })
    const before = fs.readFileSync(statusFile('heal-c'), 'utf-8')
    const r = selfHealProbeLedger('heal-c', new Set(['ok.js']), new Set())
    assert.deepEqual(r.healed, [])
    assert.deepEqual(r.pruned, [])
    assert.equal(fs.readFileSync(statusFile('heal-c'), 'utf-8'), before, '没病不能乱动刀')
})
