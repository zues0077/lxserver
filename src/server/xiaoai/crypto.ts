import crypto from 'node:crypto'

/**
 * 小爱同学（MiniA / MIoT）接入用到的加解密工具。
 *
 * 说明：这里刻意只依赖 node:crypto，不引入任何第三方库，
 * 这样 Docker 镜像里不需要额外的 Python / 原生依赖，alpine 下也能直接跑。
 */

/** 小米登录用的密码摘要：MD5 后取大写十六进制 */
export const md5Upper = (text: string) => crypto.createHash('md5').update(text, 'utf8').digest('hex').toUpperCase()

/** serviceToken 交换用的 clientSign：base64(sha1(`nonce=${nonce}&${ssecurity}`)) */
export const sha1Base64 = (text: string) => crypto.createHash('sha1').update(text, 'utf8').digest('base64')

/** 随机十六进制串（用于伪造 deviceId） */
export const randomHex = (bytes: number) => crypto.randomBytes(bytes).toString('hex')

/** 生成一个 32 位十六进制设备标识，用于模拟手机 App */
export const generateDeviceId = () => randomHex(16)

/** 播放直链签名用的 HMAC-SHA256 */
export const hmacSha256Hex = (secret: string, payload: string) =>
  crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex')

/** 生成 Mina ubus 请求用的 requestId，格式与手机端一致：app_ios_ + 30 位随机串 */
export const generateRequestId = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = 'app_ios_'
  for (let i = 0; i < 30; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}
