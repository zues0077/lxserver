// 酷狗 歌手详情/歌曲/专辑 —— 适配 extendDetail 约定，全部复用 singer.js / album.js 的现成端点
// （mobiles.kugou.com api/v5，免签名）

import singer from './singer'
import album from './album'

export default {
  async getArtistDetail(id) {
    const data = await singer.getInfo(id)
    return {
      source: 'kg',
      id: data.id || id,
      name: data.info?.name || '未知歌手',
      desc: data.info?.desc || '',
      avatar: data.info?.avatar || '',
      musicSize: data.count?.music || 0,
      albumSize: data.count?.album || 0,
    }
  },

  // singer.getSongList 返回 { source, list(已转好的歌曲 info), total }，正好是 getArtistSongs 约定
  async getArtistSongs(id, page = 1, limit = 100, order = 'hot') {
    const data = await singer.getSongList(id, page, limit)
    return { source: 'kg', list: data.list || [], total: data.total || 0 }
  },

  async getArtistAlbums(id, page = 1, limit = 50) {
    const data = await singer.getAlbumList(id, page, limit)
    const list = (data.list || []).map(item => ({
      id: item.id,
      name: item.info?.name || '',
      img: item.info?.img || '',
      singer: item.info?.author || '',
      publishTime: undefined,
      total: item.count || 0,
      source: 'kg',
    }))
    return { source: 'kg', list, total: data.total || list.length }
  },

  async getAlbumSongs(id) {
    const data = await album.getAlbumDetail(id)
    return {
      source: 'kg',
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
}
