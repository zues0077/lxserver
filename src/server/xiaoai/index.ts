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
 *  - stream.ts      音频流转发（本地文件 / 远端中转）
 *  - service.ts     面向业务的高阶服务（多设备 fan-out）
 */

export { xiaoAiService } from './service'
export type { XiaoAiPublicConfig, DeviceActionResult } from './service'
export { buildStreamUrl, createStreamToken, parseStreamToken } from './streamToken'
export { serveXiaoAiStream } from './stream'
export { loadConfig as loadXiaoAiConfig } from './config'
