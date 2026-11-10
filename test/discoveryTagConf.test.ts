import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTagConfSuccess, decodeEntities } from '../src/server/utils/discovery'

// 2026-11-09 本机 curl 实测 fcg_get_diss_tag_conf：
// HTTP 200 / code=0 / data.categories 6 组，分类名含 `R&#38;B`。
// 移植自上游 PR #468，回归用（4 轮深度检索 R1）。

test('isTagConfSuccess: code:0 与 code:200 都算成功（旧实现只认 200，导致流派恒空）', () => {
    assert.strictEqual(isTagConfSuccess({ code: 0, data: { categories: [] } }), true)
    assert.strictEqual(isTagConfSuccess({ code: 200 }), true)
})

test('isTagConfSuccess: 异常码 / 缺字段 / 字符串 "0" 一律不算成功', () => {
    for (const body of [{ code: 500 }, { code: -1 }, {}, null, undefined, { code: '0' }]) {
        assert.strictEqual(isTagConfSuccess(body), false, `body=${JSON.stringify(body)}`)
    }
})

test('decodeEntities: 数字实体解码（含 BMP 外码点）', () => {
    assert.strictEqual(decodeEntities('R&#38;B'), 'R&B')
    assert.strictEqual(decodeEntities('&#128512;'), '\u{1F600}')
    assert.strictEqual(decodeEntities('华语&#32;流行'), '华语 流行')
})

test('decodeEntities: 非法/越界码点保留原实体，不抛异常', () => {
    assert.strictEqual(decodeEntities('A&#999999999;B'), 'A&#999999999;B')
    assert.strictEqual(decodeEntities('A&#1114112;B'), 'A&#1114112;B')
})

test('decodeEntities: 普通文本与 null 输入不改写、不抛异常', () => {
    assert.strictEqual(decodeEntities('摇滚'), '摇滚')
    assert.strictEqual(decodeEntities(''), '')
    assert.strictEqual(decodeEntities(null as any), 'null')
})
