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
import { encodeRequestUrl } from '@/utils/urlEncode'
import { syncLog } from '@/utils/log4js'
import { localTime } from '@/utils/time'
import { markSourceBusy } from './sourceGuard'
import { isThrottled } from './sourceGovernor'
import { beginProbeQuiet, endProbeQuiet } from './probeQuiet'
import { beginHostActivity, endHostActivity } from './sourceActivity'
import { moveScriptToTrash, listTrash } from './sourceTrash'
import { hasRecentSuccess } from './sourcePlayRank'
import type { ScheduledTask, TaskExecutionResult } from './task/types'

export const PROBE_TASK_ID = 'custom_source_health_probe'
/** 已关闭平台快速复检任务（只做恢复，不定罪） */
export const PROBE_RESTORE_TASK_ID = 'custom_source_restore_probe'
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
   * 被本模块自动关闭时的「连续失败次数」归档值。
   * 关闭那一刻把 failCount 快照到这里再把 failCount 清零，避免「连续失败 66 次」这种只增不减的展示；
   * 平台恢复可用时随 autoDisabled 一并清零。
   */
  disabledFailCount?: number
  /** 被本模块自动关闭的真实时间戳（区别于最后巡检时刻 lastCheckAt） */
  disabledAt?: number
  /**
   * 「平台侧疑似异常」停探截止时间。
   * 该平台在过半音源上同时失败（测试曲目不可播/平台限流）时，再探一遍结果也一样，
   * 却要实打实烧掉几分钟 CPU 与出口带宽——停探半个周期，下一轮自动重新探测，
   * 平台恢复最多晚一个周期发现。
   */
  suspectSkipUntil?: number
  /**
   * 连续**软失败**次数（本机网络 / 平台限流 / 风控这类「不是音源自己坏了」的失败）。
   *
   * 为什么不并进 failCount：failCount 直接决定「关平台」和「删音源」两件不可逆的事，
   * 而实测本机网络抖一下就失败是常态 —— 让抖动去凑那两个阈值，等于按网络质量删好源。
   * 但也不能无限豁免（真有源长期超时），所以连续 SOFT_PROMOTE_AFTER 次软失败折成一次硬证据。
   * 成功一次即清零。
   */
  softCount?: number
  /**
   * 本轮「被赦免」的时间戳（0/未设置 = 本轮有真实结论）。
   *
   * 赦免有三种：平台侧疑似异常（整档 / 只赦免软失败）、停探期的哨兵样本、快速复检轮。
   * 赦免只把 status 改成 unknown，但 failCount 仍 > 0 —— 而全平台失效判定把
   * `failCount > 0` 当失败证据，于是「平台层写暂缓处置、整源层照样起 3 天删除倒计时」。
   * 这个字段就是用来把「本轮没结论」和「本轮真失败」区分开的（见 evalAllDown）。
   */
  deferredAt?: number
  /**
   * 上一次「自动恢复」的时间戳。
   *
   * 用来防抖：实测某个源（Hei Music源/wy）在 3 小时里被「自动关闭 → 自动恢复」来回折腾 6 次 ——
   * 平台本身是**间歇可用**，每轮巡检有时过阈值、有时又不失败，正反两个方向都被阈值放大成动作。
   * 刚恢复过的平台再失败时要求双倍连续失败次数才允许再次关闭，抖动就落在计数上，不再落到开关上。
   */
  restoredAt?: number
  /**
   * 「降权观察」的起始时间戳（0/未设置 = 未降权）。
   *
   * 语义：该「音源 × 平台」在巡检里第一次取链失败 → 只是**排到换源顺序的队尾**，
   * 不写 states.json、不关平台；连续第二次失败才允许关闭（见 conf.demoteThreshold / conf.failThreshold）。
   *
   * 为什么要有这一档：巡检一次失败就关平台，误判代价是「用户少一个能用的源」；
   * 而第一次失败只降权，代价仅仅是「下次先试别的源」，两者严重不对称。
   * 降权由成功一次或超期自动失效，不会长期粘住：硬失败 6 小时（DEMOTE_TTL_MS），
   * 软失败 30 分钟（DEMOTE_SOFT_TTL_MS，见下面 demoteSoft 字段）。
   */
  demotedAt?: number
  /**
   * 本次降权是由**软失败**点亮的（无版权/未找到链接/接口返回空）。
   *
   * 只为决定降权有效期：软失败用 `DEMOTE_SOFT_TTL_MS`（30 分钟），硬失败用
   * `DEMOTE_TTL_MS`（6 小时）。语义不变——软失败照样排到队尾，只是不用一次
   * 「这首歌没有」压它 6 小时（2026-11-14，依据 17950 实测：tx 上 K×H测试 仅
   * 2 次软失败、failCount 仍为 0，却被压了整 6 小时队尾）。
   * 旧数据没有这个字段 → 视为硬失败，行为与升级前一致。
   */
  demoteSoft?: boolean
}

export interface SourceProbeState {
  name: string
  platforms: Record<string, PlatformProbeState>
  removedAt?: number
  removedReason?: string
  /**
   * 「全平台首次判定失效」的起始时间戳（0/未设置 = 当前没有处于全平台失效）。
   *
   * 只用于「持续失效满 N 天才移除」的时间窗判定：任一平台恢复可用即清零，
   * 因此它记的是**连续**失效时长，不是累计。落盘在 probe-status.json 里，重启不丢计时。
   */
  allDownSince?: number
}

export interface ProbeStatusFile {
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
  /**
   * 内置 SDK 搜索兜底，可返回多首候选。
   * 只给一首的话，这一首恰好无版权/需会员就会让该平台所有音源集体失败，
   * 进而被误判成「平台侧异常」—— 多候选是降误判最省事的手段。
   */
  searchTestSong?: (platform: string) => Promise<ProbeTestSong[] | ProbeTestSong | null>
}

export interface ProbeRunResult {
  startedAt: number
  durationMs: number
  sourcesChecked: number
  platformsChecked: number
  platformsOk: number
  platformsDown: number
  platformsSkipped: number
  /**
   * 本轮探测失败但被「平台侧疑似异常」赦免、未计入不可用的平台数。
   * 没有这个数字，日志会出现「可用 56、不可用 0」而几十个失败人间蒸发的怪象。
   */
  platformsDeferred: number
  /** 本次新关闭的平台 */
  newlyDisabled: string[]
  /** 本次首次进入「降权观察」的「源/平台」（只影响换源顺序，不关平台） */
  demoted: string[]
  /** 本次恢复可用的平台 */
  restored: string[]
  /** 本次移除的音源 */
  removed: string[]
  /**
   * 因超出单轮时长预算（maxDurationMs）而未探测的任务数。
   * 与 platformsDeferred 区分：那个是「探了但证据不足暂缓处置」，这个是「压根没探，留到下一轮」。
   */
  budgetCut?: number
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
  /** 是否处于「降权观察」：只排到换源队尾，不关平台 */
  demoted: boolean
}

export interface ProbeStatusSnapshot {
  enabled: boolean
  running: boolean
  intervalMinutes: number
  failThreshold: number
  /** 连续失败几次降权（0 = 关闭降权档） */
  demoteThreshold: number
  /** 当前生效的探测并发路数（config.js 的 customSource.probe.concurrency） */
  concurrency: number
  autoDisablePlatform: boolean
  autoRemoveSource: boolean
  removeMode: 'trash' | 'delete'
  /** 全平台失效持续多少天后移除音源（0 = 判定当轮即移除） */
  allDownDays: number
  lastRunAt: number | null
  lastRun: ProbeRunResult | null
  /** 「已关闭平台快速复检」的间隔（分钟）；0 表示关闭 */
  restoreIntervalMinutes: number
  /** 每轮复检最多探多少个「源 × 平台」 */
  restoreBatch: number
  /** 最近一次快速复检的时刻（与 lastRunAt 分开，主巡检快照不受它影响） */
  lastRestoreAt: number | null
  lastRestoreRun: ProbeRunResult | null
  /** 单轮总时长预算（毫秒）与同平台最小探测间隔（毫秒），面板可据此判断是否需要调参 */
  maxDurationMs: number
  throttleMs: number
  /** 已排队、等待巡检的「新增音源」数量（撞上正在跑的轮次时会排队，不会丢） */
  pendingNewSources: number
  /** 当前生效的「自动关闭」平台清单 */
  autoDisabledPlatforms: Array<{ owner: string; sourceId: string; sourceName: string; platform: string; since: number; disabledAt?: number; failCount?: number }>
  /** 逐平台明细：仅在 includeDetail=true 时返回，避免 /health 常规轮询被撑大 */
  details?: ProbePlatformDetail[]
}

// ============================ 配置 ============================

export interface ProbeConfig {
  enabled: boolean
  intervalMinutes: number
  failThreshold: number
  /**
   * 连续失败几次后进入「降权观察」（只排到换源队尾，不关平台）。
   *
   * 默认 1：第一次取链失败就降权，第二次（failThreshold）才关平台。
   * 填 0 关闭降权档，恢复「失败到阈值直接关」的老行为。
   * 若填得 ≥ failThreshold，说明没有观察窗口，按关闭降权处理（见 configOf 的钳制）。
   */
  demoteThreshold: number
  timeoutMs: number
  concurrency: number
  verifyLink: boolean
  autoDisablePlatform: boolean
  autoRemoveSource: boolean
  removeMode: 'trash' | 'delete'
  /**
   * 全平台失效持续多少天后才移除整个音源。
   *
   * 用户 2026-11-06 定调：全平台失效满 3 天即可移除（进回收站，回收站再留 3 天）。
   * 为什么要「持续」而不是「本轮判定即移除」：单轮判定受测试曲目、平台瞬时故障影响，
   * 实测一次失败的条目下一轮恢复的比例约 20%（failCount=1 的样本 3/3 恢复），
   * 立即移除等于用最轻的证据做最重的处置。用时间窗把「偶发」和「真的死了」分开。
   */
  allDownDays: number
  probeOnNewSource: boolean
  /** 真实播放数据优先：7 天内真播成功过的「源×平台」本轮不再合成探测（默认开） */
  preferPlayRank: boolean
  testSongs: Record<string, Partial<ProbeTestSong>>
  /** 平台失败率超过该比例即视为「平台侧系统性异常」，本轮暂缓自动处置 */
  systemicFailureRatio: number
  /** 「平台侧异常」成立所允许的最高成功率：高于此值说明有音源能播，不构成平台侧问题 */
  suspectMaxOkRatio: number
  /** 平台侧疑似异常的平台停探半个周期（省掉注定失败的重复探测，配置可关） */
  suspectBackoff: boolean
  /**
   * 已关闭平台的「快速复检」间隔（分钟）。0 = 关闭该功能。
   *
   * 为什么需要：被自动关闭的平台原本只能等下一轮**全量**巡检才有机会恢复，
   * 而全量间隔默认 180/360 分钟 —— 一次误判或平台临时故障，用户最坏要等 3~6 小时
   * 才能把那个源重新用起来。复检只探「已关闭」的平台、每平台 1 首，成本是全量的几十分之一，
   * 却能把这个窗口压到半小时以内。
   */
  restoreIntervalMinutes: number
  /** 每轮复检最多探多少个「源 × 平台」（限制瞬时压力，多的下一轮按关闭时间轮转） */
  restoreBatch: number
  /**
   * 同一平台两次探测之间的最小间隔（毫秒）。0 = 不节流。
   *
   * 全量巡检并发打 139 个平台，同一平台往往有 20~30 个源同时排队；
   * 并发全开时会出现「同一个平台瞬时收到 6 个请求」，正是最容易触发平台风控的形态。
   * 加一道很轻的间隔（默认 250ms）就能把瞬时并发摊平，对总时长影响可忽略。
   */
  throttleMs: number
  /**
   * 单轮巡检的总时长预算（毫秒）。超预算就不再领取新任务，剩下的留到下一轮。
   *
   * 实测 39 源 / 139 平台在并发 2 下要跑 304 秒，正好和用户点歌、投送撞车；
   * 与其让它无限延长，不如到点收工 —— 任务按「上次探测时间最久」排序，
   * 被截断的自然排到下一轮最前面，不会饿死。
   */
  maxDurationMs: number
}

/**
 * 判定「平台侧系统性异常」的默认比例：某平台本轮在 [该比例] 以上的音源上失败即视为平台侧问题。
 *
 * 刻意不设「最少样本数」门槛：小音源库（某平台只有 1~2 个音源声明）恰恰最经不起误伤，
 * 而单个样本失败本来也无法区分「平台坏了」和「测试曲目不可播」——
 * 证据不足时宁可只报告、不自动处置。
 */
const DEFAULT_SYSTEMIC_RATIO = 0.5
/**
 * 「平台侧异常」成立还要求该平台的成功比例低到没有对照组。
 *
 * 光看失败比例会得出荒谬结论：实测一轮 kw 探测 36 个、18 个成功（成功率 50%），
 * 照样被判「平台侧系统性异常」。既然有一半音源能播，测试曲目就是可播的、平台也没限流，
 * 剩下那些失败只可能是音源自己的后端挂了 —— 此时赦免等于把真凶全部放走。
 *
 * 只有成功率低到几乎没人能播，才谈得上「曲目不可播 / 平台整体限流」。
 */
const DEFAULT_SUSPECT_MAX_OK_RATIO = 0.05
/**
 * 失败原因里属于「音源侧硬故障」的特征。
 *
 * 聚合音源生态里几十个源共用同一批第三方后端，一个后端挂会让几十个源同时失败，
 * 于是失败比例自然过半、触发上面的赦免。但这些失败与「测试曲目选得不好」毫无关系：
 * 域名解析失败、连接被重置、源站 5xx、接口已废弃、加密方案过期 —— 都是铁证。
 * 命中这些特征的失败，即使所在平台被判疑似异常，也不应被赦免。
 */
const HARD_FAILURE_PATTERN = new RegExp([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'EHOSTUNREACH', 'EPIPE', 'socket hang up', 'getaddrinfo',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificate',
  'Unknown cipher', 'unsupported cipher', 'digital envelope',
  'HTTP\\s*5\\d\\d', '\\b5\\d\\d\\b\\s*(?:错误|Error)',
  // 4xx 里只有「资源不存在 / 已永久移除」算音源自己的硬故障。
  // 实测聚合源报「链接返回 404/GET 404（music.haitangw.cc）」= 它写死的后端路径已失效，
  // 与「测试曲目不可播」无关；老正则只认 5xx，这批源因此被当成软失败永久豁免
  // （failCount 堆到 99 也不关、也不删，2026-11-06 实测 kg 上 9 个）。
  // 403/401 刻意不收：那是平台风控、地区限制或版权限制，源本身可能没坏。
  '\\b404\\b', '\\b410\\b\\s*(?:Gone|错误|已删除)',
  '已废弃', '已停用', '已下线', '已关闭', '请升级',
  // 「取链成功但返回的是网页」——由 verifyUrlPlayable 的 content-type 判定产生。
  // 这类不是「这首歌没版权」（那种应该返回空/报错），而是音源脚本自身坏了，
  // 属于硬故障，必须能进巡检账本，否则它会一直假成功、永远不到处置阈值。
  '不是音频',
].join('|'), 'i')

/** 失败信息是否属于音源自身的硬故障（而非测试曲目不可播这类软失败） */
export const isHardFailure = (message: unknown): boolean => {
  if (typeof message !== 'string' || !message) return false
  return HARD_FAILURE_PATTERN.test(message)
}

/** 「该音源是否全平台失效」的判定结果 */
export interface AllDownVerdict {
  /** 该源支持的每个有结论的平台都失败，且没有任何平台成功 */
  allDown: boolean
  /** 至少有一个平台给出了失败证据（down，或 unknown 且 failCount>0） */
  hasEvidence: boolean
  /**
   * 所有平台里「最近一次成功」的时间戳（0 = 从未成功过）。
   *
   * 用途：`allDownSince` 是本次上线后才有的字段，存量坏源没有计时起点。
   * 用 lastOkAt 推断「它其实已经多久没成功过了」，避免它们明明死了几个月
   * 还要从部署那一刻重新等满 3 天。
   */
  lastOkAt: number
}

/**
 * 判定「该音源是否全平台失效」。
 *
 * 刻意不要求 status === 'down'：被平台侧异常豁免的平台 status 是 'unknown'，
 * 老写法要求「每个平台都 down」，导致「所有平台都探不通」的源永远凑不齐移除条件
 * （2026-11-06 实测：长青SVIP 4 个平台 down + mg/kg 被豁免 → 永远不删）。
 *
 * skipped 不算证据也不算反证：它意味着这轮没探到（停探期/预算截断），
 * 既不能用来定罪，也不该成为「因为一个没探的平台就永不清理」的绊脚石。
 */
export const evalAllDown = (
  platforms: string[],
  getState: (platform: string) => PlatformProbeState | undefined,
): AllDownVerdict => {
  let allDown = true
  let hasEvidence = false
  let lastOkAt = 0
  for (const platform of platforms) {
    const ps = getState(platform)
    if (!ps) { allDown = false; break }
    lastOkAt = Math.max(lastOkAt, Number(ps.lastOkAt) || 0)
    if (ps.status === 'ok') { allDown = false; break }
    if (ps.status === 'skipped') continue
    // 本轮被赦免（平台侧疑似异常 / 停探哨兵 / 快速复检轮）→ 只是「没拿到结论」，
    // 既不能当失败证据，也不能阻断 allDown（阻断就又回到「全平台都没定论 → 永不删除」的老死锁）。
    if (Number(ps.deferredAt) > 0) continue
    if (ps.status === 'down' || ps.failCount > 0) { hasEvidence = true; continue }
    allDown = false
    break
  }
  return { allDown, hasEvidence: allDown && hasEvidence, lastOkAt }
}

/**
 * 全平台失效的「持续」判定。
 *
 * 时间窗记的是**连续**失效：任一平台恢复或整轮没探到（无证据）都会把计时清零。
 * @param prevSince 上次记录的计时起点（0 = 未在计时）
 * @param windowMs 需要持续的毫秒数；0 表示判定当轮即移除
 * @returns since 新的计时起点；remove 是否该移除；started 本次是否刚开始计时
 */
export const decideAllDownRemoval = (
  prevSince: number,
  verdict: AllDownVerdict,
  now: number,
  windowMs: number,
): { since: number; remove: boolean; started: boolean } => {
  if (!verdict.allDown || !verdict.hasEvidence) return { since: 0, remove: false, started: false }
  if (windowMs <= 0) return { since: now, remove: true, started: true }
  const base = Number(prevSince) || 0
  if (base > 0) return { since: base, remove: now - base >= windowMs, started: false }

  // 没有计时起点 = 首次判定（含存量坏源）。用 lastOkAt 推断已经失效多久：
  // 最后一次成功早于「窗口起点」说明它确实已经连续失效满窗口，直接移除，
  // 不必因为本字段是这次才加的、从部署那一刻重新等 3 天。
  const lastOkAt = Number(verdict.lastOkAt) || 0
  if (lastOkAt > 0 && now - lastOkAt >= windowMs) {
    return { since: lastOkAt, remove: true, started: false }
  }
  // 从未成功过（lastOkAt=0，多半是新导入还没跑通的源）：无法证明持续了多久，从此刻起计时
  return { since: now, remove: false, started: true }
}
/** 单个平台每轮最多尝试几首测试曲目（第一首失败后换歌重试，降低单曲失灵的误判） */
const MAX_SONG_ATTEMPTS = 3
/**
 * 平台处于「停探」期时，每轮仍要探测的哨兵音源数。
 * 用意在 suspectBackoff 分支里详述：没有哨兵的话，全部平台同时 suspect 会让整轮巡检 100% 空转。
 */
const SUSPECT_SAMPLE_SIZE = 3
/**
 * 判定「平台侧系统性异常」所需的最小样本量。
 * 停探轮次只有 SUSPECT_SAMPLE_SIZE 个哨兵，若允许小样本定罪，哨兵全挂就会让嫌疑无限续期
 * —— 停探期永不到期，巡检再也回不到全量。低于该样本量只报告、不续期。
 */
const SUSPECT_MIN_SAMPLE = 5

const positiveNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

/**
 * 允许 0 的数值配置（0 表示「关闭该功能」）。
 * 注意与 positiveNumber 的区别：那边 0 会被当成「没填」而回落默认值，
 * 对 restoreIntervalMinutes / throttleMs 这种「0 是合法关闭值」的键必须用这个。
 */
const nonNegativeNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

/** 取 [0,1] 区间的比例配置 */
const ratioNumber = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
}

/**
 * 读取当前生效的巡检配置（导出的目的是让单测能验证「0 是合法关闭值」这类边界，
 * 以及让诊断脚本能读到真实的生效参数，而不是照着默认值猜）。
 */
export const configOf = (): ProbeConfig => {
  const c: any = (global.lx && global.lx.config) || {}
  const rawTestSongs = c['customSource.probe.testSongs']
  const failThreshold = Math.max(1, Math.round(positiveNumber(c['customSource.probe.failThreshold'], 2)))
  // 降权阈值必须给「第二次失败才关平台」留出观察窗口：
  //   - 配 0 = 关闭降权档，回到「到阈值直接关」的老行为；
  //   - 配到 ≥ failThreshold 等于没有观察窗口，同样按关闭处理，而不是钳成「和关闭同步触发」；
  //   - 合法区间 [1, failThreshold - 1]，failThreshold=1 时必然为 0（本来就没有第二次）。
  const rawDemote = Math.round(nonNegativeNumber(c['customSource.probe.demoteThreshold'], 1))
  const demoteThreshold = rawDemote > 0 && rawDemote < failThreshold ? rawDemote : 0
  return {
    enabled: c['customSource.probe.enabled'] !== false,
    intervalMinutes: positiveNumber(c['customSource.probe.intervalMinutes'], 360),
    failThreshold,
    demoteThreshold,
    timeoutMs: positiveNumber(c['customSource.probe.timeoutMs'], 15000),
    // 并发默认 6：实测 40 音源 × 152 平台在并发 2 下要跑 356 秒，
    // 窗口越长越容易和用户播放撞车（抢出口带宽与 CPU）。单平台多为网络等待，提并发 safe。
    concurrency: Math.max(1, Math.min(8, Math.round(positiveNumber(c['customSource.probe.concurrency'], 6)))),
    verifyLink: c['customSource.probe.verifyLink'] !== false,
    autoDisablePlatform: c['customSource.probe.autoDisablePlatform'] !== false,
    autoRemoveSource: c['customSource.probe.autoRemoveSource'] !== false,
    removeMode: c['customSource.probe.removeMode'] === 'delete' ? 'delete' : 'trash',
    // 全平台失效持续多少天移除：默认 3 天（用户 2026-11-06 定调）。
    // 0 = 关闭时间窗（判定当轮即移除，等同老行为）；上限 90 天，避免配置写错把清理拖成永久。
    allDownDays: Math.min(90, nonNegativeNumber(c['customSource.probe.allDownDays'], 3)),
    probeOnNewSource: c['customSource.probe.probeOnNewSource'] !== false,
    // 真实播放数据优先：7 天内真播成功过的「源×平台」本轮不拿测试曲去探（默认开）
    preferPlayRank: c['customSource.probe.preferPlayRank'] !== false,
    testSongs: rawTestSongs && typeof rawTestSongs === 'object' && !Array.isArray(rawTestSongs) ? rawTestSongs : {},
    systemicFailureRatio: ratioNumber(c['customSource.probe.systemicFailureRatio'], DEFAULT_SYSTEMIC_RATIO),
    suspectMaxOkRatio: ratioNumber(c['customSource.probe.suspectMaxOkRatio'], DEFAULT_SUSPECT_MAX_OK_RATIO),
    suspectBackoff: c['customSource.probe.suspectBackoff'] !== false,
    // 快速复检：默认 180 分钟（3 小时）一轮，每轮最多 32 个「源 × 平台」；设 0 可关闭
    // 246 实测 62 个平台待复检：32 个/轮 → 2 轮（6 小时）扫完，单个平台最长等 6 小时
    restoreIntervalMinutes: nonNegativeNumber(c['customSource.probe.restoreIntervalMinutes'], 180),
    restoreBatch: Math.max(1, Math.round(positiveNumber(c['customSource.probe.restoreBatch'], 32))),
    // 同平台探测最小间隔：默认 250ms，上限 5000ms，避免配置写错把巡检拖成几小时
    throttleMs: Math.min(5000, nonNegativeNumber(c['customSource.probe.throttleMs'], 250)),
    // 单轮预算：默认 8 分钟（低于默认间隔 180/360 分钟，留足余量）
    maxDurationMs: positiveNumber(c['customSource.probe.maxDurationMs'], 8 * 60 * 1000),
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

/**
 * 修复旧版本留下的「半截禁用态」。
 *
 * 旧代码关闭平台时只写 `autoDisabled=true`，既不写 `disabledAt`，也不写 `disabledFailCount`，
 * 而且 `failCount` 不归零（会一路涨到 99）。新版写入路径修了，但**只补写不回溯**，
 * 于是历史条目永远对不上，表现成两种假象：
 *   - `/health` 的 `since` 退化成 `lastCheckAt`：看起来像「今天刚关」，其实只是今天巡检过；
 *   - `failCount` 显示 99 而 `disabledAt=0`：像是「连续失败 99 次还在涨」，实际早已关闭。
 * 这里按「关闭时刻 = 最后一次巡检时刻」「归档值 = 当时的连续失败次数」补全，与新版同构。
 * 返回修复条数，调用方负责落盘（不落盘则每次读都会重算）。
 */
export const normalizeStatus = (status: ProbeStatusFile): number => {
  let fixed = 0
  for (const source of Object.values(status.sources) || []) {
    const platforms = (source && (source as SourceProbeState).platforms) || {}
    for (const ps of Object.values(platforms)) {
      if (!ps || !ps.autoDisabled) continue
      if (!ps.disabledAt) {
        ps.disabledAt = ps.lastCheckAt || status.updatedAt || Date.now()
        fixed++
      }
      if (typeof ps.disabledFailCount !== 'number') {
        ps.disabledFailCount = ps.failCount || 0
        ps.failCount = 0
        fixed++
      }
    }
  }
  return fixed
}

const readStatus = (owner: string): ProbeStatusFile => {
  try {
    const file = statusPath(owner)
    if (!fs.existsSync(file)) return emptyStatus()
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sources !== 'object') return emptyStatus()
    const status: ProbeStatusFile = { version: 1, updatedAt: Number(parsed.updatedAt) || 0, sources: parsed.sources || {} }
    normalizeStatus(status)
    return status
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
    // 取链排序读的就是这份文件，写完必须让缓存失效，否则降权要等 30 秒才对排序生效
    statusReadCache.delete(owner)
  } catch (e: any) {
    syncLog.warn(`[音源巡检] 保存巡检状态失败 (${owner}):`, e?.message || e)
  }
}

/** 追加一行审计记录（移除音源 / 关闭平台等破坏性动作） */
const audit = (owner: string, action: string, payload: Record<string, any>) => {
  try {
    const dir = ownerDir(owner)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ at: localTime(), action, ...payload })
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
  // 汽水/B站（2026-11-06 定稿）：不再有「extra 独立源」，巡检对象是脚本声明的 qs/bili
  // 平台，自动关闭/重开与五大平台一样写脚本的 states.json，无需特殊分支。
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
  return encodeRequestUrl(trimmed)
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
      stream = needle.get(encodeRequestUrl(url), {
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
    // 幂等编码：调用方（normalizeProbeUrl）已经编过一次，这里再兜一层，
    // 防止以后新增调用点直接传原始 URL 又把 unescaped characters 带回来。
    const resp = await needle('head', encodeRequestUrl(url), null, {
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
// 导出给 sourceDisabledProbe.ts（整源停用源复检）复用：判定口径必须与主巡检同源，
// 绝不允许两边各写一套「有效/无效」标准。
export const probePlatform = async (
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

/** kg 的歌曲主键是 32 位文件 hash（`audio_id` 那种数字 ID 源脚本用不了） */
const KG_HASH_PATTERN = /^[0-9A-Fa-f]{32}$/

/** 只有这些平台的源脚本**必须**拿到 hash 才可能出链 */
const REQUIRES_HASH_PLATFORM = new Set(['kg'])

/**
 * 归一化一条测试曲目，不合格返回 null。
 *
 * 两件事，都是「把好源判成坏源」的源头：
 *
 * 1. **剥平台前缀**。缓存索引里的 songmid 是 `kg_205496462`（`source_songmid` 形态），
 *    而源脚本期望的是纯 ID —— 正常取链和歌词抓取都剥过，只有巡检没剥，
 *    于是每个平台都在探测时写成「歌曲ID不存在」。
 * 2. **kg 必须有 hash**。缓存索引只存 songmid 不存 hash，kg 的 audio_id
 *    发给源只会得到「缺少 songmid 或 hash」。这类曲目必须丢弃，
 *    否则池里「有但不合格」会让 pickTestSongs 永远走不到兜底搜索
 *    （内置搜索返回的曲目是带 hash 的），kg 平台就整轮全灭。
 */
export const sanitizeTestSong = (song: ProbeTestSong): ProbeTestSong | null => {
  if (!song || !song.source || !song.songmid) return null
  const rawMid = String(song.songmid).trim()
  const prefix = `${song.source}_`
  const songmid = rawMid.startsWith(prefix) ? rawMid.slice(prefix.length) : rawMid
  if (!songmid) return null
  const hash = song.hash ? String(song.hash).trim() : ''
  if (REQUIRES_HASH_PLATFORM.has(song.source)) {
    // 有些源确实把 hash 塞在 songmid 里，两种形态都认
    const hashForUse = KG_HASH_PATTERN.test(hash) ? hash : (KG_HASH_PATTERN.test(songmid) ? songmid : '')
    if (!hashForUse) return null
    return { ...song, songmid, hash: hashForUse }
  }
  return hash ? { ...song, songmid, hash } : { ...song, songmid }
}

const buildSongPool = (deps: ProbeDeps): Map<string, ProbeTestSong[]> => {
  const conf = configOf()
  const map = new Map<string, ProbeTestSong[]>()
  const seen = new Set<string>()
  const push = (song: ProbeTestSong) => {
    const clean = sanitizeTestSong(song)
    if (!clean) return
    const key = `${clean.source}_${clean.songmid}`
    if (seen.has(key)) return
    seen.add(key)
    const list = map.get(clean.source)
    if (list) list.push(clean)
    else map.set(clean.source, [clean])
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
    // 兜底搜索的结果同样要过净化：它也可能带上平台前缀或缺少必需字段，
    // 直接塞给源脚本就又回到「曲目形态不对被判成源坏了」。
    const foundList = (Array.isArray(found) ? found : [found])
      .map(it => sanitizeTestSong(it as ProbeTestSong))
      .filter((it): it is ProbeTestSong => !!it)
    if (foundList.length) {
      // 兜底搜索到的曲目也放进池子，后续轮次可直接复用
      const exist = cachedSongPool.get(platform)
      if (exist) exist.push(...foundList)
      else cachedSongPool.set(platform, [...foundList])
      return foundList.slice(0, MAX_SONG_ATTEMPTS)
    }
  } catch { /* ignore */ }
  return []
}

/**
 * 给「整源停用源复检」（sourceDisabledProbe.ts）挑测试曲目的包装。
 * 与主巡检共用同一份曲目池、同一个兜底搜索 —— 判定口径同源的另一半。
 */
export const pickTestSongsForDisabledProbe = async (platform: string): Promise<ProbeTestSong[]> => {
  if (!depsRef) return []
  return pickTestSongs(platform, depsRef)
}

// ============================ 音源移除 ============================

/** 把脚本文件移入同级 .trash/，或直接删除 */
const disposeScriptFile = (owner: string, sourceId: string, mode: 'trash' | 'delete', reason?: string): string | null => {
  const dir = ownerDir(owner)
  const scriptPath = path.join(dir, sourceId)
  if (!fs.existsSync(scriptPath)) return null
  try {
    if (mode === 'delete') {
      fs.unlinkSync(scriptPath)
      return null
    }
    // 统一走回收站模块：会同时落一份 .meta.json 保存原 sources.json 条目，
    // 否则「可恢复」恢复出来的只是一个没有名称/作者/平台/启用态的光脚脚本。
    return moveScriptToTrash(owner, sourceId, {
      by: 'probe',
      reason: reason || '巡检判定全部平台不可用',
    })
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
  const trashedTo = disposeScriptFile(owner, sourceId, conf.removeMode, reason)
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
/** 最近一次「已关闭平台快速复检」的时刻与结果（与主巡检分开记，避免污染面板快照） */
let lastRestoreAt: number | null = null
let lastRestoreRun: ProbeRunResult | null = null
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
/**
 * 巡检进行中的内存状态。手动取链的记账必须走同一份：
 * 否则它先 writeStatus 落盘，巡检轮末又整体 writeStatus 覆盖回去，证据会被悄悄抹掉。
 */
let liveStatusByOwner: Map<string, ProbeStatusFile> | null = null

/** 用户点播放时的取链失败证据 */
export interface ManualFailureReport {
  owner: string
  sourceId: string
  sourceName: string
  platform: string
  error: string
  /** 同一首歌、同一平台是否有别的音源成功返回链接 —— 这是最强的对照组 */
  hasControlGroup: boolean
}

/**
 * 防抖窗口：刚被自动恢复过的平台，在 30 分钟内再失败要求**双倍**连续失败次数才允许再次关闭。
 *
 * 针对的是「间歇可用」的平台：实测 Hei Music源/wy 在 3 小时里被关了又开、开了又关 6 次。
 * 关闭与恢复本身都要写 states.json、写审计日志、改前端开关状态，抖动一次用户就懵一次
 * （「我的源怎么自己开了/关了」）。把抖动吸收在计数上，平台真挂时依然会在下一轮被关掉，
 * 只是多等一轮 —— 这个代价远小于反复改开关。
 */
const RESTORE_DEBOUNCE_MS = 30 * 60_000

/**
 * 「降权观察」的有效期：从这里往后最多维持 6 小时（= 默认巡检间隔一轮）。
 *
 * 降权本身只是一条排序提示，但它是**有证据门槛**的：必须由一次真实探测失败点亮。
 * 如果不设有效期，某个源被降权后再也没被巡检探到（预算截断、音源被卸载重载丢了状态），
 * 它会永远排在队尾，而用户完全看不出原因。过期即恢复原位，下一轮巡检失败会重新降权。
 */
const DEMOTE_TTL_MS = 6 * 60 * 60 * 1000
/**
 * 软失败降权的有效期。
 *
 * 与硬失败分开的理由：降权是「排到换源队尾」，硬失败（超时/DNS 失败/连接重置/5xx）
 * 说明这个源此刻真的不能用，6 小时合理；软失败（无版权/未找到链接/接口返回空）
 * 多数是「这一首没有」，与源健康相关性弱，压 6 小时等于用最弱的证据做最长效的排序惩罚。
 * 30 分钟与 `customSource.governor.ttlMinutes` 同档，代价仍大于零（照样让位给别的源），
 * 又不至于因一次偶然空返回长时间压住一个好源。
 */
const DEMOTE_SOFT_TTL_MS = 30 * 60 * 1000

/** 某「源 × 平台」当前是否处于降权观察期（纯函数，便于单测；ps 为空视为未降权） */
export const isDemoteActive = (ps: { demotedAt?: number; demoteSoft?: boolean } | undefined, now: number = Date.now()): boolean => {
  const at = Number(ps?.demotedAt || 0)
  if (!(at > 0)) return false
  const ttl = ps?.demoteSoft ? DEMOTE_SOFT_TTL_MS : DEMOTE_TTL_MS
  return now - at < ttl
}

export interface FailureNoteOptions {
  /** 连续失败到几次降权（0 = 关闭降权档） */
  demoteThreshold: number
  failThreshold: number
  now?: number
  /**
   * 这次失败是否属于音源自身的硬故障（见 isHardFailure）。
   * 缺省 true —— 老调用方不传时行为与升级前完全一致。
   */
  hard?: boolean
}

/** 「真实播放成功」的有效窗口：7 天内（v1.5.54 巡检真实数据优先） */
const PLAY_RANK_FRESH_MS = 7 * 86400_000

/** 连续几次软失败折成一次硬证据（防「长期超时」的真死源被永久豁免） */
const SOFT_PROMOTE_AFTER = 3

/**
 * 记一次平台侧探测失败，并按「先降权、后关平台」的阶梯推进。
 *
 * 只负责 failCount 与降权标记；「是否够格关平台」由调用方用 disableThresholdFor 判定
 * （那里还有「刚恢复过的平台要双倍证据」的防抖），本函数绝不碰 autoDisabled / states.json。
 *
 * v1.5.54（检测科学化，用户 2026-11-11 拍板）：软失败**不进 failCount**。
 * 原因：failCount 直接决定「关平台」和「删音源」两件不可逆动作，而本机网络抖一下失败是常态；
 * 让抖动凑满阈值，等于按网络质量删好源。软失败仍然降权（代价极小），但连续
 * SOFT_PROMOTE_AFTER 次会折成一次硬证据 —— 长期超时的真死源照样能被处置。
 *
 * @returns demoteStarted=true 表示本次是**首次**进入降权观察（调用方据此只打一条日志）；
 *          counted=false 表示这次失败没有计入 failCount（软失败且未达折算次数）
 */
export const notePlatformFailure = (
  ps: PlatformProbeState,
  opts: FailureNoteOptions,
): { demoted: boolean; demoteStarted: boolean; counted: boolean } => {
  const now = opts.now ?? Date.now()
  const hard = opts.hard !== false

  if (!hard) {
    ps.softCount = Math.min(99, Number(ps.softCount || 0) + 1)
    if (ps.softCount < SOFT_PROMOTE_AFTER) {
      // 已经关掉的平台不参与降权：它在 states.json 里已不可选，排序层看不到它
      if (ps.autoDisabled) return { demoted: isDemoteActive(ps, now), demoteStarted: false, counted: false }
      const demoteStarted = !isDemoteActive(ps, now)
      if (demoteStarted) {
        ps.demotedAt = now
        // 软失败降权走 30 分钟短窗口（见 DEMOTE_SOFT_TTL_MS），语义仍是「排到队尾」
        ps.demoteSoft = true
      }
      return { demoted: true, demoteStarted, counted: false }
    }
    // 连续软失败到折算线：清软计数，按一次硬证据继续走下面的正常流程
    ps.softCount = 0
  } else {
    ps.softCount = 0
  }

  // 失败计数上限 99，避免「连续失败 N 次」在停探期/关闭后只增不减变成无意义的极大值
  ps.failCount = Math.min(99, Number(ps.failCount || 0) + 1)
  const threshold = Math.max(0, Math.round(Number(opts.demoteThreshold) || 0))
  // 已经关掉的平台不参与降权：它在 states.json 里已经不可选，排序层看不到它
  if (!threshold || ps.autoDisabled || ps.failCount < threshold) {
    return { demoted: isDemoteActive(ps, now), demoteStarted: false, counted: true }
  }
  const active = isDemoteActive(ps, now)
  const demoteStarted = !active
  // 软失败点亮过的降权，遇到硬失败要「升级」成 6 小时长窗口（证据更强，时长理应更长）
  if (demoteStarted || ps.demoteSoft) {
    ps.demotedAt = now
    ps.demoteSoft = false
  }
  return { demoted: true, demoteStarted, counted: true }
}

/** 探测成功：立刻撤销降权（与「任意一次成功即恢复原位」的沉底语义保持一致） */
export const clearPlatformDemote = (ps: PlatformProbeState): void => {
  ps.demotedAt = 0
  ps.demoteSoft = false
}

/**
 * 从回收站恢复音源后清掉它的「已移除」标记与失效计时。
 *
 * 不清的后果：probe-status.json 里该源的 removedAt 还在 ——
 * getSourceProbeStatus 会跳过 removedAt 条目（面板上看不到这个源），
 * 自动移除判定也会 continue（用户救回的源永远不再被考察）。
 *
 * 巡检进行中改的是同一份内存对象（liveStatusByOwner 里的引用），
 * 轮末整体 writeStatus 不会把我们这次清理覆盖掉；不在巡检就直接落盘。
 */
export const clearProbeRemoval = (owner: string, sourceId: string): boolean => {
  if (!owner || !sourceId) return false
  const live = liveStatusByOwner
  const status = live ? live.get(owner) : readStatus(owner)
  if (!status) return false
  const sourceState = status.sources[sourceId]
  if (!sourceState) return false
  let changed = false
  if (sourceState.removedAt !== undefined) { delete sourceState.removedAt; changed = true }
  if (sourceState.removedReason !== undefined) { delete sourceState.removedReason; changed = true }
  if (sourceState.allDownSince !== undefined) { delete sourceState.allDownSince; changed = true }
  if (changed) writeStatus(owner, status)
  return changed
}

/**
 * 删除音源（手动删进回收站 / 彻底删除 / 回收站清空）时，把它的巡检账本条目一并删掉。
 *
 * 不删的后果（2026-11-06 246 实测）：getSourceProbeStatus 的快照里会一直挂着
 * 这个已经不存在的源的行 —— `gdstudio音乐源.js` 删回回收站后 details 仍报 5 行，
 * 且永远不会自愈：巡检不再巡它（源已不在列表），账本也没人剪除，面板展示幽灵。
 *
 * 与 clearProbeRemoval 并列：恢复=清「已移除」标记留历史，删除=整条删掉。
 * 注意「probe 自动移除」不走这里：那条路写的是 removedAt 标记，快照靠
 * `if (removedAt) continue` 跳过，同样不产生幽灵行，且保留了失效历史。
 *
 * 读失败时不落盘：readStatus 异常会返回空账本，直接 writeStatus 会把真账本覆盖成空。
 * 所以只在该源条目确实存在时才写。
 */
export const removeProbeStatus = (owner: string, sourceId: string): boolean => {
  if (!owner || !sourceId) return false
  const live = liveStatusByOwner
  const status = live ? live.get(owner) : readStatus(owner)
  if (!status || !status.sources[sourceId]) return false
  delete status.sources[sourceId]
  writeStatus(owner, status)
  return true
}

/**
 * 巡检启动时的账本自愈（2026-11-06 新增，246 全量账本扫描发现两类脏数据）：
 *
 * C1 反向幽灵：源文件还在（活跃源）但账本残留 removedAt —— 快照靠
 *     `if (removedAt) continue` 跳过，于是一个**活源**的巡检明细对 /health 不可见。
 *     现场：`幻音音源.js`，账本残留 11-02 的自动移除记录，文件后来回到源目录
 *     但当时还没有 clearProbeRemoval，标记永远没人清。→ 走 clearProbeRemoval 清掉。
 * C2 真孤儿：账本有条目，但源文件没了也不在回收站 —— 快照永久挂幽灵行
 *     （现场：`Appx64 Clear Music.js`、probe-verify 空间的 `巡检验证源.js`）。
 *     → 走 removeProbeStatus 整条剪除。
 *
 * 注意：`id.disabled` 结尾的文件（停用产物，如 `豆包定制[聚合音源].js.disabled`）
 * 视为「存在」——停用是设计内状态，条目保留，不剪。
 * 只在全量巡检时调用（restoreOnly / only 批量的 targets 是过滤后的子集，不能当活跃全集）。
 */
export const selfHealProbeLedger = (
  owner: string,
  activeIds: Set<string>,
  trashedIds: Set<string>,
): { healed: string[]; pruned: string[] } => {
  const healed: string[] = []
  const pruned: string[] = []
  const status = readStatus(owner)
  if (!status || !Object.keys(status.sources || {}).length) return { healed, pruned }
  const dir = ownerDir(owner)
  for (const id of Object.keys(status.sources)) {
    if (activeIds.has(id)) {
      if (status.sources[id]?.removedAt !== undefined && clearProbeRemoval(owner, id)) {
        healed.push(id)
        syncLog.warn(`[音源巡检] 自愈：${id} 源文件仍在但账本残留 removedAt，已清除（快照恢复可见）`)
      }
      continue
    }
    if (trashedIds.has(id)) continue
    const fileAlive = [path.join(dir, id), path.join(dir, `${id}.disabled`)].some(p => fs.existsSync(p))
    if (fileAlive) continue
    if (removeProbeStatus(owner, id)) {
      pruned.push(id)
      syncLog.warn(`[音源巡检] 自愈：${id} 源文件已消失且不在回收站，账本孤儿条目已剪除`)
    }
  }
  return { healed, pruned }
}

/** 枚举所有有巡检账本的空间（_open 目录映射回 owner 'open'） */
export const ledgerOwners = (): string[] => {
  const root = sourceRoot()
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d: any) => d.isDirectory())
      .map((d: any) => d.name)
  } catch {
    return []
  }
  return dirs
    .filter(name => fs.existsSync(path.join(root, name, STATUS_FILE)))
    .map(name => (name === '_open' ? 'open' : name))
}

/** 磁盘状态的短缓存（只服务 isPlatformDemoted 这条热路径） */
const statusReadCache = new Map<string, { at: number; status: ProbeStatusFile }>()
const STATUS_READ_CACHE_MS = 30_000

const readStatusCached = (owner: string): ProbeStatusFile | null => {
  const hit = statusReadCache.get(owner)
  const now = Date.now()
  if (hit && now - hit.at < STATUS_READ_CACHE_MS) return hit.status
  try {
    const status = readStatus(owner)
    statusReadCache.set(owner, { at: now, status })
    return status
  } catch {
    return null
  }
}

/**
 * 给取链排序层用：该「源 × 平台」当前是否处于降权观察期。
 *
 * 巡检进行中直接读内存状态（liveStatusByOwner）；不在巡检时读磁盘，带 30 秒缓存 ——
 * 取链是热路径，不能每首歌都同步读一次 probe-status.json。
 * 读不到 / 没建档一律返回 false（宁可少降权，也不凭缺失证据改变顺序）。
 */
export const isPlatformDemoted = (owner: string, sourceId: string, platform: string, now: number = Date.now()): boolean => {
  if (!owner || !sourceId || !platform) return false
  const live = liveStatusByOwner
  const status = live ? live.get(owner) : readStatusCached(owner)
  const ps = status?.sources?.[sourceId]?.platforms?.[platform]
  return isDemoteActive(ps, now)
}

function disableThresholdFor(ps: { restoredAt?: number } | undefined, threshold: number): number {
  const restoredAt = Number(ps?.restoredAt || 0)
  if (!restoredAt) return threshold
  return Date.now() - restoredAt < RESTORE_DEBOUNCE_MS ? threshold * 2 : threshold
}

/**
 * 把「手动取链」遇到的硬故障记进巡检账本。
 *
 * 为什么不直接关平台：手动请求是**单首歌、单次失败**，而没有版权/已下架/这首歌在该源没资源
 * 这类软失败占比极高，凭一首冷门歌就关平台会一次性误伤一批。
 * 所以这里只记「与歌曲无关」的硬故障（域名解析失败、连接重置、超时、5xx、接口已废弃、证书过期），
 * 且只有在**同一首歌、同一平台有别的音源成功**时才可能立即处置 ——
 * 歌能播是确定的，那么它失败只能是它自己的后端挂了。
 * 没有对照组时只累加计数，处置仍留给有测试曲目与阈值保护的巡检。
 */
export function reportManualFailure(ev: ManualFailureReport): { counted: boolean; disabled: boolean; failCount: number } {
  const none = { counted: false, disabled: false, failCount: 0 }
  const conf = configOf()
  if (!conf.enabled) return none

  const live = liveStatusByOwner
  let status: ProbeStatusFile
  if (live) {
    let s = live.get(ev.owner)
    if (!s) { s = readStatus(ev.owner); live.set(ev.owner, s) }
    status = s
  } else {
    status = readStatus(ev.owner)
  }

  const sourceState = status.sources[ev.sourceId]
  // 巡检尚未登记过这个源（例如刚上传还没跑首轮）→ 不凭单次播放就建档
  if (!sourceState) return none
  const ps = sourceState.platforms[ev.platform]
  if (!ps || ps.autoDisabled) return none

  ps.lastCheckAt = Date.now()
  ps.lastError = ev.error
  // 手动取链同样遵守「先降权、后关平台」：第一次硬故障只排到队尾，
  // 与巡检共用同一套状态，避免两条路径对同一个平台给出不同结论
  notePlatformFailure(ps, {
    demoteThreshold: conf.demoteThreshold,
    failThreshold: conf.failThreshold,
  })

  let disabled = false
  if (ev.hasControlGroup && conf.autoDisablePlatform && ps.failCount >= disableThresholdFor(ps, conf.failThreshold)) {
    ps.status = 'down'
    ps.autoDisabled = true
    // 关闭即归档清零：把当前连续失败次数快照下来展示，再让 failCount 归零重新计
    ps.disabledFailCount = ps.failCount
    ps.disabledAt = Date.now()
    ps.failCount = 0
    clearPlatformDemote(ps)
    if (setPlatformDisabled(ev.owner, ev.sourceId, ev.platform, true)) disabled = true
    audit(ev.owner, 'disable-platform', {
      sourceId: ev.sourceId, sourceName: ev.sourceName, platform: ev.platform,
      failCount: ps.disabledFailCount, error: ev.error, via: 'manual-play',
    })
    const msg = `⚠ 已关闭平台解析: ${ev.sourceName} / ${ev.platform}` +
      `（同一首歌下其他音源可播，本源硬故障 ${ps.disabledFailCount} 次：${ev.error}）`
    console.warn(`[手动取链] ${msg}`)
    syncLog.warn(`[手动取链] ${msg}`)
  }

  // 巡检进行中时由它轮末统一落盘；否则自己写回
  if (!live) writeStatus(ev.owner, status)
  return { counted: true, disabled, failCount: ps.failCount }
}

export async function runSourceProbe(
  options: {
    owner?: string
    only?: Array<{ owner: string; id: string }>
    firstProbe?: boolean
    /**
     * 只复检「已被自动关闭」的平台：每平台 1 首、不做定罪/关闭/移除。
     * 由 createSourceProbeRestoreTask 以远小于全量的间隔调用，用来快速恢复误关或临时故障的平台。
     */
    restoreOnly?: boolean
  } = {},
): Promise<ProbeRunResult> {
  const startedAt = Date.now()
  const empty: ProbeRunResult = {
    startedAt, durationMs: 0, sourcesChecked: 0, platformsChecked: 0,
    platformsOk: 0, platformsDown: 0, platformsSkipped: 0, platformsDeferred: 0,
    newlyDisabled: [], demoted: [], restored: [], removed: [], suspectPlatforms: [], suspectSkippedPlatforms: [],
    message: '未执行',
  }

  const deps = depsRef
  if (!deps) return { ...empty, message: '巡检未初始化' }
  const conf = configOf()
  if (!conf.enabled) return { ...empty, message: '巡检已关闭' }
  if (running) return { ...empty, message: '上一轮巡检仍在进行中，跳过本次' }

  running = true
  // 复检不计入 lastRunAt：它只覆盖「已关闭平台」这一小撮样本，
  // 写进主快照会让面板显示成「1 源 / 3 平台」的假巡检结果（本轮压测就踩过这个误判）。
  if (options.restoreOnly) lastRestoreAt = startedAt
  else lastRunAt = startedAt
  statesCache.clear()
  searchAttempted.clear() // 每轮重新允许一次内置搜索，平台恢复后仍能拿到测试曲目
  poolRefreshedThisRound = false
  // 巡检自身就是卡顿来源之一（并发回调的同步序列化开销会叠加），
  // 这里留痕，好让归因把「巡检期内的卡顿」与「音源自发的卡顿」区分开
  beginHostActivity('sourceProbe', options.restoreOnly ? '关闭平台复检中' : `巡检中（${options.firstProbe ? '首轮' : '周期'}）`)
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

    // 账本自愈（C1 反向幽灵 / C2 真孤儿，见 selfHealProbeLedger 注释）。
    // 只在全量巡检跑：restoreOnly / only 批量的 targets 是过滤后子集，不能当活跃全集。
    // 必须在 statusFor(owner) 首次调用之前执行，否则自愈会被轮末 writeStatus 用旧状态覆盖。
    const selfHealNotes: string[] = []
    if (!options.restoreOnly && !(options.only && options.only.length)) {
      const ownerScope = options.owner
        ? [options.owner]
        : [...new Set([...ledgerOwners(), ...targets.map(t => t.owner)])]
      for (const owner of ownerScope) {
        const activeIds = new Set(targets.filter(t => t.owner === owner).map(t => t.id))
        let trashedIds: Set<string>
        try {
          trashedIds = new Set(listTrash(owner).map(i => i.id))
        } catch {
          trashedIds = new Set()
        }
        const r = selfHealProbeLedger(owner, activeIds, trashedIds)
        if (r.healed.length) selfHealNotes.push(`${owner} 恢复可见 ${r.healed.length} 个：${r.healed.join('、')}`)
        if (r.pruned.length) selfHealNotes.push(`${owner} 剪除孤儿 ${r.pruned.length} 个：${r.pruned.join('、')}`)
      }
    }

    const result: ProbeRunResult = {
      startedAt, durationMs: 0, sourcesChecked: targets.length, platformsChecked: 0,
      platformsOk: 0, platformsDown: 0, platformsSkipped: 0, platformsDeferred: 0,
      newlyDisabled: [], demoted: [], restored: [], removed: [], suspectPlatforms: [], suspectSkippedPlatforms: [],
      message: '',
    }

    // 复检专属：被跳过的「降速源」数量与批量截断备注，最后拼进摘要
    let restoreSkippedThrottled = 0
    let restoreCutNote = ''

    const statusByOwner = new Map<string, ProbeStatusFile>()
    const statusFor = (owner: string): ProbeStatusFile => {
      let s = statusByOwner.get(owner)
      if (!s) { s = readStatus(owner); statusByOwner.set(owner, s) }
      return s
    }
    // 巡检进行中：让「手动取链失败记账」走同一份内存状态，
    // 否则它写完文件、巡检轮末又整体 writeStatus 覆盖回去，证据会被抹掉
    liveStatusByOwner = statusByOwner

    interface Job { target: ProbeTarget; platform: string; songs: ProbeTestSong[] }
    const jobs: Job[] = []
    // 「停探」期间每个平台仍保留的哨兵探测数（见下方 suspectBackoff 分支）
    const suspectSamples = new Map<string, number>()
    // 本轮因停探而被跳过的平台计数：> 0 说明该平台正处于停探期，
    // 此时剩下的只是哨兵样本，不能拿去做「自动关闭平台」这种最重的处置
    const suspectSkipCounts = new Map<string, number>()

    for (const target of targets) {
      const status = statusFor(target.owner)
      if (!status.sources[target.id]) status.sources[target.id] = { name: target.name, platforms: {} }
      const sourceState = status.sources[target.id]
      sourceState.name = target.name

      for (const platform of target.platforms) {
        if (!sourceState.platforms[platform]) sourceState.platforms[platform] = emptyPlatformState()
        const platformState = sourceState.platforms[platform]

        // 快速复检模式：只处理「已被自动关闭」的平台。
        // 其余平台既不探测也不计入 skipped —— 这一轮的样本本来就只覆盖关闭平台，
        // 把它们算进「跳过」会让面板上的数字看起来像巡检大面积失效。
        if (options.restoreOnly && !platformState.autoDisabled) continue

        // 复检跳过「降速运行」的慢源：它单次同步块就要 5~7 秒，探它一次就是把主线程
        // 停住一次，而它的平台本来也大多是同一个后端在失败——纯亏。
        // 这些源仍在全量巡检里参与，降速状态 30 分钟自动过期，过期后复检自然又会带上它。
        if (options.restoreOnly && isThrottled(target.owner, target.id)) {
          restoreSkippedThrottled++
          continue
        }

        // 用户在面板上手动关闭的平台：尊重用户选择，永不参与自动复检
        const flags = readPlatformFlags(ownerDirName(target.owner), target.id)
        // 幽灵禁用：巡检状态记着 autoDisabled=true，但 states.json 里这个平台的开关其实是开着的
        // （旧版本「写状态成功、写开关失败」，或用户从面板手动把它开回来了）。
        // 这时面板显示「已关闭」而实际仍在参与取链，属于最难排查的一类不一致——
        // 以已有证据为准补写开关：该平台已经被判定连续失败达阈值，宁可多禁，也不放开。
        if (platformState.autoDisabled && !flags.disabled.has(platform)) {
          if (setPlatformDisabled(target.owner, target.id, platform, true)) flags.disabled.add(platform)
        }
        // 手动平台开关/停用判定（与五大平台同源，均读脚本 states.json）
        let manuallyDisabled = flags.disabled.has(platform)
        manuallyDisabled = manuallyDisabled && !platformState.autoDisabled
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
          // 每个平台仍保留 SUSPECT_SAMPLE_SIZE 个哨兵探测。
          // 不加这一刀会出大事：平台种类一共就 wy/tx/kw/kg/mg 这么几个，一旦它们同时被判 suspect，
          // 「按平台停探」就等价于「整轮停探」——实测出现过 40 源 / 166 平台一轮只探 0 个、
          // 全程 76ms 空转，巡检等于被自己关掉，而且平台恢复了也发现不了。
          // 有哨兵就既能观测平台是否恢复，成本又只有几个请求。
          const sampled = suspectSamples.get(platform) ?? 0
          if (sampled < SUSPECT_SAMPLE_SIZE) {
            suspectSamples.set(platform, sampled + 1)
          } else {
            platformState.status = 'skipped'
            platformState.lastCheckAt = Date.now()
            platformState.lastError = '平台侧疑似异常（上轮过半音源同时失败），本轮停探'
            result.platformsSkipped++
            suspectSkipCounts.set(platform, (suspectSkipCounts.get(platform) ?? 0) + 1)
            if (!result.suspectSkippedPlatforms.includes(platform)) result.suspectSkippedPlatforms.push(platform)
            continue
          }
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
        // 首轮失败只是累计 failCount（默认要连续 2 轮），真正的定罪与重试留给后续周期巡检。
        // 快速复检同样只试 1 首：复检的目的只是「确认平台是否恢复」，探到能出链就停，
        // 探不到也只记证据、不定罪，多试几首纯属浪费上游请求。
        //
        // 已被自动关闭的平台在全量轮里也只试 1 首（2026-11-03 实测）：
        // 这类平台本来就判过「不可用」，139 个平台里有 43 个属于此类，
        // 每平台再试 3 首等于拿 3 倍超时时间去确认一个已知结论。
        // 它们的目的是「发现恢复」而不是「复核可用性」，1 首足够；真恢复了下轮自然会转正常巡检。
        const onlyOne = options.firstProbe || options.restoreOnly || platformState.autoDisabled
        jobs.push({ target, platform, songs: onlyOne ? songs.slice(0, 1) : songs })
      }
    }

    // ---- 任务排序与预算 ----
    // 按「该源×平台上次探测时间」从旧到新排队。配合下面的总时长预算，
    // 被预算截断的任务天然落到下一轮最前面，不会出现「尾部平台永远探不到」的饥饿。
    const lastCheckOf = (job: Job): number => {
      const st = statusFor(job.target.owner)
      const ps = st.sources[job.target.id]?.platforms?.[job.platform]
      return ps?.lastCheckAt || 0
    }
    if (!options.firstProbe) {
      // 降速运行的慢源排到队尾：它单次就要占住主线程数秒，排在前面等于让同批其它源
      // 都在它后面排队（慢源之间还有互斥闸，排在前面只会互相等）。
      // 排序保持稳定：先按「是否降速」分组，组内仍按上次探测时间轮转，
      // 慢源不会饿死 —— 降速状态 30 分钟自动过期，过期即回到正常队列。
      jobs.sort((a, b) => {
        const ra = isThrottled(a.target.owner, a.target.id) ? 1 : 0
        const rb = isThrottled(b.target.owner, b.target.id) ? 1 : 0
        if (ra !== rb) return ra - rb
        return lastCheckOf(a) - lastCheckOf(b)
      })
    }
    // 快速复检每轮只取 N 个。**必须按「上次探测时间」轮转，不能按「关闭时间」**：
    // 按关闭时间会把最老的 16 个固定下来，它们若一直探不通，后面的平台永远排不到
    // （2026-11-03 实机首轮就踩到：16 个全失败，下一轮还是同一批）。
    // 这里的 jobs 已经按 lastCheckAt 升序排好，探测后 lastCheckAt 会刷新，天然轮转。
    let plannedJobs = jobs
    if (options.restoreOnly && jobs.length > conf.restoreBatch) {
      plannedJobs = jobs.slice(0, conf.restoreBatch)
      // 不能直接写 result.message：后面统一拼摘要时会整段覆盖，这条提示就丢了
      restoreCutNote = `；本轮只取 ${plannedJobs.length}/${jobs.length} 个（restoreBatch=${conf.restoreBatch}，按最久未探轮转）`
    }

    // 并发消费探测任务。同一个平台会按候选测试曲目依次重试，任意一首成功即视为该平台可用 ——
    // 单曲常常恰好是无版权/需会员的歌，只探一首会把「歌不可播」错判成「平台不可用」。
    let cursor = 0
    /** 因超出总时长预算而未探测的任务数（下一轮会排在最前面） */
    let budgetCut = 0
    /** 因「7 天内有真实播放成功」而跳过合成探测的数量（v1.5.54） */
    let skippedByPlayRank = 0
    // 平台级节流：同一平台的两次探测之间至少间隔 conf.throttleMs。
    // 全量巡检 139 个平台里，单个平台往往排着 20~30 个源；并发全开时同一平台会瞬时收到
    // 好几个请求，这正是最容易触发平台风控（以及被平台侧判定为异常流量）的形态。
    // 用一个很轻的间隔把瞬时并发摊平，对总时长的影响可以忽略（139×0.25s 分散在几分钟里）。
    const nextSlotAt = new Map<string, number>()
    const waitPlatformSlot = async (platform: string) => {
      if (!conf.throttleMs) return
      const now = Date.now()
      const slot = nextSlotAt.get(platform) || 0
      if (slot > now) {
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(slot - now, conf.throttleMs)))
      }
      nextSlotAt.set(platform, Date.now() + conf.throttleMs)
    }
    // 总时长预算：到点不再领新任务，剩余留到下一轮（任务已按上次探测时间排好序，不会饿死）
    const budgetDeadline = startedAt + conf.maxDurationMs
    const worker = async () => {
      while (true) {
        // 处理完一个平台就让出一次事件循环：
        // 并发回来的一批响应，每个都要在沙箱边界做 decontextify + JSON.parse，
        // 挨在一起就糊成数秒的同步阻塞（实测巡检自身曾造成 7~15 秒卡顿）。
        // setImmediate 只让出一个 tick，对巡检总时长的影响可以忽略。
        await new Promise<void>(resolve => { setImmediate(resolve) })
        const index = cursor++
        if (index >= plannedJobs.length) return
        // 预算耗尽：剩下的不领了。标记出来而不是静默跳过 ——
        // 「这轮只探了 80 个」和「这轮 80 个都正常」是两件事。
        if (Date.now() > budgetDeadline) {
          budgetCut++
          continue
        }
        const job = plannedJobs[index]
        await waitPlatformSlot(job.platform)
        const status = statusFor(job.target.owner)
        const platformState = status.sources[job.target.id].platforms[job.platform]
        result.platformsChecked++

        // ---- 真实播放数据优先（v1.5.54，用户 2026-11-11 拍板的 C 项）----
        // 最近 7 天这个「源 × 平台」在真实播放链路里成功取过链 → 本轮不拿测试曲去试。
        // 理由：合成探测的测试曲本身可能不可播，用它否定一个用户天天在用的源不划算。
        // 标记 deferredAt = 本轮无新证据：既不参与定罪，也不阻断「全平台失效」判定。
        if (conf.preferPlayRank && hasRecentSuccess(
          { owner: job.target.owner, id: job.target.id, platform: job.platform }, PLAY_RANK_FRESH_MS)) {
          platformState.deferredAt = Date.now()
          platformState.lastCheckAt = Date.now()
          result.platformsSkipped++
          skippedByPlayRank++
          continue
        }

        let ok = false
        let lastError = ''
        // 赦免标记是「本轮」语义：探测前先清掉，避免上一轮的标记一直粘着，
        // 让这个平台永远不参与全平台失效判定
        platformState.deferredAt = 0
        for (const song of job.songs) {
          const outcome = await probePlatform(job.target, job.platform, song, conf)
          if (outcome.ok) { ok = true; break }
          lastError = outcome.error || '未知错误'
        }
        platformState.lastCheckAt = Date.now()

        if (ok) {
          platformState.failCount = 0
          platformState.softCount = 0
          platformState.deferredAt = 0
          platformState.lastOkAt = Date.now()
          platformState.lastError = ''
          // 成功一次即撤销降权：顺序上的惩罚必须能被一次真实成功立刻抹掉
          clearPlatformDemote(platformState)
          result.platformsOk++

          // 之前被自动关闭的平台恢复可用 → 立即自动重新开启（恢复一定是安全的，不必等后置校验）
          if (platformState.autoDisabled) {
            platformState.autoDisabled = false
            platformState.disabledFailCount = 0
            platformState.disabledAt = 0
            // 记下恢复时刻：30 分钟内再失败要双倍证据才允许重新关闭（见 disableThresholdFor）
            platformState.restoredAt = Date.now()
            setPlatformDisabled(job.target.owner, job.target.id, job.platform, false)
            result.restored.push(`${job.target.name}/${job.platform}`)
            audit(job.target.owner, 'restore-platform', { sourceId: job.target.id, sourceName: job.target.name, platform: job.platform })
            console.log(`[音源巡检] ✓ 平台已恢复，自动重新开启: ${job.target.name} / ${job.platform}`)
            syncLog.info(`[音源巡检] ✓ 平台已恢复，自动重新开启: ${job.target.name} / ${job.platform}`)
          }
          platformState.status = 'ok'
        } else {
          // 先降权、后关平台：第一次失败只把该「源 × 平台」排到取链队尾（不写 states.json），
          // 连续失败到 failThreshold 才由下面的落定阶段关闭。
          const noted = notePlatformFailure(platformState, {
            demoteThreshold: conf.demoteThreshold,
            failThreshold: conf.failThreshold,
            // 检测科学化的核心一步：本机网络/限流/风控类失败只降权，不计入关闭与删除的阈值
            hard: isHardFailure(lastError),
          })
          platformState.lastError = shorten(lastError)
          // 是否「不可用」要等平台侧系统性判定后再落定，这里先按证据不足处理
          platformState.status = 'unknown'
          // 快速复检轮只做「恢复」，单平台单曲的失败不构成任何处置证据 → 打赦免标，
          // 免得这轮的 failCount 被后面的「全平台失效」判定当成定罪证据
          if (options.restoreOnly) platformState.deferredAt = Date.now()
          if (noted.demoteStarted) {
            result.demoted.push(`${job.target.name}/${job.platform}`)
            console.log(`[音源巡检] ↓ 已降权观察: ${job.target.name} / ${job.platform}` +
              `（首次失败：${platformState.lastError}；仅排到换源队尾，连续失败 ${conf.failThreshold} 次才关闭）`)
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(conf.concurrency, Math.max(1, plannedJobs.length)) }, () => worker()))
    if (budgetCut > 0) {
      const msg = `[音源巡检] 本轮达到 ${Math.round(conf.maxDurationMs / 1000)} 秒预算，剩余 ${budgetCut} 个任务留到下一轮（下轮优先）`
      console.warn(msg)
      syncLog.warn(msg)
      result.budgetCut = budgetCut
      result.message = result.message ? `${result.message}；${msg}` : msg
    }

    // ---- 平台侧系统性异常判定 ----
    // 同一个平台如果在「多数音源」上同时失败，那么更可能是测试曲目不可播、平台侧限流/风控等外部原因，
    // 而不是某个音源自己坏了。此时若继续按「连续失败达阈值」自动关闭，会一次性误伤大量可用音源，
    // 甚至因为「全部平台都失败」把这些音源整个删掉。因此这类平台本轮只记录、不处置，交由人工判断。
    const platformStats = new Map<string, { checked: number; failed: number; ok: number }>()
    // 快速复检的样本只覆盖「已关闭平台」，单平台 1 首，既不能代表平台整体，也不足以定罪；
    // 传空数组让后续所有「平台侧异常 / 停探续期」分支自然不成立。
    const statJobs = options.restoreOnly ? [] : jobs
    for (const job of statJobs) {
      const ps = statusFor(job.target.owner).sources[job.target.id].platforms[job.platform]
      const stat = platformStats.get(job.platform) || { checked: 0, failed: 0, ok: 0 }
      stat.checked++
      if (!ps || ps.failCount > 0) stat.failed++
      else stat.ok++
      platformStats.set(job.platform, stat)
    }
    const suspectPlatforms = new Set<string>()
    /**
     * 真正「几乎没人能播」的平台：失败比例过半 **且** 成功率低到没有对照组。
     * 只有这一档才整档赦免失败，并续期停探。
     *
     * 有对照组的平台（失败过半但仍有若干音源成功）只赦免「软失败」，
     * 命中硬故障特征（域名解析失败/连接重置/源站 5xx/接口已废弃/加密方案过期）的照常定罪 ——
     * 已经证明曲目能播，那么这些源失败只能是它们自己的后端出了问题。
     */
    const fullSuspectPlatforms = new Set<string>()
    /** 需要续期「停探」的平台（无对照组且样本量够，见 SUSPECT_MIN_SAMPLE） */
    const backoffPlatforms = new Set<string>()
    for (const [platform, stat] of platformStats) {
      if (stat.checked > 0 && stat.failed / stat.checked >= conf.systemicFailureRatio) {
        suspectPlatforms.add(platform)
        result.suspectPlatforms.push({ platform, checked: stat.checked, failed: stat.failed, ok: stat.ok })
        const hasControlGroup = stat.ok / stat.checked > conf.suspectMaxOkRatio
        if (hasControlGroup) continue
        fullSuspectPlatforms.add(platform)
        // 只有样本量够的平台才续期「停探」。定罪本身仍按原样（含小样本），
        // 这样小音源库依旧受保护，但停探期不会因为哨兵全挂而无限续期。
        if (stat.checked >= SUSPECT_MIN_SAMPLE) backoffPlatforms.add(platform)
      }
    }
    if (suspectPlatforms.size) {
      result.suspectPlatforms.sort((a, b) => b.failed / b.checked - a.failed / a.checked)
      const fmt = (s: { platform: string; checked: number; failed: number; ok: number }) =>
        `${s.platform}(失败${s.failed}/探测${s.checked}，可用${s.ok}${fullSuspectPlatforms.has(s.platform) ? '' : '，有对照组→硬故障仍处置'})`
      console.warn('[音源巡检] ⚠ 以下平台在过半音源上同时失败：' +
        `${result.suspectPlatforms.map(fmt).join('、')}`)
    }
    if (fullSuspectPlatforms.size) {
      const noSuccess = result.suspectPlatforms.filter(
        s => s.ok === 0 && fullSuspectPlatforms.has(s.platform)
      ).map(s => s.platform)
      if (noSuccess.length) {
        console.warn('[音源巡检] ⓘ ' +
          `${noSuccess.join('、')} 本轮没有任何音源探测成功，更可能是测试曲目不可播或平台整体不可用，` +
          `而不是这些音源同时坏了；若每轮都如此，可在 config.js 里用 customSource.probe.testSongs 指定曲目`)
      }
    }

    // 记录停探截止时间（半个周期）：这些平台下一轮不再重复探测，省下的时间留给真正需要探的平台
    if (conf.suspectBackoff && backoffPlatforms.size) {
      const skipUntil = startedAt + Math.floor((conf.intervalMinutes * 60 * 1000) / 2)
      for (const target of targets) {
        const sourceState = statusFor(target.owner).sources[target.id]
        if (!sourceState) continue
        for (const platform of target.platforms) {
          if (!backoffPlatforms.has(platform)) continue
          const ps = sourceState.platforms[platform]
          if (ps) ps.suspectSkipUntil = skipUntil
        }
      }
    }

    // ---- 落定每个平台的结论并执行自动关闭 ----
    // 快速复检到这里就结束：worker 里已经把「探测成功」的平台重新打开，
    // 剩下的事（定罪、关闭、移除）都需要多轮多平台证据，单平台单曲的复检样本一律不参与。
    if (!options.restoreOnly) for (const target of targets) {
      const sourceState = statusFor(target.owner).sources[target.id]
      for (const platform of target.platforms) {
        const ps = sourceState.platforms[platform]
        if (!ps || ps.status === 'skipped' || ps.status === 'ok') continue
        if (ps.failCount < disableThresholdFor(ps, conf.failThreshold)) { ps.status = 'unknown'; continue }
        // 停探期：这一轮剩下的只是哨兵样本（每平台 3 个），拿它去关闭平台属于
        // 「用最少的证据做最重的处置」——哨兵的职责是观测平台是否恢复，不是定罪。
        if ((suspectSkipCounts.get(platform) ?? 0) > 0) {
          ps.status = 'unknown'
          // 哨兵样本只用来观测平台是否恢复，不构成对本源的定罪证据
          ps.deferredAt = Date.now()
          continue
        }
        if (suspectPlatforms.has(platform)) {
          // 整档赦免：该平台几乎没有音源能播，失败更可能是测试曲目不可播 / 平台限流。
          // 有对照组时只赦免软失败 —— 已经证明曲目能播，命中硬故障特征的就是这个音源自己的后端挂了
          if (fullSuspectPlatforms.has(platform) || !isHardFailure(ps.lastError)) {
            ps.status = 'unknown'
            // 关键：赦免必须一路穿透到「整源删除」判定。只改 status 不改证据，
            // 就会出现「日志写暂缓处置、整源却照样起 3 天删除倒计时」（2026-11-11 实测 6 个源中招）。
            ps.deferredAt = Date.now()
            result.platformsDeferred++
            continue
          }
        }
        ps.status = 'down'
        // 真实定罪 → 清掉赦免标，让这次的失败正常参与全平台失效判定
        ps.deferredAt = 0
        result.platformsDown++
        if (conf.autoDisablePlatform && !ps.autoDisabled) {
          ps.autoDisabled = true
          // 关闭即归档清零：把连续失败次数快照下来展示，再让 failCount 归零重新计，
          // 避免「连续失败 66 次」这种只增不减的展示（问题：failCount 停探期/关闭后不清零）
          ps.disabledFailCount = ps.failCount
          ps.disabledAt = Date.now()
          ps.failCount = 0
          // 平台已关闭，降权标记没有意义了（它在 states.json 里已不可选），一并清掉
          clearPlatformDemote(ps)
          setPlatformDisabled(target.owner, target.id, platform, true)
          result.newlyDisabled.push(`${target.name}/${platform}`)
          audit(target.owner, 'disable-platform', {
            sourceId: target.id, sourceName: target.name,
            platform, failCount: ps.disabledFailCount, error: ps.lastError,
          })
          console.warn(`[音源巡检] ⚠ 已关闭平台解析: ${target.name} / ${platform}（连续失败 ${ps.disabledFailCount} 次，原因：${ps.lastError}）`)
          syncLog.warn(`[音源巡检] ⚠ 已关闭平台解析: ${target.name} / ${platform}（连续失败 ${ps.disabledFailCount} 次，原因：${ps.lastError}）`)
        }
      }
    }

    // 复检只做「恢复」：上面的定罪块整段跳过，platformsDown 因此永远是 0，
    // 摘要就变成「可用 0、不可用 0、跳过 0」——看着像啥都没干（2026-11-04 246 实测三轮都这样）。
    // 这里按「探测过但没恢复」补齐，让面板与日志能看出复检到底成没成。
    if (options.restoreOnly) {
      result.platformsDown = Math.max(0, result.platformsChecked - result.platformsOk)
    }

    // 全平台不可用 → 移除音源
    if (conf.autoRemoveSource && !options.restoreOnly) {
      const windowMs = Math.max(0, conf.allDownDays) * 86400_000
      for (const target of targets) {
        const status = statusFor(target.owner)
        const sourceState = status.sources[target.id]
        const platforms = Object.entries(sourceState.platforms)
        if (!platforms.length || sourceState.removedAt) continue
        if (!target.platforms.length) continue

        // 「全平台失效」判定与「持续多久」判定都抽成纯函数（见 evalAllDown / decideAllDownRemoval）：
        // 这两个条件以前写死在一起，导致「所有平台都探不通」的源因为一个平台 status !== 'down'
        // 就永远凑不齐移除条件（2026-11-06 实测死锁）。
        const verdict = evalAllDown(target.platforms, p => sourceState.platforms[p])
        const now = Date.now()
        const decision = decideAllDownRemoval(sourceState.allDownSince || 0, verdict, now, windowMs)
        if (decision.since !== (sourceState.allDownSince || 0)) {
          sourceState.allDownSince = decision.since || undefined
        }
        if (!decision.remove) {
          if (decision.started) {
            console.warn(`[音源巡检] ⏳ 音源全平台失效，开始计时: ${target.name}` +
              `（${conf.allDownDays} 天后移除；期间任一平台恢复即取消）`)
          }
          continue
        }

        const reason = `全部平台（${target.platforms.join(', ')}）持续失效超过 ${conf.allDownDays} 天`
        if (removeSource(target.owner, target.id, target.name, reason, deps, conf)) {
          sourceState.removedAt = Date.now()
          sourceState.removedReason = reason
          result.removed.push(`${target.name} (${target.id})`)
        }
      }
    }

    for (const [owner, status] of statusByOwner) writeStatus(owner, status)

    result.durationMs = Date.now() - startedAt
    result.message =
      `巡检 ${targets.length} 个音源的 ${result.platformsChecked} 个平台：` +
      `可用 ${result.platformsOk}、不可用 ${result.platformsDown}、跳过 ${result.platformsSkipped}` +
      (skippedByPlayRank ? `（其中 ${skippedByPlayRank} 个因 7 天内有真实播放成功而免测）` : '') +
      (result.platformsDeferred ? `（另有 ${result.platformsDeferred} 个失败因平台疑似异常暂缓，未计入不可用）` : '') +
      (result.demoted.length ? `；降权观察 ${result.demoted.length} 个（仅排到换源队尾）` : '') +
      (result.newlyDisabled.length ? `；新关闭 ${result.newlyDisabled.length} 个平台` : '') +
      (result.restored.length ? `；恢复 ${result.restored.length} 个平台` : '') +
      (result.removed.length ? `；移除 ${result.removed.length} 个音源` : '') +
      (result.suspectPlatforms.length ? `；${result.suspectPlatforms.length} 个平台疑似平台侧异常已暂缓处置` : '') +
      (result.suspectSkippedPlatforms.length
        ? `；${result.suspectSkippedPlatforms.length} 个平台上轮疑似异常本轮停探（每平台保留 ${SUSPECT_SAMPLE_SIZE} 个哨兵）` : '') +
      (restoreSkippedThrottled ? `；跳过 ${restoreSkippedThrottled} 个降速中的慢源` : '') +
      restoreCutNote +
      (selfHealNotes.length ? `；账本自愈 ${selfHealNotes.join('；')}` : '')

    if (options.restoreOnly) lastRestoreRun = result
    else lastRun = result
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
    if (options.restoreOnly) lastRestoreRun = failed
    else lastRun = failed
    return failed
  } finally {
    running = false
    liveStatusByOwner = null
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

let healedOnce = false
/**
 * 启动自愈：把旧版本留下的「半截禁用态」补齐并落盘。
 *
 * 巡检默认 6 小时一轮，指望它自然落盘意味着脏数据要在面板上挂几个小时；
 * 容器起来就修一次最省事。只碰 probe-status.json，**不动** states.json 的平台开关，
 * 也就是不会因为「修数据」而意外放行被关闭的平台。
 */
export function healProbeStatus(): { owners: number; fields: number } {
  if (healedOnce) return { owners: 0, fields: 0 }
  healedOnce = true
  const owners = new Set<string>(['open', ...registeredUsers()])
  for (const target of depsRef ? depsRef.listTargets() : []) owners.add(target.owner)
  const touched: string[] = []
  let fields = 0
  for (const owner of owners) {
    try {
      const file = statusPath(owner)
      if (!fs.existsSync(file)) continue
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (!raw || typeof raw !== 'object' || typeof raw.sources !== 'object') continue
      const status: ProbeStatusFile = { version: 1, updatedAt: Number(raw.updatedAt) || 0, sources: raw.sources || {} }
      const fixed = normalizeStatus(status)
      if (fixed > 0) {
        writeStatus(owner, status)
        touched.push(`${owner}(${fixed})`)
        fields += fixed
      }
    } catch { /* 单个空间读失败不影响其它空间 */ }
  }
  if (touched.length) {
    const msg = `[音源巡检] 启动自愈：补齐旧版本的禁用态字段 ${touched.join('、')}`
    console.log(msg)
    syncLog.info(msg)
  }
  return { owners: touched.length, fields }
}

/** 注册到后台任务调度器 */
export function createSourceProbeTask(): ScheduledTask {
  const conf = configOf()
  try { healProbeStatus() } catch { /* 自愈失败不影响巡检本身 */ }
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

/**
 * 「已关闭平台」快速复检任务。
 *
 * 为什么单独一个任务：全量巡检的间隔是 180/360 分钟，而被自动关闭的平台只能在全量轮里
 * 才有机会恢复 —— 一次误判、或平台一次临时故障，用户最坏要等 3~6 小时才能重新用上那个源。
 * 复检只探已关闭平台、每平台 1 首、每轮限量，成本是全量的几十分之一，却把恢复窗口压到 30 分钟内。
 *
 * 三条安全边界：
 *   1. `restoreOnly` 下只做「恢复」，不做定罪/关闭/移除（样本太小，不足以定罪）；
 *   2. 每轮最多 restoreBatch 个，按关闭时间最久的优先；
 *   3. 与全量巡检共用 running 互斥，撞上就跳过本次，不会两轮同时打平台。
 */
export function createSourceProbeRestoreTask(): ScheduledTask {
  const conf = configOf()
  const minutes = conf.restoreIntervalMinutes
  const task: ScheduledTask = {
    id: PROBE_RESTORE_TASK_ID,
    name: '已关闭平台快速复检',
    intervalMs: Math.max(1, minutes) * 60 * 1000,
    // 0 表示关闭该功能：任务仍注册（面板可见），但不自动跑
    enabled: conf.enabled && minutes > 0,
    isRunning: false,
    // 排在主巡检之后足够远：主巡检启动后 120 秒开跑、约 5 分钟结束，
    // 复检若紧跟其后（实测首次设在 10 分钟）会撞在平台限流的尾巴上，16 个平台集体失败。
    startupDelayMs: 20 * 60 * 1000,
    run: async (): Promise<TaskExecutionResult> => {
      const result = await runSourceProbe({ restoreOnly: true })
      return {
        taskId: PROBE_RESTORE_TASK_ID,
        timestamp: Date.now(),
        success: true,
        message: result.restored.length
          ? `已恢复 ${result.restored.length} 个平台：${result.restored.slice(0, 5).join('、')}`
          : result.message,
        details: result,
      }
    },
  }
  return task
}

/** 读取某个 owner 的巡检状态文件（不存在/解析失败返回 null）。供设置列表注入额外音源健康状态。 */
export function getProbeStatusForOwner(owner: string): any | null {
  try {
    const s = readStatus(owner)
    return s && typeof s === 'object' ? s : null
  } catch {
    return null
  }
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
            // since 语义修正：原本误写成 lastCheckAt（最后巡检时刻），这里改用真实的禁用时刻 disabledAt
            since: platformState.disabledAt ?? platformState.lastCheckAt,
            disabledAt: platformState.disabledAt ?? 0,
            // 关闭后的连续失败次数以归档值展示（failCount 已归零重新计）
            failCount: platformState.disabledFailCount ?? 0,
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
            // 关闭中的平台用归档的连续失败次数展示；其余用当前实时计数（上限 99）
            failCount: platformState.autoDisabled ? (platformState.disabledFailCount ?? 0) : (platformState.failCount || 0),
            lastCheckAt: platformState.lastCheckAt || 0,
            lastOkAt: platformState.lastOkAt || 0,
            lastError: platformState.lastError || '',
            demoted: isDemoteActive(platformState),
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
    demoteThreshold: conf.demoteThreshold,
    concurrency: conf.concurrency,
    autoDisablePlatform: conf.autoDisablePlatform,
    autoRemoveSource: conf.autoRemoveSource,
    removeMode: conf.removeMode,
    allDownDays: conf.allDownDays,
    lastRunAt,
    lastRun,
    restoreIntervalMinutes: conf.restoreIntervalMinutes,
    restoreBatch: conf.restoreBatch,
    lastRestoreAt,
    lastRestoreRun,
    maxDurationMs: conf.maxDurationMs,
    throttleMs: conf.throttleMs,
    pendingNewSources: pendingNewSources.size,
    autoDisabledPlatforms,
    ...(includeDetail ? { details } : {}),
  }
}
