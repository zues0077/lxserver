/**
 * 浏览器扩展打包（store 模式 zip，无需第三方依赖）
 *
 * 为什么不把 zip 直接提交进仓库：
 * 二进制文件走不了文本 diff，改一行 README 也要重传整包，而且容易和源码不一致。
 * 这里改成「请求时按 public/ext/cookie-sync 的当前内容现打」，
 * 源码改完刷新页面就拿到新包，永远同步。
 *
 * store 模式（method=0，不压缩）足够：四个文件加起来十几 KB。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 扩展目录（相对运行目录）。镜像里 public 在 /server/public。 */
const EXT_DIR = path.join('public', 'ext', 'cookie-sync')

/** 打进包里的文件，顺序固定，保证同一份源码产出同一个字节流 */
const FILES = ['manifest.json', 'popup.html', 'popup.js', 'README.txt']

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  crcTable = table
  return table
}

function crc32(buf: Buffer): number {
  const table = getCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

interface Entry {
  name: string
  data: Buffer
}

function buildZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  // 固定为 1980-01-01 00:00，避免每次请求产出的包因时间戳不同而无法比对
  const dosTime = 0
  const dosDate = 0x21

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(e.data.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)

    locals.push(local, e.data)
    centrals.push(central)
    offset += local.length + e.data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, eocd])
}

/** 读取扩展源码并打成 zip；源码缺失时抛错，由调用方回 500 */
export function buildExtensionZip(): Buffer {
  const dir = path.resolve(process.cwd(), EXT_DIR)
  const entries: Entry[] = []
  for (const name of FILES) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) throw new Error(`扩展文件缺失：${name}`)
    entries.push({ name, data: fs.readFileSync(file) })
  }
  return buildZip(entries)
}
