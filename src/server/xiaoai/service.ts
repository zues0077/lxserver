import { MinaAuth, type LoginResult, type QRPollResult, type TokenInfo } from './auth'
import { MinaClient, type MinaDevice } from './client'
import { httpRequest } from './http'
import {
  loadConfig,
  saveConfig,
  loadToken,
  saveToken,
  normalizeDevice,
  type XiaoAiConfig,
  type XiaoAiDevice,
} from './config'

/** 单个设备的操作结果 */
export interface DeviceActionResult {
  deviceId: string
  name: string
  ok: boolean
  error?: string
}

/** 对外暴露的配置（含设备与登录状态，不含任何凭据） */
export interface XiaoAiPublicConfig {
  configured: boolean
  loginState: 'none' | 'valid' | 'expired'
  loginMethod: string
  account: string
  serverBaseUrl: string
  streamPath: string
  keepLight: boolean
  disabledModels: string[]
  selectedDeviceIds: string[]
  devices: XiaoAiDevice[]
  lastSyncAt: number | null
}

class XiaoAiService {
  private auth = new MinaAuth()
  private client: MinaClient | null = null
  private inited = false

  /** 首次使用时从磁盘恢复登录态 */
  private ensureInit() {
    if (this.inited) return
    this.inited = true
    const token = loadToken()
    if (token) this.auth.restoreToken(token)
  }

  /** 当前登录态 */
  getLoginState(): 'none' | 'valid' | 'expired' {
    this.ensureInit()
    const token = this.auth.getToken()
    if (!token?.serviceToken) return 'none'
    return this.auth.isTokenValid() ? 'valid' : 'expired'
  }

  getPublicConfig(): XiaoAiPublicConfig {
    this.ensureInit()
    const config = loadConfig()
    const token = this.auth.getToken()
    return {
      configured: !!token?.serviceToken,
      loginState: this.getLoginState(),
      loginMethod: token?.loginMethod || '',
      account: token?.account ? maskAccount(token.account) : config.account ? maskAccount(config.account) : '',
      serverBaseUrl: config.serverBaseUrl,
      streamPath: config.streamPath || '/api/music/xiaoai/stream',
      keepLight: config.keepLight !== false,
      disabledModels: config.disabledModels,
      selectedDeviceIds: config.selectedDeviceIds,
      devices: config.devices,
      lastSyncAt: config.lastSyncAt,
    }
  }

  updateConfig(patch: Record<string, unknown>): XiaoAiPublicConfig {
    const next: Partial<XiaoAiConfig> = {}
    if (patch.serverBaseUrl !== undefined) next.serverBaseUrl = String(patch.serverBaseUrl || '').trim()
    if (patch.streamPath !== undefined) next.streamPath = String(patch.streamPath || '').trim() || '/api/music/xiaoai/stream'
    if (patch.keepLight !== undefined) next.keepLight = !!patch.keepLight
    if (patch.disabledModels !== undefined) next.disabledModels = Array.isArray(patch.disabledModels) ? patch.disabledModels.map(String) : []
    if (patch.selectedDeviceIds !== undefined) {
      next.selectedDeviceIds = Array.isArray(patch.selectedDeviceIds) ? patch.selectedDeviceIds.map(String) : []
    }
    saveConfig(next)
    return this.getPublicConfig()
  }

  // ===== 登录 =====

  /** 扫码登录第一步：拿二维码 */
  async startQrLogin() {
    this.ensureInit()
    const info = await this.auth.getQRCode()
    if (!info) throw new Error('获取二维码失败，请稍后重试')
    // 顺手由服务端把二维码图片取回来转成 data URL：
    // 这样浏览器不用直连 account.xiaomi.com 也能显示二维码（内网/受限网络下更稳）。
    let imageDataUrl = ''
    if (info.qrcodeUrl) {
      try {
        const res = await httpRequest(info.qrcodeUrl, { binary: true, timeoutMs: 15000 })
        if (res.binary?.length) {
          const contentType = String(res.headers['content-type'] || 'image/png').split(';')[0].trim()
          imageDataUrl = `data:${contentType};base64,${res.binary.toString('base64')}`
        }
      } catch (error: any) {
        console.warn('[XiaoAi] 二维码图片获取失败，回退为直链:', error?.message || error)
      }
    }
    return { qrcodeUrl: info.qrcodeUrl, loginUrl: info.loginUrl, qrcodeImage: imageDataUrl }
  }

  /** 扫码登录第二步：轮询状态；成功后自动持久化登录态 */
  async pollQrLogin(): Promise<QRPollResult> {
    const result = await this.auth.pollQRCode()
    if (result.state === 'confirmed' && result.tokenInfo) this.persistToken(result.tokenInfo)
    return result
  }

  async loginWithPassword(account: string, password: string): Promise<LoginResult> {
    this.ensureInit()
    if (!account || !password) throw new Error('请填写小米账号与密码')
    const result = await this.auth.loginWithPassword(account, password)
    if (result.state === 'success' && result.tokenInfo) this.persistToken(result.tokenInfo)
    else if (result.state === 'success') this.persistToken(this.auth.getToken()!)
    return result
  }

  async loginWithCaptcha(captcha: string): Promise<LoginResult> {
    const result = await this.auth.loginWithCaptcha(captcha)
    if (result.state === 'success' && result.tokenInfo) this.persistToken(result.tokenInfo)
    return result
  }

  async loginWithVerifyCode(code: string): Promise<LoginResult> {
    const result = await this.auth.loginWithVerifyCode(code)
    if (result.state === 'success' && result.tokenInfo) this.persistToken(result.tokenInfo)
    return result
  }

  /** 用浏览器 Cookie 里的 passToken + userId 直接登录 */
  async loginByCookie(params: { passToken: string; userId: string; cUserId?: string }): Promise<LoginResult> {
    this.ensureInit()
    const passToken = String(params.passToken || '').trim()
    const userId = String(params.userId || '').trim()
    if (!passToken || !userId) throw new Error('请填写 passToken 与 userId')
    const result = await this.auth.loginByPassToken(passToken, userId, String(params.cUserId || '').trim())
    if (result.state === 'success' && result.tokenInfo) this.persistToken(result.tokenInfo)
    return result
  }

  /** 退出登录：清空内存与磁盘上的凭据 */
  logout() {
    this.ensureInit()
    this.auth = new MinaAuth()
    this.client = null
    saveToken(null)
    saveConfig({ selectedDeviceIds: [], devices: [], lastSyncAt: null })
    return { ok: true }
  }

  private persistToken(token: TokenInfo) {
    saveToken(token)
    if (this.client) this.client.updateToken(token)
    if (token.account) saveConfig({ account: token.account })
  }

  // ===== 设备 =====

  /** 拉取设备列表（refresh=false 且有缓存时直接用缓存） */
  async listDevices(refresh = false): Promise<{ devices: XiaoAiDevice[]; lastSyncAt: number | null; selectedDeviceIds: string[] }> {
    this.ensureInit()
    const config = loadConfig()
    if (!refresh && config.devices.length) {
      return { devices: config.devices, lastSyncAt: config.lastSyncAt, selectedDeviceIds: config.selectedDeviceIds }
    }
    const client = await this.getClient()
    const list = await client.getDeviceList()
    const devices = list.map(normalizeDevice).filter(item => item.deviceID)
    // 清掉已失效的选中项
    const selected = config.selectedDeviceIds.filter(id => devices.some(device => device.deviceID === id))
    const lastSyncAt = Date.now()
    saveConfig({ devices, selectedDeviceIds: selected, lastSyncAt })
    return { devices, lastSyncAt, selectedDeviceIds: selected }
  }

  /** 组装好的设备清单（含用户选中的设备） */
  private async resolveTargets(deviceIds?: string[]): Promise<Array<{ deviceID: string; name: string; hardware: string }>> {
    const config = loadConfig()
    const ids = Array.isArray(deviceIds) && deviceIds.length ? deviceIds : config.selectedDeviceIds
    if (!ids.length) throw new Error('请先在小爱设置里选择要播放的设备')
    const devices = config.devices.length ? config.devices : (await this.listDevices(true)).devices
    return ids.map(id => {
      const found = devices.find(device => device.deviceID === id)
      return { deviceID: id, name: found?.name || id, hardware: found?.hardware || '' }
    })
  }

  /** 把一次设备操作 fan-out 到多个设备，单个设备失败不影响其它设备 */
  private async fanOut(
    deviceIds: string[] | undefined,
    action: string,
    run: (client: MinaClient, deviceId: string, hardware: string) => Promise<boolean>
  ): Promise<DeviceActionResult[]> {
    const targets = await this.resolveTargets(deviceIds)
    const client = await this.getClient()
    return Promise.all(
      targets.map(async target => {
        try {
          const ok = await run(client, target.deviceID, target.hardware)
          return { deviceId: target.deviceID, name: target.name, ok }
        } catch (error: any) {
          console.warn(`[XiaoAi] ${action} 失败 (${target.name}):`, error?.message || error)
          return { deviceId: target.deviceID, name: target.name, ok: false, error: error?.message || String(error) }
        }
      })
    )
  }

  // ===== 播放控制 =====

  /**
   * 投播：把同一个音频直链同时推给多台音箱。
   * streamUrl 必须是对音箱可达的地址（通常是本服务的签名中转地址）。
   */
  async play(params: { streamUrl: string; deviceIds?: string[]; song?: { name?: string; singer?: string } }) {
    const streamUrl = String(params.streamUrl || '').trim()
    if (!streamUrl) throw new Error('缺少可投送的播放地址')
    const config = loadConfig()
    const results = await this.fanOut(params.deviceIds, 'play', (client, deviceId, hardware) =>
      client.playUrl(deviceId, streamUrl, hardware, { keepLight: config.keepLight !== false, disabledModels: config.disabledModels })
    )
    return { results, success: results.some(item => item.ok), song: params.song || null }
  }

  async pause(deviceIds?: string[]) {
    const results = await this.fanOut(deviceIds, 'pause', (client, deviceId) => client.playerPause(deviceId))
    return { results, success: results.some(item => item.ok) }
  }

  async resume(deviceIds?: string[]) {
    const results = await this.fanOut(deviceIds, 'resume', (client, deviceId) => client.playerPlay(deviceId))
    return { results, success: results.some(item => item.ok) }
  }

  async stop(deviceIds?: string[]) {
    const results = await this.fanOut(deviceIds, 'stop', (client, deviceId) => client.playerStop(deviceId))
    return { results, success: results.some(item => item.ok) }
  }

  async next(deviceIds?: string[]) {
    const results = await this.fanOut(deviceIds, 'next', (client, deviceId) => client.playerNext(deviceId))
    return { results, success: results.some(item => item.ok) }
  }

  async prev(deviceIds?: string[]) {
    const results = await this.fanOut(deviceIds, 'prev', (client, deviceId) => client.playerPrev(deviceId))
    return { results, success: results.some(item => item.ok) }
  }

  /** 设置音量（多设备同时生效） */
  async setVolume(volume: number, deviceIds?: string[]) {
    const value = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)))
    const results = await this.fanOut(deviceIds, 'volume', (client, deviceId) => client.setVolume(deviceId, value))
    return { volume: value, results, success: results.some(item => item.ok) }
  }

  /** 单设备播放状态（用于界面回显） */
  async getStatus(deviceId: string) {
    const config = loadConfig()
    const target = deviceId || config.selectedDeviceIds[0] || config.devices[0]?.deviceID || ''
    if (!target) throw new Error('没有可查询的设备')
    const client = await this.getClient()
    const raw = await client.getPlayerStatus(target)
    let info: Record<string, unknown> = {}
    const rawInfo = (raw?.data as any)?.info
    if (typeof rawInfo === 'string') {
      try {
        info = JSON.parse(rawInfo)
      } catch {
        info = {}
      }
    }
    const position = Number(info.position)
    const duration = Number(info.duration)
    const hasPosition = Number.isFinite(position) && position > 0
    const hasDuration = Number.isFinite(duration) && duration > 0
    return {
      deviceId: target,
      playing: Number(info.status) === 1,
      volume: typeof info.volume === 'number' ? info.volume : -1,
      title: String(info.title || info.audioName || ''),
      durationMs: hasDuration ? duration : 0,
      positionMs: hasPosition ? position : 0,
      // 设备上报的位置/总长单位随固件而异（秒或毫秒），因此额外给出无量纲的播放进度比例。
      // 自动续播的前端只看这个比例，就不必关心单位差异。
      hasProgress: hasPosition && hasDuration,
      progressRatio: hasPosition && hasDuration ? Math.min(1, position / duration) : -1,
      raw: info,
    }
  }

  // ===== 内部：客户端与自动续期 =====

  private async getClient(): Promise<MinaClient> {
    this.ensureInit()
    const token = this.auth.getToken()
    if (!token?.serviceToken) throw new Error('尚未登录小米账号')

    if (!this.client) {
      this.client = new MinaClient(token, async () => this.refreshByPassToken())
    } else {
      this.client.updateToken(token)
    }

    // serviceToken 快过期时先静默续期，避免首个请求 401 白跑一趟
    if (!this.auth.isTokenValid()) await this.refreshByPassToken()
    return this.client
  }

  /** 用 passToken 静默续期 */
  private async refreshByPassToken(): Promise<boolean> {
    const token = this.auth.getToken()
    if (!token?.passToken || !token.userId) return false
    try {
      const result = await this.auth.loginByPassToken(token.passToken, token.userId, token.cUserId, token.account)
      if (result.state === 'success' && result.tokenInfo) {
        this.persistToken(result.tokenInfo)
        console.log('[XiaoAi] serviceToken 已续期')
        return true
      }
      console.warn('[XiaoAi] serviceToken 续期失败:', result.error || '未知原因')
      return false
    } catch (error: any) {
      console.warn('[XiaoAi] serviceToken 续期异常:', error?.message || error)
      return false
    }
  }
}

const maskAccount = (value: string) => {
  const text = String(value || '')
  if (!text) return ''
  if (text.length <= 3) return `${text[0] || ''}***`
  return `${text.slice(0, 2)}***${text.slice(-1)}`
}

export const xiaoAiService = new XiaoAiService()
