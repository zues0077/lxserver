import fs from 'node:fs'
import path from 'node:path'
import type { TokenInfo } from './auth'
import { DEFAULT_SCREEN_MODELS } from './screen'

/**
 * 小爱同学的配置与登录态持久化。
 *
 * 刻意不写进主 config.js：
 *  - 小爱配置项多且是运行期可变的（设备列表、选中设备），单独放一个 JSON 更清晰
 *  - 登录态（passToken）属于凭据，单独一个文件便于用户清理，也不会被配置导出/备份带出去
 *
 * 注意：不保存账号密码。登录成功后只持久化 passToken，后续用 passToken 静默续期。
 */

export interface XiaoAiDevice {
  deviceID: string
  name: string
  hardware: string
  model: string
  roomName: string
  miotDID: string
}

export interface XiaoAiConfig {
  /** 音箱能访问到的服务地址，如 http://192.168.1.10:9527（留空则用请求来源自动推断） */
  serverBaseUrl: string
  /** 投播用的流地址路径 */
  streamPath: string
  /** 播放时点亮灯环 */
  keepLight: boolean
  /**
   * 触屏音箱显示封面与歌词（会向小米曲库搜索 audioID 并塞进 player_play_music）。
   * 默认关闭：带上曲库 audioID 后，音箱会改播小米云端的对应资源，
   * VIP 歌往往只有 30 秒试听片段，表现为「播错歌 / 断断续续」，所以默认走自己的直链。
   */
  touchscreenLyrics: boolean
  /** 投送前先把整首缓存到本地（默认关闭：音箱直接按远端地址拉流） */
  cacheBeforePlay: boolean
  /** 强制走 player_play_url 的型号（覆盖内置白名单） */
  disabledModels: string[]
  /**
   * 推送格式统一转 mp3（默认开启）。
   * 音箱对 mp3 的兼容性最好；已是 mp3 的源不会重复转码，直接复用。
   *
   * 兼容旧配置用：新逻辑看 `mp3Policy`，这里保留是为了老前端/老配置文件仍能读。
   */
  unifyMp3: boolean
  /**
   * 投送格式策略（2026-11-02 起）：
   *  - `auto`  （默认）音箱**原生能播**的容器直接投，其余转 mp3
   *  - `always` 一律转 mp3（老行为，最稳）
   *  - `off`    一律原格式直投（排障用；m4a/ogg/wma 这类设备放不出来）
   *
   * 原生可播白名单来自真机实测（泰禾世家小爱触屏音箱，2026-11-02）：
   *   mp3 / flac / wav 有进度；m4a(aac/alac) / ogg(vorbis/opus) / wma
   *   能拉完全部字节但设备零进度（= 放不出来）。
   */
  mp3Policy: 'auto' | 'always' | 'off'
  /**
   * 切歌提前量偏移（秒，-30..30）。
   * 0 = 用服务端实测延迟自适应；负数更晚切（少截结尾），正数更早切（减少空档）。
   */
  songTransitionOffset: number
  /** 转码时的尾部淡出秒数（0 = 不淡出，默认 1.5s，让切歌不突兀） */
  fadeOutSec: number
  /**
   * 上一次设置的音量（0-100，仅用于界面回填）。
   *
   * 音箱不支持「读我上次设了多少」，真值要问设备（/status 的 volume）；
   * 离线或查询失败时用这个值兜底，避免界面永远显示 HTML 里写死的 50 那种假状态。
   */
  volume: number
  /**
   * 兜底封面用的曲库 audioID：曲库搜不到这首歌时，用它的封面当默认封面。
   * 默认 `1732418460076477549`（Theme Of Loft）。设置里可换成曲库任意一首歌的封面
   * （UI 提供若干预设；本质是"用哪首曲库歌的封面兜底"，不是上传自定义图）。
   */
  defaultCoverAudioId: string
  /**
   * 曲库未命中时怎么投（2026-11-22 新增）：
   *  - false（默认，沿用旧行为）下发 `defaultCoverAudioId` 那首歌，屏幕会显示它的封面/歌名；
   *  - true 不带任何曲库 audioID，改走 `player_play_url` 纯直链——屏幕不会再出现
   *    「另一首歌的歌名」，代价是没有封面与滚动歌词。
   *
   * 由来（17950 实机）：`defaultCoverAudioId` 被配成《所念皆星河》后，投送
   * 《时间线-于冬然》曲库未命中，触屏整屏显示《所念皆星河》，被当成「播错歌」；
   * 实际音频是这一路直链（streamBytes 与源文件字节数一致）。
   */
  unmatchedDirectUrl: boolean
  /**
   * 曲库未命中时按「设备有没有屏幕」自动选择（2026-11-22 新增，默认 true）：
   *  - 带屏幕的机型（触屏音箱）：沿用兜底封面（屏幕有封面/歌词，代价是曲名可能是占位曲目）；
   *  - 无屏机型：改走纯直链（反正不显示封面，避免任何「别人的歌名」被播报）。
   * `unmatchedDirectUrl=true` 仍然强制所有机型走直链。
   */
  unmatchedDirectByModel: boolean
  /** 判定「带屏幕」的型号名单（hardware 大写代号）；名单外再按设备名里的「触屏/屏幕」兜底 */
  screenModels: string[]
  /** 选中的设备（支持多选同时播放） */
  selectedDeviceIds: string[]
  /** 上一次拉取到的设备列表 */
  devices: XiaoAiDevice[]
  /** 登录账号（仅用于界面展示） */
  account: string
  lastSyncAt: number | null
}

export interface XiaoAiStoredToken extends TokenInfo {}

const DEFAULT_CONFIG: XiaoAiConfig = {
  serverBaseUrl: '',
  streamPath: '/api/music/xiaoai/stream',
  keepLight: true,
  cacheBeforePlay: false,
  touchscreenLyrics: false,
  disabledModels: [],
  unifyMp3: true,
  mp3Policy: 'auto',
  songTransitionOffset: 0,
  fadeOutSec: 1.5,
  volume: 50,
  defaultCoverAudioId: '1732418460076477549',
  unmatchedDirectUrl: false,
  unmatchedDirectByModel: true,
  // 带屏型号名单（LX04/X08A/X08C/X08E/X8F/X6A/X10A，详见 screen.ts 的依据注释）；
  // 名字含「触屏/屏幕」的仍会兜底命中，用户自定义名单优先。
  screenModels: DEFAULT_SCREEN_MODELS,
  selectedDeviceIds: [],
  devices: [],
  account: '',
  lastSyncAt: null,
}

/**
 * 归一化 mp3 策略。
 * 老配置只有 `unifyMp3`：显式关过转码 → off（保持用户原本的选择），
 * 没关过 → auto（比老行为更省：mp3/flac/wav 不再无脑重编码）。
 */
export const normalizeMp3Policy = (raw: unknown, legacyUnify?: unknown): 'auto' | 'always' | 'off' => {
  const value = String(raw || '').trim().toLowerCase()
  if (value === 'auto' || value === 'always' || value === 'off') return value
  return legacyUnify === false ? 'off' : 'auto'
}

/** 数值配置的兜底与夹取：配置文件被手改坏时不至于让逻辑跑飞 */
const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

const dataPath = () => {
  try {
    return global?.lx?.dataPath || process.cwd()
  } catch {
    return process.cwd()
  }
}

export const configFilePath = () => path.join(dataPath(), 'xiaoai.config.json')
export const tokenFilePath = () => path.join(dataPath(), 'xiaoai.token.json')
export const secretFilePath = () => path.join(dataPath(), 'xiaoai.secret')

export const normalizeDevice = (device: any): XiaoAiDevice => ({
  deviceID: String(device?.deviceID || device?.deviceId || '').trim(),
  name: String(device?.name || device?.alias || device?.hardware || '未命名设备').trim(),
  hardware: String(device?.hardware || '').trim(),
  model: String(device?.model || '').trim(),
  roomName: String(device?.roomName || '').trim(),
  miotDID: String(device?.miotDID || device?.did || '').trim(),
})

export const loadConfig = (): XiaoAiConfig => {
  try {
    const file = configFilePath()
    if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      keepLight: raw.keepLight !== false,
      touchscreenLyrics: raw.touchscreenLyrics === true,
      cacheBeforePlay: raw.cacheBeforePlay === true,
      unifyMp3: raw.unifyMp3 !== false,
      // 老配置没有 mp3Policy：显式关过转码的沿用 off，其余升级到 auto
      mp3Policy: normalizeMp3Policy(raw.mp3Policy, raw.unifyMp3),
      songTransitionOffset: clampNumber(raw.songTransitionOffset, -30, 30, 0),
      fadeOutSec: clampNumber(raw.fadeOutSec, 0, 6, 1.5),
      volume: Math.round(clampNumber(raw.volume, 0, 100, DEFAULT_CONFIG.volume)),
      defaultCoverAudioId: String(raw.defaultCoverAudioId || DEFAULT_CONFIG.defaultCoverAudioId).trim(),
      // 曲库未命中时走直链：只认显式 true，缺省（含老配置）保持旧的「兜底封面」行为
      unmatchedDirectUrl: raw.unmatchedDirectUrl === true,
      // 按型号智能选择：缺省开启（带屏保持兜底封面，无屏走直链）
      unmatchedDirectByModel: raw.unmatchedDirectByModel !== false,
      screenModels: Array.isArray(raw.screenModels)
        ? raw.screenModels.map((item: unknown) => String(item).trim().toUpperCase()).filter(Boolean)
        : DEFAULT_CONFIG.screenModels,
      disabledModels: Array.isArray(raw.disabledModels)
        ? raw.disabledModels.map((item: unknown) => String(item).trim().toUpperCase()).filter(Boolean)
        : [],
      selectedDeviceIds: Array.isArray(raw.selectedDeviceIds) ? raw.selectedDeviceIds.map((item: unknown) => String(item)) : [],
      devices: Array.isArray(raw.devices) ? raw.devices.map(normalizeDevice).filter((item: XiaoAiDevice) => item.deviceID) : [],
      lastSyncAt: raw.lastSyncAt ? Number(raw.lastSyncAt) : null,
    }
  } catch (error: any) {
    console.warn('[XiaoAi] 读取配置失败:', error?.message || error)
    return { ...DEFAULT_CONFIG }
  }
}

export const saveConfig = (patch: Partial<XiaoAiConfig>): XiaoAiConfig => {
  const prev = loadConfig()
  const next: XiaoAiConfig = {
    ...prev,
    ...patch,
    unifyMp3: patch.unifyMp3 !== undefined ? patch.unifyMp3 !== false : prev.unifyMp3,
    mp3Policy: normalizeMp3Policy(patch.mp3Policy, patch.unifyMp3 !== undefined ? patch.unifyMp3 : prev.unifyMp3),
    songTransitionOffset:
      patch.songTransitionOffset !== undefined
        ? clampNumber(patch.songTransitionOffset, -30, 30, prev.songTransitionOffset)
        : prev.songTransitionOffset,
    fadeOutSec:
      patch.fadeOutSec !== undefined ? clampNumber(patch.fadeOutSec, 0, 6, prev.fadeOutSec) : prev.fadeOutSec,
    volume:
      patch.volume !== undefined
        ? Math.round(clampNumber(patch.volume, 0, 100, prev.volume))
        : prev.volume,
    defaultCoverAudioId:
      patch.defaultCoverAudioId !== undefined
        ? String(patch.defaultCoverAudioId).trim() || prev.defaultCoverAudioId
        : prev.defaultCoverAudioId,
    unmatchedDirectUrl:
      patch.unmatchedDirectUrl !== undefined ? patch.unmatchedDirectUrl === true : prev.unmatchedDirectUrl,
    unmatchedDirectByModel:
      patch.unmatchedDirectByModel !== undefined ? patch.unmatchedDirectByModel !== false : prev.unmatchedDirectByModel,
    screenModels: patch.screenModels
      ? patch.screenModels.map(item => String(item).trim().toUpperCase()).filter(Boolean)
      : prev.screenModels,
    disabledModels: patch.disabledModels
      ? patch.disabledModels.map(item => String(item).trim().toUpperCase()).filter(Boolean)
      : prev.disabledModels,
    selectedDeviceIds: patch.selectedDeviceIds ? patch.selectedDeviceIds.map(item => String(item)) : prev.selectedDeviceIds,
    devices: patch.devices ? patch.devices.map(normalizeDevice).filter((item: XiaoAiDevice) => item.deviceID) : prev.devices,
  }
  // mp3Policy 是主开关：显式传了就不让 unifyMp3 与之打架（否则会出现
  // 「策略=auto 但 unifyMp3=false」这种自相矛盾的落盘，界面显示与实际行为不一致）
  if (patch.mp3Policy !== undefined) next.unifyMp3 = next.mp3Policy !== 'off'
  const file = configFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}

export const loadToken = (): XiaoAiStoredToken | null => {
  try {
    const file = tokenFilePath()
    if (!fs.existsSync(file)) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw?.userId || !raw?.serviceToken) return null
    return raw as XiaoAiStoredToken
  } catch {
    return null
  }
}

export const saveToken = (token: XiaoAiStoredToken | null) => {
  const file = tokenFilePath()
  try {
    if (!token) {
      if (fs.existsSync(file)) fs.unlinkSync(file)
      return
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(token, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (error: any) {
    console.warn('[XiaoAi] 保存登录态失败:', error?.message || error)
  }
}

/** 读取（或首次生成）流地址签名密钥 */
export const loadSecret = (): string => {
  const file = secretFilePath()
  try {
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, 'utf8').trim()
      if (value) return value
    }
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const value = crypto.randomBytes(32).toString('hex')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 })
    return value
  } catch {
    // 极端情况下（目录不可写）退化为进程级随机密钥，签名仍有效，只是重启后旧链接失效
    return `fallback-${process.pid}-${Date.now()}`
  }
}
