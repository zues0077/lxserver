/**
 * 扫码登录驱动的公共类型
 *
 * 每个平台驱动只需要实现 create / check 两个函数：
 *   create() → 给我二维码图片 + 一段「后面轮询要用的」私有状态
 *   check(state) → 这次扫到哪一步了，成功时顺手把 Cookie 递出来
 * 会话管理、过期清理、 Cookie 落盘都在 index.ts 统一处理，驱动层不碰存储。
 */

export type QrStatus = 'waiting' | 'scanned' | 'success' | 'expired' | 'failed'

export interface QrCreateResult {
  /** 私有状态，只在服务端内存里流转，不返回给前端 */
  state: any
  /** 二维码图片（data URL，前端直接塞 img.src） */
  image: string
  /** 提示文案：告诉用户用哪个 App 扫 */
  hint: string
}

export interface QrCheckResult {
  status: QrStatus
  message?: string
  /** status === 'success' 时必须有值 */
  cookie?: string
}

export interface QrDriver {
  /** 二维码有效期（秒），用于前端倒计时与服务端会话清理 */
  ttlSec: number
  /** 建议轮询间隔（毫秒） */
  pollIntervalMs: number
  create(): Promise<QrCreateResult>
  check(state: any): Promise<QrCheckResult>
}
