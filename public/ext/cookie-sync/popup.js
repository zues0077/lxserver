/**
 * LX 音乐账号 Cookie 同步 —— popup 逻辑
 *
 * 设计原则：
 * 1. 只读、只发：读当前已登录音乐站点的 Cookie，POST 到用户自己填的服务器，不落任何第三方。
 * 2. 同时支持「一键同步」和「复制为 Netscape 文件」两条路 ——
 *    服务器不可达时，用户仍可拿文件去别处用（go-music-dl 也吃这个格式）。
 * 3. Cookie 排序按 domain 从宽到窄，同名时具体子域的值覆盖父域，
 *    与服务端「后写覆盖」的语义一致。
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

function setStatus(text, kind) {
  statusEl.textContent = text
  statusEl.className = kind || ''
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
async function readCookies(domain) {
  const all = await chrome.cookies.getAll({ domain })
  const now = Date.now() / 1000
  return all
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
      [
        httpOnly + domain,
        includeSub,
        c.path || '/',
        c.secure ? 'TRUE' : 'FALSE',
        exp,
        c.name,
        c.value ?? '',
      ].join('\t'),
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
  // 用户点过按钮，仍在手势有效期内，可以弹授权
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
    throw new Error(`服务器返回了非 JSON 内容（HTTP ${res.status}），请检查地址是否指向 LX 服务器`)
  }
  if (res.status === 401) throw new Error('管理员密码不正确')
  return data
}

let platformId = 'wy'
let cookies = []

async function reload() {
  const tab = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab[0]?.url || ''
  const detected = currentPlatformFromUrl(url)
  $('dot').className = 'dot' + (detected ? '' : ' off')

  if (detected) {
    platformId = detected
    $('platform').value = detected
    $('platText').textContent = `当前页面：${PLATFORMS[detected].name}`
  } else {
    $('platText').textContent = '当前不是音乐平台页面，已按下方选择的平台读取'
    platformId = $('platform').value
  }

  cookies = await readCookies(PLATFORMS[platformId].domain)
  if (!cookies.length) {
    setStatus(`没有读到 ${PLATFORMS[platformId].name} 的 Cookie。请先打开并登录该平台。`, 'warn')
    return
  }
  const names = [...new Set(cookies.map(c => c.name))]
  setStatus(
    `已读取 ${names.length} 个 Cookie\n${names.slice(0, 8).join(', ')}${names.length > 8 ? ' …' : ''}`,
  )
}

$('platform').addEventListener('change', async () => {
  platformId = $('platform').value
  await reload()
})

$('refresh').addEventListener('click', reload)

$('sync').addEventListener('click', async () => {
  const server = normalizeServer($('server').value)
  const password = $('password').value
  if (!server) return setStatus('请填写服务器地址，例如 http://192.168.1.120:8027', 'err')
  if (!password) return setStatus('请填写管理员密码（就是后台登录密码）', 'err')

  await chrome.storage.local.set({ server, password })
  $('sync').disabled = true
  setStatus('正在同步…')

  try {
    await ensurePermission(server)
    if (!cookies.length) await reload()
    if (!cookies.length) throw new Error('没有可同步的 Cookie，请确认已登录该平台')

    const cookie = toCookieHeader(cookies)
    const r = await apiPost(server, '/api/music/accounts', password, { platform: platformId, cookie })
    if (!r.success) throw new Error(r.error || '服务器拒绝保存')

    let msg = `已同步 ${r.count ?? ''} 个 Cookie（识别为${r.formatText || 'Cookie'}）`
    if (Array.isArray(r.warnings) && r.warnings.length) msg += '\n⚠ ' + r.warnings.join('\n⚠ ')

    // 顺手验一下，让用户当场知道这份 Cookie 有没有用
    try {
      const v = await apiPost(server, '/api/music/accounts/verify', password, { platform: platformId })
      const info = v?.data
      if (info) {
        msg += `\n校验：${info.message || (info.ok ? '通过' : '未通过')}`
      }
    } catch {
      /* 校验失败不影响已保存的事实，静默 */
    }

    setStatus(msg, 'ok')
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

;(async () => {
  const saved = await chrome.storage.local.get(['server', 'password'])
  if (saved.server) $('server').value = saved.server
  if (saved.password) $('password').value = saved.password
  await reload()
})()
