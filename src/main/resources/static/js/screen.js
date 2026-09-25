/* ===== screen.js — 屏幕共享 (WebRTC getDisplayMedia) ===== */

let screenStream = null;
let screenPeerConnections = {};
let screenActive = false;
var screenMicWasEnabled = null;   // 共享系统音频前的麦克风状态（防回音：临时闭麦）
let roomScreenActive = false;
let currentScreenSharer = null;
let screenStatusPending = false; // 等待服务端屏共享状态响应中
let screenStatusCallback = null; // 收到响应后的回调
let screenQuality = '720p';
let screenFps = 15;

// Quality presets for getDisplayMedia
const qualityPresets = {
    '480p':  { width: 854,  height: 480 },
    '720p':  { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
    '2k':    { width: 2560, height: 1440 }
};
// 帧率可选值（2026-09-25 用户实测：90/120fps 带宽根本不够 ⇒ 去掉，改成 24/36/48/60）
const fpsOptions = [24, 36, 48, 60];
const FPS_MIGRATE = { '15': 24, '30': 36, '60': 60, '90': 60, '120': 60 };
/** 读帧率设置；老值（15/30/90/120）自动迁移到新档位 */
function readScreenFps() {
    var raw = localStorage.getItem('screen-fps');
    if (raw === null || raw === '') return 24;
    var v = parseInt(raw, 10);
    if (fpsOptions.indexOf(v) >= 0) return v;
    var migrated = FPS_MIGRATE[String(raw)] || 24;
    try { localStorage.setItem('screen-fps', String(migrated)); } catch (e) { }
    return migrated;
}

// ==================== Start Screen Share ====================
$('btn-screen-share').addEventListener('click', () => {
    if (isOffline()) { showToast('连接已断开，请先重连', 'error'); return; }
    if (screenActive) {
        // 共享者关掉了预览窗口 → 重新调出
        $('screen-viewer').classList.add('visible');
        $('screen-video').srcObject = screenStream;
        return;
    }
    // 已知有人在共享 → 调出观看窗口
    if (currentScreenSharer !== null) {
        $('screen-viewer').classList.add('visible');
        showToast('正在观看 ' + currentScreenSharer + ' 的共享', 'info');
        if (ws && ws.readyState === WebSocket.OPEN && !screenPeerConnections[currentScreenSharer]) {
            screenViewerDismissed = false;      // 用户又主动点开观看
            ws.send(JSON.stringify({
                type: 'screen_watch', nickname: nickname, receiver: currentScreenSharer
            }));
        }
        return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('连接未就绪', 'error'); return; }

    // 向服务端（唯一权威来源）确认
    screenStatusPending = true;
    screenStatusCallback = function(status) {
        screenStatusPending = false;
        if (status.active) {
            roomScreenActive = true;
            currentScreenSharer = status.sharer;
            $('btn-screen-share').classList.add('off');
            if (!$('screen-viewer').classList.contains('visible')) {
                $('screen-viewer').classList.add('visible');
            }
            showToast(status.sharer + ' 正在共享屏幕', 'info');
            if (!screenPeerConnections[status.sharer]) {
                ws.send(JSON.stringify({
                    type: 'screen_watch', nickname: nickname, receiver: status.sharer
                }));
            }
        } else {
            startScreenShare();
        }
    };
    ws.send(JSON.stringify({ type: 'screen_status' }));
    setTimeout(function() {
        if (screenStatusPending && screenStatusCallback) {
            screenStatusPending = false;
            screenStatusCallback({ active: false });
        }
    }, 3000);
});

async function startScreenShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        showToast('您的浏览器不支持屏幕共享', 'error');
        return;
    }

    // Read default quality from settings
    const defaultQuality = localStorage.getItem('screen-quality') || '720p';
    screenQuality = defaultQuality;
    const preset = qualityPresets[screenQuality];
    screenFps = readScreenFps();

    // 屏幕共享要带系统音频（用户反馈：只有画面没有声音）。
    // 注意：audio:true 只在 Chrome/Edge 支持，且需要用户在选择器里选「整个屏幕」或「标签页」
    // 并勾选"分享音频"（选「窗口」无法采集音频）。Safari/Firefox 不支持 —— 故遇到
    // "不支持音频"类错误时自动回退为纯画面共享，不让整个功能失败。
    const videoConstraints = {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: screenFps },
        cursor: 'always'
    };
    try {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: videoConstraints,
                audio: true
            });
        } catch (eAudio) {
            // 用户主动取消：不要立刻再弹一次选择器
            if (eAudio && eAudio.name === 'NotAllowedError') throw eAudio;
            console.warn('[SCREEN] 带音频采集失败，回退为纯画面:', eAudio && eAudio.name);
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: videoConstraints,
                audio: false
            });
        }
    } catch (e) {
        if (e.name === 'NotAllowedError') showToast('屏幕共享被取消', 'info');
        else if (e.name === 'AbortError') showToast('屏幕共享启动超时，请重试', 'error');
        else showToast('屏幕共享失败: ' + e.message, 'error');
        return;
    }

    screenActive = true;
    roomScreenActive = true;
    currentScreenSharer = nickname;
    screenPeerConnections = {};

    $('screen-bar').classList.add('visible');
    $('screen-quality').value = screenQuality;
    $('screen-fps').value = screenFps;
    $('screen-viewer').classList.add('visible');
    // ★ 共享者本地预览必须静音：否则电脑会播放刚采集到的"系统音频"，
    //   而这个播放出来的声音又会被"共享系统音频"重新采集 ⇒ 数字正反馈回路
    //   （现象：与设备距离无关、回声越叠越大、双方都听得到）。
    //   观看端不受影响 —— 观看端在 ontrack 里会显式 muted=false（见 handleScreenOffer）。
    $('screen-video').muted = true;
    $('screen-video').srcObject = screenStream;
    startShareStatsMonitor();          // 共享者：开始估算上行占用

    // 通知服务器
    ws.send(JSON.stringify({ type: 'screen_start', nickname: nickname, quality: screenQuality }));
    screenStream.getVideoTracks()[0].addEventListener('ended', () => stopScreenShare());
    var _hasAudio = screenStream.getAudioTracks().length > 0;
    showToast('屏幕共享已开始 (' + screenQuality + (_hasAudio ? '，含系统音频' : '，仅画面') + ')', 'success');
    if (!_hasAudio) {
        showToast('提示：要共享声音请在选择器里选「整个屏幕」或「标签页」并勾选"分享音频"', 'info');
    } else {
        // ★ 防回音：系统音频与麦克风会形成"双路回声"
        //   （电脑外放的声音会被本机麦克风再次采集，经语音通话那条路延迟送达对端，
        //     而浏览器 AEC 只能消除"远端声音"，消不掉本机系统音频）
        //   因此共享系统音频时自动闭麦，共享结束再恢复。
        // ★ 防回音（按用户要求：麦克风常开、不做硬闭麦）：侧链闪避
        //   回声的物理来源是"扬声器外放的声音被本机麦克风再次采集"，
        //   压低系统音频并不能消除声学回声，只能压低麦克风。
        //   做法：系统音频正在出声 ⇒ 麦克风增益压到 8%；停止出声 350ms 后恢复 100%。
        //   想要"完全同时说话 + 放音且无回声"：电脑端戴耳机（声学路径消失）。
        startEchoDucking();
        ensureDuckButton();
        showToast('已开启"回音闪避"：电脑放声时自动压低麦克风；要完全同时说话+放音请给电脑戴耳机', 'info');
    }

    // 始终使用独立的 screen peer connections（可靠，不依赖 replaceTrack 竞态）
    setTimeout(() => {
        if (!screenActive) return;
        onlineUsers.forEach(target => {
            if (target !== nickname) createScreenOfferFor(target);
        });
    }, 600);
}

// ==================== Stop Screen Share ====================
$('btn-screen-stop').addEventListener('click', () => stopScreenShare());
// Close button: hide viewer, sharing continues (can reopen)
$('screen-close').addEventListener('click', () => {
    // 通知服务端"我不看了" ⇒ 服务端转告共享者释放那一路
    // （否则共享者的上行估算会一直把已经关掉的人算进去，直到 ICE 超时）
    try {
        if (currentScreenSharer && currentScreenSharer !== nickname && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'screen_unwatch', nickname: nickname, receiver: currentScreenSharer }));
        }
    } catch (e) { }
    if (typeof stopScreenStatsMonitor === 'function') stopScreenStatsMonitor();
    // ★ 本地也要把这条 PC 关掉并清引用：否则共享者那边已经释放了，我们这边还留着"已连接"的假象，
    //   再点观看时会因为"已有 PC"而不发请求（表现为黑屏 + 人数对不上）。
    try {
        if (currentScreenSharer && screenPeerConnections[currentScreenSharer]) {
            screenPeerConnections[currentScreenSharer].close();
            delete screenPeerConnections[currentScreenSharer];
        }
    } catch (e) { }
    screenViewerDismissed = true;
    $('screen-viewer').classList.remove('visible');
    $('screen-viewer').classList.remove('fullscreen');
    screenMaxed = false;
    $('screen-max').textContent = '全屏';
});

// Maximize / restore screen viewer
let screenMaxed = false;
$('screen-max').addEventListener('click', () => {
    screenMaxed = !screenMaxed;
    if (screenMaxed) {
        $('screen-viewer').classList.add('fullscreen');
        $('screen-max').textContent = '还原';
    } else {
        $('screen-viewer').classList.remove('fullscreen');
        $('screen-max').textContent = '全屏';
    }
});

// Drag + Resize screen viewer
(function initScreenDrag() {
    const panel = $('screen-viewer');
    const header = $('screen-viewer-bar');
    const handle = $('screen-resize-handle');
    let dragging = false, resizing = false, startX, startY, startLeft, startTop, startW, startH, startRatio;

    header.addEventListener('pointerdown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top;
        panel.style.transition = 'none';
        e.preventDefault();
    });

    handle.addEventListener('pointerdown', (e) => {
        resizing = true;
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startW = rect.width; startH = rect.height;
        startRatio = startW / startH;
        panel.style.transition = 'none';
        e.preventDefault(); e.stopPropagation();
    });

    document.addEventListener('pointermove', (e) => {
        if (dragging) {
            panel.style.left = (startLeft + e.clientX - startX) + 'px';
            panel.style.top = (startTop + e.clientY - startY) + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        } else if (resizing) {
            const dw = e.clientX - startX;
            const dh = e.clientY - startY;
            // Lock aspect ratio: use the larger delta to drive both dimensions
            let newW, newH;
            if (Math.abs(dw) >= Math.abs(dh)) {
                newW = Math.max(240, startW + dw);
                newH = newW / startRatio;
            } else {
                newH = Math.max(180, startH + dh);
                newW = newH * startRatio;
            }
            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
        }
    });

    document.addEventListener('pointerup', () => {
        if (dragging) { dragging = false; panel.style.transition = ''; }
        if (resizing) { resizing = false; panel.style.transition = ''; }
    });
})();

function stopScreenShare() {
    if (!screenActive) return;
    screenActive = false;
    roomScreenActive = false;
    currentScreenSharer = null;

    Object.values(screenPeerConnections).forEach(pc => pc.close());
    screenPeerConnections = {};
    stopShareStatsMonitor();
    stopScreenStatsMonitor();

    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }

    $('screen-bar').classList.remove('visible');
    $('screen-viewer').classList.remove('visible');
    $('screen-viewer').classList.remove('fullscreen');
    screenMaxed = false;
    $('screen-max').textContent = '全屏';

    ws.send(JSON.stringify({ type: 'screen_stop', nickname: nickname }));
}

// ==================== Quality Switch ====================
// FPS switch
$('screen-fps').addEventListener('change', () => {
    if (!screenActive) return;
    screenFps = parseInt($('screen-fps').value);
    localStorage.setItem('screen-fps', $('screen-fps').value);
    const preset = qualityPresets[screenQuality];
    if (screenStream) {
        const vt = screenStream.getVideoTracks()[0];
        if (vt) {
            vt.applyConstraints({
                width: { ideal: preset.width },
                height: { ideal: preset.height },
                frameRate: { ideal: screenFps }
            }).then(() => {
                showToast('帧率: ' + screenFps + 'fps', 'success');
                // 帧率变了 → 同步刷新各观看者的码率上限
                Object.values(screenPeerConnections).forEach(applyScreenBitrate);
        updateShareStats();            // 帧率/清晰度变了 → 每路码率变了 → 重算上行估算
            })
              .catch(() => showToast('切换帧率失败', 'error'));
        }
    }
});

$('screen-quality').addEventListener('change', () => {
    if (!screenActive) return;
    screenQuality = $('screen-quality').value;
    const preset = qualityPresets[screenQuality];
    if (screenStream) {
        const vt = screenStream.getVideoTracks()[0];
        if (vt) {
            vt.applyConstraints({
                width: { ideal: preset.width },
                height: { ideal: preset.height },
                frameRate: { ideal: screenFps }
            }).then(() => {
                showToast('清晰度: ' + screenQuality, 'success');
                localStorage.setItem('screen-quality', screenQuality);
                Object.values(screenPeerConnections).forEach(applyScreenBitrate);
        updateShareStats();            // 帧率/清晰度变了 → 每路码率变了 → 重算上行估算
                ws.send(JSON.stringify({ type: 'screen_start', nickname: nickname, quality: screenQuality }));
            }).catch(() => showToast('切换失败', 'error'));
        }
    }
});

// ==================== Handle Incoming Screen Share ====================
function handleScreenOffer(msg) {
    // 只处理发给自己的 offer
    if (msg.receiver && msg.receiver !== nickname) return;
    if (typeof RTCPeerConnection === 'undefined') return;

    const pc = new RTCPeerConnection(rtcConfig);
    screenPeerConnections[msg.nickname] = pc;
    pc._pendingCandidates = [];   // ICE 排队（描述未就绪时不再静默丢弃候选）
    pc.addTransceiver('video', { direction: 'recvonly' });
    // ③ 屏幕共享可能带系统音频：补一个只收的音频通道（若对方没发音频，这个 m-line 不占用媒体）
    try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch (e) {}
    var sharerNick = msg.nickname; // 共享者的昵称，用于 ICE 和 answer
    let trackReceived = false;
    let iceConnected = false;
    let trackTimeout;

    pc.ontrack = (event) => {
        trackReceived = true;
        if (trackTimeout) clearTimeout(trackTimeout);
        // 用 event.track 构建 MediaStream（兼容 event.streams[0] 为空的浏览器）
        var stream = event.streams && event.streams[0]
            ? event.streams[0]
            : new MediaStream([event.track]);
        var video = $('screen-video');
        $('screen-viewer').classList.add('visible');
        // ③ 共享可能带系统音频：确保元素没有被静音（否则听不到声音）
    try { video.volume = 1; } catch (e) {}
    try { if (typeof applyScreenAudioPref === 'function') applyScreenAudioPref(); } catch (e) {}
        video.srcObject = stream;
        startScreenStatsMonitor();     // 观看者：开始显示实时延迟/丢包/帧率
        // ③ 诊断 + 保险：打印通话方块与共享画面的真实播放状态；
        //    并确保通话方块没有被意外静音（手机上两路音频互相抢占时可据此定位）
        try {
            var dbg = [];
            document.querySelectorAll('#video-grid video').forEach(function (v) {
                dbg.push('tile:' + (v.parentNode && v.parentNode.id) + ' muted=' + v.muted +
                         ' vol=' + v.volume + ' paused=' + v.paused);
            });
            console.log('[SCREEN] 开始播放共享画面｜' + dbg.join(' | '));
            document.querySelectorAll('#video-grid video').forEach(function (v) {
                if (v.muted && v.parentNode && v.parentNode.id !== 'tile-local') v.muted = false;
            });
        } catch (e) {}
        console.log('[SCREEN] ontrack kind=' + (event.track && event.track.kind) +
                    ' muted=' + video.muted + ' volume=' + video.volume +
                    ' paused=' + video.paused + ' audioTracks=' +
                    (stream.getAudioTracks ? stream.getAudioTracks().length : 'n/a'));
        // ④ 带声音的自动播放会被浏览器策略拦截（不再静默吞掉）：失败时提示并支持点击播放
        var _vp = video.play();
        if (_vp && _vp.catch) {
            _vp.catch(function () {
                showToast('点一下共享画面即可播放声音', 'info');
                video.onclick = function () {
                    var p2 = video.play();
                    if (p2 && p2.catch) p2.catch(function () {});
                };
            });
        }
        showToast(sharerNick + ' 正在共享屏幕 (' + (msg.quality || '720p') + ')', 'info');
        video.onstalled = function() { showToast('屏幕共享画面中断，可能是网络不稳定', 'error'); };
    };

    pc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: "screen_ice", nickname: nickname, receiver: sharerNick,
                content: JSON.stringify(event.candidate)
            }));
        }
    };

    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            iceConnected = true;
        }
        if (pc.iceConnectionState === 'failed' && !trackReceived) {
            showToast('无法连接到' + sharerNick + '的屏幕共享（NAT穿透失败，尝试降低清晰度）', 'error');
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            if (trackTimeout) clearTimeout(trackTimeout);
            if (!trackReceived) showToast('屏幕共享连接失败，请让对方降低清晰度后重试', 'error');
            $('screen-viewer').classList.remove('visible');
            pc.close();
            delete screenPeerConnections[sharerNick];
        }
    };

    trackTimeout = setTimeout(function() {
        if (!trackReceived) {
            showToast('屏幕共享画面未到达，可能是网络带宽不足或NAT问题。建议：1)降低共享清晰度 2)检查防火墙设置', 'error');
        }
    }, 15000);

    var offer = JSON.parse(msg.content);
    pc.setRemoteDescription(new RTCSessionDescription(offer)).then(function() {
        flushScreenCandidates(pc);
        return pc.createAnswer();
    }).then(function(answer) {
        return pc.setLocalDescription(answer);
    }).then(function() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: "screen_answer", nickname: nickname, receiver: sharerNick,
                content: JSON.stringify(pc.localDescription)
            }));
        }
    }).catch(function(e) { console.error('Screen offer error:', e); });
}

/** 描述就绪后统一重放排队的 ICE 候选 */
function flushScreenCandidates(pc) {
    if (!pc || !pc.remoteDescription) return;
    var q = pc._pendingCandidates || [];
    pc._pendingCandidates = [];
    q.forEach(function (cand) {
        pc.addIceCandidate(cand).catch(function (e) {
            console.warn('screen addIceCandidate failed:', e && e.message);
        });
    });
}

function handleScreenAnswer(msg) {
    if (msg.receiver && msg.receiver !== nickname) return;
    var pc = screenPeerConnections[msg.nickname];
    if (!pc) return;
    if (pc.signalingState === 'stable') return;   // 过期 answer，忽略
    var answer = JSON.parse(msg.content);
    pc.setRemoteDescription(new RTCSessionDescription(answer))
      .then(function () { flushScreenCandidates(pc); })
      .catch(function (e) { console.warn('screen setRemoteDescription(answer):', e && e.message); });
}

function handleScreenIce(msg) {
    if (msg.receiver && msg.receiver !== nickname) return;
    var pc = screenPeerConnections[msg.nickname];
    if (!pc) return;
    try {
        var candidate = new RTCIceCandidate(JSON.parse(msg.content));
        if (!pc.remoteDescription) {
            if (!pc._pendingCandidates) pc._pendingCandidates = [];
            pc._pendingCandidates.push(candidate);
            return;
        }
        pc.addIceCandidate(candidate).catch(function (e) {
            console.warn('screen addIceCandidate failed:', e && e.message);
        });
    } catch (e) {}
}

function onScreenStop() {
    Object.values(screenPeerConnections).forEach(function(pc) { pc.close(); });
    screenPeerConnections = {};
    var v = $('screen-viewer');
    v.classList.remove('visible');
    v.classList.remove('fullscreen');
    v.style.left = ''; v.style.top = ''; v.style.right = '360px'; v.style.bottom = '120px';
    v.style.width = ''; v.style.height = '';
    screenMaxed = false;
    $('screen-max').textContent = '全屏';
    $('screen-video').srcObject = null;
    // ★ 共享结束：停止闪避并恢复麦克风增益（麦克风全程未被关闭）
    try { stopEchoDucking(); showToast('屏幕共享结束，麦克风已恢复正常音量', 'info'); } catch (e) {}
}

// ==================== Create Screen Offer ====================
function createScreenOfferFor(targetNick) {
    if (!screenStream) return;

    var pc = new RTCPeerConnection(rtcConfig);
    screenPeerConnections[targetNick] = pc;
    pc._pendingCandidates = [];

    screenStream.getTracks().forEach(function(track) {
        if (track.kind === 'video') {
            // 屏幕内容（文字/代码/UI）用 'text' 比默认的 'motion' 清晰得多
            try { track.contentHint = 'text'; } catch (e) {}
        }
        pc.addTrack(track, screenStream);
    });
    applyScreenBitrate(pc);
    updateShareStats();                // 多了一个观看者 → 刷新上行估算

    pc.onicecandidate = function(event) {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: "screen_ice", nickname: nickname, receiver: targetNick,
                content: JSON.stringify(event.candidate)
            }));
        }
    };

    pc.oniceconnectionstatechange = function() {
        if (pc.iceConnectionState === 'failed') {
            console.error('Screen ICE failed to ' + targetNick);
        }
    };

    pc.createOffer().then(function(offer) { return pc.setLocalDescription(offer); }).then(function() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: "screen_offer", nickname: nickname, receiver: targetNick,
                content: JSON.stringify(pc.localDescription),
                quality: screenQuality
            }));
        }
    }).catch(function(e) { console.error('Screen create offer error:', e); });
}

/**
 * 屏幕共享码率上限。旧版不设上限，共享端会把上行全部吃满，通话视频/音频被挤掉。
 * 15/30fps 档 1.5 Mbps、60fps 档 3 Mbps、90/120fps 档 5 Mbps。
 */
function applyScreenBitrate(pc) {
    var sender = pc.getSenders().find(function (s) { return s.track && s.track.kind === 'video'; });
    if (!sender) return;
    var fps = screenFps || 24;
    var cap = fps >= 90 ? 5000000 : (fps >= 60 ? 3000000 : 1500000);
    try {
        var p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = cap;
        p.encodings[0].maxFramerate = fps;
        // 文字/UI 内容优先保清晰度（弱网时先掉帧而不是掉分辨率）
        p.degradationPreference = 'maintain-resolution';
        sender.setParameters(p).catch(function () {});
    } catch (e) { /* 忽略不支持的浏览器 */ }
}

// ==================== 共享者：上行占用估算 ====================
// 每路码率上限与 applyScreenBitrate 的 cap 同源（只跟帧率有关，与 480p/720p/1080p 无关）
function screenPerViewerMbps() {
    var fps = screenFps || 24;
    var cap = fps >= 90 ? 5000000 : (fps >= 60 ? 3000000 : 1500000);
    var audio = (screenStream && screenStream.getAudioTracks().length > 0) ? 128000 : 0;   // 系统音频约 128 kbps
    return (cap + audio) / 1e6;
}
// 出口上行估值（本机实测 ≈29–30 Mbps，2026-09-24）；可用 localStorage 覆盖：
//   localStorage.setItem('screen-uplink-mbps','100')
function screenUplinkEstimateMbps() {
    var v = parseFloat(localStorage.getItem('screen-uplink-mbps'));
    return (isFinite(v) && v > 0) ? v : 30;
}
var shareWarned = false;
function updateShareStats() {
    var el = document.getElementById('screen-share-stats');
    if (!el) return;
    if (!screenActive) { el.textContent = ''; return; }
    // 自清洁：连接已失败/已关闭的条目直接删掉（例如对方直接关页面、没走 screen_unwatch）
    Object.keys(screenPeerConnections).forEach(function (n) {
        var pc = screenPeerConnections[n];
        var st = pc && pc.connectionState;
        if (!pc || st === 'failed' || st === 'closed' || (pc.signalingState === 'closed')) delete screenPeerConnections[n];
    });
    // 人数以**服务端名单**为准（screen_viewers）；服务端还没下发时用本地 PC 表兜底
    var srvList = (Array.isArray(screenViewerList) ? screenViewerList : []).filter(function (n) { return n !== nickname; });
    var localList = Object.keys(screenPeerConnections).filter(function (n) { return n !== nickname; });
    // 收到过服务端名单就以它为准（哪怕 0 人）；还没收到时才用本地 PC 表兜底
    var viewers = screenViewerListKnown ? srvList.length : localList.length;
    var per = screenPerViewerMbps();
    var total = viewers * per;
    var up = screenUplinkEstimateMbps();
    var ratio = total / up;
    el.textContent = '👥 ' + viewers + ' 人观看 · 上行 ≈ ' + total.toFixed(1) + ' Mbps（每路 ' + per.toFixed(2) + '）';
    el.style.color = ratio >= 0.85 ? '#ffb3b3' : (ratio >= 0.6 ? '#ffe08a' : '#b8f3c0');
    el.title = '估算 = 观看人数 × 每路码率上限（' + (screenFps || 15) + 'fps → ' +
        Math.round(per * 1000) + ' kbps' + (screenStream && screenStream.getAudioTracks().length ? '，含系统音频' : '') + '）。\n' +
        '每个观看者各占一路上行（P2P）；打不通直连时会走你机器的 TURN，进出各占一次。\n' +
        '出口估值按 ' + up + ' Mbps 算 —— 想改成实际值：localStorage.setItem("screen-uplink-mbps","50")';
    if (ratio >= 0.85 && !shareWarned) {
        shareWarned = true;
        showToast('⚠ 上行估算 ' + total.toFixed(1) + ' Mbps，已接近你的出口（约 ' + up +
            ' Mbps）——建议降到 720p/15fps，或让部分人停止观看', 'error');
    }
}

// ==================== 观看者：实时网络延迟 ====================
// 与语音通话的质量徽标同一套算法：nominated candidate-pair 的 RTT + 增量丢包率，
// 再带上解码帧率与实际分辨率（屏幕共享设了 maintain-resolution ⇒ 弱网先掉帧，所以 fps 很关键）。
let screenStatsTimer = null, screenStatsPrev = {}, shareStatsTimer = null;
let screenViewerList = [];         // 服务端权威的观看者名单（共享者侧）
let screenViewerListKnown = false; // 是否已收到过服务端名单（区分"还没下发"与"服务端说 0 人"）
let screenViewerDismissed = false; // 观看者主动关掉了画面（不再自动重发观看请求）
function screenQualityLevel(rtt, lossPct) {
    if (!rtt) return { txt: '测量中', color: '#9e9e9e' };
    if (rtt < 150 && lossPct < 2) return { txt: '良好', color: '#b8f3c0' };
    if (rtt < 300 && lossPct < 5) return { txt: '一般', color: '#ffe08a' };
    return { txt: '较差', color: '#ffb3b3' };
}
async function pollScreenStats() {
    var el = document.getElementById('screen-viewer-stats');
    if (!el) return;
    var nick = currentScreenSharer;
    var pc = nick && screenPeerConnections[nick];
    if (!pc || pc.signalingState === 'closed') { el.textContent = ''; return; }
    try {
        var report = await pc.getStats();
        var rtt = 0, lossPct = 0, fps = 0, w = 0, h = 0;
        report.forEach(function (r) {
            if (r.type === 'candidate-pair' && r.currentRoundTripTime != null &&
                (r.nominated || r.state === 'succeeded')) {
                var ms = Math.round(r.currentRoundTripTime * 1000);
                if (r.nominated || !rtt) rtt = ms;
            }
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
                var prev = screenStatsPrev[r.id];
                if (prev && r.packetsReceived != null && r.packetsLost != null) {
                    var dLost = Math.max(0, r.packetsLost - prev.lost);
                    var dRecv = Math.max(0, r.packetsReceived - prev.recv);
                    var tot = dLost + dRecv;
                    lossPct = tot > 0 ? (dLost / tot) * 100 : 0;
                }
                screenStatsPrev[r.id] = { lost: r.packetsLost || 0, recv: r.packetsReceived || 0 };
                if (r.framesPerSecond != null) fps = Math.round(r.framesPerSecond);
                if (r.frameWidth) { w = r.frameWidth; h = r.frameHeight; }
            }
        });
        var q = screenQualityLevel(rtt, lossPct);
        el.textContent = '● ' + q.txt + ' · 延迟 ' + (rtt || '--') + 'ms · ' + fps + 'fps' +
            (lossPct >= 0.05 ? ' · 丢包 ' + lossPct.toFixed(1) + '%' : '');
        el.style.color = q.color;
        el.title = '与「' + nick + '」这条连接：RTT ' + rtt + ' ms；视频丢包 ' + lossPct.toFixed(2) +
            '%；解码 ' + fps + ' fps；画面 ' + (w ? w + '×' + h : '未知');
    } catch (e) { }
}
function startScreenStatsMonitor() {
    stopScreenStatsMonitor();
    pollScreenStats();
    screenStatsTimer = setInterval(pollScreenStats, 2000);
}
function stopScreenStatsMonitor() {
    if (screenStatsTimer) { clearInterval(screenStatsTimer); screenStatsTimer = null; }
    screenStatsPrev = {};
    var el = document.getElementById('screen-viewer-stats');
    if (el) { el.textContent = ''; }
}
function startShareStatsMonitor() {
    stopShareStatsMonitor();
    shareWarned = false;
    updateShareStats();
    shareStatsTimer = setInterval(updateShareStats, 5000);   // 观看者进出/切档都会在 5 秒内反映
}
function stopShareStatsMonitor() {
    if (shareStatsTimer) { clearInterval(shareStatsTimer); shareStatsTimer = null; }
    updateShareStats();
}

// Override handleMessage to intercept screen signaling
const origHandleMsg2 = handleMessage;
handleMessage = function(msg) {
    switch (msg.type) {
        case 'screen_offer': handleScreenOffer(msg); break;
        case 'screen_answer': handleScreenAnswer(msg); break;
        case 'screen_ice': handleScreenIce(msg); break;
        case 'screen_viewers':
            // 服务端权威名单（共享者侧）：人数不再靠本地 PC 表推
            if (Array.isArray(msg.users)) { screenViewerList = msg.users; screenViewerListKnown = true; }
            updateShareStats();
            break;
        case 'screen_viewer_left':
            // 某个观看者关闭了画面 ⇒ 释放他那一路，并刷新上行估算
            if (screenPeerConnections[msg.nickname]) {
                try { screenPeerConnections[msg.nickname].close(); } catch (e) { }
                delete screenPeerConnections[msg.nickname];
            }
            updateShareStats();
            break;
        case 'screen_new_viewer':
            // 我是共享者，有新用户加入 — 向其发送独立的 screen_offer
            if (msg.nickname === nickname && msg.receiver) {
                createScreenOfferFor(msg.receiver);
            }
            break;
        case 'screen_start':
            window.setUserStatus && window.setUserStatus(msg.nickname, 'screen', true);
            roomScreenActive = true;
            currentScreenSharer = msg.nickname;
            $('btn-screen-share').classList.add('off');
            origHandleMsg2(msg);
            // 新人主动请求观看：向服务端发送 screen_watch，服务端通知共享者创建专属 offer
            if (msg.nickname !== nickname && !screenActive && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'screen_watch',
                    nickname: nickname,
                    receiver: msg.nickname
                }));
            }
            break;
        case 'screen_stop':
            screenViewerList = [];       // 共享结束，名单作废
            screenViewerListKnown = false;
            window.setUserStatus && window.setUserStatus(msg.nickname, 'screen', false);
            roomScreenActive = false;
            currentScreenSharer = null;
            $('btn-screen-share').classList.remove('off');
            onScreenStop();
            origHandleMsg2(msg);
            break;
        case 'screen_status_resp':
            if (screenStatusPending && screenStatusCallback) {
                screenStatusPending = false;
                screenStatusCallback({
                    active: msg.content === 'active',
                    sharer: msg.nickname || ''
                });
            }
            break;
        case 'screen_active':
            // 服务端通知新用户：有人正在共享 — 调出窗口并请求画面
            roomScreenActive = true;
            currentScreenSharer = msg.nickname || '';
            $('btn-screen-share').classList.add('off');
            $('screen-viewer').classList.add('visible');
            if (ws && ws.readyState === WebSocket.OPEN && msg.nickname !== nickname) {
                ws.send(JSON.stringify({
                    type: 'screen_watch', nickname: nickname, receiver: msg.nickname
                }));
            }
            break;
        case 'screen_blocked':
            // 服务端拒绝：共享发起被拦截
            showToast(msg.content || '当前有人正在进行共享', 'error');
            roomScreenActive = true;
            currentScreenSharer = msg.nickname || '';
            $('btn-screen-share').classList.add('off');
            break;
        default:
            origHandleMsg2(msg);
    }
};


// ==================== ③ 页面恢复可见：修复"切屏回来屏幕共享黑屏" ====================
// 手机切到后台再回来时，<video> 会被浏览器暂停/丢帧，表现为黑屏；这里统一重新播放，
// 并在"仍有共享在播"时重新发一次 screen_watch（拿一条全新的 offer/PC），避免拿到已失效的流。
document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    try {
        ['screen-video'].forEach(function (id) {
            var v = $(id);
            if (v && v.srcObject) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        });
        // 通话里的每个画面也一并重试播放
        document.querySelectorAll('#video-grid video').forEach(function (v) {
            if (v.srcObject) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        });
    } catch (e) {}
    try {
        if (roomScreenActive && currentScreenSharer && ws && ws.readyState === WebSocket.OPEN) {
            console.log('[SCREEN] 页面恢复可见，重新请求观看 ' + currentScreenSharer);
            // ⚠️ 必须排除"我自己就是共享者"：否则共享者切回页面时会给自己的共享发观看请求，
    //    服务端把他记成观看者、他给自己建一条 PC ⇒ 人数凭空 +1（用户实测"一个人共享显示 2 人"）
    if (!screenViewerDismissed && currentScreenSharer && currentScreenSharer !== nickname)
        ws.send(JSON.stringify({ type: 'screen_watch', nickname: nickname, receiver: currentScreenSharer }));
            $('screen-viewer').classList.add('visible');
        }
    } catch (e) {}
});


// ==================== 回音闪避（侧链 ducking） ====================
// 电脑共享系统音频时：麦克风保持开启，但当系统音频正在出声时把麦克风增益压到很低
//（回声 = 扬声器外放被本机麦克风采集；压系统音频无用，只能压麦克风）。
var _duckCtx = null, _duckTimer = null, _duckOn = false;
var DUCK_FLOOR = 0.35;        // 闪避下限：保持 35%（说话仍清楚；太小会听不见说话）
var DUCK_KEY = 'uchat-echo-duck';

function echoDuckEnabled() {
    try { return localStorage.getItem(DUCK_KEY) !== '0'; } catch (e) { return true; }
}

/** 在共享栏里放一个"防回音"开关（默认开），让用户可以自行取舍回声与麦克风音量 */
function ensureDuckButton() {
    try {
        var bar = $('screen-bar');
        if (!bar || $('btn-echo-duck')) return;
        var b = document.createElement('button');
        b.id = 'btn-echo-duck';
        b.type = 'button';
        b.style.cssText = 'margin-left:6px;padding:2px 8px;font-size:12px;cursor:pointer;border-radius:10px;' +
                          'border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.12);color:#fff';
        function refresh() {
            var on = echoDuckEnabled();
            b.textContent = on ? '🛡 防回音 开' : '🛡 防回音 关';
            b.title = on ? '电脑放声时自动压低麦克风以减少回声（点击可关闭；戴耳机时建议关闭）'
                         : '已关闭：麦克风始终满音量（电脑外放时可能听到回声）';
            b.style.opacity = on ? '1' : '0.6';
        }
        b.addEventListener('click', function () {
            try { localStorage.setItem(DUCK_KEY, echoDuckEnabled() ? '0' : '1'); } catch (e) {}
            refresh();
            if (echoDuckEnabled()) { startEchoDucking(); }
            else { stopEchoDucking(); }
            showToast(echoDuckEnabled() ? '已开启防回音闪避' : '已关闭防回音闪避（麦克风满音量）', 'info');
        });
        bar.appendChild(b);
        refresh();
    } catch (e) { console.warn('[SCREEN] 防回音开关创建失败:', e); }
}

function startEchoDucking() {
    try {
        stopEchoDucking();
        if (!echoDuckEnabled()) { console.log('[SCREEN] 防回音闪避已被用户关闭'); return; }
        if (!screenStream) return;
        var at = screenStream.getAudioTracks();
        if (!at.length) return;                       // 没采集到系统音频则无需闪避
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        _duckCtx = new AC();
        var srcNode = _duckCtx.createMediaStreamSource(new MediaStream(at));
        var an = _duckCtx.createAnalyser();
        an.fftSize = 512;
        srcNode.connect(an);
        var buf = new Uint8Array(an.fftSize);
        var quietSince = 0;
        _duckOn = true;
        _duckTimer = setInterval(function () {
            if (!_duckOn) return;
            try {
                an.getByteTimeDomainData(buf);
                var peak = 0;
                for (var i = 0; i < buf.length; i++) {
                    var v = Math.abs(buf[i] - 128);
                    if (v > peak) peak = v;
                }
                var loud = peak > 20;                 // 约 -30dBFS 以上才算"正在出声"（避免轻声/底噪就触发）
                if (loud) {
                    quietSince = 0;
                    if (window.setMicDuck) window.setMicDuck(DUCK_FLOOR);
                } else {
                    if (!quietSince) quietSince = Date.now();
                    if (Date.now() - quietSince > 350) {
                        if (window.setMicDuck) window.setMicDuck(1);
                    }
                }
            } catch (e) {}
        }, 60);
        console.log('[SCREEN] 回音闪避已启动（系统音频出声时压低麦克风）');
    } catch (e) { console.warn('[SCREEN] 回音闪避启动失败:', e); }
}

function stopEchoDucking() {
    _duckOn = false;
    if (_duckTimer) { clearInterval(_duckTimer); _duckTimer = null; }
    if (_duckCtx) { try { _duckCtx.close(); } catch (e) {} _duckCtx = null; }
    try { if (window.setMicDuck) window.setMicDuck(1); } catch (e) {}
}




// ==================== 观看端：共享声音开关 ====================
// 需求：手机上能单独把"屏幕共享的声音"静音（通话语音不受影响）。
// 记住用户选择；共享者自己的本地预览始终保持静音（避免数字回路）。
var SCREEN_MUTE_KEY = 'uchat-screen-muted';

function screenMutedPref() {
    try { return localStorage.getItem(SCREEN_MUTE_KEY) === '1'; } catch (e) { return false; }
}

function applyScreenAudioPref() {
    try {
        var v = $('screen-video');
        var b = $('screen-audio-toggle');
        var muted = screenMutedPref();
        if (screenActive) {
            // ★ 共享者：这个键表示"我是否把电脑的声音发出去"
            try {
                if (screenStream) screenStream.getAudioTracks().forEach(function (tr) { tr.enabled = !muted; });
            } catch (e) {}
            if (v) v.muted = true;                    // 自己的预览始终静音（避免数字回路）
            if (b) {
                b.textContent = muted ? '🔇' : '🔊';
                b.title = muted ? '正在静音我发出的电脑声音（点一下恢复）' : '正在发送电脑声音（点一下静音）';
                b.style.display = '';                 // ★ 不再隐藏（之前点一下就消失是 bug）
            }
        } else {
            // 观看端：控制本机播放（通话语音不受影响）
            if (v) v.muted = muted;
            if (b) {
                b.textContent = muted ? '🔇' : '🔊';
                b.title = muted ? '共享声音：已静音（点一下恢复）' : '共享声音：开启（点一下静音）';
                b.style.display = '';
            }
        }
    } catch (e) {}
}

(function initScreenAudioToggle() {
    function bind() {
        var b = $('screen-audio-toggle');
        if (!b) return false;
        b.addEventListener('click', function () {
            try {
                var muted = !screenMutedPref();
                localStorage.setItem(SCREEN_MUTE_KEY, muted ? '1' : '0');
                applyScreenAudioPref();
                if (!muted) {
                    var v = $('screen-video');
                    if (v) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
                }
                if (typeof showToast === 'function') {
                    showToast(muted ? '已静音共享声音（通话语音不受影响）' : '已开启共享声音', 'info');
                }
            } catch (e) {}
        });
        return true;
    }
    if (!bind()) {
        // DOM 可能还没就绪
        document.addEventListener('DOMContentLoaded', function () { bind(); applyScreenAudioPref(); });
    } else {
        applyScreenAudioPref();
    }
})();


// ==================== 观看栏上的麦克风按钮 ====================
// 与通话面板里的 #btn-mic-toggle 同一个行为：点一下切换麦克风，并同步按钮外观。
(function initScreenMicToggle() {
    function bind() {
        var b = $('screen-mic-toggle');
        if (!b) return false;
        function refresh() {
            try {
                var on = (typeof micEnabled === 'undefined') ? true : micEnabled;
                b.textContent = on ? '🎙️' : '🔇';
                b.title = on ? '麦克风已开（点击静音）' : '麦克风已静音（点击开启）';
                b.style.opacity = on ? '' : '0.6';
            } catch (e) {}
        }
        b.addEventListener('click', function () {
            try {
                var real = $('btn-mic-toggle');
                if (real) { real.click(); }              // 复用通话面板的开关逻辑（含状态广播）
                else if (typeof micEnabled !== 'undefined') { micEnabled = !micEnabled; }
            } catch (e) {}
            setTimeout(refresh, 60);
        });
        refresh();
        // 互相同步外观（每人 2 秒核对一次，避免与通话面板状态不一致）
        setInterval(refresh, 2000);
        return true;
    }
    if (!bind()) document.addEventListener('DOMContentLoaded', bind);
})();
