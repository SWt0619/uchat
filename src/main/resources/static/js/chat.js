/* ===== chat.js — WebSocket 通信、消息渲染 ===== */

let ws = null;
let heartbeatTimer = null;
let heartbeatTimeout = null;
// HTTP 模式（WebSocket 不可用时自动切换）
const msgIdMap = {}; // msgId -> DOM element for recall
const MSGID_MAP_MAX = 500;

function addMsgId(msgId, el) {
    var keys = Object.keys(msgIdMap);
    if (keys.length >= MSGID_MAP_MAX) {
        delete msgIdMap[keys[0]]; // 删最早一条，防止内存无限增长
    }
    msgIdMap[msgId] = el;
}

function connectWebSocket(mode, nick, pwd, errorEl, invite) {
    // 清理旧连接，防止重复
    if (ws) {
        try { ws.close(); } catch(e) {}
        ws = null;
    }
    stopHeartbeat();

    // 连接代次号：旧 socket 的 onclose/onmessage 迟到时不得再影响状态
    // （否则"重连成功后旧连接的 onclose 才到"会把刚恢复的会话重新打成离线）
    const myToken = ++wsToken;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsHost;
    if (window.CHAT_SERVER_HOST && window.CHAT_SERVER_PORT) {
        wsHost = window.CHAT_SERVER_HOST + ':' + window.CHAT_SERVER_PORT;
    } else if (window.CHAT_SERVER_HOST) {
        wsHost = window.CHAT_SERVER_HOST;
    } else {
        wsHost = location.host;
    }
    const wsUrl = proto + '//' + wsHost + '/ws/chat';

    try {
        ws = new WebSocket(wsUrl);
    } catch (e) {
        errorEl && (errorEl.textContent = '连接失败: ' + e.message);
        if (offlineMode) scheduleAutoReconnect();
        return;
    }

    // 认证看门狗：连上了但服务器不回 auth_resp（半死不活）也要能自行重试，
    // 否则会永远卡在"正在重连"里（旧版没有这个保护）。
    let authWatchdog = setTimeout(function () {
        if (myToken !== wsToken) return;
        console.warn('[重连] 已连接但 ' + (AUTH_TIMEOUT_MS / 1000) + 's 内未收到认证响应，强制重试');
        try { ws && ws.close(); } catch (e) {}
    }, AUTH_TIMEOUT_MS);

    function clearAuthWatchdog() { if (authWatchdog) { clearTimeout(authWatchdog); authWatchdog = null; } }

    ws.onopen = () => {
        if (myToken !== wsToken) return;
        var authMsg = { type: 'auth', subtype: mode, nickname: nick, content: pwd };
        if (invite) authMsg.invite = invite;
        ws.send(JSON.stringify(authMsg));
    };

    ws.onmessage = (event) => {
        if (myToken !== wsToken) return;
        try {
            const msg = JSON.parse(event.data);
            handleMessage(msg);
            if (msg.type === 'auth_resp' && msg.subtype === 'ok') {
                clearAuthWatchdog();
                if (msg.token) setFileAuthToken(msg.token);
                if (offlineMode) {
                    var wasInCall = (typeof videoCallActive !== 'undefined' && videoCallActive);
                    var savedRoom = (typeof callRoomNum !== 'undefined') ? callRoomNum : 0;
                    exitOfflineMode();
                    showToast('已重连，欢迎回来', 'success');
                    ws.send(JSON.stringify({ type: 'list' }));
                    // 如果在通话中断线，重连后通过 rejoinCallRoom 重新建立 WebRTC 连接
                    if (wasInCall && savedRoom > 0 && typeof rejoinCallRoom === 'function') {
                        setTimeout(function() {
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                rejoinCallRoom();
                            }
                        }, 800);
                    }
                } else {
                    onLoginSuccess();
                }
                startHeartbeat();
                // T4：登录/重连成功 → 初始化（或复用）消息队列、flush 积压消息、请求 sync_since 补齐。
                // 注意：这一句只是"通常能跑到"的那次；真正保证执行的是文件末尾的 try/finally 钩子
                // （onLoginSuccess 内部会抛异常，见那里的注释）。
                try {
                    var _obc = outboxApi();
                    if (_obc) _obc.onConnected(nickname);
                } catch (e) { console.error('[T4] outbox onConnected 失败:', e); }
            } else if (msg.type === 'auth_resp' && msg.subtype === 'fail') {
                clearAuthWatchdog();
                setFileAuthToken(null);
                onLoginFailed(msg.reason);
                // 重连过程中被拒（例如服务端刚重启、会话已被清理），不要退出登录，
                // 保留凭据继续按退避重试；只有首次登录失败才回登录页。
                if (offlineMode) {
                    console.warn('[重连] 认证被拒: ' + msg.reason + '，稍后重试');
                    try { ws.close(); } catch (e) {}
                    ws = null;
                } else {
                    ws.close();
                    ws = null;
                }
            }
        } catch (e) {
            console.error('Parse error:', e);
        }
    };

    ws.onclose = (event) => {
        clearAuthWatchdog();
        if (myToken !== wsToken) {
            console.log('WS CLOSE(旧连接，已忽略): code=' + event.code);
            return;
        }
        console.log('WS CLOSE: code=' + event.code + ' reason=' + event.reason + ' wasClean=' + event.wasClean);
        stopHeartbeat();
        // ★ 服务端以 4001 关闭 = 本账号在别处登录、本连接被顶替。
        //   此时**绝不能自动重连**：否则两端会各自重连、互相顶号，形成每秒一次
        //   的"断线—重连"死循环（同账号在手机+电脑同时打开时的典型症状）。
        if (event.code === 4001) {
            onSuperseded(event.reason || '已在其他设备登录');
            return;
        }
        if (mainApp.classList.contains('hidden')) return;
        if (offlineMode) {
            scheduleAutoReconnect();
        } else {
            // 立即健康检查，判断是服务器宕机还是仅断线（同一轮故障只提示一次）
            checkServerHealth().then(alive => {
                if (!alive && Date.now() - lastOfflineNoticeAt > 5000) {
                    lastOfflineNoticeAt = Date.now();
                    showToast('服务器已离线，等待恢复...', 'error');
                }
            });
            enterOfflineMode();
        }
    };

    ws.onerror = (e) => {
        if (myToken !== wsToken) return;
        console.error('WS ERROR:', e);
        if (errorEl) { errorEl.textContent = '连接失败，请检查服务器'; }
        // 不要在这里提示"连接失败" —— onclose 紧跟着会走重连流程，避免刷屏
    };
}

var heartbeatMissCount = 0;
var HEARTBEAT_MAX_MISS = 3;        // 连续丢失 3 个心跳判定断线
var HEARTBEAT_INTERVAL_MS = 5000;  // 旧版 10 秒：局域网/内网穿透下 5 秒的开销可以忽略，
                                   // 但把"TCP 半开（没有 RST）"的发现时间从 30 秒压到 15 秒
var AUTH_TIMEOUT_MS = 10000;       // 连上后等待 auth_resp 的上限
var wsToken = 0;                   // WebSocket 连接代次

/* ★ 被其他设备顶替（服务端 4001）：停止一切自动重连，并给用户明确出口。
   设计取舍：不做自动重连，是因为"自动重连"正是互踢死循环的成因；
   用户想在这台设备继续用，刷新页面即可（届时会顶掉另一端，而另一端会停在这里，不会再来踢）。 */
var supersededByOtherDevice = false;
function onSuperseded(reason) {
    supersededByOtherDevice = true;
    if (autoReconnectTimer) { clearTimeout(autoReconnectTimer); autoReconnectTimer = null; }
    stopHeartbeat();
    offlineMode = false;
    try {
        if (typeof msgInput !== 'undefined' && msgInput) {
            msgInput.disabled = true;
            msgInput.placeholder = '此账号已在其他设备登录（点「重新连接」可顶掉那台设备）';
        }
        if (typeof sendBtn !== 'undefined' && sendBtn) {
            sendBtn.textContent = '重新连接';
            sendBtn.classList.add('reconnect');
        }
    } catch (e) {}
    try { showToast('该账号已在其他设备登录，本页面已停止自动重连。点「重新连接」可把那台设备顶下线。', 'error'); } catch (e) {}
}

/** 被顶替后，用户主动点「重新连接」：解除封锁并立刻重连（会顶掉另一台设备）。
    注意：这正是"不会无限互踢"的关键 —— 只有**人为**发起才会抢回会话。 */
function takeOverSession() {
    supersededByOtherDevice = false;
    try {
        if (typeof msgInput !== 'undefined' && msgInput) msgInput.disabled = false;
    } catch (e) {}
    showToast('正在重新连接，将顶掉另一台设备…', 'info');
    if (typeof showToast === 'function' && typeof enterOfflineMode === 'function') {
        enterOfflineMode();          // 进入离线态 → 走既有的自动重连流程（退避从最小开始，很快连上）
    }
}
try { window.takeOverSession = takeOverSession; } catch (e) {}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatMissCount = 0;
    heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'heartbeat' }));
            heartbeatMissCount++;
            if (heartbeatMissCount >= HEARTBEAT_MAX_MISS) {
                // 连续多个心跳未收到任何回复，主动断线触发重连
                console.log('[heartbeat] 连续' + heartbeatMissCount + '次心跳无响应，主动断开');
                stopHeartbeat();
                try { ws.close(); } catch(e) {}
                ws = null;
                if (!offlineMode && !mainApp.classList.contains('hidden')) enterOfflineMode();
            }
        }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimeout = setTimeout(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            if (!offlineMode && !mainApp.classList.contains('hidden')) enterOfflineMode();
        }
    }, 120000);
}

function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
    heartbeatMissCount = 0;
}

function resetHeartbeatTimeout() {
    heartbeatMissCount = 0; // 收到任意消息说明连接正常
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    heartbeatTimeout = setTimeout(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            if (!offlineMode && !mainApp.classList.contains('hidden')) enterOfflineMode();
        }
    }, 120000);
}

// ==================== Message Handler ====================
/** T4：Outbox 可能还没加载完（它是 chat.js 动态注入的），所有调用都要走这个取值器 */
function outboxApi() {
    return (typeof window !== 'undefined' && window.Outbox) ? window.Outbox : null;
}

function handleMessage(msg) {
    resetHeartbeatTimeout();
    var _ob = outboxApi();

    switch (msg.type) {
        case 'chat':
            // T4 去重：同一个 msgId 已经在界面上就不再渲染
            // （乐观气泡 vs 服务端回显、history 回放 vs 广播、重复投递 都会走到这里）
            if (_ob && !_ob.shouldRender(msg)) { _ob.onEcho(msg); break; }
            appendChatMessage(msg);
            if (_ob) {
                _ob.onMessageSeen(msg);
                if (msg.nickname === nickname) _ob.onEcho(msg);   // 自己的回显 → 给 ack 兜底计时
            }
            if (!window._loadingHistory && msg.nickname !== nickname) {
                playNotify(); incrementUnread();
                if (_ob) _ob.onIncoming(msg);                     // 页外未读 + 系统通知
            }
            break;
        case 'private':
            if (_ob && !_ob.shouldRender(msg)) { _ob.onEcho(msg); break; }
            onPrivateMessage(msg);
            if (_ob) {
                _ob.onMessageSeen(msg);
                if (msg.nickname === nickname) _ob.onEcho(msg);
            }
            if (!window._loadingHistory && msg.nickname !== nickname) {
                playNotify(); incrementUnread();
                if (_ob) _ob.onIncoming(msg);
            }
            break;
        case 'chat_ack':
            // T3 协议：msgId 原样回带；duplicate=true 表示服务端此前已处理过同一 (nickname,msgId)
            if (_ob) _ob.onAck(msg.msgId, msg.duplicate === true, msg.serverTime);
            break;
        case 'sync_result':
            // T3 协议：messages 是原始消息 JSON 字符串 → 直接复用 handleMessage 渲染
            if (_ob) _ob.onSyncResult(msg);
            else if (msg.messages) {
                msg.messages.forEach(function(raw) {
                    try { handleMessage(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (e) {}
                });
            }
            break;
        case 'private_pending':
            // P0-④：登录时服务端下发的未读私聊汇总（先于逐条补投到达）→ 用户列表上的未读角标
            if (typeof onPrivatePending === 'function') onPrivatePending(msg);
            break;
        case 'private_fail':
            // P0-④ 之后 private_fail 只剩两种原因：收件人不是注册用户 / 给自己发。
            // 消息带 msgId ⇒ 只删掉这一条（旧实现按"删最后一条自己发的"会删错）。
            if (_ob) _ob.onPrivateFail(msg);
            if (typeof showToast === 'function') {
                showToast(msg.nickname + ' ' + (msg.content || '无法发送私聊'), 'error');
            }
            if (typeof pmRemoveMessage === 'function') pmRemoveMessage(msg.nickname, msg.msgId);
            break;
        case 'file':
            if (_ob && !_ob.shouldRender(msg)) { _ob.onEcho(msg); break; }
            appendFileMessage(msg);
            if (_ob) { _ob.onMessageSeen(msg); }
            if (!window._loadingHistory && msg.nickname !== nickname) {
                playNotify(); incrementUnread();
                if (_ob) _ob.onIncoming(msg);
            }
            break;
        case 'system':
            appendSystemMessage(msg.content);
            break;
        case 'welcome':
            appendSystemMessage(msg.nickname + ' 加入了聊天室，当前在线 ' + msg.online + ' 人');
            break;
        case 'userlist':
                if (msg.roles) { try { applyRoles(msg.roles); } catch (e) { } }
            updateUserList(msg.users, msg.offline, msg.statuses);
            break;
        case 'user_status':
            if (typeof onUserStatus === 'function') onUserStatus(msg.nickname, msg.status);
            break;
        case 'recall':
            handleRecall(msg);
            break;
        case 'room_leave':
            var lt = (msg.subtype === 'voice') ? '语音' : '视频';
            appendSystemMessage(msg.nickname + ' 离开了' + lt + '通话');
            break;
        case 'screen_start':
            appendSystemMessage(msg.nickname + ' 开始共享屏幕 (' + (msg.quality || '720p') + ')');
            showToast(msg.nickname + ' 开始共享屏幕', 'info');
            break;
        case 'screen_stop':
            appendSystemMessage(msg.nickname + ' 停止了屏幕共享');
            onScreenStop();
            break;
        case 'typing':
            showTyping(msg.nickname);
            break;
        case 'music_room_state':
            updateMusicRoom(msg);
            break;
        case 'heartbeat_ack':
            break;
        case 'recall_fail':
            showToast(msg.content || '撤回失败', 'error');
            break;
        case 'history_start':
            window._loadingHistory = true;
            // 清空聊天区避免重连后消息重复
            messageArea.innerHTML = '';
            Object.keys(msgIdMap).forEach(function(k) { delete msgIdMap[k]; });
            break;
        case 'history_end':
            window._loadingHistory = false;
            break;
        case 'auth_change_pwd_ok':
            showToast('密码已修改', 'success');
            break;
        case 'auth_change_pwd_fail':
            showToast('密码修改失败，请检查旧密码是否正确', 'error');
            break;
        default:
            // history could be JSON strings
            if (typeof msg === 'string') {
                try {
                    const parsed = JSON.parse(msg);
                    if (parsed.type) handleMessage(parsed);
                } catch (e) {}
            }
            break;
    }
}


// ==================== Render Messages ====================
function appendSystemMessage(content) {
    const div = document.createElement('div');
    div.className = 'message system';
    div.innerHTML = esc(content);
    messageArea.appendChild(div);
    scrollToBottom();
}

function appendChatMessage(msg) {
    const isMutedSender = isMuted(msg.nickname);
    const div = document.createElement('div');
    div.className = 'message';
    div.dataset.msgId = msg.msgId || '';
    div.dataset.nickname = msg.nickname || '';
    div.dataset.content = msg.content || '';
    div.dataset.type = msg.type || 'chat';
    if (isMutedSender) div.classList.add('muted-msg', 'hidden');

    const isSelf = msg.nickname === nickname;
    const isPrivate = msg.type === 'private';

    let headerHtml = '';
    let bodyHtml = '';

    // Private tag
    if (isPrivate) {
        headerHtml += '<span class="msg-private-tag">[私聊]</span> ';
    }

    // Nickname
    headerHtml += `<span class="msg-nick ${isSelf ? 'self' : 'other'}">${esc(msg.nickname)}</span>`;

    // Time
    headerHtml += `<span class="msg-time">${formatTime()}</span>`;

    // Quote
    if (msg.quote) {
        bodyHtml += `<div class="msg-quote">${esc(msg.quoteNick || '')}: ${esc(msg.quote)}</div>`;
    }

    // Content with markdown
    bodyHtml += renderMarkdown(msg.content || '');

    div.innerHTML = '<div class="msg-header">' + headerHtml + '</div><div class="msg-body">' + bodyHtml + '</div>';

    if (isPrivate) div.classList.add('private');
    // @提及高亮
    if (!isSelf && msg.content && msg.content.includes('@' + nickname)) {
        div.classList.add('mentioned');
    }
    if (msg.msgId) addMsgId(msg.msgId, div);

    // Apply saved font and size
    const savedFont = localStorage.getItem('chatroom-font');
    if (savedFont) div.style.fontFamily = savedFont;
    const savedSize = localStorage.getItem('chatroom-fontsize');
    if (savedSize) div.style.fontSize = savedSize + 'px';

    messageArea.appendChild(div);

    // 代码高亮：marked 只管产出 <pre><code>，着色在这里做（幂等，见 highlightCodeBlocks）
    highlightCodeBlocks(div);

    // URL 预览：异步拉取 OG 标签渲染卡片
    var urlMatch = (msg.content || '').match(/https?:\/\/[^\s<>"']+/i);
    if (urlMatch) {
        var previewUrl = urlMatch[0];
        fetchPreviewCard(previewUrl, function(card) {
            if (card && card.title) {
                var cardDiv = document.createElement('div');
                cardDiv.className = 'url-preview-card';
                cardDiv.style.cssText = 'margin:6px 0 0;border-left:3px solid var(--accent);padding:8px 10px;background:var(--bg-tertiary);border-radius:0 4px 4px 0;max-width:400px;cursor:pointer';
                cardDiv.onclick = function() { window.open(previewUrl, '_blank'); };
                var img = card.image ? '<img src="' + esc(card.image) + '" style="width:100%;max-height:160px;object-fit:cover;border-radius:4px;margin-bottom:4px" onerror="this.style.display=\'none\'">' : '';
                cardDiv.innerHTML = img +
                    '<div style="font-size:13px;font-weight:600;color:var(--accent);margin-bottom:2px">' + esc(card.title || '') + '</div>' +
                    '<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(card.description || previewUrl) + '</div>';
                div.appendChild(cardDiv);
            }
        });
    }

    scrollToBottom();
}

// 异步获取 URL 预览卡片
var previewCache = {};
function fetchPreviewCard(url, cb) {
    if (previewCache[url]) { cb(previewCache[url]); return; }
    var pu = getApiBaseUrl() + '/api/files/preview?url=' + encodeURIComponent(url);
    var auth = getFileAuthParams();
    fetch(auth ? pu + '&' + auth : pu)
        .then(function(r) { return r.json(); })
        .then(function(data) { previewCache[url] = data; cb(data); })
        .catch(function() { cb(null); });
}

function handleRecall(msg) {
    const el = msgIdMap[msg.msgId];
    if (el) {
        el.innerHTML = '<span class="msg-recalled">[消息已撤回]</span>';
        el.classList.add('system');
    }
}

// ==================== Markdown Rendering ====================
function renderMarkdown(text) {
    if (!text) return '';
    if (typeof marked === 'undefined') return esc(text);
    try {
        // 数学公式：提取并替换为占位符，避免被 marked 转义
        var mathBlocks = [];
        var processed = text;
        // 块级公式 $$...$$
        processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, function(_, formula) {
            mathBlocks.push({ type: 'block', formula: formula.trim() });
            return '\u0000MATH' + (mathBlocks.length - 1) + '\u0000';
        });
        // 行内公式 $...$（不匹配 $$ 残余）
        processed = processed.replace(/(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g, function(_, formula) {
            mathBlocks.push({ type: 'inline', formula: formula.trim() });
            return '\u0000MATH' + (mathBlocks.length - 1) + '\u0000';
        });

        // ⚠️ 这里原来塞的是 `opts.highlight = function(code, lang){...}`，那是旧版 marked 的扩展点。
        // marked 自 v5 起移除了该选项（被静默忽略），所以代码块的产物一直只有
        // `<pre><code class="language-js">…</code></pre>`，没有任何 hljs 的 `<span class="hljs-*">`
        // ⇒ 代码块没有语法着色。修复方式改为「marked 只产出结构，插入 DOM 后再由
        // highlightCodeBlocks() 逐块调 hljs 后处理」（见 appendChatMessage）。
        var opts = { breaks: true };
        var parseFn = typeof marked.parse === 'function' ? marked.parse : marked;
        var html = parseFn(processed, opts);
        html = html.replace(/<p>/g, '').replace(/<\/p>/g, '<br>');
        if (html.endsWith('<br>')) html = html.slice(0, -4);
        html = html.replace(/<a /g, '<a target="_blank" rel="noopener" ');

        // 还原数学公式占位符
        mathBlocks.forEach(function(mb, i) {
            var placeholder = '\u0000MATH' + i + '\u0000';
            if (typeof katex !== 'undefined') {
                try {
                    var rendered = katex.renderToString(mb.formula, {
                        throwOnError: false,
                        displayMode: mb.type === 'block',
                        trust: true
                    });
                    html = html.replace(placeholder, rendered);
                } catch(e) {
                    html = html.replace(placeholder, '<code>' + esc(mb.formula) + '</code>');
                }
            } else {
                html = html.replace(placeholder, '<code>' + esc(mb.formula) + '</code>');
            }
        });

        return '<span class="md-rendered">' + html + '</span>';
    } catch (e) {
        return esc(text);
    }
}

// ==================== 代码高亮（T4 §0.1 修复） ====================
/**
 * 对 root 内所有 `.md-rendered pre code` 做语法着色。
 *
 * 为什么放在这里而不是 marked 的选项里：marked v5 起移除了 `highlight` 选项，只能后处理。
 *
 * 为什么必须打标记：`hljs.highlightElement()` 是「读 textContent → 重新生成 innerHTML」，
 * 对一个**已经高亮过**的元素再调一次，会把已经生成的 `<span class="hljs-*">` 当成源码文本
 * 再包一层（出现嵌套 span、颜色错乱）。而本项目会重复走到同一条渲染路径
 * （重连 history 回放、sync_since 补齐、Outbox 乐观气泡重放），所以必须幂等：
 * 处理过的元素打 `data-hljs="1"`，下次直接跳过。
 *
 * @param {Element|Document} root 作用范围
 * @returns {number} 本次实际处理了多少个代码块
 */
function highlightCodeBlocks(root) {
    if (typeof hljs === 'undefined' || !root) return 0;
    var scope = (root.nodeType === 1) ? root : document;
    var list = scope.querySelectorAll('.md-rendered pre code');
    var done = 0;
    for (var i = 0; i < list.length; i++) {
        var el = list[i];
        // 幂等守卫：自己打的标记 + hljs v11 自己打的标记
        if (el.getAttribute('data-hljs') === '1' || el.getAttribute('data-highlighted') === 'yes') continue;
        try {
            var m = /(?:^|\s)language-([\w+#.-]+)/.exec(el.className || '');
            var lang = m ? m[1] : '';
            if (lang && hljs.getLanguage(lang)) {
                el.innerHTML = hljs.highlight(el.textContent, { language: lang, ignoreIllegals: true }).value;
            } else {
                hljs.highlightElement(el);   // 交给 hljs 自动识别（它自己会置 data-highlighted）
            }
            el.classList.add('hljs');
            el.setAttribute('data-hljs', '1');
            done++;
        } catch (e) {
            console.warn('[HLJS] 代码块高亮失败:', e && e.message);
        }
    }
    return done;
}

// ==================== Voice Message ====================
// Resolve API base URL (server mode: same origin; client mode: chat server)
function getApiBaseUrl() {
    // API 调用优先用独立配置（允许与 WebSocket 不同目标）
    if (window.API_SERVER_HOST && window.API_SERVER_PORT) {
        var proto = location.protocol === 'https:' ? 'https:' : 'http:';
        return proto + '//' + window.API_SERVER_HOST + ':' + window.API_SERVER_PORT;
    } else if (window.API_SERVER_HOST) {
        var proto = location.protocol === 'https:' ? 'https:' : 'http:';
        return proto + '//' + window.API_SERVER_HOST;
    } else if (window.CHAT_SERVER_HOST && window.CHAT_SERVER_PORT) {
        var proto = location.protocol === 'https:' ? 'https:' : 'http:';
        return proto + '//' + window.CHAT_SERVER_HOST + ':' + window.CHAT_SERVER_PORT;
    } else if (window.CHAT_SERVER_HOST) {
        var proto = location.protocol === 'https:' ? 'https:' : 'http:';
        return proto + '//' + window.CHAT_SERVER_HOST;
    }
    return location.protocol + '//' + location.host;
}

// 获取文件访问认证参数（WebSocket 登录后由服务端下发）
var _fileAuthToken = sessionStorage.getItem('uchat-file-token') || '';
function getFileAuthParams() {
    if (!_fileAuthToken || !nickname) return '';
    return 'token=' + encodeURIComponent(_fileAuthToken) + '&nickname=' + encodeURIComponent(nickname);
}
function setFileAuthToken(token) {
    _fileAuthToken = token || '';
    if (token) sessionStorage.setItem('uchat-file-token', token);
    else sessionStorage.removeItem('uchat-file-token');
}

// ==================== File Message ====================
function appendFileMessage(msg) {
    const div = document.createElement('div');
    div.className = 'message';
    div.dataset.type = 'file';
    div.dataset.nickname = msg.nickname;
    div.dataset.msgId = msg.msgId || '';

    const base = getApiBaseUrl();
    const auth = getFileAuthParams();
    const isSelf = msg.nickname === nickname;
    const fname = esc(msg.filename || '');
    const ext = fname.split('.').pop().toLowerCase();
    const isVideo = /^(mp4|webm|m4v|mov|ogv|mkv|avi|flv|wmv)$/i.test(ext);
    const isAudio = /^(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i.test(ext);
    let quoteText = '';

    let html = `<span class="msg-nick ${isSelf ? 'self' : 'other'}">${esc(msg.nickname)}:</span>`;

    if (msg.filetype === 'image') {
        quoteText = '[图片] ' + fname;
        const imgUrl = base + '/api/files/preview/' + fname + (auth ? '?' + auth : '');
        // loading=lazy + decoding=async：视口外的图片不解码（媒体解码缓冲是页面内存的大头）
        html += `<br><img class="msg-img" src="${imgUrl}" alt="${fname}" loading="lazy" decoding="async">`;
        html += `<br><span style="font-size:12px;color:var(--text-muted)">${fname} (${formatFileSize(msg.size || 0)})</span>`;
    } else if (isVideo) {
        quoteText = '[视频] ' + fname;
        const videoUrl = base + '/api/files/preview/' + fname + (auth ? '?' + auth : '');
        const dlUrl = base + '/api/files/download/' + fname + (auth ? '?' + auth : '');
        if (isPlayableVideo(ext)) {
            // 可内嵌播放：缩略图 + 点开就地播放（服务端支持 Range ⇒ 边下边播、可拖进度）
            html += `<div class="msg-video-card" data-url="${videoUrl}" data-name="${fname}">`;
            html += `<div class="video-thumb" onclick="playInlineVideo(this)" title="点击播放" style="width:240px;height:135px;background:#000;border-radius:4px;display:flex;align-items:center;justify-content:center;position:relative;cursor:pointer;overflow:hidden">`;
            html += `<span style="font-size:32px">▶️</span>`;
            html += `<span class="video-dur" style="position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.7);color:#fff;font-size:11px;padding:1px 5px;border-radius:3px">--:--</span>`;
            html += `</div>`;
            html += `<br><span style="font-size:12px;color:var(--text-muted)">${fname} (${formatFileSize(msg.size || 0)})</span>`;
            html += `<a class="msg-dl" href="${dlUrl}" download title="下载原文件">⬇ 下载</a>`;
            html += `</div>`;
            // 原来的写法是每条视频消息都立刻建一个隐藏 <video preload=metadata> 探时长
            //（一个解码器 + 一次请求）；改成滚到视口附近才探（v2.9.11 内存优化）
            // ⚠️ 此刻 div.innerHTML 还没赋值，querySelector 必然拿到 null ⇒ 只记录，等 DOM 就位后再观察
            div._videoMetaUrl = videoUrl;
        } else {
            // 浏览器放不了的容器（avi/mkv/wmv…）：不挂播放器，明确说明 + 给下载
            html += `<div class="msg-media-unsupported">`;
            html += `<div style="font-weight:600">🎬 ${fname}</div>`;
            html += `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">`;
            html += `格式 <b>.${ext}</b> · ${formatFileSize(msg.size || 0)} · 浏览器无法内嵌播放（avi/mkv/wmv 等需用本地播放器）`;
            html += `</div>`;
            html += `<a class="msg-dl" href="${dlUrl}" download style="display:inline-block;margin-top:4px">⬇ 下载原文件</a>`;
            html += `</div>`;
        }
    } else if (isAudio) {
        // 音频：内联自绘播放器（v2.9.8）—— 原生 <audio controls> 的音量/倍速/下载藏在弹出菜单里，
        // 调完音量进度条会"收起"、菜单还可能被页面顶部遮挡；自绘后全部平铺在卡片里，不误触、不遮挡。
        quoteText = '[音频] ' + fname;
        const audioUrl = base + '/api/files/preview/' + fname + (auth ? '?' + auth : '');
        const dlUrl2 = base + '/api/files/download/' + fname + (auth ? '?' + auth : '');
        html += buildAudioPlayerHtml(uidSeed(), audioUrl, dlUrl2, '🎵 ' + fname + ' (' + formatFileSize(msg.size || 0) + ')');
    } else {
        quoteText = '[文件] ' + fname;
        html += `<div class="msg-file-card" onclick="downloadFile('${fname}')" title="点击下载">`;
        html += `📄 <span>${fname}</span> <span style="font-size:12px;color:var(--text-muted)">${formatFileSize(msg.size || 0)}</span>`;
        html += `</div>`;
    }
    html += `<span class="msg-time">${formatTime()}</span>`;

    div.innerHTML = html;
    // v2.9.11：DOM 就位后再把视频卡交给观察器（滚到视口附近才探测时长/建解码器）
    if (div._videoMetaUrl) {
        var vc = div.querySelector('.msg-video-card');
        var url2 = div._videoMetaUrl;
        watchNearViewport(vc, function () { loadVideoMeta(div, url2); }, 400);
    }
    div.dataset.content = quoteText;
    if (msg.msgId) addMsgId(msg.msgId, div);
    // Apply saved font and size
    var savedFont2 = localStorage.getItem('chatroom-font');
    if (savedFont2) div.style.fontFamily = savedFont2;
    var savedSize2 = localStorage.getItem('chatroom-fontsize');
    if (savedSize2) div.style.fontSize = savedSize2 + 'px';
    messageArea.appendChild(div);
    // Lazy check: mark stale files (404)
    if (msg.filename) {
        const checkUrl = base + '/api/files/download/' + encodeURIComponent(msg.filename) + (auth ? '?' + auth : '');
        fetch(checkUrl, { method: 'HEAD' }).then(r => {
            if (!r.ok) div.classList.add('stale-file');
        }).catch(() => {});
    }
    scrollToBottom();
}

// ==================== 内联音频播放器（v2.9.8） ====================
var _auSeq = 0;
function uidSeed() { return 'au' + (++_auSeq) + '_' + Date.now().toString(36); }
/** 浏览器能内嵌播放的容器（其余走"下载 + 说明"） */
function isPlayableVideo(ext) { return /^(mp4|webm|m4v|ogv|mov)$/i.test(ext); }

/**
 * 生成自绘音频播放器的 HTML。所有控件都在卡片里平铺：
 *   ▶/⏸ · 进度条 · 时间 · 倍速 · 音量 · ⬇下载
 * 不用原生 <audio controls> 的原因：音量/倍速/下载都藏在浏览器的弹出菜单里，
 * 调完音量进度条会收起（要再点一下才回来，极易误触），菜单还可能被页面顶部遮挡。
 */
function buildAudioPlayerHtml(uid, src, dlUrl, caption) {
    return '<div class="msg-audio-card" data-auid="' + uid + '">' +
        '<div class="au-row">' +
        '<button class="au-btn au-play" title="播放/暂停" onclick="auToggle(\'' + uid + '\')">▶</button>' +
        '<input class="au-seek" type="range" min="0" max="1000" value="0" step="1" ' +
        'oninput="auSeek(\'' + uid + '\', this.value)" title="进度">' +
        '<span class="au-time" title="当前/总时长">0:00 / 0:00</span>' +
        '</div>' +
        '<div class="au-row au-row2">' +
        '<button class="au-btn au-rate" title="倍速" onclick="auRate(\'' + uid + '\')">1.0×</button>' +
        '<span class="au-volwrap" title="音量">🔊<input class="au-vol" type="range" min="0" max="100" value="100" step="1" ' +
        'oninput="auVol(\'' + uid + '\', this.value)"></span>' +
        '<a class="au-dl" href="' + dlUrl + '" download title="下载原文件">⬇ 下载</a>' +
        '</div>' +
        '<div class="au-cap">' + caption + '</div>' +
        '<audio preload="metadata" src="' + src + '" style="display:none"></audio>' +
        '</div>';
}

/** 懒创建 <audio> 并接线（避免为每条历史消息都建播放器对象） */
function auCtx(uid) {
    var card = document.querySelector('[data-auid="' + uid + '"]');
    if (!card) return null;
    var a = card.querySelector('audio');
    if (!a) return null;
    // 交给视口观察器：滚远自动释放解码器（再滚回来会重新按 src 加载）
    if (!a._watched) {
        a._watched = true;
        var ob = _ensureMediaObserver();
        if (ob) ob.observe(card);
        else if (a.getAttribute('src')) a.preload = 'metadata';
    }
    if (!a._wired) {
        a._wired = true;
        a.addEventListener('loadedmetadata', function () { auPaint(uid); });
        a.addEventListener('durationchange', function () { auPaint(uid); });
        a.addEventListener('timeupdate', function () { auPaint(uid); });
        a.addEventListener('play', function () { auPaint(uid); });
        a.addEventListener('pause', function () { auPaint(uid); });
        a.addEventListener('ended', function () { a.currentTime = 0; auPaint(uid); });
        a.addEventListener('error', function () {
            var cap = card.querySelector('.au-cap');
            if (cap) cap.textContent = '⚠ 无法播放（浏览器不支持该编码或文件已删除）';
        });
    }
    return { card: card, a: a };
}
function auFmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}
function auPaint(uid) {
    var c = auCtx(uid); if (!c) return;
    var a = c.a, card = c.card;
    var dur = isFinite(a.duration) ? a.duration : 0;
    var seek = card.querySelector('.au-seek');
    if (seek && dur > 0 && !seek._dragging) seek.value = String(Math.round(a.currentTime / dur * 1000));
    var time = card.querySelector('.au-time');
    if (time) time.textContent = auFmt(a.currentTime) + ' / ' + auFmt(dur);
    var play = card.querySelector('.au-play');
    if (play) play.textContent = a.paused ? '▶' : '⏸';
}
function auToggle(uid) {
    var c = auCtx(uid); if (!c) return;
    if (c.a.paused) c.a.play().catch(function () { }); else c.a.pause();
    auPaint(uid);
}
function auSeek(uid, val) {
    var c = auCtx(uid); if (!c) return;
    var dur = isFinite(c.a.duration) ? c.a.duration : 0;
    var seek = c.card.querySelector('.au-seek');
    if (seek) { seek._dragging = true; setTimeout(function () { seek._dragging = false; }, 350); }
    if (dur > 0) c.a.currentTime = (Number(val) / 1000) * dur;
}
function auVol(uid, val) {
    var c = auCtx(uid); if (!c) return;
    c.a.volume = Math.max(0, Math.min(1, Number(val) / 100));
}
function auRate(uid) {
    var c = auCtx(uid); if (!c) return;
    var rates = [1, 1.25, 1.5, 2, 0.5];
    var cur = c.a.playbackRate || 1;
    var idx = rates.indexOf(cur); if (idx < 0) idx = 0;
    var next = rates[(idx + 1) % rates.length];
    try { c.a.playbackRate = next; } catch (e) { }
    var btn = c.card.querySelector('.au-rate');
    if (btn) btn.textContent = next.toFixed(next === 1 ? 1 : 2).replace(/0$/, '') + '×';
}

/**
 * 视频缩略图 → 就地展开成可播放的 <video>（2026-09-25 v2.9.7）
 * 走 /api/files/preview（inline + Range），所以是「边下边播」，不需要先下载整段。
 */
function playInlineVideo(thumb) {
    var card = thumb.closest ? thumb.closest('.msg-video-card') : null;
    if (!card) return;
    var url = card.dataset.url, name = card.dataset.name || '';
    var old = card.querySelector('video.msg-video-inline');
    if (old) { try { old.pause(); } catch (e) { } old.remove(); thumb.style.display = ''; return; }
    var v = document.createElement('video');
    v.className = 'msg-video-inline';
    v.controls = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.src = url;
    v.style.cssText = 'width:320px;max-width:100%;border-radius:6px;background:#000;display:block;margin:4px 0';
    // 就插在缩略图后面（缩略图的父节点就是卡片）
    thumb.parentNode.insertBefore(v, thumb.nextSibling);
    thumb.style.display = 'none';
    v.play().catch(function () { });
    // 视频播完把缩略图收回来
    v.addEventListener('ended', function () { try { v.pause(); } catch (e) { } v.remove(); thumb.style.display = ''; });
}

// ==================== 视口相关：延迟加载与自动释放（v2.9.11 内存优化） ====================
// 为什么要它：媒体元素（<audio>/<video>）一旦有 src 就会持有解码器与缓冲，
// 聊天记录里堆几十个音视频 = 几百 MB。策略：
//   · 进入视口附近（提前 400px）→ 回调（例如探测视频时长）
//   · 离开视口较远（超过 1200px）→ 释放：pause + 去掉 src + load()（解码器与缓冲随之回收）
var _mediaObserver = null;
function _ensureMediaObserver() {
    if (_mediaObserver || typeof IntersectionObserver === 'undefined') return _mediaObserver;
    _mediaObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
            var el = e.target;
            if (e.isIntersecting) {
                if (typeof el._onNear === 'function') el._onNear();
            } else {
                // 滚远了：把媒体释放掉（只在它确实带 src 时做，避免无谓抖动）
                var m = el.querySelector ? el.querySelector('audio,video') : null;
                if (m && m.getAttribute('src')) {
                    try { m.pause(); } catch (err) { }
                    m.removeAttribute('src');
                    try { m.load(); } catch (err) { }
                }
            }
        });
    }, { rootMargin: '400px 0px 1200px 0px', threshold: 0 });
    return _mediaObserver;
}
/** 元素进入视口附近时执行一次 cb（用于延迟探测/延迟加载） */
function watchNearViewport(el, cb, marginPx) {
    if (!el || typeof IntersectionObserver === 'undefined') { if (cb) setTimeout(cb, 100); return; }
    el._onNear = cb;
    var ob = _ensureMediaObserver();
    if (ob) ob.observe(el); else if (cb) setTimeout(cb, 100);
}

function loadVideoMeta(div, url) {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;
    video.onloadedmetadata = () => {
        const dur = video.duration;
        if (dur && isFinite(dur)) {
            const m = Math.floor(dur / 60);
            const s = Math.floor(dur % 60);
            const durEl = div.querySelector('.video-dur');
            if (durEl) durEl.textContent = m + ':' + String(s).padStart(2,'0');
        }
        // Capture thumbnail at 1s
        video.currentTime = Math.min(1, video.duration * 0.1);
    };
    video.onseeked = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 240; canvas.height = 135;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 240, 135);
        const thumb = div.querySelector('.video-thumb');
        if (thumb) {
            thumb.innerHTML = '';
            thumb.appendChild(canvas);
            const durEl = document.createElement('span');
            durEl.className = 'video-dur';
            durEl.style.cssText = 'position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.7);color:#fff;font-size:11px;padding:1px 5px;border-radius:3px';
            const d = video.duration;
            durEl.textContent = Math.floor(d/60) + ':' + String(Math.floor(d%60)).padStart(2,'0');
            thumb.appendChild(durEl);
        }
        video.remove();
    };
    video.onerror = () => video.remove();
    // Click to play in new tab
    div.querySelector('.video-thumb').onclick = () => window.open(url, '_blank');
}

function downloadFile(filename) {
    var auth = getFileAuthParams();
    var url = getApiBaseUrl() + '/api/files/download/' + encodeURIComponent(filename);
    window.open(auth ? url + '?' + auth : url, '_blank');
}

// ==================== Image Lightbox ====================
let lightboxImgs = [];
let lightboxIdx = 0;
let imgRotation = 0;
let imgScale = 1;
let imgDragging = false, imgDragX, imgDragY, imgLeft, imgTop;

function openLightbox(imgSrc) {
    lightboxImgs = [];
    messageArea.querySelectorAll('img.msg-img').forEach((img, i) => {
        lightboxImgs.push(img.src);
        if (img.src === imgSrc) lightboxIdx = i;
    });
    showLightboxImg();
    $('img-lightbox').style.display = 'flex';
}

function closeLightbox() { $('img-lightbox').style.display = 'none'; }

function showLightboxImg() {
    const img = $('img-preview');
    imgRotation = 0; imgScale = 1;
    img.style.transform = 'rotate(0deg) scale(1)';
    img.style.left = ''; img.style.top = '';
    img.src = lightboxImgs[lightboxIdx];
    $('img-counter').textContent = (lightboxIdx + 1) + ' / ' + lightboxImgs.length;
}

function prevImg() { if (lightboxImgs.length > 1) { lightboxIdx = (lightboxIdx - 1 + lightboxImgs.length) % lightboxImgs.length; showLightboxImg(); } }
function nextImg() { if (lightboxImgs.length > 1) { lightboxIdx = (lightboxIdx + 1) % lightboxImgs.length; showLightboxImg(); } }

function rotateImg(deg) {
    imgRotation = (imgRotation + deg) % 360;
    applyTransform();
}

function zoomImg(delta) {
    imgScale = Math.max(0.2, Math.min(5, imgScale + delta));
    applyTransform();
}

function resetImg() { imgRotation = 0; imgScale = 1; applyTransform(); }

function applyTransform() {
    $('img-preview').style.transform = `rotate(${imgRotation}deg) scale(${imgScale})`;
}

async function saveImg() {
    try {
        const url = lightboxImgs[lightboxIdx];
        const resp = await fetch(url);
        const blob = await resp.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = url.split('/').pop().split('?')[0] || 'image';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objUrl);
    } catch(e) {
        // Fallback: open in new tab for download
        window.open(lightboxImgs[lightboxIdx], '_blank');
    }
}

// Keyboard
document.addEventListener('keydown', e => {
    if ($('img-lightbox').style.display !== 'flex') return;
    if (e.key === 'ArrowLeft') prevImg();
    if (e.key === 'ArrowRight') nextImg();
    if (e.key === 'Escape') closeLightbox();
});

// Wheel zoom
$('img-preview').addEventListener('wheel', e => { e.preventDefault(); zoomImg(e.deltaY < 0 ? 0.1 : -0.1); });

// Click to open lightbox (delegated)
messageArea.addEventListener('click', e => {
    const img = e.target.closest('img.msg-img');
    if (img) openLightbox(img.src);
});

// Close on backdrop click
$('img-lightbox').addEventListener('click', e => {
    if (e.target === $('img-lightbox')) closeLightbox();
});

// ==================== Message Search (Enhanced) ====================
let searchResults = [];
let searchIdx = -1;
let searchDebounceTimer = null;
const SEARCH_HISTORY_KEY = 'uchat-search-history';
const MAX_SEARCH_HISTORY = 10;

function loadSearchHistory() {
    try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); } catch(e) { return []; }
}
function saveSearchHistory(term) {
    var hist = loadSearchHistory().filter(function(h) { return h !== term; });
    hist.unshift(term);
    if (hist.length > MAX_SEARCH_HISTORY) hist.pop();
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(hist));
}

$('btn-search-toggle').addEventListener('click', function() {
    $('search-modal').style.display = 'flex';
    $('search-keyword').value = '';
    $('search-sender').value = '';
    $('search-date').value = '';
    clearSearchHighlights();
    $('search-count').textContent = '';
    updateSearchSenderDatalist();
    renderSearchHistory();
    $('search-keyword').focus();
});

function updateSearchSenderDatalist() {
    var list = $('search-sender-list');
    list.innerHTML = '';
    var seen = {};
    // 先加在线用户
    if (typeof onlineUsers !== 'undefined' && onlineUsers.length) {
        onlineUsers.forEach(function(u) { if (!seen[u]) { seen[u] = true; list.innerHTML += '<option value="' + esc(u) + '">'; } });
    }
    // 再加当前可见消息中的发言人
    document.querySelectorAll('#message-area .message:not(.system)').forEach(function(m) {
        var n = m.dataset.nickname;
        if (n && !seen[n]) { seen[n] = true; list.innerHTML += '<option value="' + esc(n) + '">'; }
    });
}

function renderSearchHistory() {
    var hist = loadSearchHistory();
    var el = $('search-history');
    if (hist.length === 0) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML = '<span style="color:var(--text-muted);margin-right:4px">历史:</span>' +
        hist.map(function(h) {
            return '<span style="background:var(--bg-tertiary);padding:2px 8px;border-radius:10px;cursor:pointer;color:var(--text-secondary)" data-term="' + esc(h) + '">' + esc(h) + '</span>';
        }).join('');
    el.querySelectorAll('span[data-term]').forEach(function(s) {
        s.addEventListener('click', function() {
            $('search-keyword').value = this.dataset.term;
            doSearch();
        });
        s.addEventListener('mouseenter', function() { this.style.background = 'var(--accent-light)'; this.style.color = 'var(--accent)'; });
        s.addEventListener('mouseleave', function() { this.style.background = 'var(--bg-tertiary)'; this.style.color = 'var(--text-secondary)'; });
    });
}

function doSearch() {
    saveSearchHistory($('search-keyword').value.trim());
    renderSearchHistory();
    clearSearchHighlights();
    searchResults = [];
    searchIdx = -1;
    var kw = $('search-keyword').value.trim();
    var sender = $('search-sender').value.trim().toLowerCase();
    // 多关键词：空格分隔
    var words = kw ? kw.toLowerCase().split(/\s+/).filter(function(w){ return w.length > 0; }) : [];

    document.querySelectorAll('#message-area .message:not(.system)').forEach(function(m) {
        var text = (m.dataset.content || m.textContent || '').toLowerCase();
        var nick = (m.dataset.nickname || '').toLowerCase();
        // 多关键词全部命中
        if (words.length > 0) {
            for (var i = 0; i < words.length; i++) {
                if (text.indexOf(words[i]) === -1) return;
            }
        }
        if (sender && nick !== sender) return;
        searchResults.push(m);
    });
    // 高亮所有匹配项
    searchResults.forEach(function(m) { m.classList.add('search-match'); });
    $('search-count').textContent = searchResults.length > 0 ? searchResults.length + ' 条' : '无结果';
    if (searchResults.length > 0) {
        searchIdx = 0;
        scrollToSearchResult(0);
    }
}

function scrollToSearchResult(idx) {
    searchResults.forEach(function(m, i) { m.classList.toggle('search-highlight', i === idx); });
    if (searchResults[idx]) {
        searchResults[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    $('search-count').textContent = (idx + 1) + '/' + searchResults.length;
}

// 搜索输入去抖
$('search-keyword').addEventListener('input', function() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(doSearch, 250);
    updateSearchSenderDatalist();
});
$('search-sender').addEventListener('input', function() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(doSearch, 250);
});
$('search-date').addEventListener('change', doSearch);

// 导航
$('btn-search-prev').addEventListener('click', function() {
    if (!searchResults.length) return;
    searchIdx = (searchIdx - 1 + searchResults.length) % searchResults.length;
    scrollToSearchResult(searchIdx);
});
$('btn-search-next').addEventListener('click', function() {
    if (!searchResults.length) return;
    searchIdx = (searchIdx + 1) % searchResults.length;
    scrollToSearchResult(searchIdx);
});
// 键盘导航
$('search-keyword').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
            searchIdx = (searchIdx - 1 + searchResults.length) % searchResults.length;
        } else {
            searchIdx = (searchIdx + 1) % searchResults.length;
        }
        if (searchResults.length) scrollToSearchResult(searchIdx);
    }
    if (e.key === 'Escape') { $('search-modal').style.display = 'none'; clearSearchHighlights(); }
});

$('btn-search-close').addEventListener('click', function() {
    $('search-modal').style.display = 'none';
    clearSearchHighlights();
});
$('search-modal').addEventListener('click', function(e) {
    if (e.target === $('search-modal')) { $('search-modal').style.display = 'none'; clearSearchHighlights(); }
});

function clearSearchHighlights() {
    document.querySelectorAll('#message-area .search-highlight, #message-area .search-match').forEach(function(m) {
        m.classList.remove('search-highlight', 'search-match');
    });
    searchResults = [];
    searchIdx = -1;
}

// ==================== Offline Mode (指数退避自动重连) ====================
let offlineMode = false;
let autoReconnectTimer = null;
let autoReconnectCount = 0;
let serverDead = false;                      // 服务器是否确认宕机
let lastOfflineNoticeAt = 0;                 // 同一轮故障只提示一次
let offlineSince = 0;                        // 本轮离线开始时间
let lastRetryAt = 0;                         // 手动/事件触发重试的冷却

/**
 * 重连退避序列。旧版是「固定 30 秒一次」，而且**第一次也要等 30 秒** ——
 * 主机网络抖动 3 秒，用户却要盯着"正在重连 (1/10)"看满 30 秒。
 * 现在：首次几乎立即重试，之后指数增长到 30 秒封顶。
 */
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];
const RECONNECT_CAP_MS = 15000;              // 到顶后一直按这个间隔重试，不再放弃
                                             // （房间上限 16 人，15 秒一次即每分钟最多 64 次连接请求，可忽略）
const RECONNECT_JITTER = 0.25;               // ±25% 抖动：避免所有人同时打服务器

function isOffline() { return offlineMode; }

/** 第 attempt 次重试的等待时长（含抖动） */
function reconnectDelay(attempt) {
    var base = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
    base = Math.min(base, RECONNECT_CAP_MS);
    var jitter = base * RECONNECT_JITTER;
    return Math.max(300, Math.round(base + (Math.random() * 2 - 1) * jitter));
}

function checkServerHealth() {
    var base = (location.protocol + '//' + location.host).replace(/\/$/, '');
    return fetch(base + '/api/health', { method: 'GET', signal: AbortSignal.timeout(5000) })
        .then(r => r.json())
        .then(data => {
            if (data && data.status === 'ok') {
                if (serverDead) {
                    serverDead = false;
                    showToast('服务器已恢复', 'info');
                }
                return true;
            }
            serverDead = true;
            return false;
        })
        .catch(() => {
            serverDead = true;
            return false;
        });
}

function enterOfflineMode() {
    if (offlineMode) return;
    offlineMode = true;
    offlineSince = Date.now();

    // T4：离线时**不再禁用输入框**。用户继续输入并按 Enter 时，消息会进 Outbox 队列
    // （localStorage 持久化），连接恢复后自动送达 —— 这就是"消息不丢"的用户可见形态。
    // 发送按钮的文案仍是「重连」（点它=立即重试连接），语义不冲突。
    msgInput.disabled = false;
    msgInput.placeholder = '离线中：按 Enter 发送会排队，恢复连接后自动送达';
    msgInput.classList.add('recording-placeholder');

    sendBtn.textContent = '重连';
    sendBtn.classList.add('reconnect');

    if (Date.now() - lastOfflineNoticeAt > 5000) {
        lastOfflineNoticeAt = Date.now();
        showToast('连接断开，正在自动重连（点"重连"可立即重试）', 'info');
    }
    startAutoReconnect();
}

function exitOfflineMode() {
    offlineMode = false;
    serverDead = false;
    offlineSince = 0;
    stopAutoReconnect();
    autoReconnectCount = 0;

    msgInput.disabled = false;
    msgInput.placeholder = '输入消息... (支持 Markdown)';
    msgInput.classList.remove('recording-placeholder');

    sendBtn.textContent = '发送';
    sendBtn.classList.remove('reconnect');

    // T4：连接恢复 → 立刻把积压的消息发出去（同一条消息仍是原来的 msgId）
    var _ob = outboxApi();
    if (_ob) _ob.flush();
}

function startAutoReconnect() {
    stopAutoReconnect();
    autoReconnectCount = 0;
    if (!offlineMode) return;
    // 立即发起第一次尝试（旧版要先干等 30 秒）
    scheduleAutoReconnect();
}

function stopAutoReconnect() {
    if (autoReconnectTimer) { clearTimeout(autoReconnectTimer); autoReconnectTimer = null; }
}

function scheduleAutoReconnect() {
    if (supersededByOtherDevice) return;    // 被顶替后不再排队重连
    if (!offlineMode) return;
    if (autoReconnectTimer) return;          // 已有待执行的重试，不重复排队
    var delay = reconnectDelay(autoReconnectCount);
    autoReconnectCount++;
    var secs = Math.round(delay / 100) / 10;
    var elapsed = offlineSince ? Math.round((Date.now() - offlineSince) / 1000) : 0;
    msgInput.placeholder = '正在重连... 第 ' + autoReconnectCount + ' 次，' +
        secs + 's 后重试（已断开 ' + elapsed + 's）';
    autoReconnectTimer = setTimeout(function () {
        autoReconnectTimer = null;
        doAutoReconnect();
    }, delay);
}

/** 读取会话里保存的凭据（sessionStorage） */
function savedCredentials() {
    return {
        nick: sessionStorage.getItem('uchat-nick') || nickname,
        pwd: sessionStorage.getItem('uchat-pwd')
    };
}

function doAutoReconnect() {
    if (supersededByOtherDevice) return;    // 被顶替后不再自动重连
    if (!offlineMode) return;
    var c = savedCredentials();
    if (!c.nick || !c.pwd) {
        // 没有凭据才回登录页；旧版是"重试 10 次就放弃并清空密码框"
        goToLogin('缺少登录凭据，请重新登录');
        return;
    }
    if (ws && ws.readyState === WebSocket.CONNECTING) return;   // 上一次还挂着
    lastRetryAt = Date.now();
    connectWebSocket('login', c.nick, c.pwd, null);
}

function tryReconnect() {
    // 手动重连：立即尝试，并重置退避（用户主动行为，不必再等）
    if (!offlineMode) return;
    var c = savedCredentials();
    if (!c.nick || !c.pwd) {
        goToLogin('缺少登录凭据，请重新登录');
        return;
    }
    if (Date.now() - lastRetryAt < 800) return;   // 防连点
    stopAutoReconnect();
    autoReconnectCount = 0;
    lastRetryAt = Date.now();
    showToast('正在重连...', 'info');
    connectWebSocket('login', c.nick, c.pwd, null);
}

/**
 * 立刻重试（不等退避计时器）。用于网络恢复、标签页回到前台等确定性信号。
 * 背景标签页里 setTimeout 会被浏览器节流到 ≥1 分钟，所以这些事件是必要的补充。
 */
function retryNow(reason, resetBackoff) {
    if (!offlineMode) return;
    if (Date.now() - lastRetryAt < 1000) return;
    if (autoReconnectTimer) { clearTimeout(autoReconnectTimer); autoReconnectTimer = null; }
    if (resetBackoff) autoReconnectCount = 0;
    console.log('[重连] 立即重试（' + reason + '）');
    doAutoReconnect();
}

window.addEventListener('online', function () { retryNow('网络已恢复', true); });
document.addEventListener('visibilitychange', function () {
    if (!document.hidden) retryNow('标签页回到前台', false);
});
window.addEventListener('focus', function () { retryNow('窗口获得焦点', false); });
window.addEventListener('pageshow', function (e) { if (e.persisted) retryNow('页面从缓存恢复', false); });

function goToLogin(msg) {
    exitOfflineMode();
    mainApp.classList.add('hidden');
    loginOverlay.classList.remove('hidden');
    $('login-nick').value = nickname;
    $('login-pwd').value = '';
    $('login-error').textContent = msg || '连接断开，请重新登录';
    $('login-pwd').focus();
}

// ==================== Utility ====================
function scrollToBottom() {
    setTimeout(() => {
        messageArea.scrollTop = messageArea.scrollHeight;
    }, 50);
}

// Override connectWebSocket: if HTTP mode, use HTTP
// 2026-09-25 清理：这里原本有一套「HTTP 兜底聊天」的覆盖（/api/chat/auth|send|poll），
// 但那些接口随 ChatHttpController 一起删掉了（v2.9.7），代码早已不可用 ⇒ 整段移除。
var _origSendTextMessage2 = typeof sendTextMessage === 'function' ? sendTextMessage : function(){};
sendTextMessage = function() {
    _origSendTextMessage2();
};

/* ======================================================================
 * T4 · 客户端消息可靠性：把发送路径接到 Outbox（发送队列 / 重发 / 去重 / 未读通知）
 * ====================================================================== */

// outbox.js 是本任务新增的文件，而 index.html 本轮不在授权改动清单里 ⇒ 在这里动态注入。
// 同源、相对路径与 index.html 里其它 <script src="js/..."> 写法一致。
// 注入失败（404 等）时下面的发送路径会自动退回"直接 ws.send"的老行为，不会把功能弄坏。
(function loadOutboxModule() {
    if (window.Outbox || document.getElementById('uchat-outbox-js')) return;
    var s = document.createElement('script');
    s.id = 'uchat-outbox-js';
    s.src = 'js/outbox.js?v=' + Date.now();
    s.onload = function () {
        // 脚本可能在登录之后才加载完（例如缓存）→ 补一次初始化
        if (window.Outbox && typeof nickname !== 'undefined' && nickname &&
            !mainApp.classList.contains('hidden')) {
            window.Outbox.onConnected(nickname);
        }
    };
    s.onerror = function () { console.warn('[T4] outbox.js 加载失败，发送路径退回直发模式'); };
    (document.head || document.documentElement).appendChild(s);
})();

// 关掉这一层 HTTP 包装，拿到"HTTP 模式判断 + 原发送逻辑"这一版作为兜底
var _sendTextBeforeOutbox = sendTextMessage;
var _t4MsgSeq = 0;

/**
 * T4 发送入口。与原实现的区别只有两点：
 *   1. **不再直接 ws.send**，而是交给 Outbox 入队（持久化 + 断线重发 + 状态 UI）；
 *   2. **msgId 只生成一次并复用** —— 重发时仍是同一个 msgId，服务端据此幂等去重（这是"不重"的关键）。
 * 输入框内容仍按原逻辑在"入队成功"后清空（离线时也清空，因为消息已经落到队列里了）。
 */
sendTextMessage = function () {
    // HTTP 回退模式保持原样（该模式不落 history，sync_since 也补不到，不在本任务范围）
    // 2026-09-25：HTTP 兜底已移除，这里不再需要分支

    var text = msgInput ? msgInput.value.trim() : '';
    if (!text) return;
    if (typeof nickname === 'undefined' || !nickname) return;

    var msgId = Date.now() + '_' + (_t4MsgSeq++);
    var msg;
    if (typeof replyTo !== 'undefined' && replyTo) {
        msg = { type: 'chat', nickname: nickname, content: text, msgId: msgId,
                quote: replyTo.content, quoteNick: replyTo.nickname };
        replyTo = null;
        msgInput.placeholder = '输入消息... (支持 Markdown)';
    } else {
        msg = { type: 'chat', nickname: nickname, content: text, msgId: msgId };
    }

    var ob = outboxApi();
    if (ob) {
        ob.enqueue(msg);
    } else {
        // 兜底：outbox 未就绪 → 老行为（只在连接可用时直发）
        if (isOffline()) { showToast('连接已断开，请先重连', 'error'); return; }
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
            ws.send(JSON.stringify(msg));
        } catch (e) {
            showToast('消息发送失败，请重试', 'error');
            return;
        }
    }
    msgInput.value = '';
    msgInput.style.height = 'auto';
};

/* ----------------------------------------------------------------------
 * T4：登录/重连成功时"保证执行"的钩子
 *
 * 🔴 实测到的一个坑（与本任务无关的项目既有 bug，app.js 本轮冻结 ⇒ 只上报不改）：
 *   `onLoginSuccess()`（app.js:289）会调用 `applyToolbarVisibility()`，而该函数被**误声明在
 *   `initChangePwdUI()` 内部**（app.js:870，缩进也对得上），并不是全局函数
 *   ⇒ 每次登录成功都抛 `ReferenceError: applyToolbarVisibility is not defined`，
 *   这个异常被 `ws.onmessage` 外层的 try/catch 吞掉（只打印 "Parse error:"），
 *   于是**写在 `onLoginSuccess()` 后面的语句永远不会执行**。
 *
 *   我第一版就是把 `Outbox.onConnected()` 直接写在 auth_resp 分支里 ⇒ 在真实页面上
 *   Outbox 从来没被初始化过（harness 抓到的证据：`diag.onConn=0`、队列一直停在 localStorage）。
 *
 * 所以这里用 try/finally 把 `onLoginSuccess` / `exitOfflineMode` 包一层：
 * 无论被包的函数正常返回还是抛异常，钩子都一定会跑到。
 * ⚠️ finally 里**不能有 return / 抛异常**，否则会把原始异常吞掉（改变既有行为）。
 * ---------------------------------------------------------------------- */
(function hookLoginSuccessForOutbox() {
    function wrap(name) {
        var orig = window[name];
        if (typeof orig !== 'function') {
            console.warn('[T4] ' + name + ' 未定义，跳过挂钩');
            return;
        }
        window[name] = function () {
            try {
                return orig.apply(this, arguments);
            } finally {
                try {
                    var visible = !(typeof mainApp !== 'undefined' && mainApp && mainApp.classList.contains('hidden'));
                    var ob = outboxApi();
                    if (visible && ob && typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
                        ob.onConnected(nickname);
                    }
                } catch (e) {
                    console.error('[T4] outbox 登录钩子失败:', e);
                }
            }
        };
    }
    wrap('onLoginSuccess');
    wrap('exitOfflineMode');
})();
