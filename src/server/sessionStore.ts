/**
 * 用户会话（web 登录 Token）落盘。
 *
 * 背景：userSessions 原来是纯内存 Map，容器/进程一重启就全部作废。
 * 前端 `ensureUserAuthToken()` 只在「没有 token」时才重新登录，手里拿着旧 token
 * 一律当有效 —— 于是重启之后整个页面所有需要鉴权的接口都返回 401：
 *   - /api/music/cache/check  → 401 → 前端判定「没有缓存」
 *   - /api/music/cache/file/… → 401 → <audio> 加载失败 → 触发「智能换源」
 *   - /api/music/url          → 401 → 换源也必然失败 → 自动跳过下一首 → 无限循环
 * 表现出来就是「已缓存的歌也播不了、一直在智能换源、菜单点不动」。
 *
 * 这里把会话写到 data/sessions.json（0600），启动时读回，重启不再踢人下线。
 */
import fs from 'fs'
import path from 'path'

export interface PersistedSession {
  username: string
  createdAt: number
}

const getDataPath = (): string => process.env.DATA_PATH || path.join(process.cwd(), 'data')

const getFilePath = (): string => path.join(getDataPath(), 'sessions.json')

/** 读取落盘的会话；过期的不返回，损坏的文件直接忽略（不能因为一个坏文件起不来服务） */
export const loadPersistedSessions = (ttl: number): [string, PersistedSession][] => {
  try {
    const file = getFilePath()
    if (!fs.existsSync(file)) return []
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const now = Date.now()
    const out: [string, PersistedSession][] = []
    const sessions = raw && typeof raw === 'object' ? raw.sessions : null
    if (!sessions || typeof sessions !== 'object') return []
    for (const [token, value] of Object.entries(sessions as Record<string, any>)) {
      const username = String((value && value.username) || '')
      const createdAt = Number((value && value.createdAt) || 0)
      if (!token || !username || !createdAt) continue
      if (now - createdAt > ttl) continue
      out.push([token, { username, createdAt }])
    }
    return out
  } catch (e: any) {
    console.warn(`[会话] 读取会话文件失败（忽略）: ${e?.message || e}`)
    return []
  }
}

/** 原子写入：先写临时文件再 rename，避免写一半被容器杀掉留下坏 JSON */
export const persistSessions = (sessions: Map<string, PersistedSession>): void => {
  try {
    const dataPath = getDataPath()
    if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true })
    const file = getFilePath()
    const tmp = `${file}.tmp`
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      sessions: Object.fromEntries(sessions),
    }
    fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
    try { fs.chmodSync(file, 0o600) } catch { /* 某些文件系统不支持，忽略 */ }
  } catch (e: any) {
    console.warn(`[会话] 写入会话文件失败: ${e?.message || e}`)
  }
}
