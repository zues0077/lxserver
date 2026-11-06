/**
 * 额外音源（汽水 / B站）的运行态存储。
 *
 * 与社区脚本（custom-source）的 states.json 平行，但独立成一个文件：
 * extraSource 不是「上传的脚本」，没有 sources.json / 重载生命周期，
 * 它们的「启用 / 平台开关」只由本文件持久化，避免和社区脚本的状态纠缠。
 *
 * 默认 enabled=true：保持历史行为（汽水/B站此前一直参与搜索与取链），
 * 仅在用户从设置页手动关闭后才翻成 false。
 */
import * as fs from 'fs'
import * as path from 'path'

const STATE_FILE = 'extra-sources-state.json'

export interface ExtraSourceState {
  enabled: boolean
  disabledSources: string[]
}

function statePath(): string {
  const base = process.env.DATA_PATH || path.join(process.cwd(), 'data')
  return path.join(base, STATE_FILE)
}

function readAll(): Record<string, ExtraSourceState> {
  try {
    const p = statePath()
    if (!fs.existsSync(p)) return {}
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return raw && typeof raw === 'object' ? (raw as Record<string, ExtraSourceState>) : {}
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, ExtraSourceState>): void {
  const p = statePath()
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(p, JSON.stringify(map, null, 2), 'utf-8')
}

export function getExtraSourceState(id: string): ExtraSourceState {
  const all = readAll()
  return all[id] || { enabled: true, disabledSources: [] }
}

export function setExtraSourceEnabled(id: string, enabled: boolean): void {
  const all = readAll()
  const cur = all[id] || { enabled: true, disabledSources: [] }
  all[id] = { ...cur, enabled }
  writeAll(all)
}

export function setExtraSourceDisabledSources(id: string, disabledSources: string[]): void {
  const all = readAll()
  const cur = all[id] || { enabled: true, disabledSources: [] }
  all[id] = { ...cur, disabledSources: Array.isArray(disabledSources) ? disabledSources : [] }
  writeAll(all)
}

/**
 * 该额外音源当前是否参与搜索 / 取链 / 巡检。
 * enabled=false 或平台开关里包含自身 id（单平台音源关掉即整体停用）都为非激活。
 */
export function isExtraSourceActive(id: string): boolean {
  const s = getExtraSourceState(id)
  if (s.enabled === false) return false
  if (Array.isArray(s.disabledSources) && s.disabledSources.includes(id)) return false
  return true
}
