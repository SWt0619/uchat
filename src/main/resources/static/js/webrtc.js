/* ===== webrtc.js — 音视频通话 (WebRTC Mesh) =====
 *
 * 本文件在 v2.7.2 做了一轮通话质量/可靠性加固，主要变更：
 *   1. ICE 服务器从服务端 GET /api/turn 领取（含 TURN 临时凭据），不再硬编码单条 Google STUN
 *   2. ICE candidate 排队：远端描述就绪前不丢弃，连接失败率显著下降
 *   3. 音频约束打开浏览器原生 AEC / NS / AGC（旧版三项全 false，等于没有回声消除）
 *   4. 逐对等体码率控制 + Opus 带内 FEC/DTX（弱网抗丢包）+ 关摄像头真正停发
 *   5. ICE restart：disconnected 超时 / 网络切换后自动重启，而不是直接拆连接
 *   6. 音频处理链收敛为一条（增益 + 可选增强降噪），新老对等体音质一致
 *   7. 统计口径改为增量式 + nominated candidate-pair，并据此自动降级/恢复
 *   8. 麦克风/摄像头状态广播给同房间成员，对端画面上显示角标
 *   9. 修掉 AudioContext 泄漏（旧版每个远端 peer 建一个且从不 close）
 *  10. 修掉 playsinline（正确属性名是 playsInline）、无效的「Prefer H.264」空操作
 *  11. 去掉进房 3 秒盲重发 room_enter，改为服务端直发 room_state + 单次兜底
 */

// ==================== 全局状态 ====================
// ★ 手机端音频会话：声明"同时录音 + 播放"。
//   iOS 17+ 默认 'auto'，在麦克风会话激活时可能把页面里的媒体播放（通话方块）压掉，
//   表现为"能听到屏幕共享内容、却听不到对方语音"。设为 play-and-record 可避免。
/**
 * 音频会话类型：按需切换。
 * 为什么：iOS 在"录音会话(play-and-record)"下会把**媒体播放**也送进语音处理单元
 * （AEC/AGC/降噪）⇒ 屏幕共享的音频听起来像被降噪/变调。只在确实要采集麦克风时才用该模式，
 * 其余时候用 playback（纯播放，不做语音处理）。
 */
function applyAudioSessionType() {
    try {
        if (typeof navigator === 'undefined' || !navigator.audioSession) return;
        var inCall = (typeof videoCallActive !== 'undefined') && videoCallActive;
        var micOn = (typeof micEnabled === 'undefined') ? true : micEnabled;
        // 规则：通话中且开麦 ⇒ play-and-record（必须，否则麦克风发不出声）
        //       通话中但闭麦 ⇒ playback（只听音频时走纯播放路径，避开 iOS 语音处理/降噪）
        //       不在通话中 ⇒ auto（交回系统；绝不能设 playback —— iOS 下 playback 与采集麦克风冲突，
        //                       会导致"发起通话时报 AudioSession category 错误"）
        var next;
        if (inCall && micOn) next = 'play-and-record';
        else if (inCall && !micOn) next = 'playback';
        else next = 'auto';
        navigator.audioSession.type = next;
        console.log('[AUDIO] audioSession.type=' + navigator.audioSession.type + '（通话=' + inCall + ' 麦克风=' + micOn + '）');
    } catch (e) { }
}
applyAudioSessionType();

let myStream = null;              // 本地媒体流（音频轨 = 处理链输出，见 §音频链）
let rawMicStream = null;          // getUserMedia 拿到的原始音频流
let micChain = null;              // 音频处理链 {src, nodes, dest, outTrack, gain}
let micGainPct = 100;
let nrEnabled = false;
let nrModel = null;
let sharedAudioCtx = null;        // 全页面共用一个 AudioContext（远端分析 + 本地处理链共用）

let peerConnections = {};         // nickname -> RTCPeerConnection
let videoCallActive = false;
let justJoinedCall = false;
let roomStateAcked = false;       // 是否已收到服务端 room_state（收到即无需兜底重发）
let micEnabled = true;
let camEnabled = true;
let pendingVideoOffers = new Set();
let voiceQuality = {};            // nickname -> { pct, quality, rtt, loss, lim, bitrate }
let voiceQualityTimer = null;
let participantCount = 0;

let mediaStates = {};             // nickname -> { audio:bool, video:bool }
let peerUnstable = {};            // nickname -> 标记时间戳（对端重连中）
let peerUnstableTimers = {};
let statsCache = {};              // reportId -> { lost, recv }（增量式丢包统计）
let adaptiveLevel = {};           // nickname -> 0 全质量 / 1 降码率 / 2 仅音频
let badStreak = {};               // nickname -> 连续差样本数
let goodStreak = {};              // nickname -> 连续好样本数

// ICE 配置：先用 STUN 占位，进房前从 /api/turn 拉取（screen.js 也复用这个全局）
// ★ 默认 ICE 服务器：国内可达的公共 STUN 优先（Google 的在境内基本不可达，仅作最后兜底）。
//   跨设备（电脑↔手机）通话依赖这些 STUN 做 NAT 穿透/连通性检查；只留 Google 那台会导致
//   "电脑↔电脑（同机 localhost host 候选）能通、跨设备完全不通"的现象。
const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.chat.bilibili.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
];
let rtcConfig = { iceServers: DEFAULT_ICE_SERVERS.slice() };
let iceServersLoaded = false;

// ==================== ICE 服务器（STUN + TURN） ====================

/**
 * 从服务端领取 ICE 服务器列表。未配置 TURN 时服务端只回 STUN，行为与旧版一致。
 * 只拉起一次；force=true 可强制刷新（TURN 凭据默认 1 小时过期）。
 */
async function loadIceServers(force) {
    if (iceServersLoaded && !force) return;
    try {
        var base = (typeof getApiBaseUrl === 'function') ? getApiBaseUrl() : '';
        var resp = await fetch(base + '/api/turn', { credentials: 'omit', cache: 'no-store' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var data = await resp.json();
        if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
            // ★ 与内置的国内 STUN 合并（按 urls 去重）：服务端若只返回 TURN、或返回了一组
            //   境内不可达的 STUN，这里仍保留可用兜底，避免"服务端配了配置反而更连不上"。
            var merged = data.iceServers.slice();
            DEFAULT_ICE_SERVERS.forEach(function (s) {
                if (!merged.some(function (m) { return m.urls === s.urls; })) merged.push(s);
            });
            rtcConfig = { iceServers: merged };
            console.log('[ICE] 已加载 ' + data.iceServers.length + ' 个 ICE 服务器，TURN=' + (!!data.turnEnabled));
            // 热更新已有连接（TURN 凭据轮换/首次补配时）
            Object.values(peerConnections).forEach(function (pc) {
                try { pc.setConfiguration(rtcConfig); } catch (e) {}
            });
            if (typeof screenPeerConnections !== 'undefined') {
                Object.values(screenPeerConnections).forEach(function (pc) {
                    try { pc.setConfiguration(rtcConfig); } catch (e) {}
                });
            }
        }
    } catch (e) {
        console.warn('[ICE] /api/turn 不可用，退化为默认 STUN：', e && e.message);
    } finally {
        iceServersLoaded = true;   // 失败也不反复重试，避免每次进房都挂住
    }
}

// ==================== 通话状态与房间人数 ====================

// 按人数+网络自适应调整所有发送端（码率/帧率/是否发视频）
function adjustForParticipantCount() {
    tuneAllSenders();
}

function micKey()  { return 'chatroom-mic-device-' + nickname; }
function camKey()  { return 'chatroom-cam-device-' + nickname; }
function micVolKey(){ return 'chatroom-mic-vol-' + nickname; }
function spkVolKey(){ return 'chatroom-spk-vol-' + nickname; }
function nrKey()   { return 'chatroom-nr-model-' + nickname; }
function camPrefKey(){ return 'chatroom-open-cam-' + nickname; }

/**
 * 音频约束。旧版把 echoCancellation / noiseSuppression / autoGainControl 全设为 false，
 * 换成自研 HPF+压缩器 —— 结果是完全没有回声消除（对方外放必啸叫）、没有 AGC（音量忽大忽小），
 * 而降噪效果也远不如浏览器内置。这里改回浏览器原生处理。
 * deviceId 用 ideal 而不是 exact：exact 在设备被拔掉时会直接抛 OverconstrainedError 卡住进房。
 */
function getAudioConstraints() {
    const base = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000
    };
    var micId = localStorage.getItem(micKey());
    if (micId) base.deviceId = { ideal: micId };
    return base;
}

function getVideoConstraints() {
    var camId = localStorage.getItem(camKey());
    var base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    if (camId) base.deviceId = { ideal: camId };
    else base.facingMode = { ideal: 'user' };
    return base;
}

// 清理指定用户的所有设备偏好（用于约束失败时回退）
function clearDevicePrefs() {
    localStorage.removeItem(micKey());
    localStorage.removeItem(camKey());
}

// ==================== Start / Join ====================
let callRoomNum = 0; // 当前所在通话房间号，0=未加入
let callRoomIsVoice = false;   // **实际所在**房间的类型（≠ audioOnlyMode：后者是"选择器正在显示哪一类"）
let audioOnlyMode = false; // 纯语音模式（不开启摄像头）

// 各房间容量由服务端下发（call_status.caps），客户端只显示不硬编码
var callRoomCaps = { voice1: 12, voice2: 6, video1: 8, video2: 6 };
// 各房间**上次已知的人数**（切换语音/视频时立刻用新分母重画，避免视频模式还显示 0/12 人）
var callRoomCounts = { voice1: 0, voice2: 0, video1: 0, video2: 0 };

function callRoomCap(type, num) {
    var k = (type === 'voice' ? 'voice' : 'video') + num;
    var v = callRoomCaps[k];
    return (typeof v === 'number' && v > 0) ? v : 6;
}

function updateRoomCard(type, num, count) {
    var key = (type === 'voice' ? 'voice' : 'video') + num;
    callRoomCounts[key] = count;                   // 记住人数，切换类型时要用
    if (!$('call-room-selector')) return;
    var el = document.getElementById('call-room-' + num + '-count');
    if (el) el.textContent = count + '/' + callRoomCap(type, num) + ' 人';
}

/** 按选择器当前模式（语音/视频）刷新两张卡片的名称、容量与「当前所在房间」标记 */
function renderRoomCards(audioOnly) {
    var type = audioOnly ? 'voice' : 'video';
    var typeName = audioOnly ? '语音' : '视频';
    for (var n = 1; n <= 2; n++) {
        var nameEl = document.getElementById('call-room-' + n + '-name');
        if (nameEl) nameEl.textContent = typeName + '房间 ' + n;
        var subEl = document.getElementById('call-room-' + n + '-sub');
        if (subEl) subEl.textContent = typeName + ' · 最多 ' + callRoomCap(type, n) + ' 人';
        var curEl = document.getElementById('call-room-' + n + '-cur');
        if (curEl) {
            var isCurrent = videoCallActive && callRoomNum === n && callRoomIsVoice === audioOnly;
            curEl.style.display = isCurrent ? '' : 'none';
        }
        // 人数分母也要按新类型立刻刷新（否则视频模式会沿用语音的 0/12 人）
        var cntEl = document.getElementById('call-room-' + n + '-count');
        if (cntEl) cntEl.textContent = callRoomCounts[type + n] + '/' + callRoomCap(type, n) + ' 人';
    }
    var hang = document.getElementById('btn-call-room-hangup');
    if (hang) hang.style.display = videoCallActive ? '' : 'none';
}

/**
 * 打开房间选择器。
 *   · 不在通话中：选一个房间进入
 *   · 已在通话中：**换房间**（旧版这里直接挂断；现在可语音⇄视频、1 号房⇄2 号房互切），
 *     想退出请点选择器里的「退出通话」或通话面板上的挂断。
 */
function showCallRoomSelector(mode) {
    if (isOffline()) { showToast('连接已断开，请先重连', 'error'); return; }
    if (videoCallActive) {
        audioOnlyMode = mode;                 // 显示哪一类房间（可跨类型换房）
        $('call-room-title').textContent = '🔀 换房间（当前：' + (callRoomIsVoice ? '语音' : '视频')
            + '房间 ' + callRoomNum + '）';
    } else {
        audioOnlyMode = mode;
        $('call-room-title').textContent = mode ? '🎙️ 选择语音房间' : '📞 选择通话房间';
    }
    renderRoomCards(mode);
    var row = document.getElementById('call-open-cam-row');
    var cb = document.getElementById('call-open-cam');
    if (row) row.style.display = mode ? 'none' : '';
    if (cb) {
        // 记忆上次选择，替代旧版的 confirm() 阻塞弹窗
        var saved = localStorage.getItem(camPrefKey());
        cb.checked = (saved === null) ? true : saved === '1';
    }
    $('call-room-selector').style.display = 'flex';
    renderRoomCards(mode);
    requestCallRoomState();
    // 延时再请求一次，确保面板渲染后拿到最新数据
    setTimeout(requestCallRoomState, 300);
}

function requestCallRoomState() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'call_rooms_state' }));
    }
}

function wantCamera() {
    var cb = document.getElementById('call-open-cam');
    if (cb) {
        localStorage.setItem(camPrefKey(), cb.checked ? '1' : '0');
        return !!cb.checked;
    }
    var saved = localStorage.getItem(camPrefKey());
    return saved === null ? true : saved === '1';
}

$('btn-video-call').addEventListener('click', function() { showCallRoomSelector(false); });
$('btn-voice-call').addEventListener('click', function() { showCallRoomSelector(true); });

// 房间选择器事件
$('call-room-1-card').addEventListener('click', function() { pickCallRoom(1); });
$('call-room-2-card').addEventListener('click', function() { pickCallRoom(2); });

/** 卡片点击：不在通话中就进房；在通话中就换房 */
function pickCallRoom(roomNum) {
    var audioOnly = audioOnlyMode;
    if (!videoCallActive) { enterCallRoom(roomNum, audioOnly); return; }
    if (callRoomNum === roomNum && audioOnlyMode === audioOnly) {
        showToast('你已经在' + (audioOnly ? '语音' : '视频') + '房间 ' + roomNum + ' 了', 'info');
        $('call-room-selector').style.display = 'none';
        return;
    }
    switchCallRoom(roomNum, audioOnly);
}

/** 换房：拆掉旧连接与采集 → 以"新进房"的完整流程重新进（服务端会把旧房间自动清掉） */
function switchCallRoom(roomNum, audioOnly) {
    var target = (audioOnly ? '语音' : '视频') + '房间 ' + roomNum;
    showToast('正在切换到' + target + '…', 'info');
    try { teardownAllPeers(); } catch (e) {}
    try { stopMyStream(); } catch (e) {}
    try { cleanupMicGain(); } catch (e) {}
    try { resetNrButton(); } catch (e) {}
    try { clearAllPeerMeta(); } catch (e) {}
    justJoinedCall = false;
    roomStateAcked = false;
    videoCallActive = false;
    callRoomNum = 0;
    audioOnlyMode = audioOnly;
    try { $('video-grid').innerHTML = ''; } catch (e) {}
    $('call-room-selector').style.display = 'none';
    enterCallRoom(roomNum, audioOnly);
}
$('btn-call-room-cancel').addEventListener('click', function() {
    $('call-room-selector').style.display = 'none';
});
$('call-room-selector').addEventListener('click', function(e) {
    if (e.target === $('call-room-selector')) this.style.display = 'none';
});
$('btn-call-room-hangup').addEventListener('click', function() {
    $('call-room-selector').style.display = 'none';
    hangupVideoCall();
});

async function enterCallRoom(roomNum, audioOnly) {
    // ④ 开麦前先把音频会话交回系统：iOS 下若残留 playback 分类，采集麦克风会被拒
    try { if (typeof navigator !== 'undefined' && navigator.audioSession) navigator.audioSession.type = 'auto'; } catch (e) {}
    $('call-room-selector').style.display = 'none';
    callRoomNum = roomNum;
    callRoomIsVoice = !!audioOnly;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast("浏览器不支持通话", "error");
        return;
    }
    stopMyStream();
    cleanupMicGain();

    var withCam = !audioOnly && wantCamera();
    try {
        await loadIceServers();   // 先拿到 ICE 配置（含 TURN），再建连接
        var c = { audio: getAudioConstraints() };
        if (withCam) c.video = getVideoConstraints();
        rawMicStream = await navigator.mediaDevices.getUserMedia(c);
        // 运行时读增益（旧版用模块加载时的快照，滑块改过之后进房会用旧值）
        var savedMicVol = localStorage.getItem(micVolKey());
        micGainPct = savedMicVol === null ? 100 : (parseInt(savedMicVol, 10) || 0);
        if (savedMicVol !== null) $('mic-vol').value = savedMicVol;
        myStream = rawMicStream;
        buildAudioPipeline();     // 增益 +（可选）增强降噪，收敛成一条链
        rebuildMyStream();
    } catch (e) {
        stopMyStream();
        if (e && e.name === "NotAllowedError") {
            showToast("请允许设备权限后重试", "error");
        } else if (e && (e.name === "OverconstrainedError" || e.name === "NotFoundError")) {
            showToast("指定设备不可用，已切换为默认设备，请重试", "info");
            clearDevicePrefs();
            var micSel = document.getElementById('setting-mic');
            var camSel = document.getElementById('setting-cam');
            if (micSel) micSel.value = '';
            if (camSel) camSel.value = '';
            if (typeof saveUserPrefs === 'function') saveUserPrefs();
        } else {
            showToast("设备访问失败: " + ((e && (e.message || e.name)) || '未知错误'), "error");
        }
        callRoomNum = 0;
        return;
    }

    try {
        videoCallActive = true;
        micEnabled = true;
        camEnabled = withCam;
        peerConnections = {};
        pendingVideoOffers = new Set();
        mediaStates = {};
        adaptiveLevel = {};
        badStreak = {}; goodStreak = {};
        statsCache = {};
        $("video-overlay").classList.add("visible");
        $("video-header-title").textContent = audioOnly ? '🎙️ 语音通话' : '📹 视频通话';
        if (audioOnly) {
            $("video-overlay").style.width = '300px';
            $("video-overlay").style.height = '';
            $("video-grid").style.display = 'none';
        }
        $("btn-cam").style.display = audioOnly ? 'none' : '';
        $("btn-video-max").style.display = audioOnly ? 'none' : '';
        $("btn-video-min").style.display = audioOnly ? 'none' : '';
        if (!withCam) $("btn-cam").classList.add("off");
        addLocalTile();
        if (audioOnly) {
            var localTile = document.getElementById('tile-local');
            if (localTile) localTile.style.display = 'none';
            $("voice-participants").style.display = 'flex';
            updateVoiceParticipantList();
            startSpeakingDetection();
        }
    } catch (e) {
        console.error('enterCallRoom UI error:', e);
    }

    justJoinedCall = true;
    try { applyAudioSessionType(); } catch (e) {}
    roomStateAcked = false;
    var sub = audioOnly ? 'voice' : 'video';
    ws.send(JSON.stringify({ type: "room_enter", nickname: nickname, online: roomNum, subtype: sub }));
    sendMediaState();
    startVoiceQualityMonitor();

    // 兜底：服务端现在会在 room_enter 后立刻直发 room_state，
    // 只有在完全没收到状态时才重发一次（不再是旧版无条件的 3 秒盲重发）。
    var fallbackNick = nickname, fallbackRoom = roomNum, fallbackSub = sub;
    setTimeout(function() {
        if (videoCallActive && justJoinedCall && !roomStateAcked && ws && ws.readyState === WebSocket.OPEN) {
            console.warn('[CALL] 未收到 room_state，重发一次 room_enter');
            ws.send(JSON.stringify({ type: "room_enter", nickname: fallbackNick, online: fallbackRoom, subtype: fallbackSub }));
        }
    }, 5000);

    if (audioOnly) {
        $('btn-voice-call').classList.add('active');
    }
    var label = audioOnly ? '语音房间 ' : '通话房间 ';
    showToast("已进入" + label + roomNum, "success");
}

function leaveCallRoom() {
    stopVoiceQualityMonitor();
    teardownAllPeers();
    stopMyStream();
    cleanupMicGain();
    resetNrButton();
    justJoinedCall = false;
    try { applyAudioSessionType(); } catch (e) {}
    videoCallActive = false;
    var wasAudio = audioOnlyMode;
    audioOnlyMode = false;
    var rn = callRoomNum;
    callRoomNum = 0;
    callRoomIsVoice = false;
    $("video-grid").innerHTML = "";
    $("video-grid").style.display = '';
    $("voice-participants").style.display = 'none';
    stopSpeakingDetection();
    $("video-overlay").classList.remove("visible");
    $("video-overlay").style.width = '';
    $("video-overlay").style.height = '';
    $("video-header-title").textContent = '📹 视频通话';
    $("btn-video-max").style.display = '';
    $("btn-video-min").style.display = '';
    $("btn-mic-toggle").textContent = "🎙️";
    $("btn-mic-toggle").classList.remove("off");
    $("btn-cam").textContent = "📷";
    $("btn-cam").classList.remove("off");
    $('btn-voice-call').classList.remove('active');
    clearAllPeerMeta();
    if (ws && ws.readyState === WebSocket.OPEN) {
        if (!window.__suppressLeaveSend) { ws.send(JSON.stringify({ type: "room_leave", nickname: nickname, online: rn, subtype: wasAudio ? 'voice' : 'video' })); }
    }
}

function stopMyStream() {
    if (myStream) {
        try { myStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        myStream = null;
    }
    if (rawMicStream && rawMicStream !== myStream) {
        try { rawMicStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    }
    rawMicStream = null;
}

function clearAllPeerMeta() {
    peerUnstable = {};
    Object.keys(peerUnstableTimers).forEach(function (k) { clearTimeout(peerUnstableTimers[k]); });
    peerUnstableTimers = {};
    voiceAnalysers = {};
    voiceQuality = {};
    mediaStates = {};
    peerConnections = {};
    pendingVideoOffers = new Set();
    statsCache = {};
    adaptiveLevel = {};
    badStreak = {}; goodStreak = {};
}

// ==================== 音视频参数（码率 / Opus 抗丢包） ====================

/** 按人数与自适应等级算视频码率预算 */
function videoBudget() {
    var n = participantCount || 2;
    var br, fps;
    if (n <= 2) { br = 1200000; fps = 30; }
    else if (n <= 4) { br = 500000; fps = 20; }
    else { br = 240000; fps = 15; }
    return { bitrate: br, framerate: fps };
}

/** 单人音频码率（1对1 给足，多人时压缩以给视频让出带宽） */
function audioBudget() {
    var n = participantCount || 2;
    return n <= 2 ? 64000 : 32000;
}

/**
 * 给远端 SDP 里的 Opus 打开带内 FEC 与 DTX，并限制平均码率。
 * useinbandfec=1 在丢包 5~10% 时能显著减少爆音；usedtx=1 静音时停发省流量。
 */
function mangleOpusSdp(desc, audioBitrate) {
    if (!desc || !desc.sdp) return desc;
    var m = desc.sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
    if (!m) return desc;
    var pt = m[1];
    var want = 'useinbandfec=1;usedtx=1;stereo=0;minptime=10;maxaveragebitrate=' + audioBitrate;
    var re = new RegExp('a=fmtp:' + pt + '\\s+([^\\r\\n]*)');
    if (re.test(desc.sdp)) {
        desc.sdp = desc.sdp.replace(re, function (full, params) {
            if (/useinbandfec/i.test(params)) return full;      // 已经设过就不重复追加
            return 'a=fmtp:' + pt + ' ' + params + ';' + want;
        });
    } else {
        desc.sdp = desc.sdp.replace('a=rtpmap:' + pt + ' opus/48000/2',
            'a=rtpmap:' + pt + ' opus/48000/2\r\na=fmtp:' + pt + ' ' + want);
    }
    return desc;
}

function setLocalDescriptionTuned(pc, desc) {
    // rollback 是 {type:'rollback'}，没有 sdp，不能碰
    if (desc && desc.sdp) desc = mangleOpusSdp(desc, audioBudget());
    return pc.setLocalDescription(desc);
}

/** H.264 优先（移动端/低功耗设备想用硬件编码时有用）。必须在创建 offer/answer 之前调用。 */
function preferCodecs(pc) {
    try {
        if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
        var caps = RTCRtpSender.getCapabilities('video');
        if (!caps || !caps.codecs) return;
        var order = ['H264', 'VP8', 'VP9', 'AV1'];
        function rank(c) {
            var mt = (c.mimeType || '').toUpperCase();
            for (var i = 0; i < order.length; i++) { if (mt.indexOf(order[i]) >= 0) return i; }
            return order.length;
        }
        var sorted = caps.codecs.slice().sort(function (a, b) { return rank(a) - rank(b); });
        pc.getTransceivers().forEach(function (t) {
            var kind = (t.sender && t.sender.track && t.sender.track.kind) ||
                       (t.receiver && t.receiver.track && t.receiver.track.kind);
            if (kind !== 'video') return;
            if (typeof t.setCodecPreferences === 'function') {
                try { t.setCodecPreferences(sorted); } catch (e) {}
            }
        });
    } catch (e) { /* 非致命 */ }
}

/** 单条连接的发送端调参 */
async function tuneSenders(pc, nick) {
    if (!pc) return;
    var level = adaptiveLevel[nick] || 0;
    var sendVideo = camEnabled && !audioOnlyMode && level < 2;
    try {
        var vs = pc.getSenders().find(function (s) { return s.track && s.track.kind === 'video'; });
        if (vs) {
            var p = vs.getParameters();
            if (!p.encodings || !p.encodings.length) p.encodings = [{}];
            var b = videoBudget();
            if (level >= 1) { b.bitrate = Math.round(b.bitrate * 0.4); b.framerate = Math.min(b.framerate, 12); }
            p.encodings[0].maxBitrate = b.bitrate;
            p.encodings[0].maxFramerate = b.framerate;
            // active=false 才是真停发；track.enabled=false 仍然在送黑帧
            p.encodings[0].active = sendVideo;
            p.degradationPreference = 'balanced';
            await vs.setParameters(p);
        }
    } catch (e) { /* 部分浏览器不支持，忽略 */ }
    try {
        var as = pc.getSenders().find(function (s) { return s.track && s.track.kind === 'audio'; });
        if (as) {
            var ap = as.getParameters();
            if (!ap.encodings || !ap.encodings.length) ap.encodings = [{}];
            ap.encodings[0].maxBitrate = audioBudget();
            await as.setParameters(ap);
        }
    } catch (e) {}
}

function tuneAllSenders() {
    Object.keys(peerConnections).forEach(function (nick) {
        tuneSenders(peerConnections[nick], nick).catch(function () {});
    });
}

// ==================== Peer Connection ====================

/** 判断已有 PC 是否还能用（否则收到新 offer 时重建，避免在坏连接上重协商失败） */
function isPcUsable(pc) {
    if (!pc) return false;
    var s = pc.connectionState;
    return s === 'new' || s === 'connecting' || s === 'connected';
}

function createPeerConnection(targetNick, isOfferer) {
    if (peerConnections[targetNick]) return peerConnections[targetNick];
    if (!myStream) return null;

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[targetNick] = pc;
    pc._pendingCandidates = [];
    pc._offerInFlight = false;

    // 添加本地轨道（视频按运动场景优化）
    myStream.getTracks().forEach(track => {
        if (track.kind === 'video') {
            track.contentHint = 'motion';   // 人脸/动作场景优先保证流畅
        }
        pc.addTrack(track, myStream);
    });
    preferCodecs(pc);   // 必须在 createOffer / createAnswer 之前

    // 远端轨道
    let remoteTrackTimeout;
    pc.ontrack = (event) => {
        if (remoteTrackTimeout) { clearTimeout(remoteTrackTimeout); remoteTrackTimeout = null; }
        var stream = event.streams && event.streams[0];
        if (!stream) {
            if (!event.track) return;
            if (!pc._remoteStream) pc._remoteStream = new MediaStream();
            pc._remoteStream.addTrack(event.track);
            stream = pc._remoteStream;
        }
        addRemoteTile(targetNick, stream);
        attachAudioAnalyser(targetNick, stream);   // 说话检测用（共用 AudioContext）
        var videoEl = document.querySelector('#tile-' + targetNick + ' video');
        if (videoEl) {
            videoEl.onstalled = function() { showToast(targetNick + ' 的视频画面中断', 'error'); };
            videoEl.play().catch(function () {
                // 自动播放被策略拦截时给用户一个可点的提示，而不是静默黑屏
                if (videoEl.paused) showToast('点击 ' + targetNick + ' 的画面即可开始播放', 'info');
            });
        }
        clearPeerUnstable(targetNick);
    };

    // 15s 未拿到画面提示
    remoteTrackTimeout = setTimeout(() => {
        if (!peerConnections[targetNick]) return;
        showToast('无法获取 ' + targetNick + ' 的视频画面（网络问题）', 'error');
    }, 15000);

    // ICE 候选
    pc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'video_ice', nickname: nickname, receiver: targetNick,
                content: JSON.stringify(event.candidate)
            }));
        }
    };

    // 连接状态：disconnected 尝试 ICE restart，而不是直接拆掉
    pc.oniceconnectionstatechange = () => {
        var st = pc.iceConnectionState;
        console.log('[ICE] ' + targetNick + ' -> ' + st);
        if (st === 'disconnected') {
            if (!pc._iceRestartTimer) {
                pc._iceRestartTimer = setTimeout(function () {
                    pc._iceRestartTimer = null;
                    var cur = pc.iceConnectionState;
                    if (cur === 'connected' || cur === 'completed') return;
                    console.warn('[ICE] ' + targetNick + ' disconnected 超时，尝试 ICE restart');
                    try {
                        pc.restartIce();
                        negotiate(targetNick, pc);
                    } catch (e) {}
                }, 4000);
            }
        } else {
            if (pc._iceRestartTimer) { clearTimeout(pc._iceRestartTimer); pc._iceRestartTimer = null; }
        }
        if (st === 'failed') {
            if (!pc._iceRestartedOnce) {
                pc._iceRestartedOnce = true;
                console.warn('[ICE] ' + targetNick + ' failed，先试一次 ICE restart');
                try { pc.restartIce(); negotiate(targetNick, pc); } catch (e) {}
                return;
            }
            showToast('与 ' + targetNick + ' 的网络连接失败（可能不在同一网络）', 'error');
        }
    };
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
            teardownPeer(targetNick, false);
            showToast('与 ' + targetNick + ' 的连接已断开', 'error');
        }
    };

    // 注意：这里刻意不使用 onnegotiationneeded —— 该事件在部分浏览器会因未完成的协商
    // 反复触发，造成双方来回发 offer。改由调用方在「进房时没开摄像头、之后打开」这一
    // 真正需要重协商的路径上显式调用 negotiate()，行为确定、无循环风险。
    tuneSenders(pc, targetNick).catch(function () {});

    if (isOfferer) {
        negotiate(targetNick, pc);
    }

    return pc;
}

/** 创建并发送 offer（同时用于首次协商、ICE restart 与轨道变化后的重协商） */
function negotiate(targetNick, pc) {
    if (!pc || pc.signalingState !== 'stable' || pc._offerInFlight) return;
    pc._offerInFlight = true;
    pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true })
      .then(offer => setLocalDescriptionTuned(pc, offer))
      .then(() => {
          if (ws && ws.readyState === WebSocket.OPEN && pc.localDescription) {
              ws.send(JSON.stringify({
                  type: 'video_offer', nickname: nickname, receiver: targetNick,
                  content: JSON.stringify(pc.localDescription)
              }));
          }
      })
      .catch(e => console.error('Create offer error:', targetNick, e))
      .finally(() => { pc._offerInFlight = false; });
}

/** 清掉与某个对等体的连接（keepTile=true 时保留画面格子，等对端回来） */
function teardownPeer(targetNick, keepTile) {
    pendingVideoOffers.delete(targetNick);
    releaseAudioAnalyser(targetNick);
    if (peerConnections[targetNick]) {
        try { peerConnections[targetNick].close(); } catch (e) {}
        delete peerConnections[targetNick];
    }
    delete adaptiveLevel[targetNick];
    delete badStreak[targetNick];
    delete goodStreak[targetNick];
    delete voiceQuality[targetNick];
    statsCache = {};   // 报告 id 可能在新建连接时复用，整体清掉避免误算增量
    if (!keepTile) {
        removeRemoteTile(targetNick);
        delete mediaStates[targetNick];
    }
}

function teardownAllPeers() {
    Object.values(peerConnections).forEach(function (pc) { try { pc.close(); } catch (e) {} });
    peerConnections = {};
    pendingVideoOffers = new Set();
    Object.keys(peerUnstableTimers).forEach(function (k) { clearTimeout(peerUnstableTimers[k]); });
    peerUnstableTimers = {};
    peerUnstable = {};
    statsCache = {};
}

/** 兼容旧接口名 */
function cleanupPeer(targetNick) {
    teardownPeer(targetNick, false);
}

// ==================== ICE candidate 排队 ====================
// 旧实现在 setRemoteDescription 完成前收到 candidate 会抛 InvalidStateError 并被 .catch 静默吞掉，
// 候选直接丢失 —— 表现为"偶发连不上/连接很慢"。这里改为排队，描述就绪后统一 flush。
function flushPendingCandidates(pc) {
    if (!pc || !pc.remoteDescription) return;
    var q = pc._pendingCandidates || [];
    pc._pendingCandidates = [];
    q.forEach(function (cand) {
        pc.addIceCandidate(cand).catch(function (e) {
            console.warn('addIceCandidate failed:', e && e.message);
        });
    });
}

// ==================== Handle Signaling ====================
function handleVideoOffer(msg) {
    try {
        if (!videoCallActive || !myStream) return;
        if (pendingVideoOffers.has(msg.nickname)) return;
        pendingVideoOffers.add(msg.nickname);

        var pc = peerConnections[msg.nickname];
        // 已有连接但已不健康 → 重建，避免在坏连接上重协商
        if (pc && !isPcUsable(pc)) {
            teardownPeer(msg.nickname, true);
            pc = null;
        }
        var isGlare = pc && pc.signalingState !== 'stable';

        if (isGlare) {
            // 双方同时发 offer：用昵称字典序决定 polite/impolite
            var iAmPolite = nickname < msg.nickname;
            if (iAmPolite) {
                console.log('Glare detected: we are polite, rolling back and accepting offer from ' + msg.nickname);
                var offer = JSON.parse(msg.content);
                Promise.all([
                    pc.setLocalDescription({type: 'rollback'}),
                    pc.setRemoteDescription(new RTCSessionDescription(offer))
                ]).then(function() {
                    preferCodecs(pc);
                    return pc.createAnswer();
                }).then(function(answer) {
                    return setLocalDescriptionTuned(pc, answer);
                }).then(function() {
                    flushPendingCandidates(pc);
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'video_answer', nickname: nickname, receiver: msg.nickname,
                            content: JSON.stringify(pc.localDescription)
                        }));
                    }
                }).catch(function(e) {
                    console.error('Glare handle error:', e);
                    teardownPeer(msg.nickname, false);
                });
            } else {
                // Impolite：忽略来方 offer，以自己发出的为准
                console.log('Glare detected: we are impolite, ignoring offer from ' + msg.nickname);
                pendingVideoOffers.delete(msg.nickname);
            }
            return;
        }

        if (!pc) {
            pc = createPeerConnection(msg.nickname, false);
        }
        if (!pc) { pendingVideoOffers.delete(msg.nickname); return; }

        var offer2 = JSON.parse(msg.content);
        pc.setRemoteDescription(new RTCSessionDescription(offer2)).then(function() {
            flushPendingCandidates(pc);
            preferCodecs(pc);
            return pc.createAnswer();
        }).then(function(answer) {
            return setLocalDescriptionTuned(pc, answer);
        }).then(function() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'video_answer', nickname: nickname, receiver: msg.nickname,
                    content: JSON.stringify(pc.localDescription)
                }));
            }
        }).catch(function(e) {
            console.error('Handle offer error:', e);
            teardownPeer(msg.nickname, false);
        });
    } catch (e) { console.error('offer parse error:', e); }
}

function handleVideoAnswer(msg) {
    try {
        const pc = peerConnections[msg.nickname];
        if (!pc) return;
        if (pc.signalingState === 'stable') return;   // 过期 answer（例如已 rollback 后的残留）
        const answer = JSON.parse(msg.content);
        pc.setRemoteDescription(new RTCSessionDescription(answer))
          .then(function () { flushPendingCandidates(pc); })
          .catch(function (e) { console.warn('setRemoteDescription(answer) failed:', e && e.message); });
    } catch (e) {}
}

function handleVideoIce(msg) {
    try {
        const pc = peerConnections[msg.nickname];
        if (!pc) return;
        const candidate = new RTCIceCandidate(JSON.parse(msg.content));
        if (!pc.remoteDescription) {
            // 远端描述还没就绪 → 排队，等 setRemoteDescription 后 flush
            pc._pendingCandidates.push(candidate);
            return;
        }
        pc.addIceCandidate(candidate).catch(function (e) {
            console.warn('addIceCandidate failed:', e && e.message);
        });
    } catch (e) {}
}

// ==================== 对端状态（宽限期内"重连中"） ====================

function markPeerUnstable(nick) {
    if (nick === nickname) return;
    peerUnstable[nick] = Date.now();
    renderTileLabel(nick);
    if (!peerUnstableTimers[nick]) {
        peerUnstableTimers[nick] = setTimeout(function () {
            delete peerUnstableTimers[nick];
            if (!peerUnstable[nick]) return;
            delete peerUnstable[nick];
            // 服务端宽限期 45s 都没回来 → 真正拆掉
            teardownPeer(nick, false);
        }, 60000);
    }
}

function clearPeerUnstable(nick) {
    if (!peerUnstable[nick]) return;
    delete peerUnstable[nick];
    if (peerUnstableTimers[nick]) { clearTimeout(peerUnstableTimers[nick]); delete peerUnstableTimers[nick]; }
    renderTileLabel(nick);
}

// Override handleMessage to intercept call signaling
const origHandleMessage = handleMessage;
handleMessage = function(msg) {
    switch (msg.type) {
        case 'video_offer': handleVideoOffer(msg); break;
        case 'video_answer': handleVideoAnswer(msg); break;
        case 'video_ice': handleVideoIce(msg); break;
        case 'media_state':
            if (msg.nickname && msg.nickname !== nickname) {
                mediaStates[msg.nickname] = { audio: msg.audioOn !== false, video: msg.videoOn !== false };
                renderTileLabel(msg.nickname);
            }
            break;
        case 'room_peer_unstable':
            if (msg.nickname && msg.nickname !== nickname) {
                markPeerUnstable(msg.nickname);
                showToast(msg.nickname + ' 网络中断，正在重连…', 'info');
            }
            break;
        case 'room_peer_resume':
            if (msg.nickname && msg.nickname !== nickname) {
                clearPeerUnstable(msg.nickname);
                showToast(msg.nickname + ' 已恢复连接', 'success');
            }
            break;
        case 'room_enter':
            var callType = (msg.subtype === 'voice') ? '语音' : '视频';
            var action = (msg.nickname === nickname) ? '发起了' : '加入了';
            if (typeof appendSystemMessage === 'function') {
                appendSystemMessage(msg.nickname + ' ' + action + ' ' + callType + '通话');
            }
            if (msg.nickname !== nickname && typeof showToast === 'function') {
                showToast(msg.nickname + ' ' + action + ' ' + callType + '通话', 'info');
            }
            break;
        case 'room_leave':
            // ★ 自己被移出通话房间（例如掉线超过宽限期被服务端清理）：
            //   必须把本地通话 UI / 采集媒体一起收尾，否则会出现
            //   "服务端已把你移出、你自己的界面却还显示在频道里"的状态不一致。
            if (msg.nickname === nickname) {
                // ★ 只做本地收尾，**绝不回发 room_leave**：否则服务端会再次通知本人，
                //   形成无限回声环（消息风暴 / 日志爆量 / 服务端被拖垮）。
                window.__suppressLeaveSend = true;
                try { leaveCallRoom(); } catch (e) { console.warn('[CALL] 被移出通话后收尾失败:', e); }
                finally { window.__suppressLeaveSend = false; }
                if (typeof showToast === 'function') {
                    showToast(msg.reason === 'grace_expired' ? '掉线超时，已退出通话' : '已退出通话', 'info');
                }
                break;
            }
            window.setUserStatus && window.setUserStatus(msg.nickname, 'call', false);
            teardownPeer(msg.nickname, false);
            delete mediaStates[msg.nickname];
            clearPeerUnstable(msg.nickname);
            origHandleMessage(msg);
            break;
        case 'call_status':
            // online=视频1, count=视频2, subtype=语音1人数, offline=语音2列表
            if (msg.caps) { callRoomCaps = msg.caps; renderRoomCards(audioOnlyMode); }
            window.clearAllUserStatuses && window.clearAllUserStatuses('call');
            if (msg.users) msg.users.forEach(function(u) { window.setUserStatus && window.setUserStatus(u, 'call', true); });
            updateRoomCard('video', 1, msg.online || 0);
            updateRoomCard('video', 2, msg.count || 0);
            updateRoomCard('voice', 1, parseInt(msg.subtype) || 0);
            updateRoomCard('voice', 2, Array.isArray(msg.offline) ? msg.offline.length : 0);
            origHandleMessage(msg);
            break;
        case 'room_state':
            var rtype = msg.subtype || 'video';
            var msgRoom = msg.online || 1;
            var roomUsers = msg.users || [];
            updateRoomCard(rtype, msgRoom, roomUsers.length);
            window.clearAllUserStatuses && window.clearAllUserStatuses('call');
            if (msg.users) msg.users.forEach(function(u) { window.setUserStatus && window.setUserStatus(u, 'call', true); });
            if (videoCallActive && msgRoom === callRoomNum
                    && ((audioOnlyMode && rtype === 'voice') || (!audioOnlyMode && rtype === 'video'))) {
                roomStateAcked = true;
                if (roomUsers.indexOf(nickname) < 0) {
                    // 自己已不在房间里（被服务端移除）
                    showToast('你已离开' + (audioOnlyMode ? '语音' : '视频') + '房间', 'info');
                    hangupVideoCall();
                } else {
                    participantCount = msg.count || roomUsers.length;
                    try { tuneAllSenders(); } catch (e) { console.error(e); }
                    if (justJoinedCall) {
                        justJoinedCall = false;
                        roomUsers.forEach(function(user) {
                            if (user === nickname) return;
                            if (peerConnections[user]) return;
                            try { createPeerConnection(user, true); } catch (e) { console.error(e); }
                        });
                    }
                }
            }
            origHandleMessage(msg);
            break;
        default:
            origHandleMessage(msg);
    }
};

// ==================== Voice Quality Monitor ====================

function startVoiceQualityMonitor() {
    stopVoiceQualityMonitor();
    voiceQualityTimer = setInterval(pollVoiceQuality, 2000);
}

function stopVoiceQualityMonitor() {
    if (voiceQualityTimer) { clearInterval(voiceQualityTimer); voiceQualityTimer = null; }
    voiceQuality = {};
    updateAllQualityBadges();
}

/**
 * 质量采样。旧版用累计 packetsLost/(lost+received) 当"质量百分比"，
 * 刚断流时仍显示 100%；rtt 取的是任意 succeeded candidate-pair（可能不是实际使用的那对）。
 * 现在改为增量式，并取 nominated 的那对；同时读取 qualityLimitationReason 与可用上行带宽。
 */
async function pollVoiceQuality() {
    var pcs = Object.entries(peerConnections);
    for (var i = 0; i < pcs.length; i++) {
        var nick = pcs[i][0];
        var pc = pcs[i][1];
        try {
            var stats = await pc.getStats();
            var lost = 0, recv = 0, rtt = 0, limReason = 'none', availOut = 0;
            stats.forEach(function(report) {
                if (report.type === 'inbound-rtp') {
                    var kind = report.kind || report.mediaType;
                    if (kind !== 'audio' && kind !== 'video') return;
                    var prev = statsCache[report.id];
                    if (!prev) {
                        // 首次采样只记录基线，不计入增量，否则冷启动会算出巨大分母
                        statsCache[report.id] = { lost: report.packetsLost || 0, recv: report.packetsReceived || 0 };
                        return;
                    }
                    lost += Math.max(0, (report.packetsLost || 0) - prev.lost);
                    recv += Math.max(0, (report.packetsReceived || 0) - prev.recv);
                    statsCache[report.id] = { lost: report.packetsLost || 0, recv: report.packetsReceived || 0 };
                }
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    if (report.nominated && report.currentRoundTripTime != null) {
                        rtt = Math.round(report.currentRoundTripTime * 1000);
                    }
                    if (!report.nominated && rtt === 0 && report.currentRoundTripTime != null) {
                        rtt = Math.round(report.currentRoundTripTime * 1000);
                    }
                    if (report.availableOutgoingBitrate) availOut = Math.max(availOut, report.availableOutgoingBitrate);
                }
                if (report.type === 'outbound-rtp' && (report.kind === 'video') && report.qualityLimitationReason) {
                    limReason = report.qualityLimitationReason;
                }
            });
            var total = lost + recv;
            var lossRate = total > 0 ? lost / total : 0;
            var pct = total > 0 ? Math.round((1 - lossRate) * 100) : -1;
            var quality = lossRate < 0.02 ? 'good' : lossRate < 0.08 ? 'ok' : 'poor';
            voiceQuality[nick] = {
                pct: pct, quality: quality, rtt: rtt,
                loss: lossRate, lim: limReason,
                bitrate: Math.round(availOut / 1000)
            };
            adaptForQuality(nick, lossRate, rtt);
        } catch (e) {
            voiceQuality[nick] = { pct: -1, quality: 'poor', rtt: 0, loss: 0, lim: 'none', bitrate: 0 };
        }
    }
    updateAllQualityBadges();
}

/**
 * 网络自适应：连续 2 个采样周期差 → 降一档；连续 3 个周期良好 → 升一档。
 * 档位 0=全质量 / 1=降码率 / 2=停发视频（仅语音）。
 */
function adaptForQuality(nick, lossRate, rtt) {
    var bad = (lossRate > 0.05) || (rtt > 300);
    var good = (lossRate < 0.01) && (rtt < 150);
    var lvl = adaptiveLevel[nick] || 0;
    if (bad) {
        goodStreak[nick] = 0;
        badStreak[nick] = (badStreak[nick] || 0) + 1;
        if (badStreak[nick] >= 2 && lvl < 2) {
            badStreak[nick] = 0;
            adaptiveLevel[nick] = lvl + 1;
            console.warn('[ADAPT] ' + nick + ' 网络变差 → 降级到第 ' + adaptiveLevel[nick] + ' 档');
            tuneSenders(peerConnections[nick], nick).catch(function () {});
        }
    } else if (good) {
        badStreak[nick] = 0;
        goodStreak[nick] = (goodStreak[nick] || 0) + 1;
        if (goodStreak[nick] >= 3 && lvl > 0) {
            goodStreak[nick] = 0;
            adaptiveLevel[nick] = lvl - 1;
            console.log('[ADAPT] ' + nick + ' 网络恢复 → 升到第 ' + adaptiveLevel[nick] + ' 档');
            tuneSenders(peerConnections[nick], nick).catch(function () {});
        }
    }
}

function updateAllQualityBadges() {
    Object.keys(voiceQuality).forEach(function(nick) {
        var tile = document.getElementById('tile-' + nick);
        if (!tile) return;
        var badge = tile.querySelector('.quality-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'quality-badge';
            badge.style.cssText = 'position:absolute;top:4px;right:4px;font-size:10px;padding:1px 5px;border-radius:3px;color:#fff;white-space:nowrap';
            tile.appendChild(badge);
        }
        var q = voiceQuality[nick];
        var pctText = q.pct >= 0 ? q.pct + '%' : '...';
        var rttText = q.rtt > 0 ? ' ' + q.rtt + 'ms' : '';
        var limText = (q.lim === 'bandwidth') ? ' ↓带宽' : (q.lim === 'cpu' ? ' ↓CPU' : '');
        var lvlText = (adaptiveLevel[nick] > 0) ? (adaptiveLevel[nick] >= 2 ? ' 仅语音' : ' 降码率') : '';
        if (q.quality === 'good') {
            badge.textContent = '●' + pctText + rttText + lvlText;
            badge.style.background = 'rgba(76,175,80,0.8)';
        } else if (q.quality === 'ok') {
            badge.textContent = '●' + pctText + rttText + limText + lvlText;
            badge.style.background = 'rgba(255,152,0,0.8)';
        } else {
            badge.textContent = '●' + (q.pct >= 0 ? q.pct : '?') + '%' + rttText + limText + lvlText;
            badge.style.background = 'rgba(244,67,54,0.8)';
        }
    });
}

// ==================== UI ====================

function renderTileLabel(nick) {
    var isLocal = (nick === nickname);
    var tile = document.getElementById('tile-' + nick);
    if (!tile) return;
    var label = tile.querySelector('.tile-label');
    if (!label) return;
    var st = isLocal
        ? { audio: micEnabled, video: (camEnabled && !audioOnlyMode) }
        : (mediaStates[nick] || { audio: true, video: true });
    var text = nick + (isLocal ? ' (我)' : '');
    if (peerUnstable[nick]) text += ' ⏳重连中';
    var icons = [];
    if (!st.audio) icons.push('🔇');
    if (!st.video) icons.push('📸');
    if (icons.length) text += ' ' + icons.join('');
    label.textContent = text;
}

function updateLocalTileStream() {
    var v = document.querySelector('#tile-local video');
    if (v && myStream) {
        v.srcObject = myStream;
        v.play().catch(function () {});
    }
}

function addLocalTile() {
    const grid = $('video-grid');
    const tile = document.createElement('div');
    tile.className = 'video-tile local';
    tile.id = 'tile-local';
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;    // 正确属性名（旧版写 playsinline，iOS Safari 会全屏弹出）
    video.setAttribute('playsinline', '');   // 双保险：属性 + IDL
    video.srcObject = myStream;
    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = nickname + ' (我)';
    tile.appendChild(video);
    tile.appendChild(label);
    grid.appendChild(tile);
    renderTileLabel(nickname);
}

function addRemoteTile(targetNick, stream) {
    // 已有 tile → 只更新 srcObject，避免重建导致闪烁
    var existing = document.getElementById('tile-' + targetNick);
    if (existing) {
        var vid = existing.querySelector('video');
        if (vid) { vid.srcObject = stream; vid.play().catch(function () {}); }
        attachRemoteAudioFor(existing, stream, vid);   // ① 流类型可能变化（加视频轨等）
        renderTileLabel(targetNick);
        return;
    }
    const grid = $('video-grid');
    const tile = document.createElement('div');
    tile.className = 'video-tile remote';
    tile.id = 'tile-' + targetNick;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.volume = parseInt($('spk-vol').value) / 100;
    video.srcObject = stream;
    // ★ ① iOS 上 <video> 播放"纯音频流"（语音通话没有视频轨）不可靠：
    //    现象是"没声音 + 说话电平高亮不动"，而带视频轨的屏幕共享却正常。
    //    故纯音频流改用 <audio> 播放。
    attachRemoteAudioFor(tile, stream, video);
    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = targetNick;
    tile.appendChild(video);
    tile.appendChild(label);
    grid.appendChild(tile);
    renderTileLabel(targetNick);
}

function removeRemoteTile(targetNick) {
    const tile = document.getElementById('tile-' + targetNick);
    if (tile) tile.remove();
}

// ==================== Controls ====================
// 麦克风静音
$('btn-mic-toggle').addEventListener('click', () => {
    // ★ 不再用 `if (!myStream) return;` 提前返回 —— 只要 myStream 为空（或未进通话），
    //   整个按钮就毫无反应（用户反馈"点了没反应"）。这里改为：永远切换 UI，
    //   并对所有"可能存在的"音频路径都生效（原始轨 / 处理链轨 / 增益节点）。
    micEnabled = !micEnabled;
    try { applyAudioSessionType(); } catch (e) {}
    try { if (rawMicStream) rawMicStream.getAudioTracks().forEach(x => x.enabled = micEnabled); } catch (e) {}
    try { if (myStream) myStream.getAudioTracks().forEach(x => x.enabled = micEnabled); } catch (e) {}
    try {
        if (micChain && micChain.gain && micChain.gain.gain) {
            micChain.gain.gain.value = micEnabled ? (micGainPct / 100) * micDuckFactor : 0;
        }
    } catch (e) {}
    try { $('btn-mic-toggle').classList.toggle('off', !micEnabled); } catch (e) {}
    try { $('btn-mic-toggle').textContent = micEnabled ? '🎙️' : '🔇'; } catch (e) {}
    // ★ 真闭麦：静音时释放麦克风（让 iOS 有机会退出语音处理单元）；
    //   解除静音时重新采集并换回新轨。失败也不影响其它逻辑。
    try {
        if (!micEnabled) releaseMicCapture();
        else restoreMicCapture();
    } catch (e) { console.warn('[MIC] 采集切换失败:', e); }
    try { sendMediaState(); } catch (e) {}
    try { renderTileLabel(nickname); } catch (e) {}
    console.log('[MIC] 切换为 ' + (micEnabled ? '开' : '静音') + '｜myStream=' + (!!myStream) +
                ' rawMic=' + (!!rawMicStream) + ' chain=' + (!!(micChain && micChain.gain)));
});

/** 广播自己的麦克风/摄像头状态，让对端画面上显示角标 */
function sendMediaState() {
    if (!videoCallActive || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        type: 'media_state',
        nickname: nickname,
        audioOn: !!micEnabled,
        videoOn: !!(camEnabled && !audioOnlyMode)
    }));
}

$('btn-cam').addEventListener('click', async () => {
    if (!myStream) return;
    const hasVideo = myStream.getVideoTracks().length > 0;
    if (!hasVideo && !camEnabled) {
        // 进房时没开摄像头 → 现在打开（会通过 onnegotiationneeded 触发重协商）
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ video: getVideoConstraints() });
            const videoTrack = newStream.getVideoTracks()[0];
            const needsRenegotiation = [];
            try {
                myStream.addTrack(videoTrack);
                for (const [peerNick, pc] of Object.entries(peerConnections)) {
                    const s = pc.getSenders().find(x => x.track && x.track.kind === 'video');
                    if (s) {
                        // 已有 video sender（此前用 active=false 停发）→ 换轨即可，无需重协商
                        await s.replaceTrack(videoTrack).catch(function () {});
                    } else {
                        pc.addTrack(videoTrack, myStream);
                        needsRenegotiation.push(peerNick);   // 新增轨道必须重协商，否则对端收不到
                    }
                }
                newStream.getTracks().forEach(function(t) { if (t !== videoTrack) t.stop(); });
            } catch (e2) {
                newStream.getTracks().forEach(function(t) { t.stop(); });
                throw e2;
            }
            updateLocalTileStream();
            camEnabled = true;
            $('btn-cam').classList.remove('off');
            $('btn-cam').textContent = '📷';
            tuneAllSenders();
            needsRenegotiation.forEach(function (n) {
                var pc = peerConnections[n];
                if (pc) negotiate(n, pc);
            });
            sendMediaState();
            renderTileLabel(nickname);
            return;
        } catch (e) {
            showToast('无法开启摄像头', 'error');
            return;
        }
    }
    // 已有的摄像头开关（true 停发 / false 恢复）
    camEnabled = !camEnabled;
    myStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
    $('btn-cam').classList.toggle('off', !camEnabled);
    $('btn-cam').textContent = camEnabled ? '📷' : '📸';
    tuneAllSenders();          // encodings.active=false 真正停止发送，而不是发黑帧
    sendMediaState();
    renderTileLabel(nickname);
});

// ==================== 增强降噪（可选） ====================
// 说明：浏览器的 echoCancellation / noiseSuppression / autoGainControl 已在音频约束里打开，
// 这里是额外的「增强」档位（高通 + 压缩器 + 软扩展器）。旧版把它当作降噪主体并关了原生处理，
// 导致没有回声消除；现在它只是可选增强，默认关闭。
const NR_MODELS = [
    { name: 'off',    label: '\u25CB', desc: '关闭' },   // ○
    { name: 'gentle', label: '\u25D0', desc: '柔和',  hpf:60,  compTh:-24, compRatio:2,   compAttack:0.01, compRelease:0.15, expTh:0.005, expRatio:2.5 },  // ◐
    { name: 'strong', label: '\u25CF', desc: '强力',  hpf:120, compTh:-30, compRatio:5,   compAttack:0.003,compRelease:0.08, expTh:0.018, expRatio:8.0 }    // ●
];

// ④ 默认使用「强力降噪」档（用户要求：不降噪时收音范围过大）；并记住用户手动选择
var NR_DEFAULT_IDX = 2;
var NR_LS_KEY = 'uchat-nr-model';
function nrSavedIdx() {
    try {
        var v = localStorage.getItem(NR_LS_KEY);
        if (v !== null) {
            var n = parseInt(v, 10);
            if (!isNaN(n) && n >= 0 && n < NR_MODELS.length) return n;
        }
    } catch (e) {}
    return NR_DEFAULT_IDX;
}
let nrModelIdx = nrSavedIdx(); // 默认关闭

$('btn-nr').addEventListener('click', function () {
    if (!myStream) return;
    nrModelIdx = (nrModelIdx + 1) % NR_MODELS.length;
    var model = NR_MODELS[nrModelIdx];
    $('btn-nr').textContent = model.label;
    $('btn-nr').classList.toggle('on', nrModelIdx > 0);
    try { localStorage.setItem(NR_LS_KEY, String(nrModelIdx)); } catch (e) {}
    nrEnabled = nrModelIdx > 0;
    nrModel = nrEnabled ? model : null;
    try {
        buildAudioPipeline();
        rebuildMyStream();
        applyAudioTrackToPeers();
        updateLocalTileStream();
    } catch (e) {
        console.error('切换降噪失败:', e);
        nrModelIdx = 0; nrEnabled = false; nrModel = null;
        $('btn-nr').textContent = NR_MODELS[nrModelIdx].label;
        $('btn-nr').classList.remove('on');
    }
});

function resetNrButton() {
    nrEnabled = false;
    nrModel = null;
    nrModelIdx = 0;
    $('btn-nr').classList.toggle('on', nrModelIdx > 0);
    $('btn-nr').textContent = NR_MODELS[nrModelIdx].label;
}

// 兼容旧接口
async function enableNR(model) {
    nrEnabled = true;
    nrModel = model;
    buildAudioPipeline();
    rebuildMyStream();
    applyAudioTrackToPeers();
    updateLocalTileStream();
}

function disableNR() {
    nrEnabled = false;
    nrModel = null;
    buildAudioPipeline();
    rebuildMyStream();
    applyAudioTrackToPeers();
    updateLocalTileStream();
}

// ==================== 音频链（增益 + 可选增强降噪） ====================
/**
 * 旧版有两条独立的 WebAudio 链（attachMicGain 的增益链 + enableNR 的降噪链），
 * 切换顺序不同结果不同；且 enableNR 只 replaceTrack 已有 sender，
 * 之后新建的 PC 拿到的是未降噪的轨道 → 同一房间不同人听到的音质不一致。
 * 现在收敛为唯一一条链，myStream 始终暴露链的输出轨。
 */
function getSharedAudioCtx() {
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
        sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume().catch(function () {});
    return sharedAudioCtx;
}

let expanderLoopToken = 0;

var micDuckFactor = 1;      // 侧链闪避系数（屏幕共享放音时自动压低麦克风，见 screen.js）

/**
 * 侧链闪避：把麦克风增益乘上 factor（1=不闪避）。
 * 用途：屏幕共享播放电脑声音时，扬声器外放会被本机麦克风再次采集形成回声；
 *       此时压低麦克风即可消除回声，停止放音后恢复 —— 麦克风始终不被硬关闭。
 */
function setMicDuck(factor) {
    micDuckFactor = (typeof factor === 'number' && factor >= 0) ? factor : 1;
    try {
        if (micChain && micChain.gain && micChain.gain.gain) {
            micChain.gain.gain.value = (micGainPct / 100) * micDuckFactor;
        }
    } catch (e) { }
}
window.setMicDuck = setMicDuck;

function buildAudioPipeline() {
    // 拆掉旧链（保留 AudioContext 本身：远端说话检测也在用它）
    if (micChain) {
        try { micChain.src.disconnect(); } catch (e) {}
        micChain.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
        try { micChain.dest.disconnect(); } catch (e) {}
        micChain = null;
    }
    expanderLoopToken++;   // 让旧的扩展器循环自行退出
    if (!rawMicStream) return null;

    var ctx = getSharedAudioCtx();
    var src = ctx.createMediaStreamSource(new MediaStream(rawMicStream.getAudioTracks()));
    var nodes = [];
    var node = src;
    var gainNode = null;

    if (true) {   // 恒真：始终创建增益节点（侧链闪避 setMicDuck 需要它存在；value=1 时等价直通）
        gainNode = ctx.createGain();
        gainNode.gain.value = micGainPct / 100;
        node.connect(gainNode);
        nodes.push(gainNode);
        node = gainNode;
    }

    if (nrEnabled && nrModel) {
        var hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = nrModel.hpf;
        hpf.Q.value = 0.5;

        var comp = ctx.createDynamicsCompressor();
        comp.threshold.value = nrModel.compTh;
        comp.knee.value = 30;
        comp.ratio.value = nrModel.compRatio;
        comp.attack.value = nrModel.compAttack || 0.01;
        comp.release.value = nrModel.compRelease || 0.15;

        var expandGain = ctx.createGain();
        expandGain.gain.value = 1;

        node.connect(hpf);
        hpf.connect(comp);
        comp.connect(expandGain);
        nodes.push(hpf, comp, expandGain);
        node = expandGain;

        // 软扩展器：低于阈值时按比例压低增益（用 AnalyserNode 估 RMS）
        var analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.3;
        comp.connect(analyser);
        var data = new Uint8Array(analyser.frequencyBinCount);
        var token = expanderLoopToken;
        var model = nrModel;
        (function expandLoop() {
            if (token !== expanderLoopToken || !nrEnabled) return;
            analyser.getByteTimeDomainData(data);
            var sum = 0;
            for (var i = 0; i < data.length; i++) {
                var v = (data[i] - 128) / 128;
                sum += v * v;
            }
            var rms = Math.sqrt(sum / data.length);
            var targetGain;
            if (rms >= model.expTh) {
                targetGain = 1.0;
            } else {
                var dbBelow = 20 * Math.log10(Math.max(rms, 0.00003) / model.expTh);
                var dbReduction = dbBelow * (model.expRatio - 1);
                targetGain = Math.max(Math.pow(10, dbReduction / 20), 0.06);
            }
            expandGain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.05);
            requestAnimationFrame(expandLoop);
        })();
    }

    var dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    micChain = { src: src, nodes: nodes, dest: dest, outTrack: dest.stream.getAudioTracks()[0], gain: gainNode };
    return micChain;
}

/** myStream 只暴露处理链的输出音频轨 + 原视频轨 */
function rebuildMyStream() {
    if (!micChain || !micChain.outTrack) return;
    var videoTracks = myStream ? myStream.getVideoTracks() : [];
    var out = new MediaStream();
    out.addTrack(micChain.outTrack);
    videoTracks.forEach(function (t) { out.addTrack(t); });
    myStream = out;
}

/** 把处理后的音频轨同步给所有已有对等体 */
function applyAudioTrackToPeers() {
    if (!micChain || !micChain.outTrack) return;
    var track = micChain.outTrack;
    Object.values(peerConnections).forEach(function (pc) {
        var s = pc.getSenders().find(function (x) { return x.track && x.track.kind === 'audio'; });
        if (s) s.replaceTrack(track).catch(function () {});
    });
}

function cleanupMicGain() {
    if (micChain) {
        try { micChain.src.disconnect(); } catch (e) {}
        micChain.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
        try { micChain.dest.disconnect(); } catch (e) {}
        micChain = null;
    }
    expanderLoopToken++;
}

// 兼容旧接口名
async function attachMicGain(rawStream) {
    rawMicStream = rawStream;
    try {
        micGainPct = parseInt($('mic-vol').value, 10) || 0;
    } catch (e) {}
    buildAudioPipeline();
    rebuildMyStream();
    return myStream;
}

$('video-hangup').addEventListener('click', () => hangupVideoCall());

/** 重连后重新加入通话房间。与 enterCallRoom 不同：尽量复用已有 myStream */
function rejoinCallRoom() {
    if (!videoCallActive || callRoomNum <= 0) return;

    // 关闭可能已失效的旧 peerConnections
    teardownAllPeers();

    function doRejoin() {
        justJoinedCall = true;
        roomStateAcked = false;
        var sub = audioOnlyMode ? 'voice' : 'video';
        ws.send(JSON.stringify({ type: 'room_enter', nickname: nickname, online: callRoomNum, subtype: sub }));
        sendMediaState();
        startVoiceQualityMonitor();

        var fallbackRoom = callRoomNum, fallbackSub = sub;
        setTimeout(function() {
            if (videoCallActive && justJoinedCall && !roomStateAcked && ws && ws.readyState === WebSocket.OPEN) {
                console.warn('[CALL] 重连后未收到 room_state，重发一次 room_enter');
                ws.send(JSON.stringify({ type: "room_enter", nickname: nickname, online: fallbackRoom, subtype: fallbackSub }));
            }
        }, 5000);
    }

    // 检查已有 stream 是否还活着
    var tracksLive = myStream && myStream.getTracks().length > 0 &&
        myStream.getTracks().every(function(t) { return t.readyState === 'live'; });
    if (tracksLive) {
        try { addLocalTile(); } catch(e) {}
        if (audioOnlyMode) {
            var localTile = document.getElementById('tile-local');
            if (localTile) localTile.style.display = 'none';
            var vp = document.getElementById('voice-participants');
            if (vp) vp.style.display = 'flex';
            updateVoiceParticipantList();
            startSpeakingDetection();
        }
        updateLocalTileStream();
        doRejoin();
        return;
    }

    // myStream 已失效，重新请求设备
    stopMyStream();
    cleanupMicGain();

    var constraints = { audio: getAudioConstraints() };
    if (!audioOnlyMode && camEnabled) constraints.video = getVideoConstraints();
    loadIceServers().then(function () {
        return navigator.mediaDevices.getUserMedia(constraints);
    }).then(function(s) {
        rawMicStream = s;
        myStream = s;
        buildAudioPipeline();
        rebuildMyStream();
        try { addLocalTile(); } catch(e) {}
        updateLocalTileStream();
        doRejoin();
    }).catch(function() {
        showToast('重连通话失败：无法访问设备，请手动重新加入', 'error');
        hangupVideoCall();
    });
}

function hangupVideoCall() {
    stopVoiceQualityMonitor();
    justJoinedCall = false;
    videoCallActive = false;
    var wasAudioOnly = audioOnlyMode;
    var leavingRoom = callRoomNum;

    teardownAllPeers();
    stopMyStream();
    cleanupMicGain();
    resetNrButton();

    $('video-grid').innerHTML = '';
    $('voice-participants').style.display = 'none';
    stopSpeakingDetection();
    const panel = $('video-overlay');
    panel.classList.remove('visible');
    panel.style.left = ''; panel.style.top = '';
    panel.style.right = '16px'; panel.style.bottom = '120px';
    panel.style.width = '380px'; panel.style.height = '';
    $('spk-vol').value = localStorage.getItem(spkVolKey()) || '100';
    $('mic-vol').value = localStorage.getItem(micVolKey()) || '100';
    panel.style.borderRadius = '';
    $('video-grid').style.display = '';
    $('video-controls').style.display = '';
    $('btn-video-max').textContent = '🗖';
    $('btn-video-min').textContent = '🗕';
    $('btn-video-max').style.display = '';
    $('btn-video-min').style.display = '';

    $('btn-mic-toggle').textContent = '🎙️';
    $('btn-mic-toggle').classList.remove('off');
    $('btn-cam').textContent = '📷';
    $('btn-cam').classList.remove('off');
    $('btn-voice-call').classList.remove('active');
    micEnabled = true;
    camEnabled = true;
    audioOnlyMode = false;
    participantCount = 0;
    callRoomNum = 0;

    clearAllPeerMeta();

    if (ws && ws.readyState === WebSocket.OPEN) {
        if (!window.__suppressLeaveSend) { ws.send(JSON.stringify({ type: "room_leave", nickname: nickname, online: leavingRoom, subtype: wasAudioOnly ? 'voice' : 'video' })) };
    }
}

// ==================== Drag & Resize ====================
(function initVideoPanelDrag() {
    const panel = $('video-overlay');
    const header = $('video-header');
    let dragging = false, startX, startY, startLeft, startTop;

    header.addEventListener('pointerdown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top;
        panel.style.transition = 'none';
        e.preventDefault();
    });

    document.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        panel.style.left = (startLeft + e.clientX - startX) + 'px';
        panel.style.top = (startTop + e.clientY - startY) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    });

    document.addEventListener('pointerup', () => {
        if (dragging) { dragging = false; panel.style.transition = ''; }
    });

    // Maximize / restore
    let maximized = false, savedStyle = {};
    $('btn-video-max').addEventListener('click', () => {
        if (maximized) {
            Object.assign(panel.style, savedStyle);
            $('btn-video-max').textContent = '🗖';
        } else {
            savedStyle = { left: panel.style.left, top: panel.style.top,
                right: panel.style.right, bottom: panel.style.bottom,
                width: panel.style.width, height: panel.style.height };
            panel.style.left = '0'; panel.style.top = '0';
            panel.style.right = '0'; panel.style.bottom = '0';
            panel.style.width = '100%'; panel.style.height = '100%';
            panel.style.borderRadius = '0';
            $('btn-video-max').textContent = '🗗';
        }
        maximized = !maximized;
    });

    // Minimize: shrink to just the header
    let minimized = false;
    $('btn-video-min').addEventListener('click', () => {
        const grid = $('video-grid');
        const controls = $('video-controls');
        if (minimized) {
            grid.style.display = '';
            controls.style.display = '';
            $('btn-video-min').textContent = '🗕';
        } else {
            grid.style.display = 'none';
            controls.style.display = 'none';
            $('btn-video-min').textContent = '🗖';
        }
        minimized = !minimized;
    });
})();

// ==================== Voice-Only Participants List & Speaking Detection ====================
var voiceAnalysers = {};   // nickname -> { analyser, data, level, lastSpeak }
var voiceSpeakTimer = null;
var SPEAK_THRESHOLD = 0.03; // RMS 阈值，超过即认为在说话
var SPEAK_HOLD_MS = 600;    // 停止说话后保持高亮时间

function startSpeakingDetection() {
    stopSpeakingDetection();
    voiceSpeakTimer = setInterval(pollAudioLevels, 150); // 150ms 检测一次
}

function stopSpeakingDetection() {
    if (voiceSpeakTimer) { clearInterval(voiceSpeakTimer); voiceSpeakTimer = null; }
    voiceAnalysers = {};
}

/**
 * 为远端音频轨建一个 AnalyserNode。
 * 旧版每个 peer 各建一个 AudioContext 且从不 close —— 反复进出多人房会累积到浏览器上限，
 * 之后说话检测静默失效。现在共用同一个 AudioContext。
 */
function attachAudioAnalyser(targetNick, stream) {
    if (!stream) return;
    var audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;
    if (voiceAnalysers[targetNick]) return;
    try {
        var ctx = getSharedAudioCtx();
        var src = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
        var analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.4;
        src.connect(analyser);
        voiceAnalysers[targetNick] = {
            src: src, analyser: analyser,
            data: new Uint8Array(analyser.frequencyBinCount),
            level: 0, lastSpeak: 0
        };
    } catch (e) { console.warn('attachAudioAnalyser failed:', e && e.message); }
}

function releaseAudioAnalyser(nick) {
    var a = voiceAnalysers[nick];
    if (!a) return;
    try { a.src.disconnect(); } catch (e) {}
    try { a.analyser.disconnect(); } catch (e) {}
    delete voiceAnalysers[nick];
}

function pollAudioLevels() {
    var now = Date.now();
    for (var nick in voiceAnalysers) {
        var a = voiceAnalysers[nick];
        a.analyser.getByteTimeDomainData(a.data);
        var sum = 0;
        for (var i = 0; i < a.data.length; i++) { var v = (a.data[i] - 128) / 128; sum += v * v; }
        a.level = Math.sqrt(sum / a.data.length);
        if (a.level > SPEAK_THRESHOLD) a.lastSpeak = now;
    }
    updateVoiceParticipantList();
}

function updateVoiceParticipantList() {
    var panel = $('voice-participants');
    if (!panel) return;
    if (panel.style.display === 'none') return;   // 语音面板未显示时不必重建 DOM（150ms 一次）
    var myNick = typeof nickname !== 'undefined' ? nickname : '';
    panel.innerHTML = '';

    // 本地用户
    var meEntry = document.createElement('div');
    meEntry.className = 'voice-participant';
    var meQuality = voiceQuality[myNick] || { pct: -1, quality: 'good', rtt: 0 };
    var meSpeaking = (voiceAnalysers[myNick] && voiceAnalysers[myNick].lastSpeak > Date.now() - SPEAK_HOLD_MS) || false;
    meEntry.style.cssText = 'padding:6px 10px;border-radius:6px;font-size:13px;color:#fff;display:flex;align-items:center;gap:8px;'
        + (meSpeaking ? 'background:rgba(76,175,80,0.35);' : 'background:rgba(255,255,255,0.08);');
    var mePct = meQuality.pct >= 0 ? meQuality.pct + '%' : '...';
    meEntry.innerHTML = '<span style="font-weight:600">' + esc(myNick) + ' (我)</span>'
        + '<span style="margin-left:auto;font-size:11px;color:#aaa">' + (micEnabled ? '🎤 ' : '🔇 ') + mePct + '</span>';
    panel.appendChild(meEntry);

    // 远程用户
    var peers = Object.keys(peerConnections);
    if (peers.length === 0) {
        var empty = document.createElement('div');
        empty.style.cssText = 'padding:8px;font-size:12px;color:#999;text-align:center';
        empty.textContent = '等待其他人加入...';
        panel.appendChild(empty);
        return;
    }
    peers.forEach(function(nick) {
        var entry = document.createElement('div');
        entry.className = 'voice-participant';
        var q = voiceQuality[nick] || { pct: -1, quality: 'good', rtt: 0 };
        var pctText = q.pct >= 0 ? q.pct + '%' : '...';
        var rttText = q.rtt > 0 ? ' ' + q.rtt + 'ms' : '';
        var dotColor = q.quality === 'good' ? '#4caf50' : q.quality === 'ok' ? '#ff9800' : '#f44336';
        var speaking = (voiceAnalysers[nick] && voiceAnalysers[nick].lastSpeak > Date.now() - SPEAK_HOLD_MS) || false;
        entry.style.cssText = 'padding:6px 10px;border-radius:6px;font-size:13px;color:#fff;display:flex;align-items:center;gap:8px;'
            + (speaking ? 'background:rgba(76,175,80,0.35);' : 'background:rgba(255,255,255,0.08);');
        var mst = mediaStates[nick] || { audio: true, video: true };
        var icons = (mst.audio ? '' : ' 🔇') + (mst.video ? '' : ' 📸');
        var state = peerUnstable[nick] ? ' ⏳重连中' : (adaptiveLevel[nick] > 0 ? (adaptiveLevel[nick] >= 2 ? ' ↓仅语音' : ' ↓降码率') : '');
        entry.innerHTML = '<span style="font-weight:600">' + esc(nick) + icons + '</span>'
            + '<span style="margin-left:auto;font-size:11px">'
            + '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + dotColor + ';margin-right:4px"></span>'
            + pctText + rttText + state + '</span>';
        panel.appendChild(entry);
    });
}

// ==================== Misc ====================

// 输出音量
function applyOutputVolume() {
    const vol = parseInt($('spk-vol').value) / 100;
    document.querySelectorAll('.video-tile video, #screen-viewer video').forEach(v => { v.volume = vol; });
}
$('spk-vol').addEventListener('input', applyOutputVolume);

// 麦克风增益：直接改链上的 GainNode（不再重建整条链）
$('mic-vol').addEventListener('input', () => {
    micGainPct = parseInt($('mic-vol').value, 10) || 0;
    localStorage.setItem(micVolKey(), $('mic-vol').value);
    if (typeof saveUserPrefs === 'function') saveUserPrefs();
    if (!micChain) return;
    if (micChain.gain) {
        micChain.gain.gain.value = (micGainPct / 100) * micDuckFactor;
    } else if (micGainPct !== 100) {
        // 原本 100% 时链上没有增益节点 → 重建一次把节点插进去
        buildAudioPipeline();
        rebuildMyStream();
        applyAudioTrackToPeers();
        updateLocalTileStream();
    }
});

// Init saved values
const savedSpk = localStorage.getItem(spkVolKey()) || '100';
const savedMic = localStorage.getItem(micVolKey()) || '100';
$('spk-vol').value = savedSpk;
$('mic-vol').value = savedMic;
micGainPct = parseInt(savedMic, 10) || 0;
$('spk-vol').addEventListener('change', () => { localStorage.setItem(spkVolKey(), $('spk-vol').value); if (typeof saveUserPrefs === 'function') saveUserPrefs(); });

// 网络回切（切 WiFi / 恢复联网）→ 主动重协商，而不是干等 ICE 超时
window.addEventListener('online', function () {
    if (!videoCallActive) return;
    console.log('[NET] 网络恢复，尝试重建通话连接');
    loadIceServers(true);
    Object.keys(peerConnections).forEach(function (nick) {
        var pc = peerConnections[nick];
        try {
            pc.setConfiguration(rtcConfig);
            pc.restartIce();
            negotiate(nick, pc);
        } catch (e) {}
    });
});

// 本地麦克风设备被拔掉/静音时提示
document.addEventListener('visibilitychange', function () {
    if (!document.hidden || !videoCallActive || !myStream) return;
    myStream.getTracks().forEach(function (t) {
        if (t.readyState === 'ended') showToast('本地设备已断开，通话可能中断', 'error');
    });
});


// ==================== 远端音频播放（iOS 兼容） ====================
/**
 * 为远端流选择合适的播放元素：
 *  - 有视频轨（视频通话 / 屏幕共享）⇒ 用 <video>，把 <audio> 静音
 *  - 纯音频（语音通话）⇒ 用 <audio>，把 <video> 静音
 * 依据：iOS Safari 上 <video> 播放纯音频流常常完全不出声、且 WebAudio 分析器读不到电平
 *      （表现为"没有被分享者听到对方语音、对方方块也不闪绿色"）。
 */
function attachRemoteAudioFor(tile, stream, videoEl) {
    try {
        if (!tile || !stream) return;
        var hasVideo = stream.getVideoTracks ? stream.getVideoTracks().length > 0 : false;
        var au = tile.querySelector('audio.remote-audio');
        var vol = 1;
        try { vol = (parseInt($('spk-vol').value, 10) || 100) / 100; } catch (e) {}
        if (hasVideo) {
            if (au) { try { au.pause(); au.srcObject = null; } catch (e) {} }
            if (videoEl) { videoEl.muted = false; try { videoEl.volume = vol; } catch (e) {} }
        } else {
            if (!au) {
                au = document.createElement('audio');
                au.className = 'remote-audio';
                au.autoplay = true;
                au.setAttribute('playsinline', '');
                tile.appendChild(au);
            }
            au.volume = vol;
            if (au.srcObject !== stream) au.srcObject = stream;
            var p = au.play();
            if (p && p.catch) {
                p.catch(function () {
                    // iOS 未获得用户手势时会被拒绝：提示一次并等首次触摸解锁
                    if (!window.__audioHintShown && typeof showToast === 'function') {
                        window.__audioHintShown = true;
                        showToast('点一下页面任意处即可听到对方声音', 'info');
                    }
                });
            }
            if (videoEl) videoEl.muted = true;   // 同一路声音不要播两遍
        }
        console.log('[AUDIO] 远端播放元素: ' + (hasVideo ? 'video（含视频轨）' : 'audio（纯音频）') +
                    ' volume=' + vol);
    } catch (e) { console.warn('[AUDIO] attachRemoteAudioFor 失败:', e); }
}

// 兜底：首次触摸/点击时解锁远端音频（iOS：非用户手势触发的有声播放会被拦）
var _audioUnlocked = false;
function unlockRemoteAudio(reason) {
    try {
        // ★ 同时确保麦克风处理链在出声（iOS：AudioContext 需在用户手势里 resume）
        try { ensureMicPipelineAlive(reason || 'gesture'); } catch (e) {}
        try {
            var ctx = (typeof getSharedAudioCtx === 'function') ? getSharedAudioCtx() : null;
            if (ctx && ctx.state === 'suspended') ctx.resume().then(function () { }, function () { });
        } catch (e) {}
        var els = document.querySelectorAll('#video-grid video, #video-grid audio.remote-audio, #screen-video');
        els.forEach(function (v) {
            if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        });
        if (!_audioUnlocked) {
            _audioUnlocked = true;
            console.log('[AUDIO] 已解锁远端音频播放（' + reason + '），媒体元素 ' + els.length + ' 个');
        }
    } catch (e) {}
}
document.addEventListener('touchstart', function () { unlockRemoteAudio('touchstart'); }, { passive: true });
document.addEventListener('click', function () { unlockRemoteAudio('click'); });



// ==================== iOS：确保麦克风处理链真的在出声 ====================
/**
 * iOS Safari 上，若 AudioContext 处于 suspended（必须靠用户手势才能 resume），
 * 由 MediaStreamAudioDestinationNode 输出的处理链轨会是【纯静音】——
 * 表现为：轨道 on/live、连接 connected，但对端收不到任何电平（指示灯不闪）。
 * 处理：先 resume；若仍未 running，则把音频 sender 直接换成原始麦克风轨（绕过处理链）。
 */
var _micRawFallbackDone = false;
function ensureMicPipelineAlive(reason) {
    try {
        var ctx = null;
        try { ctx = (typeof getSharedAudioCtx === 'function') ? getSharedAudioCtx() : null; } catch (e) {}
        var state = ctx ? ctx.state : 'none';
        console.log('[MIC] ensureMicPipelineAlive(' + reason + ') ctx.state=' + state);
        if (ctx && ctx.state === 'suspended') {
            try { ctx.resume(); } catch (e) {}
        }
        // 稍等一拍再看状态：resume 是异步的
        setTimeout(function () {
            try {
                var st2 = ctx ? ctx.state : 'none';
                console.log('[MIC] resume 后 ctx.state=' + st2);
                if (st2 === 'running') return;
                if (typeof rawMicStream === 'undefined' || !rawMicStream) return;
                if (_micRawFallbackDone) return;
                var raw = rawMicStream.getAudioTracks()[0];
                if (!raw) return;
                var n = 0;
                if (typeof peerConnections !== 'undefined' && peerConnections) {
                    Object.keys(peerConnections).forEach(function (k) {
                        try {
                            var pc = peerConnections[k];
                            var s = pc.getSenders().find(function (x) { return x.track && x.track.kind === 'audio'; });
                            if (s && s.track !== raw) { s.replaceTrack(raw).catch(function () {}); n++; }
                        } catch (e) {}
                    });
                }
                _micRawFallbackDone = true;
                console.log('[MIC] AudioContext 不可用 ⇒ 已改用原始麦克风轨直接发送（' + n + ' 条连接）');
            } catch (e) {}
        }, 400);
    } catch (e) { console.warn('[MIC] ensureMicPipelineAlive 失败:', e); }
}


// ==================== 真闭麦 / 恢复采集 ====================
// 背景：iOS 会把 WebRTC 音频整体交给语音处理单元(VPIO)做 AEC/AGC/降噪，
//       表现为"听屏幕共享音频被降噪、变调"，且与麦克风开关无关
//       —— 因为 track.enabled=false 只是静音轨道，**采集会话并没有结束**。
// 本实现：静音 ⇒ 真正 track.stop() 释放麦克风（让 WebKit 有机会退出 VPIO）；
//         解除静音 ⇒ 重新 getUserMedia + 重建处理链 + 把发送端换回新轨。
var _micReleased = false;

function releaseMicCapture() {
    try {
        _micReleased = true;
        try { if (rawMicStream) rawMicStream.getTracks().forEach(function (x) { try { x.stop(); } catch (e) {} }); } catch (e) {}
        try { if (myStream) myStream.getAudioTracks().forEach(function (x) { try { x.stop(); } catch (e) {} }); } catch (e) {}
        try { if (micChain && micChain.outTrack) { try { micChain.outTrack.stop(); } catch (e) {} } } catch (e) {}
        try {
            if (typeof sharedAudioCtx !== 'undefined' && sharedAudioCtx && sharedAudioCtx.state === 'running') {
                sharedAudioCtx.suspend().then(function () { }, function () { });
            }
        } catch (e) {}
        console.log('[MIC] 已真正释放麦克风采集（真闭麦）');
    } catch (e) { console.warn('[MIC] releaseMicCapture 失败:', e); }
}

async function restoreMicCapture() {
    try {
        if (!_micReleased) return true;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
        var s = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false
        });
        rawMicStream = s;
        if (typeof sharedAudioCtx !== 'undefined' && sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
            try { await sharedAudioCtx.resume(); } catch (e) {}
        }
        if (typeof buildAudioPipeline === 'function') buildAudioPipeline();   // 重建处理链
        else myStream = s;
        // ★ 关键：处理链重建后必须把 myStream 也指向【新轨】，否则 myStream 仍指向已结束的旧轨
        //   ⇒ 之后新加入的人（应用为其 addTrack(myStream 的音频轨)）将完全听不到你。
        //   做法：用新的处理链输出轨 + 保留仍存活的摄像头轨，重建一个 MediaStream。
        try {
            var newAudio = (typeof micChain !== 'undefined' && micChain && micChain.outTrack)
                ? micChain.outTrack : s.getAudioTracks()[0];
            var keepVideo = [];
            try {
                if (myStream) keepVideo = myStream.getVideoTracks().filter(function (v) { return v.readyState === 'live'; });
            } catch (e) {}
            var rebuilt = new MediaStream();
            if (newAudio) rebuilt.addTrack(newAudio);
            keepVideo.forEach(function (v) { try { rebuilt.addTrack(v); } catch (e) {} });
            myStream = rebuilt;
            console.log('[MIC] myStream 已指向新轨（音轨=' + (newAudio ? newAudio.readyState : 'none') +
                        ' 视频轨=' + keepVideo.length + '）');
        } catch (e) { console.warn('[MIC] 重建 myStream 失败:', e); }
        var newTrack = (typeof micChain !== 'undefined' && micChain && micChain.outTrack) || s.getAudioTracks()[0];
        var n = 0;
        try {
            Object.keys(peerConnections || {}).forEach(function (k) {
                try {
                    var pc = peerConnections[k];
                    var snd = pc.getSenders().find(function (x) { return x.track && x.track.kind === 'audio'; });
                    if (snd && newTrack) { snd.replaceTrack(newTrack).catch(function () {}); n++; }
                } catch (e) {}
            });
        } catch (e) {}
        _micReleased = false;
        console.log('[MIC] 已重新采集麦克风并把 ' + n + ' 条连接换回新轨');
        return true;
    } catch (e) {
        console.warn('[MIC] restoreMicCapture 失败:', e);
        if (typeof showToast === 'function') showToast('麦克风恢复失败，请重新进一次通话', 'error');
        return false;
    }
}

window.releaseMicCapture = releaseMicCapture;
window.restoreMicCapture = restoreMicCapture;
