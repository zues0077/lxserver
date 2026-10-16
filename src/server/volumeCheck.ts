/**
 * 持久化目录挂载自检（启动时执行一次）
 *
 * 背景（真实事故）：默认 `serverCacheLocation = root` 时，缓存与下载分别写在
 * `process.cwd()/cache` 与 `process.cwd()/music`（容器内即 `/server/cache`、`/server/music`），
 * 这两个路径**不在** data 卷里。若 docker-compose 只映射了 `/server/data`，文件会落到
 * 容器可写层：宿主机映射目录里看不到，一旦「下载」完成或容器重建，文件就永久消失。
 *
 * 另有一个**不受 `serverCacheLocation` 影响**的目录：封面缓存
 * （`fileCache.ts` 的 `getCoverCacheDir` 恒定用 `process.cwd()/cover_cache`）。
 * 也就是说，即便面板切到 data 缓存模式、只挂 `data`，封面图依然写在容器可写层。
 * 因此它**任何模式下都要检查**，不能跟着 cache/music 一起跳过。
 *
 * 这里在 HTTP 服务开始监听时检查这些目录是否位于独立挂载卷上，未挂载就打印醒目告警
 * 并给出可直接抄的 compose 片段。
 *
 * 判定方式：读 `/proc/self/mountinfo`，沿 `dir` 向上找最近的挂载点（**排除容器根 `/`**，
 * 那是可写层根，不具持久性）。非 Linux 或读不到 mountinfo 时（Windows / macOS 本地开发）
 * 直接静默跳过，绝不误报。
 */
import fs from 'node:fs'
import path from 'node:path'
import { syncLog } from '@/utils/log4js'

const MOUNTINFO_PATH = '/proc/self/mountinfo'

/** mountinfo 中的挂载路径会把空格等转义成 \040 /\011 /\012 /\134 */
const decodeMountPath = (p: string): string =>
    p
        .replace(/\\040/g, ' ')
        .replace(/\\011/g, '\t')
        .replace(/\\012/g, '\n')
        .replace(/\\134/g, '\\')

let cachedMountPoints: Set<string> | null | undefined

/** 读取挂载点集合；非 Linux 或读取失败返回 null（表示无法判断，调用方应跳过检查） */
function getMountPoints(): Set<string> | null {
    if (cachedMountPoints !== undefined) return cachedMountPoints
    try {
        const raw = fs.readFileSync(MOUNTINFO_PATH, 'utf8')
        const set = new Set<string>()
        for (const line of raw.split('\n')) {
            if (!line) continue
            // 格式：mountID parentID major:minor root mountPoint options ... - fstype source superOptions
            const parts = line.split(' ')
            if (parts.length < 5) continue
            const mp = decodeMountPath(parts[4])
            // 归一化：非根路径去掉尾部斜杠（mountinfo 一般是规范形式，这里防御性处理）
            set.add(mp.length > 1 ? mp.replace(/\/+$/, '') || '/' : mp)
        }
        cachedMountPoints = set
    } catch {
        cachedMountPoints = null
    }
    return cachedMountPoints
}

/**
 * dir 自身或其祖先中最近的挂载点（排除 `/`）；不在任何持久卷上则返回 null。
 * 导出是为了便于单测与其它模块复用判定逻辑。
 */
export function findPersistentVolume(dir: string, mounts: Set<string>): string | null {
    let cur = path.resolve(dir)
    // 排除文件系统根（Linux 的 `/`、Windows 的 `C:\`）——它是可写层的根，不具持久性
    const fsRoot = path.parse(cur).root
    while (cur && cur !== fsRoot && cur !== '.') {
        if (mounts.has(cur)) return cur
        const parent = path.dirname(cur)
        if (parent === cur) break
        cur = parent
    }
    return null
}

/**
 * 检查「缓存 / 下载 / 封面缓存」目录是否在持久卷上，必要时打印告警。
 *
 * - 非 Linux：静默返回（无法判断，宁可不说，也不误报）
 * - 全局 `serverCacheLocation` 已是 `data`：`cache`/`music` 都在 data 卷内，天然持久化，跳过这两项；
 *   但 `cover_cache` 恒定写在 cwd、不受该开关影响，**仍需检查**
 * - 其余情况：`process.cwd()/{cache,music,cover_cache}` 未挂载则告警
 */
export function checkPersistentVolumes(): void {
    const mounts = getMountPoints()
    if (!mounts) return

    const config = (global as any)?.lx?.config
    // 面板切到 data 模式后，缓存与下载都落进 data 卷，无需再单独检查；
    // 而封面缓存固定在 cwd，与这个开关无关，必须始终检查。
    const cacheInDataVol = !!config && config.serverCacheLocation === 'data'

    const cwd = process.cwd()
    const targets = [
        ...(cacheInDataVol ? [] : [
            { dir: path.join(cwd, 'cache'), label: '缓存', defaultValue: './cache', containerPath: '/server/cache' },
            { dir: path.join(cwd, 'music'), label: '下载', defaultValue: './music', containerPath: '/server/music' },
        ]),
        { dir: path.join(cwd, 'cover_cache'), label: '封面缓存', defaultValue: './cover_cache', containerPath: '/server/cover_cache' },
    ]

    const missing = targets.filter(t => !findPersistentVolume(t.dir, mounts))
    if (missing.length === 0) return

    const lines: string[] = []
    lines.push('⚠️  [挂载自检] 以下目录不在独立数据卷上，文件会写进容器可写层：')
    for (const m of missing) {
        lines.push(`     - ${m.dir}（${m.label}目录）`)
    }
    lines.push('    后果：宿主机映射目录里看不到这些文件，容器一旦重建即永久丢失。')
    lines.push('    修复：在 docker-compose 的 volumes 里补齐映射后重建容器，例如：')
    lines.push('      volumes:')
    lines.push('        - ./data:/server/data')
    for (const m of missing) {
        lines.push(`        - ${m.defaultValue}:${m.containerPath}`)
    }
    lines.push('    说明：`cache`/`music` 的提示在面板把「缓存位置」切到 data 模式后可忽略；')
    lines.push('          `cover_cache` 不受该开关影响（恒定写在容器 cwd），任何模式都需要单独挂载。')

    for (const line of lines) console.warn(line)
    try {
        syncLog.warn(lines.join('\n'))
    } catch {
        // log4js 尚未就绪时忽略，stdout 已经有告警
    }
}
