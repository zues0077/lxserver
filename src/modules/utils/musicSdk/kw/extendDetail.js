// 酷我 专辑歌曲列表 —— 适配 extendDetail.getAlbumSongs 约定，复用 album.js 现成端点
// （kw 歌手详情接口要 Cookie + csrf，暂不接 extendDetail 其余方法）

import album from './album'

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
}
