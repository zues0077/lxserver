/**
 * 用户输入路径的安全校验回归测试。
 *
 * 背景：2026-10-30 246 实测——对 `/proc/xxx` 同步 mkdir 会让进程进入不可中断等待，
 * HTTP 全挂、看门狗失效，只能重启容器。所以「黑名单必须先于任何文件系统操作」这条
 * 不变式必须有测试守住。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ensureWritableDir, isUnsafeFilesystemPath } from '../src/utils/fsSafePath'

const DATA_DIR = path.join(os.tmpdir(), 'lx-fs-safe-test')

test('虚拟 / 系统目录一律判为不安全', () => {
  for (const p of [
    '/proc',
    '/proc/1',
    '/proc/nope-lx',
    '/sys/kernel',
    '/dev/shm',
    '/run/lock',
    '/etc/passwd',
    '/usr/local/bin',
    '/bin/sh',
    '/lib64',
  ]) {
    assert.equal(isUnsafeFilesystemPath(p), true, `${p} 应判为不安全`)
  }
})

test('长得像但不是前缀的路径不受影响', () => {
  for (const p of [
    '/procdata/backup',   // /proc 后面直接跟字母，不是 /proc/
    '/system-backup',     // /sys 开头的其它名字
    '/development/music',
    '/vol1/1000/docker/lxserver-verify/data',
    '/server/data/backups',
    'relative/dir',
    './snapshots',
    '',
    'C:/proc/nope',       // Windows 盘符路径不能被当成 Unix 绝对路径
    'D:\\sys\\x',
  ]) {
    assert.equal(isUnsafeFilesystemPath(p), false, `${p} 不应判为不安全`)
  }
})

test('反斜杠与重复斜杠也按 Linux 绝对路径处理', () => {
  assert.equal(isUnsafeFilesystemPath('//proc//x'), true)
  assert.equal(isUnsafeFilesystemPath('/proc\\x'), true)
  assert.equal(isUnsafeFilesystemPath('/PROC/x'), true, '大小写混写也要拦住')
})

test('ensureWritableDir：黑名单路径直接抛错，不触达文件系统', () => {
  const started = Date.now()
  assert.rejects(
    () => ensureWritableDir('/proc/lx-should-not-hang', { baseDir: DATA_DIR, fieldName: '配置备份目录' }),
    /不能指向系统或虚拟目录/,
  )
  // 若这里真的去 mkdir 了，Linux 上会卡住；本断言在 Windows 上等价于「没有创建 C:\proc」
  assert.ok(Date.now() - started < 1500, '黑名单判定必须是纯字符串判断，不能有文件系统调用')
})

test('ensureWritableDir：非法字符直接拒绝', () => {
  assert.rejects(
    () => ensureWritableDir('bad<name', { baseDir: DATA_DIR, fieldName: '歌单快照备份路径' }),
    /包含非法字符/,
  )
})

test('ensureWritableDir：空值原样返回（表示用默认目录）', () => {
  return ensureWritableDir('   ', { baseDir: DATA_DIR, fieldName: '配置备份目录' }).then(v => {
    assert.equal(v, '')
  })
})

test('ensureWritableDir：相对路径按 baseDir 解析并自动创建', async () => {
  const rel = `lx-safe-${Date.now()}`
  const value = await ensureWritableDir(rel, { baseDir: DATA_DIR, fieldName: '配置备份目录' })
  assert.equal(value, rel, '返回值必须是用户原始输入，不能带 baseDir')
  assert.equal(fs.existsSync(path.join(DATA_DIR, rel)), true, '目录应已创建')
  fs.rmSync(path.join(DATA_DIR, rel), { recursive: true, force: true })
})

test('ensureWritableDir：绝对路径可正常创建', async () => {
  const abs = path.join(os.tmpdir(), `lx-safe-abs-${Date.now()}`)
  const value = await ensureWritableDir(abs, { baseDir: DATA_DIR, fieldName: '歌单快照备份路径' })
  assert.equal(value, abs)
  assert.equal(fs.existsSync(abs), true)
  fs.rmSync(abs, { recursive: true, force: true })
})

test('server.ts 里配置目录校验不再使用同步 mkdir', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/server/server.ts'), 'utf8')
  // 配置页那两处必须走 ensureWritableDir
  const backupBlock = src.slice(src.indexOf("newConfig['configBackup.dir'] !== undefined"), src.indexOf("newConfig['snapshot.backupPath'] !== undefined"))
  assert.match(backupBlock, /await ensureWritableDir\(/, '配置备份目录必须走异步校验')
  assert.doesNotMatch(backupBlock, /mkdirSync/, '配置备份目录不能再同步 mkdir')
  // 自定义音乐目录（同步上下文）至少要过黑名单
  const musicBlock = src.slice(src.indexOf('trimmedMusicDir'), src.indexOf('trimmedMusicDir') + 1200)
  assert.match(musicBlock, /isUnsafeFilesystemPath\(trimmedMusicDir\)/, '自定义音乐目录必须过黑名单')
})
