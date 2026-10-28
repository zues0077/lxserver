// 酷我 歌手/专辑搜索 —— 2026-10-28 实测（见 E:/AI/lx-music/GitHub音乐平台搜索接口资料调研.md）
// 接口：search.kuwo.cn/r.s?ft=artist|album，列表键分别为 abslist / albumlist
// 实测字段：
//   artist: TOTAL + abslist[]{ARTISTID, ARTIST, AARTIST, ALBUMNUM, SONGNUM, PICPATH, BASEPICPATH}
//   album : total + albumlist[]{albumid, name, img, artist, artistid, musiccnt, pub}
// 坑：r.s 返回伪 JSON（单引号 + &nbsp;），必须用 objStr2JSON 解析

import { httpFetch } from '../../request'
import { objStr2JSON } from './util'

const search = (str, ft, page, limit) => {
  const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(str)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=MUSIC_8.7.7.0_BCS37&plat=pc&devid=28156413&ft=${ft}&cluster=0&strategy=2012&encoding=utf8&rformat=json`
  return httpFetch(url).promise.then(({ body }) => {
    // 成功时 body 可能已被自动 JSON.parse，失败时是伪 JSON 字符串
    if (typeof body === 'string') return objStr2JSON(body)
    return body
  })
}

export default {
  searchSinger(str, page = 1, limit = 20) {
    return search(str, 'artist', page, limit).then(raw => {
      const list = (raw.abslist || []).map(item => ({
        id: item.ARTISTID,
        name: item.ARTIST || '',
        picUrl: item.PICPATH
          ? (item.BASEPICPATH || 'http://img1.kuwo.cn/star/starheads/') + item.PICPATH
          : '',
        alias: item.AARTIST && item.AARTIST !== item.ARTIST ? [item.AARTIST] : [],
        albumSize: Number(item.ALBUMNUM) || 0,
        musicSize: Number(item.SONGNUM) || 0,
        source: 'kw',
      }))
      const total = Number(raw.TOTAL) || list.length
      return { list, total, allPage: Math.ceil(total / limit) || 1, limit, source: 'kw' }
    })
  },

  searchAlbum(str, page = 1, limit = 20) {
    return search(str, 'album', page, limit).then(raw => {
      const list = (raw.albumlist || []).map(item => ({
        id: item.albumid || item.id,
        name: item.name || item.title || '',
        picUrl: item.img || item.pic || '',
        artistName: item.artist || '',
        artistId: item.artistid,
        size: Number(item.musiccnt) || undefined,
        publishTime: item.pub || '',
        source: 'kw',
      }))
      const total = Number(raw.total) || list.length
      return { list, total, allPage: Math.ceil(total / limit) || 1, limit, source: 'kw' }
    })
  },
}
