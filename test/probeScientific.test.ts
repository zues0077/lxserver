/**
 * 音源巡检「检测科学化」单测（v1.5.54，用户 2026-11-11 拍板）
 *
 * 守两件事：
 *
 * A. **赦免必须穿透到「整源删除」判定**
 *    真实事故：2026-11-11 17950 上一轮探测，日志写「不可用 0、5 个平台疑似异常暂缓处置」，
 *    转头又对这 6 个音源「开始计时 3 天后移除」—— 因为赦免只把 status 改成 unknown，
 *    而全平台失效判定把 `failCount > 0` 也当成失败证据。同一轮里「暂缓」和「判死」并存。
 *
 * B. **软失败不进 failCount**
 *    failCount 直接决定「关平台」与「删音源」两件不可逆的事。403/401 风控、地区/版权限制、
 *    接口返回空这类失败不代表源坏了（HARD_FAILURE_PATTERN 刻意不含 403/401），
 *    让它们凑满阈值等于按风控强度删源。但也不能无限豁免：连续 3 次软失败折成一次硬证据。
 */
import test from 'node:test'
import assert from 'node:assert'
import {
    evalAllDown,
    decideAllDownRemoval,
    isHardFailure,
    notePlatformFailure,
    clearPlatformDemote,
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

const mapOf = (entries: Record<string, PlatformProbeState>) => (p: string) => entries[p]
const DAY = 86400_000
const NOW = 1794400000000

// ---------------- A. 赦免穿透 ----------------

test('A1 本轮全部被赦免（failCount>0 但都带 deferredAt）→ 不算失败证据，不起删除计时', () => {
    const v = evalAllDown(['tx', 'wy', 'kw'], mapOf({
        tx: ps({ status: 'unknown', failCount: 2, deferredAt: NOW }),
        wy: ps({ status: 'unknown', failCount: 1, deferredAt: NOW }),
        kw: ps({ status: 'unknown', failCount: 3, deferredAt: NOW }),
    }))
    assert.strictEqual(v.allDown, true, '全平台都没有可用结论')
    assert.strictEqual(v.hasEvidence, false, '赦免轮不能构成证据')
    const d = decideAllDownRemoval(0, v, NOW, 3 * DAY)
    assert.strictEqual(d.started, false, '不能开始计时')
    assert.strictEqual(d.remove, false)
})

test('A2 有真实定罪平台时，赦免平台不干扰结论（照常判死）', () => {
    const v = evalAllDown(['tx', 'wy'], mapOf({
        tx: ps({ status: 'down', failCount: 3 }),
        wy: ps({ status: 'unknown', failCount: 2, deferredAt: NOW }),
    }))
    assert.strictEqual(v.allDown, true)
    assert.strictEqual(v.hasEvidence, true)
})

test('A3 未被赦免的 unknown（failCount>0）仍算证据 —— 老死锁修复不允许被改回去', () => {
    const v = evalAllDown(['tx', 'wy'], mapOf({
        tx: ps({ status: 'unknown', failCount: 1 }),   // 未到关平台阈值 → status 仍是 unknown
        wy: ps({ status: 'down', failCount: 2 }),
    }))
    assert.strictEqual(v.hasEvidence, true, '没到阈值的真失败必须能累计进删除判定')
})

test('A4 赦免过但本轮已恢复（deferredAt=0）→ 正常参与', () => {
    const v = evalAllDown(['tx', 'wy'], mapOf({
        tx: ps({ status: 'ok' }),
        wy: ps({ status: 'down', failCount: 2, deferredAt: 0 }),
    }))
    assert.strictEqual(v.allDown, false, '有平台可用就不算全平台失效')
})

// ---------------- B. 软失败不计次 ----------------

test('B1 连续两次软失败不进 failCount，但仍然降权（代价极小的那一档）', () => {
    const p = ps({ lastError: '403 Forbidden 版权限制' })
    const r1 = notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, hard: false, now: NOW })
    assert.strictEqual(p.failCount, 0)
    assert.strictEqual(p.softCount, 1)
    assert.strictEqual(r1.counted, false)
    assert.strictEqual(r1.demoted, true, '软失败也要排到换源队尾')

    const r2 = notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, hard: false, now: NOW })
    assert.strictEqual(p.failCount, 0, '两次软失败仍然不计入关闭/删除阈值')
    assert.strictEqual(p.softCount, 2)
    assert.strictEqual(r2.counted, false)
})

test('B2 连续 3 次软失败折成一次硬证据（防长期超时的真死源被永久豁免）', () => {
    const p = ps({ lastError: '403 Forbidden' })
    notePlatformFailure(p, { demoteThreshold: 0, failThreshold: 2, hard: false, now: NOW })
    notePlatformFailure(p, { demoteThreshold: 0, failThreshold: 2, hard: false, now: NOW })
    const r3 = notePlatformFailure(p, { demoteThreshold: 0, failThreshold: 2, hard: false, now: NOW })
    assert.strictEqual(r3.counted, true)
    assert.strictEqual(p.failCount, 1, '第 3 次折算成 1 次硬证据')
    assert.strictEqual(p.softCount, 0, '折算后软计数归零，重新开始累计')
})

test('B3 硬失败照旧计次（行为与升级前一致）', () => {
    const p = ps({ lastError: 'getaddrinfo ENOTFOUND api.example.com' })
    const r = notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, hard: true, now: NOW })
    assert.strictEqual(p.failCount, 1)
    assert.strictEqual(r.counted, true)
    assert.strictEqual(r.demoted, true)
})

test('B4 不传 hard 的调用方（手动取链路径）行为不变：按硬故障计次', () => {
    const p = ps({ lastError: 'ECONNRESET' })
    notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, now: NOW })
    assert.strictEqual(p.failCount, 1)
    assert.strictEqual(p.softCount, 0, '硬失败把软计数归零，不继承软失败的历史')
})

test('B5 硬失败会清掉软计数（连续语义：中间成功过一次再失败不该继承软计数）', () => {
    const p = ps({ lastError: '403' })
    notePlatformFailure(p, { demoteThreshold: 0, failThreshold: 2, hard: false, now: NOW })
    notePlatformFailure(p, { demoteThreshold: 0, failThreshold: 2, hard: false, now: NOW })
    notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, hard: true, now: NOW })
    assert.strictEqual(p.softCount, 0)
    assert.strictEqual(p.failCount, 1)
})

test('B6 成功一次撤销降权（软失败累计的降权同样要能被一次成功抹掉）', () => {
    const p = ps({ lastError: '403' })
    notePlatformFailure(p, { demoteThreshold: 1, failThreshold: 2, hard: false, now: NOW })
    assert.ok(p.demotedAt > 0)
    clearPlatformDemote(p)
    assert.strictEqual(p.demotedAt, 0)
})

// ---------------- 硬/软分类口径抽查 ----------------

test('C1 分类抽查：风控/版权属软失败，域名没了/5xx/404 属硬故障', () => {
    assert.strictEqual(isHardFailure('403 Forbidden'), false)
    assert.strictEqual(isHardFailure('401 未授权'), false)
    assert.strictEqual(isHardFailure('该歌曲暂无版权'), false)
    assert.strictEqual(isHardFailure('getaddrinfo ENOTFOUND api.dead.cn'), true)
    assert.strictEqual(isHardFailure('connect ECONNREFUSED 1.2.3.4:80'), true)
    assert.strictEqual(isHardFailure('HTTP 500 Internal Server Error'), true)
    assert.strictEqual(isHardFailure('GET 404 music.haitangw.cc'), true)
    assert.strictEqual(isHardFailure('接口已停止服务，请升级'), true)
})
