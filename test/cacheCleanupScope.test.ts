import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 上游 issue #489 续：本地此前已修「配额只算 cache、music 不删」，本轮补
 * 「清理不删索引/临时文件/传输中文件、音频+歌词同组删、删除前二次校验、索引同步」。
 * 全程用 os.tmpdir() 下的专用临时目录，不碰真实数据。
 */
const ROOT = path.join(os.tmpdir(), 'lx-cache-cleanup-test')
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })
// src/user/data.ts 顶层会 readdirSync(global.lx.userPath)，不预置会 ENOENT
const USER_PATH = path.join(ROOT, 'users')
fs.mkdirSync(USER_PATH, { recursive: true })
;(global as any).lx = {
    dataPath: ROOT,
    userPath: USER_PATH,
    config: {
        serverCacheLocation: 'data',
        'user.enableCacheSizeLimit': true,
        'user.cacheSizeLimit': 1.5,
    },
}

const load = () => import('../src/server/fileCache.js')

const makeCache = (tag: string) => {
    const dataPath = path.join(ROOT, tag)
    ;(global as any).lx.dataPath = dataPath
    ;(global as any).lx.config['user.cacheSizeLimit'] = 1.5
    const dir = path.join(dataPath, 'cache', '_open')
    fs.mkdirSync(dir, { recursive: true })
    return dir
}

const writeFile = (p: string, size: number, ageMs: number) => {
    fs.writeFileSync(p, Buffer.alloc(size, 97))
    const t = new Date(Date.now() - ageMs)
    fs.utimesSync(p, t, t)
}

const OLD = 10 * 24 * 60 * 60 * 1000

test('配额清理只删最旧的媒体文件：索引 json / .tmp / 非媒体文件一律不动', async () => {
    const dir = makeCache('case1')
    const { indexManager } = await load()
    indexManager.discard('_open', 'cache')

    writeFile(path.join(dir, 'old.mp3'), 1024 * 1024, OLD)
    writeFile(path.join(dir, 'old.lrc'), 1024, OLD)
    writeFile(path.join(dir, 'new.mp3'), 1024 * 1024, 0)
    fs.writeFileSync(path.join(dir, 'cache_index.json'), '{}')
    writeFile(path.join(dir, 'downloading.tmp'), 512 * 1024, 0)
    fs.writeFileSync(path.join(dir, 'cover.jpg'), 'x')

    await (await load()).checkAndCleanupCache()

    assert.equal(fs.existsSync(path.join(dir, 'old.mp3')), false, '最旧音频应被清理')
    assert.equal(fs.existsSync(path.join(dir, 'old.lrc')), false, '同名 .lrc 必须同组删除，不留孤立歌词')
    assert.equal(fs.existsSync(path.join(dir, 'new.mp3')), true, '较新音频应保留')
    assert.equal(fs.existsSync(path.join(dir, 'cache_index.json')), true, '索引文件绝不能被删')
    assert.equal(fs.existsSync(path.join(dir, 'downloading.tmp')), true, '下载中的 .tmp 绝不能被删')
    assert.equal(fs.existsSync(path.join(dir, 'cover.jpg')), true, '非媒体文件绝不能被删')
})

test('删除后同步清掉索引里的幽灵条目', async () => {
    const dir = makeCache('case2')
    const { indexManager } = await load()
    indexManager.discard('_open', 'cache')

    writeFile(path.join(dir, 'a.mp3'), 1024 * 1024, OLD)
    writeFile(path.join(dir, 'a.lrc'), 512, OLD)
    writeFile(path.join(dir, 'b.mp3'), 1024 * 1024, 0)
    fs.writeFileSync(path.join(dir, 'cache_index.json'), JSON.stringify({
        wy_a_flac: { id: 'wy_a', filename: 'a.mp3', quality: 'flac', hasLyric: true, lyricFilename: 'a.lrc' },
        wy_b_flac: { id: 'wy_b', filename: 'b.mp3', quality: 'flac' },
    }))

    await (await load()).checkAndCleanupCache()

    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'cache_index.json'), 'utf8'))
    assert.equal(idx.wy_a_flac, undefined, '被删文件对应的索引条目应移除')
    assert.ok(idx.wy_b_flac, '仍在磁盘上的文件索引应保留')
})

test('未超出配额时一个文件都不动', async () => {
    const dir = makeCache('case3')
    ;(global as any).lx.config['user.cacheSizeLimit'] = 100
    const { indexManager } = await load()
    indexManager.discard('_open', 'cache')

    writeFile(path.join(dir, 'old.mp3'), 1024 * 1024, OLD)
    fs.writeFileSync(path.join(dir, 'cache_index.json'), '{}')
    writeFile(path.join(dir, 'downloading.tmp'), 1024, 0)

    await (await load()).checkAndCleanupCache()

    assert.equal(fs.existsSync(path.join(dir, 'old.mp3')), true)
    assert.equal(fs.existsSync(path.join(dir, 'downloading.tmp')), true)
})
