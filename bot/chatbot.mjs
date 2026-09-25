// chatbot.mjs —— Uchat 里的 AI 用户（方案 A：以普通用户身份接入，服务端零改动）
//
// 运行：bun chatbot.mjs [--config bot_config.json] [--mock-llm] [--selftest]
// 依赖：仅 bun 内置（WebSocket / fetch / fs）—— 不需要任何第三方包
//
// 两种模式（可随时在聊天里切换）：
//   mention  —— 仅在被 @（或提到自己名字）时回复
//   ambient  —— 低频随机插话（概率 + 冷却控制），被 @ 时也回复
//
// 设计要点（都是踩过的坑）：
//   · 每条消息必须有唯一 msgId（服务端按 昵称|msgId 去重，10 分钟窗口）
//   · 服务端限流 10 条/秒且**静默丢弃** ⇒ 长回答必须切片、按间隔发送
//   · 不回自己的消息（防自循环）；全局/单会话都有冷却
//   · 断线自动重连（指数退避），并用 sync_since 补齐期间的消息
import fs from 'fs';
import path from 'path';

// ---------------- 配置 ----------------
const args = process.argv.slice(2);
function arg(name, def) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
}
const MOCK = args.includes('--mock-llm');
const SELFTEST = args.includes('--selftest');
const SELFTEST_MSG = arg('--selftest-msg', '');   // 自检时发什么（默认发 @ 消息；给普通消息可测 ambient 模式）
const NO_LOCK = args.includes('--no-lock');       // 忽略单实例锁（仅用于自检/联调）
const DUMP_PROMPT = args.includes('--dump-prompt'); // 把发往模型的 messages 写到 <BASE_DIR>/bot.prompt.json（调试上下文用）
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let CFG_PATH = arg('--config', '');
const BASE_DIR = path.resolve(arg('--base', HERE));   // 锁/状态文件所在目录（多实例用）
if (!CFG_PATH) {
    // 兼容两种文件名（有人习惯用记事本存成 .txt）
    for (const n of ['bot_config.json', 'bot_config.txt']) {
        const p = path.join(HERE, n);
        if (fs.existsSync(p)) { CFG_PATH = p; break; }
    }
    if (!CFG_PATH) {
        console.error('[BOT] 找不到配置：bot 目录下需要 bot_config.json 或 bot_config.txt');
        process.exit(1);
    }
}

let cfg;
try {
    cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
} catch (e) {
    console.error('[BOT] 读不到配置 ' + CFG_PATH + '：' + e.message);
    process.exit(1);
}
cfg = Object.assign({
    server: 'wss://127.0.0.1:8888/ws/chat',   // 服务地址（本机自签/域名证书不匹配时可保持 127.0.0.1）
    nickname: 'AI小助手',
    password: 'ai-bot-please-change',
    inviteFile: 'invite.pwd',                 // 注册码（首次注册用；与 Uchat 同目录）
    mode: 'mention',                          // mention | ambient | off
    ambientChance: 0.04,                      // ambient 模式：每条消息触发插话的概率
    ambientMinGapMs: 120000,                  // ambient：两次随机插话的最小间隔
    globalMinGapMs: 8000,                     // 任何回复之间的最小间隔
    maxPerMinute: 6,                          // 每分钟最多回复次数
    contextMessages: 30,                      // 带入模型的最近消息条数（v2.9.1 bot 侧：20→30）
    maxChunkChars: 180,                       // 单条消息最大字符数（超出则切片）
    chunkDelayMs: 1200,                       // 切片之间的间隔
    persona: '你是一个群聊里的 AI 助手。说话简短、口语化、不说教；不确定就直说不确定。',
    admin: '',                                // 可下达 /指令 的昵称（留空表示只有你能通过配置改）
    api: {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',              // DeepSeek-V4.1-Flash（官方名）
        temperature: 1.0,
        maxTokens: 800,
        timeoutMs: 45000,
        disableThinking: true                 // 先尝试关闭思考模式；不支持时自动回退重试
    }
}, cfg);

// API key 读取顺序：环境变量 → bot.pwd → dsapi.txt（bot 目录 / Uchat 根目录 / 桌面）
const KEY_CANDIDATES = [
    path.join(HERE, 'bot.pwd'),
    path.join(HERE, 'dsapi.txt'),
    path.join(HERE, '..', 'dsapi.txt'),
    path.join(HERE, '..', 'bot.pwd'),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop', 'dsapi.txt') : ''
].filter(Boolean);
// ==================== 登录密码（2026-09-25：不再写进仓库） ====================
// 取值顺序：bot_config.json 的 password → 环境变量 UCHAT_BOT_PASSWORD → 同目录 bot_login.pwd
// （公开仓库里的 bot_config.json 密码字段是空的；bot_login.pwd 已 gitignore）
function resolveBotPassword(c, here) {
    let pw = String((c && c.password) || '').trim();
    if (pw && pw !== 'CHANGE_ME') return pw;
    pw = String(process.env.UCHAT_BOT_PASSWORD || '').trim();
    if (pw) return pw;
    try {
        const f = path.join(here, 'bot_login.pwd');
        if (fs.existsSync(f)) return String(fs.readFileSync(f, 'utf8')).split(/\r?\n/)[0].trim();
    } catch (e) { }
    return '';
}
const BOT_PASSWORD = resolveBotPassword(cfg, HERE);
if (!BOT_PASSWORD) console.error('[BOT] 没有登录密码：设 UCHAT_BOT_PASSWORD 或写 bot\\bot_login.pwd，或填 bot_config.json 的 password');

let API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
let KEY_SOURCE = API_KEY ? 'environment' : '';
if (!API_KEY) {
    for (const f of KEY_CANDIDATES) {
        try {
            if (!fs.existsSync(f)) continue;
            const ls = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
            const want = Math.max(1, parseInt(cfg.apiKeyLine || 1, 10));
            const v = ls[want - 1] || '';
            if (v) { API_KEY = v; KEY_SOURCE = f + ' (第' + want + '行)'; break; }
        } catch (e) { }
    }
}
if (!MOCK && !API_KEY) {
    console.error('[BOT] 没有 API key：请把 key 写进 bot\\dsapi.txt 或 bot\\bot.pwd，或设环境变量 DEEPSEEK_API_KEY');
    process.exit(2);
}

const INVITE_FILE = path.isAbsolute(cfg.inviteFile) ? cfg.inviteFile : path.join(HERE, '..', cfg.inviteFile);
let INVITE = '';
try { if (fs.existsSync(INVITE_FILE)) INVITE = fs.readFileSync(INVITE_FILE, 'utf8').trim(); } catch (e) { }


// ---------------- 单实例锁（避免重复启动出两个 bot） ----------------
const LOCK_FILE = path.join(BASE_DIR, 'bot.lock');
try {
    if (!NO_LOCK) {
    if (fs.existsSync(LOCK_FILE)) {
        const rawLock = fs.readFileSync(LOCK_FILE, 'utf8').trim();
        const oldPid = parseInt(rawLock, 10);
        if (!oldPid || isNaN(oldPid)) {                       // 锁内容非法（空/被截断）⇒ 视为无锁
            try { fs.unlinkSync(LOCK_FILE); } catch (e) { }
        }
        if (oldPid && !isNaN(oldPid) && oldPid !== process.pid) {
            let alive = false;
            try { process.kill(oldPid, 0); alive = true; } catch (e) { alive = false; }
            if (alive) {
                console.log('[BOT] 已有一个 bot 在运行（PID ' + oldPid + '），本次退出。');
                process.exit(3);   // 3 = 已有实例（启动器据此也退出，避免 5 秒死循环）
            }
        }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    }
} catch (e) { }
const _cleanupLock = () => {
    try {
        if (fs.existsSync(LOCK_FILE) && fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch (e) { }
};
process.on('exit', _cleanupLock);
process.on('SIGINT', () => { _cleanupLock(); process.exit(0); });
process.on('SIGTERM', () => { _cleanupLock(); process.exit(0); });


// ---------------- 心跳（必须！否则空闲约 5 分钟会被服务端静默断开） ----------------
// 客户端协议：每 5 秒发 {type:'heartbeat'}，服务端回 heartbeat_ack；
// 连续 3 次没有收到任何帧 ⇒ 视为半开连接，主动重连（半开时不会触发 close 事件）。
let hbTimer = null;
let hbMiss = 0;
function startHeartbeat() {
    stopHeartbeat();
    hbMiss = 0;
    hbTimer = setInterval(() => {
        try {
            if (!ws || ws.readyState !== 1) return;
            ws.send(JSON.stringify({ type: 'heartbeat' }));
            hbMiss++;
            if (hbMiss === 1) log('心跳中（未响应计数=' + (hbMiss - 1) + '）');
            if (hbMiss >= 3) {
                log('心跳连续 ' + hbMiss + ' 次无响应，主动重连');
                stopHeartbeat();
                try { ws.close(); } catch (e) { }
                setTimeout(connect, 500);
            }
        } catch (e) { }
    }, 5000);
}
function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }

const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), '[BOT]', ...a);

// ---------------- 状态 ----------------
let ws = null;
let authed = false;
let reconnectDelay = 2000;
let myMode = cfg.mode;                    // 运行时可切换
try {
    if (fs.existsSync(STATE_FILE)) {
        const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (st && (st.mode === 'mention' || st.mode === 'ambient' || st.mode === 'off')) myMode = st.mode;
    }
} catch (e) { }
let lastReplyAt = 0;
let lastAmbientAt = 0;
const replyTimes = [];                    // 每分钟计数
const history = [];                       // {nick, text, ts}
let lastSeenTs = 0;
let lastAuthFailAt = 0;
let loginAt = 0;                       // 本次登录时刻（暖机用）
const WARMUP_MS = 8000;                // 登录后 8 秒内不响应触发（历史回放都在这个窗口）
const STALE_MS = 10 * 60 * 1000;       // 超过 10 分钟的消息不触发（回放的老消息）
const STATE_FILE = path.join(BASE_DIR, 'bot.state.json');
// ==== 上下文历史落盘（重启不丢）====
// 为什么需要：history 原来只在内存里，服务/守护一重启（或崩溃重启）就全清空 ⇒
// 机器人不记得自己刚说过什么，于是出现"你咋知道我不吃芹菜？"这种自相矛盾的回答。
const HISTORY_FILE = path.join(BASE_DIR, 'bot.history.json');
let historySaveTimer = null;
function pushHistory(h) {
    if (!h || !h.text) return;
    history.push(h);
    while (history.length > cfg.contextMessages * 6) history.shift();
    saveHistorySoon();
}
function pushHistoryDedup(h) {
    if (!h || !h.text) return;
    // 最近 6 条里出现过同样内容（同昵称、同 self 标记）⇒ 视为回放/补齐的重复，跳过
    const dup = history.slice(-6).some(x => x.text === h.text && !!x.self === !!h.self && x.nick === h.nick);
    if (dup) return;
    pushHistory(h);
}
function saveHistorySoon() {
    if (historySaveTimer) return;
    historySaveTimer = setTimeout(() => {
        historySaveTimer = null;
        try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-(cfg.contextMessages * 6)))); } catch (e) { }
    }, 1500);
}
function loadHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return;
        const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        if (!Array.isArray(arr)) return;
        for (const h of arr.slice(-(cfg.contextMessages * 6))) {
            if (h && typeof h.text === 'string' && h.text) {
                history.push({ nick: String(h.nick || ''), text: h.text, ts: Number(h.ts) || nowMs(), self: !!h.self });
            }
        }
        log('已载入历史 ' + history.length + ' 条（' + path.basename(HISTORY_FILE) + '）');
    } catch (e) { log('载入历史失败：' + (e && e.message)); }
}      // 鉴权失败退避（避免失败即重试的风暴）                       // sync_since 用（毫秒）
const pendingQueue = [];                  // 等待回复的任务（串行处理，避免并发抢答）
let processing = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowMs = () => Date.now();
const newMsgId = () => `${nowMs()}_${Math.random().toString(36).slice(2, 8)}`;

function isMentioned(text) {
    const t = (text || '');
    const name = cfg.nickname;
    if (t.includes('@' + name)) return true;
    // 若配置要求"必须 @"，则只认 @昵称（不因正文提到名字而触发）
    if (cfg.mentionRequiresAt) return false;
    return t.includes(name);
}

function cleanForModel(text) {
    // 去掉 @昵称 前缀，避免把 @ 也喂给模型
    return (text || '').replace(new RegExp('@' + cfg.nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').trim();
}

function saveMode() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ mode: myMode, savedAt: nowMs() })); } catch (e) { }
}

/** 消息是否"新鲜"（回放的老消息不触发；无 msgId 时放行） */
function isFresh(m) {
    const id = m && m.msgId;
    if (!id) return true;
    const ts = parseInt(String(id).split('_')[0], 10);
    if (!ts || isNaN(ts)) return true;
    return (nowMs() - ts) < STALE_MS;
}

function canReply() {
    const now = nowMs();
    if (now - lastReplyAt < cfg.globalMinGapMs) return false;
    while (replyTimes.length && now - replyTimes[0] > 60000) replyTimes.shift();
    return replyTimes.length < cfg.maxPerMinute;
}

// ---------------- WebSocket ----------------
function connect() {
    log('连接 ' + cfg.server + ' …');
    ws = new WebSocket(cfg.server, { tls: { rejectUnauthorized: false } });
    ws.addEventListener('open', () => {
        reconnectDelay = 2000;
        log('已连接，登录为 ' + cfg.nickname);
        ws.send(JSON.stringify({
            type: 'auth', subtype: 'login', nickname: cfg.nickname, content: BOT_PASSWORD
        }));
    });
    ws.addEventListener('message', (ev) => {
        let m = null;
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (e) { return; }
        handleFrame(m);
    });
    ws.addEventListener('close', () => {
        authed = false;
        stopHeartbeat();
        log('连接断开，' + Math.round(reconnectDelay / 1000) + ' 秒后重连');
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });
    ws.addEventListener('error', (e) => {
        log('连接错误：' + (e && e.message ? e.message : e) +
            '（若是证书错误，可把 server 改成你自己的域名地址）');
    });
}

function sendChat(text) {
    if (!authed || !ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: 'chat', nickname: cfg.nickname, content: text, msgId: newMsgId() }));
    return true;
}


/** 格式安全切片：优先在段落/换行/句末断开；绝不在 ``` 代码块或 $$ 公式内部切断 */
function splitSafely(text, maxChars) {
    const out = [];
    let rest = (text || '').trim();
    while (rest.length > maxChars) {
        let cut = -1;
        for (const sep of ['\n\n', '\n', '。', '！', '？', '；', ';', '.']) {
            const idx = rest.lastIndexOf(sep, maxChars);
            if (idx > maxChars * 0.4) { cut = idx + sep.length; break; }
        }
        if (cut <= 0) cut = maxChars;
        const head = rest.slice(0, cut);
        const fences = (head.match(/```/g) || []).length;
        if (fences % 2 === 1) {                          // 切在代码块内 ⇒ 退到围栏开始处
            const open = head.lastIndexOf('```');
            if (open > 0) cut = open;
        }
        const dollars = (head.match(/\$\$/g) || []).length;
        if (dollars % 2 === 1) {                         // 切在块级公式内
            const open = head.lastIndexOf('$$');
            if (open > 0) cut = open;
        }
        if (cut <= 20) cut = Math.min(maxChars, rest.length);
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.filter(Boolean);
}

async function sendSliced(text) {
    const parts = splitSafely(text, cfg.maxChunkChars);
    for (const p of parts) {
        if (!p) continue;
        sendChat(p);
        // ★ 关键：把自己的回复也记进上下文（标记 self=true ⇒ 组装时按 assistant 角色）
        //   不记的话，模型会把历史里每一条都当成"还没回答的问题"，从而重复作答。
        pushHistoryDedup({ nick: cfg.nickname, text: p, ts: nowMs(), self: true });
        replyTimes.push(nowMs());
        lastReplyAt = nowMs();
        await sleep(cfg.chunkDelayMs);
    }
}

function handleFrame(m) {
    hbMiss = 0;   // 收到任意帧即视为连接正常
    if (m.type === 'auth_resp') {
        if (m.subtype === 'ok') {
            authed = true;
            loginAt = nowMs();
            log('登录成功（模式=' + myMode + '，8 秒暖机中）');
            startHeartbeat();
            if (lastSeenTs) ws.send(JSON.stringify({ type: 'sync_since', nickname: cfg.nickname, content: String(lastSeenTs) }));
        } else {
            const reason = m.reason || '';
            log('登录失败：' + reason);
            // 退避：5 秒内不再重试（否则会瞬间打出几十次请求，服务端日志被刷爆）
            const _now = nowMs();
            if (_now - lastAuthFailAt < 5000) return;
            lastAuthFailAt = _now;
            if (/已存在|不存在|密码|注册/.test(reason)) {
                // 尚未注册 ⇒ 用注册码注册；注册码错则提示
                log('尝试注册（需 invite.pwd 里的注册码）…');
                ws.send(JSON.stringify({
                    type: 'auth', subtype: 'register', nickname: cfg.nickname,
                    content: BOT_PASSWORD, invite: INVITE
                }));
            }
        }
        return;
    }
    if (m.type === 'chat') {
        if (!m.content) return;
        if (m.nickname === cfg.nickname) {
            // 自己的消息：登录/重连时服务端会**回放历史**（含自己说过的）⇒ 按 assistant 记下来，
            // 否则重启后模型完全不记得自己的上一句。sendSliced 已经记过一次，这里去重。
            pushHistoryDedup({ nick: cfg.nickname, text: m.content, ts: nowMs(), self: true });
            return;
        }
        if (m.nickname) {
            log('收到聊天｜' + m.nickname + '：' + String(m.content).slice(0, 40));   // 收到聊天（诊断用）
            pushHistoryDedup({ nick: m.nickname, text: m.content, ts: nowMs() });
            consider(m);
        }
        return;
    }
    if (m.type === 'chat_ack') return;
    if (m.type === 'sync_result') {
        const list = m.history || m.messages || [];
        log('补齐历史 ' + (Array.isArray(list) ? list.length : 0) + ' 条（并入上下文）');
        // 断线期间漏掉的消息也进上下文，避免"中间断了就断片"
        if (Array.isArray(list)) {
            for (const raw of list) {
                try {
                    const mm = (typeof raw === 'string') ? JSON.parse(raw) : raw;
                    if (!mm || !mm.content || !mm.nickname) continue;
                    if (mm.nickname === cfg.nickname) pushHistoryDedup({ nick: cfg.nickname, text: mm.content, ts: nowMs(), self: true });
                    else pushHistoryDedup({ nick: mm.nickname, text: mm.content, ts: nowMs() });
                } catch (e) { }
            }
        }
    }
}

// ---------------- 触发判断 ----------------
function consider(m) {
    lastSeenTs = nowMs();
    if (loginAt && (nowMs() - loginAt) < WARMUP_MS) return;      // 暖机期：回放内容一律不响应
    if (!isFresh(m)) return;                                     // 老消息不回（重连回放）
    const text = m.content || '';

    // 管理员指令（仅配置里的 admin 生效）
    if (cfg.admin && m.nickname === cfg.admin) {
        if (isMentioned(text)) {
            if (/关闭|off|闭嘴|安静/.test(text)) { myMode = 'off'; saveMode(); sendChat('好，我先不说话（要唤醒就 @我 mention）'); return; }
            if (/mention|只回|仅@/.test(text)) { myMode = 'mention'; saveMode(); sendChat('好，以后只在你 @ 我的时候回复'); return; }
            if (/ambient|随机|插话/.test(text)) { myMode = 'ambient'; saveMode(); sendChat('好，切成低频随机插话模式'); return; }
            if (/状态|status/.test(text)) { sendChat(`当前模式：${myMode}｜每分钟上限 ${cfg.maxPerMinute}｜上下文 ${cfg.contextMessages} 条`); return; }
        }
    }
    if (myMode === 'off') return;

    if (isMentioned(text)) { queueReply(m, 'mention'); return; }

    if (myMode === 'ambient') {
        const t = nowMs();
        if (t - lastAmbientAt < cfg.ambientMinGapMs) return;
        if (Math.random() < cfg.ambientChance) { lastAmbientAt = t; queueReply(m, 'ambient'); }
    }
}

function queueReply(m, why) {
    if (!canReply()) { log('（冷却中，跳过 ' + why + '）'); return; }
    if (pendingQueue.length > 2) return;
    pendingQueue.push({ m, why });
    if (!processing) processQueue();
}

async function processQueue() {
    processing = true;
    processingSince = nowMs();
    try {
        while (pendingQueue.length) {
            const { m, why } = pendingQueue.shift();
            log('回复触发（' + why + '）来自 ' + m.nickname + '：' + (m.content || '').slice(0, 40));
            log('开始生成回复（' + why + '）');
            const reply = await withHardTimeout(askModel(m, why), (cfg.api.timeoutMs || 45000) + 10000);
            if (reply === null) log('模型调用超时/失败，本条放弃（队列继续）');
            if (reply) { await sendSliced(reply); log('已回复 ' + reply.length + ' 字'); }
        }
    } catch (e) {
        log('处理队列异常：' + e.message);
    }
    processing = false;
}

// ---------------- 硬超时包装 ----------------
// 目的：即便 fetch 既不成功也不失败（网络半开等），也保证队列不会永久卡住。
// 返回 null 表示超时（调用方据此放弃本条并继续处理队列）。
function withHardTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(null), ms))
    ]).catch(() => null);
}

// ---------------- 模型调用 ----------------
async function askModel(m, why) {
    const mockReply = MOCK
        ? ('[MOCK] 收到你的消息了：' + cleanForModel(m.content).slice(0, 60) + '。这是一条模拟回复，用于验证链路（未调用真实模型）。')
        : null;
    // 上下文锚点：显式把"我最近说过什么 / 对方最近说什么"写进 system，
    // 模型不必从几十条交错对话里自己找 —— 这是"记得自己上一句"的最有效手段。
    const lastSelf = [...history].reverse().find(h => h.self && h.text);
    const lastOther = [...history].reverse().find(h => !h.self && h.text);
    const sys = cfg.persona +
        `\n\n当前模式：${why === 'mention' ? '有人 @ 你' : '你在随机插话'}。` +
        `\n【格式】中文；2~4 句；不要用 markdown 标题；不要自我介绍；不要复述别人刚说过的话。` +
        `\n【上下文一致性（重要）】你要记得自己刚说过什么，并与之保持一致：` +
        `如果对方是在回应或追问你上一句，必须顺着自己的立场继续聊；` +
        `**绝不能否认自己刚说过的话**（不要说"我什么时候说过""你咋知道""我没说过"这类）。` +
        (lastSelf ? `\n你（${cfg.nickname}）最近说过：「${String(lastSelf.text).slice(0, 120)}」` : '') +
        (lastOther ? `\n对方（${lastOther.nick}）最近说：「${String(lastOther.text).slice(0, 120)}」` : '') +
        `\n【只答最后一条】针对对话里【最后一条】回复；若最后一条是对你上一句的回应，就接着上文，` +
        `不要重新回答更早的问题（但也要避免前后矛盾）。`;
    const msgs = [{ role: 'system', content: sys }];
    for (const h of history.slice(-cfg.contextMessages)) {
        if (h.self) msgs.push({ role: 'assistant', content: h.text });
        else msgs.push({ role: 'user', content: `${h.nick}：${h.text}` });
    }
    if (msgs.length === 1) msgs.push({ role: 'user', content: cleanForModel(m.content) });
    if (DUMP_PROMPT) {
        try {
            fs.writeFileSync(path.join(BASE_DIR, 'bot.prompt.json'), JSON.stringify({
                at: new Date().toISOString(), why, triggerNick: m.nickname, trigger: m.content,
                historyLen: history.length, messages: msgs
            }, null, 1));
            log('已 dump prompt（' + msgs.length + ' 条 messages，history=' + history.length + '）→ bot.prompt.json');
        } catch (e) { log('dump prompt 失败：' + (e && e.message)); }
    }

    // MOCK 模式：上下文已构建并 dump 完毕（上面），这里直接返回模拟回复，不调真实模型
    if (MOCK) return mockReply;

    const body = {
        model: cfg.api.model,
        messages: msgs,
        temperature: cfg.api.temperature,
        max_tokens: cfg.api.maxTokens,
        stream: false
    };
    const tryOnce = async (withThinkingOff) => {
        const b = Object.assign({}, body);
        if (withThinkingOff) b.thinking = { type: 'disabled' };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), cfg.api.timeoutMs);
        try {
            const r = await fetch(cfg.api.baseUrl.replace(/\/$/, '') + '/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
                body: JSON.stringify(b),
                signal: ctrl.signal
            });
            const txt = await r.text();
            if (!r.ok) return { ok: false, status: r.status, text: txt };
            const j = JSON.parse(txt);
            const content = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
            return { ok: true, content: (content || '').trim() };
        } catch (e) {
            return { ok: false, status: 0, text: String(e && e.message || e) };
        } finally {
            clearTimeout(timer);
        }
    };

    let res = await tryOnce(cfg.api.disableThinking);
    if (!res.ok && cfg.api.disableThinking && (res.status === 400 || res.status === 422)) {
        log('模型不接受 thinking 参数，回退重试');
        res = await tryOnce(false);
    }
    if (!res.ok) {
        log('模型调用失败 status=' + res.status + ' ' + String(res.text).slice(0, 200));
        return null;
    }
    return res.content;
}

// ---------------- 自检（无需真实 key）----------------
async function selftest() {
    log('自检模式：以「测试同学」身份再连一条连接，向 ' + cfg.nickname + ' 发一条 @ 消息');
    const url = cfg.server;
    const t = new WebSocket(url, { tls: { rejectUnauthorized: false } });
    const nick = '测试同学';
    await new Promise(r => t.addEventListener('open', r));
    t.send(JSON.stringify({ type: 'auth', subtype: 'login', nickname: nick, content: 'selftest123456' }));
    await sleep(1200);
    t.send(JSON.stringify({ type: 'auth', subtype: 'register', nickname: nick, content: 'selftest123456', invite: INVITE }));
    await sleep(1200);
    let got = [];
    t.addEventListener('message', (e) => {
        try {
            const m = JSON.parse(e.data);
            if (m.type === 'chat' && m.nickname === cfg.nickname) { got.push(m.content); }
        } catch (err) { }
    });
    const msg = SELFTEST_MSG || ('@' + cfg.nickname + ' 你在吗？');
    t.send(JSON.stringify({ type: 'chat', nickname: nick, content: msg, msgId: newMsgId() }));
    await sleep(8000);
    log('自检结果：收到 bot 回复 ' + got.length + ' 条 → ' + JSON.stringify(got.slice(0, 2)));
    console.log(got.length > 0 ? 'SELFTEST_PASS' : 'SELFTEST_FAIL');
    process.exit(got.length > 0 ? 0 : 1);
}

// ---------------- 启动 ----------------
// 队列看门狗：processing 超过 90 秒未结束 ⇒ 强制复位（防永久卡死）
let processingSince = 0;
setInterval(() => {
    if (processing && processingSince && (nowMs() - processingSince) > 90000) {
        log('看门狗：回复队列卡住超过 90 秒，强制复位');
        processing = false;
        pendingQueue.length = 0;
    }
    processingSince = processing ? (processingSince || nowMs()) : 0;
}, 15000);

log('启动：配置=' + CFG_PATH.split(/[\\/]/).pop() + ' 昵称=' + cfg.nickname + ' 模式=' + cfg.mode + ' 模型=' + cfg.api.model + ' key来源=' + (KEY_SOURCE ? KEY_SOURCE.split(/[\\/]/).pop() : 'env') +
    (MOCK ? '（模拟模型）' : '') + ' 注册码=' + (INVITE ? '已读取' : '未读取'));
loadHistory();
connect();
if (SELFTEST) setTimeout(selftest, 3000);
