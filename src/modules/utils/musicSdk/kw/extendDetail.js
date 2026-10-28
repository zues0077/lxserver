// 酷我 歌手详情/歌曲/专辑 + 专辑歌曲列表 —— 适配 extendDetail 约定
//
// 歌手维度走 www.kuwo.cn/api/www 通道。该通道要求「Secret 请求头」：
//   1) GET https://www.kuwo.cn/ 拿 set-cookie（Hm_Iuvt_xxx=<token>）
//   2) Secret = strEncrypt(token, cookieKey)（酷我前端同款混淆算法，2026-10-28 实测可用）
//   3) 请求带 Secret + Cookie + Referer
// 旧版 kw_token/csrf 方案已被酷我下线（匿名请求返回 "The request is illegal!"）。

import album from './album'
import { httpFetch } from '../../request'
import { decodeName } from '../../index'
import { formatSinger, formatPic } from './util'

const KW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 酷我前端 Secret 生成算法（prand 流式异或 + salt 后缀） */
function strEncrypt(str, pwd) {
  if (!pwd || pwd.length <= 0) return null
  let prand = ''
  for (let i = 0; i < pwd.length; i++) prand += pwd.charCodeAt(i).toString()
  const sPos = Math.floor(prand.length / 5)
  const mult = parseInt(prand.charAt(sPos) + prand.charAt(sPos * 2) + prand.charAt(sPos * 3) + prand.charAt(sPos * 4) + prand.charAt(sPos * 5))
  const incr = Math.ceil(pwd.length / 2)
  const modu = Math.pow(2, 31) - 1
  if (Number.isNaN(mult) || mult < 2) return null
  let salt = Math.round(Math.random() * 1000000000) % 100000000
  prand += salt
  while (prand.length > 10) {
    prand = (parseInt(prand.substring(0, 10)) + parseInt(prand.substring(10, prand.length))).toString()
  }
  prand = (mult * parseInt(prand) + incr) % modu
  let encStr = ''
  for (let i = 0; i < str.length; i++) {
    const encChr = parseInt(String(str.charCodeAt(i) ^ Math.floor((prand / modu) * 255)))
    encStr += (encChr < 16 ? '0' : '') + encChr.toString(16)
    prand = (mult * prand + incr) % modu
  }
  salt = salt.toString(16)
  while (salt.length < 8) salt = '0' + salt
  return encStr + salt
}

// Secret 头缓存：cookie 有效期约数小时，缓存 1 小时，失败即重取
let kwSecretCache = null

async function getSecretHeaders(retryNum = 0) {
  if (kwSecretCache && Date.now() - kwSecretCache.ts < 3600_000) {
    return {
      Secret: kwSecretCache.secret,
      Cookie: kwSecretCache.cookiePair,
      Referer: 'https://www.kuwo.cn/',
      'User-Agent': KW_UA,
    }
  }
  if (retryNum > 2) throw new Error('kw secret: 获取失败')
  const resp = await httpFetch('https://www.kuwo.cn/', {
    headers: { 'User-Agent': KW_UA, Accept: 'text/html' },
    timeout: 10000,
  }).promise
  const setCookie = resp.headers?.['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  const cookiePair = String(raw || '').replace(/;.*/, '')
  const eq = cookiePair.indexOf('=')
  const key = eq > 0 ? cookiePair.slice(0, eq) : ''
  const token = eq > 0 ? cookiePair.slice(eq + 1) : ''
  if (!key || !token) throw new Error('kw secret: 未下发 cookie')
  const secret = strEncrypt(token, key)
  if (!secret) throw new Error('kw secret: 算法失败')
  kwSecretCache = { cookiePair, secret, ts: Date.now() }
  return {
    Secret: secret,
    Cookie: cookiePair,
    Referer: 'https://www.kuwo.cn/',
    'User-Agent': KW_UA,
  }
}

/** www 通道 GET：Secret 失效时清缓存重试一次 */
async function kwWwwGet(path) {
  const url = `https://www.kuwo.cn/api/www/${path}${path.includes('?') ? '&' : '?'}httpsStatus=1&reqId=&plat=web_www`
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = await getSecretHeaders(attempt)
    const resp = await httpFetch(url, { headers, timeout: 10000 }).promise
    const body = resp.body
    if (body && typeof body === 'object' && body.data != null) return body.data
    // Secret 失效/被拒：清缓存重取一次
    kwSecretCache = null
  }
  throw new Error(`kw www 通道失败：${path}`)
}

export default {
  async getAlbumSongs(id) {
    const data = await album.getAlbumListDetail(id, 1)
    return {
      source: 'kw',
      list: data.list || [],
      total: data.total || (data.list || []).length,
      name: data.info?.name,
      artistName: data.info?.author,
      desc: data.info?.desc,
      img: data.info?.img,
      picUrl: data.info?.img,
      source_id: id,
    }
  },

  async getArtistDetail(id) {
    const d = await kwWwwGet(`artist/artist?artistid=${id}`)
    return {
      source: 'kw',
      id: d.id || id,
      name: decodeName(d.name || '未知歌手'),
      desc: decodeName(d.info || ''),
      avatar: d.pic300 || d.pic || '',
      musicSize: Number(d.musicNum) || 0,
      albumSize: Number(d.albumNum) || 0,
    }
  },

  async getArtistSongs(id, page = 1, limit = 100, order = 'hot') {
    const d = await kwWwwGet(`artist/artistMusic?artistid=${id}&pn=${Math.max(1, page)}&rn=${Math.min(100, Math.max(1, limit))}`)
    const rawList = d.list || []
    const list = rawList.map(item => {
      const songmid = String(item.rid || String(item.musicrid || '').replace(/^MUSIC_/, '') || '')
      const types = [{ type: '128k' }, { type: '320k' }]
      if (item.hasLossless) types.push({ type: 'flac' })
      return {
        name: decodeName(item.name || ''),
        singer: formatSinger(decodeName(String(item.artist || ''))),
        source: 'kw',
        songmid,
        albumId: String(item.albumid || ''),
        interval: item.songTimeMinutes || '',
        albumName: decodeName(item.album || ''),
        lrc: null,
        img: formatPic(item.albumpic || item.pic || null),
        otherSource: null,
        types,
        _types: {},
        typeUrl: {},
      }
    })
    return { source: 'kw', list, total: Number(d.total) || list.length }
  },

  async getArtistAlbums(id, page = 1, limit = 30) {
    const d = await kwWwwGet(`artist/artistAlbum?artistid=${id}&pn=${Math.max(1, page)}&rn=${Math.min(50, Math.max(1, limit))}`)
    const rawList = d.albumList || []
    const list = rawList.map(item => ({
      id: String(item.albumid || ''),
      name: decodeName(item.album || item.name || ''),
      img: formatPic(item.pic || null),
      singer: decodeName(item.artist || ''),
      publishTime: item.releaseDate || undefined,
      total: 0,
      source: 'kw',
    }))
    return { source: 'kw', list, total: Number(d.total) || list.length }
  },
}
