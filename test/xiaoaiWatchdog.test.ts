import { test } from 'node:test';
import assert from 'node:assert/strict';
import mod from '../public/music/js/xiaoai_watchdog.js';

const { evaluate, createState } = mod as any;

const BASE = 1_000_000;

// 已起播状态：playingSince 钉在 BASE，避免 evaluate 内部重锚，便于按 elapsed 精确断言
function playingState(over: any = {}) {
    const s = createState(BASE);
    s.phase = 'playing';
    s.startedAt = BASE;
    s.playingSince = BASE;
    // 不预设 lastPlayingAt：否则 evaluate 的心跳重锚逻辑会把 playingSince 顺延到 now，
    // 导致 elapsed 被算成 0，无法按「已播时长」断言。单样本测试里它就是 BASE + elapsed。
    s.durationMs = 0;
    return Object.assign(s, over);
}

function sample(elapsedMs: number, over: any = {}) {
    return Object.assign({
        ok: true,
        at: BASE + elapsedMs,
        playing: true,
        paused: false,
        hasProgress: true,
        progressRatio: -1,
        durationMs: 0,
        positionMs: 0,
        streamReplay: false,
        streamFull: 0,
        startDelayMs: 0,
        userPaused: false,
    }, over);
}

test('时长未知(抖音)：比值接近 1.0 也不得误判曲尾提前切歌', () => {
    const state = playingState();
    const d = evaluate(state, sample(16000, { progressRatio: 0.99 }), { knownDurationMs: 0 });
    assert.equal(d.action, 'none', `应为 none，实际 ${d.action}/${d.reason}`);
});

test('时长未知(抖音)：流被重拉但已播不足下限，不当作播完', () => {
    const state = playingState();
    const d = evaluate(state, sample(16000, { streamReplay: true }), { knownDurationMs: 0 });
    assert.equal(d.action, 'none', `应为 none，实际 ${d.action}/${d.reason}`);
});

test('时长未知(抖音)：流被重拉且已播过下限，认作播完切下一首', () => {
    const state = playingState();
    const d = evaluate(state, sample(25000, { streamReplay: true }), { knownDurationMs: 0 });
    assert.equal(d.action, 'advance');
    assert.equal(d.reason, 'stream-replayed');
});

test('已知时长：正常曲目比值接近 1.0 触发 near-end 切歌（回归保护）', () => {
    const state = playingState({ durationMs: 200000 });
    const d = evaluate(state, sample(180000, { progressRatio: 0.99, durationMs: 200000 }), { knownDurationMs: 200000 });
    assert.equal(d.action, 'advance');
    assert.equal(d.reason, 'near-end');
});

test('已知时长：刚起播就重拉（token 过期/抖动）不算播完', () => {
    const state = playingState({ durationMs: 200000 });
    const d = evaluate(state, sample(5000, { streamReplay: true, durationMs: 200000 }), { knownDurationMs: 200000 });
    assert.equal(d.action, 'none', `应为 none，实际 ${d.action}/${d.reason}`);
});

test('已知时长：曲终附近重拉认作播完', () => {
    const state = playingState({ durationMs: 200000 });
    const d = evaluate(state, sample(199000, { streamReplay: true, durationMs: 200000 }), { knownDurationMs: 200000 });
    assert.equal(d.action, 'advance');
    assert.equal(d.reason, 'stream-replayed');
});

test('时长未知：设备不上报进度，靠持续停止确认播完（不误判为 near-end）', () => {
    const state = playingState();
    const d = evaluate(state, sample(16000, { hasProgress: false, progressRatio: -1 }), { knownDurationMs: 0 });
    assert.equal(d.action, 'none', `应为 none，实际 ${d.action}/${d.reason}`);
});

// ---- 2026-11-05：设备把 status 瞬时报成 paused 时误跳歌 ----

test('设备报 paused 但位置仍在推进 → 不跳歌（position-advancing）', () => {
    let st: any = playingState();
    st.lastPlayingAt = BASE - 60000;
    // evaluate 返回的是新 state（内部 Object.assign 副本），必须链式传下去
    st = evaluate(st, sample(3000, { playing: false, hasProgress: false, positionMs: 1000 }), {}).state;
    const d = evaluate(st, sample(10000, { playing: false, hasProgress: false, positionMs: 7000 }), {});
    assert.equal(d.action, 'none', `应为 none，实际 ${d.action}/${d.reason}`);
    assert.equal(d.reason, 'position-advancing');
});

test('设备报 paused 且位置一直为 0 → 满 6 秒仍按播完兜底（兜底不能丢）', () => {
    let st: any = playingState();
    st.lastPlayingAt = BASE - 60000;
    st = evaluate(st, sample(3000, { playing: false, hasProgress: false, positionMs: 0 }), {}).state;
    const d = evaluate(st, sample(12000, { playing: false, hasProgress: false, positionMs: 0 }), {});
    assert.equal(d.action, 'advance', `应为 advance，实际 ${d.action}/${d.reason}`);
    assert.equal(d.reason, 'finished-without-progress');
});
