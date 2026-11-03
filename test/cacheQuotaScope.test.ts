import { test } from 'node:test'
import assert from 'node:assert'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

// fileCache 顶层会读 global.lx.dataPath（且 user/data 会往里写 serverInfo.json），
// 导入前必须先预置一个真实存在的临时目录，不碰真实数据
const TEST_DATA_PATH = path.join(os.tmpdir(), 'lx-cache-quota-test')
const TEST_USER_PATH = path.join(TEST_DATA_PATH, 'users')
fs.mkdirSync(TEST_USER_PATH, { recursive: true })
;(global as any).lx = {
    dataPath: TEST_DATA_PATH,
    userPath: TEST_USER_PATH,
    config: {},
}

// 上游 issue #489 回归护栏：缓存空间配额只统计缓存目录，绝不能把已下载文件（music 目录）算进去。
// 旧逻辑用 getCacheStats().totalSize（cache + music），用户把上限从 10G 调到 5G 后，
// 清理会按 mtime 从旧到新删，下载目录里的老文件最先被删 —— 表现为「下载目录少了一半」。

const load = () => import('../src/server/fileCache.js')

test('配额只取 cache 目录，不叠加 music 目录', async () => {
    const { getCacheQuotaUsageBytes } = await load()
    const stats = {
        cache: { totalSize: 100 * 1024 * 1024, fileCount: 10 },
        music: { totalSize: 900 * 1024 * 1024, fileCount: 90 },
        xiaoai: { totalSize: 0, fileCount: 0 },
        totalSize: 1000 * 1024 * 1024,
        fileCount: 100,
    }
    assert.strictEqual(getCacheQuotaUsageBytes(stats), 100 * 1024 * 1024)
    assert.notStrictEqual(getCacheQuotaUsageBytes(stats), stats.totalSize)
})

test('xiaoai 子目录已计入 cache，不能重复叠加', async () => {
    const { getCacheQuotaUsageBytes } = await load()
    const stats = {
        cache: { totalSize: 300, fileCount: 3 }, // 已含 xiaoai 的 100
        music: { totalSize: 5000, fileCount: 50 },
        xiaoai: { totalSize: 100, fileCount: 1 },
        totalSize: 5300,
        fileCount: 53,
    }
    assert.strictEqual(getCacheQuotaUsageBytes(stats), 300)
})

test('只有下载文件时配额基准为 0（永不触发清理）', async () => {
    const { getCacheQuotaUsageBytes } = await load()
    const stats = {
        cache: { totalSize: 0, fileCount: 0 },
        music: { totalSize: 10 * 1024 * 1024 * 1024, fileCount: 500 },
        xiaoai: { totalSize: 0, fileCount: 0 },
        totalSize: 10 * 1024 * 1024 * 1024,
        fileCount: 500,
    }
    assert.strictEqual(getCacheQuotaUsageBytes(stats), 0)
})

test('异常/缺字段时退化为 0，不抛错', async () => {
    const { getCacheQuotaUsageBytes } = await load()
    assert.strictEqual(getCacheQuotaUsageBytes({}), 0)
    assert.strictEqual(getCacheQuotaUsageBytes({ cache: {} } as any), 0)
    assert.strictEqual(getCacheQuotaUsageBytes(null as any), 0)
})
