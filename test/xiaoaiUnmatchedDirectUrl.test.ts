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
import { isScreenDevice } from '../src/server/xiaoai/screen'

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

test('按型号智能选择：老配置缺省开启，带屏机型名单有默认值', () => {
  fs.writeFileSync(configFilePath(), JSON.stringify({ touchscreenLyrics: true }, null, 2), 'utf8')
  const config = loadConfig()
  assert.equal(config.unmatchedDirectByModel, true)
  assert.deepEqual(config.screenModels, ['LX04', 'X08A', 'X08E', 'X8F'])
})

test('按型号智能选择可以关掉，型号名单写入时统一转大写', () => {
  saveConfig({ unmatchedDirectByModel: false, screenModels: ['lx04', ' X08a '] })
  const config = loadConfig()
  assert.equal(config.unmatchedDirectByModel, false)
  assert.deepEqual(config.screenModels, ['LX04', 'X08A'])
})

test('只有显式 false 才关：字符串 false 不算关闭', () => {
  saveConfig({ unmatchedDirectByModel: 'false' as unknown as boolean })
  assert.equal(loadConfig().unmatchedDirectByModel, true)
})

test('带屏判定：型号命中、名称兜底、无屏机型不命中', () => {
  // 真机：LX04 = 泰禾世家小爱触屏音箱，X08A = 小爱触屏音箱 Pro8
  assert.equal(isScreenDevice('LX04', '泰禾世家小爱触屏音箱'), true)
  assert.equal(isScreenDevice('x08a', '任意名字'), true)
  // 型号名单里没有，但名字带「触屏」也要认
  assert.equal(isScreenDevice('LX99', '小爱触屏音箱'), true)
  // 无屏机型：小米AI音箱 S12 / 万能遥控版 LX05A / 小爱音箱Pro LX06
  assert.equal(isScreenDevice('S12', '小米AI音箱'), false)
  assert.equal(isScreenDevice('LX05A', '小爱音箱万能遥控版'), false)
  assert.equal(isScreenDevice('LX06', '小爱音箱Pro'), false)
  // 自定义名单覆盖内置
  assert.equal(isScreenDevice('LX06', '小爱音箱Pro', ['LX06']), true)
  // 空型号 + 空名字不炸
  assert.equal(isScreenDevice('', ''), false)
})
