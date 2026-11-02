/**
 * 酷狗概念版「每日领取账本」。
 *
 * 需求来源（用户 2026-11-02）：领取是凌晨 6 点起由定时任务一轮轮跑完的，那时候没人看界面。
 * 第二天想知道「昨天这批号到底给我加了多久会员」，现在只能去翻 stdout 日志里的
 * `概念版自动补领｜xx：获得 N 小时`。这里把结果按天落盘，面板第二天直接给出汇总。
 *
 * 为什么必须落盘：领取发生在凌晨，容器换版/重启在白天很常见，只放内存就丢了。
 * 为什么单独一个文件：账号主存储是加密的 Cookie 库，领取记录只是统计，混进去会让
 * 读写路径都变重（每次领取都要解密改写整份账号文件）。
 *
 * 存储：<DATA_PATH>/kglite-claim-ledger.json，只保留最近 KEEP_DAYS 天。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getMusicAccountDataDir } from './store'

const LEDGER_FILE = 'kglite-claim-ledger.json'
/** 保留天数：够看一周趋势，也不会把文件养大 */
const KEEP_DAYS = 14

export interface LedgerAccountEntry {
    id: string
    label: string
    /** 当天该账号累计新增的小时数 */
    gainedHours: number
    /** 当天最后一次领取后的剩余时长（小时），拿不到就不写 */
    remainHours?: number
    /** 当天成功领取的次数（一次「连领」算一轮） */
    rounds: number
}

export interface LedgerDay {
    /** YYYY-MM-DD（本机时区） */
    date: string
    accounts: LedgerAccountEntry[]
    /** 当天合计新增小时数 */
    totalHours: number
    /** 当天最后一条记录的时刻（毫秒） */
    updatedAt: number
}

interface LedgerFile {
    version: number
    days: Record<string, LedgerDay>
}

const EMPTY: LedgerFile = { version: 1, days: {} }

/** 本地时区的 YYYY-MM-DD：不能用 toISOString，那是 UTC，凌晨 0~8 点会差一天 */
export function dayKey(d: Date = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function ledgerPath(): string {
    return path.join(getMusicAccountDataDir(), LEDGER_FILE)
}

function readLedger(): LedgerFile {
    const file = ledgerPath()
    if (!fs.existsSync(file)) return { ...EMPTY, days: {} }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
        if (!parsed || typeof parsed !== 'object' || !parsed.days) return { ...EMPTY, days: {} }
        return { version: 1, days: parsed.days as Record<string, LedgerDay> }
    } catch {
        // 文件损坏就当没有：账本只是提示用，绝不能因为它让领取/面板挂掉
        return { ...EMPTY, days: {} }
    }
}

function writeLedger(data: LedgerFile): void {
    const file = ledgerPath()
    try {
        // 先写临时文件再 rename：NAS 上偶发断电/强杀时不会留下半截 JSON
        const tmp = `${file}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
        fs.renameSync(tmp, file)
    } catch (e: any) {
        console.log(`[平台账号] 概念版领取账本写入失败（忽略）：${e?.message || e}`)
    }
}

/** 丢掉过期日期，避免文件无限增长 */
function prune(data: LedgerFile): void {
    const keys = Object.keys(data.days).sort()
    if (keys.length <= KEEP_DAYS) return
    for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete data.days[k]
}

/**
 * 记一笔领取结果。
 *
 * 只在真的拿到时长时调用：gainedHours=0 的（额度已满 / 被风控 / 状态查询失败）
 * 不写账本，否则「昨日新增 0 小时」会把真正有意义的那天挤掉。
 */
export function recordKugouLiteClaim(input: {
    id: string
    label: string
    gainedHours: number
    remainHours?: number
}): void {
    const gained = Math.round((Number(input.gainedHours) || 0) * 100) / 100
    if (gained <= 0) return

    const data = readLedger()
    const key = dayKey()
    const day: LedgerDay = data.days[key] || { date: key, accounts: [], totalHours: 0, updatedAt: 0 }
    let entry = day.accounts.find(a => a.id === input.id)
    if (!entry) {
        entry = { id: input.id, label: input.label, gainedHours: 0, rounds: 0 }
        day.accounts.push(entry)
    }
    entry.label = input.label
    entry.gainedHours = Math.round((entry.gainedHours + gained) * 100) / 100
    entry.rounds += 1
    if (typeof input.remainHours === 'number') entry.remainHours = input.remainHours

    day.totalHours = Math.round(day.accounts.reduce((s, a) => s + a.gainedHours, 0) * 100) / 100
    day.updatedAt = Date.now()
    data.days[key] = day

    prune(data)
    writeLedger(data)
    console.log(`[平台账号] 概念版领取账本｜${input.label} 今日累计 +${gained} 小时（今天合计 ${day.totalHours} 小时）`)
}

export interface KugouLiteClaimReport {
    /** 今天（正在进行的这一天）的累计 */
    today: LedgerDay | null
    /** 昨天：面板「昨日新增会员 X 小时」用的就是它 */
    yesterday: LedgerDay | null
    /** 最近几天（含今天，按日期倒序），给面板留个趋势入口 */
    recent: LedgerDay[]
}

/** 取面板需要的账本视图（只读，不产生任何写入） */
export function getKugouLiteClaimReport(): KugouLiteClaimReport {
    const data = readLedger()
    const now = new Date()
    const todayK = dayKey(now)
    const y = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const yesterdayK = dayKey(y)
    const recent = Object.values(data.days)
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .slice(0, 7)
    return {
        today: data.days[todayK] || null,
        yesterday: data.days[yesterdayK] || null,
        recent,
    }
}
