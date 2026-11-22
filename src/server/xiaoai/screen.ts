/**
 * 「这台小爱有没有屏幕」——决定曲库未命中时用哪种投送方式。
 *
 * 放在独立文件里而不是塞进 service.ts：service 会拉起 client/stream 一堆依赖，
 * 单测只想验证判定逻辑时不该被那些副作用拖进来。
 *
 * 名单来自真机（LX04 小爱触屏音箱、X08A 触屏音箱 Pro8），再加名称兜底：
 * 「泰禾世家小爱触屏音箱」这类名字里带「触屏」的也能命中，避免名单漏新型号。
 * 注意 constants.ts 的 DEFAULT_MUSIC_API_MODELS 是「需要走 music API」的型号，
 * 与「有屏幕」不是同一件事，不能拿来当判据。
 */
export const DEFAULT_SCREEN_MODELS = ['LX04', 'X08A', 'X08E', 'X8F']

export const isScreenDevice = (hardware: string, name = '', models: string[] = DEFAULT_SCREEN_MODELS): boolean => {
  const hw = String(hardware || '').trim().toUpperCase()
  const list = (Array.isArray(models) ? models : []).map(item => String(item).trim().toUpperCase())
  if (hw && list.includes(hw)) return true
  return /触屏|屏幕|智慧屏/.test(String(name || ''))
}
