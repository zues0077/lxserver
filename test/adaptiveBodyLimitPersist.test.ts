import test from 'node:test'
import assert from 'node:assert'
import { parsePersistedAdaptiveLimits } from '../src/server/userApi'

/**
 * 自适应响应体上限落盘/还原的回归用例（2026-11-13）。
 *
 * 背景：豆包定制[聚合音源] 的健康探测固定返回 4.26MB、脚本回调同步处理 8.3 秒。
 * 原实现只在内存里降闸 30 分钟，**每次重启都从 8MB 默认值重新学一遍**，
 * 于是每轮重启第一发必然再卡 8 秒（05:01 加载 → 05:02 卡 8387ms）。
 * 这里钉住三条底线：
 *  1. 落盘的上限要能还原，且 until 至少再活满一个 TTL（否则重启等于没落盘）
 *  2. 上限被夹在 [地板, 默认上限] 之间（手改文件不能把源阉死或放开）
 *  3. 过期太久的条目丢弃，避免一次偶发永久阉掉源
 */
const NOW = 1_800_000_000_000
const TTL = 24 * 60 * 60 * 1000
const FLOOR = 1024 * 1024
const MAX = 8 * 1024 * 1024

test('落盘记录能还原，until 至少续满一个 TTL', () => {
    const map = parsePersistedAdaptiveLimits({
        'open_豆包定制[聚合音源].js': {
            limit: 2.55 * 1024 * 1024, until: NOW + 1000, bytes: 4.26 * 1024 * 1024, cost: 8300,
        },
    }, NOW, TTL, FLOOR, MAX)
    const hit = map.get('open_豆包定制[聚合音源].js')
    assert.ok(hit, '记录必须还原')
    assert.equal(hit!.limit, Math.round(2.55 * 1024 * 1024))
    assert.equal(hit!.until, NOW + TTL, '剩余 1 秒的记录重启后要续满一个 TTL，否则等于没落盘')
    assert.equal(hit!.cost, 8300)
})

test('上限被夹在地板与默认上限之间', () => {
    const map = parsePersistedAdaptiveLimits({
        too_small: { limit: 1024, until: NOW + TTL },
        too_large: { limit: 999 * 1024 * 1024, until: NOW + TTL },
    }, NOW, TTL, FLOOR, MAX)
    assert.equal(map.get('too_small')!.limit, FLOOR, '低于地板要抬到地板，否则误伤正常请求')
    assert.equal(map.get('too_large')!.limit, MAX, '高于默认上限没有意义，要收回到默认值')
})

test('过期太久的记录丢弃，刚过期的仍保留', () => {
    const map = parsePersistedAdaptiveLimits({
        expired_long_ago: { limit: 2 * 1024 * 1024, until: NOW - 2 * TTL },
        just_expired: { limit: 2 * 1024 * 1024, until: NOW - 1000 },
    }, NOW, TTL, FLOOR, MAX)
    assert.equal(map.has('expired_long_ago'), false, '过期超过一个 TTL 的记录应丢弃')
    assert.ok(map.has('just_expired'), '刚过期的记录要保留并续期（重启后仍拦截）')
})

test('脏数据不炸：非对象 / 无 limit / 空 key', () => {
    const map = parsePersistedAdaptiveLimits({
        bad_null: null,
        bad_string: 'oops',
        no_limit: { until: NOW + TTL },
        zero_limit: { limit: 0, until: NOW + TTL },
        good: { limit: 3 * 1024 * 1024, until: NOW + TTL },
    }, NOW, TTL, FLOOR, MAX)
    assert.equal(map.size, 1)
    assert.ok(map.has('good'))
})

test('空/缺失输入返回空 Map（首次启动）', () => {
    assert.equal(parsePersistedAdaptiveLimits(null, NOW, TTL, FLOOR, MAX).size, 0)
    assert.equal(parsePersistedAdaptiveLimits(undefined, NOW, TTL, FLOOR, MAX).size, 0)
    assert.equal(parsePersistedAdaptiveLimits({}, NOW, TTL, FLOOR, MAX).size, 0)
})
