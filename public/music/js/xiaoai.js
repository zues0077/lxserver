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
    /** 进入歌曲最后这一段（毫秒）改为加密轮询，把「判定该切」到「真的切」的延迟压到一秒内 */
    const TAIL_WATCH_WINDOW_MS = 25000;
    /**
     * 尾部加密轮询的间隔。
     *
     * 不宜再往小调：每次查询都要经小米云往返，问得太密设备反而容易卡一下
     * （听感就是「突然静音一两秒」）。现在的切歌提前量已经能覆盖一个轮询周期。
     */
    const TAIL_WATCH_INTERVAL_MS = 1500;
    /** 进度超过该比例时提前预解析下一首，减少切歌等待 */
    const PREFETCH_RATIO = 0.6;
    /** 距离本首结束还有这么多毫秒时也提前预解析（设备不报进度时靠它，否则预取永远不触发） */
    const PREFETCH_LEAD_MS = 45000;
    /** 相邻两次自动切歌的最小间隔，避免投送异步期间被重复判定连切好几首 */
    const ADVANCE_COOLDOWN_MS = 2500;

    /** 防抖间隔；自动化测试可用 window.__XIAOAI_ADVANCE_COOLDOWN__ 覆盖成 0 */
    const advanceCooldownMs = () => {
        const override = Number(window.__XIAOAI_ADVANCE_COOLDOWN__);
        return Number.isFinite(override) && override >= 0 ? override : ADVANCE_COOLDOWN_MS;
    };

    const state = {
        config: null,
        target: localStorage.getItem(TARGET_KEY) === 'xiaoai' ? 'xiaoai' : 'local',
        autoNext: localStorage.getItem(AUTO_NEXT_KEY) !== '0',
        qrTimer: null,
        qrPolling: false,
        loginTab: 'qrcode',
        remotePaused: false,
        /** 暂停被降级为 stop（该机型不支持暂停），恢复时需重新投送 */
        remoteStopped: false,
        lastVolume: 50,
        /** 当前这一路流从第几秒开始（拖动进度条后非 0）：设备上报的是流内位置，加上它才是曲内位置 */
        seekOffsetMs: 0,
        /** 当前投送曲目的整首时长（毫秒）：拖动进度条换算秒数要用它，audio.duration 在投送模式下不可靠 */
        trackDurationMs: 0,
        /** 下一次投送的来源标记（自动续播时由 advanceToNext 设置），仅用于日志排查 */
        nextCaller: '',
    };

    /** 自动续播守望：投送成功后开始查询音箱状态，用于「自动下一首」 */
    const watch = {
        active: false,
        deviceId: '',
        song: null,
        state: null,
        hint: '',
        timer: null,
        /** 尾部加密轮询用的单次定时器 */
        tailTimer: null,
        worker: null,
        workerBroken: false,
        polling: false,
        prefetchedKey: '',
        lastAdvanceAt: 0,
        /** 服务端解析出的本首真实时长（毫秒）；比歌曲元数据 interval 可靠，优先用它 */
        audioDurationMs: 0,
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
            // t-bg-main / t-border-main / t-text-main 都带 !important，直接叠加 Tailwind 实心色会被压掉，
            // 结果就是「白字浅底」几乎看不见按钮。强调态先把主题类摘掉再上实心样式。
            const label = $('xiaoai-target-btn-text');
            const icon = $('xiaoai-target-btn-icon');
            if (label) label.textContent = active ? '切回本机播放' : '投送到小爱';
            else btn.textContent = active ? '切回本机播放' : '投送到小爱';
            if (icon) {
                icon.className = active
                    ? 'fa-solid fa-circle-stop'
                    : 'fa-solid fa-tower-broadcast';
            }
            btn.classList.toggle('t-bg-main', !active);
            btn.classList.toggle('t-border-main', !active);
            btn.classList.toggle('t-text-main', !active);
            btn.classList.toggle('hover:t-bg-track', !active);
            btn.classList.toggle('bg-amber-500', active);
            btn.classList.toggle('hover:bg-amber-600', active);
            btn.classList.toggle('border-amber-500', active);
            btn.classList.toggle('text-white', active);
            btn.classList.toggle('shadow-md', active);
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
        // 触屏歌词开关（老配置没有该字段时按开启处理，与服务端默认一致）
        const lyricsToggle = $('xiaoai-lyrics-toggle');
        if (lyricsToggle) lyricsToggle.checked = cfg.touchscreenLyrics === true;
        const cacheToggle = $('xiaoai-cache-toggle');
        if (cacheToggle) cacheToggle.checked = cfg.cacheBeforePlay === true;
        // 统一 mp3（默认开；服务端没装 ffmpeg 时自动降级，这里把状态说清楚）
        const mp3Toggle = $('xiaoai-mp3-toggle');
        if (mp3Toggle) mp3Toggle.checked = cfg.unifyMp3 !== false;
        const mp3Hint = $('xiaoai-mp3-hint');
        if (mp3Hint) {
            if (cfg.ffmpegAvailable === false) {
                mp3Hint.textContent = '服务端未检测到 ffmpeg，转码会自动跳过（按原格式投送）。';
                mp3Hint.className = 'text-xs text-amber-600 mt-1';
            } else {
                mp3Hint.textContent = '已是 mp3 的源不会重复转码；转码产物存入「歌曲缓存/xiaoai」，受权限与缓存限制约束。';
                mp3Hint.className = 'text-xs t-text-muted mt-1';
            }
        }
        const fadeInput = $('xiaoai-fadeout-input');
        if (fadeInput && document.activeElement !== fadeInput) fadeInput.value = Number(cfg.fadeOutSec ?? 1.5);
        // 音量回填：HTML 里写死的 50 只是占位，真实值来自上次保存的配置
        const volumeRange = $('xiaoai-volume-range');
        if (volumeRange && document.activeElement !== volumeRange) {
            const savedVolume = Number(cfg.volume);
            volumeRange.value = String(Number.isFinite(savedVolume) ? savedVolume : state.lastVolume);
        }
        const volumeValueEl = $('xiaoai-volume-value');
        if (volumeValueEl) {
            volumeValueEl.textContent = String(volumeRange ? volumeRange.value : state.lastVolume);
        }
        const offsetInput = $('xiaoai-transition-offset-input');
        if (offsetInput && document.activeElement !== offsetInput) offsetInput.value = Number(cfg.songTransitionOffset || 0);
        renderSleepTimer();
        renderSuggestedBase();
        renderTarget();
        renderLoginState();
        renderDevices();
    };

    /** 服务端探测到的局域网地址（仅用于「用检测到的地址」按钮） */
    let suggestedBase = '';

    /** 服务端探测到的局域网地址：仅在用户没填地址时提供一键填入 */
    const renderSuggestedBase = () => {
        const btn = $('xiaoai-use-lan-btn');
        if (!btn) return;
        const suggested = String(state.config?.suggestedBaseUrl || '');
        const configured = String(state.config?.serverBaseUrl || '').trim();
        suggestedBase = suggested;
        btn.classList.toggle('hidden', !suggested || !!configured);
        btn.title = suggested ? `填入 ${suggested}` : '';
    };

    const useSuggestedBase = () => {
        const suggested = suggestedBase || String(state.config?.suggestedBaseUrl || '').trim();
        const input = $('xiaoai-server-base-input');
        if (!suggested || !input) return;
        input.value = suggested;
        void saveConfig({ serverBaseUrl: suggested });
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
            const ok = data.results?.some(r => r.ok);
            // 音箱会把音量量化到固定档位（设 33 实际 35），服务端已回读真实值，
            // 这里以它为准，否则滑块和音箱实际音量会对不上。
            const applied = Number.isFinite(Number(data.volume)) && Number(data.volume) >= 0 ? Number(data.volume) : volume;
            if (ok) {
                state.lastVolume = applied;
                const valueEl = $('xiaoai-volume-value');
                if (range && String(range.value) !== String(applied)) range.value = String(applied);
                if (valueEl) valueEl.textContent = String(applied);
                // 记住上次设置：音箱本身不提供「读上次设了多少」，重开页面只能靠服务端配置回填
                void saveConfig({ volume: applied });
            }
            setMessage(
                ok
                    ? (applied !== volume ? `音量已设为 ${applied}（设备按 ${applied} 档位生效）` : `音量已设为 ${applied}`)
                    : '音量设置失败',
                !ok
            );
        } catch (e) {
            setMessage(e.message, true);
        }
    };

    /**
     * 用设备真实音量校正滑块。
     *
     * 音箱没有「查询我上次设置值」的接口，/status 里的 volume 才是权威值：
     * 用户可能用语音或遥控器改过音量，界面必须跟设备对齐，否则就是假状态。
     * 查询失败时保留持久化值，不报错打扰。
     */
    const syncVolumeFromDevice = async () => {
        if (!state.config?.configured) return;
        try {
            const data = await request('/status');
            const volume = Number(data?.volume);
            if (!data?.success || !Number.isFinite(volume) || volume < 0) return;
            const rounded = Math.round(volume);
            const range = $('xiaoai-volume-range');
            const valueEl = $('xiaoai-volume-value');
            if (range && document.activeElement !== range) range.value = String(rounded);
            if (valueEl) valueEl.textContent = String(range ? range.value : rounded);
            state.lastVolume = rounded;
            if (Number(state.config.volume) !== rounded) {
                state.config.volume = rounded;
                void saveConfig({ volume: rounded });
            }
        } catch (e) {
            console.warn('[小爱] 校正音量失败:', e.message);
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

    // ===== 定时关机 =====
    //
    // 服务端负责真正到点停止（页面关掉也有效）；这里只做设置与倒计时展示。
    // 语义是「停止播放」，不是断电——绝大多数小爱型号没有可用的关机指令。

    const sleepState = { status: null, timer: null };

    const renderSleepTimer = () => {
        const hint = $('xiaoai-sleep-hint');
        if (!hint) return;
        const s = sleepState.status;
        if (!s || !s.active) {
            hint.textContent = '未启用定时关机';
            hint.className = 'text-xs t-text-muted';
            return;
        }
        if (s.mode === 'minutes') {
            const ms = Math.max(0, Number(s.remainingMs) || 0);
            const total = Math.ceil(ms / 1000);
            const mm = String(Math.floor(total / 60)).padStart(2, '0');
            const ss = String(total % 60).padStart(2, '0');
            hint.textContent = `将在 ${mm}:${ss} 后停止播放`;
        } else {
            hint.textContent = `再播 ${Math.max(0, Number(s.songsLeft) || 0)} 首后停止播放`;
        }
        hint.className = 'text-xs text-emerald-600';
    };

    const loadSleepTimer = async () => {
        try {
            const data = await request('/sleep-timer');
            if (data.success) sleepState.status = data.sleepTimer;
        } catch (e) {
            /* 读取失败不影响主流程 */
        }
        renderSleepTimer();
    };

    /** 本地每秒刷新倒计时；到 0 时回服务端确认（以服务端为准） */
    const startSleepTick = () => {
        if (sleepState.timer) return;
        sleepState.timer = setInterval(() => {
            const s = sleepState.status;
            if (!s || !s.active) return renderSleepTimer();
            if (s.mode === 'minutes') {
                s.remainingMs = Math.max(0, (Number(s.endsAt) || 0) - Date.now());
                if (s.remainingMs <= 0) {
                    void loadSleepTimer();
                    return;
                }
            }
            renderSleepTimer();
        }, 1000);
    };

    const applySleepTimer = async mode => {
        try {
            const body = { mode };
            if (mode === 'minutes') body.minutes = Number($('xiaoai-sleep-minutes')?.value || 0);
            if (mode === 'songs') body.songs = Number($('xiaoai-sleep-songs')?.value || 0);
            const data = await request('/sleep-timer', body);
            if (!data.success) throw new Error(data.message || '设置失败');
            sleepState.status = data.sleepTimer;
            renderSleepTimer();
            setMessage(mode === 'off' ? '已关闭定时关机' : '定时关机已设置，到点会停止小爱播放');
        } catch (e) {
            setMessage(`定时关机设置失败：${e.message}`, true);
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

    /**
     * 音箱曲库版权闸门提示（unplayableCode===2）。
     *
     * 实测这个字段只说明「曲库把该 audioID 标成 VIP 资源」，不等于没声音：
     * 曲库命中 VIP 歌时，音箱照样来拉我们的直链、进度正常推进、时长等于我们的文件。
     * 之前不看实际拉流就断言「音箱不会出声」，属于误报。改成只在「确实没拉流」时警告。
     */
    const updateVipWarning = status => {
        const el = $('xiaoai-vip-warning');
        if (!el) return;
        const raw = status && status.raw;
        const psd = (raw && raw.play_song_detail) || {};
        if (psd.unplayableCode !== 2) {
            el.classList.add('hidden');
            return;
        }
        // 歌名优先用本地正在点播的这首：曲库没命中时设备回报的是占位曲名（Theme Of Loft）
        const localName = (watch.song && watch.song.name)
            || (typeof window.getCurrentSong === 'function' && (window.getCurrentSong() || {}).name)
            || '';
        const title = localName ? `《${localName}》` : (psd.title ? `《${psd.title}》` : '这首歌');
        const cp = psd.cp_origin ? `（来源：${psd.cp_origin}）` : '';
        const pulled = status.streamPulled === true;
        if (pulled) {
            el.textContent = `ℹ️ ${title}${cp} 在音箱曲库里属 VIP 资源（unplayableCode=2），` +
                '但音箱已正常拉取本机流并在播放，此提示只说明曲库版权归属，可忽略。';
        } else {
            el.textContent = `⚠️ ${title}${cp} 被音箱版权闸门判定为 VIP 不可播（unplayableCode=2），` +
                '且音箱未拉取本机流，可能不会出声。这是音箱曲库限制、非服务端问题，请换源或换歌。';
        }
        el.classList.remove('hidden');
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
        if (watch.tailTimer) {
            clearTimeout(watch.tailTimer);
            watch.tailTimer = null;
        }
        if (watch.worker) {
            try {
                watch.worker.postMessage({ type: 'stop' });
            } catch (e) {
                /* 忽略 */
            }
        }
    };

    /** 投送成功后开始守望（song 用于日志与界面提示，audioDurationMs 是服务端解析出的真实时长） */
    const startWatch = (song, audioDurationMs) => {
        stopWatch();
        if (!state.autoNext || !shouldRoute()) return;
        const deviceId = selectedDevices()[0];
        if (!deviceId) return;
        const watchdog = window.XiaoAiWatchdog;
        if (!watchdog || typeof watchdog.evaluate !== 'function') return;

        watch.active = true;
        watch.deviceId = deviceId;
        watch.song = song || null;
        watch.audioDurationMs = Number(audioDurationMs) > 0 ? Number(audioDurationMs) : 0;
        watch.state = watchdog.createState(Date.now());
        watch.prefetchedKey = '';
        watch.polling = false;
        startHeartbeat();
        setWatchHint('自动续播监听中…');
    };

    /**
     * 当前投送曲目的整首时长（毫秒，0 = 还没解析出来）。
     *
     * 投送模式下 audio 里装的不是这首歌，`audio.duration` 可能是上一首的甚至 NaN，
     * 所以拖动进度条换算秒数必须用这里的值，否则会跳到错误位置。
     */
    const durationMs = () => {
        const total = Number(state.trackDurationMs) > 0 ? Number(state.trackDurationMs) : 0;
        if (total > 0) return total;
        const streamed = Number(watch.audioDurationMs) > 0 ? Number(watch.audioDurationMs) : 0;
        return streamed > 0 ? streamed + Number(state.seekOffsetMs || 0) : 0;
    };

    /**
     * 记下「这一路流从第 N 秒开始」，并把已播时长基准换成剩余时长。
     *
     * 投送模式下进度不是靠 audio.currentTime（audio 已被 pause），而是 watchdog 用
     * 「now - playingSince」算已播时长、再和设备上报的流内位置比对。seek 后不同步，
     * watchdog 会以为已经播到接近曲尾，立刻触发自动切歌。
     *
     * 时长必须换成「剩余时长」：墙钟预判、预取触发都按它算；传整首会让音箱被提前掐掉。
     * 返回剩余时长（毫秒，0 = 时长未知）。
     */
    const setTimelineOffset = positionSec => {
        const sec = Math.max(0, Math.floor(Number(positionSec) || 0));
        state.seekOffsetMs = sec * 1000;
        if (!state.trackDurationMs && Number(watch.audioDurationMs) > 0) {
            state.trackDurationMs = Number(watch.audioDurationMs);
        }
        const totalMs = Number(state.trackDurationMs) > 0 ? Number(state.trackDurationMs) : 0;
        const remainingMs = totalMs > 0 ? Math.max(1000, totalMs - sec * 1000) : 0;
        if (remainingMs > 0) watch.audioDurationMs = remainingMs;
        return remainingMs;
    };

    /** 重置时间轴基准并按新时长重启守望（seek 后调用） */
    const resetTimeline = positionSec => {
        const remainingMs = setTimelineOffset(positionSec);
        if (!watch.active) return;
        if (watch.song) startWatch(watch.song, remainingMs);
    };

    /**
     * 把进度条画到第 positionSec 秒。
     *
     * 投送模式下 audio 是暂停的，timeupdate 不触发，进度条不会自己走；
     * 不主动画一次的话，松手后会看到指针弹回原位，以为没生效。
     */
    const paintProgress = positionSec => {
        const totalMs = durationMs();
        if (!(totalMs > 0)) return;
        const sec = Math.max(0, Math.min(Number(positionSec) || 0, totalMs / 1000));
        const bar = document.getElementById('progress-bar');
        if (bar) bar.style.width = `${((sec * 1000) / totalMs) * 100}%`;
        const cur = document.getElementById('time-current');
        if (cur) {
            cur.innerText = typeof formatTime === 'function'
                ? formatTime(sec)
                : `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
        }
        // 总时长也刷一遍：投送模式下 timeupdate 不触发，这里可能还停在上一首的时长
        const tot = document.getElementById('time-total');
        if (tot) {
            tot.innerText = typeof formatTime === 'function'
                ? formatTime(totalMs / 1000)
                : `${Math.floor(totalMs / 60000)}:${String(Math.floor((totalMs / 1000) % 60)).padStart(2, '0')}`;
        }
    };

    /**
     * 跳到第 positionSec 秒（投送模式）。
     *
     * 小爱没有 seek 指令，服务端只能复用 /play 时解析好的音源，重签一个「从第 N 秒开头」的
     * token 再投送一次，所以中间会有 0.3~1s 断音——这是设备能力上限，songloft 同样如此。
     */
    const seek = async positionSec => {
        const sec = Math.max(0, Math.floor(Number(positionSec) || 0));
        if (!shouldRoute()) return { success: false, message: '当前不是小爱播放' };
        const wasPaused = !!state.remotePaused;
        try {
            const result = await request('/seek', { positionSec: sec });
            if (result && result.success) {
                const done = Math.max(0, Number(result.seekSec) || sec);
                const stamp = `${Math.floor(done / 60)}:${String(done % 60).padStart(2, '0')}`;
                if (wasPaused) {
                    // 保持原来的暂停态：重新投送会让音箱开始播，补一次 pause
                    setTimelineOffset(done);
                    try {
                        await request('/pause', {});
                    } catch (e) {
                        /* 暂停失败就让音箱继续播，比卡住好 */
                    }
                    stopWatch();
                    setWatchHint(`已跳转到 ${stamp}（保持暂停）`);
                } else {
                    resetTimeline(done);
                    setWatchHint(`已跳转到 ${stamp}`);
                }
                paintProgress(done);
            } else {
                setWatchHint((result && result.message) || '跳转失败');
            }
            return result || { success: false };
        } catch (e) {
            console.warn('[小爱] 跳转失败', e);
            setWatchHint(`跳转失败：${e && e.message ? e.message : e}`);
            return { success: false, message: String((e && e.message) || e) };
        }
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
        // 投送是异步的：上一首的判定刚落地、新一首还没接上时，轮询很容易再判定一次，
        // 结果就是连切好几首。这里做个短间隔防抖。
        if (Date.now() - watch.lastAdvanceAt < advanceCooldownMs()) {
            console.info('[小爱] 自动续播请求过于频繁，已忽略');
            return;
        }
        const previousIndex = typeof currentIndex !== 'undefined' ? currentIndex : -1;
        stopWatch();
        watch.lastAdvanceAt = Date.now();
        console.info(`[小爱] 自动续播（${reason}）当前索引=${previousIndex}`);
        if (typeof window.playNext !== 'function') {
            setWatchHint('当前播放器不支持自动切歌');
            return;
        }
        // 标记这次投送来自自动续播，随 /play 上报给服务端日志，便于排查「切歌切错」
        state.nextCaller = `auto-next(${reason})`;

        // 单曲循环下 playNext 只会重播当前这首，自动续播就永远推不动。
        // 用户显式打开了「播放完自动下一首」，这里按列表顺序强制推进一首。
        let singleMode = false;
        try {
            singleMode = typeof playMode === 'string' && playMode === 'single';
        } catch (e) {
            singleMode = false;
        }
        if (singleMode && typeof currentPlaylist !== 'undefined' && currentPlaylist.length > 0) {
            const nextIndex = ((typeof currentIndex === 'number' ? currentIndex : -1) + 1) % currentPlaylist.length;
            const nextSong = currentPlaylist[nextIndex];
            if (nextSong && typeof window.playSong === 'function') {
                console.info(`[小爱] 单曲循环模式下按列表推进到第 ${nextIndex} 首`);
                setWatchHint('正在切换下一首…');
                try {
                    void window.playSong(nextSong, nextIndex);
                    return;
                } catch (e) {
                    console.error('[小爱] 强制切歌失败:', e.message);
                    state.nextCaller = '';
                }
            }
        }

        try {
            window.playNext();
            setWatchHint('正在切换下一首…');
        } catch (e) {
            state.nextCaller = '';
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

    /** 进度过半 / 距结束不足 PREFETCH_LEAD_MS 时，提前把下一首解析好，切歌时直接命中缓存 */
    const maybePrefetch = sample => {
        if (!sample.ok || !sample.playing) return;
        const duration = Number(sample.durationMs) > 0 ? Number(sample.durationMs) : 0;
        const elapsed = Number(sample.elapsedMs) > 0 ? Number(sample.elapsedMs) : 0;
        const byRatio = Number.isFinite(sample.progressRatio) && sample.progressRatio >= PREFETCH_RATIO;
        // 走 player_play_music 的机型根本不报进度（progressRatio 恒为 -1），
        // 只按比例判定的话预解析永远不会执行，切歌时就只能现解析音源，凭空多出 1~3 秒空档
        const byWallClock = duration > 0 && elapsed > 0 && duration - elapsed <= PREFETCH_LEAD_MS;
        if (!byRatio && !byWallClock) return;
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

    /**
     * 临近结尾时把采样加密到 TAIL_WATCH_INTERVAL_MS。
     *
     * 常态 3 秒一采样够用（省云端请求），但最后 20 秒里 3 秒的采样间隔本身就等于
     * 3 秒的切歌延迟：等我们发现「该切了」，音箱早把上一首从头拉回来播了几秒。
     * 这一段只在最后窗口生效，请求量增加有限。
     */
    const scheduleTailTick = sample => {
        if (watch.tailTimer) {
            clearTimeout(watch.tailTimer);
            watch.tailTimer = null;
        }
        if (!watch.active || !sample || !sample.ok || !sample.playing) return;
        const duration = Number(sample.durationMs) > 0 ? Number(sample.durationMs) : 0;
        const elapsed = Number(sample.elapsedMs) > 0 ? Number(sample.elapsedMs) : 0;
        if (!duration || !elapsed) return;
        if (duration - elapsed > TAIL_WATCH_WINDOW_MS) return;
        watch.tailTimer = setTimeout(() => {
            watch.tailTimer = null;
            void tick();
        }, TAIL_WATCH_INTERVAL_MS);
    };

    const applyWatchSample = sample => {
        if (!watch.active) return;
        const watchdog = window.XiaoAiWatchdog;
        if (!watchdog) return;

        // 切歌提前量偏移由用户在设置里调（秒 → 毫秒），叠加在服务端实测的自适应提前量上
        const offsetSec = Number(state.config && state.config.songTransitionOffset);
        const decision = watchdog.evaluate(watch.state, sample, {
            transitionOffsetMs: Number.isFinite(offsetSec) ? offsetSec * 1000 : 0,
        });
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
        scheduleTailTick(sample);
    };

    /** "03:45" → 225000 毫秒（老固件不报时长时用歌曲元数据兜底墙钟预判） */
    const parseIntervalMs = value => {
        const matched = /^(\d+):([0-5]?\d)$/.exec(String(value || '').trim());
        return matched ? (Number(matched[1]) * 60 + Number(matched[2])) * 1000 : 0;
    };

    /** 本首已播时长（毫秒）：有 playingSince 用它，否则退回「投送至今」 */
    const watchElapsedMs = () => {
        const state = watch.state;
        if (!state) return 0;
        if (state.playingSince) return Math.max(0, Date.now() - state.playingSince);
        const startedAt = Number(state.startedAt);
        return Number.isFinite(startedAt) && startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
    };

    const tick = async () => {
        if (!watch.active) return;
        if (watch.polling) {
            // 上一次查询还没回来（云端偶发慢），尾部窗口内补一次，别退回 3 秒节奏
            if (!watch.tailTimer) {
                watch.tailTimer = setTimeout(() => {
                    watch.tailTimer = null;
                    void tick();
                }, 300);
            }
            return;
        }
        if (!shouldRoute()) {
            stopWatch();
            return;
        }
        watch.polling = true;
        let sample;
        try {
            const data = await request(`/status?deviceId=${encodeURIComponent(watch.deviceId)}`);
            const deviceDuration = Number(data.durationMs) > 0 ? Number(data.durationMs) : 0;
            // 走 player_play_music 的机型，上报的时长取的是云端曲目元数据，未必是我们推的这首；
            // 歌曲元数据里的 interval 才是这次真正在放的音频长度，所以优先用它。
            const metaDuration = parseIntervalMs(watch.song && watch.song.interval);
            sample = {
                ok: data.success === true,
                at: Date.now(),
                playing: data.playing === true,
                paused: data.paused === true,
                hasProgress: data.hasProgress === true,
                progressRatio: typeof data.progressRatio === 'number' ? data.progressRatio : -1,
                // 时长优先级：服务端解析的真实文件时长 > 歌曲 interval 元数据 > 设备上报
                // （设备上报的是云端曲目元数据，interval 也常常和实际文件对不上）
                durationMs: watch.audioDurationMs || metaDuration || deviceDuration,
                // 距本次播放起点过了多久，供 watchdog 做墙钟预判、供预取按剩余时间触发。
                // 第一次采样时 playingSince 还没建立，用投送时刻兜底，否则短歌会来不及预取。
                elapsedMs: watchElapsedMs(),
                positionMs: typeof data.positionMs === 'number' ? data.positionMs : 0,
                // 服务端统计：本次投送这一路流被完整拉了几遍（音箱播完会自己重拉）
                streamFull: Number(data.streamFull) || 0,
                // 音箱已经完整拉过一遍、又开始新一轮 → 这一首确实播完了
                streamReplay: data.streamReplay === true,
                // 实测「投送完成 → 音箱来拉流」的延迟，watchdog 用它把切歌提前量调准
                startDelayMs: Number(data.startDelayMs) || 0,
                userPaused: !!state.remotePaused,
            };
            // 版权闸门提示：unplayableCode=2 时结合「是否已拉流」判断到底有没有声音
            updateVipWarning(data);
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

    /** 取播放器的队列索引与播放模式（可能为空，取不到就传 undefined） */
    const queueContext = meta => {
        const rawIndex = meta && Number.isFinite(meta.index)
            ? meta.index
            : (typeof currentIndex === 'number' ? currentIndex : undefined);
        let mode;
        try {
            mode = typeof playMode === 'string' ? playMode : undefined;
        } catch (e) {
            mode = undefined;
        }
        return { queueIndex: rawIndex, playMode: mode };
    };

    const pushSong = async (song, quality, meta) => {
        const devices = selectedDevices();
        const context = queueContext(meta);
        const data = await request('/play', {
            songInfo: song,
            quality: quality || undefined,
            deviceIds: devices,
            queueIndex: context.queueIndex,
            playMode: context.playMode,
            caller: (meta && meta.caller) || 'manual',
        });
        if (!data.success) throw new Error(data.message || '投送失败');
        // 投送成功时还没有播放状态，先按无状态处理（不提示），等守望第一次采样再判断
        updateVipWarning(data);
        return data;
    };

    const toggleTarget = async () => {
        if (state.target === 'xiaoai') {
            state.target = 'local';
            localStorage.setItem(TARGET_KEY, 'local');
            stopWatch();
            setWatchHint('已切回本机播放：音箱把正在播的这首放完就停');
            render();
            setMessage('已切回本机播放');
            // 告诉服务端「放完即止」：否则音箱播完会一直重拉同一个地址，
            // 而那首已经放完 → 单曲无限循环（实测每 3 分 38 秒重发一遍整首）
            void request('/detach', {}).catch(e => {
                console.warn('[小爱] 通知服务端切换本机失败:', e.message);
            });
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
    const playSongViaXiaoAi = async (song, index, quality, origPlaySong, explicitCaller) => {
        // 自动续播由 advanceToNext 提前打好标记，这里取走后清空，避免影响下一次手动点播
        const caller = explicitCaller || state.nextCaller || 'manual';
        state.nextCaller = '';
        console.info(`[小爱] 投送准备：${song && song.name}｜索引=${index}｜来源=${caller}`);
        // 投送到音箱时停掉浏览器本地播放，避免两边同时出声
        try {
            if (typeof audio !== 'undefined' && audio && !audio.paused) audio.pause();
        } catch (e) {
            /* 播放器未暴露 audio 时忽略 */
        }
        if (typeof origPlaySong === 'function') {
            try {
                await origPlaySong(song, index, quality, true);
            } catch (e) {
                console.warn('[小爱] 同步本地界面状态失败:', e.message);
            }
        }
        try {
            // 服务端可能要先校验音源、必要时把整首缓存下来，先给个提示免得看起来像卡住
            if (typeof setPlayerStatus === 'function') setPlayerStatus(`正在准备音频：${song.name || ''}`, false);
            const pushed = await pushSong(song, quality, { index, caller });
            markRemotePaused(false);
            state.remoteStopped = false;
            updatePlayButtonSafe(true);
            const via = pushed && pushed.via ? `（${pushed.via}）` : '';
            if (typeof setPlayerStatus === 'function') setPlayerStatus(`正在小爱音箱播放：${song.name || ''}${via}`, false);
            // 投送模式下 audio 里没有这首歌，duration 是上一首的甚至 NaN；
            // 拖动进度条换算秒数只能用服务端解析出的真实时长
            state.trackDurationMs = Number(pushed && pushed.audioDurationMs) || 0;
            state.seekOffsetMs = 0;
            // 投送成功后开始守望，用于自动下一首（带上服务端解析出的真实时长）
            startWatch(song, pushed && pushed.audioDurationMs);
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
                if (state.remoteStopped) {
                    // 该机型暂停被降级为 stop，媒体上下文已丢失，只能重新投送
                    const song = watch.song
                        || (typeof window.getCurrentSong === 'function' && window.getCurrentSong())
                        || (typeof currentPlaylist !== 'undefined' && currentIndex >= 0 ? currentPlaylist[currentIndex] : null);
                    if (!song) {
                        setMessage('没有可恢复的歌曲，请重新选择播放', true);
                        return;
                    }
                    await playSongViaXiaoAi(
                        song,
                        typeof currentIndex === 'number' ? currentIndex : -1,
                        song.quality || null,
                        typeof playSong === 'function' ? playSong : undefined,
                    );
                    state.remoteStopped = false;
                    return;
                }
                await request('/resume', {});
                markRemotePaused(false);
                updatePlayButtonSafe(true);
                // 恢复播放后重新开始守望（暂停期间不轮询，省掉无谓的云端请求）
                startWatch(watch.song);
            } else {
                const data = await request('/pause', {});
                const states = Array.isArray(data && data.results) ? data.results.map(item => item.state) : [];
                // 触屏/部分固件不支持 pause，服务端已降级为 stop，提示用户恢复时会重新投送
                state.remoteStopped = states.length > 0 && states.every(item => item === 'stopped');
                markRemotePaused(true);
                updatePlayButtonSafe(false);
                stopWatch();
                setWatchHint(
                    state.remoteStopped
                        ? '该机型不支持暂停，已停止播放（点播放会重新投送这首）'
                        : '已暂停，点播放恢复后继续自动续播'
                );
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
        // 定时关机：读取服务端状态并开始本地倒计时刷新（页面关掉服务端也照常到点停）
        void loadSleepTimer();
        startSleepTick();
        // 打开设置页时刷新一次登录态（服务端可能已自动续期），并用设备真实音量校正滑块
        const settingsEntry = document.querySelector('[data-view="settings"], a[onclick*="view-settings"]');
        if (settingsEntry) {
            settingsEntry.addEventListener('click', () => {
                void loadConfig().then(() => syncVolumeFromDevice());
            });
        }
    };

    window.XiaoAi = {
        shouldRoute,
        playSong: playSongViaXiaoAi,
        toggleRemotePlay,
        init,
        saveConfig: () => saveConfig({
            serverBaseUrl: ($('xiaoai-server-base-input')?.value || '').trim(),
            touchscreenLyrics: $('xiaoai-lyrics-toggle') ? !!$('xiaoai-lyrics-toggle').checked : false,
            cacheBeforePlay: $('xiaoai-cache-toggle') ? !!$('xiaoai-cache-toggle').checked : false,
            unifyMp3: $('xiaoai-mp3-toggle') ? !!$('xiaoai-mp3-toggle').checked : true,
            songTransitionOffset: Number($('xiaoai-transition-offset-input')?.value || 0),
            fadeOutSec: Number($('xiaoai-fadeout-input')?.value || 0),
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
        /** 投送模式下拖动进度条：跳到指定秒数（服务端重投一条以该秒开头的流） */
        seek,
        resetTimeline,
        /** 当前投送曲目的整首时长（毫秒），拖动进度条换算秒数用 */
        durationMs,
        reload: loadConfig,
        // 供调试/自动化测试查看守望状态
        watchState: () => ({
            active: watch.active,
            hint: watch.hint,
            deviceId: watch.deviceId,
            // 服务端实测的投送→拉流延迟（排查「切歌晚了一步」时看这个）
            startDelayMs: (watch.state && watch.state.startDelayMs) || 0,
            // 服务端解析出的真实时长与当前采用的时长（排查「切早/切晚」时看这两个值）
            audioDurationMs: watch.audioDurationMs,
            durationMs: (watch.state && watch.state.durationMs) || 0,
            seekOffsetMs: state.seekOffsetMs,
        }),
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
    window.xiaoAiUseSuggestedBase = useSuggestedBase;
    window.xiaoAiToggleTarget = toggleTarget;
    window.xiaoAiToggleAutoNext = toggleAutoNext;
    window.xiaoAiSleepTimer = applySleepTimer;
    window.xiaoAiReloadSleepTimer = loadSleepTimer;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        void init();
    }
})();
