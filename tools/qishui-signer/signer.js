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

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const PORT = Number(arg('port', process.env.SIGNER_PORT || 18080))
const CLIENT_DIR = arg('client', process.env.SODA_CLIENT_DIR || '')
const DEVICE_ID = arg('device', process.env.SODA_DEVICE_ID || '7300000000000001')
const APP_VER = arg('version', process.env.SODA_VERSION || '3.7.0')
const BUILD_ID = arg('build', process.env.SODA_BUILD_ID || '30080000')

/** 在几个常见位置找 app.asar.unpacked */
function findUnpacked() {
  const candidates = []
  if (CLIENT_DIR) candidates.push(path.join(CLIENT_DIR, 'resources', 'app.asar.unpacked'))
  const local = process.env.LOCALAPPDATA || ''
  if (local) candidates.push(path.join(local, 'Programs', 'Soda Music', APP_VER, 'resources', 'app.asar.unpacked'))
  if (local) candidates.push(path.join(local, 'Programs', 'Soda Music', 'current', 'resources', 'app.asar.unpacked'))
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'bdms.node'))) return c
  }
  // 兜底：在 3.x 目录里翻
  const root = local ? path.join(local, 'Programs', 'Soda Music') : ''
  if (root && fs.existsSync(root)) {
    for (const dir of fs.readdirSync(root)) {
      const p = path.join(root, dir, 'resources', 'app.asar.unpacked')
      if (fs.existsSync(path.join(p, 'bdms.node'))) return p
    }
  }
  return ''
}

const unpacked = findUnpacked()
if (!unpacked) {
  console.error('[signer] 找不到 app.asar.unpacked/bdms.node')
  console.error('  1) 确认这台电脑装过「汽水音乐」官方客户端并至少登录过一次')
  console.error('  2) 或用 --client 指定目录，例如：')
  console.error('     node signer.js --client "C:////Users////你////AppData////Local////Programs////Soda Music////3.7.0"')
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
  const url = `${server.replace(/\/+$/, '')}/api/music/prefetch/signer`
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
    } else {
      console.log(`[pair] ✗ 登记失败（HTTP ${res.status}）：${data.error || data.message || text.slice(0, 120)}`)
    }
  } catch (e) {
    console.log(`[pair] ✗ 连不上 ${server}：${e.message}`)
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
  const pairServer = arg('pair', process.env.SIGNER_PAIR_SERVER || '')
  const pairPwd = arg('password', process.env.SIGNER_PAIR_PASSWORD || '')
  if (pairServer) {
    void pairTo(pairServer, pairPwd, `http://${primary}:${PORT}`)
        .then(() => console.log('  注册完成后可以关闭这个提示，服务继续运行。'))
  } else {
    console.log('  小技巧：加 --pair http://<NAS地址>:8027 --password <后台密码> 可自动登记，免手抄。')
  }
  console.log('')
})
