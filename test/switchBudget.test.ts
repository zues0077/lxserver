import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * 换源预算（switchToOtherSource 的总闸与单候选上限）。
 *
 * 背景：这段以前完全没有总闸，汽水《诀爱》强制现取实测 80.7 秒才返回 ——
 * 汽水本尊 1.4 秒就判失败，其余 74 秒全耗在把几十个自定义源串行问一遍。
 * 预算常量是读 env 的 IIFE，直接切片求值就能验；总闸是否真的套在候选上，
 * 用源码结构锁住（防止以后有人把手写循环改回裸 await）。
 */
const root = path.resolve(import.meta.dirname, '..')
const src = fs.readFileSync(path.join(root, 'src/server/server.ts'), 'utf8')

const cut = (from: string, to: string): string => {
  const start = src.indexOf(from)
  const end = src.indexOf(to, start + from.length)
  assert.ok(start >= 0, `切片起点没找到：${from}`)
  assert.ok(end > start, `切片终点没找到：${to}`)
  return src.slice(start, end)
}

/** 把两个预算常量的 IIFE 片段在给定 env 下求值 */
function evalBudgets(env: Record<string, string>) {
  const code = cut('const MUSIC_SWITCH_BUDGET_MS', 'const musicUrlFailures')
  const sandbox: any = { process: { env }, Number, Math, console }
  vm.createContext(sandbox)
  vm.runInContext(code + '\nthis.out = { total: MUSIC_SWITCH_BUDGET_MS, candidate: MUSIC_SWITCH_CANDIDATE_MS }', sandbox)
  return sandbox.out as { total: number; candidate: number }
}

test('换源预算：默认 12 秒总闸 / 5 秒单候选', () => {
  const b = evalBudgets({})
  assert.equal(b.total, 12000)
  assert.equal(b.candidate, 5000)
})

test('换源预算：环境变量可调，低于下限时回落到默认值', () => {
  assert.deepEqual(evalBudgets({ MUSIC_SWITCH_BUDGET_MS: '20000', MUSIC_SWITCH_CANDIDATE_MS: '8000' }),
    { total: 20000, candidate: 8000 })
  // 太小会把「本来能换到的歌」直接判死，必须被下限挡掉
  assert.deepEqual(evalBudgets({ MUSIC_SWITCH_BUDGET_MS: '500', MUSIC_SWITCH_CANDIDATE_MS: '100' }),
    { total: 12000, candidate: 5000 })
  // 非数字同理
  assert.deepEqual(evalBudgets({ MUSIC_SWITCH_BUDGET_MS: 'abc' }), { total: 12000, candidate: 5000 })
})

test('换源总闸：每个候选都套了硬预算，且整体有 deadline', () => {
  const body = cut('const switchToOtherSource = async (', 'const resolveServerSong = async (')

  assert.match(body, /const switchDeadline = Date\.now\(\) \+ MUSIC_SWITCH_BUDGET_MS/,
    '必须按 MUSIC_SWITCH_BUDGET_MS 建总体 deadline')
  assert.match(body, /MUSIC_SWITCH_CANDIDATE_MS/, '必须给单候选上限')
  assert.match(body, /withHardBudget\(\s*resolveSwitchCandidate/,
    '候选取链必须走 withHardBudget（裸 await 会让一个慢源吃掉整段预算）')
  // 不允许出现「直接 await resolveSwitchCandidate」的绕过写法
  assert.ok(!/await resolveSwitchCandidate\(/.test(body),
    'switchToOtherSource 里不能直接 await resolveSwitchCandidate，必须套预算')
  // 预算用尽要有可观测的日志，便于线上判断是「没源」还是「超时」
  assert.match(body, /预算 \$\{MUSIC_SWITCH_BUDGET_MS\}ms 用尽/)
})
