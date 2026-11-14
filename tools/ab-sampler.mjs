/**
 * A/B 对照采样器（跑在 NAS 的容器里，host 网络，每轮打 A/B 两个容器各一次取链）。
 *
 * 为什么要读响应体而不是只看 url：
 *   端到端有「汽水待补 / 换源」兜底，`!!json.url` 恒为 true → 成功率没有区分度，
 *   2026-11-14 第一轮 A/B 因此白跑两小时。真正能反映沉底/降权排序效果的是：
 *     attempts[]  服务端这一轮真实试过哪些源（长度=尝试源数，顺序=排序结果）
 *     attempts[0] 首个源是否命中
 *     switched    是否走了换源兜底（跨平台）
 *     downloadSource 最终落到哪个平台
 *   另外从 /health?probeDetail=1 统计当前「源×平台」降权在册数 dem_total，
 *   用来观察降权窗口（6h vs 30min）是否在预期时刻过期。
 *
 * 用法（全部走环境变量，默认值对齐 246 的 lxserver-ab 环境）：
 *   AB_TARGETS=kw,tx,wy     每轮按轮次轮换平台，别打 soda（该平台只有 3 个源且常年全败，无区分度）
 *   AB_BASE_A=http://127.0.0.1:17953
 *   AB_BASE_B=http://127.0.0.1:17954
 *   AB_OUT=/out             A/B 容器日志所在根目录（需挂载 /out/a/logs、/out/b/logs）
 *   AB_CSV=/out/report.csv
 *   AB_ROUNDS=24  AB_INTERVAL_MS=300000
 *
 * 输出列：ts,side,platform,http,ms,has_url,attempts_n,first_ok,switched,dl_source,dem_total,
 *        kw_dem,wy_dem,kg_dem,sink_lines,srcplat_lines,platform_window,errors_bytes,stdout_bytes
 * 注意 sink_lines / srcplat_lines / platform_window 是「累计快照」（每轮 grep -c 整个文件），
 * 统计时必须用 last - first 求增量，sum 它们没有意义。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROUNDS = Number(process.env.AB_ROUNDS || 24)
const INTERVAL_MS = Number(process.env.AB_INTERVAL_MS || 5 * 60 * 1000)
const OUT = process.env.AB_OUT || '/out'
const CSV = process.env.AB_CSV || path.join(OUT, 'report.csv')
const TARGETS = (process.env.AB_TARGETS || 'kw,tx,wy').split(',').map(s => s.trim()).filter(Boolean)
const SIDES = [
  { name: 'a', base: process.env.AB_BASE_A || 'http://127.0.0.1:17953' },
  { name: 'b', base: process.env.AB_BASE_B || 'http://127.0.0.1:17954' },
]
const SONGS = [
  { name: '晴天', singer: '周杰伦' },
  { name: '稻香', singer: '周杰伦' },
  { name: '演员', singer: '薛之谦' },
]

const header = 'ts,side,platform,http,ms,has_url,attempts_n,first_ok,switched,dl_source,dem_total,' +
  'kw_dem,wy_dem,kg_dem,sink_lines,srcplat_lines,platform_window,errors_bytes,stdout_bytes'
if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, header + '\n')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const getJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) })
  return r.ok ? r.json() : null
}

const playOnce = async (base, platform, song) => {
  const t0 = Date.now()
  try {
    const r = await fetch(`${base}/api/music/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        songInfo: { source: platform, name: song.name, singer: song.singer, copyrightId: '1', songmid: '1' },
        quality: '320k',
        noCache: true,
      }),
      signal: AbortSignal.timeout(120000),
    })
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* 非 JSON 视为失败 */ }
    const attempts = Array.isArray(body?.attempts) ? body.attempts : []
    return {
      http: r.status,
      ms: Date.now() - t0,
      hasUrl: !!(body && body.url),
      attemptsN: attempts.length,
      firstOk: attempts.length && attempts[0]?.status === 'success' ? 1 : 0,
      switched: body && body.switched ? 1 : 0,
      dlSource: (body && (body.downloadSource || body.sourceId || '')) || '',
    }
  } catch (e) {
    return { http: 0, ms: Date.now() - t0, hasUrl: false, attemptsN: -1, firstOk: 0, switched: 0, dlSource: '' }
  }
}

const readFlags = (health) => {
  const out = { kw: '', wy: '', kg: '', total: 0 }
  const details = health?.sourceProbe?.details || []
  for (const it of details) {
    if (it.demoted) out.total++
    if (it.sourceId === 'lx-animemusic.js' && Object.prototype.hasOwnProperty.call(out, it.platform)) {
      out[it.platform] = it.demoted ? '1' : '0'
    }
  }
  return out
}

const countLines = (file, re) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => re.test(l)).length
  } catch { return -1 }
}

const sizeOf = (file) => {
  try { return fs.statSync(file).size } catch { return -1 }
}

const runRound = async (round) => {
  const platform = TARGETS[round % TARGETS.length]
  const song = SONGS[round % SONGS.length]
  for (const side of SIDES) {
    const play = await playOnce(side.base, platform, song)
    const health = await getJson(`${side.base}/health?probeDetail=1`).catch(() => null)
    const flags = readFlags(health)
    const stdout = path.join(OUT, side.name, 'logs', 'stdout.log')
    const sink = countLines(stdout, /已排到队尾|排到队尾兜底/)
    const srcplat = countLines(stdout, /源×平台粒度/)
    const pw = countLines(stdout, /平台级故障窗口/)
    const errs = sizeOf(path.join(OUT, side.name, 'logs', 'errors.log'))
    const rows = [
      new Date().toISOString(), side.name, platform, play.http, play.ms, play.hasUrl ? 1 : 0,
      play.attemptsN, play.firstOk, play.switched, play.dlSource, flags.total,
      flags.kw, flags.wy, flags.kg, sink, srcplat, pw, errs, sizeOf(stdout),
    ]
    fs.appendFileSync(CSV, rows.join(',') + '\n')
    console.log(`round=${round} side=${side.name} pf=${platform} http=${play.http} ms=${play.ms} ` +
      `url=${play.hasUrl} try=${play.attemptsN} first_ok=${play.firstOk} switched=${play.switched} ` +
      `dl=${play.dlSource} dem=${flags.total}`)
  }
}

const main = async () => {
  console.log(`targets=${TARGETS.join('/')} rounds=${ROUNDS} interval=${INTERVAL_MS}ms csv=${CSV}`)
  for (let i = 0; i < ROUNDS; i++) {
    try { await runRound(i) } catch (e) { console.error('round failed', i, e?.message) }
    if (i < ROUNDS - 1) await sleep(INTERVAL_MS)
  }
  console.log('sampler done')
}

main()
