/**
 * 慢源熔断：脚本自身同步重活连续命中 → 自动停用（隔离）
 *
 * 背景（2026-11-04，246 实测）：
 *   「非常刀」「西瓜聚合源」单条响应稳定卡 4.8~5.6 秒，三段拆开是
 *   parse 0ms / 深拷贝 3~12ms / **脚本回调 4.9~5.6 秒** —— 卡顿全在脚本自己身上，
 *   所以「把响应体上限降下来」这条老路对它们完全无效（原日志自己都写着「降闸无效」）。
 *
 * 处置改为按实测证据熔断：同一个源 30 分钟内第 3 次「回调为主因且 ≥2 秒」就隔离停用。
 * 体积为主因的不熔断 —— 数据大不代表源有问题，降闸就够。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as guard from '../src/server/sourceGuard'
import * as api from '../src/server/userApi'

// DATA_PATH 是每次读写时现取的（storeFilePath 是函数），所以放在 import 之后设置也生效
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-slow-'))
process.env.DATA_PATH = root

/** 一次「脚本自己算得慢」的响应：3.2MB，回调 5 秒，parse/拷贝都是毫秒级 */
const slowScriptTask = (id: string, name: string, callbackMs = 5182) => ({
    meta: { owner: 'open', id, name, bytes: Math.round(3.2 * 1024 * 1024) },
    probe: { parseMs: 0, deconMs: 3, callbackMs },
})

test('脚本自身同步重活：默认先降速运行，不直接停用', () => {
    const { meta, probe } = slowScriptTask('feichangdao.js', '非常刀')

    // 246 实测：5.6 秒的同步块属于「严重档」，第一次就该降速
    api.reportSlowTask(meta, 5185, probe)
    assert.equal(guard.getIsolationFor('open', 'feichangdao.js'), null, '降速优先，不该停用')
    api.reportSlowTask(meta, 5182, probe)
    api.reportSlowTask(meta, 5603, probe)
    assert.equal(guard.getIsolationFor('open', 'feichangdao.js'), null, '已降速的源不再累计隔离计数')
})

test('关掉降速时，熔断停用仍是兜底（reason 带次数与耗时）', () => {
    const prev = (global as any).lx?.config
    ;(global as any).lx = { config: { 'customSource.governor.enabled': false } }
    try {
        const { meta, probe } = slowScriptTask('fallback.js', '兜底源')
        api.reportSlowTask(meta, 5185, probe)
        api.reportSlowTask(meta, 5182, probe)
        assert.equal(guard.getIsolationFor('open', 'fallback.js'), null, '前两次不该停用')

        api.reportSlowTask(meta, 5603, probe)
        const rec = guard.getIsolationFor('open', 'fallback.js')
        assert.ok(rec, '第 3 次应当自动停用')
        assert.equal(rec.source, 'probe', '必须归为运行期判定，才能享受 24h 自动放行复核')
        assert.match(rec.reason, /^slow_sync:\d+msx3$/, '原因要能自证：耗时 + 命中次数')
        // fingerprint 留空：熔断是运行期判定，不该被「脚本内容变了」这条规则顺手解除
        assert.equal(rec.fingerprint, '')
    } finally {
        ;(global as any).lx = { ...(prev ? { config: prev } : {}) }
    }
})

test('体积为主因的源不熔断，只降闸', () => {
    const meta = { owner: 'open', id: 'bigbody.js', name: '大数据源', bytes: 5 * 1024 * 1024 }
    const probe = { parseMs: 800, deconMs: 900, callbackMs: 10 }
    for (let i = 0; i < 6; i++) api.reportSlowTask(meta, 1800, probe)
    assert.equal(guard.getIsolationFor('open', 'bigbody.js'), null, '数据大不是源的错，不该停用')
    // 降闸照旧生效（上限被压到本次体积的 0.6）
    const limit = api.effectiveBodyLimit('open', 'bigbody.js')
    assert.ok(limit < 5 * 1024 * 1024, '体积型仍应触发自适应降闸')
})

test('偶发一次慢不熔断', () => {
    const { meta, probe } = slowScriptTask('once.js', '偶发源', 2500)
    api.reportSlowTask(meta, 2600, probe)
    assert.equal(guard.getIsolationFor('open', 'once.js'), null)
})

test('回调没超过 2 秒不计入熔断', () => {
    const meta = { owner: 'open', id: 'mild.js', name: '轻微慢', bytes: 100 }
    const probe = { parseMs: 0, deconMs: 0, callbackMs: 900 }
    for (let i = 0; i < 5; i++) api.reportSlowTask(meta, 3000, probe)
    assert.equal(guard.getIsolationFor('open', 'mild.js'), null, '整体慢但回调不慢，不是脚本的锅')
})

test('关掉降速时，已隔离的源重复触发不会刷掉原记录', () => {
    const prev = (global as any).lx?.config
    ;(global as any).lx = { config: { 'customSource.governor.enabled': false } }
    try {
        const { meta, probe } = slowScriptTask('repeat.js', '重复源')
        for (let i = 0; i < 3; i++) api.reportSlowTask(meta, 5200, probe)
        const first = guard.getIsolationFor('open', 'repeat.js')
        assert.ok(first)
        // 再触发两次（停用后理论上不会再跑，这里直接模拟接口被重复调用）
        api.reportSlowTask(meta, 6000, probe)
        api.reportSlowTask(meta, 6200, probe)
        const again = guard.getIsolationFor('open', 'repeat.js')
        assert.equal(again.at, first.at, '不该覆盖已有记录的时间')
    } finally {
        ;(global as any).lx = { ...(prev ? { config: prev } : {}) }
    }
})

test('隔离原因能翻成人话', () => {
    const text = guard.describeIsolationReason('slow_sync:5182msx3')
    assert.match(text, /5\.2 秒/, '要带上人类可读的时长')
    assert.match(text, /第 3 次/, '要说明是第几次')
    assert.match(text, /自动停用/)
    assert.match(text, /与响应体大小无关/, '要提示不是数据大的问题，否则用户会去调体积上限')
})
