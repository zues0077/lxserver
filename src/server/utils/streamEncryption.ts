/**
 * 远端流「是否 CENC 加密」探测。
 *
 * 汽水的正式版权曲下发的 MP4 里，音轨 stsd 是 `enca` 而不是 `mp4a`/`fLaC`，
 * 并带 `senc` / `saiz` / `tenc` 保护 box —— 这类文件元数据（时长、码率）是**明文**的，
 * 所以光看响应体完全看不出问题，直接丢给 `<audio>` 才会在解码阶段失败。
 * 表现为「取链秒回、缓存秒写、播放器静音 → 换源 → 又命中同一个文件」的闭环。
 *
 * 判据：头部 256KB 里**同时**命中 `enca` 与（`senc` | `saiz` | `tenc`）。
 * 随机数据误判概率约 1e-9，实测多档音质（260k / 902k / 325k）结论一致。
 *
 * 探测失败（网络抖动 / 上游不支持 Range）一律按「非加密」处理 —— **宁可放过，不可误杀**，
 * 否则一次抖动就会把一首本来能播的歌判死。
 */

const streamEncryptionCache = new Map<string, { at: number; encrypted: boolean }>()
const STREAM_ENCRYPT_PROBE_BYTES = 256 * 1024
const STREAM_ENCRYPT_CACHE_MS = 5 * 60 * 1000

export const isEncryptedRemoteStream = async (url: string): Promise<boolean> => {
  const u = String(url || '')
  if (!/^https?:\/\//i.test(u)) return false
  const hit = streamEncryptionCache.get(u)
  if (hit && Date.now() - hit.at < STREAM_ENCRYPT_CACHE_MS) return hit.encrypted
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const resp = await fetch(u, {
      headers: { Range: `bytes=0-${STREAM_ENCRYPT_PROBE_BYTES - 1}`, 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    })
    if (!resp.ok && resp.status !== 206) return false
    const buf = Buffer.from(await resp.arrayBuffer())
    const encrypted = buf.includes('enca') && (buf.includes('senc') || buf.includes('saiz') || buf.includes('tenc'))
    streamEncryptionCache.set(u, { at: Date.now(), encrypted })
    if (encrypted) console.warn(`[加密流] 该直链为 CENC 加密音频（浏览器无法播放）: ${u.slice(0, 80)}`)
    return encrypted
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
