/* ===== outbox.js — 客户端消息可靠性：发送队列 / 重发 / 去重 / 状态 UI / 未读通知（T4）=====
 *
 * 目标：用户侧「消息不丢」。
 *   - 断网 / 切网 / 服务端重启期间发出的消息进本地队列（localStorage 持久化），连接恢复后自动送达；
 *   - 重发复用同一个 msgId ⇒ 服务端 (nickname,msgId) 幂等去重 ⇒ 不重复；
 *   - 收到 T3 的 chat_ack 就出队；老服务端不回 ack 时退回「服务端回显」作为成功判据；
 *   - 重连后用 sync_since 补齐错过的消息，且补齐的消息不会二次渲染。
 *
 * 设计约束（见任务书）：
 *   - 不依赖 window.UchatMobile（移动端任务已暂缓，它可能不存在）；
 *   - 不写 CSS 文件：所有样式内联在本文件创建的元素上；
 *   - 不碰 js/app.js（本轮冻结），只复用 chat.js 已有的全局设施：
 *     ws / nickname / offlineMode / msgIdMap / addMsgId / appendChatMessage /
 *     handleMessage / reconnectDelay / showToast。
 *
 * 整个模块包在 IIFE 里，只往 window 上挂一个 `Outbox`，避免与 app.js / chat.js 的顶层
 * let/const 撞名（顶层重复声明会直接 SyntaxError）。
 */
(function () {
    'use strict';

    // ---------------- 常量 ----------------
    var OUTBOX_PREFIX = 'uchat-outbox-';      // 队列：uchat-outbox-<nick>
    var SYNC_PREFIX = 'uchat-lastsync-';      // 已见消息最大时间戳（sync_since 的 since）
    var MAX_QUEUE = 200;                      // 队列上限（超出丢最旧的 failed，再丢最旧的 pending）
    var MAX_ATTEMPTS = 8;                     // 单条自动重发次数上限，超过标 failed 交用户决定
    var ACK_TIMEOUT_MS = 8000;                // 「已发出但没收到任何回执」的判定阈值
    var ECHO_ACK_MS = 3000;                   // 兜底：收到自己的回显后，等这么久还是没有 chat_ack 就算成功
    var SWEEP_INTERVAL_MS = 1500;             // 巡检：重发超时项 / 触发 flush
    var FLUSH_BURST = 6;                      // 单轮最多发几条（避免撞服务端每秒消息数限流）
    var RETRY_AFTER_BURST_MS = 1100;

    // ---------------- 状态 ----------------
    var nick = null;                          // 当前登录昵称（队列按昵称分桶）
    var queue = [];                           // [{msgId,payload,state,attempts,createdAt,...}] 顺序 = FIFO
    var lastSeenTs = 0;                       // 已见消息的最大时间戳 = 下一次 sync_since 的 since
    var msgSeq = 0;                           // msgId 计数后缀
    var flushing = false;
    var sweepTimer = null;
    var lastConnToken = -1;                   // 已处理过"初始化+补齐"的连接代次（wsToken）
    var lastMetaSaveAt = 0;
    var lastSyncResult = null;                // 最近一次 sync_result（测试/诊断用）
    var seenTsMap = {};                       // 本页见过的时间戳（用于 sync 后推进 lastSeenTs）
    var ui = { banner: null, bannerText: null, bannerBtn: null };
    var hiddenUnread = 0;
    var notified = {};                        // 通知去重
    var notifyAsked = false;
    var stats = {
        enqueued: 0, sent: 0, acked: 0, dupAck: 0, echoAck: 0, failed: 0,
        resent: 0, suppressed: 0, syncRequested: 0, syncResultCount: 0,
        syncRendered: 0, syncSkipped: 0, truncated: 0, notify: 0
    };

    // ---------------- 小工具 ----------------
    function log() {
        var a = Array.prototype.slice.call(arguments);
        a.unshift('[OUTBOX ' + new Date().toISOString().slice(11, 23) + ']');
        try { console.log.apply(console, a); } catch (e) { }
    }
    function warn() {
        var a = Array.prototype.slice.call(arguments);
        a.unshift('[OUTBOX ' + new Date().toISOString().slice(11, 23) + ']');
        try { console.warn.apply(console, a); } catch (e) { }
    }
    function q() { return OUTBOX_PREFIX + (nick || 'anon'); }

    /** 消息时间戳：优先 msgId 前缀（与客户端 sync_since 同源，服务端 historyTs 也是这么算的） */
    function msgTs(m) {
        if (!m) return 0;
        if (m.msgId) {
            var i = String(m.msgId).indexOf('_');
            if (i > 0) {
                var t = parseInt(String(m.msgId).slice(0, i), 10);
                if (t > 0) return t;
            }
        }
        if (m.serverTime) return m.serverTime;
        return 0;
    }

    function load() {
        try {
            var raw = localStorage.getItem(q());
            queue = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(queue)) queue = [];
        } catch (e) { queue = []; }
        // 修复历史脏数据
        queue = queue.filter(function (it) { return it && it.msgId && it.payload; });
        queue.forEach(function (it) {
            it.attempts = it.attempts || 0;
            if (it.state !== 'pending' && it.state !== 'sent' && it.state !== 'failed') it.state = 'pending';
        });
        try {
            var ts = localStorage.getItem(SYNC_PREFIX + (nick || 'anon'));
            lastSeenTs = ts ? (parseInt(ts, 10) || 0) : 0;
        } catch (e) { lastSeenTs = 0; }
    }

    function save() {
        try {
            localStorage.setItem(q(), JSON.stringify(queue.map(function (it) {
                return {
                    msgId: it.msgId, payload: it.payload, state: it.state,
                    attempts: it.attempts, createdAt: it.createdAt, lastAttemptAt: it.lastAttemptAt,
                    lastError: it.lastError || null
                };
            })));
        } catch (e) {
            warn('队列写 localStorage 失败（配额?）：' + e.message);
        }
    }

    function saveMeta(force) {
        var now = Date.now();
        if (!force && now - lastMetaSaveAt < 1000) return;
        lastMetaSaveAt = now;
        try { localStorage.setItem(SYNC_PREFIX + (nick || 'anon'), String(lastSeenTs)); } catch (e) { }
    }

    function find(msgId) {
        if (!msgId) return null;
        for (var i = 0; i < queue.length; i++) if (queue[i].msgId === msgId) return queue[i];
        return null;
    }

    function remove(msgId) {
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].msgId === msgId) { queue.splice(i, 1); return true; }
        }
        return false;
    }

    /** 界面上是否已经有这个 msgId 的气泡（复用 chat.js 的 msgIdMap；history_start 会把它清空，
     *  所以重连回放时不会被误判成"已渲染"） */
    function hasBubble(msgId) {
        if (!msgId) return false;
        var el = (typeof msgIdMap !== 'undefined') ? msgIdMap[msgId] : null;
        if (!el) return false;
        // msgIdMap 有上限淘汰，被淘汰的元素可能已经不在文档里了
        return !!(el.ownerDocument && el.ownerDocument.contains(el));
    }

    function wsReady() {
        return typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN &&
            !(typeof offlineMode !== 'undefined' && offlineMode);
    }

    function pendingCount() {
        var n = 0;
        for (var i = 0; i < queue.length; i++) if (queue[i].state !== 'sent' || queue[i].needResend) n++;
        return n;
    }
    function failedCount() {
        var n = 0;
        for (var i = 0; i < queue.length; i++) if (queue[i].state === 'failed') n++;
        return n;
    }

    // ==================== 状态 UI（全部内联样式，自建 DOM） ====================

    function ensureBanner() {
        if (ui.banner && ui.banner.ownerDocument && ui.banner.ownerDocument.contains(ui.banner)) return ui.banner;
        var panel = document.getElementById('chat-panel') || document.getElementById('content-area') || document.body;
        var el = document.createElement('div');
        el.id = 'uchat-outbox-banner';
        el.style.cssText = [
            'display:none', 'flex-shrink:0', 'align-items:center', 'gap:8px',
            'padding:6px 14px', 'font-size:12px', 'line-height:1.5',
            'background:rgba(224,160,48,0.16)', 'color:#8a5a00',
            'border-bottom:1px solid rgba(224,160,48,0.35)'
        ].join(';');
        var txt = document.createElement('span');
        txt.style.cssText = 'flex:1;min-width:0';
        var btn = document.createElement('button');
        btn.style.cssText = [
            'flex-shrink:0', 'border:1px solid currentColor', 'background:transparent',
            'color:inherit', 'font-size:12px', 'padding:2px 10px', 'border-radius:4px', 'cursor:pointer'
        ].join(';');
        btn.textContent = '立即重试';
        btn.addEventListener('click', function () { flush(true); });
        el.appendChild(txt);
        el.appendChild(btn);
        // 插到聊天面板最上面（message-area 之上）
        var anchor = document.getElementById('message-area');
        if (anchor && anchor.parentNode === panel) panel.insertBefore(el, anchor);
        else panel.insertBefore(el, panel.firstChild);
        ui.banner = el; ui.bannerText = txt; ui.bannerBtn = btn;
        return el;
    }

    function renderBanner() {
        var el = ensureBanner();
        if (!el) return;
        var pend = 0, failed = 0;
        queue.forEach(function (it) { if (it.state === 'failed') failed++; else pend++; });
        var offline = (typeof offlineMode !== 'undefined' && offlineMode);
        var parts = [];
        if (pend > 0) parts.push((offline ? '离线中，' : '') + pend + ' 条消息待发送（恢复连接后自动送达）');
        if (failed > 0) parts.push(failed + ' 条发送失败，点消息上的「重试」重新发送');
        // ⚠️ 2026-09-24 起**不再把"更早的消息已无法恢复"写进状态条**（用户要求隐藏这句）。
        //   成因有两层：① 旧服务端把"缓冲区为空"也判成截断 ⇒ 清空聊天记录后，
        //   带着旧 since 重连的客户端必然误报（已在 ChatWebSocketHandler.isTruncated 修正）；
        //   ② 即使真截断，状态条上挂一句"消息已无法恢复"也过于惊扰。
        //   信息不丢：仍写 console（onSyncResult 里的 log/warn），并挂成状态条的 title（悬停可见）。
        var truncNote = (lastSyncResult && lastSyncResult.truncated)
            ? '更早的消息已无法恢复（服务端缓冲区只保留最近 200 条）' : '';
        if (hiddenUnread > 0) parts.push('离开页面期间收到 ' + hiddenUnread + ' 条新消息');
        if (parts.length === 0) { el.style.display = 'none'; el.title = ''; return; }
        el.style.display = 'flex';
        el.title = truncNote;
        ui.bannerText.textContent = parts.join('　|　');
        ui.bannerBtn.style.display = (pend > 0 || failed > 0) ? '' : 'none';
        ui.bannerBtn.textContent = (typeof offlineMode !== 'undefined' && offlineMode) ? '立即重连' : '立即重试';
    }

    var BADGE_CLASS = 'uchat-outbox-badge';
    function badgeText(it) {
        if (it.state === 'failed') return '发送失败，点此重试';
        if (it.state === 'sent') return '发送中…';
        return '待发送';
    }
    function badgeStyle(state) {
        var color = state === 'failed' ? '#d93025' : (state === 'sent' ? '#8a8f98' : '#b06f00');
        return [
            'display:inline-block', 'margin-left:6px', 'font-size:11px', 'vertical-align:middle',
            'padding:0 5px', 'border-radius:8px', 'border:1px solid ' + color, 'color:' + color,
            'white-space:nowrap',
            state === 'failed' ? 'cursor:pointer;text-decoration:underline' : ''
        ].join(';');
    }
    /** 在消息元素上打「待发送 / 发送中 / 失败」角标（内联样式，不改任何 css 文件） */
    function updateBadge(it) {
        var el = hasBubble(it.msgId) ? msgIdMap[it.msgId] : null;
        if (!el) return;
        var b = el.querySelector('.' + BADGE_CLASS);
        if (it.state === 'sent') {
            // 发送中：角标保留很小（"发送中…"），收到 ack 直接移除
            if (!b) { b = document.createElement('span'); b.className = BADGE_CLASS; el.appendChild(b); }
            b.textContent = badgeText(it);
            b.style.cssText = badgeStyle(it.state);
            return;
        }
        if (!b) {
            b = document.createElement('span');
            b.className = BADGE_CLASS;
            el.appendChild(b);
        }
        b.textContent = badgeText(it);
        b.style.cssText = badgeStyle(it.state);
        if (it.state === 'failed') {
            b.onclick = function (ev) {
                ev.stopPropagation();
                API.retry(it.msgId);
            };
        } else {
            b.onclick = null;
        }
    }
    function clearBadge(msgId) {
        var el = hasBubble(msgId) ? msgIdMap[msgId] : null;
        if (!el) return;
        var b = el.querySelector('.' + BADGE_CLASS);
        if (b && b.parentNode) b.parentNode.removeChild(b);
    }

    // ==================== 发送 ====================

    /** 新消息入队（chat.js 的发送路径调这里；msgId 由调用方生成一次，之后永不改变） */
    function enqueue(msg) {
        if (!msg || !msg.msgId) return null;
        if (!nick) nick = (typeof nickname !== 'undefined' && nickname) || null;
        if (queue.length >= MAX_QUEUE) {
            // 先丢最旧的 failed，再丢最旧的 pending，保证新消息进得来
            var idx = -1;
            for (var i = 0; i < queue.length; i++) if (queue[i].state === 'failed') { idx = i; break; }
            if (idx < 0) idx = 0;
            var dropped = queue.splice(idx, 1)[0];
            warn('队列已满(' + MAX_QUEUE + ')，丢弃最旧的一条 msgId=' + (dropped && dropped.msgId));
        }
        var it = {
            msgId: msg.msgId, payload: msg, state: 'pending',
            attempts: 0, createdAt: Date.now(), lastAttemptAt: 0
        };
        queue.push(it);
        stats.enqueued++;
        save();
        log('enqueue msgId=' + msg.msgId + ' state=pending 队列=' + queue.length + ' 连接=' + (wsReady() ? 'OPEN' : 'DOWN'));
        // 乐观渲染：让用户立刻看到自己发出的这条 + 「待发送」角标。
        // 服务端回显时 hasBubble(msgId) 已经为 true ⇒ 不会再渲染一遍（去重）。
        // ⚠️ private 的乐观渲染由 app.js 的 sendPrivateMessage() 做（私聊气泡有独立的窗口与历史结构），
        //    这里只管 chat —— 否则会往聊天主区画出私聊气泡。
        if (msg.type === 'chat' && !hasBubble(msg.msgId)) {
            try { appendChatMessage(msg); } catch (e) { warn('乐观渲染失败: ' + e.message); }
        }
        updateBadge(it);
        renderBanner();
        flush();
        return msg.msgId;
    }

    function sendItem(it) {
        if (!wsReady()) return false;
        it.attempts = (it.attempts || 0) + 1;
        it.lastAttemptAt = Date.now();
        it.needResend = false;
        it.lastError = null;
        try {
            ws.send(JSON.stringify(it.payload));
        } catch (e) {
            it.lastError = 'ws.send 异常: ' + e.message;
            it.attempts--;
            warn('send 失败 msgId=' + it.msgId + '：' + e.message);
            return false;
        }
        it.state = 'sent';
        stats.sent++;
        if (it.attempts > 1) stats.resent++;
        log('send msgId=' + it.msgId + ' 第' + it.attempts + '次 队列=' + queue.length);
        updateBadge(it);
        save();
        return true;
    }

    /**
     * 把队列里待发的按 FIFO 发出去。
     * 「已发出但迟迟没有回执」的重发也在这里做（复用同一个 msgId，服务端幂等去重 ⇒ 不会重复入库）。
     */
    function flush(force) {
        if (force === true && !wsReady()) {
            // 「立即重试」按钮：离线时先尝试重连
            if (typeof tryReconnect === 'function' && typeof offlineMode !== 'undefined' && offlineMode) tryReconnect();
        }
        if (!nick) nick = (typeof nickname !== 'undefined' && nickname) || null;
        if (!wsReady()) {
            renderBanner();
            scheduleSweep();
            return 0;
        }
        if (flushing) return 0;
        flushing = true;
        var sentNow = 0;
        try {
            for (var i = 0; i < queue.length && sentNow < FLUSH_BURST; i++) {
                var it = queue[i];
                if (it.state === 'pending' || it.canceled) {
                    if (sendItem(it)) sentNow++;
                }
            }
        } finally {
            flushing = false;
        }
        if (sentNow > 0) {
            log('flush 发出 ' + sentNow + ' 条，剩余待发=' + pendingCount());
            save();
            renderBanner();
        }
        // 队列还没发完（超出单轮上限）→ 过一会儿再来一轮
        var still = queue.some(function (x) { return x.state === 'pending'; });
        if (still) scheduleTimer(RETRY_AFTER_BURST_MS);
        else scheduleSweep();
        return sentNow;
    }

    function scheduleTimer(ms) {
        if (sweepTimer) return;
        sweepTimer = setTimeout(function () {
            sweepTimer = null;
            sweep();
        }, ms);
    }
    function scheduleSweep() { scheduleTimer(SWEEP_INTERVAL_MS); }

    /** 巡检：超时重发 / 重试上限 / 触发 flush */
    function sweep() {
        if (!nick) nick = (typeof nickname !== 'undefined' && nickname) || null;
        var now = Date.now(), changed = false, needFlush = false;
        for (var i = 0; i < queue.length; i++) {
            var it = queue[i];
            if (it.state === 'pending') { needFlush = true; continue; }
            if (it.state !== 'sent') continue;
            // 兜底：老服务端不回 chat_ack，但会把消息回显给我 —— 回显后等一小会儿仍无 ack 就算成功
            if (it.echoAt && now - it.echoAt >= ECHO_ACK_MS) {
                log('收到回显但无 chat_ack，按成功出队（兼容老服务端）msgId=' + it.msgId);
                stats.echoAck++;
                doneDequeue(it, 'echo');
                changed = true;
                i--;
                continue;
            }
            if (now - (it.lastAttemptAt || 0) > ACK_TIMEOUT_MS) {
                if ((it.attempts || 0) < MAX_ATTEMPTS) {
                    it.state = 'pending';
                    it.needResend = true;
                    changed = true;
                    needFlush = true;
                    log('超时未收到回执，重新入队等待重发（msgId 不变）msgId=' + it.msgId + ' 已尝试=' + it.attempts);
                } else {
                    it.state = 'failed';
                    it.lastError = '重发 ' + it.attempts + ' 次仍未收到回执';
                    stats.failed++;
                    changed = true;
                    warn('重发上限，标记失败 msgId=' + it.msgId);
                }
                updateBadge(it);
            }
        }
        if (changed) { save(); renderBanner(); }
        if (needFlush) flush();
        else scheduleSweep();
    }

    function doneDequeue(it, source) {
        clearBadge(it.msgId);
        remove(it.msgId);
        save();
        renderBanner();
        log('dequeue msgId=' + it.msgId + ' 依据=' + source + ' 队列=' + queue.length);
    }

    // ==================== 接收侧 ====================

    /** chat / file 等消息分发前的准入判断：同 msgId 已在界面上 → 不重复渲染 */
    function shouldRender(msg) {
        if (!msg || !msg.msgId) return true;
        if (!hasBubble(msg.msgId)) return true;
        stats.suppressed++;
        log('抑制重复渲染（同 msgId 已有气泡）msgId=' + msg.msgId);
        return false;
    }

    /** 记录"已见的最大消息时间戳"，作为重连时 sync_since 的 since */
    function onMessageSeen(msg) {
        var ts = msgTs(msg);
        if (ts > lastSeenTs) { lastSeenTs = ts; saveMeta(); }
    }

    /** 自己的消息被服务端回显：可能是老服务端（没有 chat_ack），起一个兜底计时 */
    function onEcho(msg) {
        if (!msg || !msg.msgId) return;
        var it = find(msg.msgId);
        if (it && it.state === 'sent' && !it.echoAt) {
            it.echoAt = Date.now();
            save();
        }
    }

    /** chat_ack：服务端已处理（duplicate=true 表示此前已处理过同一 (nickname,msgId)） */
    function onAck(msgId, duplicate, serverTime) {
        var it = find(msgId);
        if (!it) {
            log('收到 ack 但队列里没有该条（可能已出队）msgId=' + msgId + ' duplicate=' + !!duplicate);
            return;
        }
        stats.acked++;
        if (duplicate) stats.dupAck++;
        log('ack msgId=' + msgId + ' duplicate=' + !!duplicate + ' serverTime=' + serverTime +
            ' 本地尝试次数=' + (it.attempts || 0));
        doneDequeue(it, duplicate ? 'chat_ack(duplicate)' : 'chat_ack');
    }

    /**
     * private_fail：服务端明确说这条私聊发不出去（收件人不是注册用户 / 给自己发）。
     *
     * <p>P0-④ 之后「对方离线」不再回 private_fail（改为落盘 + 上线补投），所以这里命中即真的失败。
     * 优先按 msgId 精确匹配（服务端现在会回带 msgId），取不到再退回按 receiver 匹配（兼容旧服务端）。</p>
     */
    function onPrivateFail(msg) {
        if (!msg) return;
        for (var i = 0; i < queue.length; i++) {
            var it = queue[i];
            if (!it.payload || it.payload.type !== 'private') continue;
            var hit = msg.msgId ? (it.msgId === msg.msgId) : (it.payload.receiver === msg.nickname);
            if (!hit) continue;
            it.state = 'failed';
            it.lastError = msg.content || '私聊失败';
            stats.failed++;
            save(); updateBadge(it); renderBanner();
            log('private_fail → 标记失败 msgId=' + it.msgId + ' 原因=' + it.lastError);
            return;
        }
    }

    /** 重画所有队列项的气泡角标（私聊窗口打开/重绘后调用：气泡可能是刚建出来的） */
    function syncBadges() {
        for (var i = 0; i < queue.length; i++) updateBadge(queue[i]);
    }

    /** 请求补齐：since 省略/0 = 全量 */
    function requestSync(since) {
        if (!wsReady()) { warn('requestSync 时连接不可用，跳过'); return false; }
        var s = (since === undefined || since === null) ? lastSeenTs : since;
        var m = { type: 'sync_since', nickname: nick, since: s };
        try {
            ws.send(JSON.stringify(m));
        } catch (e) { warn('sync_since 发送失败: ' + e.message); return false; }
        stats.syncRequested++;
        log('sync_since since=' + s + (s ? '' : '（=全量）'));
        return true;
    }

    /** sync_result：补齐错过的消息（元素是原始消息 JSON 字符串，直接复用 handleMessage 渲染） */
    function onSyncResult(msg) {
        stats.syncResultCount++;
        var list = (msg && msg.messages) || [];
        lastSyncResult = {
            count: (msg && typeof msg.count === 'number') ? msg.count : list.length,
            truncated: !!(msg && msg.truncated),
            oldest: msg ? msg.oldest : null, newest: msg ? msg.newest : null,
            rendered: 0, skipped: 0, at: Date.now()
        };
        if (lastSyncResult.truncated) stats.truncated++;
        log('sync_result count=' + lastSyncResult.count + ' truncated=' + lastSyncResult.truncated +
            ' oldest=' + lastSyncResult.oldest + ' newest=' + lastSyncResult.newest);
        if (lastSyncResult.truncated) warn('服务端缓冲区起点晚于请求的 since，缺口补不齐（最多保留 200 条）');

        // 补齐的是历史消息：临时打开 _loadingHistory，复用 chat.js 既有的"不要提示未读"语义
        var prevLoading = window._loadingHistory;
        window._loadingHistory = true;
        try {
            for (var i = 0; i < list.length; i++) {
                var raw = list[i];
                var m;
                try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { continue; }
                if (!m || !m.type) continue;
                onMessageSeen(m);
                if (m.msgId && hasBubble(m.msgId)) {
                    lastSyncResult.skipped++;
                    stats.syncSkipped++;
                    continue;   // 已在界面上 → 不二次渲染
                }
                if (typeof handleMessage === 'function') handleMessage(m);
                lastSyncResult.rendered++;
                stats.syncRendered++;
            }
        } finally {
            window._loadingHistory = prevLoading;
        }
        saveMeta(true);
        renderBanner();
    }

    // ==================== 未读 / 系统通知 ====================

    function askNotifyPermissionOnce() {
        if (notifyAsked) return;
        notifyAsked = true;
        try {
            if (typeof Notification === 'undefined') return;
            if (Notification.permission === 'default') {
                Notification.requestPermission().then(function (p) {
                    log('系统通知权限=' + p);
                }).catch(function () { });
            }
        } catch (e) { }
    }

    /** 收到别人的消息（页外才有意义） */
    function onIncoming(msg) {
        if (!msg || !msg.nickname || msg.nickname === nick) return;
        if (typeof document !== 'undefined' && document.hidden) {
            hiddenUnread++;
            renderBanner();
            notify(msg);
        }
    }

    function notify(msg) {
        try {
            if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
            if (typeof document !== 'undefined' && !document.hidden) return;
            var key = msg.msgId || (msg.nickname + '|' + msg.content);
            if (notified[key]) return;
            notified[key] = 1;
            var body = (msg.content || '').slice(0, 50);
            var n = new Notification(msg.nickname, { body: body, tag: 'uchat-' + key });
            stats.notify++;
            log('系统通知 from=' + msg.nickname);
            n.onclick = function () {
                try { window.focus(); } catch (e) { }
                locate(msg.msgId);
                hiddenUnread = 0; renderBanner();
                try { n.close(); } catch (e) { }
            };
        } catch (e) { }
    }

    /** 定位到某条消息（点击通知后调用） */
    function locate(msgId) {
        if (!msgId) return;
        var el = hasBubble(msgId) ? msgIdMap[msgId] : null;
        if (!el) { log('locate：界面上找不到 msgId=' + msgId); return; }
        try {
            el.scrollIntoView({ block: 'center' });
            var old = el.style.boxShadow;
            el.style.boxShadow = '0 0 0 2px #d93025';
            setTimeout(function () { el.style.boxShadow = old || ''; }, 1600);
        } catch (e) { }
    }

    // ==================== 连接事件 ====================

    /** 连接可用时调用（chat.js 在 auth_resp ok / onLoginSuccess / exitOfflineMode 时调） */
    function onConnected(newNick) {
        var target = newNick || (typeof nickname !== 'undefined' && nickname) || null;
        if (target && target !== nick) init(target);
        else if (!nick) init(target);
        // 同一条连接上可能被触发多次（auth 分支 + 登录成功钩子）⇒ 只在"新连接"上请求一次补齐
        var token = (typeof wsToken !== 'undefined') ? wsToken : 0;
        if (token && token === lastConnToken) {
            flush();
            return;
        }
        lastConnToken = token;
        renderBanner();
        flush();
        requestSync();
        scheduleSweep();
    }

    function init(n) {
        var target = n || (typeof nickname !== 'undefined' && nickname) || null;
        if (target === nick && ui.banner) return;    // 同一昵称重复调用：幂等
        nick = target;
        load();
        log('init nick=' + nick + ' 从 localStorage 恢复队列 ' + queue.length + ' 条，lastSeenTs=' + lastSeenTs +
            (queue.length ? ' msgIds=' + JSON.stringify(queue.map(function (x) { return x.msgId; })) : ''));
        renderBanner();
        // 恢复出来的气泡：先把"待发送"角标与乐观气泡补上（刷新后本地队列还在，界面是空的）
        queue.forEach(function (it) {
            if (!hasBubble(it.msgId) && it.payload && it.payload.type === 'chat') {
                try { appendChatMessage(it.payload); } catch (e) { }
            }
            // 私聊：本地历史（pmHistory）本来就有这条，窗口打开时会自己渲染；
            // 万一历史被清了，这里按队列把记录补回 pmHistory（不弹窗、不计数）
            if (it.payload && it.payload.type === 'private'
                && typeof addPmMessage === 'function' && typeof privateHistory !== 'undefined') {
                try {
                    var peer = (it.payload.nickname === nick) ? it.payload.receiver : it.payload.nickname;
                    addPmMessage(peer, it.payload.nickname, it.payload.content,
                                 it.createdAt, it.msgId, false);
                } catch (e) { }
            }
            updateBadge(it);
        });
        flush();
        scheduleSweep();
    }

    // ==================== 公开 API ====================
    var API = {
        init: init,
        onConnected: onConnected,
        enqueue: enqueue,
        flush: flush,
        retry: function (msgId) {
            var it = find(msgId);
            if (!it) return false;
            it.state = 'pending';
            it.attempts = 0;
            it.echoAt = 0;
            it.lastError = null;
            save(); updateBadge(it); renderBanner();
            log('用户重试 msgId=' + msgId);
            flush();
            return true;
        },
        shouldRender: shouldRender,
        onMessageSeen: onMessageSeen,
        onEcho: onEcho,
        onAck: onAck,
        onPrivateFail: onPrivateFail,
        syncBadges: syncBadges,
        onIncoming: onIncoming,
        requestSync: requestSync,
        onSyncResult: onSyncResult,
        locate: locate,
        hasBubble: hasBubble,
        // 诊断 / 测试用
        queueSnapshot: function () {
            return queue.map(function (it) {
                return {
                    msgId: it.msgId, content: it.payload && it.payload.content,
                    type: it.payload && it.payload.type, receiver: it.payload && it.payload.receiver,
                    state: it.state, attempts: it.attempts || 0, createdAt: it.createdAt,
                    lastError: it.lastError || null
                };
            });
        },
        stats: function () {
            var s = {};
            for (var k in stats) s[k] = stats[k];
            s.queueLen = queue.length;
            s.pending = pendingCount();
            s.failed = failedCount();
            s.lastSeenTs = lastSeenTs;
            s.wsReady = wsReady();
            return s;
        },
        lastSyncResult: function () { return lastSyncResult; },
        /** 直接读 localStorage 里的队列（未登录 / init 之前也能读，用于"刷新后队列还在吗"的验证） */
        storedQueues: function () {
            var out = {};
            try {
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf(OUTBOX_PREFIX) === 0) {
                        try { out[k] = JSON.parse(localStorage.getItem(k) || '[]'); }
                        catch (e) { out[k] = null; }
                    }
                }
            } catch (e) { }
            return out;
        },
        askNotifyPermissionOnce: askNotifyPermissionOnce,
    };

    window.Outbox = API;

    // 首次用户交互时才申请通知权限（不要在页面加载时弹）
    try {
        var ask = function () {
            askNotifyPermissionOnce();
            document.removeEventListener('click', ask);
            document.removeEventListener('keydown', ask);
        };
        document.addEventListener('click', ask);
        document.addEventListener('keydown', ask);
    } catch (e) { }

    // 网络恢复 / 回到前台 / 页面从缓存恢复 → 立刻尝试把队列发出去
    try {
        window.addEventListener('online', function () { log('window.online → flush'); flush(); });
        window.addEventListener('pageshow', function () { flush(); });
        window.addEventListener('focus', function () { flush(); });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) { hiddenUnread = 0; renderBanner(); flush(); }
        });
        window.addEventListener('pagehide', function () { saveMeta(true); save(); });
    } catch (e) { }

    log('模块已加载（等待 chat.js 登录成功后调用 Outbox.init）');
})();
