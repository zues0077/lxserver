/*
 * 小爱音箱投播（前端模块）
 *
 * 设计上尽量不侵入播放器主体：
 *  - 全部 UI 逻辑放在这个文件里，通过 index.html 里的按钮调用
 *  - 只在 app.js 的 playSong / togglePlay 各加一处判断，命中「播放目标=小爱」时
 *    交给本模块处理（本模块再回调原 playSong 的 noPlay 模式来同步界面状态）
 *
 * 依赖 app.js 暴露的全局：playSong / togglePlay / updatePlayButton / currentPlaylist 等
 */
(function () {
    const API = '/api/music/xiaoai';
    const TARGET_KEY = 'lx_xiaoai_target';
    const AUTO_NEXT_KEY = 'lx_xiaoai_auto_next';
    /** 轮询音箱状态的间隔（毫秒） */
    const WATCH_INTERVAL = 3000;
    /** 进度超过该比例时提前预解析下一首，减少切歌等待 */
    const PREFETCH_RATIO = 0.6;

    const state = {
        config: null,
        target: localStorage.getItem(TARGET_KEY) === 'xiaoai' ? 'xiaoai' : 'local',
        autoNext: localStorage.getItem(AUTO_NEXT_KEY) !== '0',
        qrTimer: null,
        qrPolling: false,
        loginTab: 'qrcode',
        remotePaused: false,
        lastVolume: 50,
    };

    /** 自动续播守望：投送成功后开始查询音箱状态，用于「自动下一首」 */
    const watch = {
        active: false,
        deviceId: '',
        song: null,
        state: null,
        hint: '',
        timer: null,
        worker: null,
        workerBroken: false,
        polling: false,
        prefetchedKey: '',
        lastAdvanceAt: 0,
    };

    const $ = id => document.getElementById(id);

    const request = async (path, body) => {
        const options = { method: body === undefined ? 'GET' : 'POST' };
        if (body !== undefined) {
            options.headers = { 'Content-Type': 'application/json' };
            options.body = JSON.stringify(body);
        }
        const res = await fetch(`${API}${path}`, options);
        let data = null;
        try {
            data = await res.json();
        } catch (e) {
            data = null;
        }
        if (!data) throw new Error(`请求失败 (HTTP ${res.status})`);
        return data;
    };

    const setMessage = (text, isError) => {
        const el = $('xiaoai-login-message');
        if (!el) return;
        el.textContent = text || '';
        el.className = `text-xs break-all ${isError ? 'text-red-500' : 't-text-muted'}`;
    };

    /** 是否应该把播放交给小爱 */
    const shouldRoute = () => {
        if (state.target !== 'xiaoai') return false;
        if (!state.config) return false;
        return (state.config.selectedDeviceIds || []).length > 0;
    };

    const selectedDevices = () => (state.config?.selectedDeviceIds || []).slice();

    // ===== 配置与渲染 =====

    const loadConfig = async () => {
        try {
            const data = await request('/config');
            if (data.success) state.config = data.config;
        } catch (e) {
            console.warn('[小爱] 读取配置失败:', e.message);
        }
        // 目标已被关闭或没有设备时，自动回落到本机播放
        if (state.target === 'xiaoai' && !shouldRoute()) {
            state.target = 'local';
            localStorage.setItem(TARGET_KEY, 'local');
        }
        render();
    };

    const saveConfig = async (patch) => {
        try {
            const data = await request('/config', patch);
            if (data.success) state.config = data.config;
            render();
            return true;
        } catch (e) {
            setMessage(`保存失败: ${e.message}`, true);
            return false;
        }
    };

    const renderTarget = () => {
        const hint = $('xiaoai-target-hint');
        const btn = $('xiaoai-target-btn');
        const active = state.target === 'xiaoai';
        if (hint) {
            const devices = state.config?.devices || [];
            const names = selectedDevices()
                .map(id => devices.find(d => d.deviceID === id)?.name || id)
                .join('、');
            hint.textContent = active
                ? `当前：小爱音箱${names ? `（${names}）` : ''}`
                : '当前：本机浏览器';
        }
        if (btn) {
            btn.textContent = active ? '切回本机播放' : '投送到小爱';
            btn.classList.toggle('bg-emerald-500', active);
            btn.classList.toggle('text-white', active);
        }
    };

    const renderLoginState = () => {
        const el = $('xiaoai-login-state');
        if (!el) return;
        const cfg = state.config;
        if (!cfg) {
            el.textContent = '未登录';
            return;
        }
        if (cfg.loginState === 'valid') {
            el.textContent = `已登录 ${cfg.account || ''}（${cfg.loginMethod === 'qrcode' ? '扫码' : cfg.loginMethod === 'cookie' ? 'Cookie' : '账密'}）`;
        } else if (cfg.loginState === 'expired') {
            el.textContent = '登录态已过期，正在尝试自动续期';
        } else {
            el.textContent = '未登录';
        }
    };

    const renderDevices = () => {
        const box = $('xiaoai-device-list');
        if (!box) return;
        const devices = state.config?.devices || [];
        if (!devices.length) {
            box.innerHTML = '<p class="text-xs t-text-muted">登录后点击「刷新设备」获取设备列表</p>';
            return;
        }
        const selected = new Set(selectedDevices());
        box.innerHTML = devices
            .map(device => {
                const id = String(device.deviceID);
                const checked = selected.has(id) ? 'checked' : '';
                const meta = [device.hardware, device.roomName].filter(Boolean).join(' · ');
                return `<label class="flex items-center gap-2 py-1 cursor-pointer">
                    <input type="checkbox" class="w-4 h-4 accent-emerald-500" ${checked}
                        onchange="XiaoAi.toggleDevice('${id.replace(/'/g, "\\'")}', this.checked)">
                    <span class="text-sm t-text-main">${escapeHtml(device.name)}</span>
                    ${meta ? `<span class="text-xs t-text-muted">${escapeHtml(meta)}</span>` : ''}
                </label>`;
            })
            .join('');
    };

    const escapeHtml = value =>
        String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch]));

    const render = () => {
        const cfg = state.config;
        if (!cfg) return;
        const baseInput = $('xiaoai-server-base-input');
        if (baseInput && document.activeElement !== baseInput) baseInput.value = cfg.serverBaseUrl || '';
        const autoNextToggle = $('xiaoai-auto-next-toggle');
        if (autoNextToggle) autoNextToggle.checked = !!state.autoNext;
        renderTarget();
        renderLoginState();
        renderDevices();
    };

    // ===== 登录 =====

    const switchLoginTab = tab => {
        state.loginTab = tab;
        ;['qrcode', 'password', 'cookie'].forEach(name => {
            const pane = $(`xiaoai-login-pane-${name}`);
            const btn = $(`xiaoai-login-tab-${name}`);
            if (pane) pane.classList.toggle('hidden', name !== tab);
            if (btn) {
                const active = name === tab;
                btn.classList.toggle('bg-emerald-500', active);
                btn.classList.toggle('text-white', active);
            }
        });
    };

    const stopQrPolling = () => {
        if (state.qrTimer) {
            clearTimeout(state.qrTimer);
            state.qrTimer = null;
        }
        state.qrPolling = false;
    };

    const startQr = async () => {
        setMessage('正在获取二维码…');
        stopQrPolling();
        const box = $('xiaoai-qr-box');
        if (box) {
            box.classList.add('hidden');
            box.classList.remove('flex');
        }
        try {
            const data = await request('/login/qrcode', {});
            if (!data.success) throw new Error(data.message || '获取二维码失败');
            const img = $('xiaoai-qr-img');
            // 优先用服务端回传的 data URL（浏览器无需直连小米），回退到二维码直链
            if (img) img.src = data.qrcodeImage || data.qrcodeUrl || data.loginUrl;
            if (box) {
                box.classList.remove('hidden');
                box.classList.add('flex');
            }
            $('xiaoai-qr-status').textContent = '请使用米家 App 扫码';
            setMessage('');
            state.qrPolling = true;
            setTimeout(pollQr, 1500);
        } catch (e) {
            setMessage(e.message, true);
        }
    };

    const pollQr = async () => {
        if (!state.qrPolling) return;
        try {
            const data = await request('/login/qrcode/poll', {});
            const statusEl = $('xiaoai-qr-status');
            if (data.state === 'confirmed') {
                state.qrPolling = false;
                if (statusEl) statusEl.textContent = '登录成功';
                setMessage('登录成功');
                state.config = data.config || state.config;
                render();
                await loadConfig();
                await fetchDevices(true);
                return;
            }
            if (data.state === 'expired' || data.state === 'failed') {
                state.qrPolling = false;
                if (statusEl) statusEl.textContent = data.message || '二维码已失效';
                setMessage(data.message || '二维码已失效', true);
                return;
            }
            if (statusEl) statusEl.textContent = data.state === 'scanned' ? '已扫码，请在手机上确认' : '等待扫码…';
        } catch (e) {
            state.qrPolling = false;
            setMessage(e.message, true);
            return;
        }
        state.qrTimer = setTimeout(pollQr, 2000);
    };

    const applyLoginResult = async (data) => {
        const captchaBox = $('xiaoai-captcha-box');
        const verifyBox = $('xiaoai-verify-box');
        if (captchaBox) captchaBox.classList.toggle('hidden', data.state !== 'need_captcha');
        if (verifyBox) verifyBox.classList.toggle('hidden', data.state !== 'need_verify');
        if (data.state === 'need_captcha' && data.captchaImage) {
            const img = $('xiaoai-captcha-img');
            if (img) img.src = `data:image/png;base64,${data.captchaImage}`;
            setMessage('请输入图片中的验证码');
            return;
        }
        if (data.state === 'need_verify') {
            const hint = $('xiaoai-verify-hint');
            if (hint) hint.textContent = `需要二次验证（${data.verifyType === 'email' ? '邮箱' : '短信'}）：${data.verifyUrl || ''}`;
            setMessage('请输入收到的验证码');
            return;
        }
        if (data.success) {
            setMessage('登录成功');
            state.config = data.config || state.config;
            render();
            await loadConfig();
            await fetchDevices(true);
            return;
        }
        setMessage(data.message || '登录失败', true);
    };

    const loginPassword = async () => {
        const account = ($('xiaoai-account-input')?.value || '').trim();
        const password = $('xiaoai-password-input')?.value || '';
        if (!account || !password) return setMessage('请填写账号和密码', true);
        setMessage('正在登录…');
        try {
            await applyLoginResult(await request('/login/password', { account, password }));
            const pwdInput = $('xiaoai-password-input');
            if (pwdInput) pwdInput.value = '';
        } catch (e) {
            setMessage(e.message, true);
        }
    };

    const submitCaptcha = async () => {
        const captcha = ($('xiaoai-captcha-input')?.value || '').trim();
        if (!captcha) return setMessage('请输入验证码', true);
        try {
            await applyLoginResult(await request('/login/captcha', { captcha }));
        } catch (e) {
            setMessage(e.message, true);
        }
    };

    const submitVerify = async () => {
        const code = ($('xiaoai-verify-input')?.value || '').trim();
        if (!code) return setMessage('请输入验证码', true);
        try {
            await applyLoginResult(await request('/login/verify', { code }));
        } catch (e) {
            setMessage(e.message, true);
        }
    };

    const loginCookie = async () => {
        const userId = ($('xiaoai-userid-input')?.value || '').trim();
        const passToken = ($('xiaoai-passtoken-input')?.value || '').trim();
        if (!userId || !passToken) return setMessage('请填写 userId 与 passToken', true);
        setMessage('正在登录…');
        try {
            await applyLoginResult(await request('/login/cookie', { userId, passToken }));
        } catch (e) {
            setMessage(e.message, true);
        }
    };

    const logout = async () => {
        try {
            stopWatch();
            const data = await request('/logout', {});
            state.config = data.config || state.config;
            state.target = 'local';
            localStorage.setItem(TARGET_KEY, 'local');
            render();
            setMessage('已退出登录');
        } catch (e) {
            setMessage(e.message, true);
        }
    };

    // ===== 设备与音量 =====

    const fetchDevices = async (refresh) => {
        if (!state.config?.configured) return setMessage('请先登录小米账号', true);
        setMessage('正在获取设备列表…');
        try {
            const data = await request(`/devices${refresh ? '?refresh=1' : ''}`);
            if (!data.success) throw new Error(data.message || '获取设备失败');
            state.config = data.config || state.config;
            render();
            setMessage(`共发现 ${data.devices?.length || 0} 台设备`);
        } catch (e) {
            setMessage(e.message, true);
        }
    };

    const toggleDevice = async (deviceId, checked) => {
        const current = new Set(selectedDevices());
        if (checked) current.add(deviceId);
        else current.delete(deviceId);
        await saveConfig({ selectedDeviceIds: Array.from(current) });
        if (state.target === 'xiaoai' && !shouldRoute()) {
            state.target = 'local';
            localStorage.setItem(TARGET_KEY, 'local');
            render();
        }
    };

    const applyVolume = async () => {
        const range = $('xiaoai-volume-range');
        const volume = Number(range?.value || 0);
        try {
            const data = await request('/volume', { volume });
            setMessage(data.results?.some(r => r.ok) ? `音量已设为 ${volume}` : '音量设置失败', !data.results?.some(r => r.ok));
        } catch (e) {
            setMessage(e.message, true);
        }
    };

    const stop = async () => {
        try {
            stopWatch();
            await request('/stop', {});
            setWatchHint('已停止小爱播放');
            updatePlayButtonSafe(false);
        } catch (e) {
            setMessage(e.message, true);
        }
    };

    const updatePlayButtonSafe = playing => {
        try {
            if (typeof window.updatePlayButton === 'function') window.updatePlayButton(playing);
        } catch (e) {
            /* 忽略 */
        }
    };

    // ===== 自动续播守望 =====
    //
    // 音箱播完不会通知播放器，因此投送成功后由这里持续查询音箱状态：
    //   - 接近结尾 → 提前切歌（利用播放器的队列规则，含随机/单曲/顺序）
    //   - 已播完   → 切下一首
    //   - 被暂停   → 不动，继续等待
    // 心跳由 Worker 提供，避免页面切到后台后定时器被浏览器节流。

    const setWatchHint = text => {
        watch.hint = text || '';
        const el = $('xiaoai-watch-status');
        if (el) el.textContent = watch.hint || '自动续播待命（播放时生效）';
    };

    const startHeartbeat = () => {
        try {
            if (!watch.worker && !watch.workerBroken && typeof Worker === 'function') {
                watch.worker = new Worker('js/xiaoai_watch_worker.js');
                watch.worker.onmessage = event => {
                    if (event.data && event.data.type === 'tick') void tick();
                };
                watch.worker.onerror = () => {
                    // Worker 不可用（CSP 限制等）时退回主线程定时器
                    watch.workerBroken = true;
                    try {
                        if (watch.worker) watch.worker.terminate();
                    } catch (e) {
                        /* 忽略 */
                    }
                    watch.worker = null;
                    startFallbackTimer();
                };
            }
        } catch (e) {
            watch.workerBroken = true;
            watch.worker = null;
        }

        if (watch.worker) {
            try {
                watch.worker.postMessage({ type: 'start', interval: WATCH_INTERVAL });
                return;
            } catch (e) {
                watch.workerBroken = true;
                try {
                    watch.worker.terminate();
                } catch (err) {
                    /* 忽略 */
                }
                watch.worker = null;
            }
        }
        startFallbackTimer();
    };

    const startFallbackTimer = () => {
        if (watch.timer) clearInterval(watch.timer);
        watch.timer = setInterval(() => {
            void tick();
        }, WATCH_INTERVAL);
    };

    const stopWatch = () => {
        watch.active = false;
        if (watch.timer) {
            clearInterval(watch.timer);
            watch.timer = null;
        }
        if (watch.worker) {
            try {
                watch.worker.postMessage({ type: 'stop' });
            } catch (e) {
                /* 忽略 */
            }
        }
    };

    /** 投送成功后开始守望（song 仅用于日志与界面提示） */
    const startWatch = song => {
        stopWatch();
        if (!state.autoNext || !shouldRoute()) return;
        const deviceId = selectedDevices()[0];
        if (!deviceId) return;
        const watchdog = window.XiaoAiWatchdog;
        if (!watchdog || typeof watchdog.evaluate !== 'function') return;

        watch.active = true;
        watch.deviceId = deviceId;
        watch.song = song || null;
        watch.state = watchdog.createState(Date.now());
        watch.prefetchedKey = '';
        watch.polling = false;
        startHeartbeat();
        setWatchHint('自动续播监听中…');
    };

    /** 播放器自身暂停时不让守望继续判定，避免用户暂停被当成「播完」 */
    const markRemotePaused = paused => {
        state.remotePaused = !!paused;
    };

    const lockNextIndex = nextIndex => {
        // 投送模式下播放器自身的预读不会执行，随机模式也就不会「预先抽定」下一首。
        // 这里把预解析选中的索引钉住（播放器在每次换歌时会自动清空它），
        // 保证「预解析的那首」就是「真正播的那首」，缓存不会白解析。
        try {
            if (typeof playMode !== 'undefined' && playMode === 'random' && typeof preSelectedNextIndex !== 'undefined') {
                preSelectedNextIndex = nextIndex;
            }
        } catch (e) {
            /* 忽略 */
        }
    };

    const advanceToNext = reason => {
        const previousIndex = typeof currentIndex !== 'undefined' ? currentIndex : -1;
        stopWatch();
        watch.lastAdvanceAt = Date.now();
        console.info(`[小爱] 自动续播（${reason}）`);
        if (typeof window.playNext !== 'function') {
            setWatchHint('当前播放器不支持自动切歌');
            return;
        }
        try {
            window.playNext();
            setWatchHint('正在切换下一首…');
        } catch (e) {
            console.error('[小爱] 自动切歌失败:', e.message);
            setWatchHint(`自动切歌失败：${e.message}`);
            return;
        }

        // 顺序播放到末尾时 playNext 不会有任何动作，提示一下免得用户以为是卡住了
        if (typeof playMode !== 'undefined' && playMode === 'order') {
            setTimeout(() => {
                if (watch.active) return;
                if (typeof currentIndex !== 'undefined' && currentIndex === previousIndex) {
                    setWatchHint('已播放到歌单末尾，自动续播结束');
                }
            }, 3000);
        }
    };

    /** 进度过半后提前把下一首解析好，切歌时直接命中缓存 */
    const maybePrefetch = sample => {
        if (!sample.ok || !sample.playing) return;
        if (!Number.isFinite(sample.progressRatio) || sample.progressRatio < PREFETCH_RATIO) return;
        if (typeof window.getNextIndex !== 'function' || typeof currentPlaylist === 'undefined') return;
        const nextIndex = window.getNextIndex();
        if (nextIndex === -1 || !currentPlaylist[nextIndex]) return;
        const nextSong = currentPlaylist[nextIndex];
        const songKey = `${nextSong.source || ''}|${nextSong.songmid || nextSong.songId || nextSong.id || ''}`;
        if (!songKey || songKey === '|' || watch.prefetchedKey === songKey) return;
        watch.prefetchedKey = songKey;
        lockNextIndex(nextIndex);
        request('/prefetch', { songInfo: nextSong, quality: nextSong.quality || undefined }).catch(() => {
            /* 预解析失败不影响主流程，切歌时会再解析一次 */
        });
    };

    const applyWatchSample = sample => {
        if (!watch.active) return;
        const watchdog = window.XiaoAiWatchdog;
        if (!watchdog) return;

        const decision = watchdog.evaluate(watch.state, sample, {});
        watch.state = decision.state;

        // 设备确实在响时，纠正可能已经过期的暂停标记
        if (sample.ok && sample.playing && state.remotePaused) {
            markRemotePaused(false);
            updatePlayButtonSafe(true);
        }

        if (decision.action === 'advance') {
            advanceToNext(decision.reason);
            return;
        }
        if (decision.action === 'giveup') {
            const messages = {
                'start-timeout': '音箱没有开始播放，已停止自动续播',
                'status-unavailable': '无法读取音箱状态，已停止自动续播',
                'idle-timeout': '音箱已停止播放，自动续播结束',
            };
            stopWatch();
            setWatchHint(messages[decision.reason] || '自动续播已停止');
            return;
        }

        maybePrefetch(sample);

        if (!sample.ok) {
            setWatchHint('读取音箱状态失败，重试中…');
        } else if (!sample.playing) {
            setWatchHint('检测到音箱已暂停，等待恢复…');
        } else if (Number.isFinite(sample.progressRatio) && sample.progressRatio >= 0) {
            setWatchHint(`自动续播监听中（进度 ${Math.round(sample.progressRatio * 100)}%）`);
        } else {
            setWatchHint('自动续播监听中…');
        }
    };

    const tick = async () => {
        if (!watch.active || watch.polling) return;
        if (!shouldRoute()) {
            stopWatch();
            return;
        }
        watch.polling = true;
        let sample;
        try {
            const data = await request(`/status?deviceId=${encodeURIComponent(watch.deviceId)}`);
            sample = {
                ok: data.success === true,
                at: Date.now(),
                playing: data.playing === true,
                hasProgress: data.hasProgress === true,
                progressRatio: typeof data.progressRatio === 'number' ? data.progressRatio : -1,
                userPaused: !!state.remotePaused,
            };
        } catch (e) {
            sample = { ok: false, at: Date.now() };
        } finally {
            watch.polling = false;
        }
        applyWatchSample(sample);
    };

    const toggleAutoNext = checked => {
        state.autoNext = !!checked;
        localStorage.setItem(AUTO_NEXT_KEY, state.autoNext ? '1' : '0');
        if (!state.autoNext) {
            stopWatch();
            setWatchHint('自动续播已关闭');
        } else {
            setWatchHint('自动续播已开启，播放时生效');
        }
    };

    // ===== 播放路由 =====

    const pushSong = async (song, quality) => {
        const devices = selectedDevices();
        const data = await request('/play', {
            songInfo: song,
            quality: quality || undefined,
            deviceIds: devices,
        });
        if (!data.success) throw new Error(data.message || '投送失败');
        return data;
    };

    const toggleTarget = async () => {
        if (state.target === 'xiaoai') {
            state.target = 'local';
            localStorage.setItem(TARGET_KEY, 'local');
            stopWatch();
            setWatchHint('已切回本机播放，自动续播停止');
            render();
            setMessage('已切回本机播放');
            return;
        }
        if (!state.config?.configured) return setMessage('请先登录小米账号', true);
        if (!selectedDevices().length) return setMessage('请至少选择一台小爱设备', true);
        state.target = 'xiaoai';
        localStorage.setItem(TARGET_KEY, 'xiaoai');
        render();

        // 切换目标的同时立即把当前歌曲投过去（有歌才投）
        const song = (typeof window.getCurrentSong === 'function' && window.getCurrentSong())
            || (typeof currentPlaylist !== 'undefined' && currentIndex >= 0 ? currentPlaylist[currentIndex] : null);
        if (!song) {
            setMessage('播放目标已切换为小爱音箱，点击播放即可投送');
            return;
        }
        await playSongViaXiaoAi(
            song,
            typeof currentIndex === 'number' ? currentIndex : -1,
            song.quality || null,
            typeof playSong === 'function' ? playSong : undefined,
        );
    };

    /**
     * 播放器把播放交给小爱时调用。
     * 先用 noPlay 模式跑一遍原 playSong，让标题/封面/队列索引保持一致，再推送到音箱。
     */
    const playSongViaXiaoAi = async (song, index, quality, origPlaySong) => {
        if (typeof origPlaySong === 'function') {
            try {
                await origPlaySong(song, index, quality, true);
            } catch (e) {
                console.warn('[小爱] 同步本地界面状态失败:', e.message);
            }
        }
        try {
            await pushSong(song, quality);
            markRemotePaused(false);
            updatePlayButtonSafe(true);
            if (typeof setPlayerStatus === 'function') setPlayerStatus(`正在小爱音箱播放：${song.name || ''}`, false);
            // 投送成功后开始守望，用于自动下一首
            startWatch(song);
        } catch (e) {
            console.error('[小爱] 投送失败:', e.message);
            stopWatch();
            if (typeof setPlayerStatus === 'function') setPlayerStatus(`小爱投送失败：${e.message}`, false);
            state.target = 'local';
            localStorage.setItem(TARGET_KEY, 'local');
            render();
        }
    };

    /** 小爱播放目标下的播放/暂停 */
    const toggleRemotePlay = async () => {
        try {
            if (state.remotePaused) {
                await request('/resume', {});
                markRemotePaused(false);
                updatePlayButtonSafe(true);
                // 恢复播放后重新开始守望（暂停期间不轮询，省掉无谓的云端请求）
                startWatch(watch.song);
            } else {
                await request('/pause', {});
                markRemotePaused(true);
                updatePlayButtonSafe(false);
                stopWatch();
                setWatchHint('已暂停，点播放恢复后继续自动续播');
            }
        } catch (e) {
            console.error('[小爱] 播放控制失败:', e.message);
        }
    };

    const init = async () => {
        if (!$('settings-panel-xiaoai')) return;
        await loadConfig();
        const range = $('xiaoai-volume-range');
        const valueEl = $('xiaoai-volume-value');
        if (range && valueEl) {
            range.addEventListener('input', () => {
                valueEl.textContent = range.value;
            });
        }
        const autoNextToggle = $('xiaoai-auto-next-toggle');
        if (autoNextToggle) autoNextToggle.checked = !!state.autoNext;
        setWatchHint(state.autoNext ? '自动续播待命（播放时生效）' : '自动续播已关闭');
        // 打开设置页时刷新一次登录态（服务端可能已自动续期）
        const settingsEntry = document.querySelector('[data-view="settings"], a[onclick*="view-settings"]');
        if (settingsEntry) settingsEntry.addEventListener('click', () => { void loadConfig(); });
    };

    window.XiaoAi = {
        shouldRoute,
        playSong: playSongViaXiaoAi,
        toggleRemotePlay,
        init,
        saveConfig: () => saveConfig({
            serverBaseUrl: ($('xiaoai-server-base-input')?.value || '').trim(),
        }),
        switchLoginTab,
        startQr,
        loginPassword,
        submitCaptcha,
        submitVerify,
        loginCookie,
        logout,
        fetchDevices,
        toggleDevice,
        applyVolume,
        stop,
        toggleTarget,
        toggleAutoNext,
        reload: loadConfig,
        // 供调试/自动化测试查看守望状态
        watchState: () => ({ active: watch.active, hint: watch.hint, deviceId: watch.deviceId }),
    };

    // 对外暴露成全局函数，供 index.html 的内联事件调用
    window.xiaoAiSaveConfig = window.XiaoAi.saveConfig;
    window.xiaoAiSwitchLoginTab = switchLoginTab;
    window.xiaoAiStartQr = startQr;
    window.xiaoAiLoginPassword = loginPassword;
    window.xiaoAiSubmitCaptcha = submitCaptcha;
    window.xiaoAiSubmitVerify = submitVerify;
    window.xiaoAiLoginCookie = loginCookie;
    window.xiaoAiLogout = logout;
    window.xiaoAiFetchDevices = fetchDevices;
    window.xiaoAiApplyVolume = applyVolume;
    window.xiaoAiStop = stop;
    window.xiaoAiToggleTarget = toggleTarget;
    window.xiaoAiToggleAutoNext = toggleAutoNext;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        void init();
    }
})();
