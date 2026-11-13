import { test } from 'node:test'
import assert from 'node:assert/strict'

test('A\' 开关：默认关闭（无 env、无配置键）', async () => {
    delete process.env.CUSTOM_SOURCE_WORKER_ONLY
    ;(global as any).lx = { config: {} }
    const m = await import('../src/server/userApi')
    assert.equal(m.isWorkerOnlyEnabled(), false)
})

test('A\' 开关：配置键 customSource.workerOnly.enabled=true 打开', async () => {
    delete process.env.CUSTOM_SOURCE_WORKER_ONLY
    ;(global as any).lx = { config: { 'customSource.workerOnly.enabled': true } }
    const m = await import('../src/server/userApi')
    assert.equal(m.isWorkerOnlyEnabled(), true)
})

test('A\' 开关：环境变量 CUSTOM_SOURCE_WORKER_ONLY=1 优先（配置键为 false 也打开）', async () => {
    process.env.CUSTOM_SOURCE_WORKER_ONLY = '1'
    ;(global as any).lx = { config: { 'customSource.workerOnly.enabled': false } }
    const m = await import('../src/server/userApi')
    assert.equal(m.isWorkerOnlyEnabled(), true)
    delete process.env.CUSTOM_SOURCE_WORKER_ONLY
})
