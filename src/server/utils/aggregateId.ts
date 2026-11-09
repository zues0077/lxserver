/**
 * 八源聚合（source=all）时给每首歌生成「跨源唯一」的稳定 id。
 *
 * ## 设计要点（也是 T9 回归要锁定的不变式）
 * id 必须带 source 前缀。否则 wy/tx/kw/kg/mg/bili/soda/kglite 八源里，
 * 恰好同 songmid 的两首歌会撞 id，前端按 id 去重 / 反查时会串到错误的源。
 *
 * 上游 any-listen v2.2.0 changelog 的「跨源 ID 碰撞修复」正是这件事；
 * 我们早就用 `${source}_${songmid}` 规避了，这里把内联写法提成纯函数，
 * 让聚合逻辑与回归用例共用同一份实现，行为不变。
 *
 * 注意：聚合每条结果本来就有 `source` / `songmid` 字段，id 只是给前端做
 * 去重键与反查键用的「稳定字符串」，不参与任何业务判断。
 */
export const makeAggregateSongId = (source: string, songmid: string): string => {
  return `${source}_${songmid ?? ''}`
}
