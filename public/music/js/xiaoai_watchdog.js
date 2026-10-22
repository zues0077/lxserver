/*
 * 小爱投播「自动续播」的状态判定（纯逻辑，不碰 DOM）
 *
 * 音箱是独立设备，播放完一首不会告诉播放器「该下一首了」，
 * 因此需要播放器侧不断查询音箱状态，据此判断：
 *   - 还在播：什么都不做（进度过半时提前预解析下一首）
 *   - 接近结尾：提前切歌，让音箱几乎无缝衔接
 *   - 已经播完：切下一首
 *   - 被外部暂停/打断：不切歌，继续等待
 *
 * 判定规则独立成这个文件，便于用状态序列做单元测试。
 * 通过 XiaoAiWatchdog 暴露，xiaoai.js 只负责取状态与执行动作。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.XiaoAiWatchdog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    /**
     * 说明：
     *  - 设备上报的 position/duration 单位随固件而异，因此这里只用无量纲的比例（progressRatio），
     *    不出现在任何按毫秒/秒换算的判断里。
     *  - 「进度」缺失（老固件不返回 position）时走保守分支：只有在确认停止一段时间后才续播。
     */
    const DEFAULTS = {
        /** 投送后等待设备真正开始播放的上限，超过即放弃守望 */
        startTimeoutMs: 30 * 1000,
        /** 播放进度超过该比例就提前切歌（预判，减少两曲之间的空档） */
        prerollRatio: 0.98,
        /** 非播放状态下，进度超过该比例视为「已经播完」 */
        endRatio: 0.97,
        /** 没有进度信息时，停止状态需要持续这么久才认可为播完 */
        idleConfirmMs: 6000,
        /** 没有进度信息时，至少播放过这么久才认可停止判定（避免刚开始就被误判） */
        idleConfirmMinPlayMs: 8000,
        /** 长时间无人播放（例如用户语音暂停后离开）则停止守望，避免无限轮询 */
        idleGiveupMs: 4 * 60 * 1000,
        /** 连续查询失败上限（约 failLimit × 轮询间隔），超过即放弃 */
        failLimit: 6,
        /**
         * 已知曲目时长时，按墙钟提前这么久切歌（覆盖设备不报进度的机型）。
         *
         * 这个值要覆盖「决定切歌 → 新歌真正出声」的全部延迟：
         *   投送接口耗时（命中预解析时 ~0.6s，现解析时 2~4s）
         * + 小米云下发 + 音箱建立连接、读够起播缓冲（~1~2s）
         * 实测总延迟 2.5~6 秒，取 2 秒时每次都会晚一步——音箱已经把上一首从头拉回来播了。
         * 留太长会截掉上一首结尾，所以不能盲目加大，而是用服务端下发的 startDelayMs
         * （实测「投送→音箱来拉流」的延迟）自适应，见 effectiveLeadMs。
         */
        wallClockLeadMs: 4000,
        /** 自适应提前量的上限：投送特别慢时也不至于把上一首切掉太多 */
        wallClockLeadMaxMs: 10000,
        /** 墙钟预判的最短曲目时长，太短的音频不参与（避免误判） */
        wallClockMinDurationMs: 45000,
        /**
         * 从「投送成功」到「音箱真正出声」的预估延迟。
         *
         * 墙钟的「第 0 秒」如果取第一次采样到 playing 的时刻，会整体偏晚 0~一个轮询周期，
         * 结果就是每次都晚切一两秒（音箱已经把上一首重头拉出来了）。实测局域网投送
         * 到音箱开始拉流约 0.6 秒，再到出声约 1 秒，所以用「投送时刻 + 这个延迟」当锚点。
         */
        startLatencyMs: 1000,
        /** 实际起播比预估晚太多（缓冲慢、设备唤醒）时不再用预估锚点，退回首次采样时刻 */
        startLatencyToleranceMs: 5000,
        /** 相邻两次播放心跳的正常间隔上限，超过说明中间被暂停过，需顺延计时基准 */
        heartbeatGapMs: 8000,
        /**
         * 切歌提前量偏移（毫秒，正数更早切、负数更晚切）。
         * 由用户在设置里调，直接叠加在自适应提前量上：
         *  - 觉得「切早了、上一首结尾被截掉」→ 调成负数
         *  - 觉得「切晚了、两首之间有空档/上一首回放」→ 调成正数
         */
        transitionOffsetMs: 0,
        /** 偏移量的合法范围（±30 秒），超出就夹取，避免把切歌时机调飞 */
        transitionOffsetMaxMs: 30000,
        /** 提前量的下限：再小就没有意义了（音箱起播本身就要几百毫秒） */
        leadMinMs: 500,
        /** 设备上报位置比墙钟落后超过该值，视为缓冲/上报错位，用位置重锚 */
        positionDriftToleranceMs: 20000,
        /**
         * 收到「流被重拉」信号后，至少播这么久才认可为播完（防止开头重复请求误判）。
         *
         * 这个守卫原本是 5 秒，用来防「刚投送就被重拉」的误判。
         * 但现在服务端只在「整首已完整送达」之后才置这个信号（streamRounds.complete），
         * 误判风险已经消除；而 5 秒的等待意味着音箱会把上一首**再播 5 秒**——
         * 正好是用户抱怨的「切歌时回放上一首的一部分」。
         * 所以压到 1 秒：留一点余量给轮询间隔即可。
         */
        streamReplayGuardMs: 1000,
    };

    /**
     * 本次实际使用的提前量。
     *
     * 服务端会把「投送完成 → 音箱真的来拉这一路流」的实测延迟（startDelayMs）随状态下发，
     * 再加上设备起播缓冲（startLatencyMs），就是必须提前的量。
     * 没拿到实测值时退回默认值——第一首永远只能猜，从第二首开始就越来越准。
     *
     * 用户可再叠加一个偏移（transitionOffsetMs）：在自己的设备/网络上调到最顺，
     * 不必改代码。结果夹在 [leadMinMs, wallClockLeadMaxMs + 30s] 之间，调不飞。
     */
    const effectiveLeadMs = function (sample, opts) {
        const measured = Number(sample && sample.startDelayMs);
        let base = opts.wallClockLeadMs;
        if (Number.isFinite(measured) && measured > 0) {
            const wanted = measured + Number(opts.startLatencyMs) * 2;
            base = Math.min(Number(opts.wallClockLeadMaxMs) || 10000, Math.max(opts.wallClockLeadMs, wanted));
        }
        const offsetRaw = Number(opts.transitionOffsetMs);
        const offsetMax = Number(opts.transitionOffsetMaxMs) || 30000;
        const offset = Number.isFinite(offsetRaw) ? Math.max(-offsetMax, Math.min(offsetMax, offsetRaw)) : 0;
        const minLead = Number(opts.leadMinMs) || 500;
        return Math.max(minLead, base + offset);
    };

    /** 新建一次投送对应的守望状态 */
    const createState = function (now) {
        return {
            phase: 'starting', // starting: 等待设备开始播放；playing: 已确认在播
            // 注意不能用 `Number(now) || Date.now()`：测试与回放里 now 可能是 0，
            // 会被当成 falsy 换成真实时间戳，锚点就全乱了
            startedAt: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
            lastPlayingAt: 0,
            /** 本次播放的「第 0 秒」对应的墙钟时间，暂停后会自动顺延 */
            playingSince: 0,
            /** 最近一次拿到的曲目总时长（毫秒，设备或歌曲元数据提供） */
            durationMs: 0,
            idleSince: null,
            failCount: 0,
        };
    };

    /**
     * 根据最新一次状态采样推进状态机。
     * @param {Object} prev 上一次的 state（createState 的返回值或本次返回的 state）
     * @param {Object} sample {
     *   ok: 本次查询是否成功, at: 采样时间戳, playing: 是否在播放,
     *   hasProgress: 设备是否上报了进度, progressRatio: 0~1 或 -1,
     *   userPaused: 是否由播放器自身暂停（此时不应触发续播）
     * }
     * @param {Object} [options] 覆盖 DEFAULTS
     * @returns {{state: Object, action: 'none'|'advance'|'giveup', reason: string}}
     */
    const evaluate = function (prev, sample, options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        const state = Object.assign({}, prev || createState(Date.now()));
        // 同上：at 可能合法地为 0（测试/回放基准），不能让它被 falsy 判定换成真实时间
        const now = Number.isFinite(Number(sample && sample.at)) ? Number(sample.at) : Date.now();
        const done = function (action, reason) {
            return { state: state, action: action, reason: reason };
        };

        // 1. 查询失败：累计到上限才放弃，避免偶发超时打断续播
        if (!sample || sample.ok !== true) {
            state.failCount = (state.failCount || 0) + 1;
            if (state.failCount >= opts.failLimit) return done('giveup', 'status-unavailable');
            return done('none', 'request-failed');
        }
        state.failCount = 0;

        const ratio = Number(sample.progressRatio);
        const hasRatio = Number.isFinite(ratio) && ratio >= 0;
        const durationMs = Number(sample.durationMs) > 0 ? Number(sample.durationMs) : 0;
        const positionMs = Number(sample.positionMs) > 0 ? Number(sample.positionMs) : 0;
        if (durationMs > 0) state.durationMs = durationMs;

        // 2. 正在播放：记录心跳，接近结尾就提前切
        if (sample.playing) {
            // 从未播放过 / 中间被暂停过：把「第 0 秒」的基准向后顺延，避免暂停时长被算进已播
            if (!state.playingSince) {
                const assumed = Number(state.startedAt) + Number(opts.startLatencyMs);
                // 起播比预估慢很多时（冷启动、网络慢）就不能再用预估锚点，否则会提前切歌
                state.playingSince = now - assumed <= opts.startLatencyToleranceMs ? assumed : now;
            } else if (state.lastPlayingAt && now - state.lastPlayingAt > opts.heartbeatGapMs) {
                state.playingSince += now - state.lastPlayingAt;
            }

            // 设备上报位置明显落后于墙钟（缓冲、或暂停后状态没更新）：以设备位置为准重锚。
            // 但有两种情况绝不能重锚，否则自动切歌会被无限推迟：
            //  1) 已经接近结尾——某些音箱循环拉同一 URL 时会回报小的 position；
            //  2) 设备位置回到开头——那是音箱播完重拉（songloft-plugin-miot 的 canCalibrateAutoNextTimer 同理）。
            const elapsed = now - state.playingSince;
            const lead = effectiveLeadMs(sample, opts);
            const nearEnd =
                state.durationMs > 0 && elapsed >= state.durationMs - lead - opts.positionDriftToleranceMs;
            const rewoundToStart = positionMs > 0 && positionMs < 3000 && elapsed > 15000;
            if (positionMs > 0 && !nearEnd && !rewoundToStart && positionMs + opts.positionDriftToleranceMs < elapsed) {
                state.playingSince = now - positionMs;
            }

            state.phase = 'playing';
            state.lastPlayingAt = now;
            state.idleSince = null;

            // 最可靠的「播完」信号：音箱把我们这一路流拉完一遍后，会自己重拉同一个 URL。
            // 服务端在「新一轮请求建立连接」的那一刻就置位（不用等这轮传完，快几十秒），
            // 没这个信号就只能靠猜时长，晚了就会听到上一首重头播。
            // 加个最短播放守卫，避免投送后立刻的重复请求把一首歌误判成已播完。
            if (sample.streamReplay === true && now - state.startedAt >= opts.streamReplayGuardMs) {
                return done('advance', 'stream-replayed');
            }
            // 兜底：老版本服务端只有遍数没有 replay 标记
            if (Number(sample.streamFull) >= 2 && now - state.startedAt >= opts.streamReplayGuardMs) {
                return done('advance', 'stream-replayed');
            }

            if (hasRatio && ratio >= opts.prerollRatio) return done('advance', 'near-end');

            // 有可信时长就按墙钟预判：设备不上报进度时也能准点切歌，不必等 6 秒确认
            if (state.durationMs >= opts.wallClockMinDurationMs) {
                if (now - state.playingSince >= state.durationMs - lead) {
                    return done('advance', 'wall-clock');
                }
            }
            return done('none', 'playing');
        }

        // 3. 播放器自身暂停：用户明确要求停住，绝不自动切歌
        if (sample.userPaused) {
            state.idleSince = null;
            return done('none', 'user-paused');
        }

        // 4. 还在等设备开始播放
        if (state.phase === 'starting') {
            if (now - state.startedAt >= opts.startTimeoutMs) return done('giveup', 'start-timeout');
            return done('none', 'waiting-start');
        }

        if (state.idleSince === null) state.idleSince = now;

        // 5. 有进度且已到末尾 —— 播放完毕
        if (hasRatio && ratio >= opts.endRatio) return done('advance', 'finished');

        // 6. 设备不上报进度：只能靠「持续停止」判断，门槛更保守
        if (
            sample.hasProgress !== true &&
            now - state.idleSince >= opts.idleConfirmMs &&
            now - state.lastPlayingAt >= opts.idleConfirmMinPlayMs
        ) {
            return done('advance', 'finished-without-progress');
        }

        // 7. 长时间不播（外部暂停/打断后无人恢复）→ 收工
        if (now - state.lastPlayingAt >= opts.idleGiveupMs) return done('giveup', 'idle-timeout');

        return done('none', 'paused-externally');
    };

    return { DEFAULTS: DEFAULTS, createState: createState, evaluate: evaluate, effectiveLeadMs: effectiveLeadMs };
});
