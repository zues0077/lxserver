// 咪咕 专辑歌曲列表 —— 适配 extendDetail.getAlbumSongs 约定，复用 album.js 现成端点
// （mg 歌手详情接口暂不接；歌手搜索走免签名 search_all.do）

import album from './album'

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
}
