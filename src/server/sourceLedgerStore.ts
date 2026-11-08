/**
 * 播放侧四份内存账本的落盘/恢复。
 *
 * 为什么要有它：`playRank`（源的历史耗时）、`playSink`（近期失败沉底）、
 * `cooldown`（回源超时冷却）和 `qualityLedger`（某档必败短路）原本全在内存，
 * **进程一重启就清零**。而「重启」在真实使用里一点都不罕见：换版本、容器自愈、
 * NAS 重启、改配置。实测（2026-11-08，17952）：
 *
 *   重启后第 1 次取链 5320ms（order.json 排第一的裤佬 5 秒超时 → 换墨澜）
 *   第 2 次 201ms、第 3 次 111ms（已经学会墨澜更快）
 *
 * 也就是说，每次重启用户都要重新踩一遍同样的坑。这里把「还新鲜」的账本存到
 * `data/source-ledger.json`，启动时读回来，重启后第一次取链就能直接用上次的结论。
 *
 * 三条克制的设计：
 *  - **只存新鲜的**：playRank 6 小时、沉底 15 分钟、冷却仅未过期的，过期数据
 *    不只是没用，还会拿昨天的慢拖住今天；
 *  - **脏标记 + 15 秒合并落盘**：每次取链都会记账，直接写盘会把 IO 打满；
 *  - **读失败一律当没有**：文件损坏/权限问题只让账本从零开始学，绝不影响启动。
 */
import fs from 'fs'
import path from 'path'

import { exportPlayRankState, importPlayRankState } from './sourcePlayRank'
import { exportQualityLedgerState, importQualityLedgerState } from './sourceQualityLedger'
import { exportPlaySinkState, importPlaySinkState } from './userApi'
import { takeLedgerDirty } from './sourceLedgerDirty'

const FILE_NAME = 'source-ledger.json'
const SAVE_INTERVAL_MS = 15 * 1000

let dataPath = ''
let timer: any = null

const filePath = (): string => (dataPath ? path.join(dataPath, FILE_NAME) : '')

/** 启动时调用：读回账本并开始定时落盘。可重复调用（会重建定时器） */
export const startSourceLedgerPersist = (dir: string): void => {
    dataPath = dir || ''
    if (!dataPath) return
    loadOnce()
    if (timer) clearInterval(timer)
    timer = setInterval(() => { flushSourceLedgers() }, SAVE_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
}

const loadOnce = (): void => {
    const file = filePath()
    if (!file) return
    try {
        if (!fs.existsSync(file)) return
        const raw = fs.readFileSync(file, 'utf-8')
        if (!raw) return
        const data = JSON.parse(raw)
        const rank = importPlayRankState(data.playRank)
        const sink = importPlaySinkState(data.playSink)
        const quality = importQualityLedgerState(data.quality)
        takeLedgerDirty()
        if (rank || sink || quality) {
            console.log(`[账本] 已恢复上次的学习结果：排序 ${rank} 条 / 沉底与冷却 ${sink} 条 / 档位短路 ${quality} 条（重启后首播不必重新踩坑）`)
        }
    } catch (e: any) {
        console.log(`[账本] 恢复失败（不影响启动，从零开始学）：${e?.message || e}`)
    }
}

/** 有变更就把四份账本写盘（脏标记为空时直接返回，正常请求路径零开销） */
export const flushSourceLedgers = (): boolean => {
    if (!takeLedgerDirty()) return false
    const file = filePath()
    if (!file) return false
    try {
        const payload = JSON.stringify({
            v: 1,
            savedAt: new Date().toISOString(),
            playRank: exportPlayRankState(),
            playSink: exportPlaySinkState(),
            quality: exportQualityLedgerState(),
        })
        const tmp = file + '.tmp'
        fs.writeFileSync(tmp, payload, 'utf-8')
        fs.renameSync(tmp, file)
        return true
    } catch (e: any) {
        console.log(`[账本] 落盘失败（下次再试）：${e?.message || e}`)
        return false
    }
}

/** 单测用：清掉路径与定时器 */
export const __resetSourceLedgerPersist = (): void => {
    if (timer) clearInterval(timer)
    timer = null
    dataPath = ''
}
