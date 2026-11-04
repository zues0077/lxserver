/**
 * 热搜兜底的「结果是否有效」判定。
 *
 * 2026-11-05 246 实机抓到的回归：musicSdk 各平台 `hotSearch.getList()` 返回的
 * 都是 `{ source, list }` 对象（前端 `public/music/app.js` 也是按 `data.list` 消费），
 * 而不是数组。兜底代码若写 `Array.isArray(result)` 判有效，会把每个平台都记成
 * 「空结果」，最终 5 个平台全兜底完仍返回 []，界面热搜一片空白。
 *
 * 这里同时兼容两种形态：
 * - `{ source, list }`：六个平台 SDK 的现行返回；
 * - 纯数组：个别自定义/未来实现可能直接给词数组。
 * 返回判定用的词数组，但**缓存与响应仍原样保存 SDK 的返回对象**，避免破坏前端字段。
 */
export function hotSearchItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object' && Array.isArray((payload as { list?: unknown }).list)) {
    return (payload as { list: unknown[] }).list
  }
  return []
}

export function hasHotSearchItems(payload: unknown): boolean {
  return hotSearchItems(payload).length > 0
}
