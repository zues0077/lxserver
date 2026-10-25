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
 *   GET  /health   → 200 "ok"
 *   GET  /config   → {device_id}      （可选，告诉服务端用哪个设备身份）
 *   POST /sign     {url, method, body, headers} → {headers:{X-Helios, X-Medusa}}
 *
 * 为什么必须在这台机器上跑：签名由字节的原生安全库逐请求生成，
 * 该库只有 Windows/macOS 二进制，Linux 容器里没有、也搬不过去。
 *
 * 用法：
 *   node signer.js
 *   node signer.js --port 18080 --client "C:\...\Soda Music\3.7.0"
 *   set SODA_DEVICE_ID=7300000000000001 && node signer.js
 *
 * 安全提醒：本服务会看到完整请求头（含 Cookie），只在本机/内网监听，别暴露公网。
 */

const http = require('http')
const path = require('path')
const fs = require('fs')

// ---------------- 本地配置（记住服务器地址/密码，下次双击不用再填） ----------------
const CONFIG_PATH = path.join(__dirname, 'signer-config.json')

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} } catch { return {} }
}
function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
    console.log(`[signer] 配置已保存：${CONFIG_PATH}`)
  } catch (e) {
    console.log(`[signer] 配置保存失败（不影响本次运行）：${e.message}`)
  }
}

/** 问两个问题就够了：LX 服务器地址 + 后台密码（回车 = 保持原值） */
function askSetup(defaults) {
  const d = defaults || {}
  return new Promise(resolve => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout })
    console.log('')
    console.log(d.server ? '修改连接设置（直接回车 = 保持原来的值）：' : '第一次使用，请填两项（以后会记住）：')
    const q1 = d.server
      ? `  LX 服务器地址 [${d.server}]: `
      : '  LX 服务器地址（例：192.168.1.120:8027）: '
    rl.question(q1, server => {
      const q2 = d.password ? '  后台管理员密码（回车保持不变）: ' : '  后台管理员密码: '
      rl.question(q2, password => {
        rl.close()
        resolve({
          server: String(server || '').trim() || d.server || '',
          password: String(password || '').trim() || d.password || '',
        })
      })
    })
  })
}

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const savedCfg = loadConfig()
const PORT = Number(arg('port', process.env.SIGNER_PORT || savedCfg.port || 18080))
const CLIENT_DIR = arg('client', process.env.SODA_CLIENT_DIR || savedCfg.clientDir || '')
const DEVICE_ID = arg('device', process.env.SODA_DEVICE_ID || savedCfg.deviceId || '7300000000000001')
const APP_VER = arg('version', process.env.SODA_VERSION || '3.7.0')
const BUILD_ID = arg('build', process.env.SODA_BUILD_ID || '30080000')

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
  if (CLIENT_DIR) candidates.push(path.join(CLIENT_DIR, 'resources', 'app.asar.unpacked'))
  if (root) {
    candidates.push(path.join(root, APP_VER, 'resources', 'app.asar.unpacked'))
    candidates.push(path.join(root, 'current', 'resources', 'app.asar.unpacked'))
    candidates.push(path.join(root, 'Packages', APP_VER, 'app.asar.unpacked'))
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
  // 优先用 --version 指定的版本（默认 3.7.0，是实测可用的那版），否则取最高版本
  const prefer = found.find(p => p.includes(`${path.sep}${APP_VER}${path.sep}`))
  if (prefer) return prefer
  const rank = p => {
    const m = p.match(/(\d+)\.(\d+)\.(\d+)/)
    return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0
  }
  found.sort((a, b) => rank(b) - rank(a))
  return found[0]
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
const bdms = require(path.join(unpacked, 'bdms.node'))
bdms.init({ deviceId: DEVICE_ID })
console.log(`[signer] 已加载 bdms.node：${unpacked}`)
console.log(`[signer] deviceId=${DEVICE_ID} UA=LunaPC/${APP_VER}(${BUILD_ID})`)

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

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj))
  }
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('ok')
  }
  if (req.method === 'GET' && req.url.startsWith('/config')) {
    return send(200, { device_id: DEVICE_ID, user_agent: `LunaPC/${APP_VER}(${BUILD_ID})` })
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
})

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

/** --pair：把地址自动登记到 lxserver，用户不用手抄 */
async function pairTo(server, password, selfUrl) {
  // HTTP 请求头只允许 ASCII，密码里有中文/全角字符会直接抛 ByteString 错误，
  // 提前拦下来给一句人话提示，否则报错信息会完全看不出原因。
  if (password && /[^\x20-\x7e]/.test(password)) {
    console.log('[pair] ✗ 后台密码含中文或全角字符，HTTP 请求头放不下。')
    console.log('       请改用密码里的英文/数字部分，或先把后台密码改成纯英文数字。')
    return false
  }
  // 用户常常只填 IP:端口，漏了 http://，这里自动补，不让他卡在格式上
  let base = String(server || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base
  const url = `${base}/api/music/prefetch/signer`
  const body = JSON.stringify({ url: selfUrl })
  const headers = { 'Content-Type': 'application/json' }
  if (password) headers['x-frontend-auth'] = password
  try {
    const res = await fetch(url, { method: 'POST', headers, body })
    const text = await res.text()
    let data = {}
    try { data = JSON.parse(text) } catch { }
    if (res.ok && data.success) {
      const d = data.data || {}
      console.log(d.online ? `[pair] ✓ 已登记到 ${server}，连接正常` : `[pair] 已登记，但探测失败：${d.message || ''}`)
      return true
    }
    console.log(`[pair] ✗ 登记失败（HTTP ${res.status}）：${data.error || data.message || text.slice(0, 120)}`)
    return false
  } catch (e) {
    // fetch 失败时 e.message 只有 "fetch failed"，真正的 code 在 e.cause 里
    const code = e.cause && (e.cause.code || e.cause.message)
    console.log(`[pair] ✗ 连不上 ${server}：${e.message}${code ? `（${code}）` : ''}`)
    if (code === 'ECONNREFUSED') console.log('       服务端没在监听：确认 LX 已启动，端口没写错。')
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') console.log('       域名解析失败：换成 IP 地址试试。')
    if (code === 'ETIMEDOUT') console.log('       连接超时：两台机器是不是不在一个局域网？')
    return false
  }
}

server.listen(PORT, '0.0.0.0', () => {
  const all = lanAddresses()
  // 家庭/办公网优先：先给 192.168.x，再给 10.x，最后才是虚拟网卡；链路本地(169.254)屏掉
  const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3)
  const ips = all.filter(ip => !ip.startsWith('169.254.')).sort((a, b) => rank(a) - rank(b))
  const primary = ips[0] || '127.0.0.1'
  console.log('')
  console.log('==============================================')
  console.log('  汽水签名器已启动，保持本窗口开启即可')
  console.log('==============================================')
  console.log('  把下面这一行填进 LX 后台「平台账号 → 汽水签名器」：')
  console.log('')
  console.log(`      http://${primary}:${PORT}`)
  console.log('')
  if (ips.length > 1) {
    console.log('  如果上一条填了显示不可达，换这些试试（同一局域网的那条）：')
    for (const ip of ips.slice(1)) console.log(`      http://${ip}:${PORT}`)
    console.log('')
  }
  if (!ips.length) console.log('  （没检测到局域网 IP，请确认已连上路由器）')
  console.log('')
  const selfUrl = `http://${primary}:${PORT}`
  void (async () => {
    // --setup 用来「换 LX 服务器」：即使已有配置也强制重新问一遍
    const forceSetup = args.includes('--setup')
    // 优先级：命令行 --pair > 配置文件 > 首次交互填写
    let server = forceSetup ? '' : arg('pair', process.env.SIGNER_PAIR_SERVER || savedCfg.server || '')
    let password = forceSetup ? '' : arg('password', process.env.SIGNER_PAIR_PASSWORD || savedCfg.password || '')

    const canAsk = (process.stdin.isTTY || forceSetup) && !server
    if (canAsk) {
      const answers = await askSetup(savedCfg)
      server = answers.server || server
      password = answers.password || password
      if (server && !/^https?:\/\//i.test(server)) server = 'http://' + server
      if (server) {
        saveConfig({ server, password, port: PORT, deviceId: DEVICE_ID })
      }
    }

    if (!server) {
      console.log('  没有填写服务器地址：请手动把上面那行地址贴到 LX 后台即可。')
      console.log('  想自动登记，下次双击时按提示填服务器地址和后台密码。')
      console.log('')
      return
    }

    console.log(`  正在把地址登记到 ${server} …`)
    const ok = await pairTo(server, password, selfUrl)
    if (ok) {
      console.log('')
      console.log('  ✅ 已自动登记，LX 后台可以直接用了。')
      console.log('     以后双击本程序即可，不用再填。')
    } else {
      console.log('')
      console.log('  ⚠️ 自动登记失败。不要紧，可以手动复制上面那行地址，')
      console.log('     到 LX 后台「平台账号 → 汽水签名器」粘贴并点「保存并测试」。')
    }
    console.log('')
  })()
})
