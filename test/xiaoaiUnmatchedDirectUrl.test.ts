/**
 * 小爱「曲库未命中怎么投」配置项单测（2026-11-22）
 *
 * 由来（17950 实机）：曲库没收录《时间线-于冬然》时，按旧行为下发
 * defaultCoverAudioId 那首歌（当时被配成《所念皆星河》），触屏整屏显示
 * 《所念皆星河》，被当成「播错歌」——音频其实是这一路直链。
 *
 * 这里守三条：
 *   1) 缺省（含老配置）不动行为：unmatchedDirectUrl 必须为 false
 *   2) 显式开启能落盘、能读回
 *   3) 显式关闭能把开启状态改回来（不能只开不关）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// configFilePath() 走 global.lx.dataPath，指到临时目录，绝不写进仓库
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoai-cfg-'))
;(globalThis as any).lx = { dataPath: tmpDir }

import { configFilePath, loadConfig, saveConfig } from '../src/server/xiaoai/config'

test('缺省不改行为：未配置时 unmatchedDirectUrl 为 false', () => {
  const file = configFilePath()
  if (fs.existsSync(file)) fs.unlinkSync(file)
  assert.equal(loadConfig().unmatchedDirectUrl, false)
})

test('老配置文件（没有该字段）读出来仍是 false', () => {
  fs.writeFileSync(
    configFilePath(),
    JSON.stringify({ touchscreenLyrics: true, defaultCoverAudioId: '1674523777320369892' }, null, 2),
    'utf8',
  )
  const config = loadConfig()
  assert.equal(config.unmatchedDirectUrl, false)
  // 不误伤既有字段：兜底封面 ID 要原样读回
  assert.equal(config.defaultCoverAudioId, '1674523777320369892')
})

test('显式开启后落盘、并能读回 true', () => {
  saveConfig({ unmatchedDirectUrl: true })
  const onDisk = JSON.parse(fs.readFileSync(configFilePath(), 'utf8'))
  assert.equal(onDisk.unmatchedDirectUrl, true)
  assert.equal(loadConfig().unmatchedDirectUrl, true)
})

test('显式关闭能把开启状态改回来', () => {
  saveConfig({ unmatchedDirectUrl: false })
  assert.equal(loadConfig().unmatchedDirectUrl, false)
})

test('只认布尔真值：传字符串不会被误当成开启', () => {
  saveConfig({ unmatchedDirectUrl: 'true' as unknown as boolean })
  assert.equal(loadConfig().unmatchedDirectUrl, false)
})
