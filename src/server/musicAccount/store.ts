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
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { PLATFORMS, getPlatform } from './platforms'

const FILE_VERSION = 1
const KEY_FILE = '.music-account-key'
const DATA_FILE = 'music-accounts.json'

export interface StoredAccount {
  /** AES-256-GCM 密文，格式 iv:tag:ciphertext（hex） */
  cookie: string
  updatedAt: number
  /** 最近一次验证结果（仅记录，不参与取链判断） */
  lastVerify?: {
    at: number
    ok: boolean
    isVip?: boolean
    message?: string
    nickname?: string
    /** 校验强度：online = 调了需登录接口；structural = 只核对了 Cookie 字段 */
    verified?: 'online' | 'structural'
  }
}

interface StoreShape {
  version: number
  accounts: Record<string, StoredAccount>
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

function readStore(): StoreShape {
  const file = path.join(dataDir(), DATA_FILE)
  if (!fs.existsSync(file)) return { version: FILE_VERSION, accounts: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.accounts) {
      return { version: FILE_VERSION, accounts: {} }
    }
    return { version: parsed.version || FILE_VERSION, accounts: parsed.accounts }
  } catch (e: any) {
    console.error(`[平台账号] 账号文件解析失败，已按空账号处理：${e.message}`)
    return { version: FILE_VERSION, accounts: {} }
  }
}

function writeStore(store: StoreShape): void {
  const file = path.join(dataDir(), DATA_FILE)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  fs.renameSync(tmp, file) // 原子替换，避免写一半断电导致文件损坏
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 无 chmod 语义，忽略 */ }
}

/**
 * 列出所有平台账号的「脱敏」信息，用于管理界面展示。
 * 返回的 cookiePreview 只保留前 3 后 3 位，不返回完整 cookie。
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
  lastVerify: StoredAccount['lastVerify'] | null
  /** 该平台支持的扫码方式（空数组 = 只能手工填 Cookie） */
  qrLogins: Array<{ driver: string; label: string }>
}> {
  const store = readStore()
  return PLATFORMS.map(p => {
    const acc = store.accounts[p.id]
    let cookie = ''
    let configured = false
    try {
      if (acc?.cookie) { cookie = decrypt(acc.cookie); configured = cookie.trim().length > 0 }
    } catch (e: any) {
      console.error(`[平台账号] ${p.name} 的 Cookie 解密失败：${e.message}`)
    }
    return {
      id: p.id,
      name: p.name,
      short: p.short,
      color: p.color,
      configured,
      cookieLength: cookie.length,
      cookiePreview: cookie.length > 8 ? `${cookie.slice(0, 3)}…${cookie.slice(-3)}` : '',
      updatedAt: acc?.updatedAt ?? null,
      lastVerify: acc?.lastVerify ?? null,
      qrLogins: p.qrLogins || [],
    }
  })
}

/** 取某平台的明文 Cookie（仅内存中使用，不要写日志） */
export function getCookie(id: string): string {
  const acc = readStore().accounts[id]
  if (!acc?.cookie) return ''
  try {
    return decrypt(acc.cookie)
  } catch (e: any) {
    console.error(`[平台账号] ${id} 的 Cookie 解密失败：${e.message}`)
    return ''
  }
}

/**
 * 是否已为该平台配置了可用账号。
 * 只看「有没有」不看「能否解密」，避免因为密钥丢失让整条播放链路卡住。
 */
export function hasAccount(id: string): boolean {
  return !!readStore().accounts[id]?.cookie
}

/** 写入某平台 Cookie。传空字符串等同于删除。 */
export function setCookie(id: string, cookie: string): { success: boolean; error?: string } {
  if (!getPlatform(id)) return { success: false, error: `不支持的平台：${id}` }
  const store = readStore()
  if (!String(cookie || '').trim()) {
    delete store.accounts[id]
  } else {
    store.accounts[id] = {
      cookie: encrypt(String(cookie).trim()),
      updatedAt: Date.now(),
      lastVerify: store.accounts[id]?.lastVerify,
    }
  }
  writeStore(store)
  return { success: true }
}

/** 删除某平台账号 */
export function removeCookie(id: string): { success: boolean; error?: string } {
  if (!getPlatform(id)) return { success: false, error: `不支持的平台：${id}` }
  const store = readStore()
  delete store.accounts[id]
  writeStore(store)
  return { success: true }
}

/** 记录最近一次验证结果（不影响取链） */
export function saveVerifyResult(id: string, result: StoredAccount['lastVerify']): void {
  const store = readStore()
  const acc = store.accounts[id]
  if (!acc) return
  acc.lastVerify = result
  writeStore(store)
}

/** 账号文件所在路径（供界面提示与备份排除） */
export function getStoreFilePath(): string {
  return path.join(dataDir(), DATA_FILE)
}
