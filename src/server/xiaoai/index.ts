/**
 * 小爱同学（米家云）投播能力的统一出口。
 *
 * 目录结构：
 *  - constants.ts   常量与设备型号表
 *  - crypto.ts      md5 / sha1 / hmac 等
 *  - cookieJar.ts   跨请求 Cookie 维护
 *  - http.ts        带动重定向与 Cookie 的请求封装
 *  - auth.ts        账号认证（密码 / 扫码 / Cookie）
 *  - client.ts      MiniA 接口客户端（设备列表、ubus、播放控制）
 *  - config.ts      配置与登录态持久化
 *  - streamToken.ts 播放直链签名
 *  - stream.ts      音频流转发（本地文件 / 远端中转）+ 投送前音频探测
 *  - playCache.ts   投送地址短时缓存（自动续播的预解析用）
 *  - service.ts     面向业务的高阶服务（多设备 fan-out）
 */

export { xiaoAiService } from './service'
export type { XiaoAiPublicConfig, DeviceActionResult } from './service'
export { buildStreamUrl, createStreamToken, parseStreamToken } from './streamToken'
export {
  serveXiaoAiStream,
  probeAudioSource,
  getStreamRounds,
  detectAudioFormat,
  paceWaitMs,
  retireStreams,
  hasActiveStream,
} from './stream'
export { detectAudioDurationMs } from './audioMeta'
export { loadConfig as loadXiaoAiConfig } from './config'
export { buildTrackKey, getCachedTrack, getCachedTrackUrl, setCachedTrackUrl, clearTrackCache } from './playCache'
export { sleepTimer } from './sleepTimer'
export type { SleepTimerStatus, SleepTimerMode } from './sleepTimer'
export { mp3CacheDir, mp3CacheKey, mp3CachePath, removeMp3Cache } from './mp3Cache'
export { isFfmpegAvailable, isMp3File, transcodeFileToMp3 } from './transcode'
