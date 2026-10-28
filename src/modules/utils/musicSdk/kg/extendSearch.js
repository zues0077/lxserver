// 酷狗 歌手/专辑搜索 —— 2026-10-28 实测（见 E:/AI/lx-music/GitHub音乐平台搜索接口资料调研.md）
// 接口（mobilecdn，免签名）：
//   歌手 api/v3/search/singer → data 直接是数组 [{singername, singerid}]，无 total、无头像
//   专辑 api/v3/search/album  → data.total + data.info[]{albumid, albumname, singername, publishtime, songcount, imgurl({size})}
// 歌手头像需二跳 api/v3/singer/info?singerid=（复用 singer.getInfo 的端点，失败容忍）

import { httpFetch } from '../../request'
import { createHttpFetch } from './util'

export default {
  searchSinger(str, page = 1, limit = 20) {
    const url = `http://mobilecdn.kugou.com/api/v3/search/singer?keyword=${encodeURIComponent(str)}&page=${page}&pagesize=${limit}`
    return httpFetch(url).promise.then(({ body }) => {
      const rawList = (body && body.data) || []
      if (!Array.isArray(rawList)) return { list: [], total: 0, allPage: 1, limit, source: 'kg' }
      // 二跳补头像/简介字段（并发，失败容忍）
      return Promise.all(rawList.map(item =>
        createHttpFetch(`http://mobiles.kugou.com/api/v5/singer/info?singerid=${item.singerid}`)
          .then(info => ({
            id: item.singerid,
            name: item.singername || info.singername || '',
            picUrl: info.imgurl ? info.imgurl.replace('{size}', '240') : '',
            alias: [],
            albumSize: Number(info.albumcount) || 0,
            musicSize: Number(info.songcount) || 0,
            source: 'kg',
          }))
          .catch(() => ({
            id: item.singerid,
            name: item.singername || '',
            picUrl: '',
            alias: [],
            albumSize: 0,
            musicSize: 0,
            source: 'kg',
          })),
      )).then(list => ({
        list,
        // singer 端点 data 直接是数组，无 total；按「满页则还有更多」近似
        total: list.length < limit ? (page - 1) * limit + list.length : page * limit + 1,
        allPage: list.length < limit ? page : page + 1,
        limit,
        source: 'kg',
      }))
    })
  },

  searchAlbum(str, page = 1, limit = 20) {
    const url = `http://mobilecdn.kugou.com/api/v3/search/album?keyword=${encodeURIComponent(str)}&page=${page}&pagesize=${limit}`
    return httpFetch(url).promise.then(({ body }) => {
      const rawList = (body && body.data && body.data.info) || []
      const list = rawList.map(item => ({
        id: item.albumid,
        name: item.albumname || '',
        picUrl: item.imgurl ? item.imgurl.replace('{size}', '240') : '',
        artistName: item.singername || '',
        artistId: item.singerid,
        size: Number(item.songcount) || undefined,
        publishTime: item.publishtime || '',
        source: 'kg',
      }))
      const total = (body?.data && body.data.total) || list.length
      return { list, total, allPage: Math.ceil(total / limit) || 1, limit, source: 'kg' }
    })
  },
}
