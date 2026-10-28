// 咪咕 歌手/专辑搜索 —— 2026-10-28 实测（见 E:/AI/lx-music/GitHub音乐平台搜索接口资料调研.md）
// 免签名通道：pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do（jadeite 通道任何类型都 411，别用）
// 响应结构（顶层，不在 data 下）：
//   歌手 singerResultData: { totalCount, result: [{id, name, highlightStr}] }  —— 无头像
//   专辑 albumResultData : { totalCount, result: [{id, name, singer, publishDate, imgItems:[{imgSizeType, img}]}] }

import { httpFetch } from '../../request'

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
    return search(str, 'singer', page, limit).then(raw => {
      const data = raw?.singerResultData || {}
      const list = (data.result || []).map(item => ({
        id: item.id,
        name: item.name || '',
        picUrl: '', // 免签名通道不给头像，前端用 logo 兜底
        alias: [],
        albumSize: 0,
        musicSize: 0,
        source: 'mg',
      }))
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
