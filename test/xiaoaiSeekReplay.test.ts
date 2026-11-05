import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * 拖动进度条后的「等换流」判定（2026-11-05）。
 *
 * 现象：拖到某处后页面进度直接跑到曲尾卡死，音箱其实在正常播（甚至从 0 秒播）。
 * 根因有两层：
 *  1. 服务端可能把目标改小（残留守卫 / 贴尾夹取），前端 `Number(seekSec) || sec`
 *     把「明确的 0」当假值退回请求值，时间轴偏移多算一整段；
 *  2. 设备换流前仍在上报上一条流的流内位置，被当成锚点后算成「目标 + 旧位置」。
 *
 * 这里只测第 2 层的判定函数（第 1 层在 xiaoaiSeekGuard.test.ts）。
 */
const root = path.resolve(import.meta.dirname, '..')
const src = fs.readFileSync(path.join(root, 'public/music/js/xiaoai.js'), 'utf8')

const winMatched = /const SEEK_REPLAY_WINDOW_MS = (\d+);/.exec(src)
assert.ok(winMatched, 'SEEK_REPLAY_WINDOW_MS 没找到')
const SEEK_REPLAY_WINDOW_MS = Number(winMatched[1])

const fnStart = src.indexOf('const judgeAnchorSample = (')
const fnEnd = src.indexOf('\n    };', fnStart)
assert.ok(fnStart >= 0 && fnEnd > fnStart, 'judgeAnchorSample 切片没找到')
const fnSrc = src.slice(fnStart, fnEnd + '\n    };'.length)

const run = (positionMs: number, awaitReplayAt: number, seekBaseDevicePos: number, now: number) => {
  const sandbox: any = { SEEK_REPLAY_WINDOW_MS }
  vm.createContext(sandbox)
  // 去掉 `const judgeAnchorSample = ` 前缀与结尾分号，得到可直接调用的箭头函数
  const body = fnSrc.replace(/^const judgeAnchorSample = /, '')
  const call = vm.runInContext(`(${body.slice(0, -1)})`, sandbox)
  return call(positionMs, awaitReplayAt, seekBaseDevicePos, now)
}

const NOW = 1_700_000_000_000

test('没拖动过（awaitReplayAt=0）→ 直接接受设备位置', () => {
  assert.equal(run(60_000, 0, 0, NOW), 'accept')
})

test('拖动后设备仍报上一条流的 225 秒 → 必须丢弃（否则进度条冲到曲尾）', () => {
  assert.equal(run(225_000, NOW - 5_000, 225_000, NOW), 'wait')
})

test('拖动后设备报 2 秒（新流刚起播）→ 接受', () => {
  assert.equal(run(2_000, NOW - 5_000, 225_000, NOW), 'accept')
})

test('拖动后位置明显小于拖动前 → 判定换流完成，接受', () => {
  assert.equal(run(10_000, NOW - 6_000, 225_000, NOW), 'accept')
})

test('拖动前设备位置是 0（刚开始播）→ 新流位置 500 也接受', () => {
  assert.equal(run(500, NOW - 4_000, 0, NOW), 'accept')
})

test('等换流超时（超过窗口）→ 不再拦，放行', () => {
  assert.equal(run(225_000, NOW - SEEK_REPLAY_WINDOW_MS - 1_000, 225_000, NOW), 'expired')
})

// ---- 服务端 seekSec 归一化（前端真代码）----

const normStart = src.indexOf('const normalizeSeekSec = (')
const normEnd = src.indexOf('\n    };', normStart)
assert.ok(normStart >= 0 && normEnd > normStart, 'normalizeSeekSec 切片没找到')

const normalize = (serverSeekSec: unknown, requestedSec: number) => {
  const sandbox: any = {}
  vm.createContext(sandbox)
  const body = src.slice(normStart, normEnd + '\n    };'.length).replace(/^const normalizeSeekSec = /, '')
  const call = vm.runInContext(`(${body.slice(0, -1)})`, sandbox)
  return call(serverSeekSec, requestedSec)
}

test('服务端明确回 0（回到开头）→ 偏移必须是 0，不能退回请求的 100', () => {
  assert.equal(normalize(0, 100), 0)
})

test('服务端回 85 → 用 85', () => {
  assert.equal(normalize(85, 100), 85)
})

test('字段缺失才退回请求值（null/undefined/空串）', () => {
  assert.equal(normalize(undefined, 100), 100)
  assert.equal(normalize(null, 100), 100)
  assert.equal(normalize('', 100), 100)
  assert.equal(normalize('abc', 100), 100)
})

test('服务端与请求都无效 → 0', () => {
  assert.equal(normalize(undefined, 0), 0)
  assert.equal(normalize(Number.NaN, -5), 0)
})
