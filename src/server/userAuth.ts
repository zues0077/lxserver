/**
 * 用户身份校验的间接层。
 *
 * `verifyUserAuth` 与会话表都定义在 server.ts，而 server.ts 又 import 了
 * customSourceHandlers —— 这里若直接 import server.ts 就形成循环依赖，
 * 在 CJS 下取到的很可能是未初始化的 undefined。
 *
 * 改为由 server.ts 启动时注入实现，使用方只依赖本模块。
 */
import type { IncomingMessage } from 'http'

type Verifier = (req: IncomingMessage) => string | null

let verifier: Verifier | null = null

/** 由 server.ts 在初始化时调用一次 */
export function setUserAuthVerifier(fn: Verifier): void {
  verifier = fn
}

/**
 * 返回已认证的用户名；未登录 / token 无效 / 尚未注入时返回 null。
 * 返回 null 只代表「没证明身份」，不代表「不允许访问」——是否放行由调用方决定。
 */
export function verifyUser(req: IncomingMessage): string | null {
  if (!verifier) return null
  try {
    return verifier(req)
  } catch {
    return null
  }
}
