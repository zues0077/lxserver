import os from 'node:os'
import { MinaAuth, type LoginResult, type QRPollResult, type TokenInfo } from './auth'
import { MinaClient, PLAY_STATUS_PAUSED, type MinaDevice } from './client'
import { DEFAULT_MUSIC_AUDIO_ID, needUseMusicApi } from './constants'
import { isFfmpegAvailable } from './transcode'
import { syncLog } from '../../utils/log4js'
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
  /** 暂停操作的最终结果：paused 正常暂停 / stopped 降级为停止（无法原位续播） */
  state?: 'paused' | 'stopped' | 'failed'
}

/** 对外暴露的配置（含设备与登录状态，不含任何凭据） */
export interface XiaoAiPublicConfig {
  configured: boolean
  loginState: 'none' | 'valid' | 'expired'
  loginMethod: string
  account: string
  serverBaseUrl: string
  /** 服务端探测到的局域网地址建议值（形如 http://192.168.1.10:9527），供界面一键填入 */
  suggestedBaseUrl: string
  streamPath: string
  keepLight: boolean
  /** 触屏音箱显示封面与歌词（默认关闭，开启后可能改播小米云端试听） */
  touchscreenLyrics: boolean
  /** 投送前先缓存整首音频 */
  cacheBeforePlay: boolean
  /** 推送格式统一转 mp3 */
  unifyMp3: boolean
  /** 切歌提前量偏移（秒，-30..30） */
  songTransitionOffset: number
  /** 转码时的尾部淡出秒数 */
  fadeOutSec: number
  /** ffmpeg 是否可用（不可用时 mp3 统一自动降级，界面据此提示） */
  ffmpegAvailable: boolean
  disabledModels: string[]
  selectedDeviceIds: string[]
  devices: XiaoAiDevice[]
  lastSyncAt: number | null
}

/** audioID 缓存有效期与容量上限 */
const AUDIO_ID_CACHE_TTL_MS = 30 * 60 * 1000
const AUDIO_ID_CACHE_MAX = 300

/** 是否私有网段 IPv4（10/8、172.16-31、192.168/16） */
const isPrivateIPv4 = (ip: string) => {
  const parts = String(ip || '').split('.').map(item => Number(item))
  if (parts.length !== 4 || parts.some(item => !Number.isInteger(item))) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return a === 192 && b === 168
}

/**
 * 探测本机可被音箱访问的局域网地址。
 *
 * 音箱只会照 URL 拉流，填 127.0.0.1 时它会请求自己，所以界面需要一个真实可路由的地址。
 * 参考 songloft-player 的 LanAddress：跳过回环、链路本地与容器/虚拟网卡，取第一个私有网段地址。
 */
const suggestLanBaseUrl = (): string => {
  try {
    const port = String(process.env.PORT || 9527)
    const interfaces = os.networkInterfaces()
    for (const [name, list] of Object.entries(interfaces)) {
      // 跳过容器与虚拟网卡，避免给出 docker0/br-xxx 之类的地址
      if (/^(docker|br-|veth|virbr|vmnet|tailscale|zt)/i.test(name)) continue
      for (const item of list || []) {
        if (item.internal) continue
        if (item.family !== 'IPv4' && (item.family as unknown) !== 4) continue
        if (!isPrivateIPv4(item.address)) continue
        return `http://${item.address}:${port}`
      }
    }
  } catch {
    /* 枚举失败时不给建议值，前端按原逻辑走 */
  }
  return ''
}

/** 浏览器访问本服务时的地址，判断是否值得直接拿来当建议值 */
const USELESS_HOST = /^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/i

/**
 * 优先用浏览器请求的来源地址作为建议值。
 *
 * 容器部署时网卡地址是内网假地址（fnOS 容器网络常见 10.201.x.x），
 * 端口也是容器内端口（如 9527），音箱根本连不上；
 * 而请求来源天然就是用户在浏览器里打开这份页面的地址（如 http://192.168.1.10:9527），
 * 音箱和浏览器处在同一个局域网，这个地址才是可达的。
 */
const suggestBaseUrl = (origin?: string): string => {
  const value = String(origin || '').trim().replace(/\/+$/, '')
  if (value && !USELESS_HOST.test(value)) return value
  return suggestLanBaseUrl()
}

class XiaoAiService {
  private auth = new MinaAuth()
  private client: MinaClient | null = null
  private inited = false
  /** ffmpeg 可用性（异步探测结果；未探测完时按可用处理，避免界面闪一下"不可用"） */
  private ffmpegReady = true
  /**
   * 由 server 注入：本次投送之后音箱有没有真的来拉我们这一路流。
   * 用来分辨「曲库把 audioID 标成试听」与「音箱真的去播了云端试听」——
   * 前者只是元数据，后者才会导致播错歌。
   */
  private streamPulledProbe: (() => boolean) | null = null

  setStreamPulledProbe(fn: () => boolean) {
    this.streamPulledProbe = fn
  }

  /** 首次使用时从磁盘恢复登录态 */
  private ensureInit() {
    if (this.inited) return
    this.inited = true
    const token = loadToken()
    if (token) this.auth.restoreToken(token)
    void isFfmpegAvailable().then(ok => {
      this.ffmpegReady = ok
    })
  }

  /** 当前登录态 */
  getLoginState(): 'none' | 'valid' | 'expired' {
    this.ensureInit()
    const token = this.auth.getToken()
    if (!token?.serviceToken) return 'none'
    return this.auth.isTokenValid() ? 'valid' : 'expired'
  }

  getPublicConfig(origin?: string): XiaoAiPublicConfig {
    this.ensureInit()
    const config = loadConfig()
    const token = this.auth.getToken()
    return {
      configured: !!token?.serviceToken,
      loginState: this.getLoginState(),
      loginMethod: token?.loginMethod || '',
      account: token?.account ? maskAccount(token.account) : config.account ? maskAccount(config.account) : '',
      serverBaseUrl: config.serverBaseUrl,
      suggestedBaseUrl: suggestBaseUrl(origin),
      streamPath: config.streamPath || '/api/music/xiaoai/stream',
      keepLight: config.keepLight !== false,
      // 修历史不一致：loadConfig 的默认是 false，这里原本写成 `!== false`，
      // 导致界面显示「已开启」而实际走的是直投，用户以为开了却没生效
      cacheBeforePlay: config.cacheBeforePlay === true,
      unifyMp3: config.unifyMp3 !== false,
      songTransitionOffset: config.songTransitionOffset || 0,
      fadeOutSec: config.fadeOutSec ?? 1.5,
      ffmpegAvailable: this.ffmpegReady,
      touchscreenLyrics: config.touchscreenLyrics === true,
      disabledModels: config.disabledModels,
      selectedDeviceIds: config.selectedDeviceIds,
      devices: config.devices,
      lastSyncAt: config.lastSyncAt,
    }
  }

  updateConfig(patch: Record<string, unknown>, origin?: string): XiaoAiPublicConfig {
    const next: Partial<XiaoAiConfig> = {}
    if (patch.serverBaseUrl !== undefined) next.serverBaseUrl = String(patch.serverBaseUrl || '').trim()
    if (patch.streamPath !== undefined) next.streamPath = String(patch.streamPath || '').trim() || '/api/music/xiaoai/stream'
    if (patch.keepLight !== undefined) next.keepLight = !!patch.keepLight
    if (patch.touchscreenLyrics !== undefined) next.touchscreenLyrics = !!patch.touchscreenLyrics
    if (patch.cacheBeforePlay !== undefined) next.cacheBeforePlay = !!patch.cacheBeforePlay
    if (patch.unifyMp3 !== undefined) next.unifyMp3 = !!patch.unifyMp3
    if (patch.songTransitionOffset !== undefined) next.songTransitionOffset = Number(patch.songTransitionOffset) || 0
    if (patch.fadeOutSec !== undefined) next.fadeOutSec = Number(patch.fadeOutSec) || 0
    if (patch.disabledModels !== undefined) next.disabledModels = Array.isArray(patch.disabledModels) ? patch.disabledModels.map(String) : []
    if (patch.selectedDeviceIds !== undefined) {
      next.selectedDeviceIds = Array.isArray(patch.selectedDeviceIds) ? patch.selectedDeviceIds.map(String) : []
    }
    saveConfig(next)
    return this.getPublicConfig(origin)
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
   *
   * 触屏机型走 player_play_music 时，会先按「歌名 + 歌手」去小米曲库搜真实 audioID，
   * 这样音箱屏幕上能显示对应封面与歌词（搜不到则回退默认封面）。
   */
  async play(params: { streamUrl: string; deviceIds?: string[]; song?: { name?: string; singer?: string } }) {
    const streamUrl = String(params.streamUrl || '').trim()
    if (!streamUrl) throw new Error('缺少可投送的播放地址')
    const config = loadConfig()
    const songName = String(params.song?.name || '').trim()
    const singer = String(params.song?.singer || '').trim()
    const results = await this.fanOut(params.deviceIds, 'play', async (client, deviceId, hardware) => {
      const musicApiModel = needUseMusicApi(hardware, config.disabledModels)
      // 歌词模式只在「走 player_play_music 的触屏机型 + 有歌名」时开启；
      // 开启后 client 会强制 audio_type='MUSIC'，与灯环开关彻底解耦
      const lyricsWanted = config.touchscreenLyrics === true && musicApiModel && !!songName
      let audioId: string | undefined
      if (lyricsWanted) {
        const resolved = await this.resolveAudioId(client, songName, singer)
        // 没搜到真实 audioID 时不要把它当"搜到了"传下去，让 client 走「默认封面」分支
        audioId = resolved && resolved !== DEFAULT_MUSIC_AUDIO_ID ? resolved : undefined
      }
      const outcome = await client.playUrlDetailed(deviceId, streamUrl, hardware, {
        keepLight: config.keepLight !== false,
        disabledModels: config.disabledModels,
        audioId,
        lyricsMode: lyricsWanted,
      })
      if (outcome.ok) {
        const idPart = outcome.audioId ? `（）audioID=${outcome.audioId}` : ''
        const lyricPart = lyricsWanted ? '｜歌词模式' : ''
        const line = `[XiaoAi] 下发方式 ${outcome.via}${idPart}${lyricPart} → ${deviceId}`
        console.log(line)
        // 同时写进文件日志：容器部署时 stdout 在外部看不到，
        // 「到底走了哪条回退分支」是排查触屏歌词问题最关键的线索
        syncLog.info(line)
      }
      return outcome.ok
    })
    const label = songName ? `${songName}${singer ? ` - ${singer}` : ''}` : '未命名曲目'
    for (const item of results) {
      if (item.ok) {
        console.log(`[XiaoAi] 已下发播放 ${label} → ${item.name || item.deviceId}`)
      } else {
        console.warn(`[XiaoAi] 播放下发失败 ${label} → ${item.name || item.deviceId}: ${item.error || '设备未受理'}`)
      }
    }
    // 投送后做一次「播的到底是不是这首歌」的自检：
    // 带上曲库 audioID 时音箱可能转去播小米云端资源（VIP 歌只有 30 秒试听），
    // 表现就是播错歌 / 断断续续，这里把它写进日志，免得用户只看到「能播但不对劲」。
    const firstOk = results.find(item => item.ok)
    if (firstOk) {
      setTimeout(() => {
        void this.getStatus(firstOk.deviceId)
          .then(status => this.reportPlaybackMismatch(status, songName))
          .catch(() => {})
      }, 3000)
    }
    return { results, success: results.some(item => item.ok), song: params.song || null }
  }

  /** 播放内容自检：试听片段 / 播错歌 都记一条可读告警 */
  private reportPlaybackMismatch(status: any, expectedTitle: string) {
    const raw = (status?.raw || {}) as any
    const detail = raw?.extra_track_list?.[0] || raw?.play_song_detail?.extra_track_list?.[0]
    if (!detail) return
    const title = String(detail.title || '')
    if (detail.isSongPreview) {
      // isSongPreview 只说明「这个 audioID 在小米曲库里是试听资源」，不代表正在播试听：
      // 歌词模式下发的是 player_play_music + 我们自己的 stream.url，音箱照常拉流。
      // 只有「投送之后压根没有流被拉走」才说明它真的跑去播云端试听了。
      const pulled = this.streamPulledProbe ? this.streamPulledProbe() : true
      if (pulled) {
        console.log(`[XiaoAi] 曲库把「${title || '未知'}」标为试听资源，但音箱已拉取本机流，按正常播放处理`)
        return
      }
      console.warn(
        `[XiaoAi] 音箱正在播小米曲库的试听片段：${title || '未知'}（audio_id=${detail.audio_id || '?'}），且未拉取本机流。` +
          '若听到断断续续或播错歌，请在设置里关闭「触屏显示封面歌词」',
      )
      return
    }
    if (expectedTitle && title && !title.includes(expectedTitle) && !expectedTitle.includes(title)) {
      console.warn(`[XiaoAi] 音箱当前曲目（${title}）与投送的（${expectedTitle}）不一致`)
    }
  }

  /**
   * 暂停：逐台下发并回读校验，必要时降级为 stop。
   * 返回的 results[].state 让前端能区分「真暂停」与「降级停止（无法原位续播）」。
   */
  async pause(deviceIds?: string[]) {
    const config = loadConfig()
    const targets = await this.resolveTargets(deviceIds)
    const client = await this.getClient()
    const results: DeviceActionResult[] = await Promise.all(
      targets.map(async target => {
        try {
          const state = await client.playerPauseVerified(target.deviceID, target.hardware, {
            disabledModels: config.disabledModels,
          })
          return { deviceId: target.deviceID, name: target.name, ok: state !== 'failed', state }
        } catch (error: any) {
          console.warn(`[XiaoAi] pause 失败 (${target.name}):`, error?.message || error)
          return {
            deviceId: target.deviceID,
            name: target.name,
            ok: false,
            state: 'failed' as const,
            error: error?.message || String(error),
          }
        }
      })
    )
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

  /** 单设备播放状态（用于界面回显与自动续播判定） */
  async getStatus(deviceId: string) {
    const config = loadConfig()
    const target = deviceId || config.selectedDeviceIds[0] || config.devices[0]?.deviceID || ''
    if (!target) throw new Error('没有可查询的设备')
    const client = await this.getClient()
    const raw = await client.getPlayerStatus(target)
    const info = client.parseStatusInfo(raw)

    // 设备上报的 position/duration 单位随固件而异（多数是秒，部分上报毫秒）。
    // 常用音频时长不会是「小于 10000 的毫秒数」，所以小于 10000 一律按秒处理。
    const scale = info.duration > 0 && info.duration < 10000 ? 1000 : 1
    const durationMs = info.duration > 0 ? Math.round(info.duration * scale) : 0
    const positionMs = info.position > 0 ? Math.round(info.position * scale) : 0

    return {
      deviceId: target,
      playing: info.status === 1,
      paused: info.status === PLAY_STATUS_PAUSED,
      status: info.status,
      volume: info.volume,
      title: info.title,
      durationMs,
      positionMs,
      // 无量纲播放进度：自动续播只看这个比例，就不必关心单位差异
      hasProgress: durationMs > 0 && positionMs > 0,
      // 是否在播小米曲库的试听片段（只有 30 秒，会让播放听起来断断续续）
      preview: (() => {
        const raw2 = (info.raw || {}) as any
        const detail = raw2?.extra_track_list?.[0] || raw2?.play_song_detail?.extra_track_list?.[0]
        return !!detail?.isSongPreview
      })(),
      progressRatio: durationMs > 0 && positionMs > 0 ? Math.min(1, positionMs / durationMs) : -1,
      raw: info.raw,
    }
  }

  // ===== 内部：曲库 audioID 缓存 =====

  /** audioID 搜索结果缓存：同一首歌在多设备/多次投送间复用，避免重复请求小米曲库 */
  private audioIdCache = new Map<string, { id: string; at: number }>()

  private async resolveAudioId(client: MinaClient, name: string, singer: string): Promise<string> {
    const key = `${name}|${singer}`.toLowerCase()
    const cached = this.audioIdCache.get(key)
    if (cached && Date.now() - cached.at < AUDIO_ID_CACHE_TTL_MS) return cached.id

    let audioId = DEFAULT_MUSIC_AUDIO_ID
    try {
      audioId = await client.searchAudioId(name, singer)
      if (audioId && audioId !== DEFAULT_MUSIC_AUDIO_ID) {
        console.log(`[XiaoAi] 曲库命中：${name}${singer ? ` - ${singer}` : ''} → audioID=${audioId}`)
      }
    } catch (error: any) {
      console.warn('[XiaoAi] 曲库搜索失败，回退默认封面:', error?.message || error)
    }

    // 只缓存有效结果，并限制条目数避免长期运行内存增长
    if (audioId) {
      if (this.audioIdCache.size >= AUDIO_ID_CACHE_MAX) {
        const oldest = this.audioIdCache.keys().next().value
        if (oldest) this.audioIdCache.delete(oldest)
      }
      this.audioIdCache.set(key, { id: audioId, at: Date.now() })
    }
    return audioId
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
