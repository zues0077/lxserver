// 咪咕 歌手/专辑搜索 —— 2026-10-28 实测（见 E:/AI/lx-music/GitHub音乐平台搜索接口资料调研.md）
// 免签名通道：pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do（jadeite 通道任何类型都 411，别用）
// 响应结构（顶层，不在 data 下）：
//   歌手 singerResultData: { totalCount, result: [{id, name, highlightStr}] }  —— 无头像
//   专辑 albumResultData : { totalCount, result: [{id, name, singer, publishDate, imgItems:[{imgSizeType, img}]}] }

import { httpFetch } from '../../request'

/**
 * 歌手头像补取：search_all.do 的 singerResultData 只给 {id,name,highlightStr}，没有头像。
 * 但免签名通道 singer_songs.do 一个 pageSize=1 的请求就能带回 singer.imgs（2026-11-01 实测），
 * 拿 id 反查即可补上。最多补 8 位、并发 4、总预算 2.5s，超时就先不补（下次请求有缓存）。
 */
const SINGER_SONGS_API = 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/singer_songs.do'
const AVATAR_TTL = 30 * 60 * 1000
const AVATAR_MAX = 8
const AVATAR_CONCURRENCY = 4
const AVATAR_BUDGET_MS = 2500
const avatarCache = new Map()

async function fetchSingerAvatar(id) {
  const key = String(id || '')
  if (!key) return ''
  const hit = avatarCache.get(key)
  if (hit && Date.now() - hit.at < AVATAR_TTL) return hit.url
  try {
    const url = `${SINGER_SONGS_API}?pageNo=1&pageSize=1&resourceType=2&singerId=${encodeURIComponent(key)}`
    const { body } = await httpFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
        Referer: 'https://m.music.migu.cn/',
      },
      timeout: 4000,
    }).promise
    const imgs = Array.isArray(body?.singer?.imgs) ? body.singer.imgs : []
    const urls = imgs.map(x => String(x?.img || '')).filter(u => /^https?:/.test(u))
    // imgs 通常由小到大排列，取最后一张（最大尺寸）
    const avatar = urls[urls.length - 1] || urls[0] || ''
    avatarCache.set(key, { url: avatar, at: Date.now() })
    return avatar
  } catch {
    // 失败也缓存，避免每次搜索都去撞同一个死 id（空值缓存同样 30 分钟）
    avatarCache.set(key, { url: '', at: Date.now() })
    return ''
  }
}

function fillSingerAvatars(list) {
  const targets = list.filter(x => !x.picUrl && x.id).slice(0, AVATAR_MAX)
  if (!targets.length) return Promise.resolve()
  let idx = 0
  const worker = async () => {
    while (idx < targets.length) {
      const item = targets[idx++]
      const url = await fetchSingerAvatar(item.id)
      if (url) item.picUrl = url
    }
  }
  const run = Promise.all(
    Array.from({ length: Math.min(AVATAR_CONCURRENCY, targets.length) }, worker)
  ).catch(() => {})
  // 总预算兜底：头像只是锦上添花，绝不能拖慢搜索首屏
  return Promise.race([run, new Promise(resolve => setTimeout(resolve, AVATAR_BUDGET_MS))])
}

const search = (str, switchKey, page, limit) => {
  const searchSwitch = encodeURIComponent(`{"${switchKey}":1}`)
  const url = `https://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?text=${encodeURIComponent(str)}&pageNo=${page}&pageSize=${limit}&searchSwitch=${searchSwitch}&isCorrect=1`
  return httpFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Referer: 'https://m.music.migu.cn/',
    },
  }).promise.then(({ body }) => body)
}

export default {
  searchSinger(str, page = 1, limit = 20) {
    return search(str, 'singer', page, limit).then(async raw => {
      const data = raw?.singerResultData || {}
      const list = (data.result || []).map(item => ({
        id: item.id,
        name: item.name || '',
        picUrl: '', // 搜索接口不给头像，下面按 id 反查补
        alias: [],
        albumSize: 0,
        musicSize: 0,
        source: 'mg',
      }))
      await fillSingerAvatars(list)
      const total = Number(data.totalCount) || list.length
      return { list, total, allPage: Math.ceil(total / limit) || 1, limit, source: 'mg' }
    })
  },

  searchAlbum(str, page = 1, limit = 20) {
    return search(str, 'album', page, limit).then(raw => {
      const data = raw?.albumResultData || {}
      const list = (data.result || []).map(item => {
        const imgs = Array.isArray(item.imgItems) ? item.imgItems : []
        const big = imgs.find(i => i.imgSizeType === '03') || imgs[imgs.length - 1] || {}
        return {
          id: item.id,
          name: item.name || '',
          picUrl: big.img || '',
          artistName: item.singer || '',
          size: undefined,
          publishTime: item.publishDate || '',
          source: 'mg',
        }
      })
      const total = Number(data.totalCount) || list.length
      return { list, total, allPage: Math.ceil(total / limit) || 1, limit, source: 'mg' }
    })
  },
}
