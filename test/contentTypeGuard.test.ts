import { test } from 'node:test'
import assert from 'node:assert'
import { isTextualContentType } from '../src/server/userApi'
import { isHardFailure } from '../src/server/sourceProbe'

/**
 * 「取链成功但返回的是网页」判定回归。
 *
 * 背景（2026-11-05 实测）：自定义源「回避聚合」对拿不到的歌直接返回
 * `https://music.163.com/404`，那是网易的错误页，HTTP **200 + text/html**。
 * 旧的 verifyUrlPlayable 只看状态码，于是判「✓ 成功返回链接」→ 前端拉流拿到网页
 * → 播放失败 → 换源 → 又拿回同一条，死循环卡 00:00。
 *
 * 现在按 content-type 补一道：只认**明确是文本**的类型，二进制/缺失一律放行，
 * 避免误杀 content-type 不规范的正常音频直链。
 */

test('明确是网页/JSON/XML 的类型判为文本（不是音频）', () => {
    const textual = [
        'text/html',
        'text/html;charset=utf8',
        'text/html; charset=UTF-8',
        'application/json',
        'application/json;charset=utf-8',
        'text/xml',
        'application/xml',
    ]
    for (const t of textual) {
        assert.equal(isTextualContentType(t), true, `${t} 应判为文本`)
    }
})

test('音频/二进制/未知类型一律放行', () => {
    const playable = [
        'audio/mpeg',
        'audio/mp4',
        'audio/aac',
        'application/octet-stream',
        'binary/octet-stream',
        'text/plain', // 无扩展名的音频常被标这个，不能杀
        'video/mp4',
        '',
        undefined,
        null,
    ]
    for (const t of playable) {
        assert.equal(isTextualContentType(t), false, `${String(t)} 不应判为文本`)
    }
})

test('「返回的不是音频文件」属于音源硬故障，必须能进巡检账本', () => {
    // 只有进了 isHardFailure，reportPlayHardFailures 才会计数，
    // 连续多次后巡检才会自动关闭该源在该平台的解析
    assert.equal(isHardFailure('音源 [回避聚合] 返回的不是音频文件（content-type: text/html;charset=utf8）'), true)
})

test('超时/网络错误不算「不是音频」的硬故障误伤', () => {
    assert.equal(isHardFailure('音源 [X] 取链超时（超过 3000ms 未返回）'), false)
    assert.equal(isHardFailure('socket hang up'), true) // 这是硬故障
})
