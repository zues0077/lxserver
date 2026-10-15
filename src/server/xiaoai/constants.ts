/**
 * 小爱同学接入用到的常量与型号表。
 *
 * 参考实现：
 *  - songloft-org/songloft-plugin-miot（MIoT 插件，Apache-2.0）
 *  - yihong0618/xiaogpt 的 miservice 库
 *  - gefl24/lxserver 的小爱投播功能
 */

/** 小米账号服务 */
export const ACCOUNT_BASE_URL = 'https://account.xiaomi.com'

/** 小爱音箱（MiniA）接口主机 */
export const MINA_API_HOST = 'api2.mina.mi.com'
export const MINA_API_BASE_URL = `https://${MINA_API_HOST}`

/** 小爱音箱服务标识（登录时用） */
export const MINA_SID = 'micoapi'

/** 扫码登录使用的服务标识（与米家 App 一致） */
export const QR_LOGIN_SID = 'mijia'

/** 米家 MiIO 服务标识 */
export const XIAOMI_IO_SID = 'xiaomiio'

/** 米家 MiIO API */
export const MIIO_API_BASE_URL = 'https://api.io.mi.com/app'

/** 伪造的手机端 UA 模板（%s 替换为 deviceId） */
export const USER_AGENT_TEMPLATE = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-%s APP/xiaomi.smarthome APPV/62830'

/** MiIO 接口使用的 UA */
export const MIIO_USER_AGENT = 'MICO/AndroidApp/@SHIP.TO.2A2FE0D7@/2.4.40'

/** 小爱对话记录接口（暂未使用，保留以便后续扩展） */
export const LATEST_ASK_API_TEMPLATE =
  'https://userprofile.mina.mi.com/device_profile/v2/conversation?source=dialogu&hardware=%s&timestamp=%d&limit=%l'

/** 默认 HTTP 超时 */
export const DEFAULT_HTTP_TIMEOUT = 20000

/** 扫码长轮询超时（小米服务端会阻塞到状态变化，约 30s） */
export const QR_POLL_TIMEOUT = 25000

/** 单个二维码最多轮询次数 */
export const QR_MAX_POLL_COUNT = 40

/** serviceToken 名义有效期（小时） */
export const SERVICE_TOKEN_VALID_HOURS = 12

/** serviceToken 提前刷新阈值（小时） */
export const TOKEN_REFRESH_THRESHOLD_HOURS = 3

/** 默认封面/曲库 audio id（触屏音箱显示歌词封面用） */
export const DEFAULT_MUSIC_AUDIO_ID = '1732418460076477549'

/** music cp id */
export const MUSIC_CP_ID = '355454500'

/**
 * 需要走 player_play_music（而不是 player_play_url）的音箱型号。
 * 这份表来自 MIoT 插件的实测白名单，型号不对会出现「灯亮但没声音」。
 */
export const DEFAULT_MUSIC_API_MODELS: readonly string[] = [
  'X08C',
  'X08E',
  'X8F',
  'X4B',
  'LX05',
  'OH11',
  'OH2',
  'OH2P',
  'X6A',
  'LX04',
  'L05B',
  'L05C',
  'LX06',
  'L06A',
  'X08A',
  'X10A',
  'L15A',
  'L16A',
  'L17A',
]

/** 判断某型号是否需要走 player_play_music */
export const needUseMusicApi = (hardware: string, disabledModels?: string[]): boolean => {
  const model = String(hardware || '').trim().toUpperCase()
  if (!model) return false
  if (Array.isArray(disabledModels) && disabledModels.includes(model)) return false
  return DEFAULT_MUSIC_API_MODELS.includes(model)
}

/** 组装手机端 UA */
export const formatUserAgent = (deviceId: string) => USER_AGENT_TEMPLATE.replace('%s', deviceId)
