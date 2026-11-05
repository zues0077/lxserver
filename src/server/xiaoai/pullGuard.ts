/*
 * 投送后的「拉流守门」。
 *
 * 背景（2026-11-01 246 实测）：触屏机型在歌词模式下带曲库 audioID 下发
 * player_play_music 时，部分固件会**优先去播小米曲库里的那一版**，而不是我们给的
 * stream.url。曲库那版若是 VIP 资源（vip=1 / bought=false），音箱只放一段试听，
 * 放完还会播报「当前歌单没有歌曲」——用户看到的是「投送成功」，实际上一整首都没
 * 拉过我们这一路流（/status 实测：streamPulled=false、streamBytes=0、
 * 设备上报 92s 而本曲 256s、position 还在往前走）。
 *
 * 判定不能只看「有没有拉流」：正常投送的首字节也可能晚十几秒。
 * 所以先等一小段，再拿两类**设备侧证据**判断它是不是在播另一版：
 *   1. 设备上报时长明显短于本曲真实时长（播的是试听片段）
 *   2. 曲库把该 audioID 标成 unplayableCode=2（版权闸门拦下）
 *   3. 两次采样之间进度在推进（它确实在出声，但出的不是我们的流）
 *   4. 设备上报的 audio_id 与本次下发的不一致（推送没落地，还在播上一首/别的曲目）
 *   5. 设备上报时长明显**长于**本曲（在播上一首或别的版本）
 * 只有命中证据才动手，宁可慢一秒也不误伤正常播放。
 *
 * 2026-11-01 补 4/5：汽水（soda）投送实测「设备干脆不动」——状态一直冻在
 * `Theme Of Loft / 300329ms / paused`，没进度、没 unplayableCode、时长也不比本曲短，
 * 原 1~3 三类判据全拿不到证据，守门静默放弃。加 4/5 后这类「推了但设备没换曲」
 * 也能被判出来（见手册 P-1045）。
 */

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 从 /status 的返回体里摘出守门需要的字段（纯函数，便于单测） */
export interface StatusSample {
  pulled: boolean
  playing: boolean
  positionMs: number
  durationMs: number
  audioId: string
  unplayableCode: number
}

export function sampleFromStatus(status: any, pulled: boolean): StatusSample {
  const raw = (status && status.raw) || {}
  const detail = raw.play_song_detail || raw.extra_track_list?.[0] || {}
  return {
    pulled: !!pulled,
    playing: !!(status && status.playing),
    positionMs: Number((status && status.positionMs) || 0),
    durationMs: Number(detail.duration || (status && status.durationMs) || 0),
    audioId: String(detail.audio_id || ''),
    unplayableCode: Number(detail.unplayableCode || 0),
  }
}

export interface LibraryPreviewSignal {
  hit: boolean
  reason: string
}

/**
 * 「拉过流但根本没播」判定（2026-11-05）。
 *
 * 原实现里 `isPulled()` 是一票否决：设备只要拉过一次我们的流，守门就直接放弃。
 * 实测（LX04 触屏）存在这种形态：投送成功、设备确实来拉，但只拉 0.2~0.8 秒
 * （约 1MB，正好是起播缓冲）就主动断开，`/status` 一直 `paused / positionMs=0`，
 * 屏上显示暂停三角、点屏幕播放键也起不来。守门因为「拉过流」直接不判，
 * watchdog 又拿不到进度，最后按「无进度=播完」跳下一首 → 死循环跳歌。
 *
 * 判据刻意收紧，只在「明确没播」时才命中，避免打断正常播放或用户主动暂停：
 *   - 设备拉过流，且
 *   - 两次采样都 `playing=false`、`positionMs=0`（从没播到过 1 秒），且
 *   - 服务端最近一段时间已不再向下游写字节（不是还在缓冲），且
 *   - 距本次投送已超过 minElapsedMs（给足起播/协商时间）
 */
export function detectPulledButSilent(
  first: StatusSample,
  second: StatusSample,
  opts: { elapsedSincePushMs: number; streaming: boolean; minElapsedMs?: number; connections?: number },
): LibraryPreviewSignal {
  const minElapsed = Number(opts.minElapsedMs) > 0 ? Number(opts.minElapsedMs) : 18000
  if (!second || !second.pulled) return { hit: false, reason: '' }
  if (Number(opts.elapsedSincePushMs) < minElapsed) return { hit: false, reason: '' }
  // 「服务端还在往下游写字节」通常意味着还在正常缓冲，不能判故障。
  // 但设备反复 Range 重连（每 10 秒一次、每次只读 2MB 就断）时，服务端看起来一直在推，
  // 实际是设备既不播也不消费。这一形态实测过（2026-11-05：《有些》9 次重连、pos 恒 0），
  // 所以「重连 ≥3 次」要越过这条限制。
  const connections = Number(opts.connections) || 0
  // 重连 2 次仍没起播就足够说明问题：正常播放只连 1 次，重连是断流后才有的事
  const repeatedReconnect = connections >= 2
  if (opts.streaming && !repeatedReconnect) return { hit: false, reason: '' }
  if (first?.playing || second.playing) return { hit: false, reason: '' }
  if (Number(first?.positionMs) > 0 || Number(second.positionMs) > 0) return { hit: false, reason: '' }
  const reconnects = repeatedReconnect ? `，已重连 ${connections} 次仍未起播` : ''
  return {
    hit: true,
    reason: `已拉流但 ${Math.round(minElapsed / 1000)}s 内始终未播放`
      + `（playing=false, pos=0${reconnects}）`,
  }
}

/**
 * 判断设备是不是在播「小米曲库那一版」而不是我们的直链。
 *
 * @param first  第一次采样
 * @param second 约 1 秒后的第二次采样（没有就传第一次）
 * @param expectedDurationMs 本曲真实时长（服务端解析出来的）
 * @param expectedAudioId 本次投送给设备的曲库 audioID（没带就传空，4/5 判据自动跳过）
 */
export function detectLibraryPreview(
  first: StatusSample,
  second: StatusSample,
  expectedDurationMs: number,
  expectedAudioId = '',
): LibraryPreviewSignal {
  if (!second || second.pulled) return { hit: false, reason: '' }

  const expected = Number(expectedDurationMs) || 0
  const sent = String(expectedAudioId || '')
  // 1) 时长明显短一截 → 播的是曲库试听（留 20 秒余量，避免元数据误差误判）
  if (second.durationMs > 0 && expected > 0 && second.durationMs + 20000 < expected) {
    return {
      hit: true,
      reason: `设备上报 ${Math.round(second.durationMs / 1000)}s，本曲 ${Math.round(expected / 1000)}s（曲库试听）`,
    }
  }
  // 2) 曲库把这首标成 VIP 不可播，且设备回报的正是我们下发的那个 audioID
  if (second.unplayableCode === 2) {
    return { hit: true, reason: '曲库版权闸门 unplayableCode=2（VIP 不可播）' }
  }
  // 3) 两次采样之间进度在走 → 确实在出声，但不是我们的流
  const delta = second.positionMs - first.positionMs
  if (delta >= 300) {
    return { hit: true, reason: `设备进度推进 ${delta}ms 但未拉取本机流` }
  }
  // 4) 设备上报的 audio_id 与本次下发的不一致 → 这次推送没落地，设备还在播别的曲目。
  //    这是「设备干脆不动」类故障最硬的证据（soda 实测：一直报上一首的 id）。
  if (sent && second.audioId && second.audioId !== sent) {
    return {
      hit: true,
      reason: `设备上报 audio_id=${second.audioId}，本次下发 ${sent}（投送未生效，仍在播其它曲目）`,
    }
  }
  // 5) 时长明显**长于**本曲（30 秒余量）→ 同样是在播别的曲目（上一首往往更长/更短都算）
  if (second.durationMs > 0 && expected > 0 && second.durationMs > expected + 30000) {
    return {
      hit: true,
      reason: `设备上报 ${Math.round(second.durationMs / 1000)}s 长于本曲 ${Math.round(expected / 1000)}s（仍在播其它曲目）`,
    }
  }
  return { hit: false, reason: '' }
}

export type PullGuardAction = 'none' | 'placeholder' | 'url'

export interface PullGuardDeps {
  /** 本次投送之后音箱有没有来拉我们的流 */
  isPulled: () => boolean
  /** 期间是否已经切歌 / 拖动进度（是就放弃守门，别打扰新的一次投送） */
  isStale: () => boolean
  /** 读设备播放状态 */
  getStatus: () => Promise<any>
  /** 本曲真实时长（毫秒），用于识别试听片段 */
  expectedDurationMs: number
  /** 本次下发给设备的曲库 audioID，用于判断设备是不是还在播别的曲目（可选） */
  expectedAudioId?: string
  /** 服务端最近是否仍在向下游写字节（可选，缺省视为在写，即不判「拉流但不播」） */
  isStreaming?: () => boolean
  /** 本次投送以来同一路流被设备请求了几次（可选）：反复重连说明设备既不播也不消费 */
  getConnections?: () => number
  /** 本次投送时刻（ms，可选）：用于判断「拉了流但一直没播」持续了多久 */
  pushedAt?: number
  /** 补救重发：placeholder=换默认封面 audioID，url=纯直链模式 */
  retry: (mode: 'placeholder' | 'url') => Promise<void>
  log: (message: string) => void
  /** 等待时间：首次探测 / 两次采样间隔 / 补救后的复查 / 「拉了不播」判定窗口。单测传很小的值 */
  delays?: { probe?: number; gap?: number; after?: number; silentWindow?: number }
}

/**
 * 守门：投送成功但音箱没拉流、且证据表明它在播曲库那一版时，
 * 依次降级「默认封面 audioID」→「纯直链 player_play_url」重发。
 * 全程静默失败，绝不影响主流程；返回实际做了哪一级补救。
 */
export async function runPullGuard(deps: PullGuardDeps): Promise<PullGuardAction> {
  const probe = deps.delays?.probe ?? 3500
  const gap = deps.delays?.gap ?? 900
  const after = deps.delays?.after ?? 5000
  const sleep = defaultSleep
  /** 一次守门只记一行「证据不足」现场，避免三级探测刷屏 */
  let loggedUnknown = false

  const readSample = async (): Promise<StatusSample | null> => {
    try {
      const status = await deps.getStatus()
      return sampleFromStatus(status, deps.isPulled())
    } catch {
      return null
    }
  }

  interface InspectResult {
    kind: 'pulled' | 'preview' | 'silent' | 'unknown'
    reason: string
    unplayableCode: number
  }
  const unknown = (code = 0): InspectResult => ({ kind: 'unknown', reason: '', unplayableCode: code })
  // 「拉了流但没播」的判定窗口：要给足设备起播与缓冲的时间，太短会打断正常播放。
  // 取 22 秒是有依据的：设备「拉了不播」的典型节奏是「连 10 秒读 2MB → 断开 → 再连」，
  // 22 秒正好覆盖两轮，能拿到「重连 2 次仍 pos=0」这个硬证据（实测 2026-11-05）。
  const silentWindowMs = Number(deps.delays?.silentWindow) > 0 ? Number(deps.delays?.silentWindow) : 22000
  /** kind='preview' 表示拿到了「它在播另一版」的证据；unplayableCode 透传给调用方判 VIP */
  const inspect = async (): Promise<InspectResult> => {
    if (deps.isStale()) return unknown()
    const first = await readSample()
    if (!first) return unknown()
    await sleep(gap)
    if (deps.isStale()) return unknown()
    const second = (await readSample()) || first

    // 设备拉过流：多数情况说明它确实在放我们这一路。但实测有固件只拉起播缓冲
    // （0.2~0.8 秒、约 1MB）就断开，之后一直 paused/pos=0。原实现到这里直接放弃，
    // 于是「拉了但不播」永远判不出来，watchdog 只能按「无进度=播完」跳歌。
    if (first.pulled || second.pulled) {
      const silent = detectPulledButSilent(first, second, {
        elapsedSincePushMs: deps.pushedAt ? Date.now() - deps.pushedAt : 0,
        streaming: deps.isStreaming ? deps.isStreaming() : true,
        connections: deps.getConnections ? deps.getConnections() : 0,
        minElapsedMs: silentWindowMs,
      })
      if (silent.hit) {
        deps.log(`[XiaoAi] 守门：${silent.reason}`)
        return { kind: 'silent', reason: silent.reason, unplayableCode: second.unplayableCode }
      }
      return unknown(second.unplayableCode)
    }

    const signal = detectLibraryPreview(first, second, deps.expectedDurationMs, deps.expectedAudioId)
    if (!signal.hit) {
      // 排障用：拿不到「在播别的曲目」的证据时留一行现场，否则这类「设备不动」永远无法复盘。
      // 一次守门只记一行，避免三级探测把日志刷满。
      if (!second.pulled && !loggedUnknown) {
        loggedUnknown = true
        deps.log(
          `[XiaoAi] 守门未判定：未拉流但证据不足`
          + `（playing=${second.playing} pos=${second.positionMs} dur=${second.durationMs}`
          + ` audio=${second.audioId || '-'} 期望 audio=${deps.expectedAudioId || '-'}）`,
        )
      }
      return unknown(second.unplayableCode)
    }
    deps.log(`[XiaoAi] 投送后未拉取本机流：${signal.reason}`)
    return { kind: 'preview', reason: signal.reason, unplayableCode: second.unplayableCode }
  }

  await sleep(probe)
  let firstHit = await inspect()
  // 设备已经拉过流，但还没到「拉了不播」的判定窗口（3.5s 才起探，窗口是 18s）：
  // 这里补等到窗口再判一次，否则守门 4 秒就收工，这类故障永远抓不到。
  // 正常播放的设备只多几次 /status 请求（后台异步，不影响投送响应）。
  if (firstHit.kind === 'unknown' && deps.isPulled() && Number(deps.pushedAt) > 0) {
    const pushedAt = Number(deps.pushedAt)
    // 分两轮复查：设备「拉了不播」的节奏是「连 10 秒 → 断 → 再连」，
    // 单次采样很容易正好落在重连间隙或正在推字节的瞬间，什么都判不出来。
    for (const at of [silentWindowMs * 0.7, silentWindowMs]) {
      const wait = pushedAt + at - Date.now()
      if (wait <= 0) continue
      await sleep(wait + gap)
      if (deps.isStale()) return 'none'
      firstHit = await inspect()
      if (firstHit.kind !== 'unknown') break
    }
  }
  if (firstHit.kind === 'silent') {
    // 占位 audioID 那一级对「拉流但不播」实测无效（换成占位曲一样不出声），直接走纯直链
    deps.log('[XiaoAi] 已拉流但未播放，跳过占位，直接 player_play_url 纯直链重发')
    try {
      await deps.retry('url')
    } catch (error: any) {
      deps.log(`[XiaoAi] 纯直链重发失败：${error?.message || error}`)
    }
    return 'url'
  }
  if (firstHit.kind !== 'preview') return 'none'

  // 曲库明确判 VIP 不可播（unplayableCode=2）：换默认封面那级基本救不回（实测仍「投送未生效」），
  // 直接跳过占位、走纯直链，省掉一轮 ~5s 协商（手册 P-1113 优化）。非 VIP 的其他证据仍走两级。
  const vipGate = firstHit.unplayableCode === 2 || /unplayableCode=2/.test(firstHit.reason)
  if (!vipGate) {
    deps.log('[XiaoAi] 换默认封面 audioID 重发（曲库那版不可播）')
    try {
      await deps.retry('placeholder')
    } catch (error: any) {
      deps.log(`[XiaoAi] 默认封面重发失败：${error?.message || error}`)
    }
    await sleep(after)
    if ((await inspect()).kind !== 'preview') return 'placeholder'
    deps.log('[XiaoAi] 默认封面仍未拉流，改走 player_play_url 纯直链重发')
  } else {
    deps.log('[XiaoAi] 曲库判 VIP（unplayableCode=2），跳过默认封面直接 player_play_url 纯直链重发')
  }
  try {
    await deps.retry('url')
  } catch (error: any) {
    deps.log(`[XiaoAi] 纯直链重发失败：${error?.message || error}`)
  }
  return 'url'
}
