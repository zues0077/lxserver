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
