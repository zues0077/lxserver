import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

// 2026-11-01 用户反馈两件事：
//   1) 每次打开 lx-music 都会「弹到关于」，而设置里选的是进入搜索；
//   2) 关于页的版本号与「检查更新」跟着上游仓库走，要改成我们自己的仓库。
// 这两条其实是同一条链：本 fork 版本线是 1.5.x，上游是 2.x，
// 在线检查永远认为我们过期 → 每次打开都弹「发现新版本 v2.x」并给出上游下载链接。
// 这里守住三件事：默认入口白名单、版本线只认本地文件、通知文件不再有误报条目。

const repoRoot = path.resolve(import.meta.dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8')
const readJson = (p: string) => JSON.parse(read(p))

// ---- 与 public/music/app.js 保持同构的默认入口白名单 ----
const VALID_ENTRY_TABS = ['search', 'songlist', 'leaderboard', 'favorites', 'localmusic']
function resolveDefaultTab(raw: unknown): string {
  const tab = String(raw ?? '').trim()
  return VALID_ENTRY_TABS.includes(tab) ? tab : 'search'
}

// ---- 与 public/js/notification-engine.js 保持同构的版本比较与弹窗判定 ----
function compareVersions(local: string, remote: string): number {
  if (!local || !remote) return 0
  const v1 = local.replace(/^v/, '').split('.').map(Number)
  const v2 = remote.replace(/^v/, '').split('.').map(Number)
  const len = Math.max(v1.length, v2.length)
  for (let i = 0; i < len; i++) {
    const n1 = v1[i] || 0
    const n2 = v2[i] || 0
    if (n1 < n2) return -1
    if (n1 > n2) return 1
  }
  return 0
}
function shouldPromptVersion(currentVer: string, target: string): boolean {
  // processItem 里 operator '<' 的判定：当前版本已达标就不弹
  return compareVersions(currentVer, target) < 0
}

test('默认入口：非法值（含历史残留 about）一律回落 search', () => {
  assert.strictEqual(resolveDefaultTab('about'), 'search', 'about 不是合法入口，必须回落')
  assert.strictEqual(resolveDefaultTab(''), 'search')
  assert.strictEqual(resolveDefaultTab(undefined), 'search')
  assert.strictEqual(resolveDefaultTab('favorites'), 'favorites')
  assert.strictEqual(resolveDefaultTab('localmusic'), 'localmusic')
  assert.strictEqual(resolveDefaultTab(' search '), 'search', '两端空白要能容忍')
})

test('app.js 里确实有白名单兜底，且不再是裸 settings.defaultEntry', () => {
  const src = read('public/music/app.js')
  assert.match(src, /VALID_ENTRY_TABS/, '缺少入口白名单常量')
  assert.match(src, /if \(!VALID_ENTRY_TABS\.includes\(defaultTab\)\)/, '缺少非法值回落判断')
  assert.doesNotMatch(
    src,
    /const defaultTab = settings\.defaultEntry \|\| 'favorites'/,
    '旧的裸取值写法会把脏数据直接当 tab 用',
  )
})

test('版本线：latest.json 版本与当前一致时不得弹更新', () => {
  const latest = readJson('notice/latest.json')
  const current = read('public/js/config.js').match(/version:\s*'([^']+)'/)?.[1]
  assert.ok(current, 'config.js 里应能读到当前版本')
  assert.strictEqual(latest.version, current, 'notice/latest.json 应与 config.js 版本一致（发版由 set-version.js 同步）')
  assert.strictEqual(shouldPromptVersion(current!, latest.version), false, '同版本不应弹「发现新版本」')
})

test('版本线：只有目标版本更高时才提示，且 1.5.50 不被 1.5.5 误判', () => {
  assert.strictEqual(shouldPromptVersion('v1.5.50', 'v1.5.51'), true)
  assert.strictEqual(shouldPromptVersion('v1.5.50', 'v1.5.5'), false, '1.5.50 高于 1.5.5，不能按字符串比较误报')
  assert.strictEqual(shouldPromptVersion('v1.5.50', 'v2.1.5'), true, '上游号更高时算法上仍会提示（所以必须切断在线源）')
})

test('检查更新只认本地源：checkUpdates 有本地源就直接返回，不回落在线', () => {
  const src = read('public/js/notification-engine.js')
  const body = src.slice(src.indexOf('async function checkUpdates'))
  const head = body.slice(0, 1200)
  assert.match(head, /loadForkLocalPayloads/, 'checkUpdates 应改用本地源加载')
  assert.match(head, /if \(local\.available\)[\s\S]{0,200}return/, '本地源可用时必须直接返回，禁止走 PostHog')
  assert.match(src, /notice\/latest\.json/, '应读取本仓库的版本线文件')
  assert.match(src, /zues0077\/lxserver/, '更新链接应指向本仓库')
})

test('通知文件里不再有会误报的 active 版本条目', () => {
  const notices = readJson('notice/notification.json')
  const activeVersions = (Array.isArray(notices) ? notices : [])
    .filter((it: any) => it && it.type === 'version' && it.status === 'active')
  assert.deepStrictEqual(activeVersions, [], '历史版本通知应全部归档，避免恢复旧镜像时再次误弹')
})

test('镜像会把 notice/ 复制进 public，版本线文件必须在其中', () => {
  const dockerfile = read('Dockerfile')
  assert.match(dockerfile, /cp -r notice build-output\/public\/notice/, 'Dockerfile 需继续复制 notice 目录')
  assert.ok(fs.existsSync(path.join(repoRoot, 'notice/latest.json')), 'notice/latest.json 必须存在')
})
