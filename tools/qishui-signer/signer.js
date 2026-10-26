#!/usr/bin/env node
/**
 * 汽水音乐 签名服务（Windows 侧 / 也可在 wine 里跑）
 * ---------------------------------------------------------------------------
 * 作用：把官方客户端自带的签名组件（bdms.node + metasecml.dll）包装成一个
 *      HTTP 小服务，给 NAS 上的 lxserver 调。NAS 侧只需一个环境变量：
 *
 *        QISHUI_SIGNER_URL=http://<这台机器>:18080
 *
 * 协议（与 lxserver/src/server/extraSources/signer.ts 对应）：
 *   GET  /                      → 网页配置页（浏览器打开 http://localhost:18080/）
 *   GET  /api/config            → 当前配置（密码以 ******** 掩码返回）
 *   POST /api/config            → 保存并热生效（端口变更会热重启监听，服务器列表立即重新登记）
 *   GET  /health                → 200 "ok"
 *   GET  /config                → {device_id}      （可选，告诉服务端用哪个设备身份）
 *   POST /sign                  {url, method, body, headers} → {headers:{X-Helios, X-Medusa}}
 *
 * 同一个签名器可以同时给多台 LX 服务器签名：汽水账号状态存在各台 LX 服务器里，
 * 本服务本身无状态，只负责「按收到的请求头生成签名」，因此多台服务器互不影响。
 *
 * 用法：
 *   node signer.js                                   # 读同目录 config.json
 *   node signer.js --port 18080 --client "C:\...\Soda Music\3.7.0"
 *   node signer.js --setup                           # 强制重新填写 LX 服务器
 *   set SODA_DEVICE_ID=7300000000000001 && node signer.js
 *
 * 安全提醒：本服务会看到完整请求头（含 Cookie），只在本机/内网监听，别暴露公网。
 *          配置页会显示 LX 后台密码，也只在可信局域网内打开。
 */

const http = require('http')
const path = require('path')
const fs = require('fs')

const CONFIG_PATH = path.join(__dirname, 'config.json')
const PAGE_PATH = path.join(__dirname, 'index.html')

// ---------------------------------------------------------------------------
// 配置：默认值 → config.json → 命令行/环境变量（优先级递增，兼容旧用法）
// ---------------------------------------------------------------------------
function defaultConfig() {
  return {
    port: 18080,                       // 签名器自身监听端口
    host: '0.0.0.0',                   // 监听地址（0.0.0.0 = 允许局域网内 LX 访问）
    clientDir: '',                     // 汽水客户端目录（留空自动探测）
    deviceId: '7300000000000001',      // 设备身份（改了要重启生效）
    appVersion: '',                    // 客户端版本号；留空 = 启动时从客户端目录自动识别
    buildId: '30080000',               // 客户端 buildId（客户端里找不到，只能手填）
    servers: []                        // 关联的 LX 服务器：[{ url, password }]
  }
}

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

let config = defaultConfig()
if (fs.existsSync(CONFIG_PATH)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (loaded && typeof loaded === 'object') config = Object.assign(config, loaded)
  } catch (e) {
    console.error('[config] 读取 config.json 失败，沿用默认值/命令行：', e.message)
  }
}

// 兼容旧版 signer-config.json（单 server 字段）→ 并入 servers[]
try {
  const old = JSON.parse(fs.readFileSync(path.join(__dirname, 'signer-config.json'), 'utf8'))
  if (old && old.server && !config.servers.some(s => s.url === old.server)) {
    config.servers.push({ url: old.server, password: old.password || '' })
  }
} catch {}

// 命令行 / 环境变量覆盖（兼容旧 --pair/--password 用法）
function override(key, val, asNumber) {
  if (val === undefined || val === '') return
  config[key] = asNumber ? Number(val) : String(val)
}
override('port', arg('port', process.env.SIGNER_PORT), true)
override('host', arg('host', process.env.SIGNER_HOST))
override('clientDir', arg('client', process.env.SODA_CLIENT_DIR))
override('deviceId', arg('device', process.env.SODA_DEVICE_ID))
override('appVersion', arg('version', process.env.SODA_VERSION))
override('buildId', arg('build', process.env.SODA_BUILD_ID))

// 旧式 --pair / --password → 视作第一个服务器
const legacyPair = arg('pair', process.env.SIGNER_PAIR_SERVER)
const legacyPwd = arg('password', process.env.SIGNER_PAIR_PASSWORD)
if (legacyPair) {
  const url = String(legacyPair).trim()
  if (url && !config.servers.some(s => s.url === url)) {
    config.servers.push({ url, password: legacyPwd ? String(legacyPwd) : '' })
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    console.log(`[signer] 配置已保存：${CONFIG_PATH}`)
  } catch (e) {
    console.log(`[signer] 配置保存失败（不影响本次运行）：${e.message}`)
  }
}

/** 是不是目录（读不到就当不是，别让权限问题炸掉整个扫描） */
function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
function safeReaddir(p) {
  try { return fs.readdirSync(p) } catch { return [] }
}

/**
 * 找 app.asar.unpacked（里面有 bdms.node + metasecml.dll）
 * 客户端有两种装法，都要覆盖：
 *   A) <root>\3.7.0\resources\app.asar.unpacked           （3.7 及更早）
 *   B) <root>\Packages\3.8.0\app.asar.unpacked            （3.8 起的增量更新，多一层）
 */
function findUnpacked() {
  const local = process.env.LOCALAPPDATA || ''
  const root = local ? path.join(local, 'Programs', 'Soda Music') : ''
  const candidates = []
  if (config.clientDir) {
    // 用户可能指到：unpacked 目录本身 / 包目录 / 版本目录，三种都认
    candidates.push(config.clientDir)
    candidates.push(path.join(config.clientDir, 'app.asar.unpacked'))
    candidates.push(path.join(config.clientDir, 'resources', 'app.asar.unpacked'))
  }
  if (root) {
    if (config.appVersion) {
      candidates.push(path.join(root, config.appVersion, 'resources', 'app.asar.unpacked'))
      candidates.push(path.join(root, 'Packages', config.appVersion, 'app.asar.unpacked'))
    }
    candidates.push(path.join(root, 'current', 'resources', 'app.asar.unpacked'))
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'bdms.node'))) return c
  }

  // 兜底：往两层翻，命中所有 unpacked 目录（客户端升级后版本目录名会变）
  if (!root || !isDir(root)) return ''
  const found = []
  const probe = dir => {
    if (fs.existsSync(path.join(dir, 'bdms.node')) && !found.includes(dir)) found.push(dir)
  }
  for (const n1 of safeReaddir(root)) {
    const d1 = path.join(root, n1)
    if (!isDir(d1)) continue
    probe(d1)                                              // <root>\Packages\3.8.0 本身
    probe(path.join(d1, 'resources', 'app.asar.unpacked')) // <root>\3.7.0\...
    probe(path.join(d1, 'app.asar.unpacked'))
    for (const n2 of safeReaddir(d1)) {
      const d2 = path.join(d1, n2)
      if (!isDir(d2)) continue
      probe(d2)
      probe(path.join(d2, 'resources', 'app.asar.unpacked'))
      probe(path.join(d2, 'app.asar.unpacked'))
    }
  }
  if (!found.length) return ''
  // 显式指定了版本就优先用它，否则取最高版本
  if (config.appVersion) {
    const prefer = found.find(p => p.includes(`${path.sep}${config.appVersion}${path.sep}`))
    if (prefer) return prefer
  }
  const rank = p => {
    const m = p.match(/(\d+)\.(\d+)\.(\d+)/)
    return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0
  }
  found.sort((a, b) => rank(b) - rank(a))
  return found[0]
}

/** 从 unpacked 目录推断客户端版本（manifest.json → Packages/config.json → 目录名） */
function detectVersion(unpackedDir) {
  const tries = [
    path.join(unpackedDir, 'manifest.json'),
    path.join(unpackedDir, '..', 'manifest.json'),
    path.join(unpackedDir, '..', '..', 'config.json'),
    path.join(unpackedDir, 'version.json'),
    path.join(unpackedDir, 'package.json')
  ]
  for (const p of tries) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      const v = String(j.version || j.latestVersion || j.appVersion || '').trim()
      if (/^\d+\.\d+\.\d+/.test(v)) return { version: v, source: path.basename(p) }
    } catch {}
  }
  const m = String(unpackedDir).match(/(\d+\.\d+\.\d+)/)
  if (m) return { version: m[1], source: '目录名' }
  return { version: '', source: '' }
}

const unpacked = findUnpacked()
if (!unpacked) {
  const root = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Soda Music') : '(未取到 LOCALAPPDATA)'
  console.error('[签名器] 找不到汽水客户端的 bdms.node')
  console.error(`  已查找：${root}`)
  console.error('  1) 确认这台电脑装了「汽水音乐」官方客户端，并至少登录过一次')
  console.error('  2) 或用 --client 手动指定版本目录，例如：')
  console.error('     node signer.js --client "C:\\Users\\你\\AppData\\Local\\Programs\\Soda Music\\3.7.0"')
  console.error('  3) 若客户端刚升级，先打开一次客户端让它把 app.asar.unpacked 铺好')
  process.exit(1)
}
// metasecml.dll 与 bdms.node 同目录，切换 cwd 保证能被加载
process.chdir(unpacked)

// 版本自动识别：配置里显式给了就用配置，否则从客户端目录推断
const detected = detectVersion(unpacked)
if (!config.appVersion) {
  config.appVersion = detected.version || '3.7.0'
  if (detected.version) console.log(`[signer] 自动识别客户端版本：${detected.version}（来源：${detected.source}）`)
  else console.log('[signer] 未能自动识别客户端版本，暂用 3.7.0（可在配置页手填）')
}

const bdms = require(path.join(unpacked, 'bdms.node'))
bdms.init({ deviceId: config.deviceId })
console.log(`[signer] 已加载 bdms.node：${unpacked}`)
console.log(`[signer] deviceId=${config.deviceId} UA=LunaPC/${config.appVersion}(${config.buildId})`)

function signHeaders(url, headers) {
  const lines = []
  for (const [key, value] of Object.entries(headers || {})) {
    const values = Array.isArray(value) ? value : [value]
    for (const v of values) {
      if (v === undefined || v === null) continue
      lines.push(`${String(key).toLowerCase()}\r\n${v}`)
    }
  }
  const out = bdms.generateHttpSignatureHeaders(url, lines.join('\r\n'))
  const pairs = String(out || '').split('\r\n').filter(t => t.trim())
  const result = {}
  for (let i = 0; i < pairs.length / 2; i++) result[pairs[i * 2]] = pairs[i * 2 + 1]
  return result
}

function lanAddresses() {
  const nets = require('os').networkInterfaces()
  const out = []
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address)
    }
  }
  return out
}

function selfUrl() {
  const all = lanAddresses()
  const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3)
  const ips = all.filter(ip => !ip.startsWith('169.254.')).sort((a, b) => rank(a) - rank(b))
  const primary = ips[0] || '127.0.0.1'
  return `http://${primary}:${config.port}`
}

/** 把签名器地址登记/清空到某台 LX 服务器（POST /api/music/prefetch/signer） */
async function pairTo(server, password, selfUrlArg) {
  // HTTP 请求头只允许 ASCII，密码里有中文/全角字符会直接抛 ByteString 错误，
  // 提前拦下来给一句人话提示，否则报错信息会完全看不出原因。
  if (password && /[^\x20-\x7e]/.test(password)) {
    return { url: server, ok: false, online: false, message: '后台密码含中文/全角字符，HTTP 请求头放不下，请改用英文数字部分' }
  }
  // 用户常常只填 IP:端口，漏了 http://，这里自动补，不让他卡在格式上
  let base = String(server || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base
  const url = `${base}/api/music/prefetch/signer`
  const body = JSON.stringify({ url: selfUrlArg })
  const headers = { 'Content-Type': 'application/json' }
  if (password) headers['x-frontend-auth'] = password
  try {
    const res = await fetch(url, { method: 'POST', headers, body })
    const text = await res.text()
    let data = {}
    try { data = JSON.parse(text) } catch {}
    const d = data.data || {}
    const online = !!(res.ok && data.success && d.online)
    const message = online
      ? '已登记并连通'
      : (res.ok && data.success ? (d.message || '已登记但 LX 侧探测签名器不可达') : (data.error || data.message || `HTTP ${res.status}`))
    return { url: server, ok: !!(res.ok && data.success), online, message }
  } catch (e) {
    // fetch 失败时 e.message 只有 "fetch failed"，真正的 code 在 e.cause 里
    const code = e.cause && (e.cause.code || e.cause.message)
    let message = e.message
    if (code === 'ECONNREFUSED') message = '连不上：服务端没在监听，确认 LX 已启动、端口正确'
    else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') message = '域名解析失败，换成 IP 地址试试'
    else if (code === 'ETIMEDOUT') message = '连接超时，两台机器可能不在一个局域网'
    return { url: server, ok: false, online: false, message }
  }
}

/** 对外暴露的配置（密码掩码，避免明文出现在网络响应里） */
function publicConfig() {
  return {
    port: config.port,
    host: config.host,
    clientDir: config.clientDir,
    deviceId: config.deviceId,
    appVersion: config.appVersion,
    buildId: config.buildId,
    detectedVersion: detected.version,
    detectedSource: detected.source,
    userAgent: `LunaPC/${config.appVersion}(${config.buildId})`,
    servers: config.servers.map(s => ({ url: s.url, password: s.password ? '********' : '' }))
  }
}

function findServerPassword(url) {
  const s = config.servers.find(x => x.url === url)
  return s ? s.password : ''
}

/** 应用前端提交的新配置：保存、热重启监听、重新登记服务器 */
async function applyConfig(rawBody) {
  const patch = JSON.parse(rawBody || '{}')
  const oldServers = config.servers
  const oldPort = config.port

  if (patch.port != null) {
    const p = Number(patch.port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('端口必须是 1-65535 的整数')
    config.port = p
  }
  if (patch.host != null) config.host = String(patch.host || '0.0.0.0')
  if (patch.clientDir != null) config.clientDir = String(patch.clientDir || '')
  if (patch.deviceId != null) config.deviceId = String(patch.deviceId || '7300000000000001')
  if (patch.appVersion != null) config.appVersion = String(patch.appVersion || '') || detected.version || '3.7.0'
  if (patch.buildId != null) config.buildId = String(patch.buildId || '30080000')
  if (Array.isArray(patch.servers)) {
    config.servers = patch.servers
      .map(s => {
        const url = String(s.url || '').trim()
        let password = String(s.password == null ? '' : s.password)
        if (password === '********') password = findServerPassword(url) // 未改动，沿用旧值
        return { url, password }
      })
      .filter(s => s.url)
  }

  // 端口变更 → 热重启监听（失败回滚到仍在监听的端口）
  let portChanged = false
  let bindError = ''
  if (config.port !== oldPort) {
    try {
      await rebind()
      portChanged = true
    } catch (e) {
      bindError = e.message
      config.port = oldPort
    }
  }

  saveConfig()

  // 登记到所有服务器；被移除的服务器发空地址清空
  const results = []
  for (const s of config.servers) {
    results.push(await pairTo(s.url, s.password, selfUrl()))
  }
  const removed = oldServers.filter(o => !config.servers.some(n => n.url === o.url))
  for (const r of removed) {
    if (r.url) results.push(await pairTo(r.url, r.password, ''))
  }

  return { success: true, portChanged, bindError, selfUrl: selfUrl(), config: publicConfig(), results }
}

let httpServer = null

function requestHandler(req, res) {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj))
  }
  const urlPath = (req.url || '/').split('?')[0]

  // 网页配置页
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(fs.readFileSync(PAGE_PATH, 'utf8'))
  }
  if (req.method === 'GET' && urlPath === '/api/config') {
    return send(200, publicConfig())
  }
  if (req.method === 'POST' && urlPath === '/api/config') {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      (async () => {
        try {
          const result = await applyConfig(body)
          send(200, result)
        } catch (e) {
          send(400, { success: false, error: String(e && e.message || e) })
        }
      })()
    })
    return
  }

  // 原有签名接口（保持不变）
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('ok')
  }
  if (req.method === 'GET' && req.url.startsWith('/config')) {
    return send(200, {
      device_id: config.deviceId,
      deviceId: config.deviceId,
      user_agent: `LunaPC/${config.appVersion}(${config.buildId})`,
      app_version: config.appVersion,
      build_id: config.buildId
    })
  }
  if (req.method === 'POST' && req.url.startsWith('/sign')) {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}')
        if (!payload.url) return send(400, { error: 'url is required' })
        const headers = signHeaders(payload.url, payload.headers)
        if (!Object.keys(headers).length) return send(500, { error: 'bdms 未生成签名头（deviceId 可能无效）' })
        send(200, { headers })
      } catch (e) {
        send(500, { error: String(e && e.message || e) })
      }
    })
    return
  }
  send(404, { error: 'not found' })
}

/** 关闭旧监听、在新端口/地址上重新监听（热生效） */
function rebind() {
  return new Promise((resolve, reject) => {
    const newServer = http.createServer(requestHandler)
    newServer.on('error', reject)
    newServer.listen(config.port, config.host, () => {
      if (httpServer) { try { httpServer.close() } catch {} }
      httpServer = newServer
      console.log(`[signer] 监听已切换到 ${config.host}:${config.port}`)
      resolve()
    })
  })
}

/** --setup 用来「换 LX 服务器」：即使已有配置也强制重新问一遍（返回第一个服务器） */
function askSetup(defaults) {
  const d = defaults || {}
  return new Promise(resolve => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout })
    console.log('')
    console.log(d.servers && d.servers.length ? '修改连接设置（直接回车 = 保持原来的值）：' : '第一次使用，请填两项（以后会记住）：')
    const q1 = d.servers && d.servers.length
      ? `  LX 服务器地址 [${d.servers[0].url}]: `
      : '  LX 服务器地址（例：192.168.1.120:8027）: '
    rl.question(q1, server => {
      const q2 = d.servers && d.servers.length ? '  后台管理员密码（回车保持不变）: ' : '  后台管理员密码: '
      rl.question(q2, password => {
        rl.close()
        resolve({
          server: String(server || '').trim() || (d.servers && d.servers[0] && d.servers[0].url) || '',
          password: String(password || '').trim() || (d.servers && d.servers[0] && d.servers[0].password) || ''
        })
      })
    })
  })
}

httpServer = http.createServer(requestHandler)
httpServer.listen(config.port, config.host, () => {
  const all = lanAddresses()
  const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3)
  const ips = all.filter(ip => !ip.startsWith('169.254.')).sort((a, b) => rank(a) - rank(b))
  const primary = ips[0] || '127.0.0.1'
  console.log('')
  console.log('==============================================')
  console.log('  汽水签名器已启动，保持本窗口开启即可')
  console.log('==============================================')
  console.log('  配置页（浏览器打开）：')
  console.log(`      http://localhost:${config.port}`)
  if (ips.length) console.log(`      局域网：http://${primary}:${config.port}`)
  console.log('')
  void (async () => {
    const forceSetup = args.includes('--setup')
    // 优先级：--setup > 配置文件 > 首次交互填写
    if (forceSetup) {
      const answers = await askSetup(config)
      if (answers.server) {
        config.servers = [{ url: answers.server, password: answers.password }]
        saveConfig()
      }
    } else if (!config.servers.length && process.stdin.isTTY) {
      // 首次运行且无配置：交互询问（网页为主，交互为辅）
      const answers = await askSetup(config)
      if (answers.server) {
        config.servers = [{ url: answers.server, password: answers.password }]
        saveConfig()
      }
    }

    if (config.servers.length) {
      console.log(`  开始登记 ${config.servers.length} 台 LX 服务器…`)
      for (const s of config.servers) {
        const r = await pairTo(s.url, s.password, selfUrl())
        console.log(`  ${r.ok ? (r.online ? '✓' : '△') : '✗'} ${s.url} → ${r.message}`)
      }
    } else {
      console.log('  提示：打开配置页可添加 LX 服务器（支持多台），保存后自动登记。')
      console.log('  想自动登记，下次双击时按提示填服务器地址和后台密码。')
    }
    console.log('')
  })()
})
