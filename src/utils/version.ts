import fs from 'node:fs'
import path from 'node:path'

let cached: string | null = null

/**
 * 读取 package.json 中的应用版本号，供 /health 等接口展示。
 * 多候选路径兜底：容器里 cwd 与编译产物位置可能不同。
 */
export const getAppVersion = (): string => {
  if (cached !== null) return cached
  const candidates = [
    path.join(process.cwd(), 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
    path.join(__dirname, '..', 'package.json'),
  ]
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'))
      if (pkg && pkg.version) {
        cached = String(pkg.version)
        return cached
      }
    } catch { /* 尝试下一个候选路径 */ }
  }
  cached = 'unknown'
  return cached
}
