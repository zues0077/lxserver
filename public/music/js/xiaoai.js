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
        /**
         * 暂停时的曲内位置（秒，0 = 没有可续播的位置）。
         * 该机型 pause 会降级成 stop、媒体上下文丢失，恢复时若直接重投只能整首从头；
         * 记下这个位置，恢复时走 /seek 从断点续播（手册 P-1116）。
         */
        pausePositionSec: 0,
        /** 已经提示过「这一路流转码失败、放不出来」，避免每次采样都弹一次 */
        streamFailedNoticed: false,
        lastVolume: 50,
        /** 当前这一路流从第几秒开始（拖动进度条后非 0）：设备上报的是流内位置，加上它才是曲内位置 */
        seekOffsetMs: 0,
        /** 当前投送曲目的整首时长（毫秒）：拖动进度条换算秒数要用它，audio.duration 在投送模式下不可靠 */
        trackDurationMs: 0,
        /** 下一次投送的来源标记（自动续播时由 advanceToNext 设置），仅用于日志排查 */
        nextCaller: '',
        /** 已经提示过的拉流守门动作（placeholder / url），避免每次轮询都弹一次 */
        guardNoticed: '',
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
        /** 最近一次(重)投递时刻（ms）：投递后协商冷却期内即使设备无进度也绝不误判跳歌 */
        lastDeliveryAt: 0,
        /** 服务端解析出的本首真实时长（毫秒）；比歌曲元数据 interval 可靠，优先用它 */
        audioDurationMs: 0,
        /**
         * 设备上报的进度/时长（毫秒）最近一次采样值。
         * 用途：投送后若服务端没给出时长、watchdog 也还没建立时间基准，进度条会算成 0 秒、
         * 一直显示 00:00 不动（实际设备在正常播）。用设备上报值兜底让进度立刻跟上。
         */
        devicePositionMs: 0,
        deviceDurationMs: 0,
        /**
         * 进度条平滑锚点：最近一次采样到的「设备位置 + 采样时刻」。
         * 设备 3 秒才上报一次位置，两次之间靠墙钟补；锚点存在时进度条以它为基准，
         * 不再直接用「投送至今」的墙钟（两者基准不同会让进度条来回跳）。
         */
        paintAnchorAt: 0,
        paintAnchorPosMs: 0,
        /** 设备明确没在播（协商/被外部暂停）时冻结进度条，不让墙钟继续往前推 */
        paintFrozen: false,
        /** 连续「设备非播放」的采样次数：起播协商期不算，避免误冻结 */
        nonPlayingSamples: 0,
        /**
         * 拖动进度条后「等设备换流」的时刻（ms）。
         * 拖动会重新投送一条从目标秒开始的新流，但设备在换流前仍会继续上报**上一条流**
         * 的流内位置（比如 225 秒）。把它当锚点会算成「目标 + 旧位置」，
         * 进度条直接冲到曲尾并卡死（实测：拖到 100 秒后页面显示满格、音箱在正常播）。
         */
        awaitReplayAt: 0,
        /** 拖动前设备上报的流内位置，用来判断设备是否已经换成新流（换流后位置必然变小） */
        seekBaseDevicePos: 0,
        /**
         * 起播宽限期（ms）：这段时间设备可能还没上报位置，进度条保持不动，
         * 不用墙钟硬推。投送新歌协议长（15s）；拖动只是重签一条流，1~3 秒就出声，
         * 用 15 秒会让用户以为「拖了之后进度条死了」。
         */
        startGraceMs: 15000,
    };

    /**
     * 进度条已经画到的秒数（单调递增，只在切歌/拖动时重置）。
     * 目的：设备位置每 3 秒校准一次，若校准值比上一帧小，绝不能把进度条往回拉
     * （否则用户会看到「进度条左右自己动」）。
     */
    let progressFloorSec = 0;

    /**
     * 投送/拖动之后的「起播宽限期」：这段时间设备可能还没上报位置，
     * 进度条保持不动，不要用墙钟硬推（否则切歌后进度条会先跑偏再被修正）。
     */
    const PROGRESS_START_GRACE_MS = 15000;

    /**
     * 拖动进度条后的「等换流」窗口：这段时间设备上报的位置可能还属于上一条流，
     * 一律不当锚点（新流的位置从 0 重新开始，换流成功的判据见 tick）。
     */
    const SEEK_REPLAY_WINDOW_MS = 20000;

    /**
     * 一次 status 采样能不能当进度锚点。
     *
     * 拖动进度条会重投一条「从目标秒开始」的新流，但设备换流前仍会继续上报**上一条流**
     * 的流内位置（例如 225 秒）。拿它当锚点就会被算成「目标 100 + 旧位置 225」，
     * 进度条一把冲到曲尾，之后又被「只前进不回退」的守卫钉死，再也回不来。
     * 新流的位置从 0 重新开始，所以「位置明显变小」就是换流完成的判据。
     *
     * @returns 'accept' 可以用 | 'wait' 还在等换流（丢弃本次采样）| 'expired' 等超时了，只能用
     */
    const judgeAnchorSample = (positionMs, awaitReplayAt, seekBaseDevicePos, now) => {
        const startedAt = Number(awaitReplayAt) || 0;
        if (startedAt <= 0) return 'accept';
        if (Number(now) - startedAt >= SEEK_REPLAY_WINDOW_MS) return 'expired';
        const pos = Number(positionMs) || 0;
        const base = Number(seekBaseDevicePos) || 0;
        // 新流刚起播，位置必然从 0 附近开始
        if (pos <= 3000) return 'accept';
        // 换流后位置会掉回比拖动前更小的值
        if (pos + 3000 < base) return 'accept';
        return 'wait';
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

    /**
     * 同步播放栏（底部播放条）里的小爱投送切换按钮状态。
     *
     * 之前切投送只能去设置面板点，用户每次都要进设置；现在播放栏常驻一个按钮，
     * 状态随 toggleTarget / 加载配置一起刷新：本地态显示「小爱」（点击投送），
     * 投送态显示「本机」（点击切回），与设置面板按钮同义。
     */
    const renderPlayerBarTarget = () => {
        const active = state.target === 'xiaoai';
        const sync = el => {
            if (!el) return;
            el.classList.toggle('text-emerald-600', active);
            el.classList.toggle('border-emerald-500', active);
            el.classList.toggle('text-gray-500', !active);
            el.classList.toggle('border-gray-300', !active);
            el.title = active ? '正在投送小爱音箱，点击切回本机' : '投送到小爱音箱';
        };
        sync($('player-xiaoai-btn'));
        sync($('player-xiaoai-btn-mobile'));
        const icon = $('player-xiaoai-icon');
        if (icon) icon.className = active ? 'fa-solid fa-circle-stop text-sm' : 'fa-solid fa-tower-broadcast text-sm';
        const text = $('player-xiaoai-text');
        if (text) text.textContent = active ? '本机' : '小爱';
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

    // ===== 投送状态角标 =====
    /**
     * 播放目标是音箱时，浏览器这边是刻意静音的（playSongViaXiaoAi 会 audio.pause()），
     * 用户「点了播放但一点声音都没有」，最容易误判成「没播出来 / 缓存坏了」。
     * 这里常驻一个小角标说明：正在投送给哪台设备、音量多少，点一下就能切回本机。
     */
    const routeBadge = { el: null, key: '' };

    const badgeDevices = () => {
        const devices = state.config?.devices || [];
        return selectedDevices()
            .map(id => devices.find(d => String(d.deviceID) === String(id))?.name || id)
            .join('、');
    };

    const badgeVolume = () => {
        const fromConfig = Number(state.config?.volume);
        if (Number.isFinite(fromConfig)) return Math.round(fromConfig);
        return Math.round(Number(state.lastVolume) || 0);
    };

    /**
     * 投送模式下强制静音本机 <audio>。
     *
     * 声音应该只从音箱出。但实测出现过「切歌后本机也出声」：某些路径（自动恢复播放、
     * 提前预加载）会把这个 audio 拉回播放态。这里按路由状态统一兜一层静音，
     * 只还原我们自己加的那次静音，不动用户手动点的静音。
     */
    let localMutedByCast = false;
    const syncLocalMute = () => {
        try {
            if (typeof audio === 'undefined' || !audio) return;
            if (state.target === 'xiaoai') {
                if (!audio.muted) {
                    audio.muted = true;
                    localMutedByCast = true;
                }
            } else if (localMutedByCast) {
                audio.muted = false;
                localMutedByCast = false;
            }
        } catch (e) {
            /* 播放器未暴露 audio 时忽略 */
        }
    };

    const renderRouteBadge = () => {
        // 每次路由渲染都同步一次本机静音态（投送=静音、本机=还原）
        syncLocalMute();
        if (state.target !== 'xiaoai') {
            if (routeBadge.el && routeBadge.el.parentNode) routeBadge.el.parentNode.removeChild(routeBadge.el);
            routeBadge.el = null;
            routeBadge.key = '';
            return;
        }
        const devices = badgeDevices();
        const volume = badgeVolume();
        // 音箱音量 10 基本听不见，很容易被当成「没声音 = 没播」，单独标出来
        const lowVolume = volume > 0 && volume < 20;

        // 角标结构只建一次：音量滑块作为常驻元素，拖动时不被 innerHTML 重建打断
        if (!routeBadge.el) {
            routeBadge.el = document.createElement('div');
            routeBadge.el.id = 'xiaoai-route-badge';
            document.body.appendChild(routeBadge.el);
            routeBadge.el.innerHTML = `
                <i class="fa-solid fa-tower-broadcast text-[11px]"></i>
                <span class="font-semibold whitespace-nowrap">正在投送小爱音箱</span>
                <span class="badge-devices opacity-70 truncate max-w-[10rem]" title="${escapeHtml(devices)}">${escapeHtml(devices)}</span>
                <span class="opacity-70 whitespace-nowrap">音量</span>
                <input type="range" id="xiaoai-badge-volume" min="0" max="100" value="${volume}"
                       class="w-24 h-1 accent-emerald-500 cursor-pointer align-middle" />
                <span class="badge-vol-value opacity-70 text-xs w-8 text-right">${volume}</span>
            `;
            const slider = routeBadge.el.querySelector('#xiaoai-badge-volume');
            slider.addEventListener('input', () => {
                const vEl = routeBadge.el.querySelector('.badge-vol-value');
                if (vEl) vEl.textContent = slider.value;
            });
            slider.addEventListener('change', () => {
                window.xiaoAiSetVolume(Number(slider.value));
            });
        } else {
            // 后续只更新设备名（音量在 input/change 中单独处理，不在此重建，避免打断拖动）
            const dEl = routeBadge.el.querySelector('.badge-devices');
            if (dEl) { dEl.textContent = devices; dEl.title = escapeHtml(devices); }
        }
        routeBadge.key = devices;
        routeBadge.el.className = 'fixed top-[4.5rem] left-1/2 -translate-x-1/2 z-[1004] max-w-[92vw] px-3 py-1.5 rounded-full shadow-lg border flex items-center gap-2 text-xs backdrop-blur-md '
            + (lowVolume
                ? 'bg-amber-50/95 dark:bg-amber-950/90 border-amber-400/70 text-amber-800 dark:text-amber-200'
                : 'bg-emerald-50/95 dark:bg-emerald-950/90 border-emerald-400/70 text-emerald-800 dark:text-emerald-200');
        // 滑块与音量对齐（拖动中除外，否则会抢走手势）
        const slider = routeBadge.el.querySelector('#xiaoai-badge-volume');
        if (slider && document.activeElement !== slider) slider.value = String(volume);
        const vEl = routeBadge.el.querySelector('.badge-vol-value');
        if (vEl && document.activeElement !== slider) vEl.textContent = String(volume);
    };

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
        // 推送格式策略（auto / always / off）；老配置没有 mp3Policy 时按 unifyMp3 推导
        const mp3Select = $('xiaoai-mp3-policy');
        const mp3Policy = cfg.mp3Policy || (cfg.unifyMp3 === false ? 'off' : 'auto');
        if (mp3Select) mp3Select.value = mp3Policy;
        // 兜底封面（曲库没命中时用哪个 audioID 的封面）
        const coverSelect = $('xiaoai-default-cover-select');
        if (coverSelect) coverSelect.value = cfg.defaultCoverAudioId || '1732418460076477549';
        const mp3Hint = $('xiaoai-mp3-hint');
        if (mp3Hint) {
            if (cfg.ffmpegAvailable === false) {
                mp3Hint.textContent = '服务端未检测到 ffmpeg，需要转码的格式会按原格式投送（部分格式设备放不出来）。';
                mp3Hint.className = 'text-xs text-amber-600 mt-1';
            } else if (mp3Policy === 'always') {
                mp3Hint.textContent = '所有源都会转成 mp3 再投送（最稳，但多一次转码耗时）。';
                mp3Hint.className = 'text-xs t-text-muted mt-1';
            } else if (mp3Policy === 'off') {
                mp3Hint.textContent = '不转码直接投送：m4a/ogg/wma 这类格式设备放不出来，仅建议排障时使用。';
                mp3Hint.className = 'text-xs text-amber-600 mt-1';
            } else {
                mp3Hint.textContent = '智能：音箱原生能播的格式（mp3/flac/wav）直接投，其余转 mp3；转码产物存入「歌曲缓存/xiaoai」。';
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
        renderPlayerBarTarget();
        renderLoginState();
        renderDevices();
        renderRouteBadge();
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
        renderRouteBadge();
    };

    /**
     * 直接把音箱音量设到指定值——投送角标上的滑块调用，不依赖设置面板的音量条。
     * 与 applyVolume 不同：applyVolume 读设置面板滑块；这里接收外部传入的数值，
     * 服务端回读真实档位后同步角标与设置面板两处 UI。
     */
    const setVolumeTo = async volume => {
        const vol = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
        try {
            const data = await request('/volume', { volume: vol });
            const ok = data.results?.some(r => r.ok);
            const applied = Number.isFinite(Number(data.volume)) && Number(data.volume) >= 0 ? Number(data.volume) : vol;
            state.lastVolume = applied;
            void saveConfig({ volume: applied });
            // 角标与设置面板滑块都对齐到设备真实档位
            renderRouteBadge();
            const range = $('xiaoai-volume-range');
            if (range && document.activeElement !== range) range.value = String(applied);
            const valueEl = $('xiaoai-volume-value');
            if (valueEl) valueEl.textContent = String(applied);
            setMessage(ok ? `音量已设为 ${applied}` : '音量设置失败', !ok);
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
        // 拉流守门已经动过手：曲库那一版不可播，服务端自动换了直链重发。
        // 这条优先于 unplayableCode 判断——用户会看到封面退回默认，得给个解释。
        const guard = status && status.streamGuardAction;
        if (guard) {
            el.textContent = guard === 'url'
                ? 'ℹ️ 音箱曲库里的这一版是 VIP 资源、放不了，已自动改用纯直链重发（触屏会退回默认封面）。'
                : 'ℹ️ 音箱曲库里的这一版是 VIP 资源、放不了，已自动改用默认封面并重发本机直链。';
            el.classList.remove('hidden');
            return;
        }
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
        stopProgressTicker();
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

    /**
     * 当前应该画到第几秒（曲内位置）。
     *
     * 优先级：设备上报位置（真相）> 墙钟推算（兜底）。
     * 设备上报的是「流内位置」，加 seekOffset 才是曲内位置（P-1116）。
     * 设备明确没在播时冻结，不让墙钟继续往前推——否则会出现「页面进度在走、音箱没声音」的假象。
     */
    const progressSecNow = () => {
        const offset = (Number(state.seekOffsetMs) || 0) / 1000;
        if (watch.paintFrozen) return progressFloorSec;
        const anchorPos = Number(watch.paintAnchorPosMs);
        const anchorAt = Number(watch.paintAnchorAt);
        if (anchorPos > 0 && anchorAt > 0) {
            // 两次采样之间用墙钟补：设备 3 秒才上报一次，不补就会「3 秒一跳」
            return offset + (anchorPos + Math.max(0, Date.now() - anchorAt)) / 1000;
        }
        // 还没拿到设备位置（刚切歌/刚拖动）：起播协商期内不要用墙钟硬推。
        // 墙钟是从「投送时刻」起算的，而设备要过几秒才真正出声——硬推会让进度条先跑到十几秒，
        // 等设备第一次上报再被单调守卫挡住，用户看到的就是「切歌后要等一会才定到正确位置」。
        // 宽限期过后仍无位置（老固件根本不上报）才退回墙钟，免得进度条彻底不走。
        const deliveredAt = Number(watch.lastDeliveryAt) || 0;
        const graceMs = Number(watch.startGraceMs) > 0 ? Number(watch.startGraceMs) : PROGRESS_START_GRACE_MS;
        if (deliveredAt > 0 && Date.now() - deliveredAt < graceMs) return progressFloorSec;
        return offset + watchElapsedMs() / 1000;
    };

    /**
     * 投送模式进度条：音箱独立播放，<audio> 被 pause，timeupdate 不触发，
     * 进度条会一直停在 00:00。这里起一个独立 ticker，按「设备位置锚点 + 墙钟补帧」
     * 平滑刷新进度条（与 3s 一次的设备轮询解耦，避免一跳一跳）。只在投送且守望活跃时画。
     *
     * 只前进不回退：设备位置每 3 秒校准一次，帧间隔内墙钟可能短暂超前，
     * 校准回来时会小于上一帧。直接画就会出现「进度条左右自己动」，
     * 所以这里维护 progressFloorSec，比它小的一律不画（等下一帧追上）。
     */
    let progressTicker = null;
    const startProgressTicker = () => {
        if (progressTicker) return;
        progressTicker = setInterval(() => {
            if (state.target !== 'xiaoai' || !watch.active) return;
            let sec = progressSecNow();
            const totalSec = durationMs() / 1000;
            if (totalSec > 0 && sec > totalSec) sec = totalSec;
            if (!(sec > progressFloorSec + 0.05)) return;
            progressFloorSec = sec;
            paintProgress(sec);
        }, 500);
    };
    const stopProgressTicker = () => {
        if (progressTicker) {
            clearInterval(progressTicker);
            progressTicker = null;
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
        // 重新守望时设备锚点作废（旧锚点属于上一段播放），单调守卫的起点由
        // setTimelineOffset / 投送入口负责设置，这里不动 progressFloorSec
        watch.paintAnchorAt = 0;
        watch.paintAnchorPosMs = 0;
        watch.paintFrozen = false;
        watch.nonPlayingSamples = 0;
        startHeartbeat();
        startProgressTicker();
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
        if (streamed > 0) return streamed + Number(state.seekOffsetMs || 0);
        // 服务端没给出时长时用设备上报值兜底：否则 durationMs()=0，paintProgress 直接 return，
        // 进度条永远不动（实际设备在正常播，表现为「播放栏无进度」）
        const device = Number(watch.deviceDurationMs) > 0 ? Number(watch.deviceDurationMs) : 0;
        return device > 0 ? device + Number(state.seekOffsetMs || 0) : 0;
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
        // 拖动/断点续播后进度条基准整体平移：单调守卫的起点也必须跟着移到新位置，
        // 否则会被「只前进」挡住，进度条卡在切歌前的旧位置
        progressFloorSec = sec;
        watch.paintAnchorAt = 0;
        watch.paintAnchorPosMs = 0;
        watch.paintFrozen = false;
        watch.nonPlayingSamples = 0;
        if (!state.trackDurationMs && Number(watch.audioDurationMs) > 0) {
            // 兜底也不能直接用 watch.audioDurationMs —— 拖动后它已经被换成「剩余时长」，
            // 写进整首时长会让下一次拖动的百分比换算整体偏短（越拖越短）。
            state.trackDurationMs = Number(watch.audioDurationMs) + sec * 1000;
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
    /**
     * 拖动进度条请求的串行化闸门。
     *
     * 触屏上快速连拖会并发发出多个 /seek，而每次 seek 都要重新切片+投送，耗时不同，
     * 响应回来的顺序未必等于请求顺序：先发的（例如 225s）晚回来就会把后发的（0s）覆盖掉，
     * 结果就是「页面按 225 秒显示、音箱从 0 秒在播」。
     * 这里保证同一时刻只有一个 /seek 在飞，排队期间的新目标只保留最后一次。
     */
    let seekSeq = 0;
    let seekChain = Promise.resolve();

    /**
     * 服务端返回的 seekSec 归一化（与服务端 xiaoai/seekGuard.ts 的 resolveSeekOffsetSec 同义）。
     * 服务端可能把目标改小（位置过期守卫 / 贴尾夹取），前端必须照它的结果走；
     * 只有字段缺失才退回请求值 —— 0 是合法结果，不能当假值。
     */
    const normalizeSeekSec = (serverSeekSec, requestedSec) => {
        const missing = serverSeekSec === null || serverSeekSec === undefined || serverSeekSec === '';
        const raw = Number(serverSeekSec);
        if (!missing && Number.isFinite(raw) && raw >= 0) return raw;
        const fallback = Number(requestedSec);
        return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
    };

    const seek = positionSec => {
        const sec = Math.max(0, Math.floor(Number(positionSec) || 0));
        if (!shouldRoute()) return Promise.resolve({ success: false, message: '当前不是小爱播放' });
        const seq = ++seekSeq;
        const task = seekChain.then(async () => {
            // 排队期间又拖了一次：这次目标已成中间值，直接丢掉，只做最后一次
            if (seq !== seekSeq) return { success: false, superseded: true };
            const wasPaused = !!state.remotePaused;
            // 记下拖动前的流内位置：设备换流后位置会明显变小，用它判断新流是否已开始
            watch.seekBaseDevicePos = Number(watch.devicePositionMs) || 0;
            try {
                const result = await request('/seek', { positionSec: sec });
                // 响应回来时已有更新的拖动：旧结果一律不落地（否则会把新位置覆盖掉）
                if (seq !== seekSeq) return { success: false, superseded: true };
                if (result && result.success) {
                    // 必须尊重服务端给的位置（服务端会做残留守卫、贴尾夹取）。
                    // 不能用 `Number(...) || sec`：服务端明确回 0 时 0 是假值，会被退回 sec，
                    // 前端 offset 多算 sec 秒，进度条直接冲到曲尾卡死（实测 23:14）。
                    const done = normalizeSeekSec(result.seekSec, sec);
                    const stamp = `${Math.floor(done / 60)}:${String(done % 60).padStart(2, '0')}`;
                    // 拖动 = 一次新的投送：重置起播宽限期、等换流窗口与设备位置缓存，
                    // 否则 tick 会拿上一条流的位置当锚点，进度条瞬间跑满
                    watch.lastDeliveryAt = Date.now();
                    watch.awaitReplayAt = Date.now();
                    // 拖动只重签一条流，1~3 秒就出声；宽限期用 4 秒，别让进度条干等 15 秒
                    watch.startGraceMs = 4000;
                    watch.devicePositionMs = 0;
                    watch.deviceDurationMs = 0;
                    watch.paintAnchorAt = 0;
                    watch.paintAnchorPosMs = 0;
                    watch.paintFrozen = false;
                    watch.nonPlayingSamples = 0;
                    if (wasPaused) {
                        // 保持原来的暂停态：重新投送会让音箱开始播，补一次 pause
                        setTimelineOffset(done);
                        // 拖动后仍是暂停态，断点位置要跟着更新，否则恢复时会续到拖动前的位置（P-1116）
                        state.pausePositionSec = done;
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
        }, () => undefined);
        // 链上任何一次失败都不能把后续拖动卡死
        seekChain = task.catch(() => undefined);
        return task;
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

        // 这一路流根本没内容（转码彻底失败，源音频损坏）：设备只会播小米占位曲。
        // 不能继续显示「播放中 + 进度不动」，直接提示并停下守望，让用户自己换歌（手册 P-1118）。
        // 设备已经报出位置 = 这路流确实有音频内容（真坏了只会播占位曲、位置恒 0）。
        // 服务端标记有极小的串曲机会（失败与本次投送的时序竞争），这一步用设备实况兜底，
        // 绝不把「明明在唱」的一首判成「放不出来」并停掉守望（2026-11-06 实测）。
        const deviceAudible = Number(sample.positionMs) > 0;
        if (sample.ok && sample.streamFailed === true && !state.streamFailedNoticed && !deviceAudible) {
            state.streamFailedNoticed = true;
            stopWatch();
            updatePlayButtonSafe(false);
            setWatchHint('投送失败：这首歌的音源已损坏（转码失败），音箱没有收到音频');
            if (typeof setPlayerStatus === 'function') setPlayerStatus('投送失败：音源损坏', false);
            if (typeof window.showToast === 'function') {
                window.showToast('error', '这首歌放不出来（音源损坏），请换一首或换个音源', 7000);
            }
            return;
        }

        // 切歌提前量偏移由用户在设置里调（秒 → 毫秒），叠加在服务端实测的自适应提前量上
        const offsetSec = Number(state.config && state.config.songTransitionOffset);
        const decision = watchdog.evaluate(watch.state, sample, {
            transitionOffsetMs: Number.isFinite(offsetSec) ? offsetSec * 1000 : 0,
            // 「我们已知时长」= 服务端解析出的真实文件时长（优先）或歌曲 interval 元数据，
            // 不含设备上报的时长——抖音等源设备常报错误/0 时长，拿它当已知时长会误判曲尾。
            // 时长未知时护栏据此禁用按比值/墙钟的提前切歌，只认权威的「流被重拉」信号。
            knownDurationMs: Number(sample.knownDurationMs) > 0 ? Number(sample.knownDurationMs) : 0,
            // 拉流守门进行中 / 刚(重)投递后的协商冷却：设备短暂无进度时绝不误判跳歌（手册 P-1110 续）
            guardBusy: sample.guardBusy === true,
            minDeliverySettleMs: 25000,
            deliveryAt: watch.lastDeliveryAt || 0,
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
        // 设备已经上报过位置就跟着它走：首次采样前/状态机未建立基准时，进度条否则会一直停在 00:00
        if (Number(watch.devicePositionMs) > 0) {
            if (!state || !state.playingSince) return Number(watch.devicePositionMs);
        }
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
            // 记下设备上报值：服务端时长缺失 / 状态机还没建立基准时，进度条靠它兜底，
            // 否则会一直显示 00:00 不动（实际设备在正常播）
            watch.devicePositionMs = Number(data.positionMs) > 0 ? Number(data.positionMs) : 0;
            // 进度条锚点：设备确实在播时，用它上报的位置重设「设备位置 + 采样时刻」。
            // 两次采样之间的 3 秒由 ticker 用墙钟补，避免「3 秒一跳」。
            // 设备明确没在播时：起播协商期不干预，持续非播放才冻结进度条
            // （否则墙钟会把进度条继续往前推，出现「页面在走、音箱没声」的假象）。
            if (data.playing === true) {
                watch.nonPlayingSamples = 0;
                // 设备确实在播就解冻。位置能不能当锚点是另一回事：换流瞬间 positionMs 还是 0，
                // 原来把「解冻」和「有有效位置」绑在一起，导致拖完进度条卡住不动。
                watch.paintFrozen = false;
                // 拖动后设备换流前上报的位置仍属于上一条流（如 225s），不能当锚点，
                // 否则会被算成「目标 100 + 旧位置 225」，进度条冲到曲尾后因单调守卫再也退不回来。
                // 新流的位置从 0 重新开始，所以「位置明显变小」就是换流完成的信号。
                const anchorVerdict = judgeAnchorSample(
                    watch.devicePositionMs,
                    watch.awaitReplayAt,
                    watch.seekBaseDevicePos,
                    Date.now(),
                );
                if (anchorVerdict !== 'wait') watch.awaitReplayAt = 0;
                const acceptAnchor = anchorVerdict !== 'wait';
                const totalMsForPos = durationMs();
                const posInTrack = watch.devicePositionMs + Number(state.seekOffsetMs || 0);
                const sanePos = acceptAnchor && watch.devicePositionMs > 0
                    && (totalMsForPos <= 0 || posInTrack <= totalMsForPos + 5000);
                if (sanePos) {
                    watch.paintAnchorPosMs = watch.devicePositionMs;
                    watch.paintAnchorAt = Date.now();
                }
            } else {
                watch.nonPlayingSamples = (Number(watch.nonPlayingSamples) || 0) + 1;
                const settled = Number(watch.lastDeliveryAt) > 0 && Date.now() - Number(watch.lastDeliveryAt) > 15000;
                if (settled && watch.nonPlayingSamples >= 2) watch.paintFrozen = true;
            }
            if (deviceDuration > 0) watch.deviceDurationMs = deviceDuration;
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
                // 「我们已知时长」：只取服务端解析/歌曲元数据，不含设备上报（抖音等设备常报 0/错）。
                // 护栏据此判断时长是否可信，决定能否按比值/墙钟提前切歌。
                knownDurationMs: Number(watch.audioDurationMs) > 0 ? watch.audioDurationMs : metaDuration,
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
                // 服务端最近 5 秒是否仍在向下游写字节：推流进行中时，设备「无进度」多半是瞬断，
                // 不让 watchdog 误判放完（手册 P-1110）
                serverSending: data.serverSending === true,
                // 拉流守门正在进行中（曲库 VIP 版不可播 → 服务端自动改直链重发）：
                // 这段时间设备短暂无进度/暂停是正常协商期，watchdog 据此不误判「放完了」跳歌。
                guardBusy: data.streamGuardBusy === true,
                // 这一路流转码彻底失败（源音频损坏）：设备只会播占位曲，
                // 不能继续当成「播放中」糊着（手册 P-1118）
                streamFailed: data.streamFailed === true,
                userPaused: !!state.remotePaused,
            };
            // 版权闸门提示：unplayableCode=2 时结合「是否已拉流」判断到底有没有声音
            updateVipWarning(data);
            // 拉流守门动过手（曲库那版放不了 → 自动改直链重发）：提示一次，
            // 否则用户只会看到「封面怎么突然变默认了」而不知道为什么
            const guard = data.streamGuardAction || '';
            if (guard && guard !== state.guardNoticed) {
                state.guardNoticed = guard;
                if (typeof window.showToast === 'function') {
                    window.showToast('info', '音箱曲库里的这版是 VIP 放不了，已自动改用本机直链重发', 6000);
                }
            }
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
        // 新的一次投送：上一首的守门提示作废
        state.guardNoticed = '';
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
            renderRouteBadge();
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
        renderRouteBadge();
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
        // 记录本次(重)投递时刻：拉流守门 fallback / URL 直链模式音箱缓冲都需要协商时间，
        // watchdog 在冷却期内即使设备无进度也绝不误判「放完了」跳歌（手册 P-1110 续）。
        watch.lastDeliveryAt = Date.now();
        // 新歌投送协议更长（曲库检索/取链/协商），宽限期恢复成 15 秒
        watch.startGraceMs = PROGRESS_START_GRACE_MS;
        watch.awaitReplayAt = 0;
        watch.seekBaseDevicePos = 0;
        // 切歌立刻把进度条 / 时间文案归零（手册 P-1110）：旧歌的位置会在 /play 异步返回前残留几秒，
        // 不立即归零会让客户端把上一首的进度（甚至误发成 seek）带进下一首。
        // 同时作废上一首的断点续播位置（P-1116），否则「暂停 A → 换歌 B → 点播放」会拿 A 的位置去续 B。
        state.seekOffsetMs = 0;
        state.pausePositionSec = 0;
        state.streamFailedNoticed = false;
        watch.devicePositionMs = 0;
        watch.deviceDurationMs = 0;
        // 换歌后进度条基准归零：单调守卫与设备锚点都必须清掉，否则新歌进度条会卡在上一首的位置
        progressFloorSec = 0;
        watch.paintAnchorAt = 0;
        watch.paintAnchorPosMs = 0;
        watch.paintFrozen = false;
        watch.nonPlayingSamples = 0;
        if (typeof paintProgress === 'function') paintProgress(0);
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
            // 明确告诉用户声音去了哪：页面是静音的，音箱音量又可能很低，
            // 不提示的话「点了播放没声音」会被当成播放失败。
            if (caller === 'manual' && typeof window.showToast === 'function') {
                const names = badgeDevices();
                const volume = badgeVolume();
                const low = volume > 0 && volume < 20;
                window.showToast('info', `已投送到小爱音箱${names ? `（${names}）` : ''}，音量 ${volume}${low ? '（偏低，建议调到 30 以上）' : ''}`, 4000);
            }
            renderRouteBadge();
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
            renderRouteBadge();
            render();
        }
    };

    /** 小爱播放目标下的播放/暂停 */
    const toggleRemotePlay = async () => {
        try {
            if (state.remotePaused) {
                if (state.remoteStopped) {
                    // 该机型暂停被降级为 stop，媒体上下文已丢失
                    const song = watch.song
                        || (typeof window.getCurrentSong === 'function' && window.getCurrentSong())
                        || (typeof currentPlaylist !== 'undefined' && currentIndex >= 0 ? currentPlaylist[currentIndex] : null);
                    if (!song) {
                        setMessage('没有可恢复的歌曲，请重新选择播放', true);
                        return;
                    }
                    // 断点续播（手册 P-1116）：媒体上下文没了，直接重投只能整首从头。
                    // 这里复用 /seek——服务端用上次 /play 解析好的音源重签「从断点开头」的流，
                    // 一次下发直接从暂停位置继续。音源已过期（期间换过别的歌）会返回 STALE_TRACK，回退整投。
                    const resumeSec = Math.max(0, Math.floor(Number(state.pausePositionSec) || 0));
                    if (resumeSec >= 3) {
                        try {
                            const ret = await request('/seek', {
                                positionSec: resumeSec,
                                expectSongName: String(song.name || ''),
                            });
                            if (ret && ret.success) {
                                const done = Math.max(0, Math.floor(Number(ret.seekSec) || resumeSec));
                                state.remoteStopped = false;
                                state.pausePositionSec = 0;
                                markRemotePaused(false);
                                updatePlayButtonSafe(true);
                                // 时间轴基准换成「从 done 秒开始」：watchdog 用墙钟算已播时长，
                                // 不同步会把断点位置当成已播，立刻误判曲尾切歌（P-1110 同款坑）。
                                setTimelineOffset(done);
                                watch.song = song;
                                startWatch(song, watch.audioDurationMs);
                                paintProgress(done);
                                if (typeof setPlayerStatus === 'function') setPlayerStatus('正在小爱音箱播放', true);
                                setWatchHint(`已从 ${Math.floor(done / 60)}:${String(done % 60).padStart(2, '0')} 继续播放`);
                                return;
                            }
                        } catch (e) {
                            console.warn('[小爱] 断点续播失败，回退整首重投:', e.message);
                        }
                    }
                    // 回退：没有断点 / 断点太靠前 / 音源已过期 → 整首重投
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
                if (typeof setPlayerStatus === 'function') setPlayerStatus('正在小爱音箱播放', true);
            } else {
                const data = await request('/pause', {});
                const states = Array.isArray(data && data.results) ? data.results.map(item => item.state) : [];
                // 触屏/部分固件不支持 pause，服务端已降级为 stop，提示用户恢复时会重新投送
                state.remoteStopped = states.length > 0 && states.every(item => item === 'stopped');
                // 记下暂停位置供「断点续播」用（手册 P-1116）：pause 成功时设备停在原地，
                // 降级成 stop 时媒体上下文丢失、恢复只能按这个位置重签流。
                // 必须赶在 stopWatch() 之前算——它会停掉 ticker，墙钟基准随即失效。
                state.pausePositionSec = Math.max(
                    0,
                    Math.floor((Number(state.seekOffsetMs) || 0) / 1000 + watchElapsedMs() / 1000),
                );
                markRemotePaused(true);
                updatePlayButtonSafe(false);
                stopWatch();
                if (typeof setPlayerStatus === 'function') setPlayerStatus('已暂停', false);
                setWatchHint(
                    state.remoteStopped
                        ? '该机型不支持暂停，已停止播放（点播放会从当前进度继续）'
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
        renderPlayerBarTarget();
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
            mp3Policy: $('xiaoai-mp3-policy') ? $('xiaoai-mp3-policy').value : 'auto',
            defaultCoverAudioId: $('xiaoai-default-cover-select') ? $('xiaoai-default-cover-select').value : undefined,
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
        /**
         * 是否「正在投送小爱音箱且非用户暂停」。
         * 投送时本地 <audio> 是 paused 的（声音走音箱），主播放器不能用它判断播放态，
         * 否则界面会一直显示「暂停中」。setPlayerStatus 据此修正 UI 播放态（手册 P-1113）。
         */
        isCasting: () => state.target === 'xiaoai' && !state.remotePaused,
        /** 投送目标当前是否真的在音箱里播放（供更精细的 UI 判断） */
        isCastingPlaying: () => state.target === 'xiaoai' && !state.remotePaused && !!watch.active,
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
    window.xiaoAiSetVolume = setVolumeTo;
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
