/* ===== app.js — 主入口、登录、主题、UI逻辑 ===== */

// Global state
let nickname = '';
let theme = 'light'; // 始终默认白天模式
let replyTo = null;
let selectedMsg = null;
let contextTarget = null;
let privateChatTarget = null;
let privateHistory = {};
try { privateHistory = JSON.parse(localStorage.getItem('pmHistory') || '{}'); } catch(e) {}
// 私聊未读计数：partner -> 条数（本机按到达的新消息累加；服务端 private_pending 的数字另存为"下限"）
let pmUnread = {};
try { pmUnread = JSON.parse(localStorage.getItem('pmUnread') || '{}'); } catch(e) {}
// 服务端声明的未读数（登录时下发）。**不能直接累加到 pmUnread**：登录流程里
// private_pending 先到、随后每条补投消息还会各 +1，直接相加会把同一个人的未读数算两遍（实测 2 → 4）。
// 所以它只作为"下限兜底"（换设备 / 清了本地缓存时本地没有条目，仍能显示未读），读取时取 max。
let pmUnreadFloor = {};
try { pmUnreadFloor = JSON.parse(localStorage.getItem('pmUnreadFloor') || '{}'); } catch(e) {}
let mutedUsers = new Set(JSON.parse(localStorage.getItem('mutedUsers') || '[]'));
let notifyVolume = parseFloat(localStorage.getItem('notifyVolume') || '0.4');
function notifyGain() { return notifyVolume * 0.25; }
let typingTimer = null;
let typingUsers = {};
// 用户实时状态标签
let _userStatuses = {}; // nickname -> { call, voice, music, screen }
let _typingTimers = {};  // nickname -> timeoutId (独立存储，不混入 _userStatuses)
let unreadCount = 0;
let pageTitle = 'Uchat';

// DOM refs
const $ = id => document.getElementById(id);
const loginOverlay = $('login-overlay');
const mainApp = $('main-app');
const messageArea = $('message-area');
const msgInput = $('msg-input');
const sendBtn = $('send-btn');
const userList = $('user-list');
const userCount = $('user-count');
const emojiPicker = $('emoji-picker');
const APP_VERSION = '2.9.16';   // 版本号单一来源（教程与登录页共用）
const contextMenu = $('context-menu');
const toast = $('toast');

// ==================== Init ====================
function loadLocalPrefs() {
    var raw = localStorage.getItem('uchat-prefs-' + nickname);
    if (!raw && nickname) {
        // 尝试从旧格式迁移
        var old = {};
        if (localStorage.getItem('chatroom-theme')) old.theme = localStorage.getItem('chatroom-theme');
        if (localStorage.getItem('chatroom-font')) old.font = localStorage.getItem('chatroom-font');
        if (raw = JSON.stringify(old)) localStorage.setItem('uchat-prefs-' + nickname, raw);
    }
    if (raw) {
        try {
            var p = JSON.parse(raw);
            if (p.theme && p.theme !== theme) { theme = p.theme; applyTheme(); }
            if (p.font) document.querySelectorAll('.message').forEach(function(m){m.style.fontFamily=p.font;});
            if (p.fontsize) document.querySelectorAll('.message').forEach(function(m){m.style.fontSize=p.fontsize+'px';});
        } catch(e) {}
    }
}
document.addEventListener('DOMContentLoaded', () => {
    loadTheme();          // 尽早应用已保存主题，避免亮暗闪烁
    loadLocalPrefs();
    // 密码显隐切换
    document.querySelectorAll('.pwd-toggle').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var input = document.getElementById(this.dataset.target);
            if (input) {
                input.type = input.type === 'password' ? 'text' : 'password';
                this.textContent = input.type === 'password' ? '\u2299' : '\u25CB';
            }
        });
    });
    initLoginUI();
    initEmojiPicker();
    initContextMenu();
    initSettingsUI();
    initMdToolbar();
    initToolbarToggleUI();
    initDeviceListeners();
    initPrivateChatUI();
    initChangePwdUI();
    initGuideReplay();
    // 切换账号
    var switchBtn = $('btn-switch-account');
    if (switchBtn) switchBtn.addEventListener('click', switchAccount);
    // 设置卡里加「安装到桌面」（PWA）
    try {
        var card = document.querySelector('.settings-card');
        var row = document.createElement('div');
        row.className = 'setting-row';
        row.innerHTML = '<span>安装到桌面</span><span><button id="btn-install-app" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border-color);background:var(--btn-bg);color:var(--text-primary);cursor:pointer">安装</button></span>';
        var ref2 = document.getElementById('btn-change-pwd');
        if (card) card.insertBefore(row, ref2 ? ref2.parentElement : null);
        var ib = document.getElementById('btn-install-app');
        if (ib) ib.addEventListener('click', installApp);
    } catch (e) { }
    initPwa();
    // 页面关闭/刷新前保存设置到服务器
    window.addEventListener('beforeunload', function() {
        if (nickname) saveUserPrefs();
    });
    // 加载记住的账号
    if (localStorage.getItem('uchat-remember-nick') === '1') {
        var savedNick = localStorage.getItem('uchat-account');
        if (savedNick) $('login-nick').value = savedNick;
        $('login-remember-nick').checked = true;
    }
    if (localStorage.getItem('uchat-remember-pwd') === '1') {
        var savedPwd = localStorage.getItem('uchat-password');
        if (savedPwd) $('login-pwd').value = savedPwd;
        $('login-remember-pwd').checked = true;
    }
    // 勾选记住密码时自动勾选记住账号
    $('login-remember-pwd').addEventListener('change', function() {
        if (this.checked) $('login-remember-nick').checked = true;
    });
    $('login-remember-nick').addEventListener('change', function() {
        if (!this.checked) { $('login-remember-pwd').checked = false; $('login-auto-login').checked = false; }
    });
    $('login-auto-login').addEventListener('change', function() {
        if (this.checked) { $('login-remember-nick').checked = true; $('login-remember-pwd').checked = true; }
    });
    // 自动登录
    if (localStorage.getItem('uchat-auto-login') === '1') {
        var autoNick = localStorage.getItem('uchat-account');
        var autoPwd = localStorage.getItem('uchat-password');
        if (autoNick && autoPwd) {
            $('login-auto-login').checked = true;
            $('login-remember-nick').checked = true;
            $('login-remember-pwd').checked = true;
            nickname = autoNick;
            $('login-nick').value = autoNick;
            $('login-pwd').value = autoPwd;
            if (window.IS_CLIENT_MODE) {
                $('login-server').value = (window.CHAT_SERVER_HOST || '26.136.34.205') + ':' + (window.CHAT_SERVER_PORT || 8888);
            }
            connectWebSocket('login', autoNick, autoPwd, $('login-error'));
        }
    }
});

// ==================== PWA：装到桌面（2026-09-25 v2.9.16） ====================
// Service Worker 是"可安装"的前提；策略是网络优先（见 sw.js），不会让用户看到旧版本。
var _installPrompt = null;
function initPwa() {
    try {
        if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
            navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('[PWA] SW 注册失败:', e && e.message); });
        }
    } catch (e) { }
    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        _installPrompt = e;
        var b = document.getElementById('btn-install-app');
        if (b) b.style.display = '';
    });
    window.addEventListener('appinstalled', function () {
        _installPrompt = null;
        var b = document.getElementById('btn-install-app');
        if (b) b.style.display = 'none';
        if (typeof showToast === 'function') showToast('Uchat 已装到桌面 ✓', 'success');
    });
    // 已经是"安装后"的独立窗口 ⇒ 不需要再显示安装按钮
    try {
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
            var b2 = document.getElementById('btn-install-app');
            if (b2) b2.style.display = 'none';
        }
    } catch (e) { }
}
function installApp() {
    if (_installPrompt) { _installPrompt.prompt(); return; }
    if (typeof showToast === 'function') {
        showToast('请点浏览器地址栏右侧的「安装」图标（或菜单：安装 Uchat）。装好后可独立窗口打开。', 'info');
    }
}

// ==================== Theme ====================
function applyTheme() {
    document.body.setAttribute('data-theme', theme);
}

function applyFontSize(size) {
    document.querySelectorAll('.message').forEach(m => m.style.fontSize = size + 'px');
    msgInput.style.fontSize = size + 'px';
}

function toggleTheme() {
    theme = theme === 'light' ? 'dark' : 'light';
    applyTheme();
    saveAllPrefs();
    saveUserPrefs();
    if (typeof reapplyChatBg === 'function') reapplyChatBg();
    showToast(theme === 'dark' ? 'Dark mode' : 'Light mode', 'info');
}

function loadTheme() {
    var saved = localStorage.getItem('chatroom-theme');
    if (saved) theme = saved;
    else theme = 'light';
    applyTheme();
}

// ==================== Login UI ====================
function initLoginUI() {
    const tabs = document.querySelectorAll('.tab');
    const loginBtn = $('login-btn');
    const loginNick = $('login-nick');
    const loginPwd = $('login-pwd');
    const loginNewPwd = $('login-new-pwd');
    const loginServer = $('login-server');
    const loginError = $('login-error');
    const serverGroup = $('server-addr-group');
    const newPwdGroup = $('new-pwd-group');
    let mode = 'login';

    if (window.IS_CLIENT_MODE) {
        serverGroup.style.display = '';
        if (window.CHAT_SERVER_HOST) {
            loginServer.value = window.CHAT_SERVER_HOST + ':' + (window.CHAT_SERVER_PORT || 8888);
        }
    }

    const pwdGroup = $('login-pwd-group');
    const guestCodeGroup = $('guest-code-group');

    tabs.forEach(t => t.addEventListener('click', () => {
        tabs.forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        mode = t.dataset.tab;
        loginError.textContent = '';
        var inviteGroup = document.getElementById('invite-group');
        if (mode === 'changepwd') {
            loginBtn.textContent = '修改密码';
            pwdGroup.style.display = '';
            newPwdGroup.style.display = '';
            inviteGroup.style.display = 'none';
            loginPwd.setAttribute('required', '');
        } else if (mode === 'register') {
            loginBtn.textContent = '注册';
            pwdGroup.style.display = '';
            newPwdGroup.style.display = 'none';
            inviteGroup.style.display = '';
        } else {
            loginBtn.textContent = '登录';
            pwdGroup.style.display = '';
            newPwdGroup.style.display = 'none';
            inviteGroup.style.display = 'none';
        }
    }));

    loginBtn.addEventListener('click', () => {
        const nick = loginNick.value.trim();
        if (!nick) { loginError.textContent = '请输入昵称'; return; }

        const pwd = loginPwd.value;
        if (!pwd) { loginError.textContent = '请输入密码'; return; }
        if (!isPwdAcceptable(pwd)) { loginError.textContent = pwdRuleMessage(); return; }

        if (mode === 'changepwd') {
            const newPwd = loginNewPwd.value;
            if (!newPwd) { loginError.textContent = '请输入新密码'; return; }
            if (!isPwdAcceptable(newPwd)) { loginError.textContent = pwdRuleMessage(); return; }
                        changePasswordFromLogin(nick, pwd, newPwd, loginError);
            return;
        }

        if (window.IS_CLIENT_MODE && loginServer.value) {
            const parts = loginServer.value.split(':');
            window.CHAT_SERVER_HOST = parts[0].trim();
            window.CHAT_SERVER_PORT = parseInt(parts[1]) || 8888;
        }

        loginError.textContent = '连接中...';
        nickname = nick;
        var invite = document.getElementById('login-invite').value.trim();
        connectWebSocket(mode, nick, pwd, loginError, invite);
    });

    loginPwd.addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });
    loginNewPwd.addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });
}

// Change password from login screen (temporary WebSocket)
function changePasswordFromLogin(nick, oldPwd, newPwd, errorEl) {
    errorEl.textContent = '连接中...';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsHost;
    if (window.CHAT_SERVER_HOST && window.CHAT_SERVER_PORT) {
        wsHost = window.CHAT_SERVER_HOST + ':' + window.CHAT_SERVER_PORT;
    } else if (window.CHAT_SERVER_HOST) {
        wsHost = window.CHAT_SERVER_HOST;
    } else {
        wsHost = location.host;
    }
    const tmpWs = new WebSocket(proto + '//' + wsHost + '/ws/chat');
    tmpWs.onopen = () => {
        tmpWs.send(JSON.stringify({ type: 'auth_change_pwd', nickname: nick, content: oldPwd, subtype: newPwd }));
    };
    tmpWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'auth_change_pwd_ok') {
            errorEl.textContent = '';
            showToast('密码修改成功', 'success');
            tmpWs.close();
            // Reset to login mode
            document.querySelector('.tab[data-tab="login"]').click();
        } else if (msg.type === 'auth_change_pwd_fail') {
            errorEl.textContent = '密码修改失败，请检查旧密码是否正确';
            tmpWs.close();
        }
    };
    tmpWs.onerror = () => { errorEl.textContent = '连接失败'; };
}

function onLoginSuccess() {
    // 根据选框保存凭据到 localStorage（持久化）和 sessionStorage（标签页级别）
    var rememberNick = $('login-remember-nick').checked;
    var rememberPwd  = $('login-remember-pwd').checked;
    var autoLogin    = $('login-auto-login').checked;
    localStorage.setItem('uchat-remember-nick', rememberNick ? '1' : '0');
    localStorage.setItem('uchat-remember-pwd', rememberPwd ? '1' : '0');
    localStorage.setItem('uchat-auto-login', autoLogin ? '1' : '0');
    if (rememberNick) localStorage.setItem('uchat-account', nickname);
    else localStorage.removeItem('uchat-account');
    if (rememberPwd) localStorage.setItem('uchat-password', $('login-pwd').value);
    else localStorage.removeItem('uchat-password');
    // sessionStorage 用于当前标签页快速重连
    sessionStorage.setItem('uchat-nick', nickname);
    sessionStorage.setItem('uchat-pwd', $('login-pwd').value);
    loginOverlay.classList.add('hidden');
    mainApp.classList.remove('hidden');
    pageTitle = nickname + ' - Uchat';
    document.title = pageTitle;
    loadUserPrefs();
    _tmServerSynced = false;
    _tmLoadFromServer();
    setTimeout(function() { if (typeof reapplyChatBg === 'function') reapplyChatBg(); }, 500);
    showWelcomeGuide();
    // 重新应用当前用户的工具栏显隐。
    // ⚠️ 这里按几个时间点重复应用（幂等）：登录有登录页/注册失败转登录/自动登录等多条路径，
    //    只挂在其中一条上会出现"隐藏的按钮又冒出来"（用户 2026-09-25 反馈）。
    applyToolbarVisibility();
    [200, 800, 2000, 4000].forEach(function (ms) {
        setTimeout(function () { try { applyToolbarVisibility(); } catch (e) { } }, ms);
    });
    // 预先请求摄像头和麦克风权限（静默，不存储流）
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(function(s) {
            s.getTracks().forEach(function(t) { t.stop(); });
        }).catch(function() {});
    }
    window.addEventListener('focus', () => { unreadCount = 0; document.title = pageTitle; });
    window.addEventListener('blur', () => {});
}

// 切换账号：清除凭据，返回登录界面
function switchAccount() {
    if (confirm('确定要退出当前账号吗？未保存的设置将丢失。')) {
        // 关闭所有弹窗和面板
        $('settings-modal').classList.remove('visible');
        $('pwd-modal').style.display = 'none';
        $('search-modal').style.display = 'none';
        $('files-modal').style.display = 'none';
        $('music-room').style.display = 'none';
        $('ambient-panel').style.display = 'none';
        $('timer-modal').style.display = 'none';
        $('random-modal').style.display = 'none';
        $('private-modal').classList.remove('visible');
        $('video-overlay').classList.remove('visible');
        $('screen-viewer').classList.remove('visible');
        localStorage.removeItem('uchat-auto-login');
        sessionStorage.removeItem('uchat-nick');
        sessionStorage.removeItem('uchat-pwd');
        sessionStorage.removeItem('uchat-file-token');
        if (ws) { try { ws.close(); } catch(e) {} }
        $('main-app').classList.add('hidden');
        $('login-overlay').classList.remove('hidden');
        $('login-error').textContent = '';
        $('login-pwd').value = '';
        $('login-pwd').focus();
    }
}

function showWelcomeGuide(force) {
    var GUIDE_VERSION = '4';   // 内容有更新就 +1 ⇒ 老用户也会重新看到一次
    if (force) { localStorage.removeItem('uchat-guide-version'); }
    var seenVersion = localStorage.getItem('uchat-guide-version');
    if (seenVersion === GUIDE_VERSION) return;
    localStorage.setItem('uchat-guide-version', GUIDE_VERSION);
    try {
        var existing = document.getElementById('welcome-guide');
        if (existing) existing.remove();
        if (!messageArea) return;
        var guide = document.createElement('div');
        guide.id = 'welcome-guide';
        guide.style.cssText = 'margin:0 16px 12px;padding:14px 16px;background:var(--accent-light);border-radius:8px;font-size:13px;line-height:1.8;color:var(--text-primary);position:relative';
        var _sub = 'font-size:11px;color:var(--text-muted)';
        var _h = 'margin-top:8px;font-weight:600';
        guide.innerHTML = [
            '<b>欢迎使用 Uchat</b>  <span style="' + _sub + '">v' + APP_VERSION + '</span>',
            '<div style="' + _h + '">🆕 本版亮点</div>',
            '· 🤖 群里有两个 AI：<b>@大肥鱼</b>（简短、偶尔随机插话）、<b>@资料鱼</b>（详细作答并给参考资料）—— <b>都要 @ 才会应答</b>',
            '· 👑 用户列表按角色显示：👑 管理员 / 🤖 机器人 / 普通用户；排序为 管理员 → 机器人 → 普通用户，组内按拼音首字母',
            '· 👆 <b>单击</b>用户列表里的名字 = 弹出菜单（私聊 / 静音 / @提及）；<b>双击</b> = 直接 @ 他',
            '· 🔒 <b>私聊支持离线</b>：对方不在线也能发，消息存在服务器上，他一上线就会收到；未读条数显示在用户列表的名字后面，打开窗口即清零',
            '<div style="' + _h + '">💬 聊天</div>',
            '· 支持 Markdown（粗体/列表/表格/链接）、代码块自动语法高亮、$…$ 与 $$…$$ 数学公式',
            '· @某人 提及；右键消息 = 引用 / 复制 / 撤回（撤回仅自己的消息）',
            '· 文件与图片：点按钮选，或直接拖拽到窗口',
            '<div style="' + _h + '">📞 通话与共享</div>',
            '· 语音通话：房间1 最多 12 人、房间2 最多 6 人；视频通话：房间1 最多 8 人、房间2 最多 6 人（通话中可随时换房间）；掉线有 45 秒宽限期',
            '· 屏幕共享可带电脑声音：共享者可控制是否发送，观看者可单独静音共享声音（通话语音不受影响）',
            '· 跨网络也能通：同 WiFi 优先局域网直连，跨网络自动走中继',
            '<div style="' + _h + '">🎵 其他</div>',
            '· 听歌房（支持网易云链接与本地音频，房间内真同步）、骰子、番茄钟、白噪音；主题 / 字体 / 设备 / 通知音都在设置里',
            '<div style="' + _h + '">⚠️ 小贴士</div>',
            '· 说话对方听不到：先确认系统音频设备与浏览器麦克风权限；共享没声音：看共享面板右上角的 🔊 开关',
            '· 手机端：面板可拖动、自动贴边；点一次名字就能 @ 或私聊',
            '<br><button style="margin-top:8px;padding:4px 14px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px">知道了</button>'
        ].join('<br>');
        guide.querySelector('button').addEventListener('click', function() { guide.remove(); });
        messageArea.insertBefore(guide, messageArea.firstChild);
        guide.scrollIntoView({ behavior: 'smooth' });
    } catch(e) { console.error('showWelcomeGuide:', e); }
}

function initGuideReplay() {
    var btn = $('btn-show-guide');
    if (!btn) return;
    btn.addEventListener('click', function() {
        showWelcomeGuide(true);
        $('settings-modal').classList.remove('visible');
    });
}

function incrementUnread() {
    if (document.hasFocus()) return;
    unreadCount++;
    document.title = '(' + unreadCount + ') ' + pageTitle;
}

// ==================== User Preferences ====================
function _prefKey() { return 'uchat-prefs-' + nickname; }

function loadAllPrefs() {
    var raw = localStorage.getItem(_prefKey());
    if (!raw) {
        // 迁移旧格式 → 新格式（仅当至少有一个旧 key 存在时才迁移，避免写入空对象）
        var old = {};
        if (localStorage.getItem('chatroom-theme')) old.theme = localStorage.getItem('chatroom-theme');
        if (localStorage.getItem('chatroom-font')) old.font = localStorage.getItem('chatroom-font');
        if (localStorage.getItem('chatroom-fontsize')) old.fontsize = localStorage.getItem('chatroom-fontsize');
        if (localStorage.getItem('chatroom-send-mode')) old.sendMode = localStorage.getItem('chatroom-send-mode');
        if (localStorage.getItem('screen-quality')) old.screenQuality = localStorage.getItem('screen-quality');
        if (localStorage.getItem('screen-fps')) old.screenFps = localStorage.getItem('screen-fps');
        if (localStorage.getItem('notifyVolume')) old.notifyVolume = localStorage.getItem('notifyVolume');
        if (Object.keys(old).length > 0) {
            raw = JSON.stringify(old);
            localStorage.setItem(_prefKey(), raw);
        } else {
            return {}; // 没有任何已保存的设置，不写入空对象污染存储
        }
    }
    try {
        var p = JSON.parse(raw);
        // 恢复 theme（仅当有值时写回，避免用默认值覆盖）
        // 将当前用户的设置写入全局 key，覆盖上一用户的残留值
        if (p.theme) {
            if (p.theme !== theme) { theme = p.theme; applyTheme(); }
            localStorage.setItem('chatroom-theme', p.theme);
        }
        if (p.font) {
            localStorage.setItem('chatroom-font', p.font);
            document.querySelectorAll('.message').forEach(function(m){m.style.fontFamily=p.font;});
            updateSettingsUI('setting-font', p.font);
        }
        if (p.fontsize) {
            localStorage.setItem('chatroom-fontsize', p.fontsize);
            document.querySelectorAll('.message').forEach(function(m){m.style.fontSize=p.fontsize+'px';});
            applyFontSize(p.fontsize);
            updateSettingsUI('setting-fontsize', p.fontsize);
            updateSettingsUI('fontsize-label', p.fontsize + 'px');
        }
        if (p.sendMode) {
            localStorage.setItem('chatroom-send-mode', p.sendMode);
            updateSettingsUI('setting-send-mode', p.sendMode);
            updateSendPlaceholder();
        }
        if (p.screenQuality) {
            localStorage.setItem('screen-quality', p.screenQuality);
            updateSettingsUI('setting-screen-quality', p.screenQuality);
        }
        if (p.screenFps) {
            localStorage.setItem('screen-fps', p.screenFps);
            updateSettingsUI('setting-screen-fps', p.screenFps);
        }
        if (p.notifyVolume !== undefined) {
            notifyVolume = parseFloat(p.notifyVolume);
            localStorage.setItem('notifyVolume', p.notifyVolume);
            var nv = document.getElementById('setting-notify-vol');
            if (nv) nv.value = Math.round(notifyVolume * 100);
        }
        return p;
    } catch(e) { console.error('[prefs] loadAllPrefs parse error:', e); return {}; }
}

function updateSettingsUI(id, value) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === 'INPUT' && el.type === 'range') {
        el.value = value;
    } else if (el.tagName === 'SELECT') {
        el.value = value;
    } else {
        el.textContent = value;
    }
}

function saveAllPrefs() {
    // 仅写入昵称相关 key，不再写全局 key，避免同设备用户共享设置
    var p = {
        theme: theme,
        font: localStorage.getItem('chatroom-font') || '',
        fontsize: localStorage.getItem('chatroom-fontsize') || '',
        sendMode: localStorage.getItem('chatroom-send-mode') || 'enter',
        screenQuality: localStorage.getItem('screen-quality') || '720p',
        screenFps: localStorage.getItem('screen-fps') || '15',
        notifyVolume: localStorage.getItem('notifyVolume') || '0.4'
    };
    localStorage.setItem(_prefKey(), JSON.stringify(p));
}

async function loadUserPrefs() {
    var localData = loadAllPrefs();
    var hasLocalData = localData && Object.keys(localData).length > 0;
    // 服务器补全：本地缺失或完全为空时从服务器恢复
    try {
        // 2026-09-25：prefs 接口加了鉴权（防他人按昵称读写），带上 nickname+token
        var resp = await fetch(getApiBaseUrl() + '/api/prefs/' + encodeURIComponent(nickname) +
            '?' + (typeof getFileAuthParams === 'function' ? getFileAuthParams() : ''));
        if (resp.ok) {
            var prefs = await resp.json();
            if (prefs && Object.keys(prefs).length > 0) {
                var local = JSON.parse(localStorage.getItem(_prefKey()) || '{}');
                // 本地无数据时以服务器为准；有数据时只补全缺失项
                var keys = ['theme','font','fontsize','sendMode','screenQuality','screenFps','notifyVolume'];
                for (var i = 0; i < keys.length; i++) {
                    var k = keys[i];
                    if (prefs[k] !== undefined && (!hasLocalData || !local[k])) local[k] = prefs[k];
                }
                if (!hasLocalData || !localStorage.getItem('chatroom-mic-device-' + nickname))
                    if (prefs.micDevice) localStorage.setItem('chatroom-mic-device-' + nickname, prefs.micDevice);
                if (!hasLocalData || !localStorage.getItem('chatroom-cam-device-' + nickname))
                    if (prefs.camDevice) localStorage.setItem('chatroom-cam-device-' + nickname, prefs.camDevice);
                if (!hasLocalData || !localStorage.getItem('chatroom-mic-vol-' + nickname))
                    if (prefs.micVol) localStorage.setItem('chatroom-mic-vol-' + nickname, prefs.micVol);
                if (!hasLocalData || !localStorage.getItem('chatroom-spk-vol-' + nickname))
                    if (prefs.spkVol) localStorage.setItem('chatroom-spk-vol-' + nickname, prefs.spkVol);
                if (!hasLocalData || !localStorage.getItem('chatroom-nr-model-' + nickname))
                    if (prefs.nrModel !== undefined) localStorage.setItem('chatroom-nr-model-' + nickname, prefs.nrModel);
                if (!hasLocalData || !localStorage.getItem('screen-quality'))
                    if (prefs.screenQuality) localStorage.setItem('screen-quality', prefs.screenQuality);
                if (!hasLocalData || !localStorage.getItem('screen-fps'))
                    if (prefs.screenFps) localStorage.setItem('screen-fps', prefs.screenFps);
                if (!hasLocalData || !localStorage.getItem('notifyVolume'))
                    if (prefs.notifyVolume !== undefined) localStorage.setItem('notifyVolume', prefs.notifyVolume);
                if (prefs.bgUrl && !prefs.bgUrl.startsWith('data:')) {
                    _bgSave(prefs.bgUrl);
                }
                localStorage.setItem(_prefKey(), JSON.stringify(local));
                loadAllPrefs();
            }
        } else {
            console.warn('[prefs] Server prefs load failed, status:', resp.status);
        }
    } catch(e) { console.warn('[prefs] Server prefs fetch error:', e.message || e); }
}

function saveUserPrefs(cb) {
    saveAllPrefs();
    _getBgUrl(function(bgUrl) {
        var p = {
            theme: theme,
            font: localStorage.getItem('chatroom-font') || 'sans-serif',
            fontsize: localStorage.getItem('chatroom-fontsize') || '14',
            sendMode: localStorage.getItem('chatroom-send-mode') || 'enter',
            micDevice: localStorage.getItem('chatroom-mic-device-' + nickname) || '',
            camDevice: localStorage.getItem('chatroom-cam-device-' + nickname) || '',
            screenQuality: localStorage.getItem('screen-quality') || '720p',
            screenFps: localStorage.getItem('screen-fps') || '15',
            notifyVolume: localStorage.getItem('notifyVolume') || '0.4',
            micVol: localStorage.getItem('chatroom-mic-vol-' + nickname) || '100',
            spkVol: localStorage.getItem('chatroom-spk-vol-' + nickname) || '100',
            nrModel: localStorage.getItem('chatroom-nr-model-' + nickname) || '0',
            // data URL 过大（>50KB）跳过，避免超过 prefs 64KB 上限
            bgUrl: (bgUrl && bgUrl.startsWith('data:') && bgUrl.length > 50000) ? '' : (bgUrl || '')
        };
        fetch(getApiBaseUrl() + '/api/prefs/' + encodeURIComponent(nickname) +
            '?' + (typeof getFileAuthParams === 'function' ? getFileAuthParams() : ''), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p), keepalive: true
        }).catch(function(e){ console.warn('[prefs] Server prefs save failed:', e.message || e); });
        if (cb) cb();
    });
}

function _getBgUrl(cb) {
    _bgLoad(function(url) { cb(url || ''); });
}

function onLoginFailed(msg) {
    $('login-error').textContent = msg;
}

// ==================== Emoji Picker ====================
function initEmojiPicker() {
    const emojis = ['😀','😂','🤣','😍','🥰','😎','🤩','😇','🤔','😏',
                    '👍','👎','👏','🙌','💪','🤝','👋','🎉','🔥','⭐',
                    '❤️','💔','🎵','📷','💻','📱','☕','🍕','🐱','🐶',
                    '🌞','🌈','❄️','⚡','💧','🎈','🔔','💡','🔑','🏠'];
    const grid = $('emoji-grid');
    emojis.forEach(e => {
        const btn = document.createElement('button');
        btn.className = 'emoji-btn';
        btn.textContent = e;
        btn.addEventListener('click', () => {
            msgInput.value += e;
            msgInput.focus();
            emojiPicker.classList.remove('visible');
        });
        grid.appendChild(btn);
    });

    $('btn-emoji').addEventListener('click', (e) => {
        if (emojiPicker.classList.contains('visible')) {
            emojiPicker.classList.remove('visible');
            return;
        }
        // Position above the emoji button
        const btnRect = $('btn-emoji').getBoundingClientRect();
        emojiPicker.style.left = Math.min(btnRect.left, window.innerWidth - 270) + 'px';
        emojiPicker.style.bottom = (window.innerHeight - btnRect.top + 8) + 'px';
        emojiPicker.classList.add('visible');
        e.stopPropagation();
    });
    document.addEventListener('click', e => {
        if (!emojiPicker.contains(e.target) && e.target !== $('btn-emoji')) {
            emojiPicker.classList.remove('visible');
        }
    });
}

// ==================== Context Menu ====================
function initContextMenu() {
    document.addEventListener('contextmenu', e => {
        const msgEl = e.target.closest('.message');
        if (!msgEl || msgEl.classList.contains('system')) {
            contextMenu.classList.remove('visible');
            return;
        }
        e.preventDefault();
        contextTarget = msgEl;
        selectedMsg = {
            msgId: msgEl.dataset.msgId,
            nickname: msgEl.dataset.nickname,
            content: msgEl.dataset.content,
            type: msgEl.dataset.type
        };

        const rect = msgEl.getBoundingClientRect();
        contextMenu.style.top = Math.min(e.clientY, window.innerHeight - 200) + 'px';
        contextMenu.style.left = Math.min(e.clientX, window.innerWidth - 150) + 'px';
        contextMenu.classList.add('visible');

        // Show/hide recall (only own messages, non-system)
        const recallItem = contextMenu.querySelector('[data-action="recall"]');
        const privateItem = contextMenu.querySelector('[data-action="private-chat"]');
        const muteItem = contextMenu.querySelector('[data-action="mute"]');
        if (selectedMsg.nickname === nickname && selectedMsg.type === 'chat') {
            recallItem.style.display = '';
        } else {
            recallItem.style.display = 'none';
        }
        if (selectedMsg.nickname !== nickname) {
            privateItem.style.display = '';
            var isOnline = typeof onlineUsers !== 'undefined' && onlineUsers.indexOf(selectedMsg.nickname) !== -1;
            // P0-④：对方离线也能发（消息由服务端落盘、对方上线后补投），所以不再置灰
            privateItem.style.opacity = '1';
            privateItem.textContent = isOnline ? '🔒 私聊' : '🔒 私聊（离线，上线后送达）';
            muteItem.style.display = '';
            muteItem.textContent = mutedUsers.has(selectedMsg.nickname) ? '🔊 取消静音' : '🔇 静音';
        } else {
            privateItem.style.display = 'none';
            muteItem.style.display = 'none';
        }
    });

    document.addEventListener('click', () => contextMenu.classList.remove('visible'));

    contextMenu.querySelectorAll('.context-item').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.action;
            const data = selectedMsg;
            contextMenu.classList.remove('visible');

            switch (action) {
                case 'reply':
                    if (data) {
                        replyTo = { msgId: data.msgId, nickname: data.nickname, content: data.content };
                        msgInput.placeholder = '回复 ' + data.nickname + ': ' + (data.content || '').substring(0, 30);
                        msgInput.focus();
                    }
                    break;
                case 'copy':
                    if (data && data.content) {
                        navigator.clipboard.writeText(data.content).then(() => showToast('已复制', 'success'));
                    }
                    break;
                case 'recall':
                    if (data && data.msgId) {
                        ws.send(JSON.stringify({ type: 'recall', msgId: data.msgId, nickname: nickname }));
                    }
                    break;
                case 'private-chat':
                    if (data && data.nickname && data.nickname !== nickname) {
                        openPrivateChat(data.nickname);
                    }
                    break;
                case 'at-mention':
                    if (data && data.nickname) {
                        mentionUser(data.nickname);      // 手机上还要顺手关掉抽屉 / 把光标移到末尾
                    }
                    break;
                case 'mute':
                    if (data && data.nickname) {
                        toggleMute(data.nickname);
                    }
                    break;
            }
        });
    });
}

// ==================== Private Chat（P0-④ 离线私聊） ====================
// 历史：partner -> [{ msgId, from, content, time, offline }]
// 相对旧实现的关键变化：
//   ① **对方离线也能进窗口 / 也能发**（消息由服务端落盘，对方上线后补投）——旧版直接弹「当前离线，无法私聊」；
//   ② 每条都带 msgId，并按 msgId 去重 —— 同一条可能被「在线直发 / 登录补投 / sync_since 补齐 / 自己的回显」
//      多次送达，没有去重就会出现重复气泡；
//   ③ 未读角标画在用户列表的联系人行上，打开窗口即清零；
//   ④ 服务端补投的离线消息打 [离线] 标记且**不自动弹窗**（否则一登录会被一串弹窗刷屏）。

/** 取 Outbox（chat.js 里定义；可能还没加载完） */
function pmOutbox() {
    if (typeof outboxApi === 'function') return outboxApi();
    return (typeof window !== 'undefined' && window.Outbox) ? window.Outbox : null;
}

function savePmHistory() {
    try { localStorage.setItem('pmHistory', JSON.stringify(privateHistory)); } catch(e) {}
}

function savePmUnread() {
    try {
        localStorage.setItem('pmUnread', JSON.stringify(pmUnread));
        localStorage.setItem('pmUnreadFloor', JSON.stringify(pmUnreadFloor));
    } catch(e) {}
}

/** 某个联系人的未读数 = max(本机累加, 服务端下限) */
function pmUnreadOf(partner) {
    return Math.max(pmUnread[partner] || 0, pmUnreadFloor[partner] || 0);
}

function getPmPartner(from, receiver) {
    // Normalize: the partner is the other person
    return from === nickname ? receiver : from;
}

/** 该联系人历史里是否已有这个 msgId（私聊去重的唯一判据） */
function pmHasMsg(partner, msgId) {
    if (!msgId) return false;
    var h = privateHistory[partner] || [];
    for (var i = 0; i < h.length; i++) { if (h[i].msgId === msgId) return true; }
    return false;
}

function pmIsOnline(target) {
    return typeof onlineUsers !== 'undefined' && onlineUsers.indexOf(target) !== -1;
}

/** 未读角标变了 → 重绘用户列表（角标就画在联系人那一行上） */
function renderPmBadges() {
    try {
        if (typeof updateUserList === 'function' && typeof onlineUsers !== 'undefined') {
            updateUserList(onlineUsers, null, userStatuses);
        }
    } catch (e) {}
}

/** 用户列表/菜单里的未读角标 HTML */
function pmBadgeHtml(u) {
    var n = pmUnreadOf(u);
    if (n <= 0) return '';
    return ' <span class="pm-unread-badge" title="' + n + ' 条未读私聊">' + (n > 99 ? '99+' : n) + '</span>';
}

function initPrivateChatUI() {
    const modal = $('private-modal');
    const closeBtn = modal.querySelector('.pm-close');
    const sendBtn2 = $('pm-send');
    const input = $('pm-input');

    closeBtn.addEventListener('click', () => modal.classList.remove('visible'));
    sendBtn2.addEventListener('click', () => sendPrivateMessage());
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); sendPrivateMessage(); }
    });
}

/**
 * 发送私聊。走向 Outbox（localStorage 持久化队列 + 断线重发 + 回执出队）：
 * 断网 / 服务重启期间发出的私聊不会丢，重连后按**同一个 msgId** 重发（服务端幂等去重）。
 * Outbox 不可用时退回旧的直发行为。
 */
function sendPrivateMessage() {
    var input = $('pm-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text || !privateChatTarget) return;
    var target = privateChatTarget;
    var msgId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    var msg = { type: 'private', nickname: nickname, receiver: target, content: text, msgId: msgId };

    // 乐观渲染：本地先看到（服务端回显时按 msgId 去重，不会变成两条）
    addPmMessage(target, nickname, text, Date.now(), msgId, false);

    var ob = pmOutbox();
    if (ob && typeof ob.enqueue === 'function') {
        ob.enqueue(msg);                      // 持久化队列：断线/离线也发得出去
    } else if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(msg)); } catch (e) {
            pmRemoveMessage(target, msgId);   // 发不出去就别留在界面上
            showToast('私聊发送失败，请重试', 'error');
            return;
        }
    } else {
        pmRemoveMessage(target, msgId);       // 既无队列也无连接：撤回乐观条目，别让用户误以为发出去了
        showToast('连接已断开，请稍后重试', 'error');
        return;
    }
    input.value = '';
    input.focus();
}

/**
 * 记一条私聊到本地历史。
 * @returns 新写入的条目；重复 msgId（已存在）时返回 null
 */
function addPmMessage(partner, from, content, time, msgId, offline) {
    if (!partner) return null;
    if (pmHasMsg(partner, msgId)) return null;                       // 去重（同一条可能被多次送达）
    if (!privateHistory[partner]) privateHistory[partner] = [];
    var entry = { msgId: msgId || null, from: from, content: content,
                  time: time || Date.now(), offline: !!offline };
    privateHistory[partner].push(entry);
    if (privateHistory[partner].length > 200) privateHistory[partner].shift();
    // 限制私聊对象总数，防止内存无限增长
    var partners = Object.keys(privateHistory);
    if (partners.length > 50) delete privateHistory[partners[0]]; // 删最久未用的
    savePmHistory();

    // 未读：不是自己发的，且当前**没有真正打开**这个人的窗口（窗口关了就视为未读）
    // ⚠️ 必须一并判断窗口可见性：只看 privateChatTarget 不够 —— 关掉窗口后它仍保留上一次的目标，
    //    结果「刚聊过的人再发消息不显示未读角标」（2026-09-24 手机版体检实测抓到）。
    var pmEl = document.getElementById('private-modal');
    var viewing = (privateChatTarget === partner) && pmEl && pmEl.classList.contains('visible') && !document.hidden;
    if (from !== nickname && !viewing) {
        pmUnread[partner] = (pmUnread[partner] || 0) + 1;
        savePmUnread();
        renderPmBadges();
    }
    // Update UI if this partner is currently open
    if (privateChatTarget === partner) {
        renderPmMessage(from, content, entry.offline, msgId);
    }
    return entry;
}

function renderPmMessage(from, content, offline, msgId) {
    var div = document.createElement('div');
    div.className = 'message private' + (from === nickname ? ' self' : '');
    if (msgId) div.dataset.msgId = msgId;
    var offTag = offline
        ? '<span class="msg-offline-tag" title="对方当时不在线，这是服务端补投的离线消息">[离线]</span> '
        : '';
    div.innerHTML = '<span class="msg-private-tag">[私聊]</span> ' + offTag +
        '<span class="msg-nick ' + (from === nickname ? 'self' : 'other') + '">' + esc(from) + ':</span> ' + esc(content);
    var msgs = $('pm-messages');
    if (!msgs) return null;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    // 让私聊气泡也进 msgId 索引 ⇒ Outbox 能把「待发送/失败」角标挂上来，服务端回显也会被去重
    if (msgId && typeof addMsgId === 'function') addMsgId(msgId, div);
    return div;
}

/** 离线提示（画在消息区顶部） */
function pmHint(target) {
    var msgs = $('pm-messages');
    if (!msgs) return;
    var d = document.createElement('div');
    d.className = 'pm-hint';
    d.textContent = target + ' 当前离线：消息会先存在服务器上，等对方上线后自动送达。';
    msgs.appendChild(d);
}

/** 重绘当前私聊窗口（删除失败消息 / 标记已读后用） */
function rerenderPmMessages() {
    var msgs = $('pm-messages');
    if (!msgs || !privateChatTarget) return;
    msgs.innerHTML = '';
    (privateHistory[privateChatTarget] || []).forEach(function(m) {
        renderPmMessage(m.from, m.content, m.offline, m.msgId);
    });
    if (!pmIsOnline(privateChatTarget)) pmHint(privateChatTarget);
    var ob = pmOutbox();
    if (ob && typeof ob.syncBadges === 'function') ob.syncBadges();   // 刷新后队列里还有的私聊把角标补上
}

function openPrivateChat(target) {
    if (!target) return;
    privateChatTarget = target;
    var online = pmIsOnline(target);
    // P0-④：对方离线**也允许**打开（消息会入库、对方上线后补投），只在标题与消息区提示
    $('pm-title').textContent = '私聊 ' + target + (online ? '' : '（离线）');
    $('pm-messages').innerHTML = '';
    var hist = privateHistory[target] || [];
    hist.forEach(function(m) { renderPmMessage(m.from, m.content, m.offline, m.msgId); });
    if (!online) pmHint(target);
    var ob = pmOutbox();
    if (ob && typeof ob.syncBadges === 'function') ob.syncBadges();
    $('private-modal').classList.add('visible');
    // 打开窗口 = 已读（本地计数与服务端下限一并清掉）
    if (pmUnread[target] || pmUnreadFloor[target]) {
        pmUnread[target] = 0;
        delete pmUnreadFloor[target];
        savePmUnread();
        renderPmBadges();
    }
    $('pm-input').focus();
}

/** 从本地历史里删掉一条（服务端明确回执"发不出去"时） */
function pmRemoveMessage(partner, msgId) {
    var h = privateHistory[partner];
    if (!h) return false;
    var idx = -1;
    for (var i = h.length - 1; i >= 0; i--) {
        if (msgId ? h[i].msgId === msgId : h[i].from === nickname) { idx = i; break; }
    }
    if (idx < 0) return false;
    h.splice(idx, 1);
    savePmHistory();
    if (privateChatTarget === partner) rerenderPmMessages();
    return true;
}

function onPrivateMessage(msg) {
    var partner = getPmPartner(msg.nickname, msg.receiver);
    if (!partner) return;
    var fromSelf = (msg.nickname === nickname);
    var offline = msg.offlineMsg === true;                 // 服务端补投的离线私聊
    var entry = addPmMessage(partner, msg.nickname, msg.content,
                             msg.serverTime || msg.time || Date.now(), msg.msgId, offline);
    if (fromSelf) return;                                  // 自己的消息：入库/渲染即可，不提示不计数
    // 重复投递（sync + 补投 + 回显）→ 什么都不做
    if (!entry) return;
    showToast(msg.nickname + ' 发来私聊消息', 'info');
    // 补投的离线消息 / 历史回放：不自动弹窗（一次登录可能来一串，弹窗会刷屏）
    // 手机端也不自动弹：私聊窗口在手机上是**整屏**的，自动弹出会把正在看的聊天顶掉；
    // 靠"未读角标 + 提示"就够，点用户行里的 🔒（或菜单里的私聊）即可进。
    var quiet = offline || window._loadingHistory;
    if (!quiet && !isMobileLayout() && privateChatTarget !== partner && !document.hidden) {
        openPrivateChat(partner);
    }
}

/** 服务端下发的未读汇总（登录时先于补投到达） */
function onPrivatePending(msg) {
    var un = (msg && msg.unread) || {};
    Object.keys(un).forEach(function(k) {
        // 只更新"下限"：随后到达的补投消息会在 pmUnread 里各 +1，读取时取 max ⇒ 不会重复计数
        pmUnreadFloor[k] = Math.max(pmUnreadFloor[k] || 0, un[k] || 0);
    });
    savePmUnread();
    renderPmBadges();
    if (msg && msg.dropped > 0) {
        showToast('有 ' + msg.dropped + ' 条离线私聊超出容量上限，无法补齐', 'error');
    }
}

// ==================== Settings ====================
function initSettingsUI() {
    $('btn-settings').addEventListener('click', () => {
        $('settings-modal').classList.add('visible');
    });
    $('btn-settings-close').addEventListener('click', () => {
        $('settings-modal').classList.remove('visible');
    });
    $('settings-modal').addEventListener('click', e => {
        if (e.target === $('settings-modal')) $('settings-modal').classList.remove('visible');
    });

    $('setting-font').addEventListener('change', () => {
        const font = $('setting-font').value;
        document.querySelectorAll('.message').forEach(m => m.style.fontFamily = font);
        localStorage.setItem('chatroom-font', font);
        saveUserPrefs();
    });

    const savedFont = localStorage.getItem('chatroom-font');
    if (savedFont) $('setting-font').value = savedFont;

    // Font size
    const savedFontSize = localStorage.getItem('chatroom-fontsize') || '14';
    $('setting-fontsize').value = savedFontSize;
    $('fontsize-label').textContent = savedFontSize + 'px';
    applyFontSize(savedFontSize);
    $('setting-fontsize').addEventListener('input', () => {
        const sz = $('setting-fontsize').value;
        $('fontsize-label').textContent = sz + 'px';
        localStorage.setItem('chatroom-fontsize', sz);
        applyFontSize(sz);
        saveUserPrefs();
    });

    // Screen quality preset
    const savedScreenQ = localStorage.getItem('screen-quality') || '720p';
    $('setting-screen-quality').value = savedScreenQ;
    $('setting-screen-quality').addEventListener('change', () => {
        localStorage.setItem('screen-quality', $('setting-screen-quality').value);
        saveUserPrefs();
    });
    // Screen FPS preset
    const savedFps = localStorage.getItem('screen-fps') || '15';
    $('setting-screen-fps').value = savedFps;
    $('setting-screen-fps').addEventListener('change', () => {
        localStorage.setItem('screen-fps', $('setting-screen-fps').value);
        saveUserPrefs();
    });

    // Notification volume slider
    const notifyVolEl = $('setting-notify-vol');
    if (notifyVolEl) {
        notifyVolEl.value = Math.round(notifyVolume * 100);
        notifyVolEl.addEventListener('input', () => {
            notifyVolume = parseInt(notifyVolEl.value) / 100;
            localStorage.setItem('notifyVolume', notifyVolume);
            saveUserPrefs();
        });
    }

    // 发送习惯设置
    var sendModeEl = $('setting-send-mode');
    if (sendModeEl) {
        var saved = localStorage.getItem('chatroom-send-mode') || 'enter';
        sendModeEl.value = saved;
        sendModeEl.addEventListener('change', function() {
            localStorage.setItem('chatroom-send-mode', this.value);
            updateSendPlaceholder();
            saveUserPrefs();
            showToast('发送习惯已更新', 'info');
        });
        updateSendPlaceholder();
    }
}

// 工具栏按钮表（工具栏显隐与设置里的勾选都以它为准）
var _TB_BTNS = [
    {id:'btn-emoji', name:'表情', keyName:'emoji', mobile:true},
    {id:'btn-dice', name:'骰子', keyName:'dice', mobile:true},
    {id:'btn-file', name:'文件', keyName:'file'},
    {id:'btn-ambient', name:'环境音', keyName:'ambient'},
    {id:'btn-timer-popup', name:'番茄钟', keyName:'timer'},
    {id:'btn-random-popup', name:'随机决策', keyName:'random'}
];
/**
 * 工具栏按钮的存储键。
 * ⚠️ 必须带昵称：历史上设置里那组勾选框是**登录前**建的，键被算成 `uchat-tb--emoji`（昵称为空），
 *    而登录后按真实昵称读 `uchat-tb-<nick>-emoji` 读不到 ⇒ 隐藏的按钮又冒出来（用户 2026-09-25 反馈）。
 *    所以键一律在读写时算，绝不烘进 DOM。
 */
function _tbKey(name) { return 'uchat-tb-' + (nickname || 'anon') + '-' + name; }
/** 迁移历史脏键（空昵称）→ 正确键；只在正确键不存在时迁移 */
function _tbMigrateLegacy() {
    if (!nickname) return;
    _TB_BTNS.forEach(function(tb) {
        var legacy = 'uchat-tb--' + tb.keyName, right = _tbKey(tb.keyName);
        var lv = localStorage.getItem(legacy);
        if (lv !== null && localStorage.getItem(right) === null) localStorage.setItem(right, lv);
    });
}
/** 按当前昵称把「工具栏显隐」与「设置里的勾选状态」一次同步到位 */
function _tbApplyAll() {
    _TB_BTNS.forEach(function(tb) {
        var el = document.getElementById(tb.id);
        var hidden = localStorage.getItem(_tbKey(tb.keyName)) === 'hidden';
        if (el) {
            try { el.classList.toggle('tb-hidden', hidden); } catch (e) {}
            el.style.display = hidden ? 'none' : '';      // 兼容旧逻辑（类才是权威）
        }
        var cb = document.querySelector('input[data-tb="' + tb.id + '"]');
        if (cb) cb.checked = !hidden;
    });
}

/** 是否是手机/窄屏布局（与 index.html 里的 @media (max-width:768px) 同一断点） */
function isMobileLayout() {
    try { return !!(window.matchMedia && window.matchMedia('(max-width: 768px)').matches); }
    catch (e) { return false; }
}

/** 关掉用户列表抽屉（纯 CSS 由 #user-panel-toggle 控制，这里只需取消勾选） */
function closeUserDrawer() {
    var cb = document.getElementById('user-panel-toggle');
    if (cb && cb.checked) cb.checked = false;
}

/**
 * @提及：把昵称插到输入框**末尾**、光标移到末尾并聚焦。
 * 手机端还会关掉抽屉，否则抽屉盖着输入框，看不到自己插的内容（聚焦会拉起键盘）。
 */
function mentionUser(nick) {
    if (!nick || typeof msgInput === 'undefined' || !msgInput) return;
    msgInput.value = (msgInput.value || '') + '@' + nick + ' ';
    try { msgInput.setSelectionRange(msgInput.value.length, msgInput.value.length); } catch (e) {}
    msgInput.focus();
    closeUserDrawer();
}

function initToolbarToggleUI() {
    // ⚠️ 手机工具栏是「白名单」：只放 表情/骰子/语音/视频/设置/主题/清屏（见 index.html 的 @media 段）。
    //    所以「工具栏按钮」这一组勾选项在手机上只能列出**手机上真的存在**的那两个；
    //    否则用户会看到「文件/环境音/番茄钟/随机决策」四个勾选框 —— 勾了没有任何东西出现（2026-09-24 用户反馈"明显有不存在的选项"）。
    var mobile = isMobileLayout();
    var toolbarBtns = _TB_BTNS.filter(function(tb) { return !mobile || tb.mobile; });
    var settingsCard2 = document.querySelector('.settings-card');
    if (!settingsCard2) return;
    var sep = document.createElement('div'); sep.className = 'setting-row';
    sep.innerHTML = '<span style="font-weight:600">工具栏按钮</span><span></span>';
    var ref = document.getElementById('btn-change-pwd');
    settingsCard2.insertBefore(sep, ref ? ref.parentElement : settingsCard2.querySelector('.btn-row'));
    toolbarBtns.forEach(function(tb) {
        if (document.querySelector('input[data-tb="' + tb.id + '"]')) return;   // 已建过就不重复建
        var vis = localStorage.getItem(_tbKey(tb.keyName)) !== 'hidden';
        var r = document.createElement('div'); r.className = 'setting-row';
        r.innerHTML = '<span>' + tb.name + '</span><span><input type="checkbox" ' + (vis?'checked':'') +
            ' data-tb="' + tb.id + '" data-name="' + tb.keyName + '" style="cursor:pointer"></span>';
        settingsCard2.insertBefore(r, ref ? ref.parentElement : settingsCard2.querySelector('.btn-row'));
        var cb = r.querySelector('input');
        cb.addEventListener('change', function() {
            var on = this.checked;
            var el = document.getElementById(this.dataset.tb);
            if (el) {
                try { el.classList.toggle('tb-hidden', !on); } catch (e) {}
                el.style.display = on ? '' : 'none';
            }
            // ★ 关键：键在这里按**当前昵称**算（不再用构建时烘进 DOM 的旧键）
            localStorage.setItem(_tbKey(this.dataset.name), on ? 'visible' : 'hidden');
        });
    });
    _tbApplyAll();      // 建完立刻按当前昵称同步一次（登录后还会再同步）
}

// 登录后根据当前用户昵称重新应用工具栏显隐
function applyToolbarVisibility() {
    if (!nickname) return;
    _tbMigrateLegacy();     // 把历史脏键（空昵称）迁到当前昵称下
    _tbApplyAll();          // 工具栏显隐 + 设置里的勾选状态一起同步
}

function initChangePwdUI() {

    const modal = $('pwd-modal');
    $('btn-change-pwd').addEventListener('click', () => {
        modal.style.display = 'flex';
        $('pwd-old').value = '';
        $('pwd-new').value = '';
        $('pwd-error').textContent = '';
    });
    $('btn-pwd-cancel').addEventListener('click', () => modal.style.display = 'none');
    $('btn-pwd-confirm').addEventListener('click', () => {
        const oldPwd = $('pwd-old').value;
        const newPwd = $('pwd-new').value;
        if (!oldPwd || !newPwd) { $('pwd-error').textContent = '请填写密码'; return; }
        if (newPwd.length < 6 || newPwd.length > 18) { $('pwd-error').textContent = '新密码需6-18位'; return; }
        if (!/^[a-zA-Z0-9]+$/.test(newPwd)) { $('pwd-error').textContent = '密码需6-18位'; return; }
        ws.send(JSON.stringify({ type: 'auth_change_pwd', nickname: nickname, content: oldPwd, subtype: newPwd }));
        modal.style.display = 'none';
        // 结果由 chat.js 中 auth_change_pwd_ok / auth_change_pwd_fail 处理
    });
    modal.addEventListener('click', e => {
        if (e.target === modal) modal.style.display = 'none';
    });
}

// ==================== Device Enumeration ====================
async function loadDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const micSel = $('setting-mic');
        const camSel = $('setting-cam');
        micSel.innerHTML = '<option value="">默认麦克风</option>';
        camSel.innerHTML = '<option value="">默认摄像头</option>';
        const savedMic = localStorage.getItem('chatroom-mic-device-' + nickname) || '';
        const savedCam = localStorage.getItem('chatroom-cam-device-' + nickname) || '';

        devices.forEach(d => {
            if (d.kind === 'audioinput') {
                micSel.innerHTML += `<option value="${d.deviceId}" ${d.deviceId===savedMic?'selected':''}>${d.label||'麦克风 '+(micSel.options.length)}</option>`;
            } else if (d.kind === 'videoinput') {
                camSel.innerHTML += `<option value="${d.deviceId}" ${d.deviceId===savedCam?'selected':''}>${d.label||'摄像头 '+(camSel.options.length)}</option>`;
            }
        });
    } catch(e) {}
}

function initDeviceListeners() {
    var micSel = $('setting-mic');
    var camSel = $('setting-cam');
    if (micSel) micSel.addEventListener('change', function() { localStorage.setItem('chatroom-mic-device-' + nickname, this.value); saveUserPrefs(); });
    if (camSel) camSel.addEventListener('change', function() { localStorage.setItem('chatroom-cam-device-' + nickname, this.value); saveUserPrefs(); });
    // Trigger device load when settings opened
    $('btn-settings').addEventListener('click', loadDevices);
}

// ==================== Voice Test ====================
var voiceTestActive = false;
var voiceTestStream = null;
var voiceTestCtx = null;
var voiceTestAnalyser = null;
var voiceTestSrc = null;
var voiceTestDest = null;
var voiceTestSidetone = null;
var voiceTestNrNodes = null;
var voiceTestNrIdx = 2; // 默认强力
var voiceTestAnimId = null;

// NR 模型参数（与 webrtc.js 保持一致）
var VOICE_NR_MODELS = [
    { name:'off',    hpf:0,   compTh:0,    compRatio:1, compAttack:0.01, compRelease:0.15, expTh:0,     expRatio:1 },
    { name:'gentle', hpf:60,  compTh:-24,  compRatio:2, compAttack:0.01, compRelease:0.15, expTh:0.005, expRatio:2.5 },
    { name:'strong', hpf:120, compTh:-30,  compRatio:5, compAttack:0.003,compRelease:0.08,expTh:0.018, expRatio:8.0 }
];

function startVoiceTest() {
    if (voiceTestActive) return;
    navigator.mediaDevices.getUserMedia({ audio: { autoGainControl:false, echoCancellation:false, noiseSuppression:false } }).then(function(stream) {
        voiceTestStream = stream;
        voiceTestCtx = new (window.AudioContext || window.webkitAudioContext)();
        voiceTestSrc = voiceTestCtx.createMediaStreamSource(stream);

        // 分析器 — 驱动音量条
        voiceTestAnalyser = voiceTestCtx.createAnalyser();
        voiceTestAnalyser.fftSize = 256;
        voiceTestAnalyser.smoothingTimeConstant = 0.3;
        voiceTestSrc.connect(voiceTestAnalyser);

        // 侧音监听链：src → [NR] → sidetoneGain → dest
        voiceTestSidetone = voiceTestCtx.createGain();
        voiceTestSidetone.gain.value = parseInt($('voice-sidetone-vol').value) / 100;
        voiceTestSidetone.connect(voiceTestCtx.destination);

        // 初始无 NR：直连
        voiceTestSrc.connect(voiceTestSidetone);
        voiceTestNrIdx = 0;
        updateNrButtons();

        // 动画循环
        var data = new Uint8Array(voiceTestAnalyser.frequencyBinCount);
        function loop() {
            if (!voiceTestActive) return;
            voiceTestAnalyser.getByteTimeDomainData(data);
            var sum = 0;
            for (var i = 0; i < data.length; i++) { var v = (data[i]-128)/128; sum += v*v; }
            var rms = Math.sqrt(sum / data.length);
            var db = rms > 0.0001 ? Math.round(20 * Math.log10(rms)) : -60;
            var pct = Math.max(0, Math.min(100, (db + 60) * 100 / 54));
            $('voice-level-fill').style.width = pct + '%';
            $('voice-level-fill').style.background = pct > 85 ? '#f44336' : pct > 60 ? '#ff9800' : '#4caf50';
            $('voice-level-text').textContent = db > -59 ? db + 'dB' : '-∞';
            voiceTestAnimId = requestAnimationFrame(loop);
        }
        loop();

        voiceTestActive = true;
        $('btn-voice-test').textContent = '停止测试';
        $('btn-voice-test').style.background = '#f44336';
        $('voice-test-status').textContent = '测试中...';
    }).catch(function(e) {
        showToast('麦克风访问失败: ' + (e.message||e.name), 'error');
    });
}

function stopVoiceTest() {
    voiceTestActive = false;
    if (voiceTestAnimId) { cancelAnimationFrame(voiceTestAnimId); voiceTestAnimId = null; }
    if (voiceTestNrNodes) { disconnectNrChain(); voiceTestNrNodes = null; }
    if (voiceTestCtx) { voiceTestCtx.close().catch(function(){}); voiceTestCtx = null; }
    if (voiceTestStream) { voiceTestStream.getTracks().forEach(function(t){t.stop();}); voiceTestStream = null; }
    voiceTestAnalyser = null; voiceTestSrc = null; voiceTestDest = null; voiceTestSidetone = null;
    $('btn-voice-test').textContent = '开始测试';
    $('btn-voice-test').style.background = 'var(--accent)';
    $('voice-test-status').textContent = '点击测试麦克风';
    $('voice-level-fill').style.width = '0';
    $('voice-level-text').textContent = '-∞';
}

// NR 链：src → hpf → comp → expandGain → sidetone
var nrHpf=null, nrComp=null, nrExpandGain=null, nrExpandAnalyser=null;

function applyNrModel(idx) {
    if (!voiceTestActive || !voiceTestCtx || !voiceTestSrc || !voiceTestSidetone) return;
    voiceTestNrIdx = idx;
    updateNrButtons();

    // 断开旧 NR 链
    disconnectNrChain();

    var m = VOICE_NR_MODELS[idx];
    if (idx === 0) {
        // 无 NR：直连
        voiceTestSrc.connect(voiceTestSidetone);
        return;
    }

    // 断直连，插入 NR 链
    try { voiceTestSrc.disconnect(voiceTestSidetone); } catch(e) {}

    nrHpf = voiceTestCtx.createBiquadFilter();
    nrHpf.type = 'highpass';
    nrHpf.frequency.value = m.hpf;
    nrHpf.Q.value = 0.5;

    nrComp = voiceTestCtx.createDynamicsCompressor();
    nrComp.threshold.value = m.compTh;
    nrComp.knee.value = 30;
    nrComp.ratio.value = m.compRatio;
    nrComp.attack.value = m.compAttack || 0.01;
    nrComp.release.value = m.compRelease || 0.15;

    nrExpandGain = voiceTestCtx.createGain();
    nrExpandGain.gain.value = 1;

    nrExpandAnalyser = voiceTestCtx.createAnalyser();
    nrExpandAnalyser.fftSize = 256;
    nrExpandAnalyser.smoothingTimeConstant = 0.3;

    voiceTestSrc.connect(nrHpf);
    nrHpf.connect(nrComp);
    nrComp.connect(nrExpandGain);
    nrExpandGain.connect(voiceTestSidetone);
    nrComp.connect(nrExpandAnalyser);

    // 扩展器循环
    var analyser = nrExpandAnalyser;
    var gainNode = nrExpandGain;
    var model = m;
    var data = new Uint8Array(analyser.frequencyBinCount);
    function expandLoop() {
        if (!voiceTestActive || voiceTestNrIdx !== idx || !nrExpandGain) return;
        analyser.getByteTimeDomainData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) { var v = (data[i]-128)/128; sum += v*v; }
        var rms = Math.sqrt(sum / data.length);
        var targetGain;
        if (rms >= model.expTh) { targetGain = 1.0; }
        else {
            var dbBelow = 20 * Math.log10(Math.max(rms, 0.00003) / model.expTh);
            targetGain = Math.pow(10, (dbBelow * (model.expRatio - 1)) / 20);
            targetGain = Math.max(targetGain, 0.06);
        }
        gainNode.gain.setTargetAtTime(targetGain, voiceTestCtx.currentTime, 0.05);
        requestAnimationFrame(expandLoop);
    }
    expandLoop();
    voiceTestNrNodes = { hpf:nrHpf, comp:nrComp, gain:nrExpandGain, analyser:nrExpandAnalyser };
}

function disconnectNrChain() {
    try { if (nrHpf) nrHpf.disconnect(); } catch(e) {}
    try { if (nrComp) nrComp.disconnect(); } catch(e) {}
    try { if (nrExpandGain) nrExpandGain.disconnect(); } catch(e) {}
    try { if (nrExpandAnalyser) nrExpandAnalyser.disconnect(); } catch(e) {}
    try { voiceTestSrc.disconnect(nrHpf); } catch(e) {}
    try { voiceTestSrc.disconnect(voiceTestSidetone); } catch(e) {}
    nrHpf = null; nrComp = null; nrExpandGain = null; nrExpandAnalyser = null;
}

function updateNrButtons() {
    document.querySelectorAll('.voice-nr-btn').forEach(function(b) {
        b.classList.toggle('nr-active', parseInt(b.dataset.nr) === voiceTestNrIdx);
    });
}

// 事件绑定
$('btn-voice-test').addEventListener('click', function() {
    if (voiceTestActive) { stopVoiceTest(); }
    else { startVoiceTest(); }
});

$('voice-sidetone-vol').addEventListener('input', function() {
    var vol = parseInt(this.value) / 100;
    $('voice-sidetone-label').textContent = Math.round(vol*100) + '%';
    if (voiceTestSidetone) voiceTestSidetone.gain.value = vol;
});

document.querySelectorAll('.voice-nr-btn').forEach(function(b) {
    b.addEventListener('click', function() {
        applyNrModel(parseInt(this.dataset.nr));
    });
});

// ==================== Ambient Sound ====================
var ambientActive = null; // current sound name or null
var ambientCtx = null;
var ambientGain = null;
var ambientNodes = null;

function initAmbient() {
    var panel = $('ambient-panel');
    var header = $('ambient-header');
    var dragging = false, sx, sy, sl, st;
    header.addEventListener('pointerdown', function(e) {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        var r = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        panel.style.transition = 'none';
        e.preventDefault();
    });
    document.addEventListener('pointermove', function(e) {
        if (!dragging) return;
        panel.style.left = (sl + e.clientX - sx) + 'px';
        panel.style.top = (st + e.clientY - sy) + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    document.addEventListener('pointerup', function() {
        if (dragging) { dragging = false; panel.style.transition = ''; }
    });

    $('btn-ambient').addEventListener('click', function() {
        var p = $('ambient-panel');
        if (p.style.display === 'flex') { p.style.display = 'none'; return; }
        p.style.display = 'flex';
    });
    $('btn-ambient-close').addEventListener('click', function() {
        $('ambient-panel').style.display = 'none';
    });
    $('ambient-vol').addEventListener('input', function() {
        var v = parseInt(this.value) / 100;
        $('ambient-vol-label').textContent = Math.round(v*100) + '%';
        if (ambientGain) ambientGain.gain.value = v;
    });

    document.querySelectorAll('.ambient-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var snd = this.dataset.sound;
            if (ambientActive === snd) { stopAmbient(); return; }
            startAmbient(snd);
        });
    });
}

function startAmbient(snd) {
    stopAmbient();
    ambientCtx = new (window.AudioContext || window.webkitAudioContext)();
    ambientGain = ambientCtx.createGain();
    ambientGain.gain.value = parseInt($('ambient-vol').value) / 100;
    ambientGain.connect(ambientCtx.destination);

    var sampleRate = ambientCtx.sampleRate;
    var duration = 4; // 4-second loop
    var length = sampleRate * duration;
    var buffer = ambientCtx.createBuffer(1, length, sampleRate);
    var data = buffer.getChannelData(0);

    if (snd === 'rain') {
        for (var i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * 0.008;
        var hpf = ambientCtx.createBiquadFilter();
        hpf.type = 'highpass'; hpf.frequency.value = 800; hpf.Q.value = 0.5;
        var lpf = ambientCtx.createBiquadFilter();
        lpf.type = 'lowpass'; lpf.frequency.value = 5000; lpf.Q.value = 0.5;
        var src = ambientCtx.createBufferSource(); src.buffer = buffer; src.loop = true;
        src.connect(hpf); hpf.connect(lpf); lpf.connect(ambientGain);
        src.start();
        var tickBuf = ambientCtx.createBuffer(1, sampleRate * 0.05, sampleRate);
        var td = tickBuf.getChannelData(0);
        for (var i = 0; i < td.length; i++) td[i] = (Math.random()*2-1) * Math.exp(-i*200/sampleRate) * 0.05;
        var tickSrc = ambientCtx.createBufferSource(); tickSrc.buffer = tickBuf; tickSrc.loop = true;
        var tickGain = ambientCtx.createGain(); tickGain.gain.value = 0.15;
        tickSrc.connect(tickGain); tickGain.connect(ambientGain);
        tickSrc.start();
        ambientNodes = [src, hpf, lpf, tickSrc, tickGain];
    } else if (snd === 'cafe') {
        for (var i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * 0.015;
        var lpf2 = ambientCtx.createBiquadFilter();
        lpf2.type = 'lowpass'; lpf2.frequency.value = 600; lpf2.Q.value = 0.3;
        var src = ambientCtx.createBufferSource(); src.buffer = buffer; src.loop = true;
        src.connect(lpf2); lpf2.connect(ambientGain);
        src.start();
        ambientNodes = [src, lpf2];
    } else if (snd === 'campfire') {
        // 篝火：低频轰隆底噪 + 稀疏噼啪 + 偶尔爆裂
        var bLow = 0;
        for (var i = 0; i < length; i++) {
            bLow = bLow * 0.997 + (Math.random() * 2 - 1) * 0.003;
            data[i] = bLow * 0.25; // 底层音量降低
        }
        for (var i = 0; i < length; i++) {
            // 噼啪: ~每1秒1~2次 (44100 * ~0.00004)
            if (Math.random() < 0.00004) {
                var crackLen = 15 + Math.floor(Math.random() * 50);
                var crackAmp = 0.02 + Math.random() * 0.06; // 降80%+
                for (var j = 0; j < crackLen && i + j < length; j++) {
                    var env = 1 - j / crackLen;
                    data[i + j] += (Math.random() * 2 - 1) * crackAmp * env * env;
                }
            }
            // 大爆裂: ~每4~8秒一次
            if (Math.random() < 0.000005) {
                var popLen = 8 + Math.floor(Math.random() * 15);
                var popAmp = 0.06 + Math.random() * 0.08; // 降80%+
                for (var j = 0; j < popLen && i + j < length; j++) {
                    var env2 = 1 - j / popLen;
                    data[i + j] += (Math.random() * 2 - 1) * popAmp * env2;
                }
            }
        }
        for (var i = 0; i < length; i++) {
            data[i] = Math.max(-1, Math.min(1, data[i] * 1.2));
        }
        // 低频段增强低通滤波
        var src = ambientCtx.createBufferSource(); src.buffer = buffer; src.loop = true;
        var campLPF = ambientCtx.createBiquadFilter();
        campLPF.type = 'lowpass'; campLPF.frequency.value = 3500;
        var campHPF = ambientCtx.createBiquadFilter();
        campHPF.type = 'highpass'; campHPF.frequency.value = 30;
        src.connect(campHPF); campHPF.connect(campLPF); campLPF.connect(ambientGain);
        src.start();
        ambientNodes = [src, campLPF, campHPF];
    } else if (snd === 'white') {
        for (var i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * 0.008;
        var lpf3 = ambientCtx.createBiquadFilter();
        lpf3.type = 'lowpass'; lpf3.frequency.value = 8000;
        var src = ambientCtx.createBufferSource(); src.buffer = buffer; src.loop = true;
        src.connect(lpf3); lpf3.connect(ambientGain);
        src.start();
        ambientNodes = [src, lpf3];
    }

    ambientActive = snd;
    document.querySelectorAll('.ambient-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.sound === snd);
    });
}

function stopAmbient() {
    if (ambientNodes) { ambientNodes.forEach(function(n) { try { n.disconnect(); } catch(e){} }); ambientNodes = null; }
    if (ambientCtx) { ambientCtx.close().catch(function(){}); ambientCtx = null; }
    ambientGain = null;
    ambientActive = null;
    document.querySelectorAll('.ambient-btn').forEach(function(b) { b.classList.remove('active'); });
}

initAmbient();

// ==================== Custom Chat Background ====================
// IndexedDB 背景存取（localStorage 空间太小会丢数据）
var _bgDb = null;
function _bgOpen(cb) {
    if (_bgDb) { cb(_bgDb); return; }
    var req = indexedDB.open('uchat-bg', 1);
    req.onupgradeneeded = function(e) { e.target.result.createObjectStore('images'); };
    req.onsuccess = function(e) { _bgDb = e.target.result; cb(_bgDb); };
    req.onerror = function() { cb(null); };
}
function _bgSave(url, cb) {
    _bgOpen(function(db) { if(!db)return; var t=db.transaction('images','readwrite'); t.objectStore('images').delete(nickname); t.objectStore('images').put(url, nickname); if(cb) t.oncomplete=cb; });
}
function _bgLoad(cb) {
    _bgOpen(function(db) { if(!db){cb(null);return;} var r=db.transaction('images','readonly').objectStore('images').get(nickname); r.onsuccess=function(){cb(r.result);}; r.onerror=function(){cb(null);}; });
}
function _bgDelete(cb) {
    _bgOpen(function(db) { if(!db)return; var t=db.transaction('images','readwrite'); t.objectStore('images').delete(nickname); if(cb) t.oncomplete=cb; });
}

function initChatBg() {
    var msgArea = document.getElementById('message-area');
    window._chatMsgArea = msgArea;

    window.reapplyChatBg = function() {
        var d = window._chatMsgArea; if (!d) return;
        _bgLoad(function(u) {
            if (!u) { d.style.background = ''; return; }
            var isDark = document.body.getAttribute('data-theme') === 'dark';
            var overlay = isDark ? 'rgba(26,26,46,0.92)' : 'rgba(248,248,252,0.88)';
            d.style.background = 'linear-gradient(' + overlay + ',' + overlay + '), url(' + u + ') center/cover';
        });
    };
    window.reapplyChatBg();

    var settingsCard = document.querySelector('.settings-card');
    if (!settingsCard) return;
    var row = document.createElement('div'); row.className = 'setting-row';
    row.innerHTML = '<span>聊天背景</span><span style="display:flex;gap:6px"><button id="btn-bg-upload" class="btn" style="background:var(--btn-bg);color:var(--text-primary);font-size:11px;padding:4px 10px">上传图片</button><button id="btn-bg-clear" class="btn" style="background:var(--btn-bg);color:var(--text-primary);font-size:11px;padding:4px 10px">清除</button></span>';
    var closeBtn = settingsCard.querySelector('.btn-row');
    settingsCard.insertBefore(row, closeBtn);
    var fileInput = document.createElement('input'); fileInput.type='file'; fileInput.accept='image/*'; fileInput.style.display='none';
    document.body.appendChild(fileInput);

    function applyIt(url) {
        _bgSave(url, function() {
            var isDark = document.body.getAttribute('data-theme') === 'dark';
            var overlay = isDark ? 'rgba(26,26,46,0.92)' : 'rgba(248,248,252,0.88)';
            msgArea.style.background = 'linear-gradient(' + overlay + ',' + overlay + '), url(' + url + ') center/cover';
            showToast('背景已设置', 'success');
            // 同步到服务器（data URL 过大则跳过，避免撑爆 prefs.json）
            saveUserPrefs();
        });
    }
    var bu = document.getElementById('btn-bg-upload'); if (bu) bu.addEventListener('click', function(){ fileInput.click(); });
    fileInput.addEventListener('change', function() {
        var f = this.files[0]; if (!f) return;
        var r = new FileReader();
        r.onload = function(e) { applyIt(e.target.result); };
        r.readAsDataURL(f);
    });
    var bc = document.getElementById('btn-bg-clear'); if (bc) bc.addEventListener('click', function() {
        _bgDelete(function() { msgArea.style.background = ''; showToast('背景已清除', 'info'); });
    });
}

// 延迟初始化背景（等待设置面板渲染）
setTimeout(initChatBg, 800);

// ==================== Timer & Random Buttons ====================
var btnTimer = document.getElementById('btn-timer-popup');
if (btnTimer) btnTimer.addEventListener('click', function() {
    // 恢复每日目标值
    var stats = _tmLoadStats();
    var goalEl = $('tm-goal');
    if (goalEl && stats.goalSec) goalEl.value = Math.round(stats.goalSec / 3600);
    $('timer-modal').style.display = 'flex';
    _tmUpdate();
});
var btnRandom = document.getElementById('btn-random-popup');
if (btnRandom) btnRandom.addEventListener('click', function() { $('random-modal').style.display = 'flex'; });

// ==================== Timer (Card-based) ====================
var _tmSec = 25 * 60, _tmRun = false, _tmIv = null;
var _tmWorkSec = 25 * 60, _tmBreakSec = 5 * 60, _tmCycles = 4; // 当前番茄设定
var _tmPomoPhase = 'work', _tmPomoCount = 0, _tmAllDone = false;

// ---- 统计（localStorage + 服务端持久化） ----
var _tmServerSynced = false;
function _tmStatsKey() { return 'uchat-pomo-' + (nickname || 'anon'); }
function _tmLoadStats() {
    var raw = localStorage.getItem(_tmStatsKey());
    var s = raw ? JSON.parse(raw) : null;
    var today = new Date().toDateString();
    var todayKey = new Date().toISOString().slice(0,10);
    if (!s || s.todayDate !== today) {
        // 跨日：保留总数据和历史，重置今日
        var old = s || {};
        return { totalCycles: (old.totalCycles||0), totalSec: (old.totalSec||0), todaySec: 0, todayDate: today, goalSec: (old.goalSec||(parseInt(($('tm-goal')||{}).value)||2)*3600), dailyHistory: (old.dailyHistory||{}) };
    }
    s.todayDate = today;
    s.dailyHistory = s.dailyHistory || {};
    if (!$('tm-goal') || !$('tm-goal').value) {
        var el = $('tm-goal'); if (el && s.goalSec) el.value = Math.round(s.goalSec/3600);
    }
    return s;
}
function _tmSaveStats(s) {
    localStorage.setItem(_tmStatsKey(), JSON.stringify(s));
    _tmSyncToServer(s);
}
function _tmLoadFromServer() {
    if (!nickname || _tmServerSynced) return;
    var base = (location.protocol + '//' + location.host).replace(/\/$/, '');
    fetch(base + '/api/pomodoro/' + encodeURIComponent(nickname) +
        '?' + (typeof getFileAuthParams === 'function' ? getFileAuthParams() : ''))
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data && data.ok && data.stats) {
                var svr = data.stats;
                var local = _tmLoadStats();
                if (svr.totalSec > local.totalSec || svr.totalCycles > local.totalCycles) {
                    local.totalSec = Math.max(local.totalSec, svr.totalSec||0);
                    local.totalCycles = Math.max(local.totalCycles, svr.totalCycles||0);
                    // 只在服务端日期与本地相同时才合并 todaySec
                    if (svr.todayDate === local.todayDate) {
                        local.todaySec = Math.max(local.todaySec, svr.todaySec||0);
                    }
                    if (svr.goalSec) local.goalSec = Math.max(local.goalSec||0, svr.goalSec);
                }
                // 合并每日历史
                if (svr.dailyHistory) {
                    local.dailyHistory = local.dailyHistory || {};
                    for (var d in svr.dailyHistory) {
                        local.dailyHistory[d] = Math.max(local.dailyHistory[d]||0, svr.dailyHistory[d]||0);
                    }
                    localStorage.setItem(_tmStatsKey(), JSON.stringify(local));
                }
            }
            _tmServerSynced = true;
            _tmUpdate();
        }).catch(function(){});
}
function _tmSyncToServer(s) {
    if (!nickname) return;
    var base = (location.protocol + '//' + location.host).replace(/\/$/, '');
    fetch(base + '/api/pomodoro/' + encodeURIComponent(nickname) +
        '?' + (typeof getFileAuthParams === 'function' ? getFileAuthParams() : ''), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ stats: s })
    }).catch(function(){});
}
function _tmAddWork(sec) {
    var s = _tmLoadStats();
    s.totalCycles = (s.totalCycles||0) + 1;
    s.totalSec = (s.totalSec||0) + sec;
    s.todaySec = (s.todaySec||0) + sec;
    if (!$('tm-goal') || !$('tm-goal').value) s.goalSec = (parseInt(($('tm-goal')||{}).value)||2)*3600;
    else s.goalSec = parseInt($('tm-goal').value)*3600;
    // 记录每日历史
    s.dailyHistory = s.dailyHistory || {};
    var todayKey = new Date().toISOString().slice(0,10);
    s.dailyHistory[todayKey] = (s.dailyHistory[todayKey]||0) + sec;
    _tmSaveStats(s);
}

function _restoreTitle() { document.title = pageTitle; }

// ---- 环形进度条 ----
function _tmUpdateRing() {
    var ring = document.getElementById('tm-ring');
    var label = document.getElementById('tm-ring-label');
    var stats = _tmLoadStats();
    var goalSec = stats.goalSec || 7200;
    var pct = Math.min(1, stats.todaySec / goalSec);
    var circ = 2 * Math.PI * 50; // 314.16
    var offset = circ * (1 - pct);
    if (ring) ring.setAttribute('stroke-dashoffset', offset);
    if (label) {
        var h = Math.floor(stats.todaySec / 3600);
        var m = Math.floor((stats.todaySec % 3600) / 60);
        label.innerHTML = '今日<br>' + h + 'h' + m + 'm/' + Math.round(goalSec/3600) + 'h';
    }
}

// ---- 长进度条（工作/休息阶段） ----
function _tmUpdateBar() {
    var segs = document.getElementById('tm-bar-segments');
    var dot = document.getElementById('tm-bar-dot');
    var labels = document.getElementById('tm-bar-labels');
    if (!segs || !dot || !labels) return;

    // 构建阶段数组
    var phases = [];
    for (var i = 0; i < _tmCycles; i++) {
        phases.push({ type: 'work',  sec: _tmWorkSec, label: '工作' + _tmWorkSec/60 + '分' });
        if (i < _tmCycles - 1) {
            phases.push({ type: 'break', sec: _tmBreakSec, label: '休息' + _tmBreakSec/60 + '分' });
        }
    }
    var totalSec = 0;
    for (var i = 0; i < phases.length; i++) totalSec += phases[i].sec;

    // 当前已过时间
    var elapsed = 0;
    for (var i = 0; i < _tmPomoCount; i++) elapsed += _tmWorkSec + _tmBreakSec;
    if (_tmPomoPhase === 'work') {
        elapsed += (_tmWorkSec - _tmSec);
    } else {
        elapsed += _tmWorkSec + (_tmBreakSec - _tmSec);
    }
    if (!_tmRun) elapsed = 0;

    // 渲染分段
    segs.innerHTML = '';
    labels.innerHTML = '';
    for (var i = 0; i < phases.length; i++) {
        var p = phases[i];
        var w = (p.sec / totalSec * 100).toFixed(1);
        var div = document.createElement('div');
        div.style.width = w + '%';
        div.style.height = '100%';
        div.style.background = p.type === 'work' ? '#e91e63' : '#4caf50';
        div.style.opacity = '0.55';
        segs.appendChild(div);
        if (i % 2 === 0) {
            var lbl = document.createElement('span');
            lbl.textContent = p.label;
            lbl.style.width = w + '%';
            lbl.style.textAlign = 'left';
            lbl.style.overflow = 'hidden';
            lbl.style.whiteSpace = 'nowrap';
            labels.appendChild(lbl);
        }
    }
    // 移动圆点
    var dotPct = totalSec > 0 ? Math.min(100, elapsed / totalSec * 100) : 0;
    dot.style.left = dotPct + '%';
}

var _tmViewMode = 'bar'; // 'bar' or 'grid'
function _tmToggleView() {
    _tmViewMode = _tmViewMode === 'bar' ? 'grid' : 'bar';
    var barWrap = document.getElementById('tm-bar-wrap');
    var gridWrap = document.getElementById('tm-grid-wrap');
    var btn = document.getElementById('tm-view-toggle');
    if (barWrap) barWrap.style.display = _tmViewMode === 'bar' ? 'block' : 'none';
    if (gridWrap) gridWrap.style.display = _tmViewMode === 'grid' ? 'block' : 'none';
    if (btn) btn.textContent = _tmViewMode === 'bar' ? '▦' : '━';
    _tmUpdate();
}

function _tmUpdateGrid() {
    var grid = document.getElementById('tm-grid');
    if (!grid || _tmViewMode !== 'grid') return;

    // 构建阶段数组
    var phases = [];
    for (var i = 0; i < _tmCycles; i++) {
        phases.push({ type: 'work', sec: _tmWorkSec });
        if (i < _tmCycles - 1) phases.push({ type: 'break', sec: _tmBreakSec });
    }

    // _tmPomoCount 在 work 结束时 +1
    var elapsed = 0;
    if (_tmPomoPhase === 'work') {
        for (var i = 0; i < _tmPomoCount; i++) elapsed += _tmWorkSec + _tmBreakSec;
        elapsed += (_tmWorkSec - _tmSec);
    } else {
        for (var i = 0; i < Math.max(0, _tmPomoCount - 1); i++) elapsed += _tmWorkSec + _tmBreakSec;
        elapsed += _tmWorkSec + (_tmBreakSec - _tmSec);
    }
    // 计算需要的总分钟数，限制格子数 ≤ 60
    var totalMin = 0;
    for (var p = 0; p < phases.length; p++) totalMin += Math.ceil(phases[p].sec / 60);
    var cellMin = 1;
    if (totalMin > 60) cellMin = Math.ceil(totalMin / 60); // 每个格子代表 cellMin 分钟
    var cellSec = cellMin * 60;

    var cells = [];
    var cumSec = 0;
    for (var p = 0; p < phases.length; p++) {
        var ph = phases[p];
        var n = Math.round(ph.sec / cellSec);
        for (var c = 0; c < n; c++) {
            cumSec += cellSec;
            cells.push({ type: ph.type, past: cumSec <= elapsed });
        }
    }

    grid.innerHTML = '';
    var gridWidth = grid.clientWidth || 400;
    var cellSize = Math.max(10, Math.min(16, Math.floor((gridWidth - (cells.length-1)*2) / cells.length)));
    for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        var div = document.createElement('div');
        div.className = 'tm-cell';
        div.style.width = cellSize + 'px';
        div.style.height = cellSize + 'px';
        if (cell.past) div.classList.add(cell.type);
        if (!cell.past && (c === 0 || cells[c-1].past)) div.classList.add('current');
        grid.appendChild(div);
    }
}

function _tmUpdate() {
    var d = document.getElementById('timer-mini-display');
    if (!d) return;
    var m = Math.floor(_tmSec / 60), s = _tmSec % 60;
    d.textContent = String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    d.style.color = _tmRun ? '#e91e63' : 'var(--accent)';
    if (_tmRun) { document.title = '🍅 ' + d.textContent + ' - Uchat'; }
    else { _restoreTitle(); }
    var btn = document.getElementById('timer-card-start');
    if (btn) { btn.textContent = _tmRun ? '暂停' : '开始'; btn.style.background = _tmRun ? '#ff9800' : '#4caf50'; }
    // 统计文字
    var st = document.getElementById('tm-stats');
    if (st) {
        var stats = _tmLoadStats();
        var th = Math.floor(stats.totalSec / 3600);
        var tm = Math.floor((stats.totalSec % 3600) / 60);
        st.textContent = '累计: ' + (stats.totalCycles||0) + '轮 · ' + th + 'h' + tm + 'm';
    }
    _tmUpdateRing();
    _tmUpdateBar();
    _tmUpdateChart();
    _tmUpdateGrid();
    // 完成特效检测
    if (_tmAllDone) { _tmShowComplete(); } else { _tmClearComplete(); }
}

var _tmCompleted = false;
function _tmShowComplete() {
    if (_tmCompleted) return;
    _tmCompleted = true;
    var grid = document.getElementById('tm-grid');
    var dot = document.getElementById('tm-bar-dot');
    var display = document.getElementById('timer-mini-display');
    // 75% 金色特效, 25% 蓝紫粉渐变
    var isGold = Math.random() < 0.75;
    if (grid) {
        grid.classList.add('tm-complete');
        if (isGold) grid.classList.add('tm-complete-gold');
    }
    if (dot) {
        dot.classList.add('tm-firework');
        if (isGold) dot.classList.add('tm-firework-gold');
    }
    if (display) {
        display.style.color = isGold ? '#ffd700' : '#e040fb';
    }
}
function _tmClearComplete() {
    _tmAllDone = false;
    if (!_tmCompleted) return;
    _tmCompleted = false;
    var grid = document.getElementById('tm-grid');
    if (grid) { grid.classList.remove('tm-complete', 'tm-complete-gold'); }
    var dot = document.getElementById('tm-bar-dot');
    if (dot) { dot.classList.remove('tm-firework', 'tm-firework-gold'); }
    var display = document.getElementById('timer-mini-display');
    if (display) display.style.color = '';
}

function _tmUpdateChart() {
    var chart = document.getElementById('tm-chart');
    var labels = document.getElementById('tm-chart-labels');
    if (!chart || !labels) return;
    var stats = _tmLoadStats();
    var dh = stats.dailyHistory || {};
    var maxSec = 0, days = [];
    for (var i = 6; i >= 0; i--) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        var key = d.toISOString().slice(0,10);
        var sec = dh[key] || 0;
        if (sec > maxSec) maxSec = sec;
        days.push({ key: key, sec: sec, label: (d.getMonth()+1)+'/'+d.getDate(), w: ['日','一','二','三','四','五','六'][d.getDay()] });
    }
    if (maxSec === 0) maxSec = 3600;
    chart.innerHTML = ''; labels.innerHTML = '';
    days.forEach(function(day) {
        var bar = document.createElement('div');
        bar.className = 'pomo-bar';
        bar.style.height = Math.max(2, (day.sec / maxSec) * 90) + 'px';
        var hh = Math.floor(day.sec/3600), mm = Math.floor((day.sec%3600)/60);
        bar.title = day.key + ': ' + hh + 'h' + mm + 'm';
        if (day.sec > 0) bar.innerHTML = '<span class="pomo-bar-label">' + hh + 'h' + mm + 'm</span>';
        chart.appendChild(bar);
        var lbl = document.createElement('div');
        lbl.style.cssText = 'flex:1;min-width:30px;text-align:center;white-space:pre-line';
        lbl.textContent = day.label + '\n周' + day.w;
        labels.appendChild(lbl);
    });
}

// ==================== Random Picker ====================
function randomPick() {
    var input = document.getElementById('random-options-input');
    var result = document.getElementById('random-result');
    if (!input || !result) return;
    var text = input.value.replace(/\n/g, ' ').trim();
    if (!text) { result.textContent = '请先输入选项'; return; }
    var options = text.split(/\s+/).filter(function(s) { return s.length > 0; });
    if (options.length < 2) { result.textContent = '至少需要2个选项'; return; }
    var count = 0, max = 15;
    var iv = setInterval(function() {
        var idx = Math.floor(Math.random() * options.length);
        result.textContent = '🎯 ' + options[idx];
        result.style.transform = 'scale(' + (1 + Math.random()*0.1) + ')';
        count++;
        if (count >= max) {
            clearInterval(iv);
            var final = options[Math.floor(Math.random() * options.length)];
            result.textContent = '✅ ' + final;
            result.style.transform = 'scale(1.15)';
            setTimeout(function() { result.style.transform = 'scale(1)'; }, 200);
        }
    }, 80);
}

function _clamp(v, min, max, def) { var n = parseInt(v); return isNaN(n) || n < min || n > max ? def : n; }

function timerCardApplyPomo() {
    if (_tmRun) { clearInterval(_tmIv); _tmIv = null; _tmRun = false; }
    _tmClearComplete();
    var w = _clamp((document.getElementById('tm-work')||{}).value, 1, 120, 25);
    var b = _clamp((document.getElementById('tm-break')||{}).value, 1, 60, 5);
    var c = _clamp((document.getElementById('tm-cycles')||{}).value, 1, 20, 4);
    var g = _clamp((document.getElementById('tm-goal')||{}).value, 1, 12, 2);
    document.getElementById('tm-work').value = w;
    document.getElementById('tm-break').value = b;
    document.getElementById('tm-cycles').value = c;
    document.getElementById('tm-goal').value = g;
    _tmWorkSec = w * 60; _tmBreakSec = b * 60; _tmCycles = c;
    _tmSec = w * 60;
    _tmPhaseDuration = w * 60;
    _tmPomoPhase = 'work';
    _tmPomoCount = 0;
    _tmLoadStats();
    _tmUpdate();
}

var _tmPhaseStart = 0, _tmPhaseDuration = 0;

function timerCardStartStop() {
    if (_tmRun) { clearInterval(_tmIv); _tmIv = null; _tmRun = false; _tmUpdate(); return; }
    _tmRun = true;
    _tmPhaseStart = Date.now();
    _tmPhaseDuration = _tmSec;
    _tmUpdate();
    _tmIv = setInterval(function() {
        var elapsed = Math.floor((Date.now() - _tmPhaseStart) / 1000);
        _tmSec = Math.max(0, _tmPhaseDuration - elapsed);
        _tmUpdate();
        if (_tmSec <= 0) {
            if (_tmPomoPhase === 'work') {
                _tmAddWork(_tmWorkSec);
                _tmPomoCount++;
                // 最后一轮工作结束 = 全部完成，无需休息
                if (_tmPomoCount >= _tmCycles) {
                    _tmAllDone = true;
                    _tmPomoPhase = 'work'; _tmPomoCount = 0; _tmSec = _tmWorkSec;
                    clearInterval(_tmIv); _tmIv = null; _tmRun = false;
                    if (typeof showToast === 'function') showToast('🎉 ' + _tmCycles + '轮完成！', 'success');
                    try { var c=new (window.AudioContext||window.webkitAudioContext)(),o=c.createOscillator(),g=c.createGain(); o.connect(g);g.connect(c.destination);o.type='sine';g.gain.value=0.3;o.frequency.setValueAtTime(880,c.currentTime);o.frequency.setValueAtTime(1100,c.currentTime+0.1);g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+0.5);o.start();o.stop(c.currentTime+0.5); } catch(e){}
                } else {
                    // 进入休息
                    _tmPomoPhase = 'break'; _tmSec = _tmBreakSec;
                    _tmPhaseStart = Date.now(); _tmPhaseDuration = _tmSec;
                    if (typeof showToast === 'function') showToast('🍅 休息' + Math.floor(_tmBreakSec/60) + '分钟', 'success');
                }
            } else {
                // 休息结束 → 进入下一轮工作
                _tmPomoPhase = 'work'; _tmSec = _tmWorkSec;
                _tmPhaseStart = Date.now(); _tmPhaseDuration = _tmSec;
                if (typeof showToast === 'function') showToast('☕ 第' + (_tmPomoCount+1) + '/' + _tmCycles + '轮', 'info');
            }
            _tmUpdate();
        }
    }, 250);
}

function timerCardReset() {
    // 重置前先保存当前已专注时长（满1分钟才记录）
    if (_tmPomoPhase === 'work') {
        var elapsed = _tmWorkSec - _tmSec;
        var mins = Math.floor(elapsed / 60);
        if (mins >= 1) {
            _tmAddWork(mins * 60);
            if (typeof showToast === 'function') showToast('已记录 ' + mins + ' 分钟专注', 'info');
        }
    }
    if (_tmRun) { clearInterval(_tmIv); _tmIv = null; _tmRun = false; }
    _tmClearComplete();
    var w = _clamp((document.getElementById('tm-work')||{}).value, 1, 120, 25);
    document.getElementById('tm-work').value = w;
    _tmSec = w * 60;
    _tmPomoPhase = 'work';
    _tmPomoCount = 0;
    _tmUpdate();
}

// ==================== File Overview ====================
$('btn-files-view').addEventListener('click', async () => {
    $('files-modal').style.display = 'flex';
    const list = $('files-list');
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">加载中...</div>';
    try {
        const resp = await fetch(getApiBaseUrl() + '/api/files/list?' + getFileAuthParams());
        const files = await resp.json();
        if (files.length === 0) {
            list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">暂无文件</div>';
        } else {
            const auth = typeof getFileAuthParams === 'function' ? getFileAuthParams() : '';
            list.innerHTML = files.map((f, i) => {
                const isImg = /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(f.name);
                const isAudio = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i.test(f.name);
                const isVideo = /\.(mp4|webm|m4v|mov|mkv|ogv)$/i.test(f.name);
                const baseUrl = getApiBaseUrl();
                const authSuffix = auth ? '?' + auth : '';
                const previewUrl = baseUrl + '/api/files/preview/' + encodeURIComponent(f.name) + authSuffix;
                const url = isImg ? previewUrl
                    : baseUrl + '/api/files/download/' + encodeURIComponent(f.name) + authSuffix;
                const head = !isImg ? `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light);cursor:pointer"
                    onclick="window.open('${url}')">
                    <span>${isAudio ? '🎵' : (isVideo ? '🎬' : '📄')}</span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.name}</span>
                    <span style="color:var(--text-muted);font-size:11px">${formatFileSize(f.size)}</span>
                </div>`
                : `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light);cursor:pointer"
                    onclick="openLightbox('${url}')">
                    <span>🖼️</span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.name}</span>
                    <span style="color:var(--text-muted);font-size:11px">${formatFileSize(f.size)}</span>
                </div>`;
                const cp = '<div id="file-overview-player-' + i + '"></div>';
                const playable = isAudio || (isVideo && /^(mp4|webm|m4v|ogv|mov)$/i.test((f.name.split('.').pop() || '')));
                const playBtn = playable
                    ? `<button onclick="toggleFileOverviewPlayer(${i}, '${isAudio ? 'audio' : 'video'}', '${previewUrl}')"
                         style="margin-left:6px;padding:2px 8px;font-size:11px;border:1px solid var(--border);background:var(--panel-bg);color:var(--text-primary);border-radius:4px;cursor:pointer">▶ 播放</button>`
                    : (isVideo ? `<span style="font-size:11px;color:var(--text-muted)">需本地播放器</span>` : '');
                return `<div style="border-bottom:1px solid var(--border-light)">
                    <div style="display:flex;align-items:center;gap:10px">
                        <div style="flex:1">${head}</div>${playBtn}
                    </div>${cp}</div>`;
            }).join('');
        }
    } catch(e) {
        list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--error)">加载失败</div>';
    }
});

/**
 * 文件总览里的音频/视频内联播放（2026-09-25 v2.9.16）
 * 用同一个 /api/files/preview/<name>（服务端已支持 HTTP Range ⇒ 可拖动进度、按需分段加载）。
 * 再点一次就收起来，避免同时在放好几个。
 */
window.toggleFileOverviewPlayer = function (idx, kind, url) {
    var box = document.getElementById('file-overview-player-' + idx);
    if (!box) return;
    if (box.firstChild) { try { box.firstChild.pause(); } catch (e) {} box.innerHTML = ''; return; }
    if (kind === 'audio' && typeof buildAudioPlayerHtml === 'function') {
        // 音频用聊天室里那套自绘播放器（原生控件的音量/倍速藏在弹出菜单里，易误触/被遮挡）
        box.innerHTML = buildAudioPlayerHtml('ov' + idx, url, url, '');
        return;
    }
    var el = document.createElement(kind);
    el.controls = true;
    el.preload = 'metadata';
    el.src = url;
    if (kind === 'video') { el.playsInline = true; el.style.cssText = 'width:100%;max-width:420px;margin:8px 0;border-radius:6px;background:#000'; }
    else { el.style.cssText = 'width:100%;max-width:420px;margin:8px 0'; }
    box.appendChild(el);
    el.play().catch(function () { });
};

$('btn-files-close').addEventListener('click', () => $('files-modal').style.display = 'none');
$('files-modal').addEventListener('click', e => {
    if (e.target === $('files-modal')) $('files-modal').style.display = 'none';
});

// ==================== Music Room（v2.9.16：本地音频/网易云 + 真同步 + 版权兜底） ====================
// 设计要点
//   ① **真同步**：服务端给出当前曲目的服务器起点 startedAt 与其自身时钟 serverTime，
//      每个客户端算 expected = (serverNow - startedAt)/1000（秒）→ seek 到该位置。
//      中途进来的人也能对齐；每 2 秒检查一次，偏差 >0.8 秒自动拉回。
//   ② **两种音源**：网易云外链（可能受版权限制，放不出来是常态）/ 本地音频（上传到服务器，
//      房间内所有人共用同一个 URL，音源可控、时长可算、seek 可用）。
//   ③ **失败必须可见 + 有人兜底**：点歌人上报 music_room_fail（服务端会广播「⚠ xxx 的曲目无法播放…已自动跳过」），
//      服务端另有 90 秒兜底（连上报都没有时也会推进）。
var MR_MAX = 4;                   // 与后端 MUSIC_ROOM_MAX 保持一致（仅用于显示）
var inMusicRoom = false;
var mrUsers = [], mrTracks = {}, mrTurnIdx = 0;
var mrTrackKey = '', mrStartedAt = 0, mrDuration = 0;
var mrOffset = 0;                 // serverNow - Date.now()（时钟偏移，收到状态时更新）
var mrLocalKey = '';              // 本机已加载的曲目键（trackKey 变化才重新加载）
var mrMetaSentFor = '';           // 已上报过时长的曲目键
var mrFailSentFor = '';           // 已上报过失败的曲目键
var mrNeedGesture = false;        // 浏览器拒绝自动播放 → 显示「点这里开始同步播放」
var mrAlignedKey = '';            // 已经做过"首次对齐"的曲目键（避免反复硬 seek）
var mrLastSeekAt = 0;             // 上次 seek 的时间（节流用）
var mrSyncTimer = null, mrLoadTimer = null;

function mrNow() { return Date.now() + mrOffset; }
function mrFmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}
function mrDjNick() { return mrUsers[mrTurnIdx] || ''; }
function mrTrackOf(nick) { return mrTracks[nick] || null; }

/** 解析服务端 content："nick|平台|spec" 用换行分隔 */
function mrParseContent(content) {
    var map = {};
    if (!content) return map;
    content.split('\n').forEach(function (line) {
        var p = line.split('|');
        if (p.length >= 3 && p[0]) map[p[0]] = { platform: p[1], spec: p[2] };
        else if (p.length === 2 && p[0]) map[p[0]] = { platform: 'netease', spec: p[1] };   // 兼容旧格式
    });
    return map;
}

function mrUrl(platform, spec) {
    if (platform === 'local') return '/music/' + encodeURIComponent(spec);
    return 'https://music.163.com/song/media/outer/url?id=' + encodeURIComponent(spec) + '.mp3';
}

function mrSetWarn(text) {
    var el = $('music-room-warn');
    if (!el) return;
    if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = '';
    el.innerHTML = text;
}
function mrSetSyncBadge(text, color) {
    var el = $('music-room-sync-badge');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = color || '#7ec0f6';
}

/** 停止本地播放并复位 UI（离开房间 / 房间空 / 换人未选歌） */
function mrStop(msg) {
    var player = $('music-room-player');
    if (mrLoadTimer) { clearTimeout(mrLoadTimer); mrLoadTimer = null; }
    mrLocalKey = '';
    mrAlignedKey = '';
    mrNeedGesture = false;
    if (player) {
        try { player.pause(); } catch (e) { }
        // ⚠️ 不要写 player.src = ''：那会触发一次 error(code 4) 并弹出"这首歌放不出来"的误报；
        //    摘掉属性 + 清事件即可（下一次加载会重新挂）。
        try { player.onloadedmetadata = null; player.onended = null; player.onerror = null; player.onstalled = null; } catch (e) { }
        try { player.removeAttribute('src'); player.load(); } catch (e) { }
    }
    var start = $('btn-music-room-start');
    if (start) start.style.display = 'none';
    $('music-room-progress').style.width = '0%';
    $('music-room-pos').textContent = '0:00';
    $('music-room-dur').textContent = '--:--';
    $('music-room-track-name').textContent = msg || '等待歌曲...';
    mrSetSyncBadge('');
}

/** 把播放位置对齐到服务端起点（返回期望秒数） */
function mrExpected() {
    if (!mrStartedAt) return 0;
    return Math.max(0, (mrNow() - mrStartedAt) / 1000);
}

/**
 * 对齐播放位置。
 *   hard=true 仅用于「首次拿到元数据 / 点 ⟳ / 手势开始播放」这三种情形；
 *   常规校正走容差（drift > 1.0s）且**节流**（≥1.5 秒才允许再 seek 一次），
 *   并且要求 readyState≥2、时长已知、目标 >0.5 秒 —— 否则一律不 seek。
 *   ⚠️ 每一次 currentTime 赋值都会重新触发 canplay/seeking，历史上就是因为反复硬 seek
 *      把音频切碎成杂音（实测 3500 次/秒）。
 */
function mrAlign(hard) {
    var player = $('music-room-player');
    if (!player || !mrStartedAt) return;
    if (!player.src || player.readyState < 2) return;
    var dur = (mrDuration > 0) ? mrDuration : (isFinite(player.duration) ? player.duration : 0);
    var want = mrExpected();
    if (want < 0.5 || want >= (dur > 0 ? dur - 0.3 : Infinity)) {
        mrSetSyncBadge('同步中', '#7ec0f6');
        return;
    }
    var drift = Math.abs((player.currentTime || 0) - want);
    var now = Date.now();
    var need = hard || drift > 1.0;
    if (!need || now - mrLastSeekAt < 1500) {
        mrSetSyncBadge((drift > 1.0 ? '校正中 ' : '同步中 ') + mrFmt(player.currentTime || want), '#7ec0f6');
        return;
    }
    mrLastSeekAt = now;
    try { player.currentTime = want; } catch (e) { }
    mrSetSyncBadge('已对齐 ' + mrFmt(want), '#7ec0f6');
}

/** 载入并（尽量）开始播放某曲目 */
function mrLoadTrack(dj, platform, spec) {
    var player = $('music-room-player');
    var localKey = platform + ':' + spec + '@' + dj;
    // 清掉上一首遗留的回调，避免旧闭包把新曲目的状态写乱
    try { player.onloadedmetadata = null; player.oncanplay = null; player.onended = null; player.onerror = null; } catch (e) {}
    mrLocalKey = localKey;
    mrAlignedKey = '';              // 新曲目 → 允许一次"首次硬对齐"
    mrLastSeekAt = 0;
    mrNeedGesture = false;
    mrSetWarn('');
    $('btn-music-room-start').style.display = 'none';
    $('music-room-track-name').textContent = (dj === nickname ? '你' : dj) + ' 正在播放：'
        + (platform === 'local' ? spec : '网易云 #' + spec);
    $('music-room-dur').textContent = mrDuration > 0 ? mrFmt(mrDuration) : '--:--';

    var url = mrUrl(platform, spec);
    // ⚠️ 必须先挂事件再设 src：命中 HTTP 缓存时 loadedmetadata 可能在赋值之后、挂载之前就触发
    //    （实测：DJ 端拿不到时长、不 seek、也不真正播放 —— 听众端反而正常）
    player.onloadedmetadata = function () {
        if (mrLocalKey !== localKey) return;
        mrApplyMeta(localKey, dj);
    };
    // ⚠️ 绝不要给 oncanplay 挂同一个 handler：canplay 在**每次 seek 之后都会再触发**，
    //    而 handler 结尾是硬 seek ⇒ canplay→seek→canplay 死循环（实测 3500 次 seek/秒 = 滋滋啦啦）
    player.onended = function () {
        if (mrLocalKey !== localKey) return;
        // 播完：由服务端按"起点+时长"推进（这里只做本地提示），点歌人若一直没被推进则兜底点一次跳过
        mrSetSyncBadge('本曲结束，等待下一首…', '#aaa');
        if (dj === nickname) {
            setTimeout(function () {
                if (mrLocalKey === localKey && inMusicRoom && ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'music_room_skip', nickname: nickname }));
                }
            }, 8000);
        }
    };
    player.onerror = function () { mrFail('外链被拒绝或格式不支持'); };
    player.onstalled = function () { /* 网络卡顿：交给同步循环拉回 */ };

    try { player.pause(); } catch (e) { }
    player.style.display = '';
    player.preload = 'auto';
    player.src = url;
    try { player.load(); } catch (e) { }

    if (mrLoadTimer) { clearTimeout(mrLoadTimer); mrLoadTimer = null; }
    mrLoadTimer = setTimeout(function () {
        // 20 秒还没拿到 metadata ⇒ 基本可以判定放不出来（网易云版权限制/外链失效最常见；
        // 本地大文件在手机慢网下也可能要十几秒，所以别设太短）
        if (mrLocalKey !== localKey) return;
        if (player.readyState < 1) mrFail('20 秒内没能开始播放（可能受版权限制或链接失效）');
    }, 20000);
    // 兜底：有些环境（本地文件/缓存）事件会早到或干脆不派发，第一帧同步循环里再取一次元数据
    setTimeout(function () { if (mrLocalKey === localKey) mrApplyMeta(localKey, dj); }, 400);
}

/** 幂等地把"拿到元数据"该做的事做一遍：记时长 → 上报 DJ 时长 → seek 对齐 → 播放 */
function mrApplyMeta(localKey, dj) {
    var player = $('music-room-player');
    if (!player || mrLocalKey !== localKey) return;
    if (player.readyState >= 1) {
        if (mrLoadTimer) { clearTimeout(mrLoadTimer); mrLoadTimer = null; }
        var d = isFinite(player.duration) ? Math.round(player.duration) : 0;
        if (d > 0 && d !== mrDuration) {
            mrDuration = d;
            $('music-room-dur').textContent = mrFmt(d);
        }
        if (dj === nickname && mrMetaSentFor !== localKey && d > 0) {
            mrMetaSentFor = localKey;
            mrTrySend({ type: 'music_room_meta', nickname: nickname, duration: d });
        }
    }
    // 首次对齐只做一次；之后交给 2 秒循环的容差校正（避免反复硬 seek 切碎音频）
    if (mrAlignedKey !== localKey) {
        mrAlignedKey = localKey;
        mrLastSeekAt = 0;
        mrAlign(true);
    } else {
        mrAlign(false);
    }
    mrTryPlay(localKey);
}

function mrTryPlay(localKey) {
    var player = $('music-room-player');
    if (!player || !player.src) return;
    var p = player.play();
    if (p && p.catch) {
        p.then(function () {
            mrNeedGesture = false;
            $('btn-music-room-start').style.display = 'none';
            mrAlign(false);          // 只做容差校正，别再硬 seek
        }).catch(function (e) {
            var name = (e && e.name) || '';
            if (name === 'NotAllowedError') {
                // 浏览器自动播放策略：需要用户手势（手机上必然如此）
                mrNeedGesture = true;
                $('btn-music-room-start').style.display = '';
                mrSetWarn('浏览器要求手动开始播放（手机/首次进入常见）—— 点上面的按钮即可，之后会自动对齐到房间进度。');
            } else {
                mrFail('播放失败：' + (e && e.message ? e.message : name));
            }
        });
    }
}

/** 曲目放不出来：本机提示 + 点歌人上报服务端（服务端会广播并自动跳过） */
function mrFail(reason) {
    var dj = mrDjNick();
    mrSetWarn('⚠ 这首歌放不出来：' + reason + '。<br>网易云外链只对有外链权限的曲目有效；'
        + '可以换成「📁 本地音频」，或点「跳过」换下一首。');
    mrSetSyncBadge('播放失败', '#ff9800');
    // 只有点歌人能代表整首曲子的命运（别人失败可能只是自己网络的问题）
    if (dj === nickname && mrLocalKey && mrFailSentFor !== mrLocalKey) {
        mrFailSentFor = mrLocalKey;
        mrTrySend({ type: 'music_room_fail', nickname: nickname, reason: reason });
    }
}

/** 安全发送（未连接时静默丢弃） */
function mrTrySend(obj) {
    try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    } catch (e) { }
}

/** 每 2 秒：拉回偏差 / 尝试恢复播放 / 刷新进度条 */
function mrSyncTick() {
    if (!inMusicRoom) return;
    var player = $('music-room-player');
    if (!player || !player.src) return;
    if (!player.paused) {
        mrAlign(false);
    } else if (!mrNeedGesture) {
        mrTryPlay(mrLocalKey);   // 暂停着但不是"需要手势" → 尝试继续（比如刚 seek 过）
    }
    if (mrDuration === 0 && player.readyState >= 1) mrApplyMeta(mrLocalKey, mrDjNick());   // 幂等：只取元数据，不会反复硬 seek
    var cur = player.currentTime || 0;
    var total = (mrDuration > 0) ? mrDuration : (isFinite(player.duration) ? player.duration : 0);
    $('music-room-pos').textContent = mrFmt(cur);
    $('music-room-progress').style.width = total > 0 ? Math.min(100, (cur / total) * 100) + '%' : '0%';
}

/** 收到服务端 music_room_state：刷新 UI + 驱动同步 */
function updateMusicRoom(state) {
    // 时钟偏移（用于把"服务端起点"换成本地时间）
    if (state.serverTime) mrOffset = state.serverTime - Date.now();

    mrUsers = state.users || [];
    mrTracks = mrParseContent(state.content);
    mrTurnIdx = state.count || 0;
    mrStartedAt = state.startedAt || 0;
    mrDuration = state.duration || 0;
    var newKey = state.trackKey || '';

    // 用户列表里的听歌状态
    window.clearAllUserStatuses && window.clearAllUserStatuses('music');
    mrUsers.forEach(function (u) { window.setUserStatus && window.setUserStatus(u, 'music', true); });

    inMusicRoom = mrUsers.indexOf(nickname) >= 0;
    $('btn-music').classList.toggle('active', inMusicRoom);

    // 与通话/屏幕共享互斥
    if (inMusicRoom) {
        $('btn-video-call').classList.add('disabled');
        $('btn-video-call').title = '听歌房中不可用';
        $('btn-screen-share').classList.add('disabled');
        $('btn-screen-share').title = '听歌房中不可用';
    } else {
        $('btn-video-call').classList.remove('disabled');
        $('btn-video-call').title = '通话 / 换房间';
        $('btn-screen-share').classList.remove('disabled');
        $('btn-screen-share').title = '屏幕共享';
    }

    if (mrUsers.length === 0 || !inMusicRoom) {
        // 房间空了 **或者自己已不在名单里**（主动退出/被移出）⇒ 停播 + 收面板 + 停同步循环。
        // 旧实现只看"房间是否为空"⇒ 自己退出后本地还在继续放歌（2026-09-24 修正）。
        $('music-room').style.display = 'none';
        $('btn-music').classList.remove('active');
        inMusicRoom = false;
        mrTrackKey = '';
        mrLocalKey = '';
        mrStop('等待歌曲...');
        if (mrSyncTimer) { clearInterval(mrSyncTimer); mrSyncTimer = null; }
        if (mrLoadTimer) { clearTimeout(mrLoadTimer); mrLoadTimer = null; }
        return;
    }

    $('music-room').style.display = 'flex';
    $('music-room-count').textContent = mrUsers.length + '/' + MR_MAX;
    if (!mrSyncTimer) mrSyncTimer = setInterval(mrSyncTick, 2000);

    var myTurn = mrDjNick() === nickname;
    var alreadyPicked = myTurn && mrTrackOf(nickname) && mrTrackOf(nickname).spec;

    // 成员列表（轮到的标红 + 已选歌标记）
    $('music-room-users').innerHTML = mrUsers.map(function (u, i) {
        var isCurrent = i === mrTurnIdx;
        var t = mrTrackOf(u);
        var picked = t && t.spec;
        var icon = isCurrent ? '▶' : '○';
        var label = t && t.spec ? (t.platform === 'local' ? '本地音频' : '网易云 #' + t.spec) : '';
        return '<div style="display:flex;align-items:center;gap:6px;padding:2px 0;' + (isCurrent ? 'color:#e91e63;font-weight:600' : '') + '">'
            + '<span>' + icon + ' ' + esc(u) + (u === nickname ? ' (你)' : '') + (isCurrent ? ' — 选歌中' : '') + '</span>'
            + (picked ? '<span style="font-size:10px;opacity:0.6;margin-left:auto">' + label + '</span>' : '')
            + '</div>';
    }).join('');

    // 选歌控件：只在轮到自己且还没选时可用
    var actions = $('music-room-actions');
    if (myTurn && !alreadyPicked) {
        actions.style.display = '';
        $('music-room-input').disabled = false;
        $('btn-music-room-pick').disabled = false;
        $('btn-music-room-file').disabled = false;
        $('music-room-input').placeholder = '粘贴网易云歌曲链接（song?id=数字）';
    } else if (myTurn && alreadyPicked) {
        actions.style.display = '';
        $('music-room-input').disabled = true;
        $('btn-music-room-pick').disabled = true;
        $('btn-music-room-file').disabled = true;
        $('music-room-input').placeholder = '已选歌，等待播放结束…';
    } else {
        actions.style.display = 'none';
    }

    // 曲目：键变了才重新加载（load/seek/play 都交给 mrLoadTrack）
    if (!newKey) {
        mrTrackKey = '';
        var djWaiting = mrDjNick();
        mrStop(djWaiting ? ('等待 ' + djWaiting + ' 选歌…') : '等待歌曲...');
        return;
    }
    if (newKey !== mrTrackKey || newKey !== mrLocalKey) {
        mrTrackKey = newKey;
        var dj = mrDjNick();
        var t = mrTrackOf(dj);
        if (t && t.spec) {
            mrLoadTrack(dj, t.platform, t.spec);
        } else {
            mrStop('等待歌曲...');
        }
    } else {
        // 同一首：定期对齐（此处也顺手刷新一次，避免只有 2 秒循环在跑）
        mrAlign(false);
    }
}

// ---------- 面板事件 ----------
$('btn-music').addEventListener('click', () => {
    if (isOffline()) { showToast('连接已断开', 'error'); return; }
    if (!inMusicRoom) {
        ws.send(JSON.stringify({ type: 'music_room_join', nickname: nickname }));
    } else {
        ws.send(JSON.stringify({ type: 'music_room_leave', nickname: nickname }));
    }
});

$('btn-music-room-close').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!inMusicRoom) { $('music-room').style.display = 'none'; return; }
    ws.send(JSON.stringify({ type: 'music_room_leave', nickname: nickname }));
    $('music-room').style.display = 'none';
    inMusicRoom = false;
    $('btn-music').classList.remove('active');
    $('btn-video-call').classList.remove('disabled');
    $('btn-video-call').title = '通话 / 换房间';
    $('btn-screen-share').classList.remove('disabled');
    $('btn-screen-share').title = '屏幕共享';
    if (mrSyncTimer) { clearInterval(mrSyncTimer); mrSyncTimer = null; }
    mrTrackKey = '';
    mrStop('等待歌曲...');
});

// 音量（本地记忆）
(function initMusicVolume() {
    var saved = parseInt(localStorage.getItem('musicVol') || '40');
    var player = $('music-room-player');
    $('music-room-vol').value = saved;
    $('music-room-vol-label').textContent = saved + '%';
    player.volume = Math.pow(saved / 100, 2);
    $('music-room-vol').addEventListener('input', function () {
        var vol = parseInt($('music-room-vol').value);
        localStorage.setItem('musicVol', vol);
        player.volume = Math.pow(vol / 100, 2);
        $('music-room-vol-label').textContent = vol + '%';
    });
})();

// 📁 本地音频：选文件 → 上传 → 作为 local 曲目点歌
$('btn-music-room-file').addEventListener('click', function () {
    $('music-room-file').click();
});
$('music-room-file').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    var maxMB = 30;
    if (f.size > maxMB * 1024 * 1024) { showToast('音频不能超过 ' + maxMB + 'MB', 'error'); return; }
    var box = $('music-room-upload');
    box.style.display = '';
    box.textContent = '上传中… ' + f.name;
    var auth = (typeof getFileAuthParams === 'function') ? getFileAuthParams() : '';
    var fd = new FormData();
    fd.append('file', f);
    fetch('/api/music/upload?' + auth, { method: 'POST', body: fd })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
            if (!res.ok || !res.j || !res.j.name) {
                box.textContent = '上传失败：' + ((res.j && res.j.error) || '未知错误');
                box.style.color = '#ff9800';
                return;
            }
            box.textContent = '上传完成：' + (res.j.displayName || res.j.name) + '（' + Math.round(res.j.size / 1024) + ' KB）→ 正在点歌';
            box.style.color = '#7ec0f6';
            mrTrySend({ type: 'music_room_pick', nickname: nickname, platform: 'local',
                        content: res.j.name, prompt: res.j.displayName || '' });
        })
        .catch(function (e) {
            box.textContent = '上传失败：' + (e && e.message ? e.message : e);
            box.style.color = '#ff9800';
        });
});

// 用链接点歌（网易云；也接受纯数字 id；直接贴 .mp3/.ogg 等直链会被当作网易云 id 清洗，故提示用本地音频）
$('btn-music-room-pick').addEventListener('click', function () {
    var url = ($('music-room-input').value || '').trim();
    if (!url) return;
    var id = url;
    var m = url.match(/[?&/]id=(\d+)/);
    if (m) id = m[1];
    id = id.replace(/[^0-9]/g, '');
    if (!id) {
        showToast('没解析出曲目 id：请用网易云歌曲链接（含 song?id=数字）', 'error');
        return;
    }
    mrTrySend({ type: 'music_room_pick', nickname: nickname, platform: 'netease', content: id });
    $('music-room-input').value = '';
});

$('btn-music-room-skip').addEventListener('click', function () {
    mrTrySend({ type: 'music_room_skip', nickname: nickname });
});

// 强制对齐（万一漂移了）
$('btn-music-room-resync').addEventListener('click', function () {
    mrAlign(true);
    showToast('已对齐到房间进度 ' + mrFmt(mrExpected()), 'info');
});

// 浏览器拒绝自动播放时的手势入口
$('btn-music-room-start').addEventListener('click', function () {
    mrNeedGesture = false;
    this.style.display = 'none';
    mrSetWarn('');
    mrAlign(true);
    mrTryPlay(mrLocalKey);
});

// ==================== Dice ====================
let diceRolling = false;
$('btn-dice').addEventListener('click', () => {
    if (diceRolling || isOffline()) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    diceRolling = true;
    const result = Math.floor(Math.random() * 6) + 1;
    const diceBtn = $('btn-dice');
    let count = 0;
    // 动画节奏：原来 12 帧 × 80ms + 400ms = 1.36s 才把消息发出去，
    // 手机上体感就是"点了没反应"（2026-09-24 体检时我自己都误判成死按钮）。压到 ~0.56s。
    const maxCount = 6;
    const faces = ['', '⚀','⚁','⚂','⚃','⚄','⚅'];
    const interval = setInterval(() => {
        count++;
        diceBtn.textContent = faces[Math.floor(Math.random() * 6) + 1];
        if (count >= maxCount) {
            clearInterval(interval);
            diceBtn.textContent = faces[result];
            // Send result and reset after brief pause
            setTimeout(() => {
                ws.send(JSON.stringify({
                    type: 'chat', nickname: nickname,
                    content: '🎲 掷出了 ' + result + ' 点',
                    msgId: Date.now() + '_' + Math.random()
                }));
                diceBtn.textContent = '🎲';
                diceRolling = false;
            }, 200);
        }
    }, 60);
});

// ==================== Toolbar Actions ====================
$('btn-theme').addEventListener('click', toggleTheme);
$('btn-clear').addEventListener('click', () => {
    messageArea.innerHTML = '';
    if (typeof msgIdMap !== 'undefined') { for (var k in msgIdMap) delete msgIdMap[k]; }
    showToast('已清屏', 'info');
});

// Status picker
var statusPicker = $('status-picker');
$('btn-status').addEventListener('click', function(e) {
    e.stopPropagation();
    statusPicker.style.display = statusPicker.style.display === 'none' ? 'block' : 'none';
    // 输入框预填当前状态
    $('status-custom').value = myStatus || '';
});
document.addEventListener('click', function(e) {
    if (!statusPicker.contains(e.target) && e.target !== $('btn-status')) {
        statusPicker.style.display = 'none';
    }
});
$('status-presets').addEventListener('click', function(e) {
    var el = e.target.closest('.status-preset');
    if (!el) return;
    var status = el.dataset.status;
    setMyStatus(status);
    statusPicker.style.display = 'none';
});
$('status-custom').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        setMyStatus(this.value.trim());
        statusPicker.style.display = 'none';
    }
});
$('status-clear').addEventListener('click', function() {
    setMyStatus('');
    statusPicker.style.display = 'none';
});

function setMyStatus(status) {
    myStatus = status;
    // 发送到服务器
    if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'user_status', status: status || '' }));
    }
    // 本地更新
    if (status) {
        userStatuses[nickname] = status;
    } else {
        delete userStatuses[nickname];
    }
    updateUserList(onlineUsers, null, userStatuses);
    if (status) {
        showToast('状态已设为: ' + status, 'success');
    } else {
        showToast('状态已清除', 'info');
    }
}

// Send message
sendBtn.addEventListener('click', function() {
    // ★ 被其他设备顶替后，这个按钮的语义是「重新连接」（主动抢回会话，会顶掉那台设备）。
    //   必须放在最前面判断：否则会走下面的 sendTextMessage 分支，表现成"按了没反应"。
    if (typeof supersededByOtherDevice !== 'undefined' && supersededByOtherDevice) {
        if (typeof takeOverSession === 'function') takeOverSession();
        return;
    }
    if (typeof isOffline === 'function' && isOffline()) {
        if (typeof tryReconnect === 'function') tryReconnect();
    } else {
        sendTextMessage();
    }
});
msgInput.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key !== 'Enter') return;
    var sendMode = localStorage.getItem('chatroom-send-mode') || 'enter';
    var shouldSend = (sendMode === 'ctrl' && e.ctrlKey) ||
                     (sendMode === 'enter' && !e.ctrlKey);
    // 需要手动换行的情形：enter 模式下 Ctrl+Enter，或 ctrl 模式下 Enter（浏览器默认行为可能被某些环境阻止）
    var shouldBreak = (sendMode === 'ctrl' && !e.ctrlKey) ||
                      (sendMode === 'enter' && e.ctrlKey);
    if (shouldSend) {
        e.preventDefault();
        sendTextMessage();
    } else if (shouldBreak) {
        e.preventDefault();
        var ta = msgInput;
        var start = ta.selectionStart;
        ta.setRangeText('\n', start, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
});
// Auto-resize textarea
msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    sendTyping();
});

// 粘贴图片支持：Ctrl+V 图片时自动上传
msgInput.addEventListener('paste', (e) => {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') === 0) {
            e.preventDefault();
            var blob = items[i].getAsFile();
            var ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            var ext = items[i].type.split('/')[1] || 'png';
            var file = new File([blob], 'paste_' + ts + '.' + ext, { type: items[i].type });
            if (typeof uploadFile === 'function') uploadFile(file);
            return;
        }
    }
});

/* ======================================================================
 * @ 补全（**仅在线用户**）—— 双端通用
 *   输入 @（或 @ + 前缀）→ 在输入框上方列出在线用户；↑/↓ 选择、Enter/Tab 或点选接受、Esc 关闭。
 *   ⚠️ keydown 必须挂在**捕获阶段**：既有的「Enter 发送」监听器在冒泡阶段，
 *      否则面板开着时按 Enter 会先把消息发出去，而不是接受补全。
 * ====================================================================== */
var MP_MAX = 8;
var mpActive = null;                 // 当前高亮的昵称

function mpEl() {
    var el = document.getElementById('mention-picker');
    if (!el) { el = document.createElement('div'); el.id = 'mention-picker'; document.body.appendChild(el); }
    return el;
}

/** 当前光标处是否处于 @token 中；返回 {start,end,query} 或 null */
function mpToken() {
    if (!msgInput) return null;
    var caret = msgInput.selectionStart;
    if (caret === null || caret === undefined) return null;
    var v = msgInput.value || '';
    var at = v.lastIndexOf('@', caret - 1);
    if (at < 0) return null;
    if (at > 0 && !/[\s\n]/.test(v.charAt(at - 1))) return null;   // @ 必须处在"词首"（行首或空白之后）
    var seg = v.slice(at + 1, caret);
    if (/[\s\n@]/.test(seg)) return null;                          // 中间出现空白 / 另一个 @ 就不算
    return { start: at, end: caret, query: seg };
}

/** 候选：**仅在线用户**、排除自己；前缀优先、其次包含 */
function mpCandidates(q) {
    var list = (typeof onlineUsers !== 'undefined' && onlineUsers) ? onlineUsers.slice() : [];
    list = list.filter(function(n) { return n && n !== nickname; });
    if (q) {
        var ql = q.toLowerCase(), pre = [], sub = [];
        list.forEach(function(n) {
            var i = String(n).toLowerCase().indexOf(ql);
            if (i === 0) pre.push(n); else if (i > 0) sub.push(n);
        });
        list = pre.concat(sub);
    }
    return list.slice(0, MP_MAX);
}

function mpHide() {
    var el = document.getElementById('mention-picker');
    if (el) { el.classList.remove('visible'); el.innerHTML = ''; }
    mpActive = null;
}

/** 面板定位：贴在输入框上方（放不下就放下面），并夹在视口内 */
function mpPlace(el) {
    var r = msgInput.getBoundingClientRect();
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w));
    var top = r.top - h - 6;
    if (top < 8) top = Math.min(window.innerHeight - 8 - h, r.bottom + 6);
    el.style.left = left + 'px';
    el.style.top = Math.max(8, top) + 'px';
}

function mpMark() {
    var el = document.getElementById('mention-picker');
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('.mp-item'), function(item) {
        item.classList.toggle('active', item.dataset.nick === mpActive);
    });
}

/** 输入 / 光标变化时调用：决定是否显示面板、显示哪些候选 */
function mpUpdate() {
    var tok = mpToken();
    if (!tok) { mpHide(); return; }
    var cands = mpCandidates(tok.query);
    var el = mpEl();
    if (!cands.length) {
        el.innerHTML = '<div class="mp-empty">没有匹配的在线用户</div>';
        el.classList.add('visible');
        mpActive = null;
        mpPlace(el);
        return;
    }
    el.innerHTML = cands.map(function(n) {
        var tag = '';
        try { tag = roleTagHtml(n); } catch (e) { }
        return '<div class="mp-item" data-nick="' + esc(n) + '">' +
               '<span class="mp-at">@</span><span>' + esc(n) + '</span>' + tag + '</div>';
    }).join('');
    el.classList.add('visible');
    mpActive = cands[0];
    mpMark();
    mpPlace(el);
    // 点选：用 mousedown/touchstart 并阻止默认 —— 否则输入框会先失焦，面板被 blur 收起，点不中
    Array.prototype.forEach.call(el.querySelectorAll('.mp-item'), function(item) {
        var nick = item.dataset.nick;
        item.addEventListener('mousedown', function(e) { e.preventDefault(); mpAccept(nick); });
        item.addEventListener('touchstart', function(e) { e.preventDefault(); mpAccept(nick); }, { passive: false });
    });
}

/** 接受候选：把 @query 换成「@昵称 + 空格」，光标移到其后 */
function mpAccept(nick) {
    if (!nick) return;
    var tok = mpToken();
    if (!tok) { mpHide(); return; }
    var v = msgInput.value || '';
    var insert = '@' + nick + ' ';
    msgInput.value = v.slice(0, tok.start) + insert + v.slice(tok.end);
    var pos = tok.start + insert.length;
    try { msgInput.setSelectionRange(pos, pos); } catch (e) { }
    mpHide();
    try { msgInput.focus(); } catch (e) { }
}

function mpMove(step) {
    var tok = mpToken();
    if (!tok) return;
    var cands = mpCandidates(tok.query);
    if (!cands.length) return;
    var i = cands.indexOf(mpActive);
    if (i < 0) i = 0;
    mpActive = cands[(i + step + cands.length) % cands.length];
    mpMark();
    var el = document.getElementById('mention-picker');
    var act = el && el.querySelector('.mp-item.active');
    if (act && act.scrollIntoView) { try { act.scrollIntoView({ block: 'nearest' }); } catch (e) { act.scrollIntoView(false); } }
}

msgInput.addEventListener('input', mpUpdate);
msgInput.addEventListener('click', mpUpdate);
msgInput.addEventListener('keyup', function(e) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) >= 0) mpUpdate();
});
msgInput.addEventListener('blur', function() { setTimeout(mpHide, 180); });
var _mpSendBtn = document.getElementById('send-btn');
if (_mpSendBtn) _mpSendBtn.addEventListener('click', function() { setTimeout(mpUpdate, 0); });   // 发送后 value 被清空，收起面板

// ★ 捕获阶段：抢在「Enter 发送」之前处理 ↑↓ / Enter / Tab / Esc
msgInput.addEventListener('keydown', function(e) {
    var el = document.getElementById('mention-picker');
    if (!el || !el.classList.contains('visible')) return;
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); mpMove(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); mpMove(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
        if (mpActive) { e.preventDefault(); e.stopPropagation(); mpAccept(mpActive); }
        else { mpHide(); }        // 没有候选 → 交回原来的逻辑（发送 / 换行）
        return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); mpHide(); return; }
}, true);

function updateSendPlaceholder() {
    var mode = localStorage.getItem('chatroom-send-mode') || 'enter';
    msgInput.placeholder = mode === 'ctrl'
        ? '输入消息... (Ctrl+Enter 发送, Enter 换行)'
        : '输入消息... (Enter 发送, Ctrl+Enter 换行)';
}

// ==================== Markdown Toolbar ====================
function initMdToolbar() {
    var mdMap = {
        bold:      { wrap: '**', label: '加粗文字' },
        italic:    { wrap: '*',  label: '斜体文字' },
        strike:    { wrap: '~~', label: '删除线' },
        code:      { wrap: '`',  label: '代码' },
        math:      { wrap: '$',  label: '公式' },
        mathblock: { prefix: '$$\n', suffix: '\n$$', label: '块级公式' },
        link:      { prefix: '[', suffix: '](url)', label: '链接文字' },
        ul:        { prefix: '- ', label: '', newline: true },
        ol:        { prefix: '1. ', label: '', newline: true },
        quote:     { prefix: '> ', label: '', newline: true }
    };
    // 折叠/展开切换
    var tbBtns = document.getElementById('md-toolbar-btns');
    var tbToggle = document.getElementById('btn-md-toggle');
    var tbCollapsed = localStorage.getItem('md-toolbar-collapsed') === '1';
    function applyCollapse() {
        tbBtns.style.display = tbCollapsed ? 'none' : 'flex';
        tbToggle.textContent = tbCollapsed ? '▶' : '▼';
    }
    applyCollapse();
    tbToggle.addEventListener('click', function() {
        tbCollapsed = !tbCollapsed;
        localStorage.setItem('md-toolbar-collapsed', tbCollapsed ? '1' : '0');
        applyCollapse();
    });
    // 格式按钮
    document.querySelectorAll('#md-toolbar-btns .md-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var md = mdMap[this.dataset.md];
            if (!md) return;
            var ta = msgInput;
            var start = ta.selectionStart;
            var end = ta.selectionEnd;
            var text = ta.value;
            var sel = text.substring(start, end);
            if (md.newline) {
                // 列表/引用：在行首插入，自动换行
                var before = text.lastIndexOf('\n', start - 1);
                var lineStart = before >= 0 ? before + 1 : 0;
                ta.setRangeText(md.prefix, lineStart, lineStart, 'end');
            } else if (md.prefix) {
                // 链接等不对称包裹
                var insert = md.prefix + (sel || md.label) + md.suffix;
                ta.setRangeText(insert, start, end, 'end');
                if (!sel) ta.setSelectionRange(start + md.prefix.length, start + md.prefix.length + md.label.length);
            } else if (sel) {
                // 有选中文字：toggle 包裹
                var bare = sel;
                if (sel.startsWith(md.wrap) && sel.endsWith(md.wrap) && sel.length >= md.wrap.length * 2) {
                    bare = sel.slice(md.wrap.length, -md.wrap.length);
                    ta.setRangeText(bare, start, end, 'end');
                } else {
                    ta.setRangeText(md.wrap + sel + md.wrap, start, end, 'end');
                }
            } else {
                // 无选中：插入包裹符，光标置中
                ta.setRangeText(md.wrap + md.wrap, start, end, 'start');
                ta.setSelectionRange(start + md.wrap.length, start + md.wrap.length);
            }
            ta.focus();
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        });
    });
    // 快捷键 Ctrl+B / Ctrl+I
    msgInput.addEventListener('keydown', function(e) {
        if (e.isComposing) return;
        var mdBtn = null;
        if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); mdBtn = document.querySelector('.md-btn[data-md="bold"]'); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); mdBtn = document.querySelector('.md-btn[data-md="italic"]'); }
        if (mdBtn) mdBtn.click();
    });
    // ===== Math Symbol Panel =====
    initSymbolPanel();
}

// ==================== Math Symbol Panel ====================
var mathSymbols = [
    // Greek lowercase
    { d: 'α', t: '\\alpha' }, { d: 'β', t: '\\beta' }, { d: 'γ', t: '\\gamma' },
    { d: 'δ', t: '\\delta' }, { d: 'ε', t: '\\epsilon' }, { d: 'θ', t: '\\theta' },
    { d: 'λ', t: '\\lambda' }, { d: 'μ', t: '\\mu' }, { d: 'π', t: '\\pi' },
    { d: 'σ', t: '\\sigma' }, { d: 'φ', t: '\\phi' }, { d: 'ω', t: '\\omega' },
    // Greek uppercase
    { d: 'Δ', t: '\\Delta' }, { d: 'Γ', t: '\\Gamma' }, { d: 'Ω', t: '\\Omega' },
    // Operators
    { d: '∑', t: '\\sum' }, { d: '∏', t: '\\prod' },
    { d: '∫', t: '\\int' }, { d: '∬', t: '\\iint' },
    { d: '√', t: '\\sqrt{}' }, { d: '∂', t: '\\partial' },
    { d: '∇', t: '\\nabla' }, { d: '∞', t: '\\infty' },
    { d: 'lim', t: '\\lim_{x \\to }{}' },
    // Relations
    { d: '≤', t: '\\le' }, { d: '≥', t: '\\ge' }, { d: '≠', t: '\\ne' },
    { d: '≈', t: '\\approx' }, { d: '≡', t: '\\equiv' },
    { d: '±', t: '\\pm' }, { d: '∓', t: '\\mp' },
    // Sets & logic
    { d: '∈', t: '\\in' }, { d: '∉', t: '\\notin' },
    { d: '∪', t: '\\cup' }, { d: '∩', t: '\\cap' },
    { d: '⊂', t: '\\subset' }, { d: '⊆', t: '\\subseteq' },
    { d: '∀', t: '\\forall' }, { d: '∃', t: '\\exists' },
    { d: '∅', t: '\\emptyset' }, { d: '∁', t: '\\complement' },
    // Arrows & misc
    { d: '→', t: '\\to' }, { d: '⇒', t: '\\Rightarrow' },
    { d: '↔', t: '\\leftrightarrow' }, { d: '⇔', t: '\\Leftrightarrow' },
    { d: '×', t: '\\times' }, { d: '÷', t: '\\div' },
    { d: '·', t: '\\cdot' }, { d: '∘', t: '\\circ' },
    { d: '…', t: '\\dots' }, { d: '∥', t: '\\parallel' },
    { d: '⊥', t: '\\perp' }, { d: '∠', t: '\\angle' },
    // Brackets
    { d: '⌈⌉', t: '\\lceil \\rceil' }, { d: '⌊⌋', t: '\\lfloor \\rfloor' },
    { d: '⎧⎨⎩', t: '\\begin{cases}\n\\\\\n\\end{cases}' },
    // Matrix
    { d: '⎡⎤', t: '\\begin{pmatrix}\n & \\\\\n & \n\\end{pmatrix}' },
];

function initSymbolPanel() {
    var panel = document.getElementById('symbol-panel');
    if (!panel) return;
    // Build symbol buttons
    mathSymbols.forEach(function(s) {
        var btn = document.createElement('button');
        btn.className = 'sym-btn';
        btn.textContent = s.d;
        btn.title = s.t;
        btn.addEventListener('click', function() { insertSymbol(s.t); });
        panel.appendChild(btn);
    });
    // Toggle panel
    var toggleBtn = document.getElementById('btn-symbol-panel');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function() {
            var isOpen = panel.style.display !== 'none';
            panel.style.display = isOpen ? 'none' : 'flex';
            this.classList.toggle('active', !isOpen);
        });
    }
    // Close on Escape
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && panel.style.display !== 'none') {
            panel.style.display = 'none';
            var tb = document.getElementById('btn-symbol-panel');
            if (tb) tb.classList.remove('active');
        }
    });
}

function insertSymbol(code) {
    var ta = msgInput;
    var start = ta.selectionStart;
    var end = ta.selectionEnd;
    // Check if we should strip outer $ for inline replacements
    var text = ta.value;
    var sel = text.substring(start, end);
    // If selection is wrapped in $...$, strip and insert code directly (for replacement)
    if (sel.startsWith('$') && sel.endsWith('$') && sel.length >= 2) {
        code = sel.slice(1, -1).trim() ? code : code; // keep code if sel is just $$
    }
    ta.setRangeText(code, start, end, 'end');
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function sendTextMessage() {
    if (isOffline()) { showToast('连接已断开，请先重连', 'error'); return; }
    const text = msgInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    let msg;
    if (replyTo) {
        msg = { type: 'chat', nickname: nickname, content: text, msgId: Date.now() + '_' + Math.random(), quote: replyTo.content, quoteNick: replyTo.nickname };
        replyTo = null;
        msgInput.placeholder = '输入消息... (支持 Markdown)';
    } else {
        msg = { type: 'chat', nickname: nickname, content: text, msgId: Date.now() + '_' + Math.random() };
    }

    try {
        ws.send(JSON.stringify(msg));
    } catch (e) {
        showToast('消息发送失败，请重试', 'error');
        return; // 保留输入框内容，不清空
    }
    msgInput.value = '';
    msgInput.style.height = 'auto';
}

// User list click
// ==================== 用户操作菜单（用户列表左键/右键共用，与聊天区右键一致） ====================
function openUserActionMenu(nick, x, y) {
    if (!nick || nick === nickname) return;
    // 手机上先把用户抽屉关掉：抽屉 z-index(620) 比菜单高，不关的话菜单会被抽屉/遮罩盖住，
    // 用户根本点不到「@ 提及 / 私聊」（2026-09-24 实测：菜单中心最上层元素是 user-list）。
    closeUserDrawer();
    contextTarget = { nickname: nick };
    selectedMsg = { nickname: nick, type: 'user' };
    const q = function (a) { return contextMenu.querySelector('[data-action="' + a + '"]'); };
    const recallItem = q('recall'), pmItem = q('private-chat'), muteItem = q('mute');
    const replyItem = q('reply'), copyItem = q('copy'), atItem = q('at-mention');
    if (recallItem) recallItem.style.display = 'none';                 // 不是自己的消息
    const isOnline = typeof onlineUsers !== 'undefined' && onlineUsers.indexOf(nick) !== -1;
    if (pmItem) {
        pmItem.style.display = '';
        pmItem.style.opacity = '1';                       // P0-④：离线也能发（服务端落盘 + 上线补投）
        pmItem.textContent = isOnline ? '🔒 私聊' : '🔒 私聊（离线，上线后送达）';
    }
    if (muteItem) {
        muteItem.style.display = '';
        muteItem.textContent = mutedUsers.has(nick) ? '🔊 取消静音' : '🔇 静音';
    }
    if (replyItem) replyItem.style.display = 'none';
    if (copyItem) copyItem.style.display = 'none';
    if (atItem) atItem.style.display = '';
    // 位置与聊天区右键一致：跟随坐标并夹在视口内
    contextMenu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
    contextMenu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
    contextMenu.classList.add('visible');
}

userList.addEventListener('click', e => {
    // ⓪ 手机端行内的「@ / 私聊」快捷按钮：一击直达，不走菜单（桌面端这两个按钮被 CSS 隐藏）
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
        const row = actBtn.closest('.user-item');
        const target = row ? row.dataset.nickname : null;
        if (target && target !== nickname) {
            e.stopPropagation();
            contextMenu.classList.remove('visible');
            if (actBtn.dataset.act === 'at') {
                mentionUser(target);
            } else if (actBtn.dataset.act === 'pm') {
                closeUserDrawer();
                openPrivateChat(target);
            }
        }
        return;
    }
    const item = e.target.closest('.user-item');
    if (!item) return;
    const target = item.dataset.nickname;
    if (target === nickname) return;
    if (e.detail === 2) {
        // 双击：@提及（并收起菜单）
        contextMenu.classList.remove('visible');
        msgInput.value += '@' + target + ' ';
        msgInput.focus();
        return;
    }
    // 单击：弹出与聊天区右键一致的菜单（私聊 / 静音 / @提及）
    e.stopPropagation();          // 否则会被文档级 click 立刻关掉
    openUserActionMenu(target, e.clientX, e.clientY);
});

userList.addEventListener('contextmenu', e => {
    const item = e.target.closest('.user-item');
    if (!item || item.dataset.nickname === nickname) return;
    e.preventDefault();
    openUserActionMenu(item.dataset.nickname, e.clientX, e.clientY);   // 与单击同一套菜单
});

// ==================== Utility ====================
function showToast(msg, type) {
    toast.textContent = msg;
    toast.className = type || 'info';
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.remove('show'), 2500);
}

function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatTime() {
    const d = new Date();
    return d.getHours().toString().padStart(2, '0') + ':' +
           d.getMinutes().toString().padStart(2, '0') + ':' +
           d.getSeconds().toString().padStart(2, '0');
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

// ==================== Mute ====================
function toggleMute(targetNick) {
    if (mutedUsers.has(targetNick)) {
        mutedUsers.delete(targetNick);
        showToast('已取消静音 ' + targetNick, 'info');
    } else {
        mutedUsers.add(targetNick);
        showToast('已静音 ' + targetNick + '（仅对你生效）', 'info');
    }
    localStorage.setItem('mutedUsers', JSON.stringify([...mutedUsers]));
    // Remove hidden class from existing messages
    document.querySelectorAll('.muted-msg[data-nickname="' + CSS.escape(targetNick) + '"]').forEach(el => {
        if (mutedUsers.has(targetNick)) el.classList.add('hidden');
        else el.classList.remove('hidden');
    });
}

function isMuted(targetNick) {
    return mutedUsers.has(targetNick);
}

// ==================== Notification Sound ====================
let audioCtx = null;
function playNotify() {
    if (notifyVolume <= 0) return;
    if (document.hasFocus()) return;
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.type = 'sine';
        gain.gain.value = notifyGain();
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.3);
    } catch(e) {}
}

// ==================== Typing Indicator ====================
function sendTyping() {
    if (!ws || ws.readyState !== WebSocket.OPEN || isOffline()) return;
    if (typingTimer) return;
    typingTimer = setTimeout(() => {
        typingTimer = null;
    }, 2000);
    ws.send(JSON.stringify({ type: 'typing', nickname: nickname }));
}

function showTyping(fromNick) {
    if (fromNick === nickname) return;
    typingUsers[fromNick] = Date.now();
    updateTypingDisplay();
    clearTimeout(typingUsers._timeout);
    typingUsers._timeout = setTimeout(clearStaleTyping, 3000);
}

function clearStaleTyping() {
    const now = Date.now();
    let changed = false;
    for (const [nick, ts] of Object.entries(typingUsers)) {
        if (nick.startsWith('_')) continue;
        if (now - ts > 3000) { delete typingUsers[nick]; changed = true; }
    }
    if (changed) updateTypingDisplay();
    if (Object.keys(typingUsers).filter(k => !k.startsWith('_')).length > 0) {
        typingUsers._timeout = setTimeout(clearStaleTyping, 2000);
    }
}

function updateTypingDisplay() {
    // Typing status is now shown in the user list; just refresh it
    updateUserList(onlineUsers, null);
}

// Update user list
let onlineUsers = [];

// 供其他模块调用的状态更新（window 作用域，跨文件可访问）
window.setUserStatus = function(nick, key, active) {
    if (!_userStatuses[nick]) _userStatuses[nick] = {};
    if (active) { _userStatuses[nick][key] = true; }
    else { delete _userStatuses[nick][key]; if (Object.keys(_userStatuses[nick]).length === 0) delete _userStatuses[nick]; }
    updateUserList(onlineUsers, null);
};
window.clearAllUserStatuses = function(key) {
    for (var nick in _userStatuses) {
        delete _userStatuses[nick][key];
        if (Object.keys(_userStatuses[nick]).length === 0) delete _userStatuses[nick];
    }
    updateUserList(onlineUsers, null);
};

function _statusIcon(nick) {
    var st = _userStatuses[nick];
    if (!st) return '';
    var icons = [];
    if (st.call)   icons.push('<span title="视频通话中" style="font-size:11px">📞</span>');
    if (st.voice)  icons.push('<span title="语音通话中" style="font-size:11px">🎙️</span>');
    if (st.music)  icons.push('<span title="听歌房中" style="font-size:11px">🎵</span>');
    if (st.screen) icons.push('<span title="屏幕共享中" style="font-size:11px">🖥️</span>');
    if (st.typing) icons.push('<span class="typing-dots">...</span>');
    return ' ' + icons.join('');
}

var userStatuses = {};
var myStatus = '';

// ==================== 用户角色（管理员 / 机器人 / 普通） ====================
// 角色由服务端在 userlist 消息里下发（msg.roles: nickname -> 'admin' | 'bot'）
var roleMap = {};
var ROLE_META = {
    admin: { tag: '👑', label: '管理员', cls: 'role-admin' },
    bot: { tag: '🤖', label: '机器人', cls: 'role-bot' }
};
function roleOf(nick) { return (roleMap && roleMap[nick]) || ''; }
function roleTagHtml(nick) {
    var r = roleOf(nick);
    var meta = ROLE_META[r];
    if (!meta) return '';
    return ' <span class="role-tag role-tag-' + r + '" title="' + meta.label + '">' + meta.tag + ' ' + meta.label + '</span>';
}
function applyRoles(map) {
    if (!map) return;
    roleMap = map;
    try { updateUserList(onlineUsers, null, userStatuses); } catch (e) { }
}

// ==================== 用户列表排序（管理员 → 机器人 → 普通；组内按首字母/拼音） ====================
var ROLE_ORDER = { admin: 0, bot: 1 };
function roleWeight(nick) {
    var r = roleOf(nick);
    return (r && (r in ROLE_ORDER)) ? ROLE_ORDER[r] : 2;   // 普通用户 = 2
}
function sortUsers(list) {
    var arr = (list || []).slice();
    try {
        arr.sort(function (a, b) {
            var wa = roleWeight(a), wb = roleWeight(b);
            if (wa !== wb) return wa - wb;                 // 先按角色分组
            var sa = String(a), sb = String(b);
            try {
                // 中文按拼音（ICU 排序），英文按字母；sensitivity:base 忽略大小写与音调
                return sa.localeCompare(sb, 'zh-Hans-CN', { sensitivity: 'base', numeric: true });
            } catch (e) {
                return sa < sb ? -1 : (sa > sb ? 1 : 0);
            }
        });
    } catch (e) { }
    return arr;
}

// 与后端 UserManager.isPasswordAcceptable 保持一致：6-18 位，不含空白与冒号
function isPwdAcceptable(pwd) {
    if (!pwd) return false;
    var n = pwd.length;
    if (n < 6 || n > 18) return false;
    return !/[\s:]/.test(pwd);
}
function pwdRuleMessage() { return '密码需 6-18 位，且不含空格与冒号'; }

/** 手机端用户行右侧的「@ / 私聊」快捷按钮（桌面端由 CSS 隐藏，仍走原来的单击/右键菜单） */
function pmRowActions(u) {
    var wrap = document.createElement('span');
    wrap.className = 'user-row-actions';
    wrap.innerHTML = '<button type="button" data-act="at" title="提及 ' + esc(u) + '">@</button>' +
                     '<button type="button" data-act="pm" title="私聊 ' + esc(u) + '">🔒</button>';
    return wrap;
}

function updateUserList(users, offlineUsers, statuses) {
    onlineUsers = users || [];
    const offline = offlineUsers || [];
    if (statuses) userStatuses = statuses;
    userList.innerHTML = '';

    // 显示顺序：管理员 → 机器人 → 普通用户；组内按首字母（中文按拼音）
    const orderedOnline = sortUsers(onlineUsers);
    const orderedOffline = sortUsers(offline);

    orderedOnline.forEach(u => {
        const div = document.createElement('div');
        const _r = roleOf(u);
        div.className = 'user-item' + (_r ? ' ' + ROLE_META[_r].cls : '');
        div.title = _r ? ROLE_META[_r].label : '';
        div.dataset.nickname = u;
        var parts = [];
        parts.push('<span class="online-dot"></span>');
        parts.push(esc(u));
        parts.push(roleTagHtml(u));
        if (u === nickname) parts.push(' <span style="font-size:10px;opacity:0.5">(我)</span>');
        if (mutedUsers.has(u)) parts.push(' <span style="font-size:10px">🔇</span>');
        // 显示自定义状态
        if (userStatuses[u]) {
            parts.push(' <span class="user-status-badge">' + esc(userStatuses[u]) + '</span>');
        }
        parts.push(_statusIcon(u));
        parts.push(pmBadgeHtml(u));      // P0-④：未读私聊角标
        div.innerHTML = parts.join('');
        div.appendChild(pmRowActions(u));   // 手机端行内 @ / 私聊 按钮（桌面端 CSS 隐藏）
        userList.appendChild(div);
    });

    orderedOffline.forEach(u => {
        const div = document.createElement('div');
        const _ro = roleOf(u);
        div.className = 'user-item offline' + (_ro ? ' ' + ROLE_META[_ro].cls : '');
        div.dataset.nickname = u;
        div.style.opacity = '0.5';
        div.innerHTML = `<span class="online-dot" style="background:#999"></span>${esc(u)}${roleTagHtml(u)} <span style="font-size:10px;color:var(--text-muted);margin-left:4px">离线</span>` + pmBadgeHtml(u);
        div.appendChild(pmRowActions(u));
        userList.appendChild(div);
    });

    userCount.textContent = '(' + onlineUsers.length + ')';
    // 在线名单变了：@ 补全面板开着的话按新名单刷新（比如正在 @ 的人下线了）
    try {
        var _mp = document.getElementById('mention-picker');
        if (_mp && _mp.classList.contains('visible') && typeof mpUpdate === 'function') mpUpdate();
    } catch (e) { }
}

function onUserStatus(nick, status) {
    if (status) {
        userStatuses[nick] = status;
    } else {
        delete userStatuses[nick];
    }
    updateUserList(onlineUsers, null, userStatuses);
}

// 刷新 typing 状态到用户列表
var _origShowTyping = showTyping;
showTyping = function(fromNick) {
    _origShowTyping(fromNick);
    if (fromNick !== nickname) {
        window.setUserStatus(fromNick, 'typing', true);
        clearTimeout(_typingTimers[fromNick]);
        _typingTimers[fromNick] = setTimeout(function() {
            window.setUserStatus(fromNick, 'typing', false);
        }, 4000);
    }
};

// Music room drag
(function() {
    const panel = $('music-room');
    const header = $('music-room-header');
    let dragging = false, sx, sy, sl, st;
    header.addEventListener('pointerdown', e => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
        dragging = true;
        const r = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        panel.style.transition = 'none';
        e.preventDefault();
    });
    document.addEventListener('pointermove', e => {
        if (!dragging) return;
        panel.style.left = (sl + e.clientX - sx) + 'px';
        panel.style.top = (st + e.clientY - sy) + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    document.addEventListener('pointerup', () => {
        if (dragging) { dragging = false; panel.style.transition = ''; }
    });
})();


// ==================== 输入栏提示：按屏宽适配 ====================
// 手机软键盘没有 Ctrl，也没有"Enter 键"的说法 ⇒ 窄屏时换成简洁提示（桌面文案完全不变）
(function fixInputPlaceholder() {
    function apply() {
        try {
            var ta = document.getElementById('msg-input');
            if (!ta) return false;
            var phone = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
            if (phone) {
                ta.setAttribute('placeholder', '输入消息…（点右侧"发送"发送）');
                ta.setAttribute('title', '手机端：点"发送"按钮发送');
            } else {
                ta.setAttribute('placeholder', '输入消息... (Enter 发送, Ctrl+Enter 换行)');
                ta.setAttribute('title', 'Enter 发送，Ctrl+Enter 换行');
            }
            return true;
        } catch (e) { return false; }
    }
    if (!apply()) {
        document.addEventListener('DOMContentLoaded', apply);
    }
    try {
        var mq = window.matchMedia('(max-width: 768px)');
        if (mq.addEventListener) mq.addEventListener('change', apply);
        else if (mq.addListener) mq.addListener(apply);
    } catch (e) {}
})();
