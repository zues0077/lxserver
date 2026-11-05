/**
 * 进程内单飞（single-flight）：同一个 key 的并发任务只真正跑一次，后来者共享同一个 Promise。
 *
 * 为什么需要它：
 *  - 转码产物路径是按「歌曲 + 音质」算出来的，同一首歌在几秒内被投送两次（前端补点、自动续播、
 *    多端同时点）时会并发进入 transcodeFileToMp3，两个 ffmpeg 写同一个 `.part`，
 *    先完成的一方 rename 走文件，另一方报 ENOENT 并整首重转，重转过程又把已经投送出去的文件覆盖掉，
 *    设备读到的就是半截/错位数据 —— 表现为「第一次推不放，第二次才好」（P-1140）。
 *  - 单飞让第二个调用方直接等第一个的结果，不再起第二个 ffmpeg。
 *
 * 边界：只在单进程内有效。本项目是单容器单进程（node 主进程），够用；将来多进程部署需换文件锁。
 */

const inflight = new Map<string, Promise<unknown>>()

export const runSingleFlight = <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const promise = (async () => {
    try {
      return await task()
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, promise)
  return promise
}

/** 当前在飞任务数（自检 / 单测用） */
export const inflightCount = (): number => inflight.size
