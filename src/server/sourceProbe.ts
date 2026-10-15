/**
 * 自定义源「平台可用性巡检」
 *
 * 背景：一个自定义音源脚本会声明支持多个平台（wy/tx/kw/kg/mg/...），
 * 但其中某个平台的接口可能整体失效（官方风控、接口下线、脚本过期）。
 * 失效平台在播放时会白白消耗一次解析尝试，拖慢「自动切换下一个音源」的速度，
 * 用户侧表现为「点了播放要等好几秒才出声」。
 *
 * 本模块负责：
 *   1. 新添加（上传/导入）的音源 → 立即逐个平台探测一次；
 *   2. 之后按配置间隔，对「剩余可用平台」复检；
 *   3. 某平台连续失败达到阈值 → 自动关闭该平台的解析（写 states.json 的 disabledSources，
 *      与前端「平台开关」共用同一份状态，面板上能直接看到）；
 *   4. 某音源全部平台都不可用 → 自动移除该音源（默认移入同级 .trash/ 目录，可恢复）。
 *
 * 自动关闭的平台会被持续复检，一旦恢复可用会自动重新开启；
 * 而用户在面板上手动关闭的平台永远不参与复检（尊重用户意愿）。
 *
 * 与「脚本自检护栏」（sourceGuard.ts）的分工：
 *   护栏防的是「脚本本身作恶」——空死循环、反调试自旋、沙箱逃逸；
 *   本模块管的是「脚本没写错，但它依赖的平台挂了」。
 *
 * 存储：状态写在 <DATA_PATH>/users/source/<owner>/probe-status.json。
 * 该文件不在 fs.watch 的监听范围（只监听 *.js 与 sources.json），
 * 因此巡检的高频写入不会触发音源重载。
 */
import fs from 'node:fs'
import path from 'node:path'
import needle from 'needle'
import { getProxyAgent } from '@/modules/utils/proxy.js'
import { syncLog } from '@/utils/log4js'
import { markSourceBusy } from './sourceGuard'
import type { ScheduledTask, TaskExecutionResult } from './task/types'

export const PROBE_TASK_ID = 'custom_source_health_probe'
const STATUS_FILE = 'probe-status.json'
const AUDIT_FILE = 'probe-audit.log'
const TRASH_DIR = '.trash'

/** 单个平台的探测结果 */
export type PlatformProbeStatus = 'ok' | 'down' | 'skipped' | 'unknown'

export interface PlatformProbeState {
  status: PlatformProbeStatus
  /** 连续失败次数，成功即清零 */
  failCount: number
  lastCheckAt: number
  lastOkAt: number
  lastError: string
  /** 该平台的关闭是否由本模块自动执行（true 才会被自动恢复） */
  autoDisabled: boolean
}

export interface SourceProbeState {
  name: string
  platforms: Record<string, PlatformProbeState>
  removedAt?: number
  removedReason?: string
}

interface ProbeStatusFile {
  version: number
  updatedAt: number
  sources: Record<string, SourceProbeState>
}

/** 一个待巡检的音源 */
export interface ProbeTarget {
  owner: string
  id: string
  name: string
  platforms: string[]
  callRequest: (action: string, source: string, info: any) => Promise<any>
}

/** 用于探测的测试曲目 */
export interface ProbeTestSong {
  source: string
  songmid: string
  name?: string
  singer?: string
  hash?: string
  albumId?: string
  copyrightId?: string
  strMediaMid?: string
  interval?: string
}

export interface ProbeDeps {
  /** 列出当前已加载的音源（含沙箱调用入口） */
  listTargets: () => ProbeTarget[]
  /** 卸载某个音源实例 */
  unload: (owner: string, id: string) => void
  /** 取可用于探测的候选测试曲目（通常来自用户缓存索引） */
  getCachedSongs: () => ProbeTestSong[]
  /** 内置 SDK 搜索兜底：按平台取一首测试曲目 */
  searchTestSong?: (platform: string) => Promise<ProbeTestSong | null>
}

export interface ProbeRunResult {
  startedAt: number
  durationMs: number
  sourcesChecked: number
  platformsChecked: number
  platformsOk: number
  platformsDown: number
  platformsSkipped: number
  /** 本次新关闭的平台 */
  newlyDisabled: string[]
  /** 本次恢复可用的平台 */
  restored: string[]
  /** 本次移除的音源 */
  removed: string[]
  message: string
}

export interface ProbeStatusSnapshot {
  enabled: boolean
  running: boolean
  intervalMinutes: number
  failThreshold: number
  autoDisablePlatform: boolean
  autoRemoveSource: boolean
  removeMode: 'trash' | 'delete'
  lastRunAt: number | null
  lastRun: ProbeRunResult | null
  /** 当前生效的「自动关闭」平台清单 */
  autoDisabledPlatforms: Array<{ owner: string; sourceId: string; sourceName: string; platform: string; since: number }>
}

// ============================ 配置 ============================

interface ProbeConfig {
  enabled: boolean
  intervalMinutes: number
  failThreshold: number
  timeoutMs: number
  concurrency: number
  verifyLink: boolean
  autoDisablePlatform: boolean
  autoRemoveSource: boolean
  removeMode: 'trash' | 'delete'
  probeOnNewSource: boolean
  testSongs: Record<string, Partial<ProbeTestSong>>
}

const positiveNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

const configOf = (): ProbeConfig => {
  const c: any = (global.lx && global.lx.config) || {}
  const rawTestSongs = c['customSource.probe.testSongs']
  return {
    enabled: c['customSource.probe.enabled'] !== false,
    intervalMinutes: positiveNumber(c['customSource.probe.intervalMinutes'], 180),
    failThreshold: Math.max(1, Math.round(positiveNumber(c['customSource.probe.failThreshold'], 2))),
    timeoutMs: positiveNumber(c['customSource.probe.timeoutMs'], 15000),
    concurrency: Math.max(1, Math.min(8, Math.round(positiveNumber(c['customSource.probe.concurrency'], 2)))),
    verifyLink: c['customSource.probe.verifyLink'] !== false,
    autoDisablePlatform: c['customSource.probe.autoDisablePlatform'] !== false,
    autoRemoveSource: c['customSource.probe.autoRemoveSource'] !== false,
    removeMode: c['customSource.probe.removeMode'] === 'delete' ? 'delete' : 'trash',
    probeOnNewSource: c['customSource.probe.probeOnNewSource'] !== false,
    testSongs: rawTestSongs && typeof rawTestSongs === 'object' && !Array.isArray(rawTestSongs) ? rawTestSongs : {},
  }
}

// ============================ 路径工具 ============================

const dataPath = () => (global.lx && global.lx.dataPath) || process.env.DATA_PATH || path.join(process.cwd(), 'data')
const sourceRoot = () => path.join(dataPath(), 'users', 'source')
const ownerDirName = (owner: string) => (owner === 'open' ? '_open' : owner)
const ownerDir = (owner: string) => path.join(sourceRoot(), ownerDirName(owner))
const registeredUsers = (): string[] => {
  const users = (global.lx && global.lx.config && global.lx.config.users) || []
  return users.map((u: any) => u && u.name).filter((n: any): n is string => !!n)
}

/** 巡检会写入 states.json 的空间：open 源要对「公开空间 + 每个已注册用户空间」都生效 */
const stateSpacesFor = (owner: string): string[] => {
  if (owner === 'open') return ['_open', ...registeredUsers()]
  return [owner]
}

// ============================ 探测状态读写 ============================

const emptyStatus = (): ProbeStatusFile => ({ version: 1, updatedAt: 0, sources: {} })

const statusPath = (owner: string) => path.join(ownerDir(owner), STATUS_FILE)

const readStatus = (owner: string): ProbeStatusFile => {
  try {
    const file = statusPath(owner)
    if (!fs.existsSync(file)) return emptyStatus()
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sources !== 'object') return emptyStatus()
    return { version: 1, updatedAt: Number(parsed.updatedAt) || 0, sources: parsed.sources || {} }
  } catch (e: any) {
    syncLog.warn(`[音源巡检] 读取巡检状态失败 (${owner}):`, e?.message || e)
    return emptyStatus()
  }
}

const writeStatus = (owner: string, status: ProbeStatusFile) => {
  try {
    const dir = ownerDir(owner)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    status.updatedAt = Date.now()
    fs.writeFileSync(statusPath(owner), JSON.stringify(status, null, 2), 'utf-8')
  } catch (e: any) {
    syncLog.warn(`[音源巡检] 保存巡检状态失败 (${owner}):`, e?.message || e)
  }
}

/** 追加一行审计记录（移除音源 / 关闭平台等破坏性动作） */
const audit = (owner: string, action: string, payload: Record<string, any>) => {
  try {
    const dir = ownerDir(owner)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), action, ...payload })
    fs.appendFileSync(path.join(dir, AUDIT_FILE), line + '\n', 'utf-8')
  } catch { /* 审计失败不影响主流程 */ }
}

const emptyPlatformState = (): PlatformProbeState => ({
  status: 'unknown',
  failCount: 0,
  lastCheckAt: 0,
  lastOkAt: 0,
  lastError: '',
  autoDisabled: false,
})

// ============================ states.json（平台开关）读写 ============================

/** 与 customSourceHandlers.handleUpdatePlatforms 保持一致：兼容原名 / URL 编码 / 解码三种 key */
const resolveStateKey = (states: Record<string, any>, id: string): string => {
  if (states[id]) return id
  try {
    const decoded = decodeURIComponent(id)
    if (states[decoded]) return decoded
  } catch { /* ignore */ }
  try {
    const encoded = encodeURIComponent(id)
    if (states[encoded]) return encoded
  } catch { /* ignore */ }
  return id
}

interface PlatformFlags {
  /** 当前 states.json 里已关闭的平台 */
  disabled: Set<string>
}

/**
 * 读取某空间下某音源被关闭的平台。
 * 一轮巡检里同一份 states.json 会被反复查询（音源数 × 平台数），
 * 因此这里做空间级缓存，避免成百上千次同步文件读。
 */
const statesCache = new Map<string, Record<string, any>>()

const readPlatformFlags = (statesDirName: string, sourceId: string): PlatformFlags => {
  const disabled = new Set<string>()
  // 注意：不能把「读文件」的赋值留在 try 内部再于外部使用 —— TS 会认为中途可能抛出，
  // 从而把变量判为「可能 undefined」。这里先给一个安全的初值，try 只负责覆盖。
  let states: Record<string, any> = {}
  try {
    const cached = statesCache.get(statesDirName)
    if (cached) {
      states = cached
    } else {
      const file = path.join(sourceRoot(), statesDirName, 'states.json')
      if (fs.existsSync(file)) {
        try { states = JSON.parse(fs.readFileSync(file, 'utf-8')) || {} } catch { states = {} }
      }
      statesCache.set(statesDirName, states)
    }
  } catch { /* ignore */ }
  const key = resolveStateKey(states, sourceId)
  const list = states[key]?.disabledSources
  if (Array.isArray(list)) for (const p of list) if (typeof p === 'string') disabled.add(p)
  return { disabled }
}

/**
 * 关闭 / 开启某个平台。
 * 注意：被自动关闭的平台会在 states.json 里留下记录，用户在面板上手动改也会写同一份文件，
 * 因此这里必须「读-改-写」，不能整体覆盖，否则会抹掉用户的其他设置。
 */
const setPlatformDisabled = (owner: string, sourceId: string, platform: string, disabled: boolean): boolean => {
  let changed = false
  for (const space of stateSpacesFor(owner)) {
    try {
      const dir = path.join(sourceRoot(), space)
      if (!fs.existsSync(dir)) {
        if (!disabled) continue // 目录不存在时无需创建，只是开启而已
        fs.mkdirSync(dir, { recursive: true })
      }
      const file = path.join(dir, 'states.json')
      let states: Record<string, any> = {}
      if (fs.existsSync(file)) {
        try { states = JSON.parse(fs.readFileSync(file, 'utf-8')) || {} } catch { states = {} }
      }
      const key = resolveStateKey(states, sourceId)
      if (!states[key]) states[key] = {}
      const current: string[] = Array.isArray(states[key].disabledSources) ? states[key].disabledSources : []
      const has = current.includes(platform)
      if (disabled && !has) {
        states[key].disabledSources = [...current, platform]
        changed = true
      } else if (!disabled && has) {
        states[key].disabledSources = current.filter(p => p !== platform)
        changed = true
      }
      if (changed) {
        fs.writeFileSync(file, JSON.stringify(states, null, 2), 'utf-8')
        statesCache.delete(space) // 磁盘已变，缓存失效
      }
    } catch (e: any) {
      syncLog.warn(`[音源巡检] 写入平台开关失败 (${space}/${sourceId}/${platform}):`, e?.message || e)
    }
  }
  return changed
}

/** 清掉某个音源在 states.json 里的全部痕迹（音源被移除时调用） */
const clearSourceState = (owner: string, sourceId: string) => {
  for (const space of stateSpacesFor(owner)) {
    try {
      const file = path.join(sourceRoot(), space, 'states.json')
      if (!fs.existsSync(file)) continue
      const states = JSON.parse(fs.readFileSync(file, 'utf-8')) || {}
      const key = resolveStateKey(states, sourceId)
      if (states[key]) {
        delete states[key]
        fs.writeFileSync(file, JSON.stringify(states, null, 2), 'utf-8')
      }
    } catch { /* ignore */ }
  }
}

// ============================ 探测实现 ============================

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${label} 超时 (${ms}ms)`))
    }, ms)
    if (typeof (timer as any).unref === 'function') (timer as any).unref()
    Promise.resolve(promise).then(
      value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } },
      error => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } },
    )
  })

/** 与 userApi.validateReturnedMusicUrl 同等语义的轻量校验：必须是可播放的 http(s) 直链 */
const normalizeProbeUrl = (raw: any): string | null => {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return null
  // 试听/付费片段不算可用
  if (lower.includes('freetrial') || lower.includes('trial=1') || lower.includes('onlyplay')) return null
  return trimmed
}

/** 对解析出来的链接做一次轻量可达性校验（音源可能返回一个早就失效的链接） */
const checkLinkReachable = async (url: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    const resp = await needle('get', url, null, {
      follow_max: 3,
      open_timeout: 6000,
      response_timeout: 6000,
      read_timeout: 6000,
      agent: await getProxyAgent(url, 'customSource'),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: (() => { try { return new URL(url).origin } catch { return '' } })(),
        Range: 'bytes=0-1',
      },
    })
    const code = resp?.statusCode
    if (code === undefined) return { ok: false, error: '链接无响应' }
    if (code >= 400) return { ok: false, error: `链接返回 ${code}` }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: `链接探测失败: ${e?.message || e}` }
  }
}

const buildMusicInfo = (platform: string, song: ProbeTestSong) => {
  const info: Record<string, any> = {
    songmid: song.songmid,
    name: song.name || '',
    singer: song.singer || '',
    source: platform,
  }
  if (song.hash) info.hash = song.hash
  if (song.albumId) info.albumId = song.albumId
  if (song.copyrightId) info.copyrightId = song.copyrightId
  if (song.strMediaMid) info.strMediaMid = song.strMediaMid
  if (song.interval) info.interval = song.interval
  return info
}

/**
 * 探测单个音源的单个平台。
 * 判定顺序：音源能否返回链接 → 链接本身是否可达（可配置关闭）。
 */
const probePlatform = async (
  target: ProbeTarget,
  platform: string,
  song: ProbeTestSong,
  conf: ProbeConfig,
): Promise<{ ok: boolean; error?: string }> => {
  let rawUrl: any
  try {
    rawUrl = await withTimeout(
      target.callRequest('musicUrl', platform, {
        musicInfo: buildMusicInfo(platform, song),
        quality: '128k',
        type: '128k',
      }),
      conf.timeoutMs,
      `${target.name}/${platform}`,
    )
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || String(e) }
  }

  const url = normalizeProbeUrl(rawUrl)
  if (!url) return { ok: false, error: '音源未返回有效播放链接' }

  if (conf.verifyLink) {
    const reachable = await checkLinkReachable(url)
    if (!reachable.ok) return { ok: false, error: reachable.error }
  }
  return { ok: true }
}

// ============================ 测试曲目 ============================

let cachedSongPool: ProbeTestSong[] = []
let cachedSongPoolAt = 0

const buildSongPool = (deps: ProbeDeps): ProbeTestSong[] => {
  const conf = configOf()
  const pool: ProbeTestSong[] = []
  const seen = new Set<string>()
  const push = (song: ProbeTestSong) => {
    if (!song || !song.source || !song.songmid) return
    const key = `${song.source}_${song.songmid}`
    if (seen.has(key)) return
    seen.add(key)
    pool.push(song)
  }

  // 1) 配置里的覆盖优先
  for (const [platform, raw] of Object.entries(conf.testSongs)) {
    if (!raw || !raw.songmid) continue
    push({ source: platform, songmid: String(raw.songmid), name: raw.name, singer: raw.singer, hash: raw.hash, albumId: raw.albumId, copyrightId: raw.copyrightId, strMediaMid: raw.strMediaMid, interval: raw.interval })
  }

  // 2) 用户缓存里实际播放成功过的歌（最贴近真实场景，零配置）
  try {
    for (const item of deps.getCachedSongs()) push(item)
  } catch { /* ignore */ }

  return pool
}

const getSongPool = (deps: ProbeDeps): ProbeTestSong[] => {
  if (Date.now() - cachedSongPoolAt > 5 * 60 * 1000 || !cachedSongPool.length) {
    cachedSongPool = buildSongPool(deps)
    cachedSongPoolAt = Date.now()
  }
  return cachedSongPool
}

/** 为平台挑一首测试曲目：配置/缓存 → 内置 SDK 搜索 → 放弃（跳过，不判定为不可用） */
const pickTestSong = async (platform: string, deps: ProbeDeps): Promise<ProbeTestSong | null> => {
  const fromPool = getSongPool(deps).find(s => s.source === platform)
  if (fromPool) return fromPool
  if (deps.searchTestSong) {
    try {
      const found = await deps.searchTestSong(platform)
      if (found && found.songmid) {
        cachedSongPool.push(found)
        return found
      }
    } catch { /* ignore */ }
  }
  return null
}

// ============================ 音源移除 ============================

/** 把脚本文件移入同级 .trash/，或直接删除 */
const disposeScriptFile = (owner: string, sourceId: string, mode: 'trash' | 'delete'): string | null => {
  const dir = ownerDir(owner)
  const scriptPath = path.join(dir, sourceId)
  if (!fs.existsSync(scriptPath)) return null
  try {
    if (mode === 'delete') {
      fs.unlinkSync(scriptPath)
      return null
    }
    const trashDir = path.join(dir, TRASH_DIR)
    if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(trashDir, `${stamp}_${sourceId}`)
    fs.renameSync(scriptPath, target)
    return target
  } catch (e: any) {
    syncLog.warn(`[音源巡检] 移除脚本文件失败 (${owner}/${sourceId}):`, e?.message || e)
    return null
  }
}

/** 从 sources.json 中摘除该音源条目 */
const dropFromManifest = (owner: string, sourceId: string): boolean => {
  try {
    const dir = ownerDir(owner)
    const metaPath = path.join(dir, 'sources.json')
    if (!fs.existsSync(metaPath)) return false
    const sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    if (!Array.isArray(sources)) return false
    const next = sources.filter((s: any) => s && s.id !== sourceId)
    if (next.length === sources.length) return false
    fs.writeFileSync(metaPath, JSON.stringify(next, null, 2), 'utf-8')
    return true
  } catch (e: any) {
    syncLog.warn(`[音源巡检] 更新 sources.json 失败 (${owner}/${sourceId}):`, e?.message || e)
    return false
  }
}

/**
 * 移除一个「全部平台都不可用」的音源。
 * 顺序刻意安排为「先卸载实例 → 再删文件 → 最后改 sources.json」：
 * unload 会把该空间标记为「刚刚重载过」，fs.watch 的 4 秒防抖会因此忽略后续文件变动，
 * 避免删除动作触发一次无谓的全量重载。
 */
const removeSource = (owner: string, sourceId: string, sourceName: string, reason: string, deps: ProbeDeps, conf: ProbeConfig): boolean => {
  try {
    deps.unload(owner, sourceId)
  } catch { /* ignore */ }
  const trashedTo = disposeScriptFile(owner, sourceId, conf.removeMode)
  dropFromManifest(owner, sourceId)
  clearSourceState(owner, sourceId)
  audit(owner, 'remove-source', {
    sourceId,
    sourceName,
    reason,
    mode: conf.removeMode,
    trashedTo,
  })
  console.warn(`[音源巡检] ⚠ 已移除音源: ${sourceName} (${sourceId}) —— ${reason}${trashedTo ? `（脚本已移至 ${TRASH_DIR}/ 可恢复）` : ''}`)
  return true
}

// ============================ 主流程 ============================

let depsRef: ProbeDeps | null = null
let running = false
let lastRunAt: number | null = null
let lastRun: ProbeRunResult | null = null
let scheduledTimer: NodeJS.Timeout | null = null
let periodicTimer: NodeJS.Timeout | null = null

export function startSourceProbe(deps: ProbeDeps): void {
  depsRef = deps
  const conf = configOf()
  if (!conf.enabled) {
    console.log('[音源巡检] 未启用（customSource.probe.enabled = false），跳过初始化')
    return
  }
  console.log(`[音源巡检] 已启用：间隔=${conf.intervalMinutes} 分钟，连续失败 ${conf.failThreshold} 次判定不可用，` +
    `自动关闭平台=${conf.autoDisablePlatform ? '开' : '关'}，全平台失效自动移除=${conf.autoRemoveSource ? '开' : '关'}（${conf.removeMode}）`)
}

export function stopSourceProbe(): void {
  if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null }
  if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null }
}

/**
 * 执行一轮巡检。
 * @param options.owner 只巡检该空间（不传则全部空间）
 * @param options.only  只巡检指定音源（用于「新添加的音源立即检测」）
 */
export async function runSourceProbe(options: { owner?: string; only?: { owner: string; id: string } } = {}): Promise<ProbeRunResult> {
  const startedAt = Date.now()
  const empty: ProbeRunResult = {
    startedAt, durationMs: 0, sourcesChecked: 0, platformsChecked: 0,
    platformsOk: 0, platformsDown: 0, platformsSkipped: 0,
    newlyDisabled: [], restored: [], removed: [],
    message: '未执行',
  }

  const deps = depsRef
  if (!deps) return { ...empty, message: '巡检未初始化' }
  const conf = configOf()
  if (!conf.enabled) return { ...empty, message: '巡检已关闭' }
  if (running) return { ...empty, message: '上一轮巡检仍在进行中，跳过本次' }

  running = true
  lastRunAt = startedAt
  statesCache.clear()
  // 探测期间会有持续的解析与网络开销，标记为「忙碌」避免被自检护栏误判成异常空转
  markSourceBusy(conf.timeoutMs * 4)
  const busyTicker = setInterval(() => markSourceBusy(conf.timeoutMs * 2), Math.max(5000, conf.timeoutMs))

  try {
    let targets = deps.listTargets()
    if (options.owner) targets = targets.filter(t => t.owner === options.owner)
    if (options.only) targets = targets.filter(t => t.owner === options.only!.owner && t.id === options.only!.id)

    const result: ProbeRunResult = {
      startedAt, durationMs: 0, sourcesChecked: targets.length, platformsChecked: 0,
      platformsOk: 0, platformsDown: 0, platformsSkipped: 0,
      newlyDisabled: [], restored: [], removed: [],
      message: '',
    }

    const statusByOwner = new Map<string, ProbeStatusFile>()
    const statusFor = (owner: string): ProbeStatusFile => {
      let s = statusByOwner.get(owner)
      if (!s) { s = readStatus(owner); statusByOwner.set(owner, s) }
      return s
    }

    interface Job { target: ProbeTarget; platform: string; song: ProbeTestSong | null }
    const jobs: Job[] = []

    for (const target of targets) {
      const status = statusFor(target.owner)
      if (!status.sources[target.id]) status.sources[target.id] = { name: target.name, platforms: {} }
      const sourceState = status.sources[target.id]
      sourceState.name = target.name

      for (const platform of target.platforms) {
        if (!sourceState.platforms[platform]) sourceState.platforms[platform] = emptyPlatformState()
        const platformState = sourceState.platforms[platform]

        // 用户在面板上手动关闭的平台：尊重用户选择，永不参与自动复检
        const manuallyDisabled = readPlatformFlags(ownerDirName(target.owner), target.id).disabled.has(platform) && !platformState.autoDisabled
        if (manuallyDisabled) {
          platformState.status = 'skipped'
          result.platformsSkipped++
          continue
        }

        const song = await pickTestSong(platform, deps)
        if (!song) {
          platformState.status = 'skipped'
          platformState.lastCheckAt = Date.now()
          platformState.lastError = '无可用测试曲目'
          result.platformsSkipped++
          continue
        }
        jobs.push({ target, platform, song })
      }
    }

    // 并发消费探测任务
    let cursor = 0
    const worker = async () => {
      while (true) {
        const index = cursor++
        if (index >= jobs.length) return
        const job = jobs[index]
        const status = statusFor(job.target.owner)
        const platformState = status.sources[job.target.id].platforms[job.platform]
        result.platformsChecked++

        const outcome = await probePlatform(job.target, job.platform, job.song!, conf)
        platformState.lastCheckAt = Date.now()

        if (outcome.ok) {
          platformState.status = 'ok'
          platformState.failCount = 0
          platformState.lastOkAt = Date.now()
          platformState.lastError = ''
          result.platformsOk++

          // 之前被自动关闭的平台恢复可用 → 自动重新开启
          if (platformState.autoDisabled) {
            platformState.autoDisabled = false
            setPlatformDisabled(job.target.owner, job.target.id, job.platform, false)
            result.restored.push(`${job.target.name}/${job.platform}`)
            audit(job.target.owner, 'restore-platform', { sourceId: job.target.id, sourceName: job.target.name, platform: job.platform })
            console.log(`[音源巡检] ✓ 平台已恢复，自动重新开启: ${job.target.name} / ${job.platform}`)
          }
        } else {
          platformState.failCount++
          platformState.lastError = outcome.error || '未知错误'
          if (platformState.failCount >= conf.failThreshold) {
            platformState.status = 'down'
            result.platformsDown++
            if (conf.autoDisablePlatform && !platformState.autoDisabled) {
              platformState.autoDisabled = true
              setPlatformDisabled(job.target.owner, job.target.id, job.platform, true)
              result.newlyDisabled.push(`${job.target.name}/${job.platform}`)
              audit(job.target.owner, 'disable-platform', {
                sourceId: job.target.id, sourceName: job.target.name,
                platform: job.platform, failCount: platformState.failCount, error: platformState.lastError,
              })
              console.warn(`[音源巡检] ⚠ 已关闭平台解析: ${job.target.name} / ${job.platform}（连续失败 ${platformState.failCount} 次，原因：${platformState.lastError}）`)
            }
          } else {
            platformState.status = 'unknown'
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(conf.concurrency, Math.max(1, jobs.length)) }, () => worker()))

    // 全平台不可用 → 移除音源
    if (conf.autoRemoveSource) {
      for (const target of targets) {
        const status = statusFor(target.owner)
        const sourceState = status.sources[target.id]
        const platforms = Object.entries(sourceState.platforms)
        if (!platforms.length || sourceState.removedAt) continue
        if (!target.platforms.length) continue

        // 必须「每个平台都有明确的失败结论」，任何 skipped 都视为证据不足，不删
        let allDown = true
        let hasEvidence = false
        for (const platform of target.platforms) {
          const ps = sourceState.platforms[platform]
          if (!ps) { allDown = false; break }
          if (ps.status === 'down') { hasEvidence = true; continue }
          if (ps.status === 'skipped') { allDown = false; break }
          allDown = false
          break
        }

        if (allDown && hasEvidence) {
          const reason = `全部平台（${target.platforms.join(', ')}）连续失败达阈值`
          if (removeSource(target.owner, target.id, target.name, reason, deps, conf)) {
            sourceState.removedAt = Date.now()
            sourceState.removedReason = reason
            result.removed.push(`${target.name} (${target.id})`)
          }
        }
      }
    }

    for (const [owner, status] of statusByOwner) writeStatus(owner, status)

    result.durationMs = Date.now() - startedAt
    result.message =
      `巡检 ${targets.length} 个音源的 ${result.platformsChecked} 个平台：` +
      `可用 ${result.platformsOk}、不可用 ${result.platformsDown}、跳过 ${result.platformsSkipped}` +
      (result.newlyDisabled.length ? `；新关闭 ${result.newlyDisabled.length} 个平台` : '') +
      (result.restored.length ? `；恢复 ${result.restored.length} 个平台` : '') +
      (result.removed.length ? `；移除 ${result.removed.length} 个音源` : '')

    lastRun = result
    console.log(`[音源巡检] 本轮完成（${result.durationMs}ms）：${result.message}`)
    return result
  } catch (e: any) {
    const message = `巡检异常: ${(e && e.message) || e}`
    console.error(`[音源巡检] ${message}`)
    const failed: ProbeRunResult = { ...empty, durationMs: Date.now() - startedAt, message }
    lastRun = failed
    return failed
  } finally {
    running = false
    clearInterval(busyTicker)
  }
}

/**
 * 新添加的音源 → 立即巡检一次。
 * 刻意异步、不阻塞上传响应，且失败只记日志。
 */
export function probeNewSource(owner: string, sourceId: string): void {
  const conf = configOf()
  if (!conf.enabled || !conf.probeOnNewSource) return
  if (!depsRef) return
  // 等音源实例注册进 loadedApis 后再探测
  setTimeout(() => {
    void runSourceProbe({ only: { owner, id: sourceId } })
      .catch(err => syncLog.warn('[音源巡检] 新增音源巡检失败:', err?.message || err))
  }, 3000)
}

/** 注册到后台任务调度器 */
export function createSourceProbeTask(): ScheduledTask {
  const conf = configOf()
  const task: ScheduledTask = {
    id: PROBE_TASK_ID,
    name: '自定义源平台可用性巡检',
    intervalMs: conf.intervalMinutes * 60 * 1000,
    enabled: conf.enabled,
    isRunning: false,
    run: async (): Promise<TaskExecutionResult> => {
      const result = await runSourceProbe()
      return {
        taskId: PROBE_TASK_ID,
        timestamp: Date.now(),
        success: true,
        message: result.message,
        details: result,
      }
    },
  }
  scheduledTimer = null
  return task
}

export function getSourceProbeStatus(): ProbeStatusSnapshot {
  const conf = configOf()
  const autoDisabledPlatforms: ProbeStatusSnapshot['autoDisabledPlatforms'] = []
  const owners = new Set<string>()
  for (const target of depsRef ? depsRef.listTargets() : []) owners.add(target.owner)
  for (const owner of owners) {
    const status = readStatus(owner)
    for (const [sourceId, sourceState] of Object.entries(status.sources)) {
      // 已被移除的音源不再上报（它的平台开关记录已经清干净了）
      if (sourceState.removedAt) continue
      for (const [platform, platformState] of Object.entries(sourceState.platforms || {})) {
        if (platformState.autoDisabled) {
          autoDisabledPlatforms.push({
            owner,
            sourceId,
            sourceName: sourceState.name,
            platform,
            since: platformState.lastCheckAt,
          })
        }
      }
    }
  }
  return {
    enabled: conf.enabled,
    running,
    intervalMinutes: conf.intervalMinutes,
    failThreshold: conf.failThreshold,
    autoDisablePlatform: conf.autoDisablePlatform,
    autoRemoveSource: conf.autoRemoveSource,
    removeMode: conf.removeMode,
    lastRunAt,
    lastRun,
    autoDisabledPlatforms,
  }
}
