/**
 * 平台账号使用权限（按用户白名单）
 *
 * 需求（2026-10-26）：后台「平台账号」页勾选哪些用户（含游客）可以走账号取链；
 * 没被勾选的用户回落公开音源（自定义源、B站/汽水匿名流），账号 Cookie 不替他们消费。
 *
 * 规则：
 *   - config['musicAccount.allowedUsers'] 是用户名数组；游客统一归一为 `_open`。
 *   - **名单为空（或未配置）= 所有人可用**：默认行为不变，勾了名单才开始收紧。
 *   - 本文件不 import 任何兄弟模块：extraSources 与 musicAccount/resolvers 互相引用，
 *     权限判断放在这个独立小文件里才能被两边同时引用而不成环。
 */

/** 匿名用户的五种历史写法（与 fileCache.normalizeUsername 同一套口径，这里不引它以防依赖扩散） */
const ANON_ALIASES = ['', 'open', '_open', 'default']

export const normalizeUserForPermission = (username?: string | null): string => {
  const name = typeof username === 'string' ? username.trim() : ''
  return !name || ANON_ALIASES.includes(name) ? '_open' : name
}

/** 读取名单（过滤空串/非字符串，返回修剪后的副本） */
export const getAllowedUsers = (): string[] => {
  const list = global.lx?.config?.['musicAccount.allowedUsers']
  return Array.isArray(list)
    ? list.filter((u): u is string => typeof u === 'string' && !!u.trim()).map(u => u.trim())
    : []
}

/** 该用户是否允许使用平台账号取链。名单为空 = 所有人可用。 */
export const isUserAllowed = (username?: string | null): boolean => {
  const list = getAllowedUsers()
  if (list.length === 0) return true
  return list.includes(normalizeUserForPermission(username))
}
