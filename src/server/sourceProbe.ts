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
import { beginProbeQuiet, endProbeQuiet } from './probeQuiet'
import { beginHostActivity, endHostActivity } from './sourceActivity'
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
  /**
   * 「平台侧疑似异常」停探截止时间。
   * 该平台在过半音源上同时失败（测试曲目不可播/平台限流）时，再探一遍结果也一样，
   * 却要实打实烧掉几分钟 CPU 与出口带宽——停探半个周期，下一轮自动重新探测，
   * 平台恢复最多晚一个周期发现。
   */
  suspectSkipUntil?: number
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
  /** 各平台声明的音质列表（脚本 send 时自报）；探测时优先挑它支持的音质，避免因「不支持该音质」被误判为失效 */
  qualities?: Record<string, string[]>
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
  /**
   * 本轮被判定为「平台侧系统性异常」而暂缓处置的平台。
   *
   * 判据：该平台在多数音源上同时失败。此时更可能是测试曲目不可播、
   * 平台侧限流等外部原因，而不是某个音源坏了 —— 自动关闭/删除会造成大面积误伤，
   * 因此本轮只记录、不处置，交由使用者判断。
   */
  suspectPlatforms: Array<{ platform: string; checked: number; failed: number; ok: number }>
  /** 本轮因「上轮平台侧疑似异常」而停探的平台（去重） */
  suspectSkippedPlatforms: string[]
  message: string
}

/** 单个「音源 × 平台」的巡检明细，用于排查某个平台为什么被判不可用 */
export interface ProbePlatformDetail {
  owner: string
  sourceId: string
  sourceName: string
  platform: string
  status: PlatformProbeStatus
  /** 是否由本次巡检自动关闭（区别于用户在面板上手动关闭） */
  autoDisabled: boolean
  /** 连续失败次数（成功即归零） */
  failCount: number
  lastCheckAt: number
  lastOkAt: number
  lastError: string
}

export interface ProbeStatusSnapshot {
  enabled: boolean
  running: boolean
  intervalMinutes: number
  failThreshold: number
  /** 当前生效的探测并发路数（config.js 的 customSource.probe.concurrency） */
  concurrency: number
  autoDisablePlatform: boolean
  autoRemoveSource: boolean
  removeMode: 'trash' | 'delete'
  lastRunAt: number | null
  lastRun: ProbeRunResult | null
  /** 已排队、等待巡检的「新增音源」数量（撞上正在跑的轮次时会排队，不会丢） */
  pendingNewSources: number
  /** 当前生效的「自动关闭」平台清单 */
  autoDisabledPlatforms: Array<{ owner: string; sourceId: string; sourceName: string; platform: string; since: number }>
  /** 逐平台明细：仅在 includeDetail=true 时返回，避免 /health 常规轮询被撑大 */
  details?: ProbePlatformDetail[]
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
  /** 平台失败率超过该比例即视为「平台侧系统性异常」，本轮暂缓自动处置 */
  systemicFailureRatio: number
  /** 平台侧疑似异常的平台停探半个周期（省掉注定失败的重复探测，配置可关） */
  suspectBackoff: boolean
}

/**
 * 判定「平台侧系统性异常」的默认比例：某平台本轮在 [该比例] 以上的音源上失败即视为平台侧问题。
 *
 * 刻意不设「最少样本数」门槛：小音源库（某平台只有 1~2 个音源声明）恰恰最经不起误伤，
 * 而单个样本失败本来也无法区分「平台坏了」和「测试曲目不可播」——
 * 证据不足时宁可只报告、不自动处置。
 */
const DEFAULT_SYSTEMIC_RATIO = 0.5
/** 单个平台每轮最多尝试几首测试曲目（第一首失败后换歌重试，降低单曲失灵的误判） */
const MAX_SONG_ATTEMPTS = 3

const positiveNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

/** 取 [0,1] 区间的比例配置 */
const ratioNumber = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
}

const configOf = (): ProbeConfig => {
  const c: any = (global.lx && global.lx.config) || {}
  const rawTestSongs = c['customSource.probe.testSongs']
  return {
    enabled: c['customSource.probe.enabled'] !== false,
    intervalMinutes: positiveNumber(c['customSource.probe.intervalMinutes'], 180),
    failThreshold: Math.max(1, Math.round(positiveNumber(c['customSource.probe.failThreshold'], 2))),
    timeoutMs: positiveNumber(c['customSource.probe.timeoutMs'], 15000),
    // 并发默认 6：实测 40 音源 × 152 平台在并发 2 下要跑 356 秒，
    // 窗口越长越容易和用户播放撞车（抢出口带宽与 CPU）。单平台多为网络等待，提并发 safe。
    concurrency: Math.max(1, Math.min(8, Math.round(positiveNumber(c['customSource.probe.concurrency'], 6)))),
    verifyLink: c['customSource.probe.verifyLink'] !== false,
    autoDisablePlatform: c['customSource.probe.autoDisablePlatform'] !== false,
    autoRemoveSource: c['customSource.probe.autoRemoveSource'] !== false,
    removeMode: c['customSource.probe.removeMode'] === 'delete' ? 'delete' : 'trash',
    probeOnNewSource: c['customSource.probe.probeOnNewSource'] !== false,
    testSongs: rawTestSongs && typeof rawTestSongs === 'object' && !Array.isArray(rawTestSongs) ? rawTestSongs : {},
    systemicFailureRatio: ratioNumber(c['customSource.probe.systemicFailureRatio'], DEFAULT_SYSTEMIC_RATIO),
    suspectBackoff: c['customSource.probe.suspectBackoff'] !== false,
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

/** 错误信息可能很长（音源会把整个 HTML/堆栈抛出来），落盘前截断，避免状态文件膨胀 */
const shorten = (text: string, max = 300): string =>
  typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : (text || '')

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

/** 链接所在的域名，仅用于把失败原因写清楚（便于判断是 CDN/域名问题还是音源问题） */
const hostOf = (url: string): string => {
  try { return new URL(url).host } catch { return '未知域名' }
}

const LINK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * 用「取到响应头就断开」的 GET 复核链接。
 *
 * 只发 Range: bytes=0-1 且一拿到响应头立刻 abort，理论上不下载任何音频数据体；
 * 即便 CDN 忽略 Range 开始回传整个文件，也会在第一个数据块到达时被掐断。
 */
const confirmLinkByGet = (url: string, agent: any): Promise<{ ok: boolean; code?: number; error?: string }> =>
  new Promise(resolve => {
    let settled = false
    const done = (v: { ok: boolean; code?: number; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      try { stream?.abort() } catch { /* ignore */ }
      done({ ok: false, error: `GET 复核超时（${hostOf(url)}）` })
    }, 8000)
    if (typeof (timer as any).unref === 'function') (timer as any).unref()

    let stream: any
    try {
      stream = needle.get(url, {
        follow_max: 3,
        open_timeout: 6000,
        response_timeout: 6000,
        agent,
        headers: {
          'User-Agent': LINK_UA,
          Referer: (() => { try { return new URL(url).origin } catch { return '' } })(),
          Range: 'bytes=0-1',
        },
      })
    } catch (e: any) {
      done({ ok: false, error: `GET 复核失败（${hostOf(url)}）: ${e?.message || e}` })
      return
    }

    // 拿到响应头即可判定，立刻断开，绝不下完整个音频文件
    stream.on('header', (code: number) => {
      try { stream.abort() } catch { /* ignore */ }
      done({ ok: code >= 200 && code < 400, code })
    })
    // 兜底：万一 header 事件没拿到就已经有数据体，也立即断开
    stream.on('data', () => { try { stream.abort() } catch { /* ignore */ } })
    stream.on('error', (e: any) => done({ ok: false, error: `GET 复核失败（${hostOf(url)}）: ${e?.message || e}` }))
  })

/**
 * 对解析出来的链接做一次轻量可达性校验。
 *
 * 用 HEAD 是刻意的：音频直链可能是几十 MB 的 flac，普通 GET 会变成流量炸弹。
 * 但 HEAD 的结果有两类天然歧义，处理方式如下：
 *   - 405/501：服务端不支持 HEAD → 无法判定，保守放行；
 *   - 4xx：部分 CDN 对 HEAD 一律回 403/404，而正常 GET 却能播 → 用一次
 *     「取到响应头就断开」的 GET 复核，两者都 4xx 才判定链接不可用。
 * 连接层失败（DNS 解析不到、拒绝连接、TLS 过期、超时）没有歧义，直接判定不可用 ——
 * 这类失败用户点播同样放不出来。
 */
const checkLinkReachable = async (url: string): Promise<{ ok: boolean; error?: string }> => {
  const host = hostOf(url)
  let agent: any
  try {
    agent = await getProxyAgent(url, 'customSource')
  } catch { /* 代理不可用时退回直连 */ }

  let code: number | undefined
  try {
    const resp = await needle('head', url, null, {
      follow_max: 3,
      open_timeout: 6000,
      response_timeout: 6000,
      read_timeout: 6000,
      agent,
      headers: { 'User-Agent': LINK_UA, Referer: (() => { try { return new URL(url).origin } catch { return '' } })() },
    })
    code = resp?.statusCode
  } catch (e: any) {
    return { ok: false, error: `链接探测失败（${host}）: ${shorten(e?.message || String(e), 120)}` }
  }

  if (code === undefined) return { ok: false, error: `链接无响应（${host}）` }
  if (code === 405 || code === 501) return { ok: true } // 服务端不支持 HEAD，无法判定
  if (code < 400) return { ok: true }
  if (code >= 500) return { ok: false, error: `链接返回 ${code}（${host}）` }

  // 4xx：HEAD 结果存疑，用截断式 GET 复核一次
  const confirm = await confirmLinkByGet(url, agent)
  if (confirm.ok) return { ok: true }
  if (confirm.code !== undefined) return { ok: false, error: `链接返回 ${code}/GET ${confirm.code}（${host}）` }
  return { ok: false, error: confirm.error || `链接返回 ${code}（${host}）` }
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
 * 挑选探测用的音质。
 *
 * 音源脚本会声明每个平台支持哪些音质（`qualitys`）。若我们固定用 128k，
 * 而某个脚本只支持 320k/flac，请求会被它拒绝，表现为「参数错误 / 未返回链接」——
 * 那是我们请求得不对，不是平台坏了。所以优先用脚本自己声明的音质。
 */
const pickQuality = (target: ProbeTarget, platform: string): string => {
  const list = (target.qualities && target.qualities[platform]) || []
  if (!Array.isArray(list) || !list.length) return '128k'
  if (list.includes('128k')) return '128k'
  const first = list.find(q => typeof q === 'string' && !!q)
  return first || '128k'
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
  const quality = pickQuality(target, platform)
  let rawUrl: any
  try {
    rawUrl = await withTimeout(
      target.callRequest('musicUrl', platform, {
        musicInfo: buildMusicInfo(platform, song),
        quality,
        type: quality,
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

/** 平台 → 候选测试曲目列表（多首，按优先级）。单曲可能恰好无版权/需会员，多候选能显著降低误判。 */
let cachedSongPool: Map<string, ProbeTestSong[]> = new Map()
let cachedSongPoolAt = 0

const buildSongPool = (deps: ProbeDeps): Map<string, ProbeTestSong[]> => {
  const conf = configOf()
  const map = new Map<string, ProbeTestSong[]>()
  const seen = new Set<string>()
  const push = (song: ProbeTestSong) => {
    if (!song || !song.source || !song.songmid) return
    const key = `${song.source}_${song.songmid}`
    if (seen.has(key)) return
    seen.add(key)
    const list = map.get(song.source)
    if (list) list.push(song)
    else map.set(song.source, [song])
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

  return map
}

const getSongPool = (deps: ProbeDeps): Map<string, ProbeTestSong[]> => {
  if (Date.now() - cachedSongPoolAt > 5 * 60 * 1000 || !cachedSongPool.size) {
    cachedSongPool = buildSongPool(deps)
    cachedSongPoolAt = Date.now()
  }
  return cachedSongPool
}

/** 已尝试过内置搜索的平台（含搜索失败），避免同一轮里对同一平台反复发起搜索 */
const searchAttempted = new Set<string>()
/** 本轮是否已因「池中缺该平台」补刷过曲目池（每轮最多一次，避免重复扫描缓存索引） */
let poolRefreshedThisRound = false

/**
 * 为平台取候选测试曲目：配置/缓存（可能多首）→ 内置 SDK 搜索兜底（1 首）。
 * 返回空数组表示取不到曲目，此时该平台本轮「跳过」，不参与可用性判定。
 */
const pickTestSongs = async (platform: string, deps: ProbeDeps): Promise<ProbeTestSong[]> => {
  let list = getSongPool(deps).get(platform)
  if ((!list || !list.length) && !poolRefreshedThisRound) {
    // 池子有 5 分钟缓存期，期间用户可能刚播放过新的歌；池中缺该平台时本轮补刷一次
    poolRefreshedThisRound = true
    cachedSongPool = buildSongPool(deps)
    cachedSongPoolAt = Date.now()
    list = cachedSongPool.get(platform)
  }
  if (list && list.length) return list.slice(0, MAX_SONG_ATTEMPTS)
  if (!deps.searchTestSong) return []
  if (searchAttempted.has(platform)) return []
  searchAttempted.add(platform)
  try {
    const found = await deps.searchTestSong(platform)
    if (found && found.songmid) {
      // 兜底搜索到的曲目也放进池子，后续轮次可直接复用
      const exist = cachedSongPool.get(platform)
      if (exist) exist.push(found)
      else cachedSongPool.set(platform, [found])
      return [found]
    }
  } catch { /* ignore */ }
  return []
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
  syncLog.warn(`[音源巡检] ⚠ 已移除音源: ${sourceName} (${sourceId}) —— ${reason}${trashedTo ? `（脚本已移至 ${TRASH_DIR}/ 可恢复）` : ''}`)
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
  syncLog.info(`[音源巡检] 已启用：间隔=${conf.intervalMinutes} 分钟，连续失败 ${conf.failThreshold} 次判定不可用，` +
    `自动关闭平台=${conf.autoDisablePlatform ? '开' : '关'}，全平台失效自动移除=${conf.autoRemoveSource ? '开' : '关'}（${conf.removeMode}）`)
}

export function stopSourceProbe(): void {
  if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null }
  if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null }
  if (pendingNewTimer) { clearTimeout(pendingNewTimer); pendingNewTimer = null }
}

/** 「新增音源立即检测」的聚合窗口：窗口内多次上传/导入合并成一轮，而不是每个源各跑一轮 */
const NEW_SOURCE_DEBOUNCE_MS = 3000
/**
 * 新音源撞上「正在巡检」时的兜底重排间隔。
 * 正常路径是等本轮跑完由 finally 唤醒，这个定时器只为「finally 因意外没走到」兜底。
 */
const NEW_SOURCE_FALLBACK_MS = 60000

/** 待巡检的新音源（按 owner_id 去重，批量导入只会合并成一轮） */
const pendingNewSources = new Map<string, { owner: string; id: string }>()
let pendingNewTimer: NodeJS.Timeout | null = null

/**
 * 排队并（延迟）执行一批新音源的巡检。
 *
 * 关键点：`runSourceProbe` 有全局 `running` 锁，撞上一轮巡检（可能跑几分钟）时**只会返回
 * 「跳过本次」**。如果此时把这一批源当作已处理，它们就会**被静默丢弃**，
 * 一直等到下一轮周期巡检（默认 3 小时）才被探到 —— 所以这里发现锁被占时
 * 把这批源留在队列里，等本轮结束后重排。
 */
function armNewSourceTimer(delayMs: number): void {
  if (pendingNewTimer) return
  pendingNewTimer = setTimeout(() => {
    pendingNewTimer = null
    if (!pendingNewSources.size) return

    // 上一轮还在跑：留在队列里，等本轮结束（见 wakePendingNewSources）
    if (running) {
      armNewSourceTimer(NEW_SOURCE_FALLBACK_MS)
      return
    }

    const batch = Array.from(pendingNewSources.values())
    pendingNewSources.clear()
    void runSourceProbe({ only: batch, firstProbe: true })
      .catch(err => syncLog.warn('[音源巡检] 新增音源巡检失败:', err?.message || err))
      .finally(() => {
        // 探测期间可能又有新源进来（其定时器被 running 挡回），兜底唤醒一次
        if (pendingNewSources.size) wakePendingNewSources()
      })
  }, delayMs)
  if (typeof (pendingNewTimer as any).unref === 'function') (pendingNewTimer as any).unref()
}

/** 一轮巡检结束 → 唤醒排队中的新音源：撤掉兜底定时器，改挂短延迟立即执行 */
function wakePendingNewSources(): void {
  if (!pendingNewSources.size) return
  if (pendingNewTimer) { clearTimeout(pendingNewTimer); pendingNewTimer = null }
  armNewSourceTimer(NEW_SOURCE_DEBOUNCE_MS)
}

/**
 * 执行一轮巡检。
 * @param options.owner 只巡检该空间（不传则全部空间）
 * @param options.only  只巡检指定的一批音源（用于「新添加的音源立即检测」，支持批量导入合并）
 * @param options.firstProbe 新增音源的首次探测：每个平台只试 1 首候选曲目（快），
 *        多曲目重试留给后续周期巡检做确认 —— 批量导入时不至于把单轮拖长数倍
 */
export async function runSourceProbe(
  options: { owner?: string; only?: Array<{ owner: string; id: string }>; firstProbe?: boolean } = {},
): Promise<ProbeRunResult> {
  const startedAt = Date.now()
  const empty: ProbeRunResult = {
    startedAt, durationMs: 0, sourcesChecked: 0, platformsChecked: 0,
    platformsOk: 0, platformsDown: 0, platformsSkipped: 0,
    newlyDisabled: [], restored: [], removed: [], suspectPlatforms: [], suspectSkippedPlatforms: [],
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
  searchAttempted.clear() // 每轮重新允许一次内置搜索，平台恢复后仍能拿到测试曲目
  poolRefreshedThisRound = false
  // 巡检自身就是卡顿来源之一（并发回调的同步序列化开销会叠加），
  // 这里留痕，好让归因把「巡检期内的卡顿」与「音源自发的卡顿」区分开
  beginHostActivity('sourceProbe', `巡检中（${options.firstProbe ? '首轮' : '周期'}）`)
  // 巡检期会触发大量「预期内的失败解析」，开启静默把逐条错误聚合到轮末摘要
  beginProbeQuiet()
  // 探测期间会有持续的解析与网络开销，标记为「忙碌」避免被自检护栏误判成异常空转
  markSourceBusy(conf.timeoutMs * 4)
  const busyTicker = setInterval(() => markSourceBusy(conf.timeoutMs * 2), Math.max(5000, conf.timeoutMs))

  try {
    let targets = deps.listTargets()
    if (options.owner) targets = targets.filter(t => t.owner === options.owner)
    if (options.only && options.only.length) {
      const wanted = new Set(options.only.map(o => `${o.owner}_${o.id}`))
      targets = targets.filter(t => wanted.has(`${t.owner}_${t.id}`))
    }

    const result: ProbeRunResult = {
      startedAt, durationMs: 0, sourcesChecked: targets.length, platformsChecked: 0,
      platformsOk: 0, platformsDown: 0, platformsSkipped: 0,
      newlyDisabled: [], restored: [], removed: [], suspectPlatforms: [], suspectSkippedPlatforms: [],
      message: '',
    }

    const statusByOwner = new Map<string, ProbeStatusFile>()
    const statusFor = (owner: string): ProbeStatusFile => {
      let s = statusByOwner.get(owner)
      if (!s) { s = readStatus(owner); statusByOwner.set(owner, s) }
      return s
    }

    interface Job { target: ProbeTarget; platform: string; songs: ProbeTestSong[] }
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

        // 上轮被判定为「平台侧系统性异常」的平台：停探半个周期。
        // 这类平台在过半音源上同时失败（测试曲目不可播/平台限流），再探一遍结论一样，
        // 却要实打实烧掉几分钟 CPU 与出口带宽；停探半个周期后下一轮自动重新探测，
        // 平台恢复最多晚一个周期发现。配置 customSource.probe.suspectBackoff=false 可关闭。
        if (conf.suspectBackoff && platformState.suspectSkipUntil && platformState.suspectSkipUntil > Date.now()) {
          platformState.status = 'skipped'
          platformState.lastCheckAt = Date.now()
          platformState.lastError = '平台侧疑似异常（上轮过半音源同时失败），本轮停探'
          result.platformsSkipped++
          if (!result.suspectSkippedPlatforms.includes(platform)) result.suspectSkippedPlatforms.push(platform)
          continue
        }

        const songs = await pickTestSongs(platform, deps)
        if (!songs.length) {
          platformState.status = 'skipped'
          platformState.lastCheckAt = Date.now()
          platformState.lastError = '无可用测试曲目'
          result.platformsSkipped++
          continue
        }
        // 新增音源的首次探测只试 1 首候选曲目：批量导入时不至于被「每平台 3 首重试」放大数倍；
        // 首轮失败只是累计 failCount（默认要连续 2 轮），真正的定罪与重试留给后续周期巡检
        jobs.push({ target, platform, songs: options.firstProbe ? songs.slice(0, 1) : songs })
      }
    }

    // 并发消费探测任务。同一个平台会按候选测试曲目依次重试，任意一首成功即视为该平台可用 ——
    // 单曲常常恰好是无版权/需会员的歌，只探一首会把「歌不可播」错判成「平台不可用」。
    let cursor = 0
    const worker = async () => {
      while (true) {
        // 处理完一个平台就让出一次事件循环：
        // 并发回来的一批响应，每个都要在沙箱边界做 decontextify + JSON.parse，
        // 挨在一起就糊成数秒的同步阻塞（实测巡检自身曾造成 7~15 秒卡顿）。
        // setImmediate 只让出一个 tick，对巡检总时长的影响可以忽略。
        await new Promise<void>(resolve => { setImmediate(resolve) })
        const index = cursor++
        if (index >= jobs.length) return
        const job = jobs[index]
        const status = statusFor(job.target.owner)
        const platformState = status.sources[job.target.id].platforms[job.platform]
        result.platformsChecked++

        let ok = false
        let lastError = ''
        for (const song of job.songs) {
          const outcome = await probePlatform(job.target, job.platform, song, conf)
          if (outcome.ok) { ok = true; break }
          lastError = outcome.error || '未知错误'
        }
        platformState.lastCheckAt = Date.now()

        if (ok) {
          platformState.failCount = 0
          platformState.lastOkAt = Date.now()
          platformState.lastError = ''
          result.platformsOk++

          // 之前被自动关闭的平台恢复可用 → 立即自动重新开启（恢复一定是安全的，不必等后置校验）
          if (platformState.autoDisabled) {
            platformState.autoDisabled = false
            setPlatformDisabled(job.target.owner, job.target.id, job.platform, false)
            result.restored.push(`${job.target.name}/${job.platform}`)
            audit(job.target.owner, 'restore-platform', { sourceId: job.target.id, sourceName: job.target.name, platform: job.platform })
            console.log(`[音源巡检] ✓ 平台已恢复，自动重新开启: ${job.target.name} / ${job.platform}`)
            syncLog.info(`[音源巡检] ✓ 平台已恢复，自动重新开启: ${job.target.name} / ${job.platform}`)
          }
          platformState.status = 'ok'
        } else {
          platformState.failCount++
          platformState.lastError = shorten(lastError)
          // 是否「不可用」要等平台侧系统性判定后再落定，这里先按证据不足处理
          platformState.status = 'unknown'
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(conf.concurrency, Math.max(1, jobs.length)) }, () => worker()))

    // ---- 平台侧系统性异常判定 ----
    // 同一个平台如果在「多数音源」上同时失败，那么更可能是测试曲目不可播、平台侧限流/风控等外部原因，
    // 而不是某个音源自己坏了。此时若继续按「连续失败达阈值」自动关闭，会一次性误伤大量可用音源，
    // 甚至因为「全部平台都失败」把这些音源整个删掉。因此这类平台本轮只记录、不处置，交由人工判断。
    const platformStats = new Map<string, { checked: number; failed: number; ok: number }>()
    for (const job of jobs) {
      const ps = statusFor(job.target.owner).sources[job.target.id].platforms[job.platform]
      const stat = platformStats.get(job.platform) || { checked: 0, failed: 0, ok: 0 }
      stat.checked++
      if (!ps || ps.failCount > 0) stat.failed++
      else stat.ok++
      platformStats.set(job.platform, stat)
    }
    const suspectPlatforms = new Set<string>()
    for (const [platform, stat] of platformStats) {
      if (stat.checked > 0 && stat.failed / stat.checked >= conf.systemicFailureRatio) {
        suspectPlatforms.add(platform)
        result.suspectPlatforms.push({ platform, checked: stat.checked, failed: stat.failed, ok: stat.ok })
      }
    }
    if (suspectPlatforms.size) {
      result.suspectPlatforms.sort((a, b) => b.failed / b.checked - a.failed / a.checked)
      console.warn('[音源巡检] ⚠ 以下平台在过半音源上同时失败，疑似平台侧问题（测试曲目不可播/平台限流），' +
        `本轮暂缓自动处置：${result.suspectPlatforms.map(s => `${s.platform}(失败${s.failed}/探测${s.checked}，可用${s.ok})`).join('、')}`)
    }

    // 记录停探截止时间（半个周期）：这些平台下一轮不再重复探测，省下的时间留给真正需要探的平台
    if (conf.suspectBackoff && suspectPlatforms.size) {
      const skipUntil = startedAt + Math.floor((conf.intervalMinutes * 60 * 1000) / 2)
      for (const target of targets) {
        const sourceState = statusFor(target.owner).sources[target.id]
        if (!sourceState) continue
        for (const platform of target.platforms) {
          if (!suspectPlatforms.has(platform)) continue
          const ps = sourceState.platforms[platform]
          if (ps) ps.suspectSkipUntil = skipUntil
        }
      }
    }

    // ---- 落定每个平台的结论并执行自动关闭 ----
    for (const target of targets) {
      const sourceState = statusFor(target.owner).sources[target.id]
      for (const platform of target.platforms) {
        const ps = sourceState.platforms[platform]
        if (!ps || ps.status === 'skipped' || ps.status === 'ok') continue
        if (ps.failCount < conf.failThreshold) { ps.status = 'unknown'; continue }
        if (suspectPlatforms.has(platform)) {
          // 平台本身可疑：证据不足以归罪这个音源，不判定不可用、更不自动关闭
          ps.status = 'unknown'
          continue
        }
        ps.status = 'down'
        result.platformsDown++
        if (conf.autoDisablePlatform && !ps.autoDisabled) {
          ps.autoDisabled = true
          setPlatformDisabled(target.owner, target.id, platform, true)
          result.newlyDisabled.push(`${target.name}/${platform}`)
          audit(target.owner, 'disable-platform', {
            sourceId: target.id, sourceName: target.name,
            platform, failCount: ps.failCount, error: ps.lastError,
          })
          console.warn(`[音源巡检] ⚠ 已关闭平台解析: ${target.name} / ${platform}（连续失败 ${ps.failCount} 次，原因：${ps.lastError}）`)
          syncLog.warn(`[音源巡检] ⚠ 已关闭平台解析: ${target.name} / ${platform}（连续失败 ${ps.failCount} 次，原因：${ps.lastError}）`)
        }
      }
    }

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
      (result.removed.length ? `；移除 ${result.removed.length} 个音源` : '') +
      (result.suspectPlatforms.length ? `；${result.suspectPlatforms.length} 个平台疑似平台侧异常已暂缓处置` : '') +
      (result.suspectSkippedPlatforms.length ? `；${result.suspectSkippedPlatforms.length} 个平台上轮疑似异常本轮停探` : '')

    lastRun = result
    console.log(`[音源巡检] 本轮完成（${result.durationMs}ms）：${result.message}`)
    // 同时写入 log4js（app.log）：console 只进 stdout，容器外看不到；
    // 这样管理面板的日志查看器与 /api/logs?type=app 里都能追溯巡检历史
    syncLog.info(`[音源巡检] 本轮完成（${result.durationMs}ms）：${result.message}`)
    if (result.newlyDisabled.length) {
      syncLog.warn(`[音源巡检] 自动关闭平台：${result.newlyDisabled.join('、')}`)
    }
    if (result.restored.length) {
      syncLog.info(`[音源巡检] 自动恢复平台：${result.restored.join('、')}`)
    }
    if (result.removed.length) {
      syncLog.warn(`[音源巡检] 自动移除音源：${result.removed.join('、')}`)
    }
    if (result.suspectPlatforms.length) {
      syncLog.warn(`[音源巡检] 疑似平台侧异常（仅报告、不处置）：` +
        result.suspectPlatforms.map(s => `${s.platform} ${s.failed}/${s.checked} 失败`).join('、'))
    }
    return result
  } catch (e: any) {
    const message = `巡检异常: ${(e && e.message) || e}`
    console.error(`[音源巡检] ${message}`)
    syncLog.error(`[音源巡检] ${message}`)
    const failed: ProbeRunResult = { ...empty, durationMs: Date.now() - startedAt, message }
    lastRun = failed
    return failed
  } finally {
    running = false
    endHostActivity('sourceProbe')
    clearInterval(busyTicker)
    // 退出静默，并把抑制掉的源错误日志汇总成少量几行（巡检期失败属预期内噪音）
    try {
      const quiet = endProbeQuiet()
      if (quiet.total > 0) {
        console.log(`[音源巡检] 静默期抑制 ${quiet.total} 条源错误日志，按来源汇总：`)
        for (const line of quiet.lines) console.log(`[音源巡检]   ${line}`)
        syncLog.info(`[音源巡检] 静默期抑制 ${quiet.total} 条源错误日志（明细见 stdout）`)
      }
    } catch {
      // 汇总失败不影响巡检本身
    }
    // 轮次结束是唤醒排队中「新音源」的可靠时机（它们在探测期间被 running 挡了回去）
    wakePendingNewSources()
  }
}

/**
 * 新添加的音源 → 立即巡检一次。
 * 刻意异步、不阻塞上传响应；多个音源在同一窗口内被添加时合并成一轮，
 * 既避免逐个巡检把 CPU/网络打满，也避免「上一轮还在跑 → 新源被整轮跳过」。
 */
export function probeNewSource(owner: string, sourceId: string): void {
  const conf = configOf()
  if (!conf.enabled || !conf.probeOnNewSource || !depsRef) return

  pendingNewSources.set(`${owner}_${sourceId}`, { owner, id: sourceId })
  armNewSourceTimer(NEW_SOURCE_DEBOUNCE_MS)
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
    // 一轮巡检要探测上百个平台（实测 90~120 秒），启动即跑会明显拖慢首屏与投送
    startupDelayMs: 120000,
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

export function getSourceProbeStatus(includeDetail = false): ProbeStatusSnapshot {
  const conf = configOf()
  const autoDisabledPlatforms: ProbeStatusSnapshot['autoDisabledPlatforms'] = []
  const details: ProbePlatformDetail[] = []
  // 空间既可能来自「当前已加载的源」，也可能只有历史记录（源全被移除后），两边都覆盖
  const owners = new Set<string>(['open', ...registeredUsers()])
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
        if (includeDetail) {
          details.push({
            owner,
            sourceId,
            sourceName: sourceState.name,
            platform,
            status: platformState.status,
            autoDisabled: !!platformState.autoDisabled,
            failCount: platformState.failCount || 0,
            lastCheckAt: platformState.lastCheckAt || 0,
            lastOkAt: platformState.lastOkAt || 0,
            lastError: platformState.lastError || '',
          })
        }
      }
    }
  }
  if (includeDetail) {
    // 便于排查：失败的排在前面，其次按连续失败次数降序
    details.sort((a, b) => {
      const rank = (d: ProbePlatformDetail) => (d.status === 'down' ? 0 : d.failCount > 0 ? 1 : d.status === 'skipped' ? 3 : 2)
      const ra = rank(a)
      const rb = rank(b)
      return ra !== rb ? ra - rb : b.failCount - a.failCount
    })
  }
  return {
    enabled: conf.enabled,
    running,
    intervalMinutes: conf.intervalMinutes,
    failThreshold: conf.failThreshold,
    concurrency: conf.concurrency,
    autoDisablePlatform: conf.autoDisablePlatform,
    autoRemoveSource: conf.autoRemoveSource,
    removeMode: conf.removeMode,
    lastRunAt,
    lastRun,
    pendingNewSources: pendingNewSources.size,
    autoDisabledPlatforms,
    ...(includeDetail ? { details } : {}),
  }
}
