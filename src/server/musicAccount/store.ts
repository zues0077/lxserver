/**
 * 平台账号（Cookie）存储
 *
 * 为什么不放 config.js：
 *   config.js 会被「本地配置备份」复制、也会被 WebDAV 同步到云端，
 *   Cookie 属于登录凭证，跟着配置一起上云等于把账号泄露出去。
 *   所以账号单独存一个文件，并做静态加密。
 *
 * 加密说明（务必如实理解，不要误以为是强安全保证）：
 *   密钥放在同目录下的隐藏文件里，能挡住「备份文件被打包带走」「误粘贴到群里」这类场景，
 *   但拿到服务器磁盘的人依然能解出来 —— 这是本机守护，不是防root。
 *
 * 多账号：
 *   同一个平台可以存多份登录态（典型是酷狗概念版，多个号各自做任务领 VIP）。
 *   其中一个标记成 primary（主账号），取链只走主账号；其余账号只参与验证与领 VIP。
 *   旧数据只有单个 `cookie` 字段，读取时会自动迁移成「一个主账号」的 items 结构，
 *   写回时同时保留 `cookie` 指向主账号，保证回退到旧版本仍能用。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { PLATFORMS, getPlatform } from './platforms'
import { classifyHealth } from './health'
import { extractAccountIdentity } from './identity'
import type { AccountHealth } from './health'

const FILE_VERSION = 1
const KEY_FILE = '.music-account-key'
const DATA_FILE = 'music-accounts.json'

export interface VerifyRecord {
  at: number
  ok: boolean
  isVip?: boolean
  message?: string
  nickname?: string
  /** 校验强度：online = 调了需登录接口；structural = 只核对了 Cookie 字段 */
  verified?: 'online' | 'structural'
}

export interface StoredAccountItem {
  /** 稳定 id，前端用它定位到具体账号 */
  id: string
  /** AES-256-GCM 密文，格式 iv:tag:ciphertext（hex） */
  cookie: string
  /** 用户可读的备注名（如「小号 A」），留空时界面按序号显示 */
  label?: string
  /** 主账号：取链只用它 */
  primary?: boolean
  /**
   * 账号身份：Cookie 里那个「不会变的用户 id」（酷狗 KugooID / 酷我 userid / B站 DedeUserID …）。
   * 扫码登录时用它判断「是同一个号就更新那一条，不是才新增」。
   * 老数据没有这个字段，第一次重新登录时会补上。
   */
  uid?: string
  /** Cookie 整体指纹（sha256 前 16 位），同一份 Cookie 再次导入时用来认领已有条目 */
  cookieHash?: string
  addedAt: number
  lastVerify?: VerifyRecord
}

export interface StoredAccount {
  /** 兼容旧结构：始终同步成主账号的密文（旧版本只认这个字段） */
  cookie?: string
  updatedAt: number
  /** 兼容旧结构：主账号的最近一次验证结果 */
  lastVerify?: VerifyRecord
  /** 多账号列表（新结构）；读取旧数据时会自动补出来 */
  items?: StoredAccountItem[]
}

interface StoreShape {
  version: number
  accounts: Record<string, StoredAccount>
}

/** 对外展示的单个账号（全部脱敏） */
export interface AccountItemView {
  id: string
  label: string
  primary: boolean
  configured: boolean
  cookieLength: number
  cookiePreview: string
  updatedAt: number | null
  lastVerify: VerifyRecord | null
  health: AccountHealth
  healthText: string
  ageHours: number | null
}

let cachedDir: string | null = null

function dataDir(): string {
  if (cachedDir) return cachedDir
  const dir = process.env.DATA_PATH || (global.lx?.dataPath) || path.join(process.cwd(), 'data')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  cachedDir = dir
  return dir
}

/** 读取（或首次生成）本机密钥。密钥文件与账号文件同目录。 */
function loadKey(): Buffer {
  const keyPath = path.join(dataDir(), KEY_FILE)
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf-8').trim()
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
  }
  const key = crypto.randomBytes(32)
  fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 })
  return key
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = String(payload || '').split(':')
  if (!ivHex || !tagHex || !dataHex) throw new Error('账号密文格式损坏')
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf-8')
}

function newItemId(): string {
  return `a${crypto.randomBytes(4).toString('hex')}`
}

function tryDecrypt(payload: string): string {
  try {
    return decrypt(payload)
  } catch {
    return ''
  }
}

/**
 * 旧字段与主账号打架时，以旧字段为准。
 *
 * 为什么会打架：升级到多账号版本后 `cookie` 是「主账号的镜像」，正常情况两者恒等。
 * 但如果中途把镜像回退成旧版本（旧版只认 `cookie` 字段、不认 items），
 * 用户在旧版里换了 Cookie，新结构里的主账号就成了一份过期副本。
 * 这里发现两者不一致就采纳旧字段 —— 旧版写完不会动 items，所以「不一致」只可能是它写的。
 */
function adoptLegacyCookie(acc: StoredAccount): void {
  if (!acc.cookie || !acc.items?.length) return
  const primary = acc.items.find(i => i.primary) || acc.items[0]
  if (!primary || acc.cookie === primary.cookie) return
  const legacy = tryDecrypt(acc.cookie)
  if (!legacy) return
  if (tryDecrypt(primary.cookie) === legacy) return
  primary.cookie = acc.cookie
  primary.addedAt = acc.updatedAt || Date.now()
  primary.lastVerify = acc.lastVerify ?? primary.lastVerify
}

/**
 * 把旧结构（单个 cookie）补成 items 结构。
 * 就地修改传入对象：读出来的数据只在本次操作里用，不会造成副作用扩散。
 */
function normalize(acc: StoredAccount | undefined): StoredAccount | undefined {
  if (!acc) return undefined
  if (Array.isArray(acc.items) && acc.items.length) {
    // 主账号有且只有一个：万一数据被手工改坏（多个 primary 或没有 primary），这里兜一次
    const primaries = acc.items.filter(i => i.primary)
    if (!primaries.length) acc.items[0].primary = true
    else if (primaries.length > 1) primaries.slice(1).forEach(i => { i.primary = false })
    adoptLegacyCookie(acc)
    return acc
  }
  if (!acc.cookie) return acc
  acc.items = [{
    id: 'default',
    cookie: acc.cookie,
    primary: true,
    addedAt: acc.updatedAt || Date.now(),
    lastVerify: acc.lastVerify,
  }]
  return acc
}

/** 主账号（没有标记时退回第一个） */
function primaryItem(acc: StoredAccount | undefined): StoredAccountItem | undefined {
  if (!acc?.items?.length) return undefined
  return acc.items.find(i => i.primary) || acc.items[0]
}

/** 写入时同步旧字段，保证回退到旧版本也能读到主账号 */
function syncLegacyFields(acc: StoredAccount): void {
  const first = primaryItem(acc)
  if (!first) return
  acc.cookie = first.cookie
  acc.lastVerify = first.lastVerify
  acc.updatedAt = first.addedAt
}

function readStore(): StoreShape {
  const file = path.join(dataDir(), DATA_FILE)
  if (!fs.existsSync(file)) return { version: FILE_VERSION, accounts: {} }
  let parsed: any
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (e: any) {
    console.error(`[平台账号] 账号文件解析失败，已按空账号处理：${e.message}`)
    return { version: FILE_VERSION, accounts: {} }
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.accounts) {
    return { version: FILE_VERSION, accounts: {} }
  }
  const shape: StoreShape = { version: parsed.version || FILE_VERSION, accounts: parsed.accounts }
  // 老数据里没有 uid / cookieHash（v1.5.47 之前存的号），读一次就补上。
  // 不补的后果很具体：用户重扫一个已存的号时认不出来，会被当成新号再追加一条重复的。
  try {
    if (backfillIdentities(shape)) writeStore(shape)
  } catch (e: any) {
    console.error(`[平台账号] 账号身份补全失败（忽略）：${e.message}`)
  }
  return shape
}

/** 进程内只补一次；补完就写回文件，之后 uid 一直在 */
let identityBackfilled = false
function backfillIdentities(shape: StoreShape): boolean {
  if (identityBackfilled) return false
  identityBackfilled = true
  let changed = false
  for (const [pid, acc] of Object.entries(shape.accounts)) {
    for (const it of acc.items || []) {
      if (!it.cookie || (it.uid && it.cookieHash)) continue
      const cookie = decryptSafe(pid, it.cookie)
      if (!cookie) continue
      const ident = extractAccountIdentity(pid, cookie)
      if (ident.uid) it.uid = ident.uid
      it.cookieHash = ident.cookieHash
      changed = true
    }
  }
  return changed
}

function writeStore(store: StoreShape): void {
  const file = path.join(dataDir(), DATA_FILE)
  for (const acc of Object.values(store.accounts)) syncLegacyFields(acc)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  fs.renameSync(tmp, file) // 原子替换，避免写一半断电导致文件损坏
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 无 chmod 语义，忽略 */ }
}

function preview(cookie: string): string {
  return cookie.length > 8 ? `${cookie.slice(0, 3)}…${cookie.slice(-3)}` : ''
}

function decryptSafe(id: string, payload: string): string {
  try {
    return decrypt(payload)
  } catch (e: any) {
    console.error(`[平台账号] ${id} 的 Cookie 解密失败：${e.message}`)
    return ''
  }
}

/**
 * 列出所有平台账号的「脱敏」信息，用于管理界面展示。
 * 平台级字段（configured / health …）按主账号算，另外给出 items 数组供多账号界面渲染。
 */
export function listAccounts(): Array<{
  id: string
  name: string
  short: string
  color: string
  configured: boolean
  cookieLength: number
  cookiePreview: string
  updatedAt: number | null
  lastVerify: VerifyRecord | null
  health: AccountHealth
  healthText: string
  ageHours: number | null
  qrLogins: Array<{ driver: string; label: string }>
  /** 该平台已配置的账号列表（至少 0 个，按添加顺序；主账号排在前面） */
  accounts: AccountItemView[]
  /**
   * 是否支持多账号。
   * 2026-10-29：从「只有概念版」放开到全部平台 —— 存储层 items 本来就是通用的，
   * 放开后每个平台都能存主号 + 若干冷备号（副号只做定期校验、绝不参与取链）。
   */
  multiAccount: boolean
  /** 该平台是否已开启「主号失效自动切到下一个可用号」 */
  autoSwitch: boolean
}> {
  const store = readStore()
  return PLATFORMS.map(p => {
    const acc = normalize(store.accounts[p.id])
    const items = acc?.items || []

    const views: AccountItemView[] = items.map((it, idx) => {
      const cookie = decryptSafe(p.id, it.cookie)
      const configured = cookie.trim().length > 0
      const hp = classifyHealth(configured, it.lastVerify ?? null)
      return {
        id: it.id,
        label: it.label || (it.primary ? '主账号' : `账号 ${idx + 1}`),
        primary: !!it.primary,
        configured,
        cookieLength: cookie.length,
        cookiePreview: preview(cookie),
        updatedAt: it.addedAt || null,
        lastVerify: it.lastVerify ?? null,
        health: hp.health,
        healthText: hp.text,
        ageHours: hp.ageHours,
      }
    }).sort((a, b) => Number(b.primary) - Number(a.primary))

    const first = views[0]
    return {
      id: p.id,
      name: p.name,
      short: p.short,
      color: p.color,
      configured: !!first?.configured,
      cookieLength: first?.cookieLength || 0,
      cookiePreview: first?.cookiePreview || '',
      updatedAt: first?.updatedAt ?? null,
      lastVerify: first?.lastVerify ?? null,
      health: first?.health || 'none',
      healthText: first?.healthText || '未配置',
      ageHours: first?.ageHours ?? null,
      qrLogins: p.qrLogins || [],
      accounts: views,
      multiAccount: true,
      autoSwitch: isAutoSwitchEnabled(p.id),
    }
  })
}

/**
 * 该平台是否开启了「主号失效自动切换」。
 * 默认关闭：多号之间来回漂移的代价比「某首歌播不了」更大，必须用户显式勾选才生效。
 */
export function isAutoSwitchEnabled(id: string): boolean {
  const map = global.lx?.config?.['musicAccount.autoSwitch']
  if (!map || typeof map !== 'object') return false
  return (map as Record<string, unknown>)[id] === true
}

/** 该平台所有账号的脱敏视图（供接口单独取用） */
export function listAccountItems(id: string): AccountItemView[] {
  const row = listAccounts().find(a => a.id === id)
  return row?.accounts || []
}

/**
 * 取某平台**主账号**的明文 Cookie（仅内存中使用，不要写日志）。
 * 取链只认主账号，避免多个号之间来回漂移导致播放失败。
 */
export function getCookie(id: string): string {
  const acc = normalize(readStore().accounts[id])
  const item = primaryItem(acc)
  if (!item?.cookie) return ''
  return decryptSafe(id, item.cookie)
}

/** 取某平台全部账号的明文 Cookie（领 VIP 时逐个执行） */
export function getCookies(id: string): Array<{ id: string; label: string; primary: boolean; cookie: string }> {
  const acc = normalize(readStore().accounts[id])
  return (acc?.items || []).map((it, idx) => ({
    id: it.id,
    label: it.label || (it.primary ? '主账号' : `账号 ${idx + 1}`),
    primary: !!it.primary,
    cookie: decryptSafe(id, it.cookie),
  })).filter(a => a.cookie.trim().length > 0)
}

/** 指定账号的明文 Cookie（找不到返回空串） */
export function getCookieOf(id: string, itemId: string): string {
  const acc = normalize(readStore().accounts[id])
  const item = (acc?.items || []).find(i => i.id === itemId)
  return item?.cookie ? decryptSafe(id, item.cookie) : ''
}

/**
 * 是否已为该平台配置了可用账号。
 * 只看「有没有」不看「能否解密」，避免因为密钥丢失让整条播放链路卡住。
 */
export function hasAccount(id: string): boolean {
  const acc = normalize(readStore().accounts[id])
  return !!(acc?.items || []).some(i => !!i.cookie)
}

/**
 * 写入某平台的主账号 Cookie（旧语义：整平台只留一个账号）。
 * 传空字符串等同于删除该平台全部账号。
 *
 * meta 里的 uid / cookieHash 会一并落到主账号条目上 —— 扫码走这个分支时
 * 也要记下身份，否则下次同号登录还是认不出来，会当成「没有身份信息」的老数据。
 */
export function setCookie(
  id: string,
  cookie: string,
  meta: { uid?: string; cookieHash?: string } = {},
): { success: boolean; error?: string } {
  if (!getPlatform(id)) return { success: false, error: `不支持的平台：${id}` }
  const store = readStore()
  if (!String(cookie || '').trim()) {
    delete store.accounts[id]
    writeStore(store)
    return { success: true }
  }
  const acc = normalize(store.accounts[id])
  const enc = encrypt(String(cookie).trim())
  if (acc && acc.items && acc.items.length) {
    const item = primaryItem(acc)!
    item.cookie = enc
    item.addedAt = Date.now()
    if (meta.uid) item.uid = meta.uid
    if (meta.cookieHash) item.cookieHash = meta.cookieHash
  } else {
    store.accounts[id] = {
      cookie: enc,
      updatedAt: Date.now(),
      items: [{
        id: newItemId(), cookie: enc, primary: true, addedAt: Date.now(),
        uid: meta.uid, cookieHash: meta.cookieHash,
      }],
    }
  }
  writeStore(store)
  return { success: true }
}

export interface AddAccountResult {
  success: boolean
  error?: string
  /** 新账号 id（更新已有账号时为被更新的 id） */
  itemId?: string
  /** 是否创建了新条目 */
  created?: boolean
  /** 该平台现有账号总数 */
  total?: number
  /** 命中已有条目的依据：itemId 指定 / uid 同号 / cookie 同一份 */
  matchedBy?: 'itemId' | 'uid' | 'cookie'
}

/**
 * 追加一个账号。
 *
 * @param opts.itemId 传入时视为「更新这个账号的 Cookie」，否则新建
 * @param opts.label  备注名
 * @param opts.primary 是否设为主账号（第一个账号自动成为主账号）
 * @param opts.uid   账号身份（平台的稳定用户 id）。给了就先按它认领已有条目
 * @param opts.cookieHash Cookie 整体指纹。给了就先按它认领已有条目
 */
export function addCookie(
  id: string,
  cookie: string,
  opts: { itemId?: string; label?: string; primary?: boolean; uid?: string; cookieHash?: string } = {},
): AddAccountResult {
  if (!getPlatform(id)) return { success: false, error: `不支持的平台：${id}` }
  const text = String(cookie || '').trim()
  if (!text) return { success: false, error: 'Cookie 内容为空' }

  const store = readStore()
  const acc = normalize(store.accounts[id])
  const enc = encrypt(text)

  if (!acc) {
    const itemId = newItemId()
    store.accounts[id] = {
      cookie: enc,
      updatedAt: Date.now(),
      items: [{
        id: itemId, cookie: enc, label: opts.label, primary: true, addedAt: Date.now(),
        uid: opts.uid, cookieHash: opts.cookieHash,
      }],
    }
    writeStore(store)
    return { success: true, itemId, created: true, total: 1 }
  }

  const items = acc.items || (acc.items = [])
  let target = opts.itemId ? items.find(i => i.id === opts.itemId) : undefined
  if (opts.itemId && !target) return { success: false, error: '要更新的账号不存在（可能已被删除）' }
  let matchedBy: AddAccountResult['matchedBy'] = target ? 'itemId' : undefined

  // 没显式指定要更新哪一条时，先按「这是哪个号」认领：
  // 同 uid = 同一个号重新登录 → 更新那一条，绝不新增（否则每重登一次就多一个冷备号）；
  // 同一份 Cookie 再次导入 → 也认领（覆盖老数据没有 uid 的情况）。
  if (!target && opts.uid) {
    target = items.find(i => i.uid && i.uid === opts.uid)
    if (target) matchedBy = 'uid'
  }
  if (!target && opts.cookieHash) {
    target = items.find(i => i.cookieHash && i.cookieHash === opts.cookieHash)
    if (target) matchedBy = 'cookie'
  }

  if (target) {
    target.cookie = enc
    target.addedAt = Date.now()
    if (opts.label !== undefined) target.label = opts.label
    // 兜底补身份：老数据第一次重新登录就顺手升级成带 uid 的条目
    if (opts.uid) target.uid = opts.uid
    if (opts.cookieHash) target.cookieHash = opts.cookieHash
    // 重新填了 Cookie 说明是新的登录态，旧的校验结果不再可信
    target.lastVerify = undefined
    if (opts.primary) items.forEach(i => { i.primary = i.id === target!.id })
    writeStore(store)
    return { success: true, itemId: target.id, created: false, total: items.length, matchedBy }
  }

  const itemId = newItemId()
  const isFirst = items.length === 0
  items.push({
    id: itemId,
    cookie: enc,
    label: opts.label,
    primary: isFirst || !!opts.primary,
    addedAt: Date.now(),
    uid: opts.uid,
    cookieHash: opts.cookieHash,
  })
  if (opts.primary || isFirst) items.forEach(i => { i.primary = i.id === itemId })
  writeStore(store)
  return { success: true, itemId, created: true, total: items.length }
}

/**
 * 按「账号身份」找已有条目：先 uid（同一个号），再 cookie 指纹（同一份 Cookie）。
 * 找不到返回 null —— 调用方据此决定「新增」还是「覆盖主账号」。
 */
export function findItemByIdentity(
  id: string,
  ident: { uid?: string; cookieHash?: string },
): { id: string; label: string; primary: boolean } | null {
  const store = readStore()
  const acc = normalize(store.accounts[id])
  const items = acc?.items || []
  const hit = (ident.uid ? items.find(i => i.uid && i.uid === ident.uid) : undefined)
    || (ident.cookieHash ? items.find(i => i.cookieHash && i.cookieHash === ident.cookieHash) : undefined)
  if (!hit) return null
  const idx = items.indexOf(hit)
  return {
    id: hit.id,
    label: hit.label || (hit.primary ? '主账号' : `账号 ${idx + 1}`),
    primary: !!hit.primary,
  }
}

/** 删除指定账号；删的是主账号时，自动把下一个提升为主账号 */
export function removeAccountItem(id: string, itemId: string): { success: boolean; error?: string } {
  if (!getPlatform(id)) return { success: false, error: `不支持的平台：${id}` }
  const store = readStore()
  const acc = normalize(store.accounts[id])
  if (!acc?.items?.length) return { success: false, error: '该平台没有账号' }
  const before = acc.items.length
  acc.items = acc.items.filter(i => i.id !== itemId)
  if (acc.items.length === before) return { success: false, error: '账号不存在' }
  if (!acc.items.length) {
    delete store.accounts[id]
  } else if (!acc.items.some(i => i.primary)) {
    acc.items[0].primary = true
  }
  writeStore(store)
  return { success: true }
}

/** 设为主账号（取链只走主账号） */
export function setPrimaryAccount(id: string, itemId: string): { success: boolean; error?: string } {
  if (!getPlatform(id)) return { success: false, error: `不支持的平台：${id}` }
  const store = readStore()
  const acc = normalize(store.accounts[id])
  if (!acc?.items?.length) return { success: false, error: '该平台没有账号' }
  if (!acc.items.some(i => i.id === itemId)) return { success: false, error: '账号不存在' }
  acc.items.forEach(i => { i.primary = i.id === itemId })
  writeStore(store)
  return { success: true }
}

/**
 * 改某个账号的备注名。
 *
 * 只动 label，不动 Cookie 与校验记录 —— 备注是给人看的标签，
 * 改它不应该让「上次校验结果」失效（否则用户改个名就看到一堆「未校验」）。
 * 传空字符串等于清空备注，界面会退回按序号显示。
 */
export function renameAccount(id: string, itemId: string, label: string): { success: boolean; error?: string } {
  if (!getPlatform(id)) return { success: false, error: `不支持的平台：${id}` }
  const store = readStore()
  const acc = normalize(store.accounts[id])
  if (!acc?.items?.length) return { success: false, error: '该平台没有账号' }
  const target = acc.items.find(i => i.id === itemId)
  if (!target) return { success: false, error: '账号不存在' }
  const text = String(label ?? '').trim().slice(0, 32)
  if (text) target.label = text
  else delete target.label
  writeStore(store)
  return { success: true }
}

/** 开关某平台的「主号失效自动切换」（写进配置文件，重启后仍生效） */
export function setAutoSwitchEnabled(id: string, on: boolean): { success: boolean; error?: string } {
  if (!getPlatform(id)) return { success: false, error: `不支持的平台：${id}` }
  const cfg = global.lx?.config
  if (!cfg) return { success: false, error: '配置尚未加载' }
  const prev = cfg['musicAccount.autoSwitch']
  const map: Record<string, boolean> = (prev && typeof prev === 'object') ? { ...(prev as Record<string, boolean>) } : {}
  if (on) map[id] = true
  else delete map[id]
  cfg['musicAccount.autoSwitch'] = map
  return { success: true }
}

/** 删除某平台全部账号 */
export function removeCookie(id: string): { success: boolean; error?: string } {  if (!getPlatform(id)) return { success: false, error: `不支持的平台：${id}` }
  const store = readStore()
  delete store.accounts[id]
  writeStore(store)
  return { success: true }
}

/**
 * 记录最近一次验证结果（不影响取链）。
 * @param itemId 指定账号；省略时写到主账号
 */
export function saveVerifyResult(id: string, result: VerifyRecord | undefined, itemId?: string): void {
  const store = readStore()
  const acc = normalize(store.accounts[id])
  if (!acc?.items?.length) return
  const target = itemId ? acc.items.find(i => i.id === itemId) : primaryItem(acc)
  if (!target) return
  target.lastVerify = result
  writeStore(store)
}

/** 账号文件所在路径（供界面提示与备份排除） */
export function getStoreFilePath(): string {
  return path.join(dataDir(), DATA_FILE)
}
