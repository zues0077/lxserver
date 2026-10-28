// 咪咕 歌手详情/歌曲 + 专辑歌曲列表 —— 适配 extendDetail 约定
//
// 歌手维度走免签名通道 `app.c.nf.migu.cn/MIGUM2.0/v1.0/content/singer_sings.do`：
//   一个请求同时带回 singer{名称/头像} 与 songlist[]，详情与歌曲共用（2026-10-28 实测）。
//   咪咕没有免签名的歌手专辑端点（singer_albums.do / queryAlbumBySingerId.do 都「路由请求不支持」），
//   所以不接 getArtistAlbums，前端歌手页专辑 tab 会显示为空。
// 歌手搜索走免签名 search_all.do（见 extendSearch.js）。

import album from './album'
import { httpFetch } from '../../request'

const SINGER_SONGS_API = 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/singer_songs.do'
const MIGU_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://m.music.migu.cn/',
}

/** singer_songs.do 的曲目结构 → 与 mg/musicSearch.js 的 filterData 输出对齐（取链只依赖 copyrightId/songmid） */
function mapSong(item) {
  if (!item?.copyrightId) return null
  const fmts = Array.isArray(item.newRateFormats) && item.newRateFormats.length ? item.newRateFormats : (item.rateFormats || [])
  const types = []
  const _types = {}
  for (const t of fmts) {
    const size = t.size ? `${Math.max(1, Math.round(Number(t.size) / 1024 / 1024))}MB` : undefined
    switch (t.formatType) {
      case 'PQ':
        types.push({ type: '128k', size }); _types['128k'] = { size }; break
      case 'HQ':
        types.push({ type: '320k', size }); _types['320k'] = { size }; break
      case 'SQ':
        types.push({ type: 'flac', size }); _types.flac = { size }; break
      case 'ZQ24':
        types.push({ type: 'flac24bit', size }); _types.flac24bit = { size }; break
    }
  }
  if (!types.length) {
    types.push({ type: '128k' }, { type: '320k' })
  }
  const imgNode = (item.albumImgs || []).find(x => String(x.img || '').startsWith('http'))
    || (item.albumImgs || [])[0]
  let img = imgNode?.img || null
  if (img && !/https?:/.test(img)) img = 'http://d.musicapp.migu.cn' + img
  return {
    singer: (Array.isArray(item.singerList) ? item.singerList : []).map(s => s?.name).filter(Boolean).join('、')
      || (item.singer || ''),
    name: item.songName || item.name || '',
    albumName: item.album || '',
    albumId: String(item.albumId || ''),
    songmid: String(item.songId || ''),
    copyrightId: item.copyrightId,
    source: 'mg',
    interval: item.duration ? String(Math.round(Number(item.duration))) : '',
    img,
    lrc: null,
    lrcUrl: item.lrcUrl,
    mrcUrl: item.mrcurl,
    trcUrl: item.trcUrl,
    types,
    _types,
    typeUrl: {},
  }
}

async function fetchSingerSongs(singerId, pageNo, pageSize) {
  const url = `${SINGER_SONGS_API}?pageNo=${Math.max(1, pageNo)}&pageSize=${Math.min(50, Math.max(1, pageSize))}&resourceType=2&singerId=${encodeURIComponent(singerId)}`
  const resp = await httpFetch(url, { headers: MIGU_HEADERS, timeout: 10000 }).promise
  const body = resp.body
  if (!body || (!body.singer && !Array.isArray(body.songlist))) {
    throw new Error('咪咕歌手接口返回异常')
  }
  return body
}

function pickAvatar(singer) {
  const imgs = Array.isArray(singer?.imgs) ? singer.imgs : []
  const withUrl = imgs.map(x => String(x?.img || '')).filter(u => /^https?:/.test(u))
  // imgs 通常从小到大排列，取最后一张（最大尺寸）
  return withUrl[withUrl.length - 1] || withUrl[0] || ''
}

export default {
  async getAlbumSongs(id) {
    const data = await album.getAlbumDetail(id)
    return {
      source: 'mg',
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
    const body = await fetchSingerSongs(id, 1, 1)
    return {
      source: 'mg',
      id: String(id),
      name: body.singer?.singer || '未知歌手',
      desc: '',
      avatar: pickAvatar(body.singer),
      musicSize: Number(body.total) || 0,
      albumSize: 0,
    }
  },

  async getArtistSongs(id, page = 1, limit = 100, order = 'hot') {
    const body = await fetchSingerSongs(id, page, limit)
    const list = (body.songlist || []).map(mapSong).filter(Boolean)
    return { source: 'mg', list, total: Number(body.total) || list.length }
  },
}
