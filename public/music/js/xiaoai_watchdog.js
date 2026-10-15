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
    };

    /** 新建一次投送对应的守望状态 */
    const createState = function (now) {
        return {
            phase: 'starting', // starting: 等待设备开始播放；playing: 已确认在播
            startedAt: Number(now) || Date.now(),
            lastPlayingAt: 0,
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
        const now = Number(sample && sample.at) || Date.now();
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

        // 2. 正在播放：记录心跳，接近结尾就提前切
        if (sample.playing) {
            state.phase = 'playing';
            state.lastPlayingAt = now;
            state.idleSince = null;
            if (hasRatio && ratio >= opts.prerollRatio) return done('advance', 'near-end');
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

    return { DEFAULTS: DEFAULTS, createState: createState, evaluate: evaluate };
});
