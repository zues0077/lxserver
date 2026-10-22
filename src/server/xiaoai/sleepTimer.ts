import { localTime } from '../../utils/time'

/**
 * 小爱专用「定时关机」。
 *
 * 语义说明（重要）：
 *  - 只做「到时停止播放」（player pause + stop），**不承诺断电**——
 *    绝大多数小爱型号没有可用的 MIoT 关机指令，硬发只会得到一条失败日志。
 *  - 两种计时方式：
 *      minutes：按分钟倒计时（到点即停）
 *      songs：按剩余曲数（每成功投送一首扣一次，归零时停）
 *
 * 计时器只在激活期间跑（1 秒一跳），未启用时零开销。
 */

export type SleepTimerMode = 'off' | 'minutes' | 'songs'

export interface SleepTimerStatus {
  mode: SleepTimerMode
  active: boolean
  /** 到点时间戳（毫秒），0 表示不限时 */
  endsAt: number
  /** 剩余毫秒（分钟模式）；曲数模式为 0 */
  remainingMs: number
  /** 剩余曲数（曲数模式）；分钟模式为 -1 */
  songsLeft: number
  /** 启动时设置的总分钟数（界面回显） */
  totalMinutes: number
  /** 启动时设置的总曲数（界面回显） */
  totalSongs: number
  /** 最近一次触发的时刻，0 表示从未触发 */
  lastFiredAt: number
  /** 最近一次触发的说明 */
  lastFiredReason: string
}

type StopHandler = () => Promise<unknown>

const MIN_MINUTES = 1
const MAX_MINUTES = 24 * 60
const MAX_SONGS = 999

class SleepTimer {
  private mode: SleepTimerMode = 'off'
  private endsAt = 0
  private totalMinutes = 0
  private totalSongs = 0
  private songsLeft = -1
  private lastFiredAt = 0
  private lastFiredReason = ''
  private timer: ReturnType<typeof setInterval> | null = null
  private stopHandler: StopHandler | null = null
  /** 防止 stop 还没回来又触发一次 */
  private firing = false

  /** 由 index.ts 注入「停止播放」的实现，避免 timer 直接依赖 service（循环引用） */
  setStopHandler(handler: StopHandler) {
    this.stopHandler = handler
  }

  status(): SleepTimerStatus {
    const now = Date.now()
    return {
      mode: this.mode,
      active: this.mode !== 'off',
      endsAt: this.endsAt,
      remainingMs: this.mode === 'minutes' ? Math.max(0, this.endsAt - now) : 0,
      songsLeft: this.mode === 'songs' ? this.songsLeft : -1,
      totalMinutes: this.totalMinutes,
      totalSongs: this.totalSongs,
      lastFiredAt: this.lastFiredAt,
      lastFiredReason: this.lastFiredReason,
    }
  }

  /** 启动/更新定时。mode='off' 等价于 cancel */
  start(params: { mode?: string; minutes?: number; songs?: number }): SleepTimerStatus {
    const mode = String(params.mode || '').toLowerCase()
    if (mode === 'off' || mode === 'cancel' || mode === '') {
      this.cancel()
      return this.status()
    }
    if (mode !== 'minutes' && mode !== 'songs') {
      throw new Error('定时方式只能是 minutes（按分钟）或 songs（按曲数）')
    }

    if (mode === 'minutes') {
      const minutes = Math.round(Number(params.minutes) || 0)
      if (!Number.isFinite(minutes) || minutes < MIN_MINUTES) throw new Error('请填写至少 1 分钟')
      const clamped = Math.min(MAX_MINUTES, minutes)
      this.mode = 'minutes'
      this.totalMinutes = clamped
      this.totalSongs = 0
      this.songsLeft = -1
      this.endsAt = Date.now() + clamped * 60 * 1000
      console.log(`[XiaoAi] 定时关机：${clamped} 分钟后停止播放（${localTime(new Date(this.endsAt))}）`)
    } else {
      const songs = Math.round(Number(params.songs) || 0)
      if (!Number.isFinite(songs) || songs < 1) throw new Error('请填写至少 1 首')
      const clamped = Math.min(MAX_SONGS, songs)
      this.mode = 'songs'
      this.totalMinutes = 0
      this.totalSongs = clamped
      this.songsLeft = clamped
      this.endsAt = 0
      console.log(`[XiaoAi] 定时关机：再播 ${clamped} 首后停止`)
    }

    this.startTicking()
    return this.status()
  }

  cancel(reason = '用户取消'): SleepTimerStatus {
    if (this.mode !== 'off') {
      console.log(`[XiaoAi] 定时关机已取消（${reason}）`)
    }
    this.mode = 'off'
    this.endsAt = 0
    this.songsLeft = -1
    this.totalMinutes = 0
    this.totalSongs = 0
    this.stopTicking()
    return this.status()
  }

  /**
   * 每成功投送一首歌调用一次（仅曲数模式生效）。
   * 返回是否因此触发停止，便于上层写日志。
   */
  consumeSong(): { fired: boolean; status: SleepTimerStatus } {
    if (this.mode !== 'songs') return { fired: false, status: this.status() }
    // 第一首是"当前正在播的"，从第二首开始才算消耗：投送第 N 首时应该还能听到它
    if (this.songsLeft > 0) this.songsLeft -= 1
    if (this.songsLeft <= 0) {
      void this.fire('已播完设定曲数')
      return { fired: true, status: this.status() }
    }
    console.log(`[XiaoAi] 定时关机：还剩 ${this.songsLeft} 首`)
    return { fired: false, status: this.status() }
  }

  private startTicking() {
    this.stopTicking()
    this.timer = setInterval(() => {
      if (this.mode === 'minutes' && this.endsAt > 0 && Date.now() >= this.endsAt) {
        void this.fire('已到设定时间')
      }
    }, 1000)
    // 不让定时器拖住进程退出（容器 stop 时能立刻退出）
    ;(this.timer as any).unref?.()
  }

  private stopTicking() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async fire(reason: string) {
    if (this.firing) return
    this.firing = true
    this.lastFiredAt = Date.now()
    this.lastFiredReason = reason
    const handler = this.stopHandler
    // 先复位再执行，避免 stop 耗时期间又触发一次
    this.mode = 'off'
    this.endsAt = 0
    this.songsLeft = -1
    this.totalMinutes = 0
    this.totalSongs = 0
    this.stopTicking()
    console.log(`[XiaoAi] 定时关机触发（${reason}）：正在停止小爱播放`)
    try {
      if (handler) await handler()
      console.log('[XiaoAi] 定时关机：停止指令已下发')
    } catch (error: any) {
      console.warn(`[XiaoAi] 定时关机停止失败：${error?.message || error}`)
    } finally {
      this.firing = false
    }
  }
}

export const sleepTimer = new SleepTimer()
