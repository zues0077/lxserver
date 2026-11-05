/**
 * 「降权观察」真的会影响换源顺序吗？—— 端到端（读 probe-status.json → 排序）的回归测试。
 *
 * 用户 2026-11-05 拍板：第一次取链失败只降权、第二次才关平台。
 * 单测 sourceProbeDemote 只覆盖状态机，这里补上**排序层**：降权必须真的把
 * 该「音源 × 平台」排到队尾，否则「降权」只是写进文件里的一句空话。
 */
import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { partitionByPlaySink } from '../src/server/userApi'
import { isPlatformDemoted } from '../src/server/sourceProbe'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-demote-'))
const g = global as any
g.lx = { ...(g.lx || {}), dataPath: tmp }

const HOUR = 3600_000

/** 写一份 probe-status.json（owner 唯一，避免踩 30 秒读缓存） */
const seed = (owner: string, sourceId: string, platform: string, ps: Record<string, any>) => {
  const dir = path.join(tmp, 'users', 'source', owner === 'open' ? '_open' : owner)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'probe-status.json')
  const status = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf-8'))
    : { version: 1, updatedAt: 0, sources: {} }
  status.sources[sourceId] = {
    name: sourceId,
    platforms: {
      [platform]: {
        status: 'unknown', failCount: 1, lastCheckAt: Date.now(), lastOkAt: 0,
        lastError: 'boom', autoDisabled: false, ...ps,
      },
    },
  }
  fs.writeFileSync(file, JSON.stringify(status), 'utf-8')
}

const api = (owner: string, id: string) => ({ info: { owner, id, name: id } })

test('降权中的源被排到队尾（fresh 在前、sunk 在后）', () => {
  seed('demote-a', 'srcA', 'tx', { demotedAt: Date.now() })
  const { fresh, sunk } = partitionByPlaySink([api('demote-a', 'srcA'), api('demote-a', 'srcB')], 'tx')
  assert.deepStrictEqual(sunk.map(a => a.info.id), ['srcA'])
  assert.deepStrictEqual(fresh.map(a => a.info.id), ['srcB'])
})

test('isPlatformDemoted 与排序一致：同一条记录两处口径必须相同', () => {
  seed('demote-b', 'srcA', 'tx', { demotedAt: Date.now() })
  assert.strictEqual(isPlatformDemoted('demote-b', 'srcA', 'tx'), true)
  assert.strictEqual(isPlatformDemoted('demote-b', 'srcA', 'wy'), false, '只对出问题的那个平台生效')
  assert.strictEqual(isPlatformDemoted('demote-b', 'srcB', 'tx'), false)
})

test('降权过期（超过 6 小时）后自动恢复原位', () => {
  seed('demote-c', 'srcA', 'tx', { demotedAt: Date.now() - 7 * HOUR })
  assert.strictEqual(isPlatformDemoted('demote-c', 'srcA', 'tx'), false)
  const { fresh, sunk } = partitionByPlaySink([api('demote-c', 'srcA'), api('demote-c', 'srcB')], 'tx')
  assert.strictEqual(sunk.length, 0)
  assert.strictEqual(fresh.length, 2)
})

test('没有降权标记 / 没建档的源一律不惩罚（缺失证据不能改变顺序）', () => {
  seed('demote-d', 'srcA', 'tx', { failCount: 3 })
  assert.strictEqual(isPlatformDemoted('demote-d', 'srcA', 'tx'), false)
  assert.strictEqual(isPlatformDemoted('demote-never-exists', 'srcA', 'tx'), false)
})

test('已关闭的平台不再重复降权（states.json 里本来就选不到它）', () => {
  seed('demote-e', 'srcA', 'tx', { autoDisabled: true, demotedAt: Date.now() })
  assert.strictEqual(isPlatformDemoted('demote-e', 'srcA', 'tx'), true, '历史标记仍可读')
  // 但状态机不会再给它新点亮降权（见 sourceProbeDemote 的「已关闭的平台不再参与降权」）
  const detail = partitionByPlaySink([api('demote-e', 'srcA'), api('demote-e', 'srcB')], 'tx')
  assert.strictEqual(detail.sunk.length, 1, '排序层只按标记走，是否可选用 states.json 判定')
})
