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
