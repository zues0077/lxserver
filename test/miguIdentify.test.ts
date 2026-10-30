/**
 * 保存账号的「认号 / 不覆盖主账号」决策 —— 集成级单测（不走网络）
 *
 * 这条链上的错误都是**静默**的：认错号不会报错，只会把账号写进错误的那一条；
 * 认不出号也不会报错，只会把主账号整条覆盖掉 —— 用户就是这么丢过一次数据
 * （咪咕浏览器 Cookie 没有 userid → 一键同步把主账号顶掉）。
 *
 * 这里用「结构上认不出号」的 Cookie 走真实 saveAccount 分支，验证三种结果：
 *   1) 已有一个号 + 认不出新号  → 拒收（保护主账号）
 *   2) 一个号都没有 + 认不出   → 允许存（没有可保护的对象）
 *   3) 平台没有远程认号能力     → 保持老语义（覆盖主账号）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as store from '../src/server/musicAccount/store'
import { saveAccount } from '../src/server/musicAccount'

// store 首次调用时才确定数据目录，所以这里赋值来得及（与 musicAccountMulti 同一套做法）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-acc-ident-'))
process.env.DATA_PATH = tmpDir

/** 咪咕浏览器 Cookie 的真实形状：有登录字段，但**没有 userid** */
const MG_BROWSER_COOKIE = 'idmpauth=true@passport.migu.cn; pacmtoken=PK_OLD; migu-utoken-sessionid=SID1; mg_auth_sid=X'
/** 结构上就不像登录态（没有登录字段）→ resolveUid 直接短路，不会发请求 */
const MG_GUEST_COOKIE = 'guest_token=1; theme=dark'

test('咪咕：已有账号 + 这份 Cookie 认不出号 → 拒收，不覆盖主账号', async () => {
  store.removeCookie('mg')
  store.addCookie('mg', MG_BROWSER_COOKIE)
  const before = store.getCookie('mg')

  const r = await saveAccount('mg', MG_GUEST_COOKIE)
  assert.equal(r.success, false)
  assert.match(r.error || '', /没有返回用户信息/)
  // 关键断言：主账号的 Cookie 一个字都不能变
  assert.equal(store.getCookie('mg'), before)
  store.removeCookie('mg')
})

test('咪咕：一个账号都没有时不拦（没有可保护的对象，先存下来）', async () => {
  store.removeCookie('mg')
  const r = await saveAccount('mg', MG_GUEST_COOKIE)
  assert.equal(r.success, true)
  assert.equal(store.listAccountItems('mg').length, 1)
  store.removeCookie('mg')
})

test('网易：平台没有远程认号能力 → 保持老语义（覆盖主账号）', async () => {
  store.removeCookie('wy')
  store.addCookie('wy', 'MUSIC_U=old-session; __csrf=csrf1')
  const r = await saveAccount('wy', 'MUSIC_U=new-session; __csrf=csrf2')
  // 网易 MUSIC_U 每次登录都换值、平台也没有「问我是谁」的实现，
  // 认不出号就是认不出，这里必须保持「覆盖主账号」而不是被上面的保护逻辑误伤
  assert.equal(r.success, true)
  assert.equal(r.action, 'replaced')
  assert.match(store.getCookie('wy'), /MUSIC_U=new-session/)
  assert.equal(store.listAccountItems('wy').length, 1)
  store.removeCookie('wy')
})

test('显式「添加账号」时不受保护逻辑影响（用户说了算）', async () => {
  store.removeCookie('mg')
  store.addCookie('mg', MG_BROWSER_COOKIE)
  const r = await saveAccount('mg', MG_GUEST_COOKIE, { append: true })
  assert.equal(r.success, true)
  assert.equal(store.listAccountItems('mg').length, 2)
  // 追加的号不能抢主账号
  assert.match(store.getCookie('mg'), /pacmtoken=PK_OLD/)
  store.removeCookie('mg')
})

test('咪咕：只带会话字段、没有 pacmtoken → 结构校验通过但要当场提示', async () => {
  // `*utoken*` 会把 migu-utoken-sessionid 也算成登录字段，但那只是会话标记，
  // 接口只认 pacmtoken（缺了回 299999）。这种「看着像登录、其实取不到链」最坑，
  // 必须在保存时就提示出来。
  store.removeCookie('mg')
  const r = await saveAccount('mg', 'migu-utoken-sessionid=SID1; mg_auth_sid=X', { append: true })
  assert.equal(r.success, true)
  assert.ok((r.warnings || []).some(w => /pacmtoken/.test(w)), `应提示缺少 pacmtoken，实际：${JSON.stringify(r.warnings)}`)
  store.removeCookie('mg')
})

test('咪咕：完整 16 字段会话（含 pacmtoken）不应出现缺字段提示', async () => {
  // 字段名取自用户 2026-10-30 的扩展诊断实录（16 个，无 userid，带 LTToken/USessionID）
  const names = ['idmpauth', 'mg_auth_sid', 'mgAppH5CookieId', 'pacmtoken', 'task-session-id', 'cookieId',
    'mg_uem_user_id_6c837308eb2349da90f8649ea2386794', 'mg_uem_user_id_9fbe6599400e43a4a58700a822fd57f8',
    'migu-device-uuid', 'migu-utoken-sessionid', 'LTToken', 'mg_uem_user_id_2d1cc310579741c887839ac8351dd878',
    'mgnd_session_create', 'mgnd_session_id', 'mgnd_session_last_access', 'USessionID']
  const cookie = names.map((n, i) => `${n}=V${i}`).join('; ')
  store.removeCookie('mg')
  const r = await saveAccount('mg', cookie, { append: true })
  assert.equal(r.success, true)
  assert.equal(r.count, 16, '16 个字段一个都不能丢')
  assert.equal((r.warnings || []).length, 0, `不该有提示，实际：${JSON.stringify(r.warnings)}`)
  store.removeCookie('mg')
})
