import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  badTrackKey,
  noteBadTrack,
  peekBadTrack,
  clearBadTrack,
  badTrackLedgerSize,
} from '../src/server/xiaoai/badTrackLedger'

// 每个用例独立的临时文件，避免 LRU/清理逻辑互相干扰
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'badtrack-'))
const makeFile = (dir: string) => {
  const p = path.join(dir, 'bad.m4a')
  fs.writeFileSync(p, 'x'.repeat(1024))
  return p
}

test('键生成：ID 优先，无 ID 退化到名字，音质参与区分', () => {
  const k1 = badTrackKey({ source: 'soda', songmid: '123' }, '320k')
  assert.strictEqual(k1, 'soda:123:320k')
  const k2 = badTrackKey({ source: 'soda', name: '海阔天空' }, '320k')
  assert.strictEqual(k2, 'soda:name:海阔天空:320k'.replace('name:', 'name:'))
  assert.ok(k2.startsWith('soda:name:'))
  const k3 = badTrackKey({ source: 'soda', songmid: '123' }, '128k')
  assert.notStrictEqual(k1, k3)
  const k4 = badTrackKey({ source: '', name: 'x' }, '320k')
  assert.strictEqual(k4, '')
})

test('记账后命中：返回原路径与 via', () => {
  const dir = tmpDir()
  const song = { source: 'soda', songmid: 'bt-1', name: '坏曲' }
  noteBadTrack(song, '320k', makeFile(dir), '先缓存后投送（汽水音乐（账号））｜转码失败-原格式')
  const hit = peekBadTrack(song, '320k')
  assert.ok(hit)
  assert.ok(hit.filePath.endsWith('bad.m4a'))
  assert.ok(hit.via.includes('汽水'))
})

test('不同音质互不命中', () => {
  const dir = tmpDir()
  const song = { source: 'soda', songmid: 'bt-2' }
  noteBadTrack(song, '320k', makeFile(dir), '原格式')
  assert.strictEqual(peekBadTrack(song, '128k'), null)
})

test('文件被清理后清账返回 null（LRU 失效路径）', () => {
  const dir = tmpDir()
  const p = makeFile(dir)
  const song = { source: 'soda', songmid: 'bt-3' }
  noteBadTrack(song, '320k', p, '原格式')
  assert.ok(peekBadTrack(song, '320k'))
  fs.unlinkSync(p)
  // 文件不在 → 清账返回 null；连续 peek 也 null（条目已删，不是每次现判）
  assert.strictEqual(peekBadTrack(song, '320k'), null)
  assert.strictEqual(peekBadTrack(song, '320k'), null)
})

test('clearBadTrack 主动清账', () => {
  const dir = tmpDir()
  const song = { source: 'bili', songmid: 'bt-4' }
  noteBadTrack(song, '128k', makeFile(dir), '原格式')
  clearBadTrack(song, '128k')
  assert.strictEqual(peekBadTrack(song, '128k'), null)
})

test('无效入参不记账', () => {
  const before = badTrackLedgerSize()
  noteBadTrack({ source: 'soda' }, '320k', '', '原格式')
  noteBadTrack({}, '320k', '/tmp/x.m4a', '原格式')
  assert.strictEqual(badTrackLedgerSize(), before)
})
