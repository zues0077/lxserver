import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * 投送模式进度条的「左右自己动」修复（2026-11-05）。
 *
 * 现象：小爱音箱正常出声，但页面进度条来回跳。根因是进度条同时混用两个基准：
 *  - watchdog 的墙钟（now - playingSince）
 *  - 设备每 3 秒上报的 positionMs
 * 校准值小于上一帧时就会被画回去，视觉上就是左右跳。
 *
 * 修法：以「设备位置 + 采样时刻」为锚点、帧间用墙钟补，且只前进不回退。
 * 这里按项目惯例（无构建步骤的前端）从真实源码切片 + vm 跑，不复制逻辑。
 */
const root = path.resolve(import.meta.dirname, '..')
const src = fs.readFileSync(path.join(root, 'public/music/js/xiaoai.js'), 'utf8')

const fnStart = src.indexOf('const progressSecNow = () => {')
const fnEnd = src.indexOf('\n    };', fnStart)
assert.ok(fnStart >= 0 && fnEnd > fnStart, 'progressSecNow 切片没找到')

const tickStart = src.indexOf('progressTicker = setInterval(() => {')
const tickBodyStart = src.indexOf('{', tickStart)
const tickBodyEnd = src.indexOf('}, 500);', tickBodyStart)
assert.ok(tickStart >= 0 && tickBodyEnd > tickBodyStart, 'progressTicker 切片没找到')

const progressFnSrc = src.slice(fnStart, fnEnd + '\n    };'.length)
const tickBodySrc = src.slice(tickBodyStart, tickBodyEnd + 1)

type Ctx = {
  state: { seekOffsetMs: number; target: string }
  watch: { active: boolean; paintFrozen: boolean; paintAnchorAt: number; paintAnchorPosMs: number; lastDeliveryAt: number }
  progressFloorSec: number
  elapsedMs: number
  totalMs: number
  painted: number[]
  now: number
}

const makeCtx = (): any => ({
  state: { seekOffsetMs: 0, target: 'xiaoai' },
  watch: { active: true, paintFrozen: false, paintAnchorAt: 0, paintAnchorPosMs: 0, lastDeliveryAt: 0 },
  progressFloorSec: 0,
  elapsedMs: 0,
  totalMs: 300_000,
  painted: [] as number[],
  now: 1_700_000_000_000,
})

const compile = (ctx: any) => {
  // 起播宽限期常量在切片之外，按源码实际值解析，避免测试与实现脱节
  const graceMatched = /const PROGRESS_START_GRACE_MS = (\d+);/.exec(src)
  assert.ok(graceMatched, 'PROGRESS_START_GRACE_MS 没找到')
  const sandbox: any = {
    console,
    Date: { now: () => ctx.now },
    state: ctx.state,
    watch: ctx.watch,
    progressFloorSec: ctx.progressFloorSec,
    PROGRESS_START_GRACE_MS: Number(graceMatched[1]),
    watchElapsedMs: () => ctx.elapsedMs,
    durationMs: () => ctx.totalMs,
    paintProgress: (sec: number) => ctx.painted.push(sec),
  }
  const fn = vm.runInNewContext(`${progressFnSrc}\n;progressSecNow`, sandbox)
  const tick = vm.runInNewContext(`(function () ${tickBodySrc})`, sandbox)
  // progressFloorSec 在 ticker 里会被赋值，必须回读 sandbox 上的值
  const readFloor = () => sandbox.progressFloorSec
  return { fn, tick, readFloor, sandbox }
}

test('有设备锚点时按「锚点位置 + 帧间墙钟」走', () => {
  const ctx = makeCtx()
  const { fn } = compile(ctx)
  ctx.watch.paintAnchorPosMs = 10_000
  ctx.watch.paintAnchorAt = ctx.now - 2_000
  assert.strictEqual(fn(), 12, '10s 锚点 + 2s 墙钟 = 12s')
})

test('拖动过（seekOffset 非 0）时设备流内位置要换算成曲内位置', () => {
  const ctx = makeCtx()
  const { fn } = compile(ctx)
  ctx.state.seekOffsetMs = 222_000
  ctx.watch.paintAnchorPosMs = 5_000
  ctx.watch.paintAnchorAt = ctx.now - 1_000
  assert.strictEqual(fn(), 228, '222s 偏移 + 5s 流内 + 1s = 228s')
})

test('设备明确没在播（冻结）时不跟墙钟走', () => {
  const ctx = makeCtx()
  const { fn, sandbox } = compile(ctx)
  sandbox.progressFloorSec = 42
  ctx.watch.paintFrozen = true
  ctx.elapsedMs = 99_000
  assert.strictEqual(fn(), 42, '冻结时停在已画到的位置')
})

test('没有设备锚点（设备不上报位置）时退回墙钟', () => {
  const ctx = makeCtx()
  const { fn } = compile(ctx)
  ctx.elapsedMs = 7_500
  assert.strictEqual(fn(), 7.5)
})

test('刚切歌的起播宽限期内，进度条不跟墙钟硬推（切歌后不再先跑偏）', () => {
  const ctx = makeCtx()
  const { fn, sandbox } = compile(ctx)
  sandbox.progressFloorSec = 0
  ctx.watch.lastDeliveryAt = ctx.now - 5_000
  ctx.elapsedMs = 5_000
  assert.strictEqual(fn(), 0, '设备还没上报位置，应先停在 0，而不是跑到 5 秒')
})

test('宽限期过后仍无位置（老固件）才退回墙钟', () => {
  const ctx = makeCtx()
  const { fn } = compile(ctx)
  ctx.watch.lastDeliveryAt = ctx.now - 20_000
  ctx.elapsedMs = 20_000
  assert.strictEqual(fn(), 20)
})

test('进度条只前进：校准值比上一帧小就不画', () => {
  const ctx = makeCtx()
  const { tick, sandbox } = compile(ctx)
  sandbox.progressFloorSec = 50
  ctx.watch.paintAnchorPosMs = 40_000
  ctx.watch.paintAnchorAt = ctx.now
  tick()
  assert.deepStrictEqual(ctx.painted, [], '40s < 50s，不能把进度条拉回去')
})

test('进度条前进时正常绘制并抬高守卫', () => {
  const ctx = makeCtx()
  const { tick, readFloor } = compile(ctx)
  ctx.watch.paintAnchorPosMs = 60_000
  ctx.watch.paintAnchorAt = ctx.now
  tick()
  assert.deepStrictEqual(ctx.painted, [60])
  assert.strictEqual(readFloor(), 60)
})

test('设备位置脏数据不会把进度条推过整首时长', () => {
  const ctx = makeCtx()
  const { tick } = compile(ctx)
  ctx.totalMs = 60_000
  ctx.watch.paintAnchorPosMs = 9_999_000
  ctx.watch.paintAnchorAt = ctx.now
  tick()
  assert.deepStrictEqual(ctx.painted, [60], '超过总时长要夹到曲尾')
})

test('不在投送目标 / 守望未激活时不画', () => {
  const ctx = makeCtx()
  const { tick } = compile(ctx)
  ctx.watch.paintAnchorPosMs = 60_000
  ctx.watch.paintAnchorAt = ctx.now
  ctx.state.target = 'local'
  tick()
  assert.deepStrictEqual(ctx.painted, [])
  ctx.state.target = 'xiaoai'
  ctx.watch.active = false
  tick()
  assert.deepStrictEqual(ctx.painted, [])
})

test('源码里进度条不再直接用墙钟基准（防回归）', () => {
  assert.ok(
    !/paintProgress\(\(Number\(state\.seekOffsetMs\) \|\| 0\) \/ 1000 \+ watchElapsedMs\(\) \/ 1000\)/.test(src),
    'ticker 必须走 progressSecNow，不能直接拼墙钟',
  )
  assert.ok(src.includes('progressFloorSec'), '单调守卫变量丢了')
})

test('app.js 的 timeupdate 在投送模式下不再抢画进度条', () => {
  const appSrc = fs.readFileSync(path.join(root, 'public/music/app.js'), 'utf8')
  const at = appSrc.indexOf("audio.addEventListener('timeupdate', () => {")
  assert.ok(at > 0, 'timeupdate 监听没找到')
  const head = appSrc.slice(at, at + 600)
  assert.ok(head.includes('isRoutingToXiaoAi()'), 'timeupdate 缺少投送模式守卫')
})
