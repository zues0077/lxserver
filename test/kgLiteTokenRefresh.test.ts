/**
 * 酷狗概念版「登录态静默续期」纯逻辑单测
 *
 * 只测不需要联网、也不可能靠猜正确的部分：
 *   1. 三种 AES 密文必须与上游 KGM-AUTO-CHECKIN（CryptoJS）**逐字节一致** ——
 *      抄错一个字符，报错会伪装成「token 无效」，能把人带到沟里去；
 *   2. 裸 RSA 必须能被对应私钥以 `RSA_NO_PADDING` 解回「右侧补零」的原文
 *      （Node 的 publicEncrypt 会加 PKCS#1 填充，和这里的口径不同，所以不能用它算）；
 *   3. 续期排程：区间边界、账号之间不重叠、首次排程铺满一周、重启不漂移。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {
  aesCbcDecrypt,
  aesCbcEncryptHex,
  encryptEmptyParams,
  guidFromSeed,
  md5Hex,
  rsaRawEncryptHex,
  LITE_AES,
  LITE_T1,
  LITE_T2,
} from '../src/server/musicAccount/kugouLiteCrypto'
import { planTokenRefreshAt, seedTokenRefreshAt, tokenRefreshSeparationMs } from '../src/server/musicAccount'

const DAY = 24 * 3600_000

// 参考值由上游 api/util/crypto.js（CryptoJS）算出，见 P-1096
const VECTORS = {
  p3: '8cf37af717d09934ee6ed8faea07ba7163e8b1a89d82e00c04249d4c4acbf75806e4f87aa1ffa71ec74c50d6b6cc8d40',
  t1: '7586bc68c78aa9b94609abd54a220dbe',
  t2: '43c102c064e5cb900c88b1977d797eda12d1a84a652d6107d4d41e4568793bfd03ed4eb709780311812b40e4b3911cab116819eb7766ccc980acc9ac1b124cd2',
  emptyParams: '551aea54ce40ef3b28e6ac63c38f6601',
}

test('AES：p3（token + clienttime）与上游逐字节一致', () => {
  const hex = aesCbcEncryptHex(
    JSON.stringify({ clienttime: 1700000000, token: 'TOKEN123' }),
    LITE_AES.key, LITE_AES.iv,
  )
  assert.equal(hex, VECTORS.p3)
})

test('AES：t1（会话票据）与上游逐字节一致', () => {
  const hex = aesCbcEncryptHex('|1700000000000', LITE_T1.key, LITE_T1.iv)
  assert.equal(hex, VECTORS.t1)
})

test('AES：t2（设备指纹，MAC 为空）与上游逐字节一致', () => {
  const hex = aesCbcEncryptHex(
    'guid-abc|0f607264fc6318a92b9e13c65db7cd3c||DEV1|1700000000000',
    LITE_T2.key, LITE_T2.iv,
  )
  assert.equal(hex, VECTORS.t2)
})

test('AES：临时 key 分支（key=md5(temp)[0:32]、iv=key[16:32]）与上游一致', () => {
  const temp = 'abcdef0123456789'
  const key = md5Hex(temp).slice(0, 32)
  assert.equal(aesCbcEncryptHex('{}', key, key.slice(16)), VECTORS.emptyParams)
})

test('AES：能用自己的 key 解回明文（secu_params 走的就是这条路）', () => {
  const { str, key } = encryptEmptyParams()
  assert.equal(aesCbcDecrypt(str, key), '{}')
})

test('RSA：裸加密能被私钥以 NO_PADDING 解回「右侧补零」原文', () => {
  // 用自建密钥对验证算法本身（公钥换成测试用的，生产公钥只用于真实请求）
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const plain = JSON.stringify({ clienttime_ms: 1700000000000, key: 'abcdef0123456789' })
  const hex = rsaRawEncryptHex(plain, pem)

  const keyLen = Math.ceil(crypto.createPublicKey(pem).asymmetricKeyDetails!.modulusLength! / 8)
  assert.equal(hex.length, keyLen * 2)

  const decrypted = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_NO_PADDING },
    Buffer.from(hex, 'hex'),
  )
  const expected = Buffer.alloc(keyLen)
  Buffer.from(plain, 'utf8').copy(expected, 0)
  assert.deepEqual(decrypted, expected)
})

test('RSA：数据超过密钥长度时直接报错，不静默截断', () => {
  assert.throws(() => rsaRawEncryptHex('x'.repeat(200)), /超过/)
})

test('guidFromSeed：同一账号每次都一样（设备不能漂移）', () => {
  const a = guidFromSeed('2577290129:123456')
  const b = guidFromSeed('2577290129:123456')
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(a, guidFromSeed('2577290129:654321'))
})

test('续期排程：落在 [minDays, maxDays] 区间内', () => {
  const now = 1_700_000_000_000
  for (let i = 0; i < 50; i++) {
    const at = planTokenRefreshAt(now, { minDays: 6, maxDays: 8, others: [] })
    assert.ok(at >= now + 6 * DAY, `早了：${(at - now) / DAY} 天`)
    assert.ok(at <= now + 8 * DAY, `晚了：${(at - now) / DAY} 天`)
  }
})

test('续期排程：与其它账号至少隔开 minSep（撞车会顺延）', () => {
  const now = 1_700_000_000_000
  const other = now + 7 * DAY
  const minSep = 12 * 3600_000
  // 固定随机数：先撞到 other 上，必须被顺延出去
  const at = planTokenRefreshAt(now, { minDays: 7, maxDays: 7, others: [other], minSepMs: minSep, rand: () => 0 })
  assert.ok(Math.abs(at - other) >= minSep, `没隔开：${(at - other) / 3600_000} 小时`)
})

test('续期排程：账号越多，最小间隔越短但夹在 [4h, 36h]', () => {
  // 3 个号时按「一周三等份」的 80% 算，超过 36h 上限 → 取 36h
  assert.equal(tokenRefreshSeparationMs(3), 36 * 3600_000)
  assert.equal(tokenRefreshSeparationMs(1), 36 * 3600_000)
  // 10 个号：7d/10 × 0.8 ≈ 13.4h
  assert.ok(tokenRefreshSeparationMs(10) > 12 * 3600_000 && tokenRefreshSeparationMs(10) < 14 * 3600_000)
  assert.ok(tokenRefreshSeparationMs(40) >= 4 * 3600_000)
})

test('首次排程：3 个账号铺在一周里且两两相隔足够远', () => {
  const now = 1_700_000_000_000
  const times = [0, 1, 2].map(i => seedTokenRefreshAt(now, i, 3, () => 0.5))
  times.sort((a, b) => a - b)
  // 等份中点：1/6、3/6、5/6 周
  assert.equal(Math.round((times[0] - now) / DAY), Math.round((7 / 6) * 1))
  assert.equal(Math.round((times[2] - now) / DAY), Math.round((35 / 6) * 1))
  assert.ok(times[1] - times[0] > 2 * DAY)
  assert.ok(times[2] - times[1] > 2 * DAY)
})

test('首次排程：同一个 index 每次结果固定（重启不重新抽签）', () => {
  const now = 1_700_000_000_000
  const a = seedTokenRefreshAt(now, 1, 4, () => 0.3)
  const b = seedTokenRefreshAt(now, 1, 4, () => 0.3)
  assert.equal(a, b)
})
