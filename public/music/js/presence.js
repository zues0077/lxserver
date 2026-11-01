/**
 * Presence（在线用户指示）
 *
 * 独立于 lx 同步协议的轻量 WebSocket 通道：
 *   1. POST /api/music/presence/ticket   ← 用现有鉴权头换一次性票据（60s，一次性）
 *   2. ws(s)://<host>/ws/presence?ticket=...
 *   3. 服务端推送 { type:'presence', data:[{user, connections}] }
 *
 * 之所以不用 URL 直传 token：token 会进访问日志；票据一次性且短命，泄漏窗口极小。
 * 断线指数退避重连，每次重连重新换票。
 */
(function () {
    'use strict';

    const HEARTBEAT_MS = 25000;
    const RECONNECT_BASE_MS = 2000;
    const RECONNECT_MAX_MS = 60000;

    let socket = null;
    let heartbeatTimer = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let lastUsers = [];
    let manuallyClosed = false;

    function authHeaders() {
        try {
            if (typeof window.getUserAuthHeaders === 'function') return window.getUserAuthHeaders();
        } catch (e) { /* ignore */ }
        const headers = {};
        const username = localStorage.getItem('lx_sync_user') || '';
        const token = localStorage.getItem('lx_user_token') || '';
        if (username && username !== '_open') headers['x-user-name'] = username;
        if (token) headers['x-user-token'] = token;
        const adminPass = localStorage.getItem('lx_admin_password');
        if (adminPass) headers['x-frontend-auth'] = adminPass;
        return headers;
    }

    function hasIdentity() {
        const h = authHeaders();
        return !!(h['x-user-token'] || h['x-user-password'] || h['x-frontend-auth']);
    }

    function wsUrl(ticket) {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}/ws/presence?ticket=${encodeURIComponent(ticket)}`;
    }

    function pill() {
        return document.getElementById('presence-pill');
    }

    function render(users) {
        lastUsers = Array.isArray(users) ? users : [];
        const el = pill();
        const dot = document.getElementById('presence-dot');
        const ping = document.getElementById('presence-dot-ping');
        const count = document.getElementById('presence-count');

        if (el) el.classList.remove('hidden');
        const online = lastUsers.length > 0;
        if (dot) {
            dot.classList.toggle('bg-emerald-500', online);
            dot.classList.toggle('bg-gray-400', !online);
        }
        if (ping) ping.classList.toggle('hidden', !online);
        if (count) count.textContent = String(lastUsers.length);

        const list = document.getElementById('presence-list');
        const modalCount = document.getElementById('presence-modal-count');
        if (modalCount) modalCount.textContent = `${lastUsers.length} 人`;
        if (!list) return;

        if (!lastUsers.length) {
            list.innerHTML = '<p class="text-xs t-text-muted text-center py-6">暂无在线用户</p>';
            return;
        }
        list.innerHTML = lastUsers.map(u => {
            const safeUser = String(u.user ?? '').replace(/[&<>"']/g, ch => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
            })[ch]);
            const conns = Number(u.connections) || 1;
            return `<div class="flex items-center gap-2 px-3 py-2 t-bg-track rounded-xl text-xs">
                <span class="relative flex h-1.5 w-1.5 shrink-0">
                    <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                </span>
                <span class="t-text-main font-medium truncate">${safeUser}</span>
                <span class="ml-auto t-text-muted text-[10px] shrink-0">${conns} 个页面</span>
            </div>`;
        }).join('');
    }

    function stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    function startHeartbeat() {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                try { socket.send('ping'); } catch (e) { /* ignore */ }
            }
        }, HEARTBEAT_MS);
    }

    function scheduleReconnect() {
        if (manuallyClosed) return;
        if (reconnectTimer) return;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt));
        reconnectAttempt = Math.min(reconnectAttempt + 1, 6);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connect();
        }, delay);
    }

    function closeSocket() {
        stopHeartbeat();
        if (socket) {
            try { socket.onclose = null; } catch (e) { /* ignore */ }
            try { socket.close(); } catch (e) { /* ignore */ }
            socket = null;
        }
    }

    async function fetchSnapshot() {
        try {
            const resp = await fetch('/api/music/presence', { headers: authHeaders() });
            if (!resp.ok) return null;
            const data = await resp.json();
            if (data && data.success) {
                render(data.users || []);
                return data.users || [];
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    async function connect() {
        if (!hasIdentity()) {
            // 未登录：仅尝试 HTTP 快照（管理员可看），失败就静默
            const users = await fetchSnapshot();
            if (users === null) scheduleReconnect();
            return;
        }

        let ticket = '';
        try {
            const resp = await fetch('/api/music/presence/ticket', { method: 'POST', headers: authHeaders() });
            if (!resp.ok) throw new Error('ticket http ' + resp.status);
            const data = await resp.json();
            ticket = data && data.ticket;
        } catch (e) {
            scheduleReconnect();
            return;
        }
        if (!ticket) {
            scheduleReconnect();
            return;
        }

        closeSocket();

        let ws;
        try {
            ws = new WebSocket(wsUrl(ticket));
        } catch (e) {
            scheduleReconnect();
            return;
        }
        socket = ws;

        ws.onopen = () => {
            reconnectAttempt = 0;
            startHeartbeat();
        };

        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            if (msg && msg.type === 'presence') render(msg.data || []);
        };

        ws.onclose = () => {
            stopHeartbeat();
            if (socket === ws) socket = null;
            scheduleReconnect();
        };

        ws.onerror = () => {
            // onclose 会跟着触发，这里只做静默处理避免控制台噪音
        };
    }

    function openModal() {
        const modal = document.getElementById('modal-presence');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        render(lastUsers);
        void fetchSnapshot();
    }

    function closeModal() {
        const modal = document.getElementById('modal-presence');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    window.Presence = {
        openModal,
        closeModal,
        refresh: () => void fetchSnapshot(),
        reconnect: () => {
            manuallyClosed = false;
            reconnectAttempt = 0;
            void connect();
        },
        disconnect: () => {
            manuallyClosed = true;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            closeSocket();
        },
        get users() { return lastUsers; },
    };

    // 页面加载后延迟连接，避免和首屏请求抢带宽
    const boot = () => setTimeout(() => { void connect(); }, 1500);
    if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
    else document.addEventListener('DOMContentLoaded', boot);

    // 切回前台时补一次（后台标签页可能被浏览器休眠）
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !socket) {
            manuallyClosed = false;
            void connect();
        }
    });

    // 登录 / 登出后重建连接
    window.addEventListener('lx-auth-changed', () => {
        manuallyClosed = false;
        reconnectAttempt = 0;
        void connect();
    });
})();
