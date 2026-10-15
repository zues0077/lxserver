/*
 * 自动续播的心跳线程。
 *
 * 页面切到后台后，浏览器会把主线程的定时器节流（Chrome 对长时间不可见的标签
 * 会降到每分钟一次），但 Worker 里的定时器不受该节流影响。
 * 因此这里只负责「按节奏通知主线程去查一次音箱状态」，请求与判定仍在主线程做，
 * 既绕开了节流，又不改变既有的鉴权与状态管理方式。
 */
let timer = null;

const stop = () => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
};

self.onmessage = event => {
    const msg = event.data || {};
    if (msg.type === 'start') {
        stop();
        const interval = Math.max(1000, Number(msg.interval) || 3000);
        timer = setInterval(() => self.postMessage({ type: 'tick' }), interval);
        self.postMessage({ type: 'started', interval: interval });
    } else if (msg.type === 'stop') {
        stop();
    }
};
