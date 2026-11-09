/**
 * T13a · 换源日志语义化错误码（classifySwitchError）回归。
 *
 * 借 fuzz1og/mplayer#140「失败靠 catch→换源 + 语义化错误码」的思路，
 * 把换源 / 取链失败归类成机器可读的 code，写进换源日志前缀
 * （`[自定义源][CODE] 源名 失败: ...`）。本测试只覆盖「分类器本身」，
 * 不依赖真实网络；分类失败只影响日志可读性，绝不改变换源行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { classifySwitchError } from '../src/server/userApi'

test('透传 error 自带的 code（脚本/上游若带）', () => {
    assert.equal(classifySwitchError({ code: 'E_FAIL', message: '上游挂了' }), 'E_FAIL')
})

test('取链超时 → SWITCH_TIMEOUT', () => {
    assert.equal(classifySwitchError(new Error('音源 [xx] 取链超时（超过 5000ms 未返回）')), 'SWITCH_TIMEOUT')
})

test('429 / 限流 → RATE_LIMITED', () => {
    assert.equal(classifySwitchError(new Error('429 Too Many Requests')), 'RATE_LIMITED')
    assert.equal(classifySwitchError(new Error('请求过于频繁，请稍后再试')), 'RATE_LIMITED')
})

test('返回值不是可用链接 → INVALID_URL', () => {
    assert.equal(classifySwitchError(new Error('返回值不是可用链接：<html>...')), 'INVALID_URL')
})

test('URL 不可播放（404/403） → UNPLAYABLE', () => {
    assert.equal(classifySwitchError(new Error('链接不可播放，HTTP 404')), 'UNPLAYABLE')
    assert.equal(classifySwitchError(new Error('地址无效 403 Forbidden')), 'UNPLAYABLE')
})

test('无法归类的错误 → SCRIPT_ERROR（兜底，绝不抛）', () => {
    assert.equal(classifySwitchError(new Error('某个没见过的脚本异常')), 'SCRIPT_ERROR')
    assert.equal(classifySwitchError(undefined), 'SCRIPT_ERROR')
    assert.equal(classifySwitchError(null), 'SCRIPT_ERROR')
})

test('结构性 code 由调用方显式设上（NO_CANDIDATE / ALL_EXHAUSTED 不靠文本猜）', () => {
    // 这两个是代码路径主动标注的，分类器本身不产出，这里只确认它们不在关键词误判里
    const e1: any = new Error('未找到支持 xx 平台的自定义源')
    e1.code = 'NO_CANDIDATE'
    assert.equal(classifySwitchError(e1), 'NO_CANDIDATE')
    const e2: any = new Error('已尝试了 3 个支持 xx 平台的源，但全部解析失败')
    e2.code = 'ALL_EXHAUSTED'
    assert.equal(classifySwitchError(e2), 'ALL_EXHAUSTED')
})
