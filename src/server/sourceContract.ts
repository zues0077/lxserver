/**
 * 自定义源「宿主协议契约」自检。
 *
 * 背景：音源脚本是第三方代码，它在 `lx.send('inited', { sources })` 里声明的
 * 能力清单，就是它和宿主之间唯一的一份契约。此前这份契约**从来没有被校验过**：
 * 宿主只把 `sources` 原样存进 `info`，然后等真正取链时才发现「这个源声明了
 * 宿主不支持的动作」或「取链返回的是对象不是字符串」，此时用户已经点了歌，
 * 症状只剩一句「无链接」，排查要一路翻沙箱日志。
 *
 * 实测反例（豆包音源的禁用根因）：脚本头部自称合规，代码里却声明了
 * `actions: ['musicUrl', 'lyric', 'pic', ...]` 并让 `musicUrl` 返回对象。
 * 客户端只认非 local 平台的 `musicUrl`，于是整个源被判不可用 —— 而错误
 * 直到取链阶段才以「无链接」暴露，没有任何一处日志指向真正的原因。
 *
 * 因此这里做两件事：
 *
 *   1. **静态自检**（`inspectSourceContract`）：脚本刚 inited 就逐平台核对
 *      `actions` / `qualitys` / `name` / `type` 的形态，把「声明违规」变成
 *      一条**明确指向平台与字段**的日志与面板提示，而不是等到用户点歌失败。
 *   2. **运行时降级**（`unwrapMusicUrlValue`）：声明违规不必然等于源不能用。
 *      返回对象而非字符串的源，只要对象里有一个明确的 http 字段，就解包出来
 *      继续用，并记一次「降级」日志 —— 能播比合规更重要，但违规必须留痕。
 *
 * 设计上刻意不为「合规」而拒绝加载：契约自检只产出报告，处置权留给调用方
 * （上传接口提示、列表面板展示、加载时打日志）。真正的拦截仍然只有一处 ——
 * 取链阶段拿不到可用链接。
 */

/** 宿主支持的标准音质档。请求档位超出这四档时客户端无法回落到缓存槽 */
export const LX_STANDARD_QUALITIES = ['128k', '320k', 'flac', 'flac24bit'] as const

/**
 * 非 local 平台允许声明的动作。
 *
 * 客户端只在这些平台上调用 `musicUrl`；声明别的动作不会被满足，而部分客户端
 * 版本会因此把整个源判为协议不合规并禁用。所以「多声明」在这里是硬错误。
 */
export const ALLOWED_REMOTE_ACTIONS = ['musicUrl'] as const

/** local 平台的声明语义与在线平台不同，契约校验整体跳过 */
export const LOCAL_PLATFORM = 'local'

export type ContractSeverity = 'error' | 'warn' | 'info'

export interface ContractIssue {
    platform: string
    /** 机器可读的问题码，便于前端做图标/文案映射，也便于统计 */
    code: string
    severity: ContractSeverity
    detail: string
}

export interface PlatformContract {
    actions: string[]
    qualities: string[]
    /** 该平台没有任何 error 级问题 */
    ok: boolean
}

export interface ContractReport {
    /** 全源无 error 级问题 */
    compliant: boolean
    platformCount: number
    issues: ContractIssue[]
    counts: { error: number; warn: number; info: number }
    platforms: Record<string, PlatformContract>
}

const isPlainObject = (v: unknown): v is Record<string, any> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []

/**
 * 逐平台核对 `sources` 声明是否符合宿主协议。
 *
 * 纯函数，不读写任何全局状态，便于单测；调用方拿到的 `issues` 里每条都带
 * `platform` 与 `code`，可以直接拼进日志或面板。
 */
export const inspectSourceContract = (sources: unknown): ContractReport => {
    const issues: ContractIssue[] = []
    const platforms: Record<string, PlatformContract> = {}
    const add = (platform: string, code: string, severity: ContractSeverity, detail: string) => {
        issues.push({ platform, code, severity, detail })
    }

    if (!isPlainObject(sources)) {
        add('', 'sources_invalid', 'error', 'inited 里没有 sources 对象，脚本等于没有注册任何音源')
        return {
            compliant: false,
            platformCount: 0,
            issues,
            counts: { error: 1, warn: 0, info: 0 },
            platforms,
        }
    }

    const platformKeys = Object.keys(sources)
    if (platformKeys.length === 0) {
        add('', 'sources_empty', 'error', 'sources 是空对象，没有任何平台')
    }

    for (const platform of platformKeys) {
        const meta = (sources as Record<string, any>)[platform]
        if (!isPlainObject(meta)) {
            add(platform, 'source_not_object', 'error', `平台声明不是对象：${String(meta).slice(0, 40)}`)
            platforms[platform] = { actions: [], qualities: [], ok: false }
            continue
        }

        const actions = asStringArray(meta.actions)
        const qualities = asStringArray(meta.qualitys)
        let platformOk = true

        if (typeof meta.name !== 'string' || !meta.name.trim()) {
            add(platform, 'name_missing', 'warn', '缺少 name，面板里只能显示平台 id')
        }

        if (platform === LOCAL_PLATFORM) {
            add(platform, 'local_platform_skipped', 'info', 'local 平台声明语义不同，跳过 actions/qualitys 校验')
            platforms[platform] = { actions, qualities, ok: true }
            continue
        }

        if (meta.type !== undefined && meta.type !== 'music') {
            add(platform, 'type_not_music', 'warn', `type 声明为 ${String(meta.type)}，在线平台应为 music`)
        }

        // ---- actions：多声明是硬错误，少声明是运行期必然失败 ----
        if (meta.actions === undefined) {
            add(platform, 'actions_missing', 'warn', '未声明 actions，宿主按「只提供 musicUrl」处理')
        } else if (!Array.isArray(meta.actions)) {
            add(platform, 'actions_not_array', 'error', 'actions 不是数组')
            platformOk = false
        } else {
            const illegal = actions.filter(a => !(ALLOWED_REMOTE_ACTIONS as readonly string[]).includes(a))
            if (illegal.length > 0) {
                add(platform, 'unsupported_actions', 'error',
                    `在线平台只允许 [${ALLOWED_REMOTE_ACTIONS.join(', ')}]，声明了 ${illegal.join(', ')}`)
                platformOk = false
            }
            if (!actions.includes('musicUrl')) {
                add(platform, 'music_url_not_declared', 'error',
                    `actions 里没有 musicUrl${actions.length ? `（实际为 ${actions.join(', ')}）` : '（空数组）'}`)
                platformOk = false
            }
        }

        // ---- qualitys：未知档位属 warn（客户端会丢弃该档，但源仍可用）----
        if (meta.qualitys === undefined) {
            add(platform, 'qualitys_missing', 'warn', '未声明 qualitys，面板无法展示可用音质')
        } else if (!Array.isArray(meta.qualitys)) {
            add(platform, 'qualitys_not_array', 'warn', 'qualitys 不是数组')
        } else {
            const invalidItems = meta.qualitys.filter((q: unknown) => typeof q !== 'string' || !q)
            if (invalidItems.length > 0) {
                add(platform, 'qualitys_invalid_item', 'warn', 'qualitys 里有非字符串或空项')
            }
            if (qualities.length === 0) {
                add(platform, 'qualitys_empty', 'warn', 'qualitys 为空数组，客户端不会对该平台发起取链')
            } else {
                const unknown = qualities.filter(q => !(LX_STANDARD_QUALITIES as readonly string[]).includes(q))
                if (unknown.length > 0) {
                    add(platform, 'unknown_quality', 'warn',
                        `非标准音质档 ${unknown.join(', ')}（标准档：${LX_STANDARD_QUALITIES.join('/')}），客户端会丢弃`)
                }
            }
        }

        platforms[platform] = { actions, qualities, ok: platformOk }
    }

    const counts = {
        error: issues.filter(i => i.severity === 'error').length,
        warn: issues.filter(i => i.severity === 'warn').length,
        info: issues.filter(i => i.severity === 'info').length,
    }
    return {
        compliant: counts.error === 0,
        platformCount: platformKeys.length,
        issues,
        counts,
        platforms,
    }
}

/**
 * 按问题码做全量计数（丢弃 info）。
 *
 * 列表接口只回传前几条 issues（够看清是什么问题），前端要「按源聚合」时
 * 不能拿截断后的数组去数——否则 9 项会被数成 6 项。所以另给一份真值。
 */
export const summarizeContractByCode = (
    issues: ContractIssue[],
): { error: Record<string, number>; warn: Record<string, number> } => {
    const out: { error: Record<string, number>; warn: Record<string, number> } = { error: {}, warn: {} }
    for (const i of issues) {
        if (i.severity === 'info') continue
        const bucket = out[i.severity]
        bucket[i.code] = (bucket[i.code] || 0) + 1
    }
    return out
}

const SEVERITY_RANK: Record<ContractSeverity, number> = { error: 0, warn: 1, info: 2 }

/**
 * 按严重程度排序后截断——**必须先排序再截断**。
 *
 * 面板和上传回执都只展示前几条。若按脚本声明顺序原样切，一个平台上的多条
 * warn（缺 name、非标准音质档）就能把同一源里真正该看的 error 挤出列表，
 * 用户看到「契约 5 项」却全是可忽略的提示，等于没提示。
 */
export const prioritizeContractIssues = (issues: ContractIssue[], limit = 6): ContractIssue[] =>
    [...issues]
        .filter(i => i.severity !== 'info')
        .sort((a, b) => {
            const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
            return bySeverity !== 0 ? bySeverity : String(a.platform).localeCompare(String(b.platform))
        })
        .slice(0, limit)

/** 把报告压成一行给日志用；无问题时返回空串，调用方据此决定是否打日志 */export const summarizeContract = (report: ContractReport): string => {
    if (!report.issues.length) return ''
    const parts = report.issues
        .filter(i => i.severity !== 'info')
        .slice(0, 4)
        .map(i => `${i.platform || '-'}:${i.code}`)
    const extra = report.counts.error + report.counts.warn - parts.length
    return parts.join(' ') + (extra > 0 ? ` (+${extra})` : '')
}

export interface UnwrapResult {
    url: string
    /** 命中的字段路径（`url` / `data.url` …），用于日志说明是解包出来的 */
    path: string
    /** true = 原始值是对象，本次属于降级解包 */
    fromObject: boolean
}

/**
 * 从 `musicUrl` 的返回值里解出可播放链接。
 *
 * 宿主协议要求返回**字符串**；返回对象是「只在该源自家 App 生效的私有扩展」，
 * 正是豆包音源被禁用的根因之一。但用户能不能听歌比源写得规不规范更重要，
 * 所以这里按固定的字段白名单做一次保守解包：只认明确的 http(s) 值，
 * 认不出就算没有 —— 不做递归猜测，避免把 `{code:0}` 这类业务对象误当成链接。
 *
 * 返回 `null` 表示「这不是一个能用的链接」，调用方按原有逻辑判失败。
 */
export const unwrapMusicUrlValue = (raw: unknown): UnwrapResult | null => {
    const asUrl = (v: unknown): string => {
        if (typeof v !== 'string') return ''
        const s = v.trim()
        if (!s) return ''
        const lower = s.toLowerCase()
        return lower.startsWith('http://') || lower.startsWith('https://') ? s : ''
    }

    if (typeof raw === 'string') {
        const url = asUrl(raw)
        return url ? { url, path: '', fromObject: false } : null
    }
    if (!isPlainObject(raw)) return null

    const direct = ['url', 'musicUrl', 'link']
    for (const key of direct) {
        const url = asUrl((raw as any)[key])
        if (url) return { url, path: key, fromObject: true }
    }
    for (const key of ['data', 'result']) {
        const nested = (raw as any)[key]
        if (!isPlainObject(nested)) continue
        for (const inner of direct) {
            const url = asUrl((nested as any)[inner])
            if (url) return { url, path: `${key}.${inner}`, fromObject: true }
        }
    }
    return null
}
