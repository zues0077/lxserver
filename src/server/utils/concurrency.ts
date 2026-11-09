// 并发受限执行工具
//
// T9+ 八源聚合搜索用：8 个源同时打外部 API 会从单 IP 触发各厂限速（实测 8 源并发随机掉源），
// 用 worker 池把「同时进行的源数」限制在有限值，并配合退避重试，可显著降低掉源率。
// 该工具与 Subsonic 协议无关，纯函数、可单测。

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 以最多 `limit` 个并发 worker 处理 `items`，每个 item 交给 `worker` 处理一次。
 * - 不保证处理顺序，但保证每个 item 都被处理一次；
 * - `worker` 内部抛错不影响其他 item（由调用方自行在 worker 内 try/catch）；
 * - `items` 为空时直接返回，不抛错。
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const effectiveLimit = Math.max(1, Math.min(limit, items.length))
  let cursor = 0
  const runners = Array.from({ length: effectiveLimit }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
}
