/**
 * 候选源排序的可复现性。
 *
 * 背景（2026-11-08 A/B 实测）：两个实例数据、配置、镜像基线完全相同，
 * 只有 R77 的改动不同，结果 wy 平台**稳定地**选中了不同的源 ——
 * 一个命中 110ms 的源，另一个命中 1.9s 的源，同歌同档差 17 倍。
 * 根因是 `_open` 下根本没有 order.json，候选顺序退化成「脚本加载完成顺序」，
 * 也就是异步竞态。这里用纯函数把规则钉死：order.json 优先，未列出者按 id 字典序。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const g = global as any
g.lx = { ...(g.lx || {}), config: { 'debug.enabled': false } }

import { sortCandidatesByOrder } from '../src/server/userApi'

const src = (id: string, name?: string) => ({ info: { id, name: name || id, owner: 'open', sources: {} } })
const ids = (list: any[]) => list.map((x: any) => x.info.id)

test('order.json 里列出的按表内顺序排', () => {
    const list = [src('a.js'), src('b.js'), src('c.js')]
    const order = new Map([['c.js', 0], ['a.js', 1], ['b.js', 2]])
    assert.deepStrictEqual(ids(sortCandidatesByOrder(list, order)), ['c.js', 'a.js', 'b.js'])
})

test('order.json 为空时按 id 字典序兜底（不再沿用加载完成顺序）', () => {
    const list = [src('z.js'), src('a.js'), src('m.js')]
    assert.deepStrictEqual(ids(sortCandidatesByOrder(list, new Map())), ['a.js', 'm.js', 'z.js'])
})

test('未列出的源排在已列出源之后，且它们之间按 id 字典序', () => {
    const list = [src('z.js'), src('b.js'), src('a.js')]
    const order = new Map([['b.js', 0]])
    assert.deepStrictEqual(ids(sortCandidatesByOrder(list, order)), ['b.js', 'a.js', 'z.js'])
})

test('同一份输入连排两次结果一致（顺序可复现）', () => {
    const list = [src('q.js'), src('c.js'), src('w.js'), src('e.js')]
    const once = sortCandidatesByOrder(list, new Map())
    const twice = sortCandidatesByOrder([...list].reverse(), new Map())
    assert.deepStrictEqual(ids(once), ids(twice))
})

test('不改入参数组（调用方可能还在用原顺序做别的事）', () => {
    const list = [src('b.js'), src('a.js')]
    const snapshot = ids(list)
    sortCandidatesByOrder(list, new Map())
    assert.deepStrictEqual(ids(list), snapshot)
})

// ==== order.json 缺失时的「冻结当前顺序」 ====

test('order.json 缺失 → 按当前顺序落盘冻结，内容与传入一致', () => {
    const { persistOrderSnapshot, __resetOrderSnapshotState } = require('../src/server/userApi')
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    __resetOrderSnapshotState()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-order-'))
    const file = path.join(dir, 'order.json')
    const list = ['z.js', 'a.js', 'm.js'] // 故意逆字典序：冻结的是顺序，不是字典序
    assert.strictEqual(persistOrderSnapshot(file, list), true)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), list)
    assert.deepStrictEqual(ids(sortCandidatesByOrder([src('a.js'), src('m.js'), src('z.js')],
        new Map(list.map((id: string, i: number) => [id, i])))), list)
    fs.rmSync(dir, { recursive: true, force: true })
})

test('已经冻结过 → 不重复写，也不覆盖已有文件', () => {
    const { persistOrderSnapshot, __resetOrderSnapshotState } = require('../src/server/userApi')
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    __resetOrderSnapshotState()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-order-'))
    const file = path.join(dir, 'order.json')
    fs.writeFileSync(file, JSON.stringify(['keep.js', 'me.js']), 'utf-8')
    assert.strictEqual(persistOrderSnapshot(file, ['a.js', 'b.js']), false)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), ['keep.js', 'me.js'])
    fs.rmSync(dir, { recursive: true, force: true })
})

test('候选少于 2 个或路径为空 → 不写文件', () => {
    const { persistOrderSnapshot, __resetOrderSnapshotState } = require('../src/server/userApi')
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    __resetOrderSnapshotState()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-order-'))
    const file = path.join(dir, 'order.json')
    assert.strictEqual(persistOrderSnapshot(file, ['only.js']), false)
    assert.strictEqual(fs.existsSync(file), false)
    assert.strictEqual(persistOrderSnapshot('', ['a.js', 'b.js']), false)
    fs.rmSync(dir, { recursive: true, force: true })
})
