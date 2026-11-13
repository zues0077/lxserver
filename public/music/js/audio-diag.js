/**
 * [P-1471] 前端音频诊断上报
 * 目标：把「进度走但无声」这类只在浏览器里可观测的异常，变成服务端 app.log 里
 * 可检索的 [audio-diag] 行（服务端接收接口：POST /api/music/diag/audio）。
 *
 * 监控的事件（全部围绕「元素在播但出不来声」或「媒体加载失败」）：
 *  - audio:error                媒体加载/解码失败（MEDIA_ERR_*）
 *  - audio:stalled-while-playing 播放中数据停滞
 *  - ctx:suspended-while-playing 播放中 AudioContext 非 running（接管后无声的最典型信号）
 *  - ctx:interrupted-while-playing 同上（iOS 中断态）
 *  - audio:muted / volume-zero   播放中被静音/音量为 0
 *  - graph:src-without-analyser  Web Audio 图残缺（接管了但 analyser 丢失，无声前兆）
 *
 * 设计红线：
 *  - 本脚本自身的任何异常都必须被吞掉，绝不能影响播放；
 *  - 同一事件 60 秒内只上报一条（避免轮询刷屏）；
 *  - 只上报状态快照，不上传任何媒体内容或 URL 全文。
 */
;(function () {
  if (window.audioDiag) return // 防重复加载
  var DEDUP_MS = 60000
  var last = {}

  function snapshot() {
    var a = document.getElementById('audio-player')
    var c = window._sharedAudioContext
    return {
      ctxState: c ? c.state : null,
      srcNode: !!window._sharedAudioSourceNode,
      hasGraph: (window.soundEffects && window.soundEffects.hasGraph) ? window.soundEffects.hasGraph() : null,
      audio: a ? {
        paused: a.paused,
        cur: Math.round(a.currentTime * 100) / 100,
        dur: isFinite(a.duration) ? Math.round(a.duration * 10) / 10 : null,
        muted: a.muted,
        vol: a.volume,
        err: a.error && a.error.code,
        rs: a.readyState,
      } : null,
    }
  }

  function report(ev, data) {
    try {
      var key = ev + ':' + String((data && data.code) || '')
      var now = Date.now()
      if (last[key] && now - last[key] < DEDUP_MS) return
      last[key] = now
      var payload = Object.assign({ ev: ev, data: data || null, ua: navigator.userAgent.slice(0, 80) }, snapshot())
      payload.t = now
      console.warn('[audio-diag]', ev, data || '', 'ctx=' + payload.ctxState, 'audio=' + JSON.stringify(payload.audio))
      fetch('/api/music/diag/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      }).catch(function () {})
    } catch (e) { /* 诊断通道自身绝不能抛错影响播放 */ }
  }

  window.audioDiag = { report: report }

  var audio = document.getElementById('audio-player')
  if (!audio) return

  // 媒体层错误：必报
  audio.addEventListener('error', function () {
    report('audio:error', { code: audio.error && audio.error.code, msg: audio.error && audio.error.message })
  })
  // 播放中数据停滞（弱网/外链失效的常见表现）
  audio.addEventListener('stalled', function () {
    if (!audio.paused) report('audio:stalled-while-playing', {})
  })

  // 周期巡检（5s）：抓「元素在播但出不来声」的状态组合
  setInterval(function () {
    try {
      if (audio.paused || audio.ended) return
      var c = window._sharedAudioContext
      if (c && c.state !== 'running') report('ctx:' + c.state + '-while-playing', {})
      if (audio.muted) report('audio:muted', {})
      if (audio.volume === 0) report('audio:volume-zero', {})
      if (window._sharedAudioSourceNode && !window._sharedAudioAnalyser) report('graph:src-without-analyser', {})
    } catch (e) { /* ignore */ }
  }, 5000)
})()
