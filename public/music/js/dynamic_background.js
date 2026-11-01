/**
 * 动态背景特效引擎（轻量自包含，对齐上游 v2.1.4 的灵动动态特效思路）
 * 提供几种低开销的 canvas 粒子特效，叠加在歌曲播放详情页背景层。
 * 支持的特效：none / snow / sakura / particles / bubbles
 * 设计要点：
 *  - 仅挂载在 #view-player-detail 内部，不在其它页面渲染；
 *  - pointer-events:none，不拦截任何交互；
 *  - 页面隐藏（document.hidden）时自动休眠，省 CPU；
 *  - 切换特效或关闭时清理 rAF 与 DOM，避免泄漏。
 */
(function () {
  'use strict';

  var canvas = null;
  var ctx = null;
  var rafId = null;
  var particles = [];
  var currentEffect = 'none';
  var host = null;

  function ensureCanvas() {
    host = document.getElementById('view-player-detail');
    if (!host) return false;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'dbg-canvas';
      canvas.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;opacity:0.55;';
      // 插入到背景图与遮罩之下、但仍是 view 内部，避免遮挡控件
      var bgCover = document.getElementById('detail-bg-cover');
      if (bgCover && bgCover.parentNode === host) {
        host.insertBefore(canvas, bgCover.nextSibling);
      } else {
        host.insertBefore(canvas, host.firstChild);
      }
      ctx = canvas.getContext('2d');
    }
    resize();
    return true;
  }

  function resize() {
    if (!canvas || !host) return;
    var rect = host.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width));
    canvas.height = Math.max(1, Math.floor(rect.height));
  }

  function rand(min, max) { return Math.random() * (max - min) + min; }

  function makeParticle(effect, w, h) {
    switch (effect) {
      case 'snow':
        return {
          x: rand(0, w), y: rand(-h, 0), r: rand(1.5, 3.5),
          vy: rand(0.4, 1.4), vx: rand(-0.3, 0.3), a: rand(0.4, 0.9)
        };
      case 'sakura':
        return {
          x: rand(0, w), y: rand(-h, 0), r: rand(4, 8),
          vy: rand(0.6, 1.6), vx: rand(-0.6, 0.6), rot: rand(0, Math.PI * 2),
          vr: rand(-0.02, 0.02), a: rand(0.5, 0.9)
        };
      case 'particles':
        return {
          x: rand(0, w), y: rand(0, h), r: rand(1, 2.6),
          vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), a: rand(0.2, 0.7)
        };
      case 'bubbles':
        return {
          x: rand(0, w), y: rand(h, h + 40), r: rand(3, 9),
          vy: rand(-0.8, -0.3), a: rand(0.15, 0.45)
        };
      default:
        return null;
    }
  }

  function draw(effect) {
    if (!ctx || !canvas) return;
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.x += p.vx; p.y += p.vy;
      if (effect === 'sakura') { p.rot += p.vr; }
      // 回收 / 重生
      if (p.y > h + 20 || p.y < -20 || p.x < -20 || p.x > w + 20) {
        var np = makeParticle(effect, w, h);
        if (effect === 'bubbles') { np.x = rand(0, w); np.y = h + rand(0, 40); }
        particles[i] = np;
        continue;
      }
      ctx.globalAlpha = p.a;
      if (effect === 'sakura') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = '#ffd1e8';
        ctx.beginPath();
        ctx.ellipse(0, 0, p.r, p.r * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (effect === 'bubbles') {
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = effect === 'snow' ? '#ffffff' : '#a7f3d0';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function loop() {
    if (document.hidden) { rafId = requestAnimationFrame(loop); return; }
    // 视图从隐藏切到显示时尺寸会变化，自动校正避免拉伸
    if (host && canvas) {
      var r = host.getBoundingClientRect();
      if (r.width > 1 && Math.floor(r.width) !== canvas.width) {
        canvas.width = Math.floor(r.width);
        canvas.height = Math.floor(r.height);
      }
    }
    draw(currentEffect);
    rafId = requestAnimationFrame(loop);
  }

  function start(effect) {
    if (!effect || effect === 'none') { stop(); return; }
    currentEffect = effect;
    if (!ensureCanvas()) return;
    resize();
    var w = canvas.width, h = canvas.height;
    var count = effect === 'particles' ? 70 : 90;
    particles = [];
    for (var i = 0; i < count; i++) particles.push(makeParticle(effect, w, h));
    if (!rafId) loop();
  }

  function stop() {
    currentEffect = 'none';
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // 暴露到 window，供 app.js 调用
  window.DynamicBackground = {
    setEffect: function (effect) {
      if (typeof effect !== 'string') effect = 'none';
      if (effect === currentEffect) { if (effect !== 'none') start(effect); return; }
      start(effect);
    },
    stop: stop
  };

  // 窗口尺寸变化时重算画布
  window.addEventListener('resize', function () { if (canvas) resize(); });
})();
