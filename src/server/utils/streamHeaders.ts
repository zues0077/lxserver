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

/**
 * B站系 CDN：必须带 bilibili 来源。
 *
 * ⚠️ 2026-11-02 实测补坑：B站直链经常先 302 到 `*.v.smtcdns.com`（回源加速域名），
 * 那一跳如果按「自身域名」生成 Referer 就是 403，表现正是「取链成功、播放/缓存全 403」。
 * 所以 smtcdns / szbdyd 这些跳转落地域名也一并算进 B站系。
 */
const BILIBILI_HOSTS = [
  /(^|\.)bilivideo\.com$/,
  /(^|\.)bilivideo\.cn$/,
  /(^|\.)bilivideo\.net$/,
  /(^|\.)bilibili\.com$/,
  /(^|\.)hdslb\.com$/,
  /(^|\.)v\.smtcdns\.com$/,
  /(^|\.)smtcdns\.com$/,
  /(^|\.)szbdyd\.com$/,
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
 *
 * @param originUrl 重定向链上的**首个**地址。CDN 302 到加速域名（如 `*.v.smtcdns.com`）后，
 *   防盗链策略仍然按原始地址那套走，必须沿用 originUrl 的判定，
 *   否则「B站直链 302 → 用落地域名做 Referer → 403」。
 */
export function buildStreamHeaders(
  targetUrl: string,
  extra: Record<string, string> = {},
  originUrl?: string,
): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_UA, ...extra }
  const host = hostOf(targetUrl)
  const origin = originUrl || targetUrl

  if (needsBilibiliReferer(targetUrl) || needsBilibiliReferer(origin)) {
    headers.Referer = 'https://www.bilibili.com/'
  } else if (forbidsReferer(targetUrl) || forbidsReferer(origin)) {
    // 抖音系：一个 Referer 都不能带
  } else if (host) {
    try {
      headers.Referer = new URL(targetUrl).origin
    } catch {
      // 非法 URL 就不带 Referer，交给上游判定
    }
  }
  return headers
}
