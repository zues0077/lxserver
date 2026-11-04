/**
 * 酷狗概念版「登录态续期」所需的加密算法（AES-CBC + 裸 RSA）
 *
 * 为什么单独一个文件：这套加密只服务 `/v5/login_by_token` 一个接口，
 * 参数又都是硬编码的密钥/盐（抄错一个字符就整条链失败，且报错只会是
 * 「token 无效」这类误导性信息），单拎出来才能写单测、也才能和上游逐字节比对。
 *
 * 口径来源（**不要按印象改**）：KGM-AUTO-CHECKIN 的 `api/module/login_token.js`
 * 与 `api/util/crypto.js`，以及 md3music 的 Rust 版 `modules/login.rs`（同源实现，可交叉验证）。
 *
 * 三条与直觉不同的地方：
 *   1. AES 全部是 **CBC + PKCS7**，输出 **hex 小写**（不是 base64）；
 *   2. `params`/`pk` 用**临时随机 key**：先随机 16 字符，key = md5(随机串)[0:32]、
 *      iv = key[16:32]，再把随机串本身用 RSA 加密放进 `pk`，服务端才能解出 `params`；
 *   3. `pk` 用的是**裸 RSA**（`m^e mod n`，右侧补零到密钥长度），
 *      既不是 PKCS#1 v1.5 也不是 OAEP —— Node 的 `publicEncrypt` 会加填充，
 *      所以这里必须用 BigInt 自己算模幂。
 */

import * as crypto from 'node:crypto'

/** p3（token + clienttime）专用密钥，概念版固定值 */
export const LITE_AES = { key: 'c24f74ca2820225badc01946dba4fdf7', iv: 'adc01946dba4fdf7' } as const
/** t2（设备指纹）专用密钥 */
export const LITE_T2 = { key: 'fd14b35e3f81af3817a20ae7adae7020', iv: '17a20ae7adae7020' } as const
/** t1（会话票据）专用密钥 */
export const LITE_T1 = { key: '5e4ef500e9597fe004bd09a46d8add98', iv: '04bd09a46d8add98' } as const

/** 概念版 RSA 公钥（1024 位；标准版是另一把，别混用） */
export const LITE_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB
-----END PUBLIC KEY-----`

/** t3 是固定常量（概念版客户端里写死的空设备列表） */
export const LITE_T3 = 'MCwwLDAsMCwwLDAsMCwwLDA='

export function md5Hex(input: string): string {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex')
}

/**
 * 密钥串 → WebCrypto 算法名。
 *
 * 上游用 CryptoJS，key 是 WordArray（字节数决定 AES-128/192/256）：
 * 这里所有 key 都是 **32 个字符 = 32 字节 → AES-256-CBC**，
 * 写成 aes-128 会直接抛 `Invalid key length`，或者更糟 —— 被当成「token 无效」排查半天。
 */
function aesAlgo(keyBytes: number): string {
  if (keyBytes === 16) return 'aes-128-cbc'
  if (keyBytes === 24) return 'aes-192-cbc'
  return 'aes-256-cbc'
}

/** AES-CBC/PKCS7 加密 → hex（上游 cryptoAesEncrypt 的 key+iv 分支） */
export function aesCbcEncryptHex(data: string, key: string, iv: string): string {
  const keyBuf = Buffer.from(key, 'utf8')
  const cipher = crypto.createCipheriv(aesAlgo(keyBuf.length), keyBuf, Buffer.from(iv, 'utf8'))
  return Buffer.concat([cipher.update(Buffer.from(data, 'utf8')), cipher.final()]).toString('hex')
}

/**
 * AES-CBC/PKCS7 解密。
 * 不给 iv 时按上游口径派生：key = md5(明文key)[0:32]、iv = key[16:32]。
 */
export function aesCbcDecrypt(hex: string, key: string, iv?: string): string {
  const useKey = iv ? key : md5Hex(key).slice(0, 32)
  const useIv = iv || useKey.slice(useKey.length - 16)
  const keyBuf = Buffer.from(useKey, 'utf8')
  const decipher = crypto.createDecipheriv(aesAlgo(keyBuf.length), keyBuf, Buffer.from(useIv, 'utf8'))
  return Buffer.concat([
    decipher.update(Buffer.from(hex, 'hex')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * 生成 `params` 用的临时 key（上游 `randomString(16).toLowerCase()`）。
 * 字符集不参与算法，只要 16 个字符；这里用 hex 保证长度与可读性。
 */
export function randomTempKey(): string {
  return crypto.randomBytes(8).toString('hex').slice(0, 16)
}

/** `{ str, key }`：临时 key 加密空对象 `{}`，服务端靠 pk 里的 key 解出 secu_params */
export function encryptEmptyParams(): { str: string; key: string } {
  const key = randomTempKey()
  const derived = md5Hex(key).slice(0, 32)
  return { str: aesCbcEncryptHex('{}', derived, derived.slice(derived.length - 16)), key }
}

function base64UrlToBigInt(v: string): bigint {
  const b64 = v.replace(/-/g, '+').replace(/_/g, '/')
  return BigInt(`0x${Buffer.from(b64, 'base64').toString('hex') || '0'}`)
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return result
}

/**
 * 裸 RSA 加密（hex 输出，长度 = 密钥字节数 × 2）。
 *
 * 与上游 `cryptoRSAEncrypt` 一致：把明文 UTF-8 字节**右侧补 0** 到密钥长度，
 * 再整体做 `m^e mod n`。补零方向不能反，反了服务端解出来的 JSON 尾部全是 0，
 * 表现为「key 解析失败 → token 无效」。
 */
export function rsaRawEncryptHex(data: string, pem: string = LITE_RSA_PUBLIC_KEY): string {
  const keyObj = crypto.createPublicKey(pem)
  const jwk = keyObj.export({ format: 'jwk' }) as { n?: string; e?: string }
  if (!jwk.n || !jwk.e) throw new Error('RSA 公钥解析失败')
  const n = base64UrlToBigInt(jwk.n)
  const e = base64UrlToBigInt(jwk.e)
  const keyLen = Math.ceil(n.toString(2).length / 8)

  const buf = Buffer.from(data, 'utf8')
  if (buf.length > keyLen) throw new Error('待加密数据超过 RSA 密钥长度')
  const padded = Buffer.alloc(keyLen)
  buf.copy(padded, 0)
  const m = BigInt(`0x${padded.toString('hex')}`)
  const hex = modPow(m, e, n).toString(16).padStart(keyLen * 2, '0')
  return hex
}

/** 由 md5 派生一个稳定的 UUIDv4 形态 guid（同一输入永远同一结果，避免设备漂移） */
export function guidFromSeed(seed: string): string {
  const h = md5Hex(seed)
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
