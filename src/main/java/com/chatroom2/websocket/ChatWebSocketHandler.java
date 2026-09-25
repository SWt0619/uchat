package com.chatroom2.websocket;

import com.chatroom2.model.*;
import com.google.gson.Gson;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class ChatWebSocketHandler extends TextWebSocketHandler {

    private static final Gson GSON = new Gson();
    private static final int MAX_CLIENTS = 16;
    private static final int MAX_HISTORY = 200;
    private static final long MAX_FILE_SIZE = 104857600L;
    private static final long MAX_IMAGE_SIZE = 10485760L;
    private static final int FILE_CHUNK_SIZE = 262144;

    private final UserManager userManager = new UserManager();
    /** P0-④ 离线私聊：私聊落盘 + 上线补投 + 未读计数 + 断线补齐的唯一数据源 */
    private final PrivateStore privateStore = PrivateStore.getInstance();
    private final Room room;
    private final Map<String, List<byte[]>> fileBuffers = new ConcurrentHashMap<>();
    private final Set<String> screenShareParticipants = Collections.synchronizedSet(new HashSet<>());

    // 频率限制：每用户每秒最多 10 条消息
    private final ConcurrentHashMap<String, Long> rateWindowStart = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> rateMsgCount = new ConcurrentHashMap<>();
    private static final int MAX_MSGS_PER_SEC = 10;
    private static final long RATE_WINDOW_MS = 1000;

    // 信令单独限流：信令（SDP/ICE）此前完全不限流，可被洪泛打爆
    private final ConcurrentHashMap<String, Long> signalWindowStart = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> signalMsgCount = new ConcurrentHashMap<>();

    // ==================== T3: 消息幂等去重 ====================
    /**
     * 已处理过的消息登记表：key = {@code nickname + "|" + msgId}，value = 首次处理的时刻（毫秒）。
     *
     * <p>客户端断网重连后会把本地队列里的消息重发（复用同一 msgId），服务端必须保证
     * 「同一用户 + 同一 msgId」只入库、只广播一次，否则历史里会出现重复消息。</p>
     *
     * <p><b>窗口选择：10 分钟时间窗口（{@link #DEDUP_WINDOW_MS}）+ 定时清理</b>，另加
     * {@link #DEDUP_MAX_ENTRIES} 条硬上限兜底。选时间窗口而不是"每用户最近 N 条"，是因为
     * 重传发生在秒级~分钟级（重连、切换 WiFi），10 分钟足以覆盖全部正常重传；
     * 内存估算见 prompts/_evidence/T3.md（10 分钟内最坏 16 客户端 × 10 条/秒 ≈ 9.6 万条 ≈ 19 MB，
     * 实际远低于此，且 60 秒扫一次；硬上限 2 万条把最坏占用压在 ~4 MB）。</p>
     */
    private final ConcurrentHashMap<String, Long> seenMsgIds = new ConcurrentHashMap<>();
    private static final long DEDUP_WINDOW_MS = 10 * 60 * 1000L;
    private static final int DEDUP_MAX_ENTRIES = 20000;

    @Value("${chat.signaling.max-per-sec:60}")
    private int signalMaxPerSec = 60;
    @Value("${chat.signaling.max-payload-bytes:32768}")
    private int signalMaxPayloadBytes = 32768;
    @Value("${chat.call.grace-ms:45000}")
    private long callGraceMs = 45_000L;

    // ★ 视频通话双房间
    private final Set<String> videoRoom1 = Collections.synchronizedSet(new HashSet<>());
    private final Set<String> videoRoom2 = Collections.synchronizedSet(new HashSet<>());
    private final ConcurrentHashMap<String, Integer> videoRoomMap = new ConcurrentHashMap<>();
    // ★ 语音通话双房间
    private final Set<String> voiceRoom1 = Collections.synchronizedSet(new HashSet<>());
    private final Set<String> voiceRoom2 = Collections.synchronizedSet(new HashSet<>());
    private final ConcurrentHashMap<String, Integer> voiceRoomMap = new ConcurrentHashMap<>();
    /**
     * 每间房人数上限。纯 P2P Mesh 下每人上行 =（N-1）路，
     * 8 人需要 7 路上行（≈4 Mbps 摄像头码流），家庭宽带上不可行
     * —— 旧版本的做法是「≥6 人静默关掉所有人的视频」，等于放弃功能。
     */
    // ===== 通话房间容量（2026-09-24 用户指定）=====
    //   语音房：房间1=12 人、房间2=6 人；视频房：房间1=8 人、房间2=6 人
    //   （原来是单一 callRoomMax=6，前端房间卡片还写着 0/4；现在按房间分别定，并通过 caps 下发给客户端显示）
    private static final int VOICE_ROOM1_MAX = 12;
    private static final int VOICE_ROOM2_MAX = 6;
    private static final int VIDEO_ROOM1_MAX = 8;
    private static final int VIDEO_ROOM2_MAX = 6;

    /** 某房间的容量 */
    private static int roomCapacity(boolean isVoice, int roomNum) {
        if (isVoice) return roomNum == 2 ? VOICE_ROOM2_MAX : VOICE_ROOM1_MAX;
        return roomNum == 2 ? VIDEO_ROOM2_MAX : VIDEO_ROOM1_MAX;
    }

    /** 房间容量表（随 call_status / room_state 下发，客户端只显示不硬编码） */
    private static java.util.Map<String, Integer> roomCaps() {
        java.util.Map<String, Integer> m = new java.util.LinkedHashMap<>();
        m.put("voice1", VOICE_ROOM1_MAX);
        m.put("voice2", VOICE_ROOM2_MAX);
        m.put("video1", VIDEO_ROOM1_MAX);
        m.put("video2", VIDEO_ROOM2_MAX);
        return m;
    }

    /** 注册码：只从环境变量注入（见 application.properties 的 chat.invite.code） */
    @Value("${chat.invite.code:}")
    private String inviteCode = "";

    /** 角色名单（逗号分隔）：管理员、机器人；未列入者为普通用户 */
    @Value("${chat.roles.admin:}")
    private String adminNames = "";
    @Value("${chat.roles.bot:}")
    private String botNames = "";

    private java.util.Map<String, String> buildRoles() {
        java.util.Map<String, String> m = new java.util.LinkedHashMap<>();
        for (String s : botNames.split(",")) { String n = s.trim(); if (!n.isEmpty()) m.put(n, "bot"); }
        for (String s : adminNames.split(",")) { String n = s.trim(); if (!n.isEmpty()) m.put(n, "admin"); }
        return m;
    }

    /** 掉线宽限期：通话席位保留，对端显示"重连中"，避免网络抖动直接掐断通话 */
    private final ConcurrentHashMap<String, Long> callRoomGraceUntil = new ConcurrentHashMap<>();

    /** 房间状态广播去抖（避免频繁进出时 O(N) 消息风暴） */
    private final AtomicBoolean callStateScheduled = new AtomicBoolean(false);
    private final Object callStateLock = new Object();
    private volatile long lastCallStateAt = 0;
    private static final long CALL_STATE_DEBOUNCE_MS = 150;

    /** 各用户麦克风/摄像头开关状态，用于新加入者补齐角标 */
    private final ConcurrentHashMap<String, String> mediaStates = new ConcurrentHashMap<>();

    /**
     * 被新连接顶替的旧 session id → 登记时间。
     *
     * <p>快速重连（主机网络抖动后所有客户端几乎同时回来）时，服务端会先 close 旧 socket
     * 再让新 socket 登录。旧 socket 的 afterConnectionClosed 随后才到，此时它会认为用户
     * "断开了连接" 并给所有人广播一条系统消息 —— 一轮抖动下来每个用户两条
     * （"X 断开了连接" + "X 已重连"），聊天区被刷屏。这里登记旧 session id，
     * 在 afterConnectionClosed 里静默处理（只做必要的状态标记，不广播）。</p>
     */
    private final ConcurrentHashMap<String, Long> supersededSessions = new ConcurrentHashMap<>();

    // 听歌房
    private static final int MUSIC_ROOM_MAX = 4;
    private final java.util.LinkedHashMap<String, String> musicRoom = new java.util.LinkedHashMap<>(); // nickname -> songId
    private int musicTurnIdx = 0;
    private long musicTurnStarted = 0;
    private static final long MUSIC_TURN_MS = 15 * 60 * 1000; // 每人15分钟
    /** 曲目迟迟没有上报时长（加载失败/外链被拒）时的兜底推进时间 */
    private static final long MUSIC_STUCK_MS = 90 * 1000;
    // ===== 听歌房真同步状态（2026-09-24 v2.9.0）=====
    /** 当前"正在播放"的曲目键（平台:spec@点歌人）。空 = 当前 DJ 还没选歌 */
    private String musicPlayingKey = "";
    /** 该曲目在服务端的开始时间（epoch ms），客户端据此 seek 对齐 */
    private long musicStartAt = 0;
    /** 该曲目时长（秒；0=未知，等点歌人上报 music_room_meta） */
    private int musicDuration = 0;

    private static final Path DATA_DIR = Paths.get(System.getProperty("user.dir"), "data");
    private static final Path LOG_DIR = Paths.get(System.getProperty("user.dir"), "logs");
    private static final long DISCONNECT_GRACE_MS = 6 * 60 * 1000; // 断线宽限期 6 分钟（前端自动重连 5 分钟 + 60 秒缓冲）
    private static final long RECALL_LIMIT_MS = 3 * 60 * 1000;     // 撤回时限 3 分钟
    private static final int MAX_MSG_LENGTH = 5000;                 // 消息最大长度
    private final ScheduledExecutorService cleanupScheduler = Executors.newSingleThreadScheduledExecutor();

    public ChatWebSocketHandler() {
        Room saved = Room.loadFromFile();
        if (saved != null && !saved.getHistory().isEmpty()) {
            this.room = new Room("聊天室", MAX_CLIENTS); // 始终使用正确的容量
            this.room.setHistory(saved.getHistory());
            System.out.println("已恢复上次聊天记录 " + room.getHistory().size() + " 条（容量: " + MAX_CLIENTS + "人）");
        } else {
            this.room = new Room("聊天室", MAX_CLIENTS);
            System.out.println("创建新房间（容量: " + MAX_CLIENTS + "人）");
        }
        // 定期清理断线超时用户 + 听歌房自动切歌
        cleanupScheduler.scheduleAtFixedRate(() -> {
            try {
                // 听歌房自动切歌
                synchronized (musicRoom) {
                    if (!musicRoom.isEmpty() && musicTurnStarted > 0) {
                        if (!musicPlayingKey.isEmpty()) {
                            long now = System.currentTimeMillis();
                            // ① 知道时长 → 放完就换（+3 秒余量）；② 不知道时长 → 90 秒兜底（加载失败/外链被拒）；
                            // ③ 单人回合上限 15 分钟
                            boolean byDuration = musicDuration > 0 && now > musicStartAt + musicDuration * 1000L + 3000;
                            boolean byStuck = musicDuration == 0 && now > musicStartAt + MUSIC_STUCK_MS;
                            boolean byCap = now > musicTurnStarted + MUSIC_TURN_MS;
                            if (byDuration || byStuck || byCap) {
                                if (byStuck) {
                                    String dj = currentMusicDj();
                                    broadcastToMusicRoom(Message.system("⚠ " + (dj == null ? "当前曲目" : dj + " 的曲目")
                                            + " 90 秒内没能开始播放（可能受版权限制），已自动跳过"));
                                }
                                advanceMusicTurn();
                                broadcastMusicRoomState();
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}
            try {
                // 获取即将被清理的用户列表，用于广播离开消息
                List<String> expired = room.getExpiredDisconnected(DISCONNECT_GRACE_MS);
                for (String nick : expired) {
                    // 清理通话状态
                    cleanupCallRoomsFor(nick);
                    screenShareParticipants.remove(nick);
                    Message sysMsg = Message.system(nick + " 离开了聊天室（断线超时）");
                    String json = sysMsg.toJson();
                    addHistoryIfWorth(json);
                    room.broadcastToAllOnline(json);
                    System.out.println(nick + " 断线超时，已移出房间");
                }
                int removed = room.removeExpiredDisconnected(DISCONNECT_GRACE_MS);
                if (removed > 0) {
                    for (String nick : expired) {
                        AuthTokenStore.getInstance().remove(nick);
                    }
                    broadcastUserList();
                    System.out.println("清理了 " + removed + " 个断线超时用户");
                }
            } catch (Exception ignored) {}
        }, 30, 30, TimeUnit.SECONDS);

        // 清理"被顶替的旧连接"登记表：正常情况下它会在 afterConnectionClosed 里被取走，
        // 但如果容器因为旧 socket 早已失效而没有派发关闭事件，这里兜底回收，避免无限增长。
        cleanupScheduler.scheduleAtFixedRate(() -> {
            try {
                long cutoff = System.currentTimeMillis() - 120_000L;
                supersededSessions.entrySet().removeIf(e -> e.getValue() < cutoff);
            } catch (Exception ignored) {}
        }, 60, 60, TimeUnit.SECONDS);

        // T3: 清理幂等去重表 —— 超过窗口的登记不再需要保留（登记本身只表示"服务端处理过"）
        cleanupScheduler.scheduleAtFixedRate(() -> {
            try {
                long cutoff = System.currentTimeMillis() - DEDUP_WINDOW_MS;
                int before = seenMsgIds.size();
                seenMsgIds.entrySet().removeIf(e -> e.getValue() < cutoff);
                int removed = before - seenMsgIds.size();
                if (removed > 0) {
                    System.out.println("[DEDUP] 清理过期登记 " + removed + " 条，剩余 " + seenMsgIds.size());
                }
            } catch (Exception ignored) {}
        }, 60, 60, TimeUnit.SECONDS);

        // 通话掉线宽限期扫描：到点才真正把用户移出通话房间并通知对端拆连接。
        // 旧版本是 afterConnectionClosed 里立刻移除 —— WiFi 抖一下整场通话就废了。
        cleanupScheduler.scheduleAtFixedRate(() -> {
            try {
                long now = System.currentTimeMillis();
                long grace = callGraceMs > 0 ? callGraceMs : 45_000L;
                for (Map.Entry<String, Long> e : new HashMap<>(callRoomGraceUntil).entrySet()) {
                    if (now - e.getValue() < grace) continue;
                    String nick = e.getKey();
                    if (!callRoomGraceUntil.remove(nick, e.getValue())) continue; // 已被重连清除
                    System.out.println("[CALL] " + nick + " 通话宽限期已过，移出房间");
                    disconnectFromCallRooms(nick);
                }
            } catch (Exception ignored) {}
        }, 5, 5, TimeUnit.SECONDS);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            cleanupScheduler.shutdown();
            saveLogToFile();
            room.saveToFile();
            System.out.println("房间状态已保存");
        }));
    }

    // ==================== 安全校验 ====================

    /** 验证 WebSocket 连接确实属于声称的昵称，防止消息伪造 */
    private boolean isSessionOwner(WebSocketSession session, String nickname) {
        if (nickname == null) return false;
        UserSession us = room.getSession(nickname);
        if (us == null) return false;
        return us.getSession().getId().equals(session.getId());
    }

    /** 频率限制：每用户每秒最多 MAX_MSGS_PER_SEC 条消息 */
    private boolean isRateLimited(String nickname) {
        long now = System.currentTimeMillis();
        Long windowStart = rateWindowStart.get(nickname);
        if (windowStart == null || now - windowStart > RATE_WINDOW_MS) {
            rateWindowStart.put(nickname, now);
            rateMsgCount.put(nickname, 1);
            return false;
        }
        Integer count = rateMsgCount.get(nickname);
        if (count == null) count = 0;
        if (count >= MAX_MSGS_PER_SEC) return true;
        rateMsgCount.put(nickname, count + 1);
        return false;
    }

    /** 信令限流：每用户每秒最多 signalMaxPerSec 条 SDP/ICE 消息（与聊天限流分开计数） */
    private boolean isSignalRateLimited(String nickname) {
        long now = System.currentTimeMillis();
        int limit = signalMaxPerSec > 0 ? signalMaxPerSec : 60;
        Long windowStart = signalWindowStart.get(nickname);
        if (windowStart == null || now - windowStart > RATE_WINDOW_MS) {
            signalWindowStart.put(nickname, now);
            signalMsgCount.put(nickname, 1);
            return false;
        }
        Integer count = signalMsgCount.get(nickname);
        if (count == null) count = 0;
        if (count >= limit) return true;
        signalMsgCount.put(nickname, count + 1);
        return false;
    }

    /** 信令载荷合法性：必须非空且有大小上限（防超大载荷打爆内存） */
    private boolean isSignalPayloadOk(Message msg) {
        if (msg.content == null || msg.content.isEmpty()) return false;
        int max = signalMaxPayloadBytes > 0 ? signalMaxPayloadBytes : 32768;
        return msg.content.length() <= max;
    }

    /**
     * 视频通话信令门禁（video_offer / video_answer / video_ice）。
     *
     * <p>旧版本这三个 handler 是全文唯一漏掉 {@code isSessionOwner} 的地方，且
     * 不校验 receiver 是否同房间、也不计限流 —— 任何登录用户都能伪造 nickname
     * 向任意用户投递 SDP/ICE（冒充他人发起通话、ICE 洪泛 DoS）。</p>
     *
     * <p>现在要求：① session 确属声称的昵称；② receiver 在线且不是自己；
     * ③ 载荷非空且不超限；④ 收发双方确实在同一通话房间；⑤ 单独限流。</p>
     */
    private boolean isVideoSignalAllowed(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return false;
        if (msg.receiver == null || msg.receiver.equals(msg.nickname)) return false;
        if (room.getSession(msg.receiver) == null) return false;
        if (!isSignalPayloadOk(msg)) return false;
        Set<String> mine = getCallRoomForSender(msg.nickname);
        if (mine == null) return false;
        boolean sameRoom;
        synchronized (mine) {
            sameRoom = mine.contains(msg.receiver);
        }
        if (!sameRoom) {
            System.err.println("[SIGNAL] 拒绝跨房间信令: " + msg.nickname + " -> " + msg.receiver + " type=" + msg.type);
            return false;
        }
        if (isSignalRateLimited(msg.nickname)) {
            System.err.println("[SIGNAL] 限流丢弃: " + msg.nickname + " type=" + msg.type);
            return false;
        }
        return true;
    }

    /**
     * 屏幕共享信令门禁。屏幕共享与会话房间无关（共享者向任意在线用户发 offer），
     * 因此只校验身份、接收者、载荷与限流，不做同房间约束。
     */
    private boolean isScreenSignalAllowed(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return false;
        if (msg.receiver == null || msg.receiver.equals(msg.nickname)) return false;
        if (room.getSession(msg.receiver) == null) return false;
        if (!isSignalPayloadOk(msg)) return false;
        if (isSignalRateLimited(msg.nickname)) {
            System.err.println("[SIGNAL] 限流丢弃: " + msg.nickname + " type=" + msg.type);
            return false;
        }
        return true;
    }

    // ==================== 连接生命周期 ====================

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        System.out.println("[CONNECT] " + session.getId() + " from " + session.getRemoteAddress());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage textMessage) {
        try {
            String payload = textMessage.getPayload();
            Message msg = Message.fromJson(payload);
            if (msg == null || msg.type == null) {
                System.out.println("[DEBUG] 无法解析消息: " + (payload != null && payload.length() > 100 ? payload.substring(0, 100) + "..." : payload));
                return;
            }
            // 心跳与高频信令（ICE / 媒体状态 / 房间状态）不打日志，避免刷屏
            if (!"heartbeat".equals(msg.type)
                    && !"video_ice".equals(msg.type)
                    && !"screen_ice".equals(msg.type)
                    && !"media_state".equals(msg.type)) {
                System.out.println("[MSG] " + session.getId() + " type=" + msg.type + " nick=" + msg.nickname);
            }

            switch (msg.type) {
                case "auth" -> handleAuth(session, msg);
                case "auth_change_pwd" -> handleChangePwd(session, msg);
                case "chat" -> handleChat(session, msg);
                case "private" -> handlePrivate(session, msg);
                case "sync_since" -> handleSyncSince(session, msg);
                case "recall" -> handleRecall(session, msg);
                case "file" -> handleFile(session, msg);
                case "list" -> handleList(session);
                case "room_enter" -> handleRoomEnter(session, msg);
                case "room_leave" -> handleRoomLeave(session, msg);
                case "video_offer" -> handleVideoOffer(session, msg);
                case "video_answer" -> handleVideoAnswer(session, msg);
                case "video_ice" -> handleVideoIce(session, msg);
                case "screen_start" -> handleScreenStart(session, msg);
                case "screen_offer" -> handleScreenOffer(session, msg);
                case "screen_answer" -> handleScreenAnswer(session, msg);
                case "screen_ice" -> handleScreenIce(session, msg);
                case "screen_stop" -> handleScreenStop(session, msg);
                case "screen_watch" -> handleScreenWatch(session, msg);
            case "screen_unwatch" -> handleScreenUnwatch(session, msg);
                case "screen_status" -> handleScreenStatus(session);
                case "typing" -> handleTyping(session, msg);
                case "music_room_join" -> handleMusicRoomJoin(session, msg);
                case "music_room_leave" -> handleMusicRoomLeave(session, msg);
                case "music_room_pick" -> handleMusicRoomPick(session, msg);
                case "music_room_meta" -> handleMusicRoomMeta(session, msg);
                case "music_room_fail" -> handleMusicRoomFail(session, msg);
                case "music_room_skip" -> handleMusicRoomSkip(session, msg);
                case "media_state" -> handleMediaState(session, msg);
                case "user_status" -> handleUserStatus(session, msg);
                case "heartbeat" -> handleHeartbeat(session);
                case "call_rooms_state" -> {
                    broadcastCallRoomsState();
                    // 同时给请求者直接发送 call_status，确保即时更新
                    sendCallStatus(session);
                }
                case "quit" -> handleQuit(session, msg);
                default -> System.out.println("[DEBUG] 未处理的消息类型: " + msg.type);
            }
        } catch (Exception e) {
            System.err.println("消息处理错误: " + e.getMessage());
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String nickname = findNickBySession(session);
        System.out.println("[CLOSE] nick=" + nickname + " session=" + session.getId() + " code=" + status.getCode() + " reason=" + (status.getReason() != null ? status.getReason() : ""));
        if (nickname != null) {
            // 被新连接顶替的旧 socket（快速重连）→ 静默处理：
            // 只把该用户标记为断线（且仅在房间仍指向这条旧连接时才标记，
            // 否则会误把刚上线的那个新连接打成断线），不广播任何消息。
            Long supersededAt = supersededSessions.remove(session.getId());
            if (supersededAt != null) {
                UserSession current = room.getSession(nickname);
                if (current != null && current.getSession() != null
                        && current.getSession().getId().equals(session.getId())) {
                    room.disconnect(nickname);
                }
                System.out.println("[CLOSE] 旧连接被新连接顶替，静默处理 nick=" + nickname);
                return;
            }

            // 断线宽限期：标记为断线，不立即移除
            room.disconnect(nickname);
            fileBuffers.keySet().removeIf(k -> k.startsWith(nickname + "/"));

            // 屏幕共享观看者断线：从所有共享者的名单里摘掉（否则人数永远降不下来）
        removeScreenViewerEverywhere(nickname);

        // 听歌房参与者断连
            boolean wasInMusicRoom;
            synchronized (musicRoom) {
                int idx = new ArrayList<>(musicRoom.keySet()).indexOf(nickname);
                wasInMusicRoom = musicRoom.remove(nickname) != null;
                if (wasInMusicRoom && !musicRoom.isEmpty()) {
                    if (idx <= musicTurnIdx && musicTurnIdx > 0) musicTurnIdx--;
                    if (musicTurnIdx >= musicRoom.size()) musicTurnIdx = 0;
                    musicTurnStarted = System.currentTimeMillis();
                }
            }
            if (wasInMusicRoom) broadcastMusicRoomState();

            // 通话房间：进入宽限期而不是立刻移除，避免网络抖动直接掐断通话
            markCallRoomUnstable(nickname);

            boolean wasScreenSharing = screenShareParticipants.contains(nickname);

            if (wasScreenSharing) {
                Message stopMsg = new Message();
                stopMsg.type = "screen_stop";
                stopMsg.nickname = nickname;
                room.broadcastToAllOnline(stopMsg.toJson());
                screenShareParticipants.remove(nickname);
                System.out.println("屏幕共享自动终止（共享者已离开）");
            }

            Message sysMsg = Message.system(nickname + " 断开了连接");
            String json = sysMsg.toJson();
            room.broadcastToAllOnline(json);
            broadcastUserList();
            broadcastCallRoomsState();
            System.out.println(nickname + " 断开连接，进入宽限期");
        }
    }

    private String findNickBySession(WebSocketSession session) {
        for (Map.Entry<String, UserSession> entry : room.getSessions().entrySet()) {
            if (entry.getValue().getSession().getId().equals(session.getId())) {
                return entry.getKey();
            }
        }
        return null;
    }

    // ==================== Auth ====================
    private void handleAuth(WebSocketSession session, Message msg) {
        String nickname = msg.nickname;
        String password = msg.content;
        String subType = msg.subtype;

        if (nickname == null || nickname.trim().isEmpty()) {
            System.out.println("[AUTH FAIL] " + session.getId() + " 昵称为空");
            send(session, Message.authResp("fail", "昵称不能为空"));
            return;
        }
        nickname = nickname.trim();

        if ("login".equals(subType)) {
            if (!userManager.isRegistered(nickname)) {
                System.out.println("[AUTH FAIL] " + session.getId() + " 用户不存在: " + nickname);
                send(session, Message.authResp("fail", "用户不存在，请先注册"));
                return;
            }
            if (!userManager.authenticate(nickname, password)) {
                System.out.println("[AUTH FAIL] " + session.getId() + " 密码错误: " + nickname);
                send(session, Message.authResp("fail", "密码错误"));
                return;
            }
            UserSession existing = room.getSession(nickname);
            if (existing != null && existing.isOnline()) {
                // 同一条 WebSocket 重复 auth → 拒绝
                if (existing.getSession().getId().equals(session.getId())) {
                    System.out.println("[AUTH FAIL] " + session.getId() + " 重复认证: " + nickname);
                    send(session, Message.authResp("fail", "该用户已在线"));
                    return;
                }
                // 不同 WebSocket → 旧连接僵死（如WiFi断开TCP未超时），关闭并允许重连
                System.out.println("[AUTH] " + session.getId() + " 踢掉僵死连接: " + nickname + " old=" + existing.getSession().getId());
                // 先登记再关闭：保证旧 socket 的 afterConnectionClosed（可能同步触发）
                // 能识别出这是"被顶替"，从而静默处理而不是广播断线消息
                supersededSessions.put(existing.getSession().getId(), System.currentTimeMillis());
                // ★ 用自定义关闭码 4001 明确告知"被别处登录顶替"：
                //   客户端据此**停止自动重连**。否则两端会各自重连、互相顶号，
                //   形成"每秒断线重连"的死循环（同账号在手机+电脑同时打开时的典型症状）。
                try {
                    existing.getSession().close(new CloseStatus(4001, "已在其他设备登录"));
                } catch (Exception ignored) {}
                room.disconnect(nickname);
            }
            boolean isReconnect = existing != null;
            System.out.println("[AUTH OK] " + session.getId() + " " + nickname + (isReconnect ? " 重连" : " 登录"));
            doLogin(session, nickname, isReconnect);
        } else if ("register".equals(subType)) {
            if (userManager.isRegistered(nickname)) {
                System.out.println("[AUTH FAIL] " + session.getId() + " 注册用户已存在: " + nickname);
                send(session, Message.authResp("fail", "用户已存在，请直接登录"));
                return;
            }
            if (!com.chatroom2.util.InviteCodes.matches(inviteCode, msg.invite)) {
                System.out.println("[AUTH FAIL] " + session.getId() + " 注册码错误: " + nickname + " invite=" + msg.invite);
                send(session, Message.authResp("fail", "注册码错误"));
                return;
            }
            if (!com.chatroom2.model.UserManager.isPasswordAcceptable(password)) {
                System.out.println("[AUTH FAIL] " + session.getId() + " 注册密码长度不符: " + nickname);
                send(session, Message.authResp("fail", "密码需6-18位字母数字"));
                return;
            }
            if (false) {   // 规则已统一到 UserManager.isPasswordAcceptable
                System.out.println("[AUTH FAIL] " + session.getId() + " 注册密码含非法字符: " + nickname);
                send(session, Message.authResp("fail", "密码只能包含字母和数字"));
                return;
            }
            if (!userManager.register(nickname, password)) {
                System.out.println("[AUTH FAIL] " + session.getId() + " 注册失败: " + nickname);
                send(session, Message.authResp("fail", "注册失败"));
                return;
            }
            System.out.println("[AUTH OK] " + session.getId() + " " + nickname + " 注册");
            doLogin(session, nickname, false);
        }
    }

    private void doLogin(WebSocketSession session, String nickname, boolean isReconnect) {
        UserSession us = new UserSession(nickname, session);
        if (!room.join(us)) {
            send(session, Message.authResp("fail", "房间已满"));
            return;
        }

        // 生成文件访问 token，桥接 WebSocket 认证与 HTTP 下载接口
        String token = AuthTokenStore.getInstance().generate(nickname);

        Message resp = Message.authResp("ok", isReconnect ? "重连成功" : "登录成功");
        resp.nickname = nickname;
        resp.token = token;
        send(session, resp);

        // Send filtered history (skip stale system messages)
        List<String> history = room.getHistory();
        if (!history.isEmpty()) {
            send(session, Message.of("history_start"));
            for (String h : history) {
                try {
                    Message m = Message.fromJson(h);
                    // 跳过已过时的系统消息：在线人数/加入离开/通话状态/断线通知
                    if ("system".equals(m.type) && m.content != null && (
                        m.content.contains("在线") || m.content.contains("加入") ||
                        m.content.contains("离开") || m.content.contains("通话") ||
                        m.content.contains("屏幕") || m.content.contains("发起") ||
                        m.content.contains("关闭") || m.content.contains("断开连接") ||
                        m.content.contains("重连"))) {
                        continue;
                    }
                    // 跳过通话/屏幕共享的系统通知
                    if ("welcome".equals(m.type)) continue;
                    if ("call_status".equals(m.type)) continue;
                } catch (Exception e) { /* malformed history, send anyway */ }
                send(session, h);
            }
            send(session, Message.of("history_end"));
        }

        // P0-④ 离线私聊：把对方在自己离线期间发来的私聊补上（先未读汇总，再逐条补投）
        flushOfflinePrivate(session, nickname);

        if (isReconnect) {
            Message sysMsg = Message.system(nickname + " 已重连");
            String json = sysMsg.toJson();
            addHistoryIfWorth(json);
            room.broadcastToAllOnline(json);
        } else {
            Message welcome = Message.welcome(nickname, room.getUserCount());
            String welcomeJson = welcome.toJson();
            // welcome 不入历史（否则重登会被登录提示刷屏）
            room.broadcast(welcomeJson, nickname);
            send(session, welcomeJson);
        }

        broadcastUserList();
        // 通知新用户当前正在进行的屏幕共享，并让共享者向新用户发送 offer
        notifyActiveScreenShare(session, nickname);
        System.out.println(nickname + (isReconnect ? " 重连成功" : " 登录成功") + "，在线: " + room.getUserCount());
    }

    /** 通知新加入用户当前活跃的屏幕共享 */
    private void notifyActiveScreenShare(WebSocketSession newSession, String newNick) {
        if (screenShareParticipants.isEmpty()) return;
        for (String sharer : screenShareParticipants) {
            Message screenMsg = new Message();
            screenMsg.type = "screen_active";
            screenMsg.nickname = sharer;
            send(newSession, screenMsg);
        }
        System.out.println("[SCREEN-NOTIFY] 已通知新用户 " + newNick + " 当前共享者: " + screenShareParticipants);
    }

    // 访客认证：验证房间码 + 昵称
    private void handleChangePwd(WebSocketSession session, Message msg) {
        // 登录页修改密码：临时 WebSocket 无 session 关联，改用密码验证
        if (!isSessionOwner(session, msg.nickname)) {
            if (!userManager.authenticate(msg.nickname, msg.content)) {
                send(session, Message.of("auth_change_pwd_fail"));
                return;
            }
        }
        if (userManager.changePassword(msg.nickname, msg.content, msg.subtype)) {
            send(session, Message.of("auth_change_pwd_ok"));
        } else {
            send(session, Message.of("auth_change_pwd_fail"));
        }
    }

    // ==================== Chat ====================
    private void handleChat(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        if (isRateLimited(msg.nickname)) return;
        if (msg.content != null && msg.content.length() > MAX_MSG_LENGTH) return;
        // T3 幂等：同一 (nickname, msgId) 重复提交 → 只回执，不再入库/广播
        if (!reserveMsgId(msg.nickname, msg.msgId)) {
            System.out.println("[DEDUP] 重复提交，仅回执 nick=" + msg.nickname + " msgId=" + msg.msgId);
            sendChatAck(session, msg.msgId, true);
            return;
        }
        try {
            msg.serverTime = System.currentTimeMillis();
            String json = msg.toJson();
            addHistoryIfWorth(json);
            room.broadcast(json, msg.nickname);
            send(session, json);
            sendChatAck(session, msg.msgId, false);
        } catch (Exception e) {
            // 处理失败 → 撤销登记，客户端重发时还能正常入库（否则会变成"永久重复"而静默丢消息）
            releaseMsgId(msg.nickname, msg.msgId);
            System.err.println("聊天消息处理失败: " + e.getMessage());
        }
    }

    /**
     * 私聊 —— P0-④ 之后**对方离线也收**：消息一律落 {@link PrivateStore}，
     * 在线时顺手直发并标记已投递；离线时对方下次登录（或断线重连 sync_since）时补投。
     *
     * <p>改造前这里第一句就是 {@code if (!room.hasUser(receiver)) → private_fail}，
     * 对方不在线时消息**直接丢弃**（既不落库也不重发），这是当时最容易丢消息的路径。</p>
     *
     * <p>仍然 fail 的只有两种情况：收件人不是注册用户（昵称写错）、收件人是自己。</p>
     */
    private void handlePrivate(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        if (isRateLimited(msg.nickname)) return;
        if (msg.content != null && msg.content.length() > MAX_MSG_LENGTH) return;

        String receiver = msg.receiver == null ? "" : msg.receiver.trim();
        msg.receiver = receiver;
        if (receiver.isEmpty() || !userManager.isRegistered(receiver)) {
            send(session, privateFail(msg, receiver, "用户不存在，无法发送私聊"));
            return;
        }
        if (receiver.equals(msg.nickname)) {
            send(session, privateFail(msg, receiver, "不能给自己发私聊"));
            return;
        }
        // T3 幂等：同上
        if (!reserveMsgId(msg.nickname, msg.msgId)) {
            System.out.println("[DEDUP] 重复私聊提交，仅回执 nick=" + msg.nickname + " msgId=" + msg.msgId);
            sendChatAck(session, msg.msgId, true);
            return;
        }
        try {
            msg.serverTime = System.currentTimeMillis();
            String json = msg.toJson();

            // ① 落库（无论对方在不在线）：离线投递与断线补齐都以这份为准
            PrivateStore.Entry stored = privateStore.add(msg, json);
            // ② 给发送方回显（自己的消息在界面上只有一份，客户端按 msgId 去重）
            room.sendTo(msg.nickname, json);
            // ③ 对方在线 → 顺手直发 + 标记已投递；不在线 → 留在库里等对方上线补投
            boolean online = room.hasUser(receiver);
            if (online) {
                room.sendTo(receiver, json);
                privateStore.markDelivered(stored);
            }
            sendChatAck(session, msg.msgId, false);
            System.out.println("[PRIVATE] " + msg.nickname + " → " + receiver
                    + (online ? " 在线直发" : " 离线入库（待补投）")
                    + " msgId=" + msg.msgId);
        } catch (Exception e) {
            releaseMsgId(msg.nickname, msg.msgId);
            System.err.println("私聊消息处理失败: " + e.getMessage());
        }
    }

    /** 私聊失败回执（带上 msgId，客户端据此只删掉这一条，并让发送队列把它标为失败）。 */
    private Message privateFail(Message src, String receiver, String reason) {
        Message fail = new Message();
        fail.type = "private_fail";
        fail.nickname = receiver;
        fail.content = reason;
        fail.msgId = src == null ? null : src.msgId;
        fail.receiver = receiver;
        return fail;
    }

    /**
     * 登录时补投离线私聊：先下发未读汇总（客户端据此上角标），再逐条补发（带 {@code offlineMsg:true}），
     * 最后把该用户名下所有未投递记录标记为已投递。
     *
     * @return 补投条数
     */
    private int flushOfflinePrivate(WebSocketSession session, String nickname) {
        int total = privateStore.undeliveredCount(nickname);
        int dropped = privateStore.droppedFor(nickname);
        if (total > 0 || dropped > 0) {
            Message pending = Message.privatePending(total, privateStore.undeliveredBySender(nickname), dropped);
            send(session, pending);
        }
        if (total == 0) return 0;
        int sent = 0;
        for (PrivateStore.Entry e : privateStore.pendingFor(nickname)) {
            Message m;
            try {
                m = Message.fromJson(e.json);
            } catch (Exception ex) {
                continue;      // 坏记录跳过，不让它拖住整个补投
            }
            if (m == null) continue;
            m.offlineMsg = true;  // 客户端据此显示「离线」标记并且不自动弹窗
            send(session, m.toJson());
            sent++;
        }
        privateStore.markDeliveredFor(nickname);
        System.out.println("[PRIVATE] 登录补投离线私聊 nick=" + nickname + " 条数=" + sent
                + (dropped > 0 ? " 另因容量上限丢弃=" + dropped + "（已如实告知）" : ""));
        return sent;
    }

    // ==================== T3: 幂等去重 / 回执 / 断线补齐 ====================

    /**
     * 幂等登记：返回 true = 首次见到该 (nickname, msgId)，可以正常处理。
     *
     * <p>用 {@code putIfAbsent} 保证同一时刻两个线程提交同一 msgId 只有一个能拿到 true。
     * msgId 为空（老客户端 / 系统消息）时不去重，一律放行。</p>
     */
    private boolean reserveMsgId(String nickname, String msgId) {
        if (msgId == null || msgId.isEmpty()) return true;
        String key = nickname + "|" + msgId;
        Long prev = seenMsgIds.putIfAbsent(key, System.currentTimeMillis());
        if (prev == null) {
            if (seenMsgIds.size() > DEDUP_MAX_ENTRIES) trimSeenMsgIds();
            return true;
        }
        return false;
    }

    /** 处理失败时撤销登记（让重发还能算作首次）。 */
    private void releaseMsgId(String nickname, String msgId) {
        if (msgId == null || msgId.isEmpty()) return;
        seenMsgIds.remove(nickname + "|" + msgId);
    }

    /**
     * 去重表超出硬上限时的兜底：先清过期，仍超则按登记时间淘汰最旧的一半。
     * 只在被洪泛时才走到这里（正常 10 分钟窗口内根本到不了 2 万条）。
     */
    private void trimSeenMsgIds() {
        long cutoff = System.currentTimeMillis() - DEDUP_WINDOW_MS;
        seenMsgIds.entrySet().removeIf(e -> e.getValue() < cutoff);
        int size = seenMsgIds.size();
        if (size <= DEDUP_MAX_ENTRIES) return;
        List<Map.Entry<String, Long>> all = new ArrayList<>(seenMsgIds.entrySet());
        all.sort(Map.Entry.comparingByValue());
        int target = Math.max(DEDUP_MAX_ENTRIES / 2, size - DEDUP_MAX_ENTRIES / 2);
        for (int i = 0; i < all.size() - target; i++) {
            seenMsgIds.remove(all.get(i).getKey(), all.get(i).getValue());
        }
        System.out.println("[DEDUP] 去重表超限，淘汰最旧登记 " + (all.size() - target) + " 条，剩余 " + seenMsgIds.size());
    }

    /** 回执：告诉发送方"这条已处理"，duplicate=true 表示服务端此前已收到过（客户端可安全出队）。 */
    private void sendChatAck(WebSocketSession session, String msgId, boolean duplicate) {
        send(session, Message.chatAck(msgId, System.currentTimeMillis(), duplicate));
    }

    /**
     * 断线补齐：客户端带上自己已有的最新时间戳，服务端返回之后的消息。
     *
     * <p>边界处理见 {@link #parseSince}、{@link #isTruncated} 与 sync_result 的 truncated 字段：
     * 省略/0/非法 → 全量；早于缓冲区最早 → 全量 + truncated=true；晚于最新 → 空；
     * 缓冲区为空 → 空 + truncated=<b>false</b>（清空聊天记录后老客户端重连即此情形）。</p>
     */
    private void handleSyncSince(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        if (isRateLimited(msg.nickname)) return;

        Long since = parseSince(msg.since, msg.nickname);
        List<String> hist = room.getHistory();

        long oldest = Long.MAX_VALUE;
        long newest = Long.MIN_VALUE;
        int[] timed = {0};   // 可判定时间戳的条目数
        for (String h : hist) {
            long ts = historyTs(h);
            if (ts <= 0) continue;
            timed[0]++;
            if (ts < oldest) oldest = ts;
            if (ts > newest) newest = ts;
        }
        boolean hasTimed = timed[0] > 0;

        List<String> out = new ArrayList<>();
        boolean truncated;
        if (since == null) {
            out.addAll(hist);            // 全量：缓冲区里有什么给什么（含系统消息）
            truncated = false;
        } else {
            for (String h : hist) {
                long ts = historyTs(h);
                if (ts > since) out.add(h);   // 时间戳无法判定的条目（系统消息）不做增量补齐
            }
            // 要的起点早于缓冲区最早一条（或缓冲区里没有可判定时间的消息）⇒ 缺口可能已淘汰，标记截断
            truncated = isTruncated(hasTimed, since, oldest, hist.isEmpty());
        }

        // P0-④ 离线私聊：补上"本人涉及"（自己发的 / 发给自己的）的私聊。
        // 可见性由 PrivateStore.relatedTo / sinceFor 保证 —— 只可能返回本人是发件人或收件人的消息。
        List<PrivateStore.Entry> privEntries;
        boolean privTruncated;
        if (since == null) {
            privEntries = privateStore.relatedTo(msg.nickname);
            privTruncated = privateStore.droppedFor(msg.nickname) > 0;
        } else {
            privEntries = privateStore.sinceFor(msg.nickname, since);
            Long oldestPriv = privateStore.oldestFor(msg.nickname);
            privTruncated = privateStore.droppedFor(msg.nickname) > 0
                    || (oldestPriv != null && since < oldestPriv);
        }
        for (PrivateStore.Entry e : privEntries) out.add(e.json);
        if (!privEntries.isEmpty()) {
            // 已经随本次 sync 投给本人了 → 之后不必再走"登录补投"
            privateStore.markDeliveredFor(msg.nickname);
        }
        truncated = truncated || privTruncated;

        Message resp = Message.syncResult(out, truncated, hasTimed ? oldest : null, hasTimed ? newest : null);
        send(session, resp);
        System.out.println("[SYNC] nick=" + msg.nickname
                + " since=" + (since == null ? "<全量>" : since)
                + " 缓冲=" + hist.size() + " 命中=" + out.size() + "（含私聊 " + privEntries.size() + "）"
                + " truncated=" + truncated
                + (hasTimed ? " 区间=[" + oldest + "," + newest + "]" : " 区间=<无>"));
    }

    /**
     * 增量补齐时「缺口可能补不齐」的判定（抽成静态方法，便于单测直接覆盖四种分支）。
     *
     * <p><b>2026-09-24 修正</b>：旧实现是 {@code truncated = !hasTimed || since < oldest}，把
     * <b>空缓冲区</b>也判成截断 —— 于是"清空聊天记录之后"，任何带着旧 {@code since} 重连的客户端
     * 都会收到 {@code truncated=true}，前端状态条随即冒出"更早的消息已无法恢复"（而其实一条都没丢）。
     * 现在的规则：</p>
     * <ul>
     *   <li><b>缓冲区为空</b> ⇒ 不截断（根本没有任何消息可丢）；</li>
     *   <li>缓冲区非空但一条都判不了时间戳（全是系统消息）⇒ 保守标记截断；</li>
     *   <li>有可判定时间戳 ⇒ 老规矩：{@code since} 早于缓冲区最早一条才算截断。</li>
     * </ul>
     *
     * @param hasTimed    缓冲区里存在可判定时间戳的消息
     * @param since       客户端已见过的最新时间戳（此处 > 0）
     * @param oldest      缓冲区里最早一条的时间戳（{@code hasTimed=false} 时无意义）
     * @param bufferEmpty 缓冲区为空
     */
    static boolean isTruncated(boolean hasTimed, long since, long oldest, boolean bufferEmpty) {
        if (bufferEmpty) return false;
        if (!hasTimed) return true;
        return since < oldest;
    }

    /**
     * 解析 sync_since 的 since。返回 {@code null} = 按"全量"处理。
     *
     * <p>非法值（非数字、负数、超出 long 范围、数组/对象等）一律不抛异常，记一条日志后按全量处理。</p>
     */
    private Long parseSince(Object raw, String nickname) {
        if (raw == null) return null;                       // 省略 = 全量
        long v;
        if (raw instanceof Number) {
            double d = ((Number) raw).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d) || d > Long.MAX_VALUE || d < Long.MIN_VALUE) {
                System.out.println("[SYNC] since 超出可解析范围(" + raw + ")，按全量处理 nick=" + nickname);
                return null;
            }
            v = (long) d;
        } else if (raw instanceof String) {
            String s = ((String) raw).trim();
            try {
                v = Long.parseLong(s);
            } catch (NumberFormatException e) {
                System.out.println("[SYNC] since 非数字(\"" + s + "\")，按全量处理 nick=" + nickname);
                return null;
            }
        } else {
            System.out.println("[SYNC] since 类型非法(" + raw.getClass().getSimpleName() + ")，按全量处理 nick=" + nickname);
            return null;
        }
        if (v == 0) return null;                            // 显式 0 = 全量
        if (v < 0) {
            System.out.println("[SYNC] since 为负(" + v + ")，按全量处理 nick=" + nickname);
            return null;
        }
        return v;
    }

    /**
     * 历史条目的时间戳（毫秒）。优先取 msgId 前缀（客户端时钟，与客户端传上来的 since 同源），
     * 其次取 serverTime（服务端时钟），都取不到返回 0（视为"时间未知"，增量补齐里不返回）。
     */
    private static long historyTs(String json) {
        try {
            Message m = Message.fromJson(json);
            if (m == null) return 0L;
            if (m.msgId != null) {
                int idx = m.msgId.indexOf('_');
                if (idx > 0) {
                    try {
                        long t = Long.parseLong(m.msgId.substring(0, idx));
                        if (t > 0) return t;
                    } catch (NumberFormatException ignored) { /* 落到 serverTime */ }
                }
            }
            if (m.serverTime != null && m.serverTime > 0) return m.serverTime;
        } catch (Exception ignored) {}
        return 0L;
    }


    private void handleRecall(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        if (msg.msgId != null) {
            int idx = msg.msgId.indexOf('_');
            if (idx > 0) {
                try {
                    long msgTime = Long.parseLong(msg.msgId.substring(0, idx));
                    if (System.currentTimeMillis() - msgTime > RECALL_LIMIT_MS) {
                        send(session, Message.recallFail("只能撤回3分钟内的消息"));
                        return;
                    }
                } catch (NumberFormatException e) {
                    // msgId 格式异常，拒绝撤回
                    send(session, Message.recallFail("消息ID无效，无法撤回"));
                    return;
                }
            } else {
                send(session, Message.recallFail("消息ID无效，无法撤回"));
                return;
            }
        }
        String json = msg.toJson();
        addHistoryIfWorth(json);
        room.broadcast(json, msg.nickname);
        send(session, json);
    }

    // ==================== File ====================
    // 文件通过 HTTP POST /api/files/upload 上传，WebSocket 仅传递元数据
    private void handleFile(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        if (isRateLimited(msg.nickname)) return;

        String filename = sanitize(msg.filename);
        if (filename == null) return;

        // 只广播元数据（不含 base64），所有客户端通过 REST API 下载/预览
        msg.content = null;
        String json = msg.toJson();
        addHistoryIfWorth(json);
        // exclude sender — sender already shows the file card from send-side code
        room.broadcast(json, msg.nickname);
        send(session, json);
    }

    // ==================== User List ====================
    private void handleList(WebSocketSession session) {
        Message msg = Message.userlist(room.getUserNames());
        msg.roles = buildRoles();
        send(session, msg);
    }

    // ==================== Call Rooms（语音房 12/6 人、视频房 8/6 人，可在通话中换房）====================

    private Set<String> getVideoRoom(int r) { return r == 2 ? videoRoom2 : videoRoom1; }
    private Set<String> getVoiceRoom(int r) { return r == 2 ? voiceRoom2 : voiceRoom1; }

    /** 根据 subtype 判断是视频还是语音房间 */
    private boolean isVoiceCall(Message msg) {
        return "voice".equals(msg.subtype);
    }

    private void handleRoomEnter(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        boolean isVoice = isVoiceCall(msg);
        String subtype = isVoice ? "voice" : "video";
        int roomNum = (msg.online != null && msg.online == 2) ? 2 : 1;
        Set<String> targetRoom = isVoice ? getVoiceRoom(roomNum) : getVideoRoom(roomNum);
        ConcurrentHashMap<String, Integer> roomMap = isVoice ? voiceRoomMap : videoRoomMap;
        String roomLabel = (isVoice ? "语音" : "视频") + "房间" + roomNum;

        // ★ 关键修复：先把该用户从"另一种类型"的通话房间里彻底清掉。
        //   历史 bug：只看本 subtype 的 map，于是"曾进过视频房间"会在 videoRoomMap 里留下
        //   永久残留；而 getCallRoomForSender() 优先查视频房间 ⇒ 该用户进语音房间后，
        //   服务端仍认为他在视频房间 ⇒ 与语音对端的 video_ice 全被判"跨房间"而丢弃
        //   ⇒ 表现为"候选都拿到了（host/srflx/relay 都有）但 ICE 永远 disconnected"。
        if (isVoice) {
            Integer vOther = videoRoomMap.remove(msg.nickname);
            if (vOther != null) {
                removeFromCallRoom(msg.nickname, false, vOther, true);
                System.out.println("[CALL] " + msg.nickname + " 清理残留的视频房间" + vOther + "（进语音房间）");
            }
        } else {
            Integer oOther = voiceRoomMap.remove(msg.nickname);
            if (oOther != null) {
                removeFromCallRoom(msg.nickname, true, oOther, true);
                System.out.println("[CALL] " + msg.nickname + " 清理残留的语音房间" + oOther + "（进视频房间）");
            }
        }

        System.out.println("[CALL] room_enter from " + msg.nickname + " " + roomLabel + " existing=" + targetRoom);

        Integer currentRoom = roomMap.get(msg.nickname);
        if (targetRoom.contains(msg.nickname)) {
            // 幂等：重复 enter / 宽限期内重连。旧版本这里只回显一条 room_enter，
            // 不给房间状态，逼得前端 3 秒后盲重发一次 —— 现在直接补一份权威状态。
            boolean resumed = callRoomGraceUntil.remove(msg.nickname) != null;
            send(session, msg);
            sendRoomStateTo(session, targetRoom, roomNum, subtype);
            if (resumed) {
                broadcastToCallRoom(targetRoom, Message.peerResume(msg.nickname, subtype).toJson(), msg.nickname);
                System.out.println("[CALL] " + msg.nickname + " 宽限期内恢复通话 " + roomLabel);
            }
            broadcastCallRoomsState();
            return;
        }
        // 换房间：先把旧的清掉，避免一个人同时挂在两个房间
        if (currentRoom != null && currentRoom != roomNum) {
            removeFromCallRoom(msg.nickname, isVoice, currentRoom, true);
        }
        int max = roomCapacity(isVoice, roomNum);
        if (targetRoom.size() >= max) {
            send(session, Message.system(roomLabel + "已满（" + max + "人）"));
            return;
        }
        targetRoom.add(msg.nickname);
        roomMap.put(msg.nickname, roomNum);
        callRoomGraceUntil.remove(msg.nickname);
        broadcastToCallRoom(targetRoom, msg.toJson(), msg.nickname);
        send(session, msg);
        // 立即给新加入者直发房间状态（不依赖去抖后的广播，消除"收不到状态"的竞态）
        sendRoomStateTo(session, targetRoom, roomNum, subtype);
        // 补齐房间内已有成员的麦克风/摄像头状态，让新加入者立刻显示正确角标
        for (String nick : new ArrayList<>(targetRoom)) {
            if (nick.equals(msg.nickname)) continue;
            String st = mediaStates.get(nick);
            if (st != null) {
                Message m = Message.fromJson(st);
                m.nickname = nick;
                send(session, m);
            }
        }
        broadcastCallRoomsState();
    }

    private void handleRoomLeave(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        boolean isVoice = isVoiceCall(msg);
        ConcurrentHashMap<String, Integer> roomMap = isVoice ? voiceRoomMap : videoRoomMap;
        Integer roomNum = roomMap.remove(msg.nickname);
        callRoomGraceUntil.remove(msg.nickname);
        // 防御：另一类型若有残留条目也一并清掉，避免"一个人挂在两个房间"
        if (isVoice) {
            Integer vOther = videoRoomMap.remove(msg.nickname);
            if (vOther != null) removeFromCallRoom(msg.nickname, false, vOther, true);
        } else {
            Integer oOther = voiceRoomMap.remove(msg.nickname);
            if (oOther != null) removeFromCallRoom(msg.nickname, true, oOther, true);
        }
        // ★ 重要：只有"确实从房间里移除了"才回执。
        //   旧实现无条件 send(session, msg) 把这条 room_leave 原样回声给发送者，
        //   而客户端收到"自己的 room_leave"会走"被移出"分支→（旧版会）回发一条 room_leave
        //   ⇒ 与服务端回声形成**无限互发**：消息风暴、cmd 窗口刷屏、通话瞬间被拆掉。
        if (roomNum == null) {
            System.out.println("[CALL] " + msg.nickname + " 重复 room_leave（本就不在通话房间），不再回声");
            return;
        }
        send(session, msg);
        // ⑤ 正常离开也要通知房间成员：否则对端要等到下一次心跳/状态广播才更新
        //   （用户反馈：一方退出后另一方界面不实时更新）。removeFromCallRoom 会排除本人，
        //   因此不会与「自己被移出」的处理形成回声环。
        removeFromCallRoom(msg.nickname, isVoice, roomNum, true);
        broadcastCallRoomsState();
    }

    /** 从指定通话房间移除用户；notify=true 时向房间内其余成员广播 room_leave */
    private void removeFromCallRoom(String nickname, boolean isVoice, int roomNum, boolean notify) {
        Set<String> targetRoom = isVoice ? getVoiceRoom(roomNum) : getVideoRoom(roomNum);
        if (!targetRoom.remove(nickname)) return;
        if (notify) {
            Message leaveMsg = new Message();
            leaveMsg.type = "room_leave";
            leaveMsg.nickname = nickname;
            leaveMsg.subtype = isVoice ? "voice" : "video";
            broadcastToCallRoom(targetRoom, leaveMsg.toJson(), nickname);
        }
    }

    /** 通话房间状态广播（带 150ms 去抖，合并频繁进出的重复广播） */
    private void broadcastCallRoomsState() {
        long wait = CALL_STATE_DEBOUNCE_MS - (System.currentTimeMillis() - lastCallStateAt);
        if (wait <= 0) {
            doBroadcastCallRoomsState();
            return;
        }
        // 旧实现在这里直接 return（丢弃），当两个用户同时进出房间时，
        // 后一次广播被吞掉 → 那批用户永远收不到 room_state。改为延后重放。
        if (callStateScheduled.compareAndSet(false, true)) {
            try {
                cleanupScheduler.schedule(() -> {
                    try {
                        doBroadcastCallRoomsState();
                    } finally {
                        callStateScheduled.set(false);
                    }
                }, wait, TimeUnit.MILLISECONDS);
            } catch (Exception e) {
                callStateScheduled.set(false);
            }
        }
    }

    private void doBroadcastCallRoomsState() {
        synchronized (callStateLock) {
            lastCallStateAt = System.currentTimeMillis();
            // 视频房间
            List<String> vr1, vr2;
            synchronized (videoRoom1) { vr1 = new ArrayList<>(videoRoom1); }
            synchronized (videoRoom2) { vr2 = new ArrayList<>(videoRoom2); }
            broadcastRoomState(vr1, 1, "video");
            broadcastRoomState(vr2, 2, "video");

            // 语音房间
            List<String> or1, or2;
            synchronized (voiceRoom1) { or1 = new ArrayList<>(voiceRoom1); }
            synchronized (voiceRoom2) { or2 = new ArrayList<>(voiceRoom2); }
            broadcastRoomState(or1, 1, "voice");
            broadcastRoomState(or2, 2, "voice");

            // call_status 广播给非参与者：4 个房间人数
            // online=video1, count=video2, users=voice1列表, offline=voice2列表
            List<String> allCall = new ArrayList<>(vr1); allCall.addAll(vr2); allCall.addAll(or1); allCall.addAll(or2);
            Message status = Message.callStatus(allCall.size());
            status.users = allCall;
            status.online = vr1.size();    // 视频房间1人数
            status.count = vr2.size();     // 视频房间2人数
            status.offline = new ArrayList<>(or2);  // 语音房间2列表
            status.subtype = String.valueOf(or1.size()); // 语音房间1人数（用字符串传）
            status.caps = roomCaps();      // 各房间容量（客户端显示 n/cap 人）
            String json = status.toJson();
            for (UserSession session : room.getSessions().values()) {
                try {
                    // ② 广播给所有在线用户（含通话中的参与者）。
                    //   旧实现排除了"任何通话房间里的参与者"⇒ 在语音房里的人永远收不到
                    //   视频房间的人数（用户反馈：电脑发起视频通话，手机端显示 0 人）。
                    //   status.users 是四个房间成员的完整列表，对参与者也是权威刷新，不会丢状态。
                    if (session.isOnline()) {
                        session.send(json);
                    }
                } catch (Exception ignored) {}
            }
        }
    }

    /** 把某个房间的权威状态直发给一个 session（不依赖去抖广播） */
    private void sendRoomStateTo(WebSocketSession session, Set<String> roomSet, int roomNum, String subtype) {
        List<String> users;
        synchronized (roomSet) { users = new ArrayList<>(roomSet); }
        Message state = new Message();
        state.type = "room_state";
        state.users = users;
        state.count = users.size();
        state.online = roomNum;
        state.subtype = subtype;
        send(session, state);
    }

    /** 向单个 session 发送 call_status（4 房间人数摘要） */
    private void sendCallStatus(WebSocketSession session) {
        List<String> vr1, vr2, or1, or2;
        synchronized (videoRoom1) { vr1 = new ArrayList<>(videoRoom1); }
        synchronized (videoRoom2) { vr2 = new ArrayList<>(videoRoom2); }
        synchronized (voiceRoom1) { or1 = new ArrayList<>(voiceRoom1); }
        synchronized (voiceRoom2) { or2 = new ArrayList<>(voiceRoom2); }
        List<String> allCall = new ArrayList<>(vr1); allCall.addAll(vr2); allCall.addAll(or1); allCall.addAll(or2);
        Message status = Message.callStatus(allCall.size());
        status.users = allCall;
        status.online = vr1.size();
        status.count = vr2.size();
        status.offline = new ArrayList<>(or2);
        status.subtype = String.valueOf(or1.size());
        status.caps = roomCaps();
        send(session, status);
    }

    private void broadcastRoomState(List<String> users, int roomNum, String subtype) {
        Message state = new Message();
        state.type = "room_state";
        state.users = users;
        state.count = users.size();
        state.online = roomNum;
        state.subtype = subtype;
        String json = state.toJson();
        for (String nick : users) {
            UserSession us = room.getSession(nick);
            if (us != null && us.isOnline()) us.send(json);
        }
    }

    private void broadcastToCallRoom(Set<String> roomSet, String json, String excludeNick) {
        synchronized (roomSet) {
            for (String nick : roomSet) {
                if (nick.equals(excludeNick)) continue;
                UserSession us = room.getSession(nick);
                if (us != null && us.isOnline()) us.send(json);
            }
        }
    }

    /** 清理指定用户在所有通话房间中的状态（断线/退出时调用） */
    private void cleanupCallRoomsFor(String nickname) {
        Integer vr = videoRoomMap.remove(nickname);
        if (vr != null) { getVideoRoom(vr).remove(nickname); }
        Integer or = voiceRoomMap.remove(nickname);
        if (or != null) { getVoiceRoom(or).remove(nickname); }
        callRoomGraceUntil.remove(nickname);
        mediaStates.remove(nickname);
    }

    /**
     * 掉线时把用户在通话房间里的席位标记为"不稳定"，并通知同房间成员。
     * 席位保留 callGraceMs，期间重连（room_enter）即可恢复；超时由扫描任务真正移除。
     */
    private void markCallRoomUnstable(String nickname) {
        Integer vr = videoRoomMap.get(nickname);
        Integer or = voiceRoomMap.get(nickname);
        if (vr == null && or == null) return;
        callRoomGraceUntil.put(nickname, System.currentTimeMillis());
        if (vr != null) {
            broadcastToCallRoom(getVideoRoom(vr), Message.peerUnstable(nickname, "video").toJson(), nickname);
        }
        if (or != null) {
            broadcastToCallRoom(getVoiceRoom(or), Message.peerUnstable(nickname, "voice").toJson(), nickname);
        }
        long grace = callGraceMs > 0 ? callGraceMs : 45_000L;
        System.out.println("[CALL] " + nickname + " 掉线，通话席位保留 " + (grace / 1000) + "s");
    }

    /** 真正把用户移出通话房间并通知同房间成员（宽限期到点 / 主动退出时调用） */
    private void disconnectFromCallRooms(String nickname) {
        // ★ 幂等守卫（重要）：若该用户已不在任何通话房间，说明这是重复的 room_leave。
        //   典型来源：客户端收到“自己被移出”的通知后回发 room_leave。若这里再通知一次本人，
        //   就会与客户端形成无限回声环（消息风暴、日志爆量、服务端被拖垮，
        //   表现为“一发起通话就掉线 + cmd 窗口刷屏”）。已实测复现，故在此硬性拦住。
        if (!videoRoomMap.containsKey(nickname) && !voiceRoomMap.containsKey(nickname)) {
            System.out.println("[CALL] " + nickname + " 重复 room_leave（已不在通话房间），忽略");
            return;
        }
        callRoomGraceUntil.remove(nickname);
        mediaStates.remove(nickname);
        // 视频房间
        Integer vr = videoRoomMap.remove(nickname);
        if (vr != null) {
            Set<String> room = getVideoRoom(vr);
            room.remove(nickname);
            Message leaveMsg = new Message();
            leaveMsg.type = "room_leave";
            leaveMsg.nickname = nickname;
            leaveMsg.subtype = "video";
            broadcastToCallRoom(room, leaveMsg.toJson(), nickname);
        }
        // 语音房间
        Integer or = voiceRoomMap.remove(nickname);
        if (or != null) {
            Set<String> room = getVoiceRoom(or);
            room.remove(nickname);
            Message leaveMsg = new Message();
            leaveMsg.type = "room_leave";
            leaveMsg.nickname = nickname;
            leaveMsg.subtype = "voice";
            broadcastToCallRoom(room, leaveMsg.toJson(), nickname);
        }
        if (vr != null || or != null) {
            // ★ 通知"被移出的本人"：他可能已经重连、但没有重新进房（room_enter），
            //   这样他的客户端会一直以为自己还在通话频道里 —— 表现为
            //   "对端看到我掉线了，我自己界面还显示在频道内"的两端状态不一致。
            UserSession self = room.getSession(nickname);
            if (self != null && self.isOnline() && self.getSession() != null) {
                Message selfLeave = new Message();
                selfLeave.type = "room_leave";
                selfLeave.nickname = nickname;
                selfLeave.subtype = (vr != null) ? "video" : "voice";
                selfLeave.reason = "grace_expired";
                try {
                    send(self.getSession(), selfLeave.toJson());
                } catch (Exception ignored) {}
            }
            broadcastCallRoomsState();
        }
    }

    /** 根据 subtype 和 nickname 查找所在房间，用于视频信令路由 */
    private Set<String> getCallRoomFor(String nickname, String subtype) {
        if ("voice".equals(subtype)) {
            Integer rn = voiceRoomMap.get(nickname);
            return rn != null ? getVoiceRoom(rn) : null;
        } else {
            Integer rn = videoRoomMap.get(nickname);
            return rn != null ? getVideoRoom(rn) : null;
        }
    }

    private void handleVideoOffer(WebSocketSession session, Message msg) {
        if (!isVideoSignalAllowed(session, msg)) return;
        room.sendTo(msg.receiver, msg.toJson());
    }

    private void handleVideoAnswer(WebSocketSession session, Message msg) {
        if (!isVideoSignalAllowed(session, msg)) return;
        room.sendTo(msg.receiver, msg.toJson());
    }

    private void handleVideoIce(WebSocketSession session, Message msg) {
        if (!isVideoSignalAllowed(session, msg)) return;
        room.sendTo(msg.receiver, msg.toJson());
    }

    /** 麦克风/摄像头开关状态，转发给同通话房间成员（用于对端画角标） */
    private void handleMediaState(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        Set<String> cr = getCallRoomForSender(msg.nickname);
        if (cr == null) return;
        boolean audioOn = msg.audioOn == null || msg.audioOn;
        boolean videoOn = msg.videoOn == null || msg.videoOn;
        Message out = Message.mediaState(msg.nickname, audioOn, videoOn);
        mediaStates.put(msg.nickname, out.toJson());
        broadcastToCallRoom(cr, out.toJson(), msg.nickname);
    }

    private Set<String> getCallRoomForSender(String nickname) {
        Integer rn = videoRoomMap.get(nickname);
        if (rn != null) return getVideoRoom(rn);
        rn = voiceRoomMap.get(nickname);
        if (rn != null) return getVoiceRoom(rn);
        return null;
    }

    // ==================== Screen Share ====================
    // ===== 观看者名单（服务端权威，2026-09-25）=====
    // 为什么放服务端：客户端两侧各自维护 PC 表会不一致 —— 观看者点 ✕ 只是本地关闭（PC 还活着）、
    // 页面重新可见时又会自动重发 screen_watch，于是共享者面板的人数忽多忽少
    //（用户实测：一个人共享显示 2 人；观看者退出反而 +1）。
    private final java.util.concurrent.ConcurrentHashMap<String, java.util.LinkedHashSet<String>> screenViewers
            = new java.util.concurrent.ConcurrentHashMap<>();

    /** 把某位共享者的观看者名单下发给他自己 */
    private void sendScreenViewers(String sharer) {
        if (sharer == null) return;
        UserSession us = room.getSession(sharer);
        if (us == null || !us.isOnline()) return;
        java.util.LinkedHashSet<String> set = screenViewers.get(sharer);
        Message m = new Message();
        m.type = "screen_viewers";
        m.nickname = sharer;
        m.users = new java.util.ArrayList<>();
        if (set != null) {
            for (String v : set) if (!v.equals(sharer)) m.users.add(v);   // 防御：名单里永不含共享者自己
        }
        m.count = m.users.size();
        try { us.send(m.toJson()); } catch (Exception ignored) {}
    }

    /** 某人断线时，把他从所有共享者的观看者名单里摘掉 */
    private void removeScreenViewerEverywhere(String viewer) {
        if (viewer == null) return;
        for (var e : screenViewers.entrySet()) {
            java.util.LinkedHashSet<String> set = e.getValue();
            if (set.remove(viewer)) sendScreenViewers(e.getKey());
        }
    }

    private void handleScreenStart(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        synchronized (screenShareParticipants) {
            // 同一用户切换清晰度
            if (screenShareParticipants.contains(msg.nickname)) {
                room.broadcast(msg.toJson(), msg.nickname);
                return;
            }
            // 其他人正在共享 — 原子拦截
            if (!screenShareParticipants.isEmpty()) {
                String currentSharer = screenShareParticipants.iterator().next();
                System.out.println("[SCREEN-BLOCK] " + msg.nickname + " 被阻止，当前共享者: " + currentSharer);
                Message blocked = new Message();
                blocked.type = "screen_blocked";
                blocked.content = currentSharer + " 正在共享屏幕";
                blocked.nickname = currentSharer;
                send(session, blocked);
                return;
            }
            screenShareParticipants.add(msg.nickname);
            System.out.println("[SCREEN-START] " + msg.nickname + " 开始共享，participants=" + screenShareParticipants);
            screenViewers.remove(msg.nickname);        // 新一轮共享：名单清空
        }
        room.broadcast(msg.toJson(), msg.nickname);
        sendScreenViewers(msg.nickname);
    }

    private void handleScreenOffer(WebSocketSession session, Message msg) {
        // 定向发送给 receiver，避免多观看者时 offer 被错误接收方处理
        if (!isScreenSignalAllowed(session, msg)) return;
        room.sendTo(msg.receiver, msg.toJson());
    }

    private void handleScreenAnswer(WebSocketSession session, Message msg) {
        if (!isScreenSignalAllowed(session, msg)) return;
        room.sendTo(msg.receiver, msg.toJson());
    }

    private void handleScreenIce(WebSocketSession session, Message msg) {
        // ICE candidate 同样定向发送给 receiver
        if (!isScreenSignalAllowed(session, msg)) return;
        room.sendTo(msg.receiver, msg.toJson());
    }

    private void handleScreenStop(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        screenShareParticipants.remove(msg.nickname);
        room.broadcast(msg.toJson(), msg.nickname);
        send(session, msg);
    }

    /** 新加入者主动请求观看当前屏幕共享 */
    private void handleScreenWatch(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        String sharer = msg.receiver;
        if (sharer != null && sharer.equals(msg.nickname)) {
            // 共享者请求观看**自己**的共享 ⇒ 忽略。
            // 否则服务端会把他记进观看者名单、他给自己建一条 PC（have-local-offer）⇒ 人数凭空 +1
            //（用户实测"一个人在线刚开始共享就显示两人观看"；触发点是页面切回可见时的自动重发观看请求）
            System.out.println("[SCREEN-WATCH] 忽略自己看自己：" + msg.nickname);
            return;
        }
        if (sharer == null || !screenShareParticipants.contains(sharer)) {
            System.out.println("[SCREEN-WATCH] 请求观看失败 — sharer=" + sharer + " 不在共享列表中 " + screenShareParticipants);
            return;
        }
        UserSession sharerSession = room.getSession(sharer);
        if (sharerSession == null || !sharerSession.isOnline()) return;
        Message notify = new Message();
        notify.type = "screen_new_viewer";
        notify.nickname = sharer;
        notify.receiver = msg.nickname;
        sharerSession.send(notify.toJson());
    screenViewers.computeIfAbsent(sharer, x -> new java.util.LinkedHashSet<>()).add(msg.nickname);
    sendScreenViewers(sharer);
        System.out.println("[SCREEN-WATCH] " + msg.nickname + " → 请求观看 " + sharer + " 的共享");
    }

    /** 查询当前屏幕共享状态（服务端权威判断） */
    /**
     * 观看者关闭共享画面（2026-09-24）⇒ 转告共享者释放那一路。
     * 为什么要这条：共享者面板上的「上行占用估算」按观看人数算，
     * 而观看者原来只是本地关掉、什么都不发 ⇒ 估算会一直把已经走掉的人算进去（直到 ICE 超时）。
     */
    private void handleScreenUnwatch(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        String sharer = msg.receiver;
        if (sharer == null || sharer.isEmpty()) return;
        java.util.LinkedHashSet<String> set = screenViewers.get(sharer);
        if (set != null) set.remove(msg.nickname);
        sendScreenViewers(sharer);
        UserSession us = room.getSession(sharer);
        if (us != null && us.isOnline()) {
            Message m = new Message();
            m.type = "screen_viewer_left";
            m.nickname = msg.nickname;
            try { us.send(m.toJson()); } catch (Exception ignored) {}
        }
    }

    private void handleScreenStatus(WebSocketSession session) {
        Message resp = new Message();
        resp.type = "screen_status_resp";
        if (screenShareParticipants.isEmpty()) {
            resp.content = "none";
            System.out.println("[SCREEN-STATUS] 无人共享");
        } else {
            resp.content = "active";
            resp.nickname = screenShareParticipants.iterator().next();
            resp.users = new ArrayList<>(screenShareParticipants);
            resp.count = screenShareParticipants.size();
            System.out.println("[SCREEN-STATUS] 共享中 — " + resp.nickname + " participants=" + screenShareParticipants);
        }
        send(session, resp);
    }

    private void handleTyping(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        room.broadcast(msg.toJson(), msg.nickname);
    }

    // ==================== Music Room ====================
    private void handleMusicRoomJoin(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        synchronized (musicRoom) {
            if (musicRoom.containsKey(msg.nickname)) {
                send(session, Message.system("你已在听歌房中"));
                return;
            }
            if (musicRoom.size() >= MUSIC_ROOM_MAX) {
                send(session, Message.system("听歌房已满"));
                return;
            }
            musicRoom.put(msg.nickname, "");
            if (musicRoom.size() == 1) {
                musicTurnIdx = 0;
                musicTurnStarted = System.currentTimeMillis();
            }
        }
        broadcastMusicRoomState();
        Message tip = Message.system(msg.nickname + " 加入了听歌房 (" + musicRoom.size() + "/" + MUSIC_ROOM_MAX + ")");
        for (var e : musicRoom.entrySet()) {
            UserSession us = room.getSession(e.getKey());
            if (us != null && us.isOnline()) us.send(tip.toJson());
        }
    }

    private void handleMusicRoomLeave(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        synchronized (musicRoom) {
            if (!musicRoom.containsKey(msg.nickname)) return;
            boolean wasDj = msg.nickname.equals(currentMusicDj());
            int idx = new ArrayList<>(musicRoom.keySet()).indexOf(msg.nickname);
            musicRoom.remove(msg.nickname);
            if (musicRoom.isEmpty()) {
                musicPlayingKey = "";
                musicStartAt = 0;
                musicDuration = 0;
                broadcastMusicRoomState();
                return;
            }
            if (wasDj && !musicPlayingKey.isEmpty()) {
                // 正在放歌的人退出了 → 换人并清掉同步状态（客户端会停下来等新 DJ）
                musicTurnIdx = Math.min(idx, musicRoom.size() - 1);
                advanceMusicTurn();
            } else {
                if (idx <= musicTurnIdx && musicTurnIdx > 0) musicTurnIdx--;
                if (musicTurnIdx >= musicRoom.size()) musicTurnIdx = 0;
                musicTurnStarted = System.currentTimeMillis();
            }
        }
        broadcastMusicRoomState();
        // 给离开者单独发送空状态以清除其客户端状态标签
        Message emptyState = new Message();
        emptyState.type = "music_room_state";
        emptyState.users = new ArrayList<>();
        emptyState.count = 0;
        emptyState.online = 0;
        send(session, emptyState);
    }

    private void handleMusicRoomPick(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        String spec = normalizeMusicSpec(msg.platform, msg.content);
        if (spec == null) {
            send(session, Message.system("曲目无效：网易云链接请用 song?id=数字；本地音频请先上传"));
            return;
        }
        synchronized (musicRoom) {
            if (!musicRoom.containsKey(msg.nickname)) return;
            if (musicRoom.size() < 1) {
                send(session, Message.system("听歌房为空"));
                return;
            }
            int idx = new ArrayList<>(musicRoom.keySet()).indexOf(msg.nickname);
            if (idx != musicTurnIdx) {
                return;
            }
            musicRoom.put(msg.nickname, spec);
            // 真同步：以**服务端**收到点歌的时刻为起点，所有客户端 seek 到 (now - startedAt) 的位置
            musicPlayingKey = spec + "@" + msg.nickname;
            musicStartAt = System.currentTimeMillis();
            musicDuration = 0;
            musicTurnStarted = System.currentTimeMillis();
        }
        broadcastMusicRoomState();
    }

    /** 点歌人 loadedmetadata 后上报真实时长（秒）→ 服务端据此精确排下一轮 */
    private void handleMusicRoomMeta(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        synchronized (musicRoom) {
            String dj = currentMusicDj();
            if (dj == null || !dj.equals(msg.nickname)) return;      // 只认当前点歌人
            if (musicPlayingKey.isEmpty()) return;
            int sec = (msg.duration == null) ? 0 : msg.duration;
            if (sec > 0 && sec < 4 * 3600) musicDuration = sec;
        }
        broadcastMusicRoomState();
    }

    /** 点歌人上报"放不出来"（版权限制/外链失效/文件损坏）→ 明确提示 + 自动跳过 */
    private void handleMusicRoomFail(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        String dj;
        synchronized (musicRoom) {
            dj = currentMusicDj();
            if (dj == null || !dj.equals(msg.nickname)) return;
            if (musicPlayingKey.isEmpty()) return;
        }
        String why = (msg.reason == null || msg.reason.isEmpty()) ? "可能受版权限制或外链失效" : msg.reason;
        Message tip = Message.system("⚠ " + dj + " 的曲目无法播放（" + why + "），已自动跳过");
        broadcastToMusicRoom(tip);
        synchronized (musicRoom) { advanceMusicTurn(); }
        broadcastMusicRoomState();
    }

    /** 把 "平台:spec" 规范化；不合法返回 null。spec 里绝不允许出现 '|' 或换行（state 用它们做分隔） */
    private String normalizeMusicSpec(String platform, String content) {
        if (content == null) return null;
        String p = (platform == null) ? "" : platform.trim().toLowerCase();
        String c = content.trim();
        if (c.isEmpty()) return null;
        // 老客户端只发 id（不带 platform）→ 按网易云处理
        if (p.isEmpty()) p = c.matches("\\d{1,20}") ? "netease" : "local";
        if ("netease".equals(p)) {
            String id = c.replaceAll("[^0-9]", "");
            if (id.isEmpty() || id.length() > 20) return null;
            return "netease:" + id;
        }
        if ("local".equals(p)) {
            String name = c.replaceAll("[^A-Za-z0-9._-]", "");
            if (!name.equals(c) || name.isEmpty() || name.length() > 120) return null;
            java.nio.file.Path f = com.chatroom2.controller.MusicController.MUSIC_DIR.resolve(name);
            if (!java.nio.file.Files.isRegularFile(f)) return null;
            return "local:" + name;
        }
        return null;
    }

    /** 当前轮到的点歌人（听歌房为空时返回 null） */
    private String currentMusicDj() {
        if (musicRoom.isEmpty()) return null;
        ArrayList<String> order = new ArrayList<>(musicRoom.keySet());
        if (musicTurnIdx < 0 || musicTurnIdx >= order.size()) return null;
        return order.get(musicTurnIdx);
    }

    /** 给听歌房内所有人发一条消息 */
    private void broadcastToMusicRoom(Message m) {
        String json = m.toJson();
        for (var e : musicRoom.entrySet()) {
            UserSession us = room.getSession(e.getKey());
            if (us != null && us.isOnline()) {
                try { us.send(json); } catch (Exception ignored) {}
            }
        }
    }

    private void handleMusicRoomSkip(WebSocketSession session, Message msg) {
        if (!isSessionOwner(session, msg.nickname)) return;
        synchronized (musicRoom) {
            if (!musicRoom.containsKey(msg.nickname)) return;
            int idx = new ArrayList<>(musicRoom.keySet()).indexOf(msg.nickname);
            if (idx != musicTurnIdx) {
                return;
            }
            advanceMusicTurn();
        }
        broadcastMusicRoomState();
    }

    private void advanceMusicTurn() {
        if (musicRoom.isEmpty()) return;
        // Clear current DJ's song before advancing
        String oldNick = new ArrayList<>(musicRoom.keySet()).get(musicTurnIdx);
        musicRoom.put(oldNick, "");
        musicTurnIdx = (musicTurnIdx + 1) % musicRoom.size();
        musicTurnStarted = System.currentTimeMillis();
        // 换人 = 换曲目：清掉"正在播放"的同步状态（客户端会停下来等新 DJ 选歌）
        musicPlayingKey = "";
        musicStartAt = 0;
        musicDuration = 0;
        // Clear new DJ's previous song
        String newNick = new ArrayList<>(musicRoom.keySet()).get(musicTurnIdx);
        musicRoom.put(newNick, "");
    }

    private void broadcastMusicRoomState() {
        Message state = new Message();
        state.type = "music_room_state";
        state.users = new ArrayList<>(musicRoom.keySet());
        // content：每人一条 "nick|平台|spec"，用换行分隔
        //   （旧格式 "nick:songId" 用逗号+冒号，spec 里一旦出现冒号/逗号就会串；换行分隔最稳）
        StringBuilder sb = new StringBuilder();
        for (var e : musicRoom.entrySet()) {
            if (sb.length() > 0) sb.append("\n");
            String v = e.getValue() == null ? "" : e.getValue();
            int c = v.indexOf(':');
            String p = c > 0 ? v.substring(0, c) : "";
            String s = c > 0 ? v.substring(c + 1) : v;
            sb.append(e.getKey()).append('|').append(p).append('|').append(s);
        }
        state.content = sb.toString();
        state.count = musicTurnIdx;
        state.online = (int)((musicTurnStarted + MUSIC_TURN_MS - System.currentTimeMillis()) / 1000); // remaining seconds
        // 真同步字段
        state.serverTime = System.currentTimeMillis();
        state.startedAt = musicStartAt;
        state.duration = musicDuration;
        state.trackKey = musicPlayingKey;
        String json = state.toJson();
        if (musicRoom.isEmpty()) {
            // 房间已空，广播空状态给所有人以清除客户端状态标签
            room.broadcastToAllOnline(json);
        } else {
            for (var e : musicRoom.entrySet()) {
                UserSession us = room.getSession(e.getKey());
                if (us != null && us.isOnline()) us.send(json);
            }
        }
    }

    // ==================== Heartbeat / Quit ====================
    private void handleHeartbeat(WebSocketSession session) {
        send(session, Message.of("heartbeat_ack"));
    }

    private void handleQuit(WebSocketSession session, Message msg) {
        if (msg.nickname != null && !isSessionOwner(session, msg.nickname)) return;
        String nickname = msg.nickname != null ? msg.nickname : findNickBySession(session);
        if (nickname != null) {
            // 通话房间退出（主动退出 → 立即移除，不享受宽限期）
            disconnectFromCallRooms(nickname);
            boolean wasSharing = screenShareParticipants.remove(nickname);
            room.leave(nickname);
            AuthTokenStore.getInstance().remove(nickname);
            if (wasSharing) {
                Message stopMsg = new Message();
                stopMsg.type = "screen_stop";
                stopMsg.nickname = nickname;
                room.broadcastToAllOnline(stopMsg.toJson());
            }

            Message sysMsg = Message.system(nickname + " 离开了聊天室");
            String json = sysMsg.toJson();
            addHistoryIfWorth(json);
            room.broadcastToAllOnline(json);
            broadcastUserList();
        }
    }

    // ==================== Helpers ====================

    /**
     * 只把"有价值"的消息写入历史：聊天/私聊/撤回等。
     * 丢弃 welcome（登录进入）与系统提示类（已重连/已连接/加入/离开/在线人数等），
     * 否则用户重新登录时会被历史里的登录提示刷屏（它们还会被持久化到 room.dat）。
     */
    private static final java.util.regex.Pattern TRANSIENT_SYS = java.util.regex.Pattern.compile(
            "已重连|已连接|登录成功|重连成功|进入了聊天室|离开了聊天室|加入|离开|在线人数|断开连接");

    private void addHistoryIfWorth(String json) {
        try {
            com.chatroom2.model.Message m = com.chatroom2.model.Message.fromJson(json);
            if (m == null) { addHistoryIfWorth(json); return; }
            if ("welcome".equals(m.type)) return;                       // 登录进入提示
            if ("system".equals(m.type) && m.content != null && TRANSIENT_SYS.matcher(m.content).find()) {
                return;                                                  // 重连/加入离开等瞬时提示
            }
            room.addHistory(json);
        } catch (Exception e) {
            room.addHistory(json);
        }
    }

    private void broadcastUserList() {
        Message msg = Message.userlist(room.getOnlineUserNames(), room.getDisconnectedUserNames(), room.getUserStatuses());
        msg.roles = buildRoles();
        String json = msg.toJson();
        room.broadcastToAllOnline(json);
    }

    private void handleUserStatus(WebSocketSession session, Message msg) {
        if (msg.nickname == null || !isSessionOwner(session, msg.nickname)) return;
        String status = msg.status;
        // 空字符串或null表示清除状态
        if (status != null && status.trim().isEmpty()) status = null;
        if (status != null && status.length() > 20) status = status.substring(0, 20);
        UserSession us = room.getSession(msg.nickname);
        if (us != null) {
            us.setStatus(status);
            // 广播状态变更给所有人
            Message resp = Message.userStatus(msg.nickname, status);
            room.broadcastToAllOnline(resp.toJson());
        }
    }

    private void send(WebSocketSession session, Message msg) {
        send(session, msg.toJson());
    }

    private void send(WebSocketSession session, String json) {
        try {
            synchronized (session) {
                if (session.isOpen()) {
                    session.sendMessage(new TextMessage(json));
                }
            }
        } catch (Exception ignored) {
            // IOException, IllegalStateException etc.
        }
    }

    private String sanitize(String name) {
        if (name == null || name.isEmpty()) return null;
        String n = Paths.get(name).getFileName().toString();
        if (n.isEmpty() || ".".equals(n) || "..".equals(n)) return null;
        for (int i = 0; i < n.length(); i++) {
            if (Character.isISOControl(n.charAt(i))) return null;
        }
        return n;
    }

    private void saveLogToFile() {
        try {
            Files.createDirectories(LOG_DIR);
            String ts = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss"));
            Path file = LOG_DIR.resolve("chatlog_" + ts + ".txt");
            try (BufferedWriter w = Files.newBufferedWriter(file, StandardCharsets.UTF_8)) {
                w.write("=== 聊天日志 关闭时间: " + LocalDateTime.now() + " ===\n\n");
                for (String h : room.getHistory()) {
                    w.write(h + "\n");
                }
            }
            System.out.println("日志已保存: " + file);
        } catch (IOException ignored) {}
    }
}
