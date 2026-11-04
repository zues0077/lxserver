/**
 * 音源回收站：把被删除（手动删除 / 巡检自动移除）的脚本文件挪进 `.trash/`，
 * 并落一份 `.meta.json` 保存它在 `sources.json` 里的原始条目 —— 否则「可恢复」只是句空话：
 * 脚本回来了、元数据（名称/作者/平台/启用态）全丢了，用户还得重新上传配置。
 *
 * 单独成文件是为了避开循环依赖：
 * `customSourceHandlers` 已经 import 了 `sourceProbe`，两边都要用回收站，
 * 只能把公共逻辑下沉到这里。
 */

import * as fs from 'fs'
import * as path from 'path'

const TRASH_DIR = '.trash'
/** 新文件名格式：`<stamp>__<sourceId>`，`__` 作为分隔符（sourceId 自己可能含单个下划线） */
const NEW_SEP = '__'

const dataPath = () => (global.lx && (global.lx as any).dataPath) || process.env.DATA_PATH || path.join(process.cwd(), 'data')
const sourceRoot = () => path.join(dataPath(), 'users', 'source')
const ownerDirName = (owner: string) => (owner === 'open' ? '_open' : owner)

export const ownerDirOf = (owner: string) => path.join(sourceRoot(), ownerDirName(owner))
export const trashDirOf = (owner: string) => path.join(ownerDirOf(owner), TRASH_DIR)

/** 原条目 + 回收原因，一并落盘，恢复时原样写回 sources.json */
export interface TrashEntry {
    id: string
    name: string
    entry?: any
    trashedAt: string
    trashedBy: 'manual' | 'probe'
    reason?: string
    owner?: string
}

export interface TrashItem {
    file: string
    id: string
    name: string
    size: number
    trashedAt: string
    trashedBy: 'manual' | 'probe'
    reason?: string
    /** 老回收站文件（没有 meta）只能恢复脚本，元数据得重新解析 */
    hasMeta: boolean
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * 从回收站文件名里还原 sourceId。
 * 新格式 `<stamp>__<id>`；老格式（v1.5.5x 之前巡检写的）是 `<stamp>_<id>`，
 * 时间戳里没有下划线，所以第一个 `_` 就是分隔符。
 */
function idFromTrashFile(filename: string): string {
    const idx = filename.indexOf(NEW_SEP)
    if (idx > 0) return filename.slice(idx + NEW_SEP.length)
    const m = filename.match(/^\d{4}-\d{2}-\d{2}T[\d-]+_(.+)$/)
    if (m) return m[1]
    return filename
}

/** 读 sources.json 里某个源的原条目（调用方没传 entry 时兜底用） */
function readEntryFromManifest(owner: string, sourceId: string): any {
    try {
        const metaPath = path.join(ownerDirOf(owner), 'sources.json')
        if (!fs.existsSync(metaPath)) return undefined
        const list = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        return Array.isArray(list) ? list.find((s: any) => s && s.id === sourceId) : undefined
    } catch {
        return undefined
    }
}

/**
 * 把脚本移入回收站。
 * @returns 落地后的脚本路径；文件不存在返回 null
 */
export function moveScriptToTrash(
    owner: string,
    sourceId: string,
    opts: { by: 'manual' | 'probe'; reason?: string; entry?: any } = { by: 'manual' },
): string | null {
    const dir = ownerDirOf(owner)
    const scriptPath = path.join(dir, sourceId)
    if (!fs.existsSync(scriptPath)) return null
    try {
        const trashDir = trashDirOf(owner)
        if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true })
        const base = `${stampNow()}${NEW_SEP}${sourceId}`
        const target = path.join(trashDir, base)
        fs.renameSync(scriptPath, target)

        // entry 兜底从 sources.json 读：调用方（巡检）手上只有 id 和名称，
        // 不读清单的话恢复出来的条目会缺作者/平台/启用态。
        const entry = opts.entry || readEntryFromManifest(owner, sourceId)
        const meta: TrashEntry = {
            id: sourceId,
            name: (entry && entry.name) || sourceId,
            entry,
            trashedAt: new Date().toISOString(),
            trashedBy: opts.by,
            reason: opts.reason,
            owner,
        }
        fs.writeFileSync(path.join(trashDir, `${base}.meta.json`), JSON.stringify(meta, null, 2), 'utf-8')
        return target
    } catch (e: any) {
        console.warn(`[回收站] 移入失败 (${owner}/${sourceId}): ${e?.message || e}`)
        return null
    }
}

/** 列出某个空间的回收站（按移入时间倒序） */
export function listTrash(owner: string): TrashItem[] {
    const trashDir = trashDirOf(owner)
    if (!fs.existsSync(trashDir)) return []
    const items: TrashItem[] = []
    let files: string[] = []
    try {
        files = fs.readdirSync(trashDir)
    } catch {
        return []
    }
    for (const f of files) {
        if (f.endsWith('.meta.json')) continue
        if (f.startsWith('.')) continue
        const full = path.join(trashDir, f)
        let stat: fs.Stats
        try {
            stat = fs.statSync(full)
        } catch {
            continue
        }
        if (!stat.isFile()) continue

        let meta: TrashEntry | null = null
        try {
            const metaPath = path.join(trashDir, `${f}.meta.json`)
            if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        } catch { /* 坏 meta 按老文件处理 */ }

        items.push({
            file: f,
            id: (meta && meta.id) || idFromTrashFile(f),
            name: (meta && meta.name) || idFromTrashFile(f),
            size: stat.size,
            // 老文件没有 meta，只能拿文件 mtime 当移入时间
            trashedAt: (meta && meta.trashedAt) || stat.mtime.toISOString(),
            trashedBy: (meta && meta.trashedBy) || 'probe',
            reason: meta ? meta.reason : undefined,
            hasMeta: !!meta,
        })
    }
    items.sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)))
    return items
}

/** 回收站文件名合法性：必须是 .trash 下的单层文件名，杜绝 `../` 穿越 */
export function resolveTrashFile(owner: string, file: string): string | null {
    if (!file || typeof file !== 'string') return null
    const base = path.basename(file)
    if (base !== file || base.endsWith('.meta.json') || base.startsWith('.')) return null
    const trashDir = trashDirOf(owner)
    const full = path.join(trashDir, base)
    if (path.dirname(full) !== path.resolve(trashDir) && path.dirname(full) !== trashDir) return null
    return fs.existsSync(full) ? full : null
}

/** 取回一个回收站条目：把脚本移回原位置，返回原条目元数据（调用方负责写 sources.json 并重载） */
export function takeFromTrash(owner: string, file: string): { id: string; scriptPath: string; entry?: any } | { error: string } {
    const full = resolveTrashFile(owner, file)
    if (!full) return { error: '文件不存在或路径非法' }
    const id = idFromTrashFile(file)
    let meta: TrashEntry | null = null
    try {
        const metaPath = `${full}.meta.json`
        if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    } catch { /* ignore */ }
    const realId = (meta && meta.id) || id

    const target = path.join(ownerDirOf(owner), realId)
    try {
        // 同名文件还在（用户又上传了一份），别覆盖：加时间后缀交给上层改名
        let finalTarget = target
        if (fs.existsSync(finalTarget)) {
            const stamp = stampNow()
            finalTarget = path.join(ownerDirOf(owner), `${realId}.${stamp}.js`)
        }
        const ownerDir = ownerDirOf(owner)
        if (!fs.existsSync(ownerDir)) fs.mkdirSync(ownerDir, { recursive: true })
        fs.renameSync(full, finalTarget)
        try { fs.unlinkSync(`${full}.meta.json`) } catch { /* 可能没有 */ }
        return { id: realId, scriptPath: finalTarget, entry: meta ? meta.entry : undefined }
    } catch (e: any) {
        return { error: e?.message || String(e) }
    }
}

/** 彻底删除：指定文件，或全部 */
export function purgeTrash(owner: string, file?: string): number {
    const trashDir = trashDirOf(owner)
    if (!fs.existsSync(trashDir)) return 0
    let removed = 0
    const kill = (p: string) => {
        try {
            if (fs.existsSync(p)) {
                fs.unlinkSync(p)
                return true
            }
        } catch { /* ignore */ }
        return false
    }
    if (file) {
        const full = resolveTrashFile(owner, file)
        if (!full) return 0
        if (kill(full)) removed++
        kill(`${full}.meta.json`)
        return removed
    }
    let files: string[] = []
    try {
        files = fs.readdirSync(trashDir)
    } catch {
        return 0
    }
    for (const f of files) {
        if (!kill(path.join(trashDir, f))) continue
        if (!f.endsWith('.meta.json')) removed++
    }
    return removed
}

/**
 * 清掉回收站里某个音源的全部副本。
 * 「直接删除」时用：用户明确说不要了，回收站再留着同一份旧备份只会让人困惑。
 */
export function removeTrashCopies(owner: string, sourceId: string): number {
    const trashDir = trashDirOf(owner)
    if (!fs.existsSync(trashDir)) return 0
    let removed = 0
    let files: string[] = []
    try {
        files = fs.readdirSync(trashDir)
    } catch {
        return 0
    }
    for (const f of files) {
        if (f.endsWith('.meta.json')) continue
        if (idFromTrashFile(f) !== sourceId) continue
        try {
            fs.unlinkSync(path.join(trashDir, f))
            removed++
        } catch { /* ignore */ }
        try {
            const meta = path.join(trashDir, `${f}.meta.json`)
            if (fs.existsSync(meta)) fs.unlinkSync(meta)
        } catch { /* ignore */ }
    }
    return removed
}
