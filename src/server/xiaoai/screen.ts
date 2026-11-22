/**
 * 「这台小爱有没有屏幕」——决定曲库未命中时用哪种投送方式。
 *
 * 放在独立文件里而不是塞进 service.ts：service 会拉起 client/stream 一堆依赖，
 * 单测只想验证判定逻辑时不该被那些副作用拖进来。
 *
 * 名单依据（2026-11-22 联网核对，非猜测）：
 *  - LX04：小爱触屏音箱（初代 7 英寸），实机在用；
 *  - X08A：小爱触屏音箱 Pro 8（米家说明书「产品型号 X08A」）；
 *  - X08C：Redmi 小爱触屏音箱 8（苏宁参数页「型号 X08C，显示屏：有屏幕」）；
 *  - X08E：Redmi 小爱触屏音箱 Pro 8（苏宁参数页「型号 X08E，显示屏：有屏幕」）；
 *  - X6A / X10A：小米智能家庭屏 6 / 10（淘宝配件页按「机器底部型号」列出，均为带屏）；
 *  - X8F：同代触屏固件代号，先保守列入。
 * 无屏机型核对：LX05A 万能遥控版、LX06 小爱音箱 Pro、S12 小米AI音箱、L15A 小米AI音箱，
 * 均无屏幕。名单外再按设备名里的「触屏/屏幕/智慧屏」兜底，避免漏新型号。
 * 注意 constants.ts 的 DEFAULT_MUSIC_API_MODELS 是「需要走 music API」的型号，
 * 与「有屏幕」不是同一件事，不能拿来当判据。
 */
export const DEFAULT_SCREEN_MODELS = ['LX04', 'X08A', 'X08C', 'X08E', 'X8F', 'X6A', 'X10A']

export const isScreenDevice = (hardware: string, name = '', models: string[] = DEFAULT_SCREEN_MODELS): boolean => {
  const hw = String(hardware || '').trim().toUpperCase()
  const list = (Array.isArray(models) ? models : []).map(item => String(item).trim().toUpperCase())
  if (hw && list.includes(hw)) return true
  return /触屏|屏幕|智慧屏/.test(String(name || ''))
}
