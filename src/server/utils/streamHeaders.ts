/**
 * 流媒体回源请求头（缓存下载 / 播放代理 / 重定向探测共用）。
 *
 * 教训：以前各处统一写 `Referer: <目标域名 origin>`，在 B 站这条链路上直接踩死：
 *  - B站系 CDN（*.bilivideo.com）只认 bilibili.com 来源。
 *    实测同一首 mp4a 音频轨：带 `Referer: https://www.bilibili.com/` → 206；
 *    不带、或带自身域名 → 403。表现就是「取链明明成功，下载/播放全 403」。
 *  - 抖音系 CDN（*.douyinvod.com，汽水走这里）相反：带 Referer 反而 403，必须不带（见 extraSources/soda.ts）。
 *
 * 所以 Referer 必须按目标域名分流，不要再在外面写死一个值。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** B站系 CDN：必须带 bilibili 来源 */
const BILIBILI_HOSTS = [
  /(^|\.)bilivideo\.com$/,
  /(^|\.)bilivideo\.cn$/,
  /(^|\.)bilivideo\.net$/,
  /(^|\.)bilibili\.com$/,
  /(^|\.)hdslb\.com$/,
]

/** 抖音系 CDN（汽水走这里）：带 Referer 反而 403，必须留空 */
const NO_REFERER_HOSTS = [
  /(^|\.)douyinvod\.com$/,
  /(^|\.)douyincdn\.com$/,
  /(^|\.)douyinpic\.com$/,
]

const hostOf = (targetUrl: string): string => {
  try {
    return new URL(targetUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 这个地址是不是必须带 B站 Referer 才能拉下来 */
export const needsBilibiliReferer = (targetUrl: string): boolean => {
  const host = hostOf(targetUrl)
  return !!host && BILIBILI_HOSTS.some((re) => re.test(host))
}

/** 这个地址是不是必须不带 Referer 才能拉下来 */
export const forbidsReferer = (targetUrl: string): boolean => {
  const host = hostOf(targetUrl)
  return !!host && NO_REFERER_HOSTS.some((re) => re.test(host))
}

/**
 * 构造回源请求头。extra 里的键会覆盖默认值（例如 Range）。
 */
export function buildStreamHeaders(targetUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_UA, ...extra }
  const host = hostOf(targetUrl)

  if (needsBilibiliReferer(targetUrl)) {
    headers.Referer = 'https://www.bilibili.com/'
  } else if (host && !forbidsReferer(targetUrl)) {
    try {
      headers.Referer = new URL(targetUrl).origin
    } catch {
      // 非法 URL 就不带 Referer，交给上游判定
    }
  }
  return headers
}
