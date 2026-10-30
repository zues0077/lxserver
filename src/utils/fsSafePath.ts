/**
 * 用户输入路径的安全校验。
 *
 * 背景（2026-10-30 246 实测）：在容器内对 `/proc/xxx` 调用 `fs.mkdirSync(..., { recursive: true })`
 * 会让进程进入**不可中断的内核等待**——HTTP 全挂、健康检查连续失败，连 120 秒的看门狗
 * （worker + SIGTERM/SIGKILL）都无法终止，只能重启容器才能恢复。
 * 因此凡是「用户填写的目录」都不能直接同步 mkdir，必须先过黑名单、再异步执行并带超时。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 虚拟 / 系统文件系统前缀。这些位置 mkdir、stat 都可能进入不可中断等待，
 * 或者根本不该用来存数据。用纯字符串比较判断，**不触达文件系统**。
 */
const UNSAFE_FS_PREFIXES = [
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/boot',
  '/etc',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/usr',
  '/selinux',
]

/**
 * 判断绝对路径是否落在系统 / 虚拟文件系统内。
 * Windows 路径（`C:/proc`）不以 `/` 开头，不会被误判。
 */
export function isUnsafeFilesystemPath(input: string): boolean {
  const norm = String(input || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  if (!norm.startsWith('/')) return false
  const lower = norm.toLowerCase()
  return UNSAFE_FS_PREFIXES.some(prefix => lower === prefix || lower.startsWith(`${prefix}/`))
}

export interface EnsureWritableDirOptions {
  /** 相对路径的基准目录（通常是 data 目录） */
  baseDir: string
  /** 报错时展示的字段名，如「配置备份目录」 */
  fieldName: string
  /** 文件系统操作超时（毫秒），默认 3000 */
  timeoutMs?: number
}

/**
 * 校验并确保目录存在且可写，返回**用户原始输入**（不含 baseDir 拼接）。
 *
 * - 空字符串直接返回 `''`（表示「用默认目录」）
 * - 含 `< > " | ? *` 直接拒绝
 * - 命中系统 / 虚拟文件系统直接拒绝（不触达 FS，避免卡死）
 * - mkdir + access 全部异步，且带超时，绝不阻塞事件循环
 */
export async function ensureWritableDir (rawPath: string, opts: EnsureWritableDirOptions): Promise<string> {
  const { baseDir, fieldName, timeoutMs = 3000 } = opts
  const trimmed = String(rawPath || '').trim()
  if (!trimmed) return ''

  if (/[<>"|?*]/.test(trimmed)) {
    throw new Error(`${fieldName} 包含非法字符 (< > " | ? *)`)
  }

  const resolved = path.isAbsolute(trimmed) ? trimmed : path.join(baseDir, trimmed)

  if (isUnsafeFilesystemPath(resolved)) {
    throw new Error(`${fieldName} 不能指向系统或虚拟目录 (${resolved})`)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        await fs.promises.mkdir(resolved, { recursive: true })
        await fs.promises.access(resolved, fs.constants.W_OK)
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('文件系统操作超时')), timeoutMs)
      }),
    ])
  } catch (e: any) {
    throw new Error(`${fieldName} 路径无效或无写入权限 (${resolved}): ${e?.message || e}`)
  } finally {
    if (timer) clearTimeout(timer)
  }

  return trimmed
}
