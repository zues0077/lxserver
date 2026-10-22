/**
 * 本地时区可读时间戳。
 *
 * 用于日志与审计记录，与 log4js 的 pattern 布局 `%d{yyyy-MM-dd HH:mm:ss.SSS}`
 * （同样是本地时区）保持一致，避免同一行 / 同一份日志里出现「UTC + 本地」双层时间。
 */
export const localTime = (date: Date = new Date()): string => {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`
}
