/**
 * LX 音乐账号 Cookie 同步 —— popup 逻辑
 *
 * 设计原则：
 * 1. 只读、只发：读当前已登录音乐站点的 Cookie，POST 到用户自己填的服务器，不落任何第三方。
 * 2. 结果必须「可核对」：同步成功的提示里带上服务器实际收到的字段名，
 *    用户一眼能看出是没登录（字段里没有 token 类）还是我们认不出新字段名。
 * 3. 校验不阻塞：保存成功后立刻回显，校验在后台跑完再追加，避免「点了半天没反应」。
 * 4. 出问题能取证：诊断信息可一键复制（只含字段名，不含值）。
 */

const PLATFORMS = {
  wy: { name: '网易云音乐', home: 'https://music.163.com', domain: 'music.163.com' },
  tx: { name: 'QQ 音乐', home: 'https://y.qq.com', domain: 'qq.com' },
  kw: { name: '酷我音乐', home: 'https://www.kuwo.cn', domain: 'kuwo.cn' },
  kg: { name: '酷狗音乐', home: 'https://www.kugou.com', domain: 'kugou.com' },
  mg: { name: '咪咕音乐', home: 'https://music.migu.cn', domain: 'migu.cn' },
}

const $ = id => document.getElementById(id)
const statusEl = $('status')

/** 最近一次同步的完整上下文，供「复制诊断信息」使用 */
let lastDiag = null

function setStatus(text, kind) {
  statusEl.textContent = text
  statusEl.className = kind || ''
}

function appendStatus(text) {
  statusEl.textContent = statusEl.textContent + '\n' + text
}

function fmtList(arr, max = 10) {
  const uniq = [...new Set(arr)]
  return uniq.slice(0, max).join(', ') + (uniq.length > max ? ` …（共 ${uniq.length} 个）` : '')
}

function currentPlatformFromUrl(url) {
  if (!url) return null
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  for (const [id, p] of Object.entries(PLATFORMS)) {
    if (host === p.domain || host.endsWith('.' + p.domain)) return id
  }
  return null
}

function normalizeServer(v) {
  let s = String(v || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  return s
}

/** 读某个域下的全部 Cookie（含 HttpOnly），已过期的丢掉 */
async function readCookies(domain, tabUrl) {
  const now = Date.now() / 1000
  const pick = list => list
    .filter(c => {
      if (!c.name) return false
      if (c.expirationDate && c.expirationDate < now - 60) return false
      return true
    })
    .sort((a, b) => {
      // 父域在前、具体子域在后，让具体子域覆盖同名键
      const da = (a.domain || '').replace(/^\./, '').length
      const db = (b.domain || '').replace(/^\./, '').length
      if (da !== db) return da - db
      return (a.name || '').localeCompare(b.name || '')
    })

  let list = []
  try {
    list = await chrome.cookies.getAll({ domain })
  } catch {
    list = []
  }

  // domain 查询偶尔会空（cookie 全挂在更具体的子域、或命中权限边界），
  // 再用当前页面 URL 兜一次 —— 这条查询返回的正是「该页面实际会带的那些」
  if (!list.length && tabUrl) {
    try {
      list = await chrome.cookies.getAll({ url: tabUrl })
    } catch {
      /* 忽略，交给上层提示 */
    }
  }
  return pick(list)
}

function toCookieHeader(cookies) {
  const map = new Map()
  for (const c of cookies) map.set(c.name, c.value ?? '')
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function toNetscape(cookies) {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# https://curl.haxx.se/rfc/cookie_spec.html',
    '# This is a generated file! Do not edit.',
    '',
  ]
  for (const c of cookies) {
    const domain = c.domain || ''
    const httpOnly = c.httpOnly ? '#HttpOnly_' : ''
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const exp = c.expirationDate ? Math.floor(c.expirationDate) : 0
    lines.push(
      [httpOnly + domain, includeSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value ?? ''].join('\t'),
    )
  }
  return lines.join('\n') + '\n'
}

async function ensurePermission(server) {
  let origin
  try {
    origin = new URL(server).origin + '/*'
  } catch {
    throw new Error('服务器地址格式不对，示例：http://192.168.1.120:8027')
  }
  const has = await chrome.permissions.contains({ origins: [origin] })
  if (has) return
  const granted = await chrome.permissions.request({ origins: [origin] })
  if (!granted) throw new Error('未授权访问该服务器地址，无法同步（可改用「复制为 Netscape 文件」）')
}

async function apiPost(server, path, password, payload) {
  const res = await fetch(server + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-frontend-auth': password },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`服务器返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`)
  }
  if (res.status === 401) throw new Error('管理员密码不正确')
  return { data, status: res.status }
}

let platformId = 'wy'
let cookies = []
let currentTabUrl = ''

async function reload() {
  const tab = await chrome.tabs.query({ active: true, currentWindow: true })
  currentTabUrl = tab[0]?.url || ''
  const detected = currentPlatformFromUrl(currentTabUrl)
  $('dot').className = 'dot' + (detected ? '' : ' off')

  if (detected) {
    platformId = detected
    $('platform').value = detected
    $('platText').textContent = `当前页面：${PLATFORMS[detected].name}`
  } else {
    $('platText').textContent = '当前不是音乐平台页面，已按下方选择的平台读取'
    platformId = $('platform').value
  }

  cookies = await readCookies(PLATFORMS[platformId].domain, currentTabUrl)
  if (!cookies.length) {
    setStatus(
      `没有读到 ${PLATFORMS[platformId].name} 的 Cookie。\n`
      + '请确认：① 当前标签页就是这个平台的页面；② 已经登录（不是游客）；③ 刷新一次页面再点「重新读取」。',
      'warn',
    )
    return
  }
  const names = cookies.map(c => c.name)
  setStatus(`已读取 ${new Set(names).size} 个 Cookie\n字段：${fmtList(names)}`)
}

$('platform').addEventListener('change', async () => {
  platformId = $('platform').value
  await reload()
})

$('refresh').addEventListener('click', reload)

/** 校验放后台跑，不阻塞「已保存」的回显 */
async function verifyInBackground(server, password) {
  appendStatus('校验中…')
  try {
    const { data } = await apiPost(server, '/api/music/accounts/verify', password, { platform: platformId })
    const info = data?.data || {}
    if (lastDiag) lastDiag.verify = info
    // 结构校验的结果里带着「当前实际字段名」，正是排查要的信息，原样展示
    appendStatus(`校验：${info.message || (info.ok ? '通过' : '未通过')}`)
  } catch (e) {
    appendStatus(`校验失败：${e.message || e}`)
  }
}

$('sync').addEventListener('click', async () => {
  const server = normalizeServer($('server').value)
  const password = $('password').value
  if (!server) return setStatus('请填写服务器地址，例如 http://192.168.1.120:8027', 'err')
  if (!password) return setStatus('请填写管理员密码（就是后台登录密码）', 'err')

  platformId = $('platform').value || platformId
  await chrome.storage.local.set({ server, password })
  $('sync').disabled = true
  setStatus('正在同步…')

  const names = cookies.map(c => c.name)
  lastDiag = {
    at: new Date().toISOString(),
    url: currentTabUrl,
    platform: platformId,
    domain: PLATFORMS[platformId].domain,
    count: new Set(names).size,
    names: [...new Set(names)],
    server,
    save: null,
    verify: null,
  }

  try {
    await ensurePermission(server)
    if (!cookies.length) await reload()
    if (!cookies.length) throw new Error('没有可同步的 Cookie：请确认已登录该平台并刷新页面')

    const cookie = toCookieHeader(cookies)
    const { data: r } = await apiPost(server, '/api/music/accounts', password, { platform: platformId, cookie })
    lastDiag.save = r
    if (!r.success) throw new Error(r.error || '服务器拒绝保存')

    const lines = []
    lines.push(`已保存到「${PLATFORMS[platformId].name}」：${r.count ?? names.length} 个字段（识别为${r.formatText || 'Cookie'}）`)
    lines.push(`字段：${fmtList(r.keys && r.keys.length ? r.keys : names)}`)
    for (const w of r.warnings || []) lines.push('⚠ ' + w)
    setStatus(lines.join('\n'), (r.warnings || []).length ? 'warn' : 'ok')

    // 保存已经成功，校验慢就慢，不挡着用户
    verifyInBackground(server, password)
  } catch (e) {
    setStatus(e.message || String(e), 'err')
  } finally {
    $('sync').disabled = false
  }
})

$('copy').addEventListener('click', async () => {
  try {
    if (!cookies.length) await reload()
    if (!cookies.length) return setStatus('没有可复制的 Cookie', 'warn')
    await navigator.clipboard.writeText(toNetscape(cookies))
    setStatus('已复制 Netscape 格式，可直接粘贴到后台「填写 Cookie」框，或导入 go-music-dl', 'ok')
  } catch (e) {
    setStatus('复制失败：' + (e.message || e), 'err')
  }
})

$('diag').addEventListener('click', async () => {
  try {
    const payload = lastDiag || {
      at: new Date().toISOString(),
      url: currentTabUrl,
      platform: platformId,
      domain: PLATFORMS[platformId].domain,
      count: new Set(cookies.map(c => c.name)).size,
      names: [...new Set(cookies.map(c => c.name))],
      note: '尚未同步过',
    }
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    setStatus('诊断信息已复制（只含字段名，不含 Cookie 值），可直接发给维护者', 'ok')
  } catch (e) {
    setStatus('复制失败：' + (e.message || e), 'err')
  }
})

;(async () => {
  const saved = await chrome.storage.local.get(['server', 'password'])
  if (saved.server) $('server').value = saved.server
  if (saved.password) $('password').value = saved.password
  await reload()
})()
