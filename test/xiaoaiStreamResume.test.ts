import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { pumpDownstream } from '../src/server/xiaoai/stream'

/**
 * 纯内存版下游：pumpDownstream 只需要 write / end / drain / writableEnded / writableFinished。
 * 用真实 http 会因为「上游故意不 end」留下悬挂连接，测试收不了尾，所以这里不碰 socket。
 */
function makeRes(hold = false) {
  const chunks: Buffer[] = []
  let release: ((e?: Error | null) => void) | null = null
  const res = new Writable({
    highWaterMark: 512,
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      // hold = 模拟「音箱那头不读」：写回调一直不返回，res.write 之后恒为 false
      if (hold) release = cb
      else cb()
    },
  }) as any
  return {
    res,
    chunks,
    text: () => Buffer.concat(chunks),
    release: () => {
      const r = release
      release = null
      r?.()
    },
  }
}

/** 造一个「发够 n 字节后静默」的上游流（不 end，模拟回源被 CDN 卡死） */
function makeUpstream(total: number) {
  const up = new PassThrough() as any
  up.headers = { 'content-length': String(total), 'content-type': 'audio/mpeg' }
  return up
}

test('上游静默：reopen 续传后数据接上，总字节不重复不回退', async () => {
  const TOTAL = 200 * 1024
  const CUT = 80 * 1024
  process.env.XIAOAI_UPSTREAM_SILENCE_MS = '50'

  const up = makeUpstream(TOTAL)
  const { res, text } = makeRes()
  let reopenOffset = -1
  let reopenCalls = 0

  const done = pumpDownstream(up, res, 0, {
    reopen: async (offset: number) => {
      reopenCalls += 1
      reopenOffset = offset
      const next = makeUpstream(TOTAL)
      // 第二段：从 offset 续发到结尾，然后正常 end
      setImmediate(() => {
        next.write(Buffer.alloc(TOTAL - offset, 9))
        next.end()
      })
      return next as any
    },
  })

  up.write(Buffer.alloc(CUT, 7)) // 只发一段就静默
  const stats = await done
  const buf = text()

  console.log(`  reopen 次数=${reopenCalls} offset=${reopenOffset} 收到=${buf.length}B/期望=${TOTAL}B`)
  assert.equal(reopenCalls, 1, '应只续传一次')
  assert.equal(reopenOffset, CUT, '续传 offset 应等于已收到的字节数')
  assert.equal(buf.length, TOTAL, '续传后总字节应与上游整首一致')
  assert.equal(buf[0], 7, '开头来自第一段')
  assert.equal(buf[buf.length - 1], 9, '结尾来自续传段')
  assert.equal(stats.bytes, TOTAL)
})

test('上游静默但 reopen 不可用：不重试第二次、按原逻辑收尾', async () => {
  const TOTAL = 120 * 1024
  const CUT = 50 * 1024
  process.env.XIAOAI_UPSTREAM_SILENCE_MS = '50'

  const up = makeUpstream(TOTAL)
  const { res, text } = makeRes()
  let calls = 0

  const done = pumpDownstream(up, res, 0, {
    reopen: async () => {
      calls += 1
      return null // 源站不支持 Range
    },
  })

  up.write(Buffer.alloc(CUT, 7))
  const stats = await done
  console.log(`  reopen 次数=${calls} 收到=${text().length}B（首段 ${CUT}B）`)
  assert.equal(calls, 1, '不支持续传时只尝试一次就放弃')
  assert.equal(stats.bytes, CUT, '只拿到首段字节')
})

test('远端源：硬上限内设备不读只等不掐，超时才收尾（P-1117 核心）', async () => {
  const TOTAL = 100 * 1024
  process.env.XIAOAI_DOWNSTREAM_REMOTE_GIVEUP_MS = '600'
  const up = makeUpstream(TOTAL)
  const { res } = makeRes(true)
  let settled = false

  const p = pumpDownstream(up, res, 0, {})
  void p.then(() => {
    settled = true
  })
  // 必须分块写：单个大 chunk 会一次被写出、pendingBytes 归零，就进不了「设备不读」分支
  for (let i = 0; i < TOTAL; i += 4096) up.write(Buffer.alloc(Math.min(4096, TOTAL - i), 3))
  up.end() // 上游读完，剩余字节在内存队列，设备不读
  await new Promise(r => setTimeout(r, 300))
  assert.equal(settled, false, '硬上限内必须保持连接（原实现 3 分钟就掐断）')
  // monitor 是每秒巡检一次，硬上限 600ms 实际在第 1 次巡检（~1s）才生效
  await new Promise(r => setTimeout(r, 1500))
  assert.equal(settled, true, '超过硬上限应释放连接')
})

test('本地文件：设备不读也绝不掐断（回归 P-1110）', async () => {
  const TOTAL = 100 * 1024
  process.env.XIAOAI_DOWNSTREAM_REMOTE_GIVEUP_MS = '100'
  const up = makeUpstream(TOTAL)
  const { res } = makeRes(true) // 设备不读：写回调挂住
  let settled = false

  const p = pumpDownstream(up, res, 0, { isLocalFile: true })
  void p.then(() => {
    settled = true
  })
  for (let i = 0; i < TOTAL; i += 4096) up.write(Buffer.alloc(Math.min(4096, TOTAL - i), 3))
  up.end() // 上游读完，但下游（设备）不读
  await new Promise(r => setTimeout(r, 400))
  assert.equal(settled, false, '本地文件不应因为设备不读而提前 settle')
  res.destroy() // 设备断开
  await p
  assert.equal(settled, true, '设备断开后才收尾')
})
