import {
  DEFAULT_HTTP_TIMEOUT,
  DEFAULT_MUSIC_AUDIO_ID,
  MINA_API_BASE_URL,
  MINA_SID,
  MUSIC_CP_ID,
  formatUserAgent,
  needUseMusicApi,
} from './constants'
import type { TokenInfo } from './auth'
import { generateRequestId } from './crypto'
import { encodeForm, httpRequest, parseJson } from './http'

/** 小爱设备 */
export interface MinaDevice {
  deviceID: string
  name: string
  miotDID: string
  model: string
  hardware: string
  alias: string
  roomName: string
  presence: string
}

/** ubus 返回结构 */
interface UbusResponse {
  code: number
  message?: string
  data?: unknown
}

export interface PlayOptions {
  /** 播放时点亮灯环（audio_type=MUSIC），触屏机型还会显示封面歌词 */
  keepLight?: boolean
  /** 强制禁用 player_play_music，改走 player_play_url */
  disabledModels?: string[]
}

/**
 * 小爱音箱（MiniA）接口客户端。
 *
 * 所有请求都带 userId + serviceToken Cookie；遇到 401 时回调上层刷新登录态后重试一次。
 * 同一设备的命令通过串行队列下发，避免并发 ubus 请求互相打断播放状态。
 */
export class MinaClient {
  private tokenInfo: TokenInfo
  private userAgent: string
  private queues = new Map<string, Promise<unknown>>()
  private onTokenExpired?: () => Promise<boolean>

  constructor(tokenInfo: TokenInfo, onTokenExpired?: () => Promise<boolean>) {
    this.tokenInfo = tokenInfo
    this.userAgent = formatUserAgent(tokenInfo.deviceId)
    this.onTokenExpired = onTokenExpired
  }

  updateToken(tokenInfo: TokenInfo) {
    this.tokenInfo = tokenInfo
    this.userAgent = formatUserAgent(tokenInfo.deviceId)
  }

  /** 拉取账号下的小爱设备 */
  async getDeviceList(): Promise<MinaDevice[]> {
    const merged = new Map<string, MinaDevice>()
    // master=0 返回账号下全部设备（含共享），master=1 只返回自己主控的设备；
    // 两个都查一遍取并集，避免部分账号在 master=1 下拿到空列表。
    for (const master of ['0', '1']) {
      const url = `${MINA_API_BASE_URL}/admin/v2/device_list?master=${master}`
      const res = await this.request<{ code: number; data?: any[] }>('GET', url)
      const list = Array.isArray(res?.data) ? res!.data! : []
      for (const item of list) {
        const deviceID = String(item?.deviceID || item?.deviceId || '')
        if (!deviceID || merged.has(deviceID)) continue
        merged.set(deviceID, {
          deviceID,
          name: String(item?.name || item?.alias || item?.hardware || '未命名设备'),
          miotDID: String(item?.miotDID || item?.did || ''),
          model: String(item?.model || ''),
          hardware: String(item?.hardware || ''),
          alias: String(item?.alias || ''),
          roomName: String(item?.roomName || ''),
          presence: String(item?.presence ?? ''),
        })
      }
    }
    return Array.from(merged.values())
  }

  /**
   * 播放一个音频直链。
   * 部分型号（见 DEFAULT_MUSIC_API_MODELS）必须走 player_play_music，否则会出现灯亮无声。
   */
  async playUrl(deviceId: string, url: string, hardware = '', options: PlayOptions = {}): Promise<boolean> {
    const keepLight = !!options.keepLight
    const useMusicApi = needUseMusicApi(hardware, options.disabledModels)
    if (useMusicApi) {
      return this.playMusicUrl(deviceId, url, hardware, keepLight)
    }
    const result = await this.ubus(deviceId, 'player_play_url', 'mediaplayer', {
      url,
      type: keepLight ? 1 : 2,
      media: 'app_ios',
    })
    return this.isDeviceOk(result)
  }

  /** 走 player_play_music 播放直链（触屏机型可显示歌曲信息） */
  async playMusicUrl(deviceId: string, audioUrl: string, _hardware = '', keepLight = false, audioId?: string): Promise<boolean> {
    const finalAudioId = audioId || DEFAULT_MUSIC_AUDIO_ID
    const music = {
      payload: {
        audio_type: keepLight ? 'MUSIC' : '',
        audio_items: [
          {
            item_id: {
              audio_id: finalAudioId,
              cp: {
                album_id: '-1',
                episode_index: 0,
                id: MUSIC_CP_ID,
                name: 'xiaowei',
              },
            },
            stream: { url: audioUrl },
          },
        ],
        list_params: {
          listId: '-1',
          loadmore_offset: 0,
          origin: 'xiaowei',
          type: 'MUSIC',
        },
      },
      play_behavior: 'REPLACE_ALL',
    }

    const result = await this.ubus(deviceId, 'player_play_music', 'mediaplayer', {
      startaudioid: finalAudioId,
      music: JSON.stringify(music),
    })
    return this.isDeviceOk(result)
  }

  /** 播放控制原语：play / pause / stop / next / prev */
  async playerOperation(deviceId: string, action: 'play' | 'pause' | 'stop' | 'next' | 'prev'): Promise<boolean> {
    const result = await this.ubus(deviceId, 'player_play_operation', 'mediaplayer', { action, media: 'app_ios' })
    return this.isDeviceOk(result)
  }

  /** 下一首（部分固件不支持，失败时由前端重新投送实现切歌） */
  async playerNext(deviceId: string): Promise<boolean> {
    return this.playerOperation(deviceId, 'next')
  }

  /** 上一首（同 playerNext） */
  async playerPrev(deviceId: string): Promise<boolean> {
    return this.playerOperation(deviceId, 'prev')
  }

  async playerPlay(deviceId: string): Promise<boolean> {
    return this.playerOperation(deviceId, 'play')
  }

  async playerPause(deviceId: string): Promise<boolean> {
    return this.playerOperation(deviceId, 'pause')
  }

  async playerStop(deviceId: string): Promise<boolean> {
    return this.playerOperation(deviceId, 'stop')
  }

  /** 设置音量 0-100 */
  async setVolume(deviceId: string, volume: number): Promise<boolean> {
    const value = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)))
    const result = await this.ubus(deviceId, 'player_set_volume', 'mediaplayer', { volume: value, media: 'app_ios' })
    return this.isDeviceOk(result)
  }

  /** 读取设备播放状态原始响应 */
  async getPlayerStatus(deviceId: string): Promise<{ code: number; data?: any } | null> {
    return this.ubus(deviceId, 'player_get_play_status', 'mediaplayer', { media: 'app_ios' })
  }

  /** 读取播放状态码（1 = 播放中） */
  async readPlayStatus(deviceId: string): Promise<number> {
    const raw = await this.getPlayerStatus(deviceId)
    const info = (raw?.data as any)?.info
    if (typeof info !== 'string') return -1
    try {
      const parsed = JSON.parse(info)
      return typeof parsed?.status === 'number' ? parsed.status : -1
    } catch {
      return -1
    }
  }

  /** 读取音量（-1 表示读取失败） */
  async getVolume(deviceId: string): Promise<number> {
    const raw = await this.getPlayerStatus(deviceId)
    const info = (raw?.data as any)?.info
    if (typeof info !== 'string') return -1
    try {
      const parsed = JSON.parse(info)
      return typeof parsed?.volume === 'number' ? parsed.volume : -1
    } catch {
      return -1
    }
  }

  // ===== 内部实现 =====

  /** ubus 调用：同一设备串行下发 */
  private ubus(deviceId: string, method: string, path: string, message: Record<string, unknown>) {
    const task = async () => {
      const body = encodeForm({
        deviceId,
        method,
        path,
        message: JSON.stringify(message),
        requestId: generateRequestId(),
      })
      const res = await this.request<UbusResponse>('POST', `${MINA_API_BASE_URL}/remote/ubus`, body)
      if (!res || Number(res.code) !== 0) return null
      return res
    }
    return this.enqueue(deviceId, task)
  }

  /** 设备级返回码判定：只看 ubus 外层 code 会把「云端受理但设备拒绝」当成成功 */
  private isDeviceOk(result: UbusResponse | null): boolean {
    if (!result) return false
    const data = result.data as Record<string, unknown> | undefined
    if (data && typeof data === 'object' && 'code' in data) {
      const code = Number(data.code)
      if (!Number.isNaN(code) && code !== 0) return false
    }
    return true
  }

  /** 设备级串行队列 */
  private enqueue<T>(deviceId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(deviceId) || Promise.resolve()
    const next = prev.then(run, run)
    this.queues.set(
      deviceId,
      next.catch(() => undefined)
    )
    return next
  }

  /** 统一请求入口：带 Cookie，401 时刷新登录态并重试一次 */
  private async request<T>(method: 'GET' | 'POST', url: string, body?: string, retried = false): Promise<T | null> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Cookie: [
        `userId=${this.tokenInfo.userId}`,
        `serviceToken=${this.tokenInfo.serviceToken}`,
        'channel=MI_APP_STORE',
      ].join('; '),
    }
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded'

    let res
    try {
      res = await httpRequest(url, { method, headers, body, timeoutMs: DEFAULT_HTTP_TIMEOUT })
    } catch {
      return null
    }

    if (res.status === 401 && !retried && this.onTokenExpired) {
      const refreshed = await this.onTokenExpired()
      if (refreshed) return this.request<T>(method, url, body, true)
      return null
    }

    if (res.status >= 400) return null
    return parseJson<T>(res.text)
  }
}
