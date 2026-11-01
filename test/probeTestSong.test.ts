/**
 * 巡检测试曲目净化的单元测试。
 *
 * 背景（246 实测）：kg 平台 28 个源巡检只有 2 个可用，而同曲目按源逐测能出链 9 个。
 * 差异来自曲目本身不是源脚本能吃的形态：
 *
 * 1. 缓存索引里的 songmid 是 `kg_205496462`（source_songmid），源脚本要纯 ID。
 *    正常取链（server.ts）和歌词抓取都剥过前缀，只有巡检没剥 —— 于是每个平台
 *    都在探测时写成「歌曲ID不存在」。
 * 2. kg 的主键是 32 位文件 hash，缓存索引只存 audio_id、根本没有 hash 字段，
 *    原样发给源只会得到「缺少 songmid 或 hash」。
 *
 * 更隐蔽的是第 2 点的连带效应：池里「有但不合格」让 pickTestSongs 认为该平台已有曲目，
 * 永远走不到兜底搜索（内置搜索返回的曲目是带 hash 的），于是 kg 整轮全灭、必被误禁。
 */
import test from 'node:test'
import assert from 'node:assert'
import { sanitizeTestSong } from '../src/server/sourceProbe'
import defaultConfig from '../src/defaultConfig'

const HASH = 'B3A52A7A958BF0AED0EBFBA2E9A818B7'

test('剥平台前缀：缓存索引里的 kg_205496462 要还原成源脚本认的纯 ID', () => {
    // 非 kg 平台不会被丢弃，正好用来单独观察剥前缀
    const got = sanitizeTestSong({ source: 'wy', songmid: 'wy_186016', name: '晴天', singer: '周杰伦' })
    assert.ok(got)
    assert.equal(got!.songmid, '186016')
    // 本来就没前缀的不能动
    assert.equal(sanitizeTestSong({ source: 'wy', songmid: '186016' })!.songmid, '186016')
    // 只剥自己的前缀，别的平台前缀不能误伤
    assert.equal(sanitizeTestSong({ source: 'wy', songmid: 'kg_186016' })!.songmid, 'kg_186016')
})

test('kg 的缓存曲目（audio_id + 无 hash）必须丢弃，否则池里「有但不合格」会挡住兜底搜索', () => {
    assert.equal(sanitizeTestSong({ source: 'kg', songmid: 'kg_205496462', name: '木偶', singer: '李昂星', interval: '04:04' }), null)
    assert.equal(sanitizeTestSong({ source: 'kg', songmid: '205496462', name: '木偶', singer: '李昂星' }), null)
    // hash 是空串也按缺失处理
    assert.equal(sanitizeTestSong({ source: 'kg', songmid: '205496462', hash: '' }), null)
})

test('kg 的合格曲目：songmid 或 hash 任一为 32 位 hex 即可，并保证 hash 一定带上', () => {
    // 形态 A：songmid 就是 hash（不少源直接拿 songmid 当文件 hash 用）
    const a = sanitizeTestSong({ source: 'kg', songmid: HASH, name: '晴天', singer: '周杰伦' })
    assert.ok(a)
    assert.equal(a!.hash, HASH, '读 hash 字段的源也要能拿到')

    // 形态 B：songmid 是 audio_id，hash 单独给
    const b = sanitizeTestSong({ source: 'kg', songmid: '20505418', hash: HASH, name: '晴天', singer: '周杰伦' })
    assert.ok(b)
    assert.equal(b!.songmid, '20505418')
    assert.equal(b!.hash, HASH)

    // 大小写 hex 都算合法，长度不对的必须否掉（32 位是 kg 的硬约束）
    assert.ok(sanitizeTestSong({ source: 'kg', songmid: HASH.toLowerCase() }))
    assert.equal(sanitizeTestSong({ source: 'kg', songmid: '20505418', hash: 'B3A52A7A' }), null)
})

test('非 kg 平台不做 hash 强制：缺 hash 照常保留，别把能用的曲目误杀', () => {
    const got = sanitizeTestSong({ source: 'kw', songmid: 'kw_228908', name: '晴天', singer: '周杰伦', interval: '04:29' })
    assert.ok(got)
    assert.equal(got!.songmid, '228908')
    assert.equal(got!.hash, undefined, '没给 hash 就不该凭空造一个空字符串')
})

test('空值守卫：缺 source / songmid 一律返回 null', () => {
    assert.equal(sanitizeTestSong({ source: '', songmid: '1' } as any), null)
    assert.equal(sanitizeTestSong({ source: 'kg', songmid: '' } as any), null)
    assert.equal(sanitizeTestSong({ source: 'kg', songmid: 'kg_' } as any), null)
})

test('默认配置里的 kg 测试曲目本身必须能通过净化（否则等于没配）', () => {
    const songs: any = (defaultConfig as any)['customSource.probe.testSongs']
    assert.ok(songs && songs.kg, '默认配置应带 kg 测试曲目')
    const got = sanitizeTestSong({ source: 'kg', ...songs.kg })
    assert.ok(got, '默认 kg 曲目必须合格')
    assert.match(got!.hash as string, /^[0-9A-Fa-f]{32}$/)
    assert.equal(got!.name, '晴天')
    assert.equal(got!.singer, '周杰伦')
})
