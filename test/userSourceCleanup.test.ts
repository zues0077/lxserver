/**
 * P1 · 删除用户时清理自定义音源空间（借鉴上游 v2.2.0）。
 *
 * 覆盖不变式：
 *   1. 删除用户 alice 时，<DATA_PATH>/users/source/alice/ 整目录（脚本、sources.json、
 *      order.json、states.json、probe-status.json）被清掉；
 *   2. `_open` 公共空间与其他用户 bob 的目录**不受影响**；
 *   3. 保留名与路径穿越用户名一律拒绝（不解析出目录、不删任何东西）；
 *   4. 目录不存在不报错，返回 removed=false。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveUserSourceDir, cleanupUserSources } from '../src/server/userSourceCleanup'

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lx-user-src-cleanup-'))

const seedUser = (dataPath: string, name: string, files: string[] = ['sources.json', 'states.json', 'order.json', 'probe-status.json', 'my-source.js']) => {
    const dir = path.join(dataPath, 'users', 'source', name)
    fs.mkdirSync(dir, { recursive: true })
    for (const f of files) fs.writeFileSync(path.join(dir, f), '{}')
    return dir
}

test('删除用户时清掉该用户音源目录，保留 _open 与其他用户', () => {
    const root = makeRoot()
    try {
        const alice = seedUser(root, 'alice')
        const open = seedUser(root, '_open')
        const bob = seedUser(root, 'bob')

        const r = cleanupUserSources(root, 'alice')
        assert.equal(r.removed, true)
        assert.equal(r.dir, alice)
        assert.equal(fs.existsSync(alice), false)
        assert.equal(fs.existsSync(open), true, '_open 公共空间必须保留')
        assert.equal(fs.existsSync(bob), true, '其他用户目录必须保留')
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('保留名 _open / open / default 与空用户名一律拒绝', () => {
    const root = makeRoot()
    try {
        const open = seedUser(root, '_open')
        for (const name of ['_open', 'open', 'default', '']) {
            assert.equal(resolveUserSourceDir(root, name), null, `应拒绝: ${name}`)
            assert.equal(cleanupUserSources(root, name).removed, false, `不应删除: ${name}`)
        }
        assert.equal(fs.existsSync(open), true)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('路径穿越用户名一律拒绝，且不会删到 source root 之外', () => {
    const root = makeRoot()
    try {
        const open = seedUser(root, '_open')
        for (const name of ['..', '.', '../_open', 'a/b', 'a\\b', 'a..b', 'bob/../../_open']) {
            assert.equal(resolveUserSourceDir(root, name), null, `应拒绝: ${name}`)
        }
        assert.equal(fs.existsSync(open), true)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('目录不存在时视为无需清理，不抛异常', () => {
    const root = makeRoot()
    try {
        const r = cleanupUserSources(root, 'nobody')
        assert.equal(r.removed, false)
        assert.equal(r.dir, path.join(root, 'users', 'source', 'nobody'))
        assert.equal(r.error, undefined)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('解析出的目录严格位于 users/source 之下', () => {
    const root = makeRoot()
    try {
        const dir = resolveUserSourceDir(root, 'alice')
        assert.ok(dir)
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(path.join(root, 'users', 'source')))
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})
