/**
 * 后台「系统配置」页结构回归
 *
 * 背景：该页 2026-10-30 被从 CSS 多栏瀑布流改成「分组 → 卡片网格」，
 * 卡片被重排/拆分。页面靠 `form.elements[name]` 读写字段、靠若干固定 id 做联动，
 * 结构一旦漂移就会静默丢字段（保存后配置被写成 undefined）或联动失效。
 * 这里用静态断言守住三个不变量：
 *   1. 每个配置字段在 #config-form 内出现且仅出现一次；
 *   2. app.js 依赖的元素 id 全部存在；
 *   3. data-requires 指向的父开关真实存在；分组结构与 id 唯一。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')

function sliceBetween(source: string, startMark: string, endMark: string): string {
  const s = source.indexOf(startMark)
  const e = source.indexOf(endMark, s + startMark.length)
  assert.ok(s >= 0, `找不到起点标记：${startMark}`)
  assert.ok(e > s, `找不到终点标记：${endMark}`)
  return source.slice(s, e)
}

const configSection = sliceBetween(html, '<!-- 系统配置视图 -->', '<!-- WebDAV 同步与云端备份视图')
const formBlock = sliceBetween(configSection, '<form id="config-form"', '</form>')

/** 配置页必须保留的全部字段（server.ts 按 name 取值的契约） */
const REQUIRED_FIELDS = [
  'serverName', 'list.addMusicLocationType', 'log.level',
  'admin.path', 'player.path',
  'user.enablePath', 'user.enableRoot',
  'player.name', 'admin.password', 'player.enableAuth', 'player.password',
  'user.enablePublicRestriction', 'user.enablePublicNonAdminLocalMusic',
  'user.enablePublicNonAdminBrowserDownload', 'user.enablePublicNonAdminServerCache',
  'user.enablePublicFavorites', 'user.enablePublicNonAdminAccess',
  'user.enableLoginCacheRestriction', 'user.enableCacheSizeLimit',
  'user.cacheSizeLimit', 'cache.maxAgeDays',
  'user.enableCustomMusicDir',
  'maxSnapshotNum', 'snapshot.backupPath',
  'configBackup.enable', 'configBackup.retentionDays', 'configBackup.dir',
  'webdav.enable', 'webdav.url', 'webdav.username', 'webdav.password',
  'webdav.syncPath', 'webdav.backupPath', 'sync.interval', 'sync.backupInterval',
  'webdav.excludeCache', 'webdav.excludeMusic',
  'proxy.enabled', 'proxy.header',
  'proxy.all.enabled', 'proxy.all.address',
  'proxy.music.mode', 'proxy.music.address',
  'proxy.customSource.mode', 'proxy.customSource.address',
  'proxy.app.mode', 'proxy.app.address',
  'subsonic.enable', 'subsonic.path', 'subsonic.port',
  'subsonic.publicLeaderboards', 'subsonic.leaderboardSource',
  'subsonic.sharedListMode', 'subsonic.sharedListSort',
  'subsonic.onlineSearch', 'subsonic.onlineSearchMode', 'subsonic.onlineSearchSources',
  'subsonic.lyricTranslation', 'subsonic.cacheOnPlay', 'subsonic.playCacheFirst',
  'subsonic.dislikeRating', 'subsonic.linkRatingToDislike', 'subsonic.linkDislikeToRating',
  'subsonic.hideDisliked', 'subsonic.dislikeNoRecommend', 'subsonic.dislikeRequireSinger',
  'subsonic.dislikeNormalizeName', 'subsonic.dislikeCrossSource', 'subsonic.dislikeDuetMode',
  'subsonic.quality.enabled', 'subsonic.quality.priority', 'subsonic.quality.clientCapMode',
  'subsonic.source.priority', 'subsonic.source.crossPlatform', 'subsonic.source.autoSwitchCustom',
  'customSource.probe.enabled', 'customSource.probe.intervalMinutes',
  'customSource.probe.concurrency', 'customSource.probe.failThreshold',
  'customSource.probe.autoDisablePlatform', 'customSource.probe.autoRemoveSource',
  'customSource.probe.removeMode',
  'system.allowUnsafeVM', 'singer.sourcePriority',
]

/** app.js / 服务端联动依赖的元素 id */
const REQUIRED_IDS = [
  'config-form', 'config-subnav',
  'admin-path-input', 'player-path-input', 'path-conflict-error',
  'reload-config-btn',
  'config-js-path-ref', 'config-backup-js-path-ref',
  'proxy-all-address-field', 'proxy-music-address-field',
  'proxy-customSource-address-field', 'proxy-app-address-field',
  'test-proxy-btn',
  'public-non-admin-local-music-wrapper', 'public-non-admin-access-wrapper',
  'webdav-options', 'webdav-disabled-hint',
  'config-card-webdav', 'config-card-configbackup',
  'subsonic-standalone-toggle', 'subsonic-standalone-fields', 'subsonic-port-error',
  'subsonic-leaderboard-options',
  'tag-group-leaderboard-source', 'tag-group-shared-mode', 'tag-group-shared-sort',
  'tag-group-search-sources', 'tag-group-quality-priority', 'tag-group-source-priority',
]

function countField(block: string, name: string): number {
  const re = new RegExp(`name="${name.replace(/\./g, '\\.')}"`, 'g')
  return (block.match(re) || []).length
}

test('配置字段：每个字段都仍在表单内且只出现一次', () => {
  const missing = REQUIRED_FIELDS.filter(n => countField(formBlock, n) === 0)
  const duplicated = REQUIRED_FIELDS.filter(n => countField(formBlock, n) > 1)
  assert.deepEqual(missing, [], `表单内丢失字段：${missing.join(', ')}`)
  assert.deepEqual(duplicated, [], `表单内重复字段：${duplicated.join(', ')}`)
})

test('配置字段：没有多余的新字段混进契约', () => {
  const found = new Set([...formBlock.matchAll(/name="([^"]+)"/g)].map(m => m[1]))
  const extra = [...found].filter(n => !REQUIRED_FIELDS.includes(n))
  assert.deepEqual(extra, [], `出现未登记字段（若属新增功能请同步更新本测试）：${extra.join(', ')}`)
})

test('元素 id：app.js 依赖的 id 全部存在且全页唯一', () => {
  const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1])
  const dup = allIds.filter((id, i) => allIds.indexOf(id) !== i)
  assert.deepEqual([...new Set(dup)], [], `页面内 id 重复：${[...new Set(dup)].join(', ')}`)
  const missing = REQUIRED_IDS.filter(id => !allIds.includes(id))
  assert.deepEqual(missing, [], `缺少 id：${missing.join(', ')}`)
})

test('data-requires 必须指向表单内真实存在的开关', () => {
  const deps = [...formBlock.matchAll(/data-requires="([^"]+)"/g)].map(m => m[1])
  assert.ok(deps.length > 0, '没有任何 data-requires，联动样式可能已被删掉')
  const bad = deps.filter(dep => countField(formBlock, dep) === 0)
  assert.deepEqual(bad, [], `data-requires 指向了不存在的字段：${bad.join(', ')}`)
})

test('分组结构：每个分组都有标题、说明与至少一张卡片', () => {
  const groups = configSection.split('<section class="config-group"').slice(1)
  assert.ok(groups.length >= 6, `分组数量异常：${groups.length}`)
  groups.forEach((g, i) => {
    assert.match(g, /class="config-group-head"[\s\S]{0,400}?<h3>[^<]+<\/h3>/, `第 ${i + 1} 个分组缺少标题`)
    assert.match(g, /class="config-group-head"[\s\S]{0,600}?<p>[^<]+<\/p>/, `第 ${i + 1} 个分组缺少说明`)
    const cards = (g.match(/class="config-card glass/g) || []).length
    assert.ok(cards >= 1, `第 ${i + 1} 个分组没有卡片`)
  })
})

test('分组导航：每个导航项都能命中一个真实分组', () => {
  const subnav = sliceBetween(configSection, 'id="config-subnav"', '</div>')
  const targets = [...subnav.matchAll(/data-target="([^"]+)"/g)].map(m => m[1])
  assert.ok(targets.length >= 6, `导航项过少：${targets.length}`)
  const groupIds = [...configSection.matchAll(/<section class="config-group" id="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(targets, groupIds, '导航项与分组的顺序/id 不一致')
})

test('app.js：保存前必须拦住「两种连接方式都关闭」', () => {
  const saveBlock = sliceBetween(appJs, 'async saveConfig(', '// 路径校验')
  assert.match(saveBlock, /user\.enablePath/, '保存流程未读取 user.enablePath')
  assert.match(saveBlock, /user\.enableRoot/, '保存流程未读取 user.enableRoot')
  assert.match(saveBlock, /至少要开启一种/, '保存流程缺少「至少开启一种」的拦截')
  assert.match(saveBlock, /return/, '拦截后必须 return，否则仍会把非法配置提交给后端')
})

test('app.js：配置页 UI 初始化入口已被调用', () => {
  assert.match(appJs, /initConfigPageUi\(\)\s*\{/)
  assert.match(appJs, /this\.initConfigPageUi\(\)/)
  assert.match(appJs, /refreshConfigDependentLocks\(\)\s*\{/)
})

test('密码类字段：页面不再回填明文，且留空不提交', () => {
  // 后端 GET 已改成只返回 adminPasswordSet / playerPasswordSet / webdavPasswordSet
  assert.match(appJs, /config\.adminPasswordSet/, 'app.js 未使用 adminPasswordSet 提示已设置状态')
  assert.match(appJs, /el\.value = ''/, '密码输入框必须清空，不能回填明文')
  assert.doesNotMatch(appJs, /'admin\.password': formData\.get\('admin\.password'\)/, '密码不能无条件提交')
  assert.match(appJs, /adminPasswordInput \?/, '密码为空时不应放进 payload')
  // 后端：空密码视为「保持原值」
  const serverTs = fs.readFileSync(path.join(ROOT, 'src/server/server.ts'), 'utf8')
  assert.match(serverTs, /if \(nextAdminPassword !== ''\)/, '后端必须忽略空的管理员密码')
  assert.match(serverTs, /if \(nextWebdavPassword !== ''\)/, '后端必须忽略空的 WebDAV 密码')
})

test('日志级别：两个旧开关合并成一个 select，并在后端反写', () => {
  assert.equal(countField(formBlock, 'log.level'), 1, '缺少 log.level 字段')
  assert.equal(countField(formBlock, 'debug.enabled'), 0, 'debug.enabled 应已从页面移除')
  assert.equal(countField(formBlock, 'subsonic.enableDebug'), 0, 'subsonic.enableDebug 应已从页面移除')
  const serverTs = fs.readFileSync(path.join(ROOT, 'src/server/server.ts'), 'utf8')
  assert.match(serverTs, /newConfig\['log\.level'\][\s\S]{0,300}?debug\.enabled/, '后端未把 log.level 写回 debug.enabled')
  assert.match(serverTs, /newConfig\['log\.level'\][\s\S]{0,300}?subsonic\.enableDebug/, '后端未把 log.level 写回 subsonic.enableDebug')
})

test('目录校验失败提示：两个目录字段都有错误占位元素', () => {
  assert.equal(countField(formBlock, 'snapshot.backupPath'), 1)
  assert.equal(countField(formBlock, 'configBackup.dir'), 1)
  assert.match(formBlock, /id="snapshot-path-error"/, '缺少快照路径错误提示元素')
  assert.match(formBlock, /id="config-backup-dir-error"/, '缺少配置备份目录错误提示元素')
  assert.match(appJs, /config-backup-dir-error[\s\S]{0,800}?snapshot-path-error|snapshot-path-error[\s\S]{0,800}?config-backup-dir-error/, 'app.js 未把保存错误映射到字段')
})

test('音源巡检默认间隔已放宽到 360 分钟（默认值、兜底值与页面默认值一致）', () => {
  const defaultTs = fs.readFileSync(path.join(ROOT, 'src/defaultConfig.ts'), 'utf8')
  assert.match(defaultTs, /'customSource\.probe\.intervalMinutes': 360/)
  const serverTs = fs.readFileSync(path.join(ROOT, 'src/server/server.ts'), 'utf8')
  assert.match(serverTs, /probe\.intervalMinutes'\]\) \|\| 360/)
  assert.match(formBlock, /name="customSource\.probe\.intervalMinutes"[\s\S]{0,200}?value="360"/)
})
