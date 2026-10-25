/**
 * 汽水签名器（远程）—— 探活与签名请求
 *
 * 为什么是「远程」：整曲签名只能由官方 Windows 客户端的原生安全组件
 * （bdms.node / metasecml.dll）逐请求生成，linux/amd64、arm64 镜像里既没有也搬不过去。
 * 所以 NAS 侧只做客户端：把「要发的请求」交给一台装得上客户端的机器签，再原样发出去。
 *
 * 配置方式只有一个环境变量（刻意不做进界面，避免把「安装目录 / URL / Token」三件套
 * 摆到普通用户面前 —— go-music-dl 的账号页就是这么变繁琐的）：
 *
 *   QISHUI_SIGNER_URL=http://192.168.1.10:18080
 *   QISHUI_SIGNER_TOKEN=可选
 *
 * 协议（与 sodam / music-lib 的 signer 兼容，尽量宽容）：
 *   GET  {base}/health              → 任意 2xx 即视为在线
 *   GET  {base}/config              → 可选，返回 {device_id, iid, fp}
 *   POST {base}/sign  {url, method, body, headers} → {headers:{...}} 或直接 {…header 键值}
 *
 * 注意：签名器能看到完整请求头（含 Cookie），只能指向自己信任的机器。
 */

import { request } from '../musicAccount/http'

const HEALTH_TIMEOUT = 3000
const SIGN_TIMEOUT = 8000
const STATUS_TTL = 60 * 1000

export interface SignerStatus {
  configured: boolean
  online: boolean
  url: string
  message: string
}

let statusCache: { at: number; value: SignerStatus } | null = null

/**
 * 签名器地址：后台页面保存的配置优先，其次环境变量。
 * 这样普通用户不用改 docker-compose / 环境变量，在管理页填一次就行。
 */
export function signerUrl(): string {
  const cfg = String((global as any).lx?.config?.['qishui.signerUrl'] || '').trim()
  const raw = cfg || String(process.env.QISHUI_SIGNER_URL || '').trim()
  return raw.replace(/\/+$/, '')
}

/** 地址来源，便于界面提示「当前用的是后台配置还是环境变量」 */
export function signerSource(): 'config' | 'env' | 'none' {
  const cfg = String((global as any).lx?.config?.['qishui.signerUrl'] || '').trim()
  if (cfg) return 'config'
  if (String(process.env.QISHUI_SIGNER_URL || '').trim()) return 'env'
  return 'none'
}

export function isConfigured(): boolean {
  return signerUrl().length > 0
}

function authHeaders(): Record<string, string> {
  const token = String(process.env.QISHUI_SIGNER_TOKEN || '').trim()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 探活（带 60 秒缓存，避免每首歌都打一次） */
export async function status(force = false): Promise<SignerStatus> {
  const base = signerUrl()
  if (!base) {
    return { configured: false, online: false, url: '', message: '未配置 QISHUI_SIGNER_URL，受限曲只能记录为待补' }
  }
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL) {
    return statusCache.value
  }

  let value: SignerStatus
  try {
    const resp = await request<any>(`${base}/health`, {
      headers: authHeaders(),
      timeout: HEALTH_TIMEOUT,
      raw: true,
    })
    const ok = resp.statusCode >= 200 && resp.statusCode < 300
    value = {
      configured: true,
      online: ok,
      url: base,
      message: ok ? '签名器在线' : `签名器返回 HTTP ${resp.statusCode}`,
    }
  } catch (e: any) {
    value = {
      configured: true,
      online: false,
      url: base,
      // 离线不是错误：整轮跳过即可，别把用户吓一跳
      message: `签名器不可达：${e?.message || e}`,
    }
  }
  statusCache = { at: Date.now(), value }
  return value
}

/** 取签名器的设备指纹（可选；拿不到就返回 null，由调用方用默认值） */
export async function deviceConfig(): Promise<{ deviceId: string; iid: string; fp: string } | null> {
  const base = signerUrl()
  if (!base) return null
  try {
    const resp = await request<any>(`${base}/config`, { headers: authHeaders(), timeout: HEALTH_TIMEOUT })
    const data: any = resp.body || {}
    const deviceId = String(data.device_id || data.deviceId || '')
    const iid = String(data.iid || data.install_id || '')
    const fp = String(data.fp || '')
    if (!deviceId && !iid && !fp) return null
    return { deviceId, iid, fp }
  } catch {
    return null
  }
}

/**
 * 让签名器给一次请求签名。
 * @returns 需要附加到请求上的头（x-helios / x-medusa 等）
 */
export async function sign(target: {
  url: string
  method?: string
  body?: string
  headers?: Record<string, string>
}): Promise<Record<string, string>> {
  const base = signerUrl()
  if (!base) throw new Error('未配置汽水签名器（QISHUI_SIGNER_URL）')

  const resp = await request<any>(`${base}/sign`, {
    method: 'post',
    json: {
      url: target.url,
      method: target.method || 'GET',
      body: target.body || '',
      headers: target.headers || {},
    },
    headers: authHeaders(),
    timeout: SIGN_TIMEOUT,
  })
  const body: any = resp.body || {}
  const headers: any = body.headers || body.data?.headers || body
  if (!headers || typeof headers !== 'object') {
    throw new Error('签名器返回格式无法识别（期望 {headers:{…}}）')
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string' && v) out[k] = v
  }
  if (!Object.keys(out).length) throw new Error('签名器没有返回任何签名头')
  return out
}

/** 测试用：清掉探活缓存 */
export function resetStatusCache(): void {
  statusCache = null
}
