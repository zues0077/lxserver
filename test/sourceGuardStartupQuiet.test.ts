/**
 * 2026-11-06：启动静默期护栏。
 *
 * 246 上连续三次启动，每次都有**一个无辜音源**被判「空转」：
 *   02:10 全豆要        cpu_probe:0.4%（旧文案：卸载后仍占 0.4%）
 *   06:10 全豆要        cpu_probe:drop=35.8,after=0.5,base=36.2
 *   06:19 墨澜聚合音源  cpu_probe:drop=27.5,after=7.7,base=35.2
 * 三次 baseline 都是 30~36%，是「加载 40 个源 + worker 预热」的启动负载，
 * 此时卸载任意源都会看到大幅回落，`drop = baseline - after` 判据必然成立。
 * 全豆要实测只有 10 次请求、加载 39ms，根本不是空转源。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { inStartupQuietWindow } from '../src/server/sourceGuard'

test('inStartupQuietWindow：启动 5 分钟内不做 CPU 复检', () => {
    const fiveMin = 5 * 60 * 1000
    // 三次真实误封都发生在启动后 35~65 秒
    assert.equal(inStartupQuietWindow(fiveMin, 35_000), true)
    assert.equal(inStartupQuietWindow(fiveMin, 65_000), true)
    assert.equal(inStartupQuietWindow(fiveMin, 5 * 60 * 1000 - 1), true)
})

test('inStartupQuietWindow：静默期结束后恢复正常复检', () => {
    const fiveMin = 5 * 60 * 1000
    assert.equal(inStartupQuietWindow(fiveMin, fiveMin), false)
    assert.equal(inStartupQuietWindow(fiveMin, 30 * 60 * 1000), false)
})

test('inStartupQuietWindow：配置 0 表示不限制（保留关闭开关）', () => {
    assert.equal(inStartupQuietWindow(0, 0), false)
    assert.equal(inStartupQuietWindow(-1, 1000), false)
})

test('inStartupQuietWindow：负数 uptime 视为异常输入，不静默', () => {
    assert.equal(inStartupQuietWindow(5 * 60 * 1000, -1), false)
})
