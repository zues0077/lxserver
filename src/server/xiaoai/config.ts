import fs from 'node:fs'
import path from 'node:path'
import type { TokenInfo } from './auth'

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
  /** 总开关：关闭后播放器里的小爱播放目标不可用 */
  enabled: boolean
  /** 音箱能访问到的服务地址，如 http://192.168.1.10:9527（留空则用请求来源自动推断） */
  serverBaseUrl: string
  /** 投播用的流地址路径 */
  streamPath: string
  /** 播放时点亮灯环 */
  keepLight: boolean
  /** 强制走 player_play_url 的型号（覆盖内置白名单） */
  disabledModels: string[]
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
  enabled: false,
  serverBaseUrl: '',
  streamPath: '/api/music/xiaoai/stream',
  keepLight: true,
  disabledModels: [],
  selectedDeviceIds: [],
  devices: [],
  account: '',
  lastSyncAt: null,
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
    disabledModels: patch.disabledModels
      ? patch.disabledModels.map(item => String(item).trim().toUpperCase()).filter(Boolean)
      : prev.disabledModels,
    selectedDeviceIds: patch.selectedDeviceIds ? patch.selectedDeviceIds.map(item => String(item)) : prev.selectedDeviceIds,
    devices: patch.devices ? patch.devices.map(normalizeDevice).filter((item: XiaoAiDevice) => item.deviceID) : prev.devices,
  }
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
