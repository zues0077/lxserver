/**
 * 音频内容校验：判断「下载到/缓存里的音频」是不是用户点的那一首。
 *
 * 背景（1.5.26 实机复测）：音源对无效 ID 会返回一段「别的音频」或占位静音，
 * 服务端照收照落盘，之后每次点这首都命中脏缓存并返回成功——用户听到的是无关音频或静音。
 * 现场样本：`19s / 48kbps / 24kHz`（静音占位）、`3:53 / 320kbps`（串了别的歌）。
 *
 * 原则：只在「能可靠判定」时才拒绝。误杀正常音频会让用户点歌直接失败，
 * 比听到一段占位音更难解释，所以阈值一律取宽、判据一律要求「双重不匹配」。
 *
 * 这两个函数是纯函数、无副作用，抽到 utils 里便于单测（fileCache 依赖全局 config，难以单独加载）。
 */

/** 按「时长 / 码率 / 文件大小」判断音频是否明显不是这首歌 */
export const judgeAudioMismatch = (params: {
    expectedSec: number
    actualSec: number
    bitrate?: number
    sizeBytes?: number
}): string | null => {
    const expected = Math.max(0, Number(params.expectedSec) || 0)
    const actual = Math.max(0, Number(params.actualSec) || 0)
    const bitrate = Number(params.bitrate) || 0
    const size = Number(params.sizeBytes) || 0

    if (expected > 60 && actual > 0) {
        // 期望时长已知：沿用原有的试听片段判据
        if (actual < 60) return `音频过短 (${actual}s / 预期 ${expected}s)`
        if (actual < expected * 0.5) return `明显短于预期 (${actual}s / 预期 ${expected}s)`
        if (actual <= 90 && expected - actual > 45) return `疑似试听片段 (${actual}s / 预期 ${expected}s)`
        // 明显偏长（串成整张专辑/长混音）：只在差得离谱时拦，避免误杀正常的现场版/前奏差异
        if (actual - expected > Math.max(120, expected * 0.6)) return `时长与曲目严重不符 (${actual}s / 预期 ${expected}s)`
        return null
    }

    // 期望时长是短音频（铃声/儿歌/片段，<=60s）：判据换成相对比例，避免长曲阈值不适用后完全放行
    if (expected > 0 && expected <= 60 && actual > 0) {
        if (actual < expected * 0.5) return `明显短于预期 (${actual}s / 预期 ${expected}s)`
        if (actual > expected * 2 + 60) return `明显长于预期 (${actual}s / 预期 ${expected}s)`
        return null
    }

    // 期望时长未知（调用方没给 interval，/play 的兜底路径常见）：
    // 原来整段校验被跳过，脏文件直接落盘。这里改用绝对阈值兜底——正常音乐不会 <30s 或 <64kbps。
    if (expected === 0 && actual > 0) {
        if (actual < 30) return `音频过短，疑似占位音 (${actual}s)`
        if (bitrate > 0 && bitrate < 64) return `码率过低，疑似静音占位 (${bitrate}kbps)`
    }
    if (actual === 0 && size > 0 && size < 300 * 1024) {
        return `音频无法解析且文件过小 (${size} bytes)`
    }
    return null
}

/** 「mm:ss」/「hh:mm:ss」/ 纯秒数 → 秒；解析不出返回 0 */
export const parseIntervalSec = (value: unknown): number => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
    const text = String(value ?? '').trim()
    if (!text) return 0
    if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text))
    if (!/^\d{1,2}(:\d{1,2}){1,2}$/.test(text)) return 0
    let sec = 0
    for (const part of text.split(':')) sec = sec * 60 + Number(part)
    return sec > 0 ? sec : 0
}

const formatSec = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`

/**
 * 曲目名的「来源侧规范化」：只抹平大小写、空白与标点，**保留括号内容**。
 *
 * 不能复用 normalizeTag：它会把 `(Live)`、`(Remastered)` 整段剥掉，
 * 「父亲写的散文诗 (Live)」和「父亲写的散文诗」就会变成同一个名字，
 * 拿 live 版 5:18 的登记时长去否决 4:04 的专辑版，属于典型误杀。
 */
const normalizeOriginName = (value: unknown) => String(value || '')
    .toLowerCase()
    .replace(/[\s\-_/·,，.。!！?？'"“”‘’、:：;；&+()（）\[\]【】]/g, '')
    .trim()

const SINGER_PLACEHOLDERS = new Set(['', '无', '未知', '未知歌手', '暂无', '群星', 'unknown', 'n/a', 'na', 'null'])

/** 歌手是否同一人：允许「周杰伦」对上「周杰伦 Jay Chou」这类写法差异 */
const singerAlike = (a: string, b: string) => {
    if (!a || !b) return false
    if (a === b) return true
    if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true
    const setB = new Set(b.split(''))
    let hit = 0
    for (const ch of a.split('')) if (setB.has(ch)) hit++
    return hit / Math.max(1, Math.min(a.length, b.length)) >= 0.5
}

export interface OriginCandidate {
    name?: string
    singer?: string
    /** 音源登记的时长，形如 "04:04" */
    interval?: string | number
    songmid?: string | number
}

export interface OriginVerdict {
    verdict: 'ok' | 'suspect' | 'unknown'
    reason?: string
}

/**
 * 用「音源自己搜到的曲目」判断一份音频是不是用户点的那首。
 *
 * 为什么需要它（1.5.27 之后仍存在的两个盲区）：
 *  1. 源文件没有 ID3 标签时，judgeMetadataMismatch 无从比对；若长度又刚好接近（现场样本 3:53 vs 请求 4:04），
 *     judgeAudioMismatch 也不会触发——两条判据同时失效，脏缓存照样落盘。
 *  2. 存量脏缓存（1.5.27 之前写入）在命中路径上同样没有可用判据。
 *
 * 突破口：**音源拿到无效 ID 时走的是「按歌名模糊匹配兜底」**——它把请求歌名当关键词搜一遍，
 * 把搜到的那首歌的音频返回。实测 `这首歌一定不存在abcxyz / 查无此人` 的音源搜索结果 top1 是
 * 《世界上不存在的歌 - 陈奕迅》03:53，而当时落盘的音频正好是 233s(3:53)。也就是说
 * 「放的是谁的歌」音源自己知道，问一句就能拿到。
 *
 * 三态判据（越往后越保守，宁可 unknown 也不误杀）：
 *  - ok      ：源侧登记了「同名同歌手」的版本，其中任一版本时长与音频吻合
 *  - suspect ：① 同名同歌手版本的登记时长全都对不上；或 ② 源侧根本没有这个歌名，
 *              而音频时长正好等于它模糊匹配到的头部候选（±3s）且与请求时长已有明显偏差
 *  - unknown ：搜不到、信息不足、或只有「同名不同歌手」的候选（翻唱/译名差异太常见）
 */
export const judgeOriginMismatch = (params: {
    requestName: unknown
    requestSinger?: unknown
    /** 请求方声明的时长（秒），0 表示未知 */
    expectedSec?: number
    /** 音频文件的真实时长（秒） */
    actualSec: number
    candidates: OriginCandidate[]
    /** 只看前 N 条候选做「别曲吻合」判断，默认 3 */
    topN?: number
}): OriginVerdict => {
    const reqName = normalizeOriginName(params.requestName)
    const reqSinger = normalizeOriginName(params.requestSinger)
    const expected = Math.max(0, Math.round(Number(params.expectedSec) || 0))
    const actual = Math.max(0, Math.round(Number(params.actualSec) || 0))
    const candidates = Array.isArray(params.candidates) ? params.candidates : []
    if (!reqName || actual <= 0 || !candidates.length) return { verdict: 'unknown' }

    // 阶段 A：源侧登记了同名同歌手的版本 → 拿它的时长当权威。
    // 同一首在源侧常有多个版本（海阔天空实测 03:59×2 + 05:26），只要有一个吻合就放行。
    const sameBoth = candidates.filter(item => {
        const candName = normalizeOriginName(item?.name)
        if (!candName || candName !== reqName) return false
        const candSinger = normalizeOriginName(item?.singer)
        if (!reqSinger || !candSinger || SINGER_PLACEHOLDERS.has(candSinger)) return true
        return singerAlike(reqSinger, candSinger)
    })
    if (sameBoth.length) {
        const registered = sameBoth.map(item => parseIntervalSec(item?.interval)).filter(sec => sec > 0)
        if (!registered.length) return { verdict: 'unknown' }
        const tolerance = (sec: number) => Math.max(15, Math.round(sec * 0.08))
        if (registered.some(sec => Math.abs(sec - actual) <= tolerance(sec))) return { verdict: 'ok' }
        const closest = registered.reduce((best, sec) => (
            Math.abs(sec - actual) < Math.abs(best - actual) ? sec : best
        ), registered[0])
        return {
            verdict: 'suspect',
            reason: `源侧登记的时长是 ${formatSec(closest)}，音频实际 ${formatSec(actual)}，不是同一版本`,
        }
    }

    // 阶段 B：源侧根本没有这个歌名 → 看音频是不是正好等于「它模糊匹配到的那首」。
    // 与请求歌名有包含关系的候选要排除：请求「不存在的歌」时 top1 是《世界上不存在的歌》，
    // 属于正常的相关结果，不能当成兜底证据。
    const head = candidates.slice(0, Math.max(1, params.topN ?? 3)).filter(item => {
        const candName = normalizeOriginName(item?.name)
        if (!candName || candName === reqName) return false
        return !candName.includes(reqName) && !reqName.includes(candName)
    })
    const drift = expected > 0 ? Math.abs(actual - expected) : Number.POSITIVE_INFINITY
    if (drift > 8) {
        for (const item of head) {
            const sec = parseIntervalSec(item?.interval)
            if (!sec || Math.abs(sec - actual) > 3) continue
            const shownSinger = item?.singer ? ` - ${String(item.singer).slice(0, 20)}` : ''
            return {
                verdict: 'suspect',
                reason: `音源按模糊匹配返回的其实是《${String(item?.name).slice(0, 40)}${shownSinger}》(${formatSec(sec)})，与请求的不是同一首`,
            }
        }
    }
    return { verdict: 'unknown' }
}

const normalizeTag = (value: unknown) => String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）|【[^】]*】/g, '')
    .replace(/(live|remix|remaster(ed)?|伴奏|纯音乐|cover|feat\.?.*|版)$/g, '')
    .replace(/[\s\-_/·,，.。!！?？'"“”‘’、:：;；&+]/g, '')
    .trim()

/**
 * 比对「源音频自带的标签」与「用户点的歌」是不是同一首。
 * 返回 null = 无法判断或匹配；返回字符串 = 不匹配原因。
 *
 * 这是唯一能识别「音源对无效 ID 返回另一首完整歌」的判据——那种音频时长看着正常、
 * 码率也正常（实测 3:53 / 320kbps），只靠时长/码率完全拦不住。
 *
 * 只在「双重不匹配」时才判定串歌：歌名和歌手都跟请求对不上。
 * 单边不匹配一律放行（换平台的曲名常带后缀、翻唱版歌手写法不同），避免误杀。
 * 源文件没有标签时返回 null（无从判断），保持旧行为。
 */
export const judgeMetadataMismatch = (
    requestName: unknown,
    requestSinger: unknown,
    tagTitle: unknown,
    tagArtist: unknown,
): string | null => {
    const reqName = normalizeTag(requestName)
    const reqSinger = normalizeTag(requestSinger)
    const srcName = normalizeTag(tagTitle)
    const srcSinger = normalizeTag(tagArtist)
    if (!reqName || !srcName) return null

    const alike = (a: string, b: string) => {
        if (!a || !b) return true // 缺一边就不作为否决依据
        if (a === b) return true
        if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true
        // 字符重叠率兜底：中文歌名常有一两个字差异（繁简/译名）
        const setB = new Set(b.split(''))
        let hit = 0
        for (const ch of a.split('')) if (setB.has(ch)) hit++
        return hit / Math.max(1, Math.min(a.length, b.length)) >= 0.5
    }

    const nameOk = alike(reqName, srcName)
    const singerOk = !reqSinger || !srcSinger ? true : alike(reqSinger, srcSinger)
    if (nameOk || singerOk) return null
    const shownTitle = String(tagTitle).slice(0, 40)
    const shownSinger = tagArtist ? ` - ${String(tagArtist).slice(0, 20)}` : ''
    return `音源返回的是另一首歌（标签「${shownTitle}${shownSinger}」，请求「${String(requestName).slice(0, 40)}」）`
}
