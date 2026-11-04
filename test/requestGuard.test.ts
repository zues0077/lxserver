import { test } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { checkLiteralTarget, classifyAddress, createGuardedLookup } from '../src/server/requestGuard'

/**
 * 自定义源出站护栏（requestGuard）回归。
 *
 * 背景：lx.request 曾经完全不做地址校验，源脚本能把容器当内网跳板
 * （246 实测 http://192.168.1.246:9527/health 直接 200/31KB）。
 */

test('IPv4 内网与保留网段全部识别', () => {
    const blocked = [
        '127.0.0.1', '127.255.255.254',
        '10.0.0.1', '10.255.255.255',
        '172.16.0.1', '172.31.255.255',
        '192.168.1.246', '192.168.0.1',
        '169.254.169.254', // 云 metadata
        '0.0.0.0', '100.64.0.1', // CGNAT
        '224.0.0.1', '255.255.255.255',
        '198.18.0.1', '192.0.0.1',
    ]
    for (const ip of blocked) {
        assert.ok(classifyAddress(ip), `${ip} 应被判为内网/保留`)
    }
})

test('公网 IPv4 不被误杀', () => {
    const allowed = ['8.8.8.8', '1.1.1.1', '223.5.5.5', '172.32.0.1', '192.169.0.1', '11.0.0.1']
    for (const ip of allowed) {
        assert.equal(classifyAddress(ip), null, `${ip} 不应被拦`)
    }
})

test('IPv6 私网/映射地址与展开写法都识别', () => {
    const blocked = [
        '::1', '0:0:0:0:0:0:0:1',
        '::', '::ffff:127.0.0.1', '::ffff:192.168.1.246',
        'fc00::1', 'fd12:3456::1',
        'fe80::1', 'febf::1',
        'ff02::1',
    ]
    for (const ip of blocked) {
        assert.ok(classifyAddress(ip), `${ip} 应被判为内网/保留`)
    }
    const allowed = ['2400:3200::1', '2606:4700::1111', '2001:4860:4860::8888']
    for (const ip of allowed) {
        assert.equal(classifyAddress(ip), null, `${ip} 不应被拦`)
    }
})

test('护栏 lookup 拦截字面量内网 IP（开关开启）', async () => {
    const lookup = createGuardedLookup(() => true)
    const err = await new Promise<any>(resolve => {
        lookup('127.0.0.1', {}, (e: any) => resolve(e))
    })
    assert.ok(err, '应该回传错误')
    assert.equal(err.code, 'EBLOCKEDPRIVATE')
    assert.match(String(err.message), /内网/)
})

test('开关关闭时退回原生解析（127.0.0.1 可解析）', async () => {
    const lookup = createGuardedLookup(() => false)
    const res = await new Promise<any>(resolve => {
        lookup('127.0.0.1', {}, (e: any, address: any, family: any) => resolve({ e, address, family }))
    })
    assert.equal(res.e, null)
    assert.equal(res.address, '127.0.0.1')
    assert.equal(res.family, 4)
})

test('all:true 时按数组形式回调（http.request 两种模式都要兼容）', async () => {
    const lookup = createGuardedLookup(() => false)
    const res = await new Promise<any>(resolve => {
        lookup('127.0.0.1', { all: true }, (e: any, addresses: any) => resolve({ e, addresses }))
    })
    assert.equal(res.e, null)
    assert.ok(Array.isArray(res.addresses))
    assert.equal(res.addresses[0].address, '127.0.0.1')
})

test('域名解析到本机同样被拦（防 DNS rebinding 的同一入口）', async () => {
    const lookup = createGuardedLookup(() => true)
    const err = await new Promise<any>(resolve => {
        lookup('localhost', {}, (e: any) => resolve(e))
    })
    // 某些环境 localhost 无解析结果，此时允许 ENOTFOUND；只要有解析就必须是拦截错误
    assert.ok(err)
    assert.ok(['EBLOCKEDPRIVATE', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code), `异常码 ${err.code}`)
})

test('请求前字面量预检：IP 写死的内网地址直接拒，域名放行交给 lookup', () => {
    assert.equal(checkLiteralTarget('http://127.0.0.1:9527/health').ok, false)
    assert.equal(checkLiteralTarget('http://192.168.1.246:8191/').ok, false)
    assert.equal(checkLiteralTarget('http://169.254.169.254/latest/meta-data/').ok, false)
    assert.equal(checkLiteralTarget('http://[::1]:9527/').ok, false)
    // 域名交给 lookup 阶段判定，这里必须放行（否则会把正常源全掐死）
    assert.equal(checkLiteralTarget('https://music.163.com/api/search').ok, true)
    assert.equal(checkLiteralTarget('http://8.8.8.8/').ok, true)
    // 非法 URL 不拦，交给 needle 自己去报错，保持改造前行为
    assert.equal(checkLiteralTarget('not-a-url').ok, true)
})

test('NAS 管理口 / 云元数据 / 局域网其它主机在 URL 层就被拦（不靠真去探测）', () => {
    // 报告里「未验证 169.254.169.254 与 NAS 5666 管理口」那两条，用护栏判定即可覆盖：
    // 真发请求只会在 NAS 管理口留探测记录，而拦截逻辑是否生效完全可以在本地断言。
    const blocked = [
        'http://192.168.1.246:5666/',            // fnOS NAS 管理口
        'http://192.168.1.246:5670/',            // trim 管理端口
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/', // 云 metadata
        'http://172.16.0.1/', 'http://10.1.2.3:8080/', 'http://192.168.0.10/',
        'http://[fe80::1]/', 'http://[fd00::1]:80/',
    ]
    for (const u of blocked) {
        const r = checkLiteralTarget(u)
        if (r.ok) assert.fail(`${u} 应被拦却放行了`)
        else assert.ok(r.reason, `${u} 应给出拦截原因`)
    }
    // 反例：公网 CDN 与域名不能被误伤（误伤会把所有音的取链全掐断）
    for (const u of ['https://music.163.com/', 'http://fs.youthandroid2.kugou.com/x.mp3', 'http://223.5.5.5/']) {
        assert.equal(checkLiteralTarget(u).ok, true, `${u} 不应被拦`)
    }
})

test('userApi 的 lx.request 与链接复核都挂了护栏', () => {
    const file = path.join(process.cwd(), 'src/server/userApi.ts')
    const src = fs.readFileSync(file, 'utf-8')
    assert.match(src, /import \{ checkLiteralTarget, createGuardedLookup, logBlocked \} from '\.\/requestGuard'/)
    // 两处 needle 调用（lx.request、verifyUrlPlayable）都必须带 lookup
    const hits = src.match(/lookup: privateNetLookup/g) || []
    assert.equal(hits.length, 2, `应有两处挂载，实际 ${hits.length}`)
    assert.match(src, /customSource\.blockPrivateNetwork/)
    // 每跳都先过字面量预检
    assert.match(src, /const blocked = checkLiteralTarget\(targetUrl\)/)
    // needle 的 follow_max 计数从 0 开始，传 0 仍会偷偷跟一跳，必须是 -1
    assert.match(src, /follow_max: -1/)
    assert.ok(!/follow_max: 0\s*\}/.test(src), 'follow_max 不能是 0')
})

test('隔离状态能出现在音源列表里（用户可见、可解除）', () => {
    const guardFile = path.join(process.cwd(), 'src/server/sourceGuard.ts')
    const guard = fs.readFileSync(guardFile, 'utf-8')
    assert.match(guard, /export function getIsolationFor/)
    const handler = fs.readFileSync(path.join(process.cwd(), 'src/server/customSourceHandlers.ts'), 'utf-8')
    assert.match(handler, /import \{[^}]*getIsolationFor[^}]*\} from '\.\/sourceGuard'/)
    assert.match(handler, /source\.isolated = \{/)
    const app = fs.readFileSync(path.join(process.cwd(), 'public/music/app.js'), 'utf-8')
    assert.match(app, /已隔离/, '前端应有「已隔离」标记')
    assert.match(app, /release/, '前端应能调 release 解除隔离')
    assert.match(app, /if \(action === 'release' \|\| \(action === 'trust' && reloadAfter\)\) await reloadSource\(id\)/, '解除隔离/信任后必须重新加载音源')
})

test('启用被隔离的源必须明确拒绝，不能返回假成功', () => {
    const handler = fs.readFileSync(path.join(process.cwd(), 'src/server/customSourceHandlers.ts'), 'utf-8')
    // 后端：启用前先查隔离记录，命中直接返回 isolated 标记
    assert.match(handler, /if \(enabled === true\) \{[\s\S]{0,400}?getIsolationFor/)
    assert.match(handler, /isolated: true/)
    // 前端：批量启用不能只看 response.ok —— 隔离源回的是 200 + success:false
    const app = fs.readFileSync(path.join(process.cwd(), 'public/music/app.js'), 'utf-8')
    const batch = app.slice(app.indexOf('async function batchSourceEnable'), app.indexOf('async function batchSourceDelete'))
    assert.match(batch, /data && data\.success/, '批量启用必须按 success 计数')
    assert.ok(!/if \(response\.ok\) successCount\+\+/.test(batch), '不能只看状态码就算成功')
    assert.match(batch, /isolated/, '被隔离的要单独统计并告知用户')
})

test('默认配置开启护栏', () => {
    const file = path.join(process.cwd(), 'src/defaultConfig.ts')
    const src = fs.readFileSync(file, 'utf-8')
    assert.match(src, /'customSource\.blockPrivateNetwork':\s*true/)
})
