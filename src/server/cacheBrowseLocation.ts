import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 「浏览位置」与「缓存/下载位置」是两件事（上游 #461）。
 *
 * 本地音乐页切换「根目录 / 数据目录」只是想换个视角看文件，
 * 以前前端会把这个选择 POST 给 /api/music/cache/config，直接把用户的
 * 缓存/下载存放位置改掉——之后下载的歌会静默落到另一个目录。
 *
 * 这里用 AsyncLocalStorage 给单次请求挂一个临时的位置覆盖：
 * fileCache.getUserCacheLocation() 内部优先读它，从而十余个 cache 浏览接口
 * 不用逐个改签名就能读到「本次浏览想看哪个根」，且不触碰任何持久化配置。
 */
const browseLocation = new AsyncLocalStorage<'root' | 'data' | undefined>()

export const getCacheBrowseLocation = () => browseLocation.getStore()

/** 这些接口是「真的在改配置」，必须走持久化位置，不能被浏览态覆盖 */
const CONFIG_WRITE_PATHS = ['/api/music/cache/config', '/api/music/cache/rename']

export const withCacheBrowseLocation = <T>(requestUrl: string, callback: () => T): T => {
    if (!requestUrl.startsWith('/api/music/cache/') && !requestUrl.startsWith('/api/music/remaster/start')) {
        return browseLocation.run(undefined, callback)
    }

    let url: URL
    try {
        url = new URL(requestUrl, 'http://localhost')
    } catch {
        return browseLocation.run(undefined, callback)
    }

    const location = url.searchParams.get('browseLocation')
    const isBrowseRequest = url.pathname === '/api/music/remaster/start' ||
        (url.pathname.startsWith('/api/music/cache/') && !CONFIG_WRITE_PATHS.includes(url.pathname))

    return browseLocation.run(
        isBrowseRequest && (location === 'root' || location === 'data') ? location : undefined,
        callback,
    )
}
