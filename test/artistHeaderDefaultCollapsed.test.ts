/**
 * 「点开歌手/专辑页默认就是紧凑头部」的用例。
 *
 * 背景：老实现进入页面是「大卡片展开态」，歌曲列表被挤到最底下只露一行，
 * 必须往上滚一下（>35px）才折叠成紧凑头部（用户 2026-10-31 反馈很难用）。
 * 现在 renderArtistHeader / renderAlbumDetailHeader 结束时直接调 collapse*Immediate()。
 *
 * app.js 是浏览器脚本，不能直接 import：这里把两个 collapse 函数原样切出来，
 * 配一套极简 DOM stub 在 vm 里跑。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert'
import vm from 'node:vm'

const appSource = readFileSync('public/music/app.js', 'utf8')

function sliceByMarkers(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  const end = appSource.indexOf(endMarker)
  assert.ok(start > 0, `找不到起点标记：${startMarker}`)
  assert.ok(end > start, `找不到终点标记：${endMarker}`)
  return appSource.slice(start, end + endMarker.length)
}

function mkEl(id: string) {
  const classes = new Set<string>(id.endsWith('mini-bar') ? ['hidden', 'opacity-0'] : [])
  return {
    id,
    style: {} as Record<string, string>,
    classList: {
      add: (...cs: string[]) => cs.forEach(c => classes.add(c)),
      remove: (...cs: string[]) => cs.forEach(c => classes.delete(c)),
      contains: (c: string) => classes.has(c),
    },
    _classes: classes,
    querySelector: (sel: string) => (sel === 'i' || sel === 'span' ? { className: '', textContent: '' } : null),
  }
}

function runCollapse(which: 'artist' | 'album') {
  const ids = which === 'artist'
    ? ['artist-detail-header', 'artist-mini-bar', 'artist-mini-expand-btn', 'search-results']
    : ['album-detail-header', 'album-mini-bar', 'album-mini-expand-btn', 'search-results']
  const els = new Map(ids.map(id => [id, mkEl(id)]))
  // 展开按钮的 querySelector 要返回可写的节点，才能断言文案
  const icon = { className: '', textContent: '' }
  const label = { className: '', textContent: '' }
  els.get(ids[2])!.querySelector = (sel: string) => (sel === 'i' ? icon : sel === 'span' ? label : null)

  const code = which === 'artist'
    ? sliceByMarkers('function updateArtistMiniExpandButton', 'window.collapseArtistHeaderImmediate = collapseArtistHeaderImmediate;')
    : sliceByMarkers('function updateAlbumMiniExpandButton', 'window.collapseAlbumDetailHeaderImmediate = collapseAlbumDetailHeaderImmediate;')

  const sandbox: any = {
    document: { getElementById: (id: string) => els.get(id) || null },
    console,
    window: {},
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: `app.js#${which}-collapse` })
  if (which === 'artist') sandbox.collapseArtistHeaderImmediate()
  else sandbox.collapseAlbumDetailHeaderImmediate()
  return { els, icon, label, ids }
}

test('歌手页进入即折叠：大卡片收起、mini bar 显示、按钮文案为「展开」', () => {
  const { els, label } = runCollapse('artist')
  const header = els.get('artist-detail-header')!
  const miniBar = els.get('artist-mini-bar')!
  assert.ok(header.classList.contains('artist-hero-collapsed'), '头部应带 artist-hero-collapsed')
  assert.equal(header.style.maxHeight, '0px')
  assert.equal(header.style.opacity, '0')
  assert.equal(header.style.pointerEvents, 'none')
  assert.ok(!miniBar.classList.contains('hidden'), 'mini bar 应显示')
  assert.ok(!miniBar.classList.contains('opacity-0'), 'mini bar 应不透明')
  assert.ok(miniBar.classList.contains('opacity-100'))
  assert.equal(label.textContent, '展开')
})

test('专辑页进入即折叠：大卡片收起、mini bar 显示、按钮文案为「展开」', () => {
  const { els, label } = runCollapse('album')
  const header = els.get('album-detail-header')!
  const miniBar = els.get('album-mini-bar')!
  assert.ok(header.classList.contains('album-hero-collapsed'), '头部应带 album-hero-collapsed')
  assert.equal(header.style.maxHeight, '0px')
  assert.equal(header.style.opacity, '0')
  assert.ok(!miniBar.classList.contains('hidden'))
  assert.equal(label.textContent, '展开')
})

test('两个渲染入口都接了默认折叠（防止以后被误删）', () => {
  // renderArtistHeader 内：mini bar + 监听器之后必须紧跟 collapse
  assert.ok(
    /renderArtistMiniBar\(info, activeTab, order\);\s*\n\s*initArtistScrollListener\(\);\s*\n[\s\S]{0,400}?collapseArtistHeaderImmediate\(\);/.test(appSource),
    'renderArtistHeader 应调用 collapseArtistHeaderImmediate()',
  )
  assert.ok(
    /renderAlbumMiniBar\(info\);\s*\n\s*initAlbumScrollListener\(\);\s*\n[\s\S]{0,400}?collapseAlbumDetailHeaderImmediate\(\);/.test(appSource),
    'renderAlbumDetailHeader 应调用 collapseAlbumDetailHeaderImmediate()',
  )
})
