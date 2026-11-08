import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWED_REMOTE_ACTIONS,
  LX_STANDARD_QUALITIES,
  inspectSourceContract,
  prioritizeContractIssues,
  summarizeContract,
  summarizeContractByCode,
  unwrapMusicUrlValue,
} from '../src/server/sourceContract'

const codes = (r: ReturnType<typeof inspectSourceContract>) => r.issues.map(i => `${i.platform}:${i.code}`)

test('合规声明：单平台 musicUrl + 标准档，无任何问题', () => {
  const r = inspectSourceContract({
    kw: { name: '酷我', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
  })
  assert.strictEqual(r.compliant, true)
  assert.strictEqual(r.platformCount, 1)
  assert.deepStrictEqual(r.issues, [])
  assert.deepStrictEqual(r.platforms.kw, { actions: ['musicUrl'], qualities: ['128k', '320k', 'flac'], ok: true })
})

test('多平台混合：任一平台合规即视为该平台 ok，整体看 error 数', () => {
  const r = inspectSourceContract({
    kw: { name: '酷我', actions: ['musicUrl'], qualitys: ['128k'] },
    tx: { name: 'QQ', actions: ['musicUrl', 'lyric'], qualitys: ['320k'] },
  })
  assert.strictEqual(r.compliant, false)
  assert.deepStrictEqual(codes(r), ['tx:unsupported_actions'])
  assert.strictEqual(r.platforms.kw.ok, true)
  assert.strictEqual(r.platforms.tx.ok, false)
})

test('actions 多声明是 error（豆包音源禁用根因）', () => {
  const r = inspectSourceContract({
    kw: { name: 'x', actions: ['musicUrl', 'lyric', 'pic', 'search'], qualitys: ['128k'] },
  })
  const hit = r.issues.find(i => i.code === 'unsupported_actions')
  assert.ok(hit)
  assert.strictEqual(hit!.severity, 'error')
  assert.match(hit!.detail, /lyric/)
  assert.match(hit!.detail, /pic/)
  assert.strictEqual(r.compliant, false)
})

test('actions 空数组：没有 musicUrl 是 error 而非 warn', () => {
  const r = inspectSourceContract({ kw: { name: 'x', actions: [], qualitys: ['128k'] } })
  assert.ok(codes(r).includes('kw:music_url_not_declared'))
  assert.strictEqual(r.issues.find(i => i.code === 'music_url_not_declared')!.severity, 'error')
  assert.strictEqual(r.compliant, false)
})

test('actions 缺失：只 warn，按「仅提供 musicUrl」容忍', () => {
  const r = inspectSourceContract({ kw: { name: 'x', qualitys: ['128k'] } })
  assert.ok(codes(r).includes('kw:actions_missing'))
  assert.strictEqual(r.compliant, true)
})

test('actions 不是数组：error', () => {
  const r = inspectSourceContract({ kw: { name: 'x', actions: 'musicUrl', qualitys: ['128k'] } })
  assert.ok(codes(r).includes('kw:actions_not_array'))
  assert.strictEqual(r.compliant, false)
})

test('local 平台整体跳过 actions/qualitys 校验', () => {
  const r = inspectSourceContract({
    local: { name: '本地', actions: ['musicUrl', 'lyric'], qualitys: [] },
  })
  assert.strictEqual(r.compliant, true)
  assert.deepStrictEqual(codes(r), ['local:local_platform_skipped'])
  assert.strictEqual(r.platforms.local.ok, true)
})

test('未知音质档只 warn，源仍可用', () => {
  const r = inspectSourceContract({
    kw: { name: 'x', actions: ['musicUrl'], qualitys: ['128k', '192k', '999k'] },
  })
  const hit = r.issues.find(i => i.code === 'unknown_quality')
  assert.ok(hit)
  assert.strictEqual(hit!.severity, 'warn')
  assert.match(hit!.detail, /192k/)
  assert.strictEqual(r.compliant, true)
})

test('qualitys 空数组：该平台一档都不给，客户端不会取链 → error', () => {
  const r = inspectSourceContract({ kw: { name: 'x', actions: ['musicUrl'], qualitys: [] } })
  const hit = r.issues.find(i => i.code === 'qualitys_empty')
  assert.ok(hit)
  assert.strictEqual(hit!.severity, 'error')
  assert.ok(codes(r).includes('kw:qualitys_empty'))
  assert.strictEqual(r.compliant, false)
  // 平台级 ok 也要落下来：面板据此把该平台标成不可用
  assert.strictEqual((r as any).platforms?.kw?.ok, false)
})

test('qualitys 空数组与「未声明 qualitys」不是一回事：后者仍只是 warn', () => {
  const declared = inspectSourceContract({ kw: { name: 'x', actions: ['musicUrl'] } })
  assert.ok(codes(declared).includes('kw:qualitys_missing'))
  assert.strictEqual(declared.compliant, true)
})

test('name 缺失 / type 非 music 都只是 warn', () => {
  const r = inspectSourceContract({ kw: { actions: ['musicUrl'], qualitys: ['128k'], type: 'radio' } })
  assert.ok(codes(r).includes('kw:name_missing'))
  assert.ok(codes(r).includes('kw:type_not_music'))
  assert.strictEqual(r.compliant, true)
})

test('sources 非对象 / 空对象 都是 error', () => {
  assert.strictEqual(inspectSourceContract(null).compliant, false)
  assert.deepStrictEqual(codes(inspectSourceContract(null)), [':sources_invalid'])
  assert.ok(codes(inspectSourceContract([1, 2])).includes(':sources_invalid'))
  assert.deepStrictEqual(codes(inspectSourceContract({})), [':sources_empty'])
})

test('平台值不是对象：记 error 且该平台 ok=false', () => {
  const r = inspectSourceContract({ kw: 'oops' })
  assert.ok(codes(r).includes('kw:source_not_object'))
  assert.strictEqual(r.platforms.kw.ok, false)
  assert.strictEqual(r.compliant, false)
})

test('counts 与实际 issue 数一致', () => {
  const r = inspectSourceContract({
    kw: { actions: ['musicUrl', 'lyric'], qualitys: ['192k'] },
    tx: { name: 'qq', qualitys: 'x' },
  })
  assert.strictEqual(r.counts.error, r.issues.filter(i => i.severity === 'error').length)
  assert.strictEqual(r.counts.warn, r.issues.filter(i => i.severity === 'warn').length)
  assert.ok(r.counts.error >= 1 && r.counts.warn >= 1)
})

test('summarizeContract：无问题返回空串，有问题按 平台:码 拼接且跳过 info', () => {
  assert.strictEqual(summarizeContract(inspectSourceContract({
    kw: { name: 'x', actions: ['musicUrl'], qualitys: ['128k'] },
  })), '')
  const s = summarizeContract(inspectSourceContract({
    kw: { name: 'x', actions: ['musicUrl', 'lyric'], qualitys: ['192k'] },
  }))
  assert.match(s, /kw:unsupported_actions/)
  assert.match(s, /kw:unknown_quality/)
})

test('常量表与宿主一致（防止有人顺手放宽）', () => {
  assert.deepStrictEqual([...ALLOWED_REMOTE_ACTIONS], ['musicUrl'])
  assert.deepStrictEqual([...LX_STANDARD_QUALITIES], ['128k', '320k', 'flac', 'flac24bit'])
})

// ==================== 运行时降级解包 ====================

test('字符串直接可用，不算解包', () => {
  assert.deepStrictEqual(unwrapMusicUrlValue('https://a/b.mp3'), {
    url: 'https://a/b.mp3', path: '', fromObject: false,
  })
  assert.deepStrictEqual(unwrapMusicUrlValue('  https://a/b.mp3  '), {
    url: 'https://a/b.mp3', path: '', fromObject: false,
  })
})

test('对象里认 url / musicUrl / link 三个字段', () => {
  const want = (path: string) => ({ url: 'https://a/x.mp3', path, fromObject: true })
  assert.deepStrictEqual(unwrapMusicUrlValue({ url: 'https://a/x.mp3' }), want('url'))
  assert.deepStrictEqual(unwrapMusicUrlValue({ musicUrl: 'https://a/x.mp3' }), want('musicUrl'))
  assert.deepStrictEqual(unwrapMusicUrlValue({ link: 'https://a/x.mp3' }), want('link'))
})

test('嵌套一层：data.url / result.url', () => {
  assert.deepStrictEqual(unwrapMusicUrlValue({ data: { url: 'https://a/x.mp3' } }),
    { url: 'https://a/x.mp3', path: 'data.url', fromObject: true })
  assert.deepStrictEqual(unwrapMusicUrlValue({ result: { musicUrl: 'https://a/x.mp3' } }),
    { url: 'https://a/x.mp3', path: 'result.musicUrl', fromObject: true })
})

test('认不出就返回 null（不瞎猜业务对象）', () => {
  assert.strictEqual(unwrapMusicUrlValue({ code: 0, msg: 'ok' }), null)
  assert.strictEqual(unwrapMusicUrlValue({ url: 'not-a-url' }), null)
  assert.strictEqual(unwrapMusicUrlValue({ url: '' }), null)
  assert.strictEqual(unwrapMusicUrlValue({ url: '/relative/path.mp3' }), null)
  assert.strictEqual(unwrapMusicUrlValue(null), null)
  assert.strictEqual(unwrapMusicUrlValue(undefined), null)
  assert.strictEqual(unwrapMusicUrlValue(123), null)
  assert.strictEqual(unwrapMusicUrlValue('ftp://a/b.mp3'), null)
})

test('只用 http/https，大小写不敏感', () => {
  assert.strictEqual(unwrapMusicUrlValue({ url: 'HTTPS://A/B.MP3' })!.url, 'HTTPS://A/B.MP3')
  assert.deepStrictEqual(unwrapMusicUrlValue('HTTP://a/b'), { url: 'HTTP://a/b', path: '', fromObject: false })
})

// ---------------- 展示截断：必须先按严重程度排序 ----------------
// 面板只给前几条，若按声明顺序切，一个平台的多条 warn 会把 error 挤掉 ——
// 用户看到「契约 5 项」却全是可忽略的提示，等于没提示。

test('prioritizeContractIssues：error 永远排在 warn 前面，info 被丢弃', () => {
  const issues = [
    { platform: 'kg', code: 'name_missing', severity: 'warn' as const, detail: 'w1' },
    { platform: 'kg', code: 'unknown_quality', severity: 'warn' as const, detail: 'w2' },
    { platform: 'tx', code: 'local_platform_skipped', severity: 'info' as const, detail: 'i1' },
    { platform: 'wy', code: 'unsupported_actions', severity: 'error' as const, detail: 'e1' },
    { platform: 'mg', code: 'music_url_not_declared', severity: 'error' as const, detail: 'e2' },
  ]
  const got = prioritizeContractIssues(issues, 3)
  // 两个 error 先出（同级按平台名 mg < wy），后面的 warn 才轮到
  assert.deepStrictEqual(got.map(i => i.code), ['music_url_not_declared', 'unsupported_actions', 'name_missing'])
  // info 不参与展示（local 平台的说明性条目）
  assert.ok(got.every(i => i.severity !== 'info'))
})

test('prioritizeContractIssues：截断到 limit，且不改动入参数组', () => {
  const issues = Array.from({ length: 9 }, (_, i) => ({
    platform: 'p' + i, code: 'unsupported_actions', severity: 'error' as const, detail: 'd',
  }))
  const before = JSON.stringify(issues)
  assert.strictEqual(prioritizeContractIssues(issues, 6).length, 6)
  assert.strictEqual(JSON.stringify(issues), before)
  assert.strictEqual(prioritizeContractIssues(issues).length, 6)
  assert.strictEqual(prioritizeContractIssues([], 6).length, 0)
})

test('prioritizeContractIssues：同级别按平台名稳定排序', () => {
  const issues = [
    { platform: 'wy', code: 'unsupported_actions', severity: 'error' as const, detail: '' },
    { platform: 'kg', code: 'unsupported_actions', severity: 'error' as const, detail: '' },
  ]
  assert.deepStrictEqual(prioritizeContractIssues(issues, 6).map(i => i.platform), ['kg', 'wy'])
})

// ---------------- 按码计数（列表按源聚合的数据源） ----------------
// 列表接口的 issues 被截断到 6 条，前端要统计「哪些问题最多」必须有不受截断影响的真值。

test('summarizeContractByCode：error / warn 分开计数，info 丢弃', () => {
  const issues = [
    { platform: 'tx', code: 'unknown_quality', severity: 'warn' as const, detail: '' },
    { platform: 'wy', code: 'unknown_quality', severity: 'warn' as const, detail: '' },
    { platform: 'kg', code: 'unsupported_actions', severity: 'error' as const, detail: '' },
    { platform: 'local', code: 'local_platform_skipped', severity: 'info' as const, detail: '' },
  ]
  assert.deepStrictEqual(summarizeContractByCode(issues), {
    error: { unsupported_actions: 1 },
    warn: { unknown_quality: 2 },
  })
})

test('summarizeContractByCode：空报告返回空桶，且每次是新对象（不串味）', () => {
  const a = summarizeContractByCode([])
  const b = summarizeContractByCode([])
  assert.deepStrictEqual(a, { error: {}, warn: {} })
  assert.notStrictEqual(a, b)
  assert.notStrictEqual(a.warn, b.warn)
})

test('summarizeContractByCode：与 inspectSourceContract 的 counts 对得上', () => {
  const r = inspectSourceContract({
    tx: { name: 'QQ', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['320k', '192k'] },
    wy: { name: '网易', type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
  })
  const byCode = summarizeContractByCode(r.issues)
  const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)
  assert.strictEqual(sum(byCode.error), r.counts.error)
  assert.strictEqual(sum(byCode.warn), r.counts.warn)
})

// ---- qualitys 的对象式声明：官方协议允许 [{ type, label }]，不能按「空数组」误判 ----
// 实测反例「弥音」（39 个源里的 1 个）：声明的是 [{ type:'128k', label:'标准品质' }]，
// 脚本能正常出链、巡检 status=success，却被判 qualitys_empty error。
test('qualitys 用对象式 [{type,label}]：合规，档位取 type，不报空数组', () => {
  const r = inspectSourceContract({
    tx: { name: 'QQ', type: 'music', actions: ['musicUrl'], qualitys: [{ type: '128k', label: '标准品质' }] },
  })
  assert.strictEqual(r.compliant, true)
  assert.deepStrictEqual(codes(r), [])
  assert.deepStrictEqual(r.platforms.tx.qualities, ['128k'])
  assert.strictEqual(r.platforms.tx.ok, true)
})

test('qualitys 两种写法混用也能归一：字符串与对象各取一档', () => {
  const r = inspectSourceContract({
    kw: { name: '酷我', type: 'music', actions: ['musicUrl'], qualitys: ['320k', { type: 'flac', label: '无损' }] },
  })
  assert.deepStrictEqual(r.platforms.kw.qualities, ['320k', 'flac'])
  assert.ok(!codes(r).includes('kw:qualitys_invalid_item'))
})

test('qualitys 里既不是字符串也没有 type 的项才算坏项（warn，不升级 error）', () => {
  const r = inspectSourceContract({
    kw: { name: '酷我', type: 'music', actions: ['musicUrl'], qualitys: ['', { label: '无 type' }, '128k'] },
  })
  assert.strictEqual(r.platforms.kw.ok, true)
  assert.ok(codes(r).includes('kw:qualitys_invalid_item'))
  assert.ok(!codes(r).includes('kw:qualitys_empty'))
  assert.deepStrictEqual(r.platforms.kw.qualities, ['128k'])
})

test('真正的空数组仍然是 error（与对象式声明区分开）', () => {
  const r = inspectSourceContract({ kw: { name: '酷我', type: 'music', actions: ['musicUrl'], qualitys: [] } })
  assert.strictEqual(r.platforms.kw.ok, false)
  assert.ok(codes(r).includes('kw:qualitys_empty'))
})
