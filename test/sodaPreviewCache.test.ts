import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

/**
 * 汽水「允许试听」三目录缓存单测（2026-11-13 方案）。
 * 核心断言：
 *  1. preview/ 目录与 cache/ / music/ 物理隔离（getCacheDir 映射正确）
 *  2. preview_index.json 与 cache_index.json / music_index.json 是三个独立文件
 *  3. 试听条目带 isPreview 标记，整曲缓存条目永远不会有它
 *  4. TTL 过期后查找返回 null 并清理文件
 * 不测 server.ts 的门禁分流（依赖取流探针），那条走实机验收。
 */

// fileCache 顶层会读 global.lx.dataPath（且 user/data 会往里写 serverInfo.json），
// 导入前必须先预置真实存在的临时目录，不碰真实数据（同 cacheQuotaScope.test.ts）
const TEST_DATA_PATH = path.join(os.tmpdir(), 'lx-soda-preview-test')
fs.mkdirSync(path.join(TEST_DATA_PATH, 'users'), { recursive: true })
;(global as any).lx = {
  dataPath: TEST_DATA_PATH,
  userPath: path.join(TEST_DATA_PATH, 'users'),
  config: {} as Record<string, any>,
}

const load = () => import('../src/server/fileCache.js')
let M: any = null
const mod = async () => { if (!M) M = await load(); return M }

test('getCacheDir: preview 与 cache/music 三目录物理隔离', async () => {
  const { getCacheDir } = await mod()
  const cacheDir = getCacheDir('u1', false)
  const musicDir = getCacheDir('u1', true)
  const previewDir = getCacheDir('u1', 'preview')
  assert.notEqual(previewDir, cacheDir)
  assert.notEqual(previewDir, musicDir)
  assert.ok(previewDir.includes(path.join('preview', 'u1')), previewDir)
  assert.ok(cacheDir.includes(path.join('cache', 'u1')), cacheDir)
  assert.ok(musicDir.includes(path.join('music', 'u1')), musicDir)
})

test('三份索引文件独立：preview_index.json 不污染 cache_index.json', async () => {
  const { getCacheDir, indexManager } = await mod()
  const previewDir = getCacheDir('u1', 'preview')
  const cacheDir = getCacheDir('u1', false)
  indexManager.update('u1', {
    id: 'song1', name: '试听曲', singer: 'a', album: '', source: 'soda',
    quality: '128k', filename: 'p1.m4a', folder: 'preview', mtime: Date.now(),
    size: 1, ext: 'm4a', isPreview: true, previewDurationSec: 30,
  } as any, 'preview')
  indexManager.update('u1', {
    id: 'song1', name: '整曲', singer: 'a', album: '', source: 'soda',
    quality: '128k', filename: 'c1.mp3', folder: 'cache', mtime: Date.now(),
    size: 2, ext: 'mp3',
  } as any, 'cache')

  assert.ok(fs.existsSync(path.join(previewDir, 'preview_index.json')))
  assert.ok(fs.existsSync(path.join(cacheDir, 'cache_index.json')))
  const previewIdx = JSON.parse(fs.readFileSync(path.join(previewDir, 'preview_index.json'), 'utf-8'))
  const cacheIdx = JSON.parse(fs.readFileSync(path.join(cacheDir, 'cache_index.json'), 'utf-8'))
  // 同曲同音质在两份索引里是两条独立条目
  assert.equal(previewIdx['song1_128k'].isPreview, true)
  assert.equal(cacheIdx['song1_128k'].isPreview, undefined)
  assert.equal(previewIdx['song1_128k'].previewDurationSec, 30)
})

test('getPreviewCacheItem：TTL 过期返回 null 且文件与索引被清理', async () => {
  const { getCacheDir, indexManager, getPreviewCacheItem } = await mod()
  indexManager.update('u2', {
    id: 'song2', name: '过期曲', singer: 'b', album: '', source: 'soda',
    quality: '128k', filename: 'expired.m4a', folder: 'preview', mtime: Date.now() - 200 * 3600 * 1000,
    size: 1, ext: 'm4a', isPreview: true,
  } as any, 'preview')
  const dir = getCacheDir('u2', 'preview')
  fs.writeFileSync(path.join(dir, 'expired.m4a'), 'fake')
  ;(global as any).lx.config['soda.previewTtlHours'] = 168

  const hit = getPreviewCacheItem('u2', { songmid: 'song2' }, '128k')
  assert.equal(hit, null, '过期条目应返回 null')
  assert.equal(fs.existsSync(path.join(dir, 'expired.m4a')), false, '过期文件应被删除')
  assert.equal(indexManager.get('u2', 'song2', 'preview'), undefined, '过期索引应被清理')
})

test('TTL 内的试听条目正常返回且带 isPreview 标记', async () => {
  const { getCacheDir, indexManager, getPreviewCacheItem } = await mod()
  indexManager.update('u3', {
    id: 'song3', name: '新鲜曲', singer: 'c', album: '', source: 'soda',
    quality: '320k', filename: 'fresh.m4a', folder: 'preview', mtime: Date.now(),
    size: 1, ext: 'm4a', isPreview: true, previewDurationSec: 60,
  } as any, 'preview')
  const dir = getCacheDir('u3', 'preview')
  fs.writeFileSync(path.join(dir, 'fresh.m4a'), 'fake')
  ;(global as any).lx.config['soda.previewTtlHours'] = 168

  const item = getPreviewCacheItem('u3', { songmid: 'song3' }, '320k')
  assert.ok(item, 'TTL 内应命中')
  assert.equal(item!.isPreview, true)
  assert.equal(item!.previewDurationSec, 60)
})

test('clearPreviewCacheForSong：整曲可用时清掉同曲全部试听记录', async () => {
  const { getCacheDir, indexManager, clearPreviewCacheForSong } = await mod()
  indexManager.update('u4', {
    id: 'song4', name: '曲4', singer: 'd', album: '', source: 'soda',
    quality: '128k', filename: 's4.m4a', folder: 'preview', mtime: Date.now(),
    size: 1, ext: 'm4a', isPreview: true,
  } as any, 'preview')
  const dir = getCacheDir('u4', 'preview')
  fs.writeFileSync(path.join(dir, 's4.m4a'), 'fake')

  const removed = clearPreviewCacheForSong('u4', 'song4')
  assert.equal(removed, true)
  assert.equal(fs.existsSync(path.join(dir, 's4.m4a')), false)
  assert.equal(indexManager.get('u4', 'song4', 'preview'), undefined)
})

test('配置开关缺省值：previewCacheEnabled 默认 false（保持现行为）', async () => {
  const { previewCacheEnabled } = await mod()
  ;(global as any).lx.config['soda.allowPreview'] = undefined
  assert.equal(previewCacheEnabled(), false)
  ;(global as any).lx.config['soda.allowPreview'] = true
  assert.equal(previewCacheEnabled(), true)
})
