/**
 * 删除用户时清理该用户的自定义音源空间（借鉴上游 v2.2.0 `userSourceCleanup.ts` 的思路）。
 *
 * 背景：自定义音源脚本、`sources.json`、`order.json`、`states.json`、`probe-status.json`
 * 都存在 `<DATA_PATH>/users/source/<username>/` 下（见 `userApi.ts` / `sourceProbe.ts`），
 * 而用户数据目录是 `<DATA_PATH>/users/<getUserDirname(name)>/`，**两棵独立目录树**。
 * 旧逻辑删除用户且勾选 `deleteData` 时只 `fs.rmSync(user.dataPath)`，
 * 这些音源文件会永久残留：既占空间，又可能在同名新用户建立后被继承。
 *
 * 安全边界：
 *   - 只删 `<source root>/<username>` 这一个目录，绝不碰 `_open` 公共空间和其他用户；
 *   - 拒绝 `open` / `default` / `_open` 以及含路径分隔符或 `..` 的用户名，防目录穿越；
 *   - 目录不存在视为「无需清理」，不算失败；删除失败返回结果而不抛，由调用方记日志。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 解析用户音源目录；不安全或应保留的空间返回 null */
export const resolveUserSourceDir = (dataPath: string, userName: string): string | null => {
    if (!dataPath || !userName) return null
    // `_open` 是匿名/公共音源空间，`open`/`default` 是内置保留名，绝不清理
    if (userName === '_open' || userName === 'open' || userName === 'default') return null
    // 防目录穿越：用户名必须是一段合法的单层目录名
    if (userName !== path.basename(userName) || userName === '.' || userName === '..' ||
        userName.includes('/') || userName.includes('\\') || userName.includes('..')) return null
    const sourceRoot = path.join(dataPath, 'users', 'source')
    const dir = path.join(sourceRoot, userName)
    // 再兜一层：规范化后父目录必须仍是 sourceRoot
    if (path.dirname(path.resolve(dir)) !== path.resolve(sourceRoot)) return null
    return dir
}

export interface UserSourceCleanupResult {
    /** 目录是否确实被删除 */
    removed: boolean
    /** 解析出的目录（被拒绝时为 null） */
    dir: string | null
    /** 失败原因（成功/跳过为空） */
    error?: string
}

/** 清理单个用户的自定义音源空间；失败不抛，由调用方记日志 */
export const cleanupUserSources = (dataPath: string, userName: string): UserSourceCleanupResult => {
    const dir = resolveUserSourceDir(dataPath, userName)
    if (!dir) return { removed: false, dir: null }
    if (!fs.existsSync(dir)) return { removed: false, dir }
    try {
        fs.rmSync(dir, { recursive: true, force: true })
        return { removed: true, dir }
    } catch (err) {
        return { removed: false, dir, error: err instanceof Error ? err.message : String(err) }
    }
}
