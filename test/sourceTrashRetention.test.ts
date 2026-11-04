/**
 * 回收站过期清理
 *
 * 背景（2026-11-04）：回收站只增不减，巡检每轮都可能往里丢脚本，NAS 的盘迟早被吃满。
 * 规则：默认保留 30 天，配置为 0 表示永不自动清理；到期条目被彻底删除（连同 .meta.json）。
 * 删除是不可逆动作，所以这里额外守住两条：
 *  1. 时间读不出来的条目不动；
 *  2. 未到期的条目一条都不能少。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { purgeExpiredTrash, listTrash } from '../src/server/sourceTrash.ts'

// dataPath() 是调用时求值，这里设置完再调用即可（模块顶层不读）
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-trash-'))
process.env.DATA_PATH = root

const trashDir = path.join(root, 'users', 'source', '_open', '.trash')

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600_000).toISOString()

function seed(file: string, meta: Record<string, unknown> | null, mtimeDaysAgo = 1) {
    fs.mkdirSync(trashDir, { recursive: true })
    const p = path.join(trashDir, file)
    fs.writeFileSync(p, '// fake source script')
    const t = new Date(Date.now() - mtimeDaysAgo * 24 * 3600_000)
    fs.utimesSync(p, t, t)
    if (meta) fs.writeFileSync(`${p}.meta.json`, JSON.stringify(meta))
    return p
}

test('回收站过期清理：只删超过保留期的条目，未到期的一条不动', () => {
    seed('2026-01-01T00-00-00-000Z__old-source', {
        id: 'old-source', name: '老源', trashedAt: daysAgo(40), trashedBy: 'probe',
    }, 40)
    seed('2026-02-01T00-00-00-000Z__new-source', {
        id: 'new-source', name: '新源', trashedAt: daysAgo(1), trashedBy: 'manual',
    }, 1)

    const before = listTrash('open').length
    assert.equal(before, 2, '前置条件：应有 2 条回收站记录')

    const { removed, scanned } = purgeExpiredTrash(30)
    assert.equal(scanned, 2)
    assert.equal(removed, 1, '只应删除超过 30 天的那条')

    const left = listTrash('open').map(it => it.id)
    assert.deepEqual(left, ['new-source'])
    // meta 必须跟着删，否则下次读回收站会对着空气渲染
    assert.ok(!fs.existsSync(path.join(trashDir, '2026-01-01T00-00-00-000Z__old-source.meta.json')))
})

test('保留天数设为 0 时永不清理', () => {
    const { removed, scanned } = purgeExpiredTrash(0)
    assert.equal(scanned, 0)
    assert.equal(removed, 0)
    assert.equal(listTrash('open').length, 1)
})

test('没有 meta 的老文件按 mtime 判定过期', () => {
    seed('2026-03-01T00-00-00-000Z_legacy-source', null, 60)
    const { removed } = purgeExpiredTrash(30)
    assert.equal(removed, 1, '没有 meta 的老文件也应能被清理')
    assert.deepEqual(listTrash('open').map(it => it.id), ['new-source'])
})

test('清理完成后临时目录可回收', () => {
    fs.rmSync(root, { recursive: true, force: true })
    assert.ok(!fs.existsSync(root))
})
