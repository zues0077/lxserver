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
// [方案甲] Subsonic 拆成独立视图后是第二个 form，字段契约按「config-form + subsonic-form」合并校验
const formBlock = sliceBetween(configSection, '<form id="config-form"', '</form>')
    + sliceBetween(configSection, '<form id="subsonic-form"', '</form>')

/** 配置页必须保留的全部字段（server.ts 按 name 取值的契约） */
const REQUIRED_FIELDS = [
  'serverName', 'list.addMusicLocationType', 'log.level',
  'admin.path', 'player.path',
  'user.enablePath', 'user.enableRoot',
  'player.name', 'admin.password', 'player.enableAuth', 'player.password',
  'soda.allowPreview', 'soda.previewTtlHours',
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
  'subsonic.lyricTranslation', 'subsonic.cacheOnPlay', 'subsonic.playCacheFirst', 'subsonic.playCacheAnyQuality',
  'subsonic.dislikeRating', 'subsonic.linkRatingToDislike', 'subsonic.linkDislikeToRating',
  'subsonic.hideDisliked', 'subsonic.dislikeNoRecommend', 'subsonic.dislikeRequireSinger',
  'subsonic.dislikeNormalizeName', 'subsonic.dislikeCrossSource', 'subsonic.dislikeDuetMode',
  'subsonic.quality.enabled', 'subsonic.quality.priority', 'subsonic.quality.clientCapMode',
  'subsonic.source.priority', 'subsonic.source.crossPlatform', 'subsonic.source.autoSwitchCustom',
  'customSource.probe.enabled', 'customSource.probe.intervalMinutes',
  'customSource.probe.concurrency', 'customSource.probe.failThreshold',
  'customSource.probe.demoteThreshold',
  'customSource.probe.allDownDays',
  'customSource.probe.restoreIntervalMinutes',
  'customSource.probe.autoDisablePlatform', 'customSource.probe.autoRemoveSource',
  'customSource.probe.removeMode',
  'customSource.trash.retentionDays',
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
  assert.ok(targets.length >= 5, `导航项过少：${targets.length}`)
  // [方案甲] cfg-subsonic 已拆到独立视图自己的 form，子导航只对应 config-form 内的分组
  const cfgFormOnly = sliceBetween(configSection, '<form id="config-form"', '</form>')
  const groupIds = [...cfgFormOnly.matchAll(/<section class="config-group" id="([^"]+)"/g)].map(m => m[1])
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

test('配置页双版式：默认卡片，行列表版本的分组导航固定常驻', () => {
  // 版式只在 URL 上切换，不写 localStorage：用户上次看过 ?cfg=rows 不该回不到默认
  assert.match(appJs, /new URLSearchParams\(location\.search\)\.get\('cfg'\)/)
  assert.doesNotMatch(appJs, /localStorage\.(get|set)Item\('lx_config_layout'/, '版式选择不应记忆在本地')
  assert.match(appJs, /form\.classList\.toggle\('cfg-rows'/, '未切换表单上的版式 class')
  // 导航条在 <form> 之外，只会靠 #view-config 上的同名 class 生效
  assert.match(appJs, /view\.classList\.toggle\('cfg-rows'/, '导航条所在的视图也要打上版式 class')

  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8')
  const pinned = sliceBetween(css, '#view-config.cfg-rows .config-toolbar {', '}')
  assert.match(pinned, /position:\s*sticky/, '行列表版本的分组导航必须吸顶固定')
  // 偏移必须和卡片版共用同一个变量：桌面端滚动发生在 body 上，写死 0 会被顶栏整条盖住
  assert.match(pinned, /top:\s*var\(--cfg-sticky-top/, '固定条偏移要跟随滚动容器计算，不能写死')
  assert.match(css, /#view-config\.cfg-rows \.config-group \{\s*scroll-margin-top:\s*calc\(var\(--cfg-sticky-top/,
    '跳转后分组标题要避开固定条')
})

test('吸顶偏移按真正的滚动容器算，别被顶栏盖住', () => {
  // 回归：桌面端 .content-wrapper 是自然高度（滚动在 body 上），偏移必须是顶栏下沿；
  // 只有它自己成为滚动容器时（移动端）才用自身 paddingTop。
  const cssBase = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8')
  assert.match(appJs, /scroller\.scrollHeight > scroller\.clientHeight/, '未判断滚动容器归属')
  assert.match(appJs, /bar\.offsetHeight/, '未取顶栏高度作为吸顶偏移')
  // 桌面端 .content-wrapper 一旦 overflow 非 visible，就成了永不滚动的「滚动容器」，
  // 里面的 sticky 全部失效（配置页工具栏「往下翻就没了」的根因）
  const baseWrapper = sliceBetween(cssBase, '.content-wrapper {', '}')
  assert.match(baseWrapper, /overflow-y:\s*visible/, '内容区不能自建滚动容器，否则吸顶失效')
  assert.doesNotMatch(appJs, /setProperty\('--cfg-sticky-top', \(padTop \+ 10\)/, '旧的自然高度偏移应已移除')
})

test('配置项搜索：工具栏吸顶、筛选只加 class 不动结构', () => {
  // 导航条与搜索框同处一条吸顶工具栏，避免「导航钉住、搜索框滚走」
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8')
  const toolbar = sliceBetween(css, '.config-toolbar {', '}')
  assert.match(toolbar, /position:\s*sticky/, '工具栏必须吸顶')
  const subnav = sliceBetween(css, '.config-subnav {', '}')
  assert.match(subnav, /position:\s*static/, '导航本体不再自己吸顶，交给工具栏')

  // 搜索框不能放进 <form>，否则会成为表单字段白提交给后端
  assert.match(configSection, /id="config-search-input"/, '缺少搜索输入框')
  assert.ok(configSection.indexOf('id="config-search-input"') < configSection.indexOf('<form id="config-form"'),
    '搜索框必须留在表单之外')

  assert.match(appJs, /initConfigSearch\(\)/, '未绑定搜索框')
  assert.match(appJs, /applyConfigSearch\(/, '未实现筛选逻辑')
  // 筛选只能加 class：一旦改成删 DOM 或 disabled，就会丢字段/丢配置
  assert.match(appJs, /classList\.add\('cfg-hidden'\)/, '隐藏项应只加 class')
  assert.doesNotMatch(appJs, /removeChild\(.*config-field/, '不能通过删节点来筛选')
  assert.match(css, /\.cfg-hidden\s*\{/, '缺少隐藏样式')
})

test('回收站保留天数：配置字段、默认值、清理入口三处对齐', () => {
  assert.equal(countField(formBlock, 'customSource.trash.retentionDays'), 1)
  const defaultTs = fs.readFileSync(path.join(ROOT, 'src/defaultConfig.ts'), 'utf8')
  // 默认 3 天（用户 2026-11-06 定调：全平台失效 3 天进回收站，回收站再留 3 天）
  assert.match(defaultTs, /'customSource\.trash\.retentionDays': 3/)
  const indexTs = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8')
  assert.match(indexTs, /startTrashJanitor\(/, '启动时应挂上回收站清理定时器')
  // 0 是合法值（永不清理），读配置时不能被 || 兜底成默认值
  assert.doesNotMatch(indexTs, /customSource\.trash\.retentionDays'\] \|\| \d+/, '0 不能被 || 吞掉')
})

test('页内跳转按钮：全部能被 app.js 绑上，且 data-target 指向真实存在的目标', () => {
  // 背景（2026-11-14 事故，P-1476）：配置分组拆成独立视图（Subsonic / WebDAV）后，
  // 绑定选择器仍写着 `#view-config .config-jump-btn`，落在新视图里的按钮就选不到、
  // 静默点不动（无报错、无请求）。这里守住两条不变量，防止换个视图再犯。
  assert.doesNotMatch(
    appJs,
    /querySelectorAll\('#view-config \.config-jump-btn'\)/,
    '跳转按钮绑定不能限定在 #view-config 内——分组拆分后其他视图里的按钮会绑不上'
  )
  assert.match(appJs, /querySelectorAll\('\.config-jump-btn'\)/, '应以全局 .config-jump-btn 绑定')

  const btns = [...html.matchAll(/<button[^>]*class="[^"]*config-jump-btn[^"]*"[^>]*>/g)].map(m => m[0])
  assert.ok(btns.length >= 2, `跳转按钮太少（${btns.length}），结构可能又变了`)

  const viewIds = new Set([...html.matchAll(/<div id="(view-[a-z]+)" class="view"/g)].map(m => m[1]))
  const allIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))

  for (const tag of btns) {
    const t = tag.match(/data-target="([^"]+)"/)?.[1]
    assert.ok(t, `跳转按钮缺少 data-target：${tag.slice(0, 100)}`)
    // 历史别名：cfg-webdav-page 由 app.js 特判切到 webdav 视图
    if (t === 'cfg-webdav-page') continue
    const isElement = allIds.has(t)
    const isView = viewIds.has('view-' + t)
    assert.ok(isElement || isView,
      `按钮 data-target="${t}" 既不是页面元素 id，也不是视图名（view-${t}）——点了会没反应`)
  }
})

test('逐源 VM 白名单：全局总闸在字段契约内，且后端可关、卡片有开关（方案甲）', () => {
  // P-1407：配置页新增/改动字段必须同步登记 REQUIRED_FIELDS，否则「没有多余的新字段混进契约」用例会红。
  // 本次没有新增表单字段，但逐源白名单依赖全局总闸 system.allowUnsafeVM：
  // 把它作为显式契约锁住，防止有人从配置页删掉开关，导致所有白名单静默失效（仍走 vm2）。
  assert.ok(REQUIRED_FIELDS.includes('system.allowUnsafeVM'), 'REQUIRED_FIELDS 未登记 system.allowUnsafeVM')
  assert.equal(countField(formBlock, 'system.allowUnsafeVM'), 1, '全局 VM 总闸在配置页必须且只能出现一次')

  const handlers = fs.readFileSync(path.join(ROOT, 'src/server/customSourceHandlers.ts'), 'utf8')
  assert.match(handlers, /hasAllowUnsafeVM/, 'handleToggle 必须用「键是否存在」区分未传与显式 false')
  assert.match(handlers, /target\.allowUnsafeVM = allowUnsafeVM === true/, 'handleToggle 必须支持显式 false 写回（可开可关）')
  assert.match(handlers, /const vmOnly = hasAllowUnsafeVM && !hasEnabled/, '仅切白名单不能顺带翻转启用状态')

  const musicAppJs = fs.readFileSync(path.join(ROOT, 'public/music/app.js'), 'utf8')
  assert.match(musicAppJs, /toggleSourceVm\(/, '音源卡片必须提供逐源 VM 白名单开关入口')
  assert.match(musicAppJs, /allowUnsafeVM: !currentVm/, '卡片开关必须同时支持加入与移出白名单')
  assert.match(musicAppJs, /if \(allowUnsafeVM !== undefined\) payload\.allowUnsafeVM = allowUnsafeVM/,
    '普通启停不能固定带 allowUnsafeVM:false，否则会误清白名单')
})

test('vm2 失败诊断 vmHint：列表透出 + 前端分档文案 + 问号提示 + 置顶不污染 order', () => {
  const handlers = fs.readFileSync(path.join(ROOT, 'src/server/customSourceHandlers.ts'), 'utf8')
  assert.match(handlers, /source\.vmHint = status\.vmHint/, '列表接口必须透出后端诊断字段 vmHint')

  const musicAppJs = fs.readFileSync(path.join(ROOT, 'public/music/app.js'), 'utf8')
  // 三档文案齐全
  assert.match(musicAppJs, /可恢复·加白/, 'unsafe-capable 档文案缺失')
  assert.match(musicAppJs, /疑似兼容问题/, 'vm2-incompatible 档文案缺失')
  assert.match(musicAppJs, /buildVmFailureSummary\(/, '失败汇总条函数缺失')
  // 问号提示入口存在
  assert.match(musicAppJs, /function showVmWhitelistHelp\(/, 'VM 白名单问号提示函数缺失')
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/music/index.html'), 'utf8')
  assert.match(indexHtml, /onclick="showVmWhitelistHelp\(\)"/, '设置页自定义源标题必须挂问号提示入口')
  // 展示层置顶，但要靠 dataset.vmFailed 在 onEnd 归位，不写进 order.json
  assert.match(musicAppJs, /div\.dataset\.vmFailed =/, '失败源必须打标记以便拖拽写回时归位')
  assert.match(musicAppJs, /el\.dataset\.vmFailed === '1'/, 'onEnd 必须识别失败源并排除出置顶顺序')
  assert.match(musicAppJs, /displayList\.forEach\(/, '卡片渲染必须用置顶后的展示副本，而非原始 list')
})

test('开总闸即时生效：保存配置时重载已加白但失败的源 + 前端关缓存 + 渲染防竞态', () => {
  // 1) userApi 必须导出「重载已加白但未成功源」的函数，且只挑 allowUnsafeVM 且非 success
  const userApi = fs.readFileSync(path.join(ROOT, 'src/server/userApi.ts'), 'utf8')
  assert.match(userApi, /export async function reloadWhitelistedFailedSources/,
    '缺少 reloadWhitelistedFailedSources：开总闸后无法让已加白的源恢复')
  assert.match(userApi, /s\.allowUnsafeVM !== true/,
    '重载函数必须只挑已加白的源，不能把所有源都重载')
  assert.match(userApi, /st\.status === 'success'\) continue/,
    '已成功的源必须跳过重载，避免打断在途取链')

  // 2) server.ts 保存配置：总闸由关转开要触发重载，并在响应里回传重载数
  const serverTs = fs.readFileSync(path.join(ROOT, 'src/server/server.ts'), 'utf8')
  assert.match(serverTs, /vmGateTurnedOn = !vmWasEnabled && !!newConfig\['system\.allowUnsafeVM'\]/,
    '必须识别「总闸由关转开」这一跳变，否则每次保存都会重载')
  assert.match(serverTs, /await reloadWhitelistedFailedSources\(\)/,
    '总闸开启后必须 await 重载，保证响应返回时状态已是最终态')
  assert.match(serverTs, /vmReloaded/,
    '保存响应必须回传 vmReloaded，供前端提示')

  // 3) music 前端：列表关缓存 + 渲染序号防竞态
  const musicAppJs = fs.readFileSync(path.join(ROOT, 'public/music/app.js'), 'utf8')
  assert.match(musicAppJs, /cache: 'no-store'/,
    '音源列表请求必须关缓存，否则加白后仍可能读到旧状态')
  assert.match(musicAppJs, /customSourcesRenderSeq/,
    'renderCustomSources 必须有序号保护，避免旧请求覆盖新渲染')
  assert.match(musicAppJs, /if \(renderSeq !== customSourcesRenderSeq\) return/,
    '过期的渲染结果必须直接丢弃')

  // 4) 外层设置页：保存成功时要提示已重载的源数
  const outerAppJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  assert.match(outerAppJs, /res\.vmReloaded > 0/,
    '设置页保存后必须把「已重载 N 个音源」告知用户')
})

test('搜索限流治理：tx 内部重试收敛 + 自动匹配搜结果短缓存', () => {
  // 1) 后端：外层保持快速失败；真正减少限流的是 tx 内部重试收敛
  //    （实测 300/1200ms 递增退避跨不过 QQ 限流窗口，只会让用户多等，已回滚）
  const txSearch = fs.readFileSync(path.join(ROOT, 'src/modules/utils/musicSdk/tx/musicSearch.js'), 'utf8')
  assert.match(txSearch, /if \(retryNum > 2\) return Promise\.reject/,
    'tx 内部重试必须收敛到 3 次（原来 6 次瞬间连打会加深限流）')
  assert.match(txSearch, /setTimeout\(resolve, 250\)/,
    'tx 重试之间必须有间隔，不能零延迟立即递归')
  assert.doesNotMatch(txSearch, /^\s*if \(retryNum > 5\) return Promise\.reject/m,
    '旧的 6 次立即重试不应残留（注释里的历史记录不算）')

  // 2) 前端自动关联：同一 (平台,关键词) 30s 内复用，避免连打造成平台限流
  const localMusicJs = fs.readFileSync(path.join(ROOT, 'public/music/js/local_music.js'), 'utf8')
  assert.match(localMusicJs, /LM_SEARCH_CACHE_TTL_MS = 30000/,
    '自动关联搜索必须有短期缓存 TTL')
  assert.match(localMusicJs, /async searchSingleSource\(text, source\) \{\s*\n\s*const cacheKey/,
    'searchSingleSource 必须先查缓存再发请求')
  assert.match(localMusicJs, /lmSearchCache\.set\(cacheKey/,
    '成功返回后必须回填缓存')
})
