/**
 * 「这首歌的请求里有没有该平台能用的 ID」的判定。
 *
 * 背景：自定义源与平台账号都是按 ID 取链（songmid / hash / rid / copyrightId）。
 * 请求里一旦没有 ID，十几个音源会各自报「缺少 songId」「缺少参数：songId/songmid/id」
 * 「歌曲ID无效，请检查歌单导入来源」，日志上看起来像所有公开音源同时挂掉，
 * 实际是请求本身没带 ID。分诊的第一步就是判断「到底有没有 ID」。
 *
 * 抽成独立模块是为了能单测（server.ts 太大，逻辑混在里面没法单独验证）。
 */

/** 宿主自己拼出来的占位 ID：sl_<歌单id>_<序号> / lb_<榜单id>_<序号> 之类，拿去请求必定无效 */
export const PLACEHOLDER_SONG_ID_RE = /^(sl|lb|kglite|bili|soda|cache|local)_/i

/** 各平台「能直接拿去请求」的 ID 形态。不认识的平台（自定义源自造 source）不干预 */
export const NATIVE_ID_RULES: Record<string, (id: string) => boolean> = {
  wy: id => /^\d+$/.test(id),
  kw: id => /^\d+$/.test(id),
  mg: id => /^\d+$/.test(id),
  kg: id => /^[0-9a-z]{16,40}$/i.test(id),
  kglite: id => /^[0-9a-z]{16,40}$/i.test(id),
  tx: id => /^[0-9a-z]{6,}$/i.test(id),
}

/** 把可能承载 ID 的字段都收一遍；`wy_123` 这类带平台前缀的先去前缀 */
export const collectSongIdCandidates = (song: any): string[] => {
  const raw = [
    song?.songmid, song?.hash, song?.rid, song?.copyrightId,
    song?.meta?.songId, song?.meta?.hash, song?.meta?.rid, song?.meta?.copyrightId,
    song?.id,
  ]
  const out: string[] = []
  const source = String(song?.source || '')
  for (const value of raw) {
    const text = String(value ?? '').trim()
    if (!text) continue
    out.push(source && text.startsWith(`${source}_`) ? text.slice(source.length + 1) : text)
  }
  return out
}

/** 有任一字段符合该平台 ID 形态即算「有 ID」；占位 ID 一律按没有处理 */
export const hasPlatformSongId = (song: any): boolean => {
  const source = String(song?.source || '')
  const rule = NATIVE_ID_RULES[source]
  if (!rule) return true
  return collectSongIdCandidates(song).some(id => !PLACEHOLDER_SONG_ID_RE.test(id) && rule(id))
}
