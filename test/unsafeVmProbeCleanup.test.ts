/**
 * requireUnsafe 探测实例清理回归（口径甲）
 *
 * 背景：VM2 加载失败且总闸 `system.allowUnsafeVM=true` 时，`loadUserApi` 会递归用
 * `allowUnsafeVM:true` 再加载一次，用来判断「换原生 VM 能不能跑」。旧写法沿用上游
 * `XCQ0607/lxserver` 的 `id + '_test_vm'` 递归，但上游没有 dispose 机制；本地已重构出
 * 实例级 dispose 与 `owner==='temp'` 立即释放契约（`getScriptInfo` 已在用），
 * 探测分支却没同步 —— 探测实例被写进 `loadedApis` 且不清理：
 *   · 列表显示 failed，取链候选却仍能命中这个无 vm2 隔离的实例；
 *   · 定时器/在途请求常驻（/health 的 trackedTimers 里出现 `*_test_vm`）；
 *   · 增量重载按真实 apiKey 卸载，匹配不到 `*_test_vm`，只有重启才清得掉。
 *
 * 修复：探测调用带 `owner:'temp'`，只判定、立即释放、不进运行时注册表。
 * 这里同时锁住三件事：源码契约、运行时无残留、总闸关闭时不隐式降隔离。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 模块顶层先备好最小全局配置，再动态 import —— userApi 的多个依赖会在加载/执行期读它。
const tmpDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-unsafe-vm-probe-'))
;(globalThis as any).lx = {
    config: {
        'system.allowUnsafeVM': true,
        'debug.enabled': false,
        'customSource.blockPrivateNetwork': false,
        'proxy.enabled': false,
        users: [],
    },
    dataPath: tmpDataPath,
}

/** vm2 下必然失败（`Proxy is not a constructor`），原生 vm 下可正常 inited。 */
const PROXY_SCRIPT = `/*!
 * @name probe-fixture
 * @version 1.0.0
 */
var toggles = new Proxy({}, {});
lx.send('inited', { sources: { kw: { name: 'fixture', qualitys: ['128k'] } } });
`

const SRC_PATH = path.resolve('src/server/userApi.ts')

function loadModule(): Promise<any> {
    return import('../src/server/userApi')
}

test('源码契约：探测递归必须走 owner=temp，且 temp 实例必须立即 dispose', () => {
    const src = fs.readFileSync(SRC_PATH, 'utf8')

    const probeStart = src.indexOf('id: `${apiInfo.id}_test_vm`')
    assert.ok(probeStart > 0, '找不到 requireUnsafe 探测调用')
    const probeEnd = src.indexOf('return { success: false', probeStart)
    const probeBlock = src.slice(probeStart, probeEnd)
    assert.match(probeBlock, /allowUnsafeVM:\s*true/, '探测必须用原生 VM 试加载')
    assert.match(probeBlock, /owner:\s*'temp'/, '探测实例必须标记为 temp，否则会被登记进 loadedApis')

    assert.match(
        src,
        /if \(fullApiInfo\.owner === 'temp'\) \{\s*apiInstance\.dispose\(\)/,
        'temp 实例必须在成功分支立即 dispose',
    )
})

test('运行时：探测后 loadedApis / 定时器 / 巡检候选都无 *_test_vm 残留，requireUnsafe 仍为 true', async () => {
    const m = await loadModule()
    const beforeRefs = m.getLoadedApiRefs().length
    const beforeTimers = m.getTrackedTimerCount()

    const res = await m.loadUserApi({
        id: 'probe-fixture.js',
        name: 'probe-fixture',
        script: PROXY_SCRIPT,
        enabled: true,
        allowUnsafeVM: false,
        owner: 'probe-owner',
    } as any)

    // 判定能力没有被削弱：vm2 失败 + 原生 VM 成功 → 仍要提示用户开白名单
    assert.equal(res.success, false)
    assert.match(String(res.error), /Proxy is not a constructor/)
    assert.equal(res.requireUnsafe, true, '探测成功必须仍返回 requireUnsafe，风险确认链路不能断')

    const refs = m.getLoadedApiRefs()
    const probeTargets = m.getProbeTargets()
    assert.equal(refs.length, beforeRefs, '探测实例不得进入 loadedApis')
    assert.ok(!refs.some((r: any) => String(r.id).includes('_test_vm')), 'loadedApis 出现 *_test_vm 残留')
    assert.ok(
        !probeTargets.some((t: any) => String(t.id).includes('_test_vm')),
        '巡检/取链候选出现 *_test_vm 残留',
    )
    assert.equal(m.getTrackedTimerCount(), beforeTimers, '探测实例的定时器/在途请求必须被释放')
    assert.ok(
        !m.getTrackedTimerDetails().some((t: any) => String(t.id).includes('_test_vm')),
        '定时器明细里不应出现探测实例',
    )
})

test('总闸关闭时不隐式降隔离：不触发原生 VM 探测，requireUnsafe 保持 false', async () => {
    const m = await loadModule()
    const cfg = (globalThis as any).lx.config
    cfg['system.allowUnsafeVM'] = false
    try {
        const res = await m.loadUserApi({
            id: 'probe-no-gate.js',
            name: 'probe-no-gate',
            script: PROXY_SCRIPT,
            enabled: true,
            allowUnsafeVM: false,
            owner: 'probe-owner',
        } as any)
        assert.equal(res.success, false)
        assert.match(String(res.error), /Proxy is not a constructor/)
        assert.equal(res.requireUnsafe, false, '总闸关闭时不应做任何原生 VM 探测')
        assert.ok(
            !m.getLoadedApiRefs().some((r: any) => String(r.id).includes('_test_vm')),
            '总闸关闭不应产生探测实例',
        )
    } finally {
        cfg['system.allowUnsafeVM'] = true
    }
})

// ---- vm2 加载失败诊断 vmHint（补齐「分不清可救源/坏源」缺口）----

test('classifyVmFailure：三档互斥分类', async () => {
    const m = await loadModule()
    const cls = m.classifyVmFailure

    // 高置信：探测证明原生 VM 可用，或错误就是 REQUIRE_UNSAFE_VM
    assert.equal(cls('Proxy is not a constructor', true), 'unsafe-capable')
    assert.equal(cls('REQUIRE_UNSAFE_VM', false), 'unsafe-capable')
    assert.equal(cls(undefined, true), 'unsafe-capable')

    // 中置信：P-1509 确诊的唯一 vm2 阻断点
    assert.equal(cls('Proxy is not a constructor', false), 'vm2-incompatible')

    // 无判据：语法/网络/超时/其它
    assert.equal(cls('SyntaxError: Unexpected token', false), undefined)
    assert.equal(cls('timeout', false), undefined)
    assert.equal(cls(undefined, undefined), undefined)
    assert.equal(cls(null, false), undefined)

    // 高置信优先于中置信
    assert.equal(cls('Proxy is not a constructor', true), 'unsafe-capable')
})

test('失败写状态必须带 vmHint，且不写 sources.json（只诊断、不处置）', () => {
    const src = fs.readFileSync(SRC_PATH, 'utf8')

    // 失败分支写 apiStatus 时带上 vmHint（两处：loadUserApi 返回失败 / catch 异常）
    const vmHintCalls = src.match(/vmHint:\s*classifyVmFailure\([^)]*\)/g) || []
    assert.ok(vmHintCalls.length >= 2, `失败写状态应至少两处带 vmHint，实际 ${vmHintCalls.length}`)
    assert.match(src, /vmHint:\s*classifyVmFailure\(result\.error,\s*result\.requireUnsafe\)/,
        'loadUserApi 失败分支必须用探测结果 requireUnsafe 做高置信判据')

    // 诊断只写内存 apiStatus，不回写 sources.json：失败分支 needsSave 仍为 false
    const failBlock = src.slice(src.indexOf('console.error(`[自定义源] [${owner}] 加载'), src.indexOf('return { needsSave: false }', src.indexOf('} catch (error: any)')))
    assert.ok(!/needsSave:\s*true/.test(failBlock), '加载失败分支不得写回 sources.json（needsSave 必须为 false）')
})

test('源码契约：classifyVmFailure 是纯函数，不读配置、不改状态、不执行脚本', () => {
    const src = fs.readFileSync(SRC_PATH, 'utf8')
    const start = src.indexOf('export function classifyVmFailure')
    assert.ok(start > 0, '找不到 classifyVmFailure')
    const end = src.indexOf('\n}', start)
    const fn = src.slice(start, end)
    assert.ok(!/global\.lx|apiStatus|sources|require\(|vm\.run|\.set\(/.test(fn),
        'classifyVmFailure 必须是纯函数：不读配置、不写状态、不执行脚本')
})
