/**
 * 隔离记录总览的取数逻辑
 *
 * 背景（2026-11-04）：隔离只能逐个在卡片上点，隔离多了看不到「一共关了几个、
 * 还剩几次自动复核、都因为什么」。总览接口返回的每条记录必须自带：
 * 人话原因、原始判定码、还能自动放行几次、下次放行时间。
 * 这里直接喂一份 store 文件，验证取数与换算（IO 已在别处覆盖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listIsolations, ISOLATION_AUTO_RELEASE_MS } from '../src/server/sourceGuard.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-guard-'))
process.env.DATA_PATH = root

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

fs.writeFileSync(path.join(root, 'source-guard.json'), JSON.stringify({
    version: 1,
    isolated: [
        { owner: 'open', id: 'probe-src', name: '探测隔离源', fingerprint: 'fp1', level: 'A', reason: 'cpu_probe:16.7%', reasons: [], source: 'probe', at: hoursAgo(25) },
        { owner: 'open', id: 'static-src', name: '静态隔离源', fingerprint: 'fp2', level: 'A', reason: 'infinite_loop+debugger_trap', reasons: [], source: 'static', at: hoursAgo(2) },
    ],
    trusted: [],
    // probe-src 已经自动放行过 2 次，只剩最后 1 次机会
    autoReleased: { 'open_probe-src': 2 },
}))

test('总览：原因翻成人话，原始判定码同时保留', () => {
    const list = listIsolations()
    const probe = list.find(i => i.id === 'probe-src')
    assert.ok(probe, '应能列出运行期隔离记录')
    assert.match(probe!.reasonText, /疑似空转/)
    assert.equal(probe!.reason, 'cpu_probe:16.7%', '原始码要留着，便于排查与反馈')
})

test('总览：运行期隔离算出剩余复核次数与下次放行时间', () => {
    const probe = listIsolations().find(i => i.id === 'probe-src')!
    assert.equal(probe.pardonCount, 2)
    assert.equal(probe.pardonsLeft, 1, '已放行 2 次，上限 3 次，应剩 1 次')
    assert.ok(probe.autoReleaseAt, 'probe 类要有下次放行时间')
    const at = Date.parse(probe.autoReleaseAt!)
    assert.ok(at + ISOLATION_AUTO_RELEASE_MS > Date.now(), '放行时间还没到')
})

test('总览：静态特征隔离不放行，剩余次数恒为 0 且没有放行时间', () => {
    const stat = listIsolations().find(i => i.id === 'static-src')!
    assert.equal(stat.pardonsLeft, 0)
    assert.equal(stat.autoReleaseAt, null)
    assert.match(stat.reasonText, /死循环/)
})

test('清理临时目录', () => {
    fs.rmSync(root, { recursive: true, force: true })
})
