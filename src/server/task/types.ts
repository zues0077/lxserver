export interface TaskExecutionResult {
  taskId: string
  timestamp: number
  success: boolean
  message: string
  details?: any
}

export interface ScheduledTask {
  id: string
  name: string
  intervalMs: number
  enabled: boolean
  lastRunTime?: number
  nextRunTime?: number
  isRunning: boolean
  lastResult?: TaskExecutionResult
  /** 服务端启动后多久跑第一次（默认 3 秒）；重任务可以调大，避免和启动期抢资源 */
  startupDelayMs?: number
  run: () => Promise<TaskExecutionResult>
}
