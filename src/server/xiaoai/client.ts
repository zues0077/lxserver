// [cache-bust 1.5.25] 强制 CI 重新编译以带上 C8(无损降320k)/A(失败日志)/B(status字段)/parseStatusInfo 修复 — 2026-10-23
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
import { buildSearchQueries, pickMusicCandidate, type MusicCandidate } from './musicMatch'

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

/** 曲库搜索返回的单曲（audioID 为大整数字符串） */
interface MusicSearchSong {
  audioID?: string
  songID?: string
  name?: string
  artist?: { name?: string }
}

/** 播放状态结构化结果 */
export interface PlayStatusInfo {
  /** 1 = 播放中，2 = 暂停，0 = 停止，-1 = 未知 */
  status: number
  volume: number
  /** 原始单位（部分固件是秒，部分是毫秒），由上层归一 */
  position: number
  duration: number
  title: string
  raw: Record<string, unknown>
}

/** player_get_play_status 的 status 值 */
export const PLAY_STATUS_PLAYING = 1
export const PLAY_STATUS_PAUSED = 2

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export interface PlayOptions {
  /** 播放时点亮灯环（audio_type=MUSIC） */
  keepLight?: boolean
  /** 强制禁用 player_play_music，改走 player_play_url */
  disabledModels?: string[]
  /** 触屏机型使用的曲库 audioID（用于显示封面与歌词），为空则用默认封面 */
  audioId?: string
  /**
   * 触屏歌词模式：强制 audio_type='MUSIC'。
   *
   * 历史 bug：audio_type 曾直接绑在 keepLight 上（`keepLight ? 'MUSIC' : ''`），
   * 用户一关「灯环」，audio_type 就变成空串，触屏上的封面与歌词随之消失。
   * 歌词与灯环本是两件事，这里彻底解耦。参考 songloft-plugin-miot 的 playByMusicURL(true, ...)。
   */
  lyricsMode?: boolean
}

/** 播放结果的细节（便于上层做回退与日志） */
export interface PlayOutcome {
  ok: boolean
  /** 实际生效的播放方式，写日志/自检用 */
  via: 'player_play_music(歌词)' | 'player_play_music(默认封面)' | 'player_play_music' | 'player_play_url'
  /** 实际使用的曲库 audioID（走 player_play_url 时为空） */
  audioId?: string
  /**
   * 失败原因（ok=false 时给出）。
   * 之前只回 ok=false 一个布尔，上层日志只能写「设备未受理」，
   * 用户反馈「点了没反应」时无从判断是云端拒了、设备拒了还是鉴权掉了。
   */
  error?: string
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
   *
   * 触屏歌词模式下按「搜到的 audioID → 默认 audioID → 普通 Music API → player_play_url」
   * 四级回退（参考 songloft-plugin-miot 的 playByUrl），保证封面歌词失败时至少有声音。
   */
  async playUrl(deviceId: string, url: string, hardware = '', options: PlayOptions = {}): Promise<boolean> {
    return (await this.playUrlDetailed(deviceId, url, hardware, options)).ok
  }

  async playUrlDetailed(deviceId: string, url: string, hardware = '', options: PlayOptions = {}): Promise<PlayOutcome> {
    const keepLight = !!options.keepLight
    const useMusicApi = needUseMusicApi(hardware, options.disabledModels)
    const lyricsMode = options.lyricsMode === true

    const playUrl = async (): Promise<PlayOutcome> => {
      const result = await this.ubus(deviceId, 'player_play_url', 'mediaplayer', {
        url,
        type: keepLight ? 1 : 2,
        media: 'app_ios',
      })
      const ok = this.isDeviceOk(result)
      return { ok, via: 'player_play_url', error: ok ? undefined : this.deviceReason(result) }
    }

    if (!useMusicApi) return playUrl()

    const fallbackAudioId = options.audioId || DEFAULT_MUSIC_AUDIO_ID
    /** 逐级回退过程中最后一次失败原因，全失败时带回去 */
    let lastReason = ''

    if (lyricsMode) {
      // 1. 搜到的真实 audioID（能对上歌词与封面）
      const searched = options.audioId || ''
      if (searched) {
        const r = await this.playMusicUrlDetailed(deviceId, url, hardware, {
          keepLight,
          audioId: searched,
          audioType: 'MUSIC',
        })
        if (r.ok) return { ok: true, via: 'player_play_music(歌词)', audioId: searched }
        lastReason = r.reason
        console.warn(`[XiaoAi] 曲库 audioID=${searched} 播放失败，回退默认封面：${r.reason}`)
      }
      // 2. 默认 audioID（仍在歌词模式，屏幕至少要有个封面位）
      const d1 = await this.playMusicUrlDetailed(deviceId, url, hardware, {
        keepLight,
        audioId: fallbackAudioId,
        audioType: 'MUSIC',
      })
      if (d1.ok) return { ok: true, via: 'player_play_music(默认封面)', audioId: fallbackAudioId }
      lastReason = d1.reason

      // 3. 退回普通 Music API（audio_type 跟随灯环设置）
      const d2 = await this.playMusicUrlDetailed(deviceId, url, hardware, { keepLight, audioId: fallbackAudioId })
      if (d2.ok) return { ok: true, via: 'player_play_music', audioId: fallbackAudioId }
      lastReason = d2.reason

      // 4. 最后退回 player_play_url：宁可没有封面歌词，也要能出声
      console.warn(`[XiaoAi] 设备 ${deviceId} 多次 player_play_music 失败，回退 player_play_url`)
      const final = await playUrl()
      if (final.ok) return final
      return { ...final, error: [lastReason, final.error].filter(Boolean).join(' / ') || '设备未受理' }
    }

    const r = await this.playMusicUrlDetailed(deviceId, url, hardware, { keepLight, audioId: options.audioId })
    return {
      ok: r.ok,
      via: 'player_play_music',
      audioId: options.audioId || DEFAULT_MUSIC_AUDIO_ID,
      error: r.ok ? undefined : r.reason,
    }
  }

  /**
   * 走 player_play_music 播放直链（触屏机型可显示歌曲信息）。
   *
   * audioType 与 keepLight 解耦：传 'MUSIC' 就一定有封面歌词位（触屏歌词模式），
   * 不传时才回落到「灯环开着就带 MUSIC」的旧行为。
   */
  async playMusicUrl(
    deviceId: string,
    audioUrl: string,
    _hardware = '',
    options: { keepLight?: boolean; audioId?: string; audioType?: 'MUSIC' | '' } = {},
  ): Promise<boolean> {
    return (await this.playMusicUrlDetailed(deviceId, audioUrl, _hardware, options)).ok
  }

  /** 同上，但带回失败原因（日志/排障用） */
  private async playMusicUrlDetailed(
    deviceId: string,
    audioUrl: string,
    _hardware = '',
    options: { keepLight?: boolean; audioId?: string; audioType?: 'MUSIC' | '' } = {},
  ): Promise<{ ok: boolean; reason: string }> {
    const finalAudioId = options.audioId || DEFAULT_MUSIC_AUDIO_ID
    const audioType = options.audioType !== undefined ? options.audioType : options.keepLight ? 'MUSIC' : ''
    const music = {
      payload: {
        audio_type: audioType,
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
    const ok = this.isDeviceOk(result)
    return { ok, reason: ok ? '' : this.deviceReason(result) }
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

  /**
   * 暂停并回读校验，必要时升级为 stop。
   *
   * 部分小爱型号（尤其是走 player_play_music 的触屏机型）会「受理」pause 但音频继续播，
   * 表现为网页暂停按钮无效。这里 pause 后连续回读设备状态，仍在上报播放就降级为 stop。
   * 参考 songloft-plugin-miot 的 playerPauseVerified 与 miair-next 的 pause=stop 策略。
   *
   * @returns 'paused' 暂停已生效 | 'stopped' 已升级为停止（媒体上下文丢失，无法原位续播）
   *          | 'failed' 指令下发失败
   */
  async playerPauseVerified(deviceId: string, hardware = '', options: PlayOptions = {}): Promise<'paused' | 'stopped' | 'failed'> {
    // 触屏机型走 music api 时，pause 的状态机经常不更新，直接用 stop 表达暂停语义。
    // 但 stop 不一定会丢掉媒体上下文：实测 LX04 停完进度仍在原处、/resume 能原位续播。
    // 所以停完再看一眼进度——还在就报 paused（前端可继续），清零了才报 stopped（需要重新投送）。
    if (needUseMusicApi(hardware, options.disabledModels)) {
      if (!(await this.playerStop(deviceId))) return 'failed'
      for (let i = 0; i < 2; i++) {
        await delay(500)
        const info = this.parseStatusInfo(await this.getPlayerStatus(deviceId))
        if (info.status === -1) continue // 读不到状态时别急着下结论
        if (info.status !== PLAY_STATUS_PLAYING && Number(info.position) > 0) return 'paused'
        break
      }
      return 'stopped'
    }

    const pauseOK = await this.playerPause(deviceId)
    for (let i = 0; i < 2; i++) {
      await delay(700)
      const status = await this.readPlayStatus(deviceId)
      // -1 表示读不到状态（部分固件不支持），此时保守认为暂停已生效，避免误 stop 丢进度
      if (status !== PLAY_STATUS_PLAYING) return 'paused'
    }

    console.warn(`[XiaoAi] 设备 ${deviceId} 暂停未生效（仍在上报播放），升级为 stop`)
    if (await this.playerOperation(deviceId, 'stop')) return 'stopped'
    return pauseOK ? 'paused' : 'failed'
  }

  /** 停止播放：部分型号单独 stop 不生效，先 pause 再 stop */
  async playerStop(deviceId: string): Promise<boolean> {
    await this.playerPause(deviceId).catch(() => false)
    return this.playerOperation(deviceId, 'stop')
  }

  /**
   * 搜小米曲库，命中真实 audioID（触屏音箱据此拉取封面与歌词）。
   *
   * 屏幕上的封面/歌名/滚动歌词全部来自曲库（payload 只能带 audio_id 和 stream.url），
   * 所以这里是投送观感的唯一开关：命中就有真封面和歌词，落空只能显示占位曲目。
   * 参考实现（songloft-plugin-miot / xiaomusic）是「有结果就用第一条」，命中率高但会错配；
   * 原实现只认「歌名完全相等 + 歌手对得上」，本地歌名带 (Live)/feat 后缀时会大量落空。
   * 现在按 musicMatch.ts 的分档择优：多条 query 逐级放宽，宁可占位也不错配。
   */
  async searchAudioId(title: string, artist = '', options: { fuzzyFallback?: boolean; fallbackAudioId?: string } = {}): Promise<string> {
    const fallback = options.fallbackAudioId || DEFAULT_MUSIC_AUDIO_ID
    const songTitle = String(title || '').trim()
    if (!songTitle) return fallback
    const songArtist = String(artist || '').trim()
    // 多条 query 逐级放宽：本地歌手写法/歌名后缀常与曲库不一致，只发一条很容易整轮落空
    const queries = buildSearchQueries(songTitle, songArtist)
    if (!queries.length) return fallback

    const seen = new Set<string>()
    const candidates: MusicCandidate[] = []
    let tried = 0
    for (const query of queries) {
      let songList: MusicSearchSong[]
      try {
        songList = await this.searchMusicList(query)
      } catch (e: any) {
        // 单条 query 失败不该让整次匹配报废，换下一条更宽的继续试
        console.warn(`[XiaoAi] 曲库搜索失败（${query}）：${e?.message || e}`)
        continue
      }
      tried++
      for (const song of songList) {
        const audioId = String(song?.audioID || '')
        if (!audioId || seen.has(audioId)) continue
        seen.add(audioId)
        candidates.push({
          name: String(song?.name || ''),
          artist: String(song?.artist?.name || ''),
          audioId,
        })
      }
      // 最理想档（同名 + 歌手匹配）已经到手，不必再用更宽的 query 追问
      const decisive = pickMusicCandidate(candidates, songTitle, songArtist)
      if (decisive && decisive.score >= 100) return decisive.candidate.audioId
    }

    const best = pickMusicCandidate(candidates, songTitle, songArtist)
    if (best) return best.candidate.audioId

    // 兼容旧的模糊兜底开关：只有在没有任何可信候选时才拿第一条（可能错配，默认关闭）
    if (options.fuzzyFallback === true) {
      const first = candidates.find(c => c.audioId)
      if (first) return first.audioId
    }
    // 未命中会退占位封面（屏幕显示 Theme Of Loft），留一行可对账的日志便于排查命中率
    console.log(
      `[XiaoAi] 曲库未命中：${songTitle}${songArtist ? ` - ${songArtist}` : ''}（试 ${tried} 个查询 / ${candidates.length} 条候选）`
    )
    return fallback
  }

  /**
   * 曲库搜索单次请求。
   *
   * audioID / songID 是超出 JS 安全整数范围的大整数，必须先把纯数字转成字符串再解析，
   * 否则会被 JSON.parse 截成浮点数，拿去投送就变成别的歌。
   */
  private async searchMusicList(query: string): Promise<MusicSearchSong[]> {
    const body = encodeForm({
      query,
      queryType: '1',
      offset: '0',
      count: '12',
      timestamp: String(Date.now()),
      requestId: generateRequestId(),
    })
    const result = await this.request<{ code?: number; data?: { songList?: MusicSearchSong[] } }>(
      'POST',
      `${MINA_API_BASE_URL}/music/search`,
      body,
      false,
      text => text.replace(/"(audioID|songID)"\s*:\s*(-?\d+)/g, '"$1":"$2"')
    )
    const songList = result?.data?.songList
    return Array.isArray(songList) ? songList : []
  }

  /**
   * 把 player_get_play_status 的返回解析成结构化对象。
   * 兼容性要点（实测触屏固件）：
   *  - 真机返回 { code, info }，其中 info 可能是 JSON 字符串，需要 JSON.parse
   *  - 也兼容 { code, data } 或把字段直接平铺在 raw 上的旧形态
   */
  parseStatusInfo(raw: { code: number; data?: any; info?: any } | null): PlayStatusInfo {
    // 真机经 MINA /remote/ubus 返回的是**双层包裹**：{ code, data: { code, info: "<json 字符串>" } }。
    // 之前只在 info 是「对象」时才继续剥，遇到 info 是「字符串」就停在外层 {code,info}，
    // 导致 play_song_detail 取不到、title/duration/unplayableCode 全空（状态栏空白、VIP 闸门失效）。
    // 改为循环剥 data/info，遇字符串就 JSON.parse，直到取到含 play_song_detail/status/试听列表的终态对象。
    const peel = (value: any): Record<string, any> => {
      let cur: any = value
      for (let depth = 0; depth < 6; depth++) {
        if (typeof cur === 'string') {
          try {
            cur = JSON.parse(cur)
          } catch {
            return {}
          }
          continue
        }
        if (cur && typeof cur === 'object') {
          // 已到终态（含播放详情/状态/试听列表）就停，避免把业务字段再往下剥
          if ('play_song_detail' in cur || 'status' in cur || 'extra_track_list' in cur || 'track_list' in cur) {
            return cur as Record<string, any>
          }
          const next = (cur as any).info ?? (cur as any).data
          if (next !== undefined && next !== null) {
            cur = next
            continue
          }
          return cur as Record<string, any>
        }
        return {}
      }
      return cur && typeof cur === 'object' ? (cur as Record<string, any>) : {}
    }
    const parsed = peel(raw)
    // 触屏/部分固件把 title/duration/position 放在 play_song_detail 下，顶层不报；
    // 顶层取不到时回退到 play_song_detail，保证曲名与进度能正常显示。
    const sd = (parsed.play_song_detail && typeof parsed.play_song_detail === 'object')
      ? (parsed.play_song_detail as Record<string, unknown>)
      : {}
    const status = Number(parsed.status)
    const title = String(parsed.title || sd.title || parsed.audioName || sd.media_name || '')
    const duration = Number(parsed.duration) || Number(sd.duration) || 0
    const position = Number(parsed.position) || Number(sd.position) || 0
    const volume = typeof parsed.volume === 'number'
      ? parsed.volume
      : (typeof sd.volume === 'number' ? sd.volume : -1)
    // 把「外层 raw 的 extra_track_list（试听片段判定用）」一并带回，避免 preview 判定失效；
    // 同时保留 play_song_detail，供前端版权闸门提示读取 unplayableCode。
    const outer = (raw ?? {}) as any
    return {
      status: Number.isFinite(status) ? status : -1,
      volume,
      position,
      duration,
      title,
      raw: {
        ...parsed,
        extra_track_list:
          parsed.extra_track_list ?? outer.extra_track_list ?? outer?.data?.extra_track_list,
      } as Record<string, unknown>,
    }
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

  /** 读取播放状态码（1 = 播放中，2 = 暂停，0 = 停止，-1 = 未知） */
  async readPlayStatus(deviceId: string): Promise<number> {
    const raw = await this.getPlayerStatus(deviceId)
    return this.parseStatusInfo(raw).status
  }

  /** 读取音量（-1 表示读取失败） */
  async getVolume(deviceId: string): Promise<number> {
    const raw = await this.getPlayerStatus(deviceId)
    return this.parseStatusInfo(raw).volume
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

  /**
   * 把 ubus 结果翻成人话失败原因。
   * 排障时最需要区分的是「云端就没受理」（result=null）与「云端受理但设备拒绝」（data.code≠0）。
   */
  private deviceReason(result: UbusResponse | null): string {
    if (!result) return '云端未受理（MINA 请求失败或返回 code≠0）'
    const data = result.data as Record<string, unknown> | undefined
    if (data && typeof data === 'object' && 'code' in data) {
      const code = Number(data.code)
      if (!Number.isNaN(code) && code !== 0) {
        const msg = String((data as any).message || (data as any).msg || '').trim()
        return `设备拒绝（code=${code}${msg ? ` ${msg}` : ''}）`
      }
    }
    if (result.message) return `设备返回：${result.message}`
    return '设备未受理'
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
  private async request<T>(
    method: 'GET' | 'POST',
    url: string,
    body?: string,
    retried = false,
    transformResponseText?: (text: string) => string
  ): Promise<T | null> {
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
      if (refreshed) return this.request<T>(method, url, body, true, transformResponseText)
      return null
    }

    if (res.status >= 400) return null
    const text = transformResponseText ? transformResponseText(res.text) : res.text
    return parseJson<T>(text)
  }
}
