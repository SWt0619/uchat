package com.chatroom2.model;

import com.google.gson.Gson;
import java.util.List;

public class Message {
    private static final Gson GSON = new Gson();

    public String type;
    public String subtype;
    public String reason;
    public String nickname;
    public String content;
    public String msgId;
    public String receiver;
    public String quote;
    public String quoteNick;
    public List<String> users;
    public List<String> offline;
    public java.util.Map<String, String> statuses;
    /** 用户角色：nickname -> "admin" / "bot"（未列入者为普通用户） */
    public java.util.Map<String, String> roles;
    public String status;
    public Integer online;
    public Integer count;
    public String filename;
    public Long size;
    public Integer chunk;
    public Integer total;
    public String filetype;
    public String frameType;
    public String prompt;
    public String quality; // screen share quality: 480p/720p/1080p
    public String platform; // music_share: netease / qq
    public String token;   // auth token for HTTP file access
    public String invite;  // registration invite code
    public Boolean audioOn; // media_state: 麦克风是否开启
    public Boolean videoOn; // media_state: 摄像头是否开启 / call: 是否漫游中

    // ==================== T3: 消息可靠性（回执 / 断线补齐） ====================

    /** chat_ack / 入库消息：服务端处理时刻（毫秒）。入库的 chat/private 也带上，便于客户端做时间轴排序与补齐游标。 */
    public Long serverTime;
    // ===== 听歌房真同步（2026-09-24 v2.9.0）=====
    /** 当前曲目在**服务端**的开始时间（epoch ms）。客户端据此把播放位置对齐到 (now-serverTime) 的偏移 */
    public Long startedAt;
    /** 当前曲目的唯一键（平台:spec@点歌人）。变=换歌，客户端凭它判断"要不要重新加载" */
    public String trackKey;
    /** 当前曲目时长（秒；0=未知，由点歌人 loadedmetadata 后上报） */
    public Integer duration;
    // ===== 通话房间容量（2026-09-24 v2.9.0）=====
    /** 各房间容量：voice1/voice2/video1/video2 —— 由服务端下发，客户端只负责显示 */
    public java.util.Map<String, Integer> caps;
    /** chat_ack：true = 这条 (nickname,msgId) 服务端此前已经处理过（重发命中幂等去重），本次未再入库/广播。 */
    public Boolean duplicate;
    /**
     * sync_since：客户端已有的最新时间戳（毫秒）。省略 / 0 表示要全量。
     *
     * <p>刻意声明为 {@code Object} 而不是 {@code Long}：Gson 把 JSON 数字读成 Double、字符串读成 String、
     * 数组/对象读成 List/Map，这样"非法 since"（字符串 / 数组 / 对象 / 超出 long 范围的超大数）
     * 在反序列化阶段就不会抛异常，交给 {@code ChatWebSocketHandler.parseSince} 统一按"全量 + 记日志"处理。</p>
     */
    public Object since;
    /** sync_result：命中的历史消息，元素是原始消息 JSON 字符串（与广播时逐字一致）。 */
    public List<String> messages;
    /** sync_result：true = 客户端要的区间起点早于缓冲区起点（或缓冲区里没有可判定时间的消息）⇒ 缺口可能补不齐。 */
    public Boolean truncated;
    /** sync_result：缓冲区里最早一条的时间戳（毫秒）；无法判定时为 null。 */
    public Long oldest;
    /** sync_result：缓冲区里最新一条的时间戳（毫秒）；无法判定时为 null。 */
    public Long newest;

    // ==================== P0-④ 离线私聊 ====================

    /**
     * private：true = 这条私聊是服务端在收件人登录 / 断线补齐时**补投**的（发送时收件人不在线）。
     * 客户端据此显示「离线」标记，并且不自动弹窗（避免一登录被历史消息刷屏）。
     *
     * <p>⚠️ 字段名不能叫 {@code offline} —— 那个名字已被 {@code userlist} 的离线用户列表占用
     * （{@code public List<String> offline}），两者类型不同、语义无关。</p>
     */
    public Boolean offlineMsg;
    /** private_pending：尚未投递给本人的私聊总条数（= 未读数）。 */
    public Integer unreadCount;
    /** private_pending：未读数按发件人分组（昵称 -> 条数），客户端用于在联系人上显示角标。 */
    public java.util.Map<String, Integer> unread;
    /** private_pending：因容量上限被丢弃、补不齐的条数（> 0 时客户端如实提示）。 */
    public Integer dropped;

    /** 登录时的未读私聊汇总（在逐条补投之前下发）。 */
    public static Message privatePending(int count, java.util.Map<String, Integer> unread, int dropped) {
        Message m = new Message();
        m.type = "private_pending";
        m.unreadCount = count;
        m.unread = unread;
        m.dropped = dropped;
        return m;
    }

    public Message() {}

    /**
     * 服务端回执：告诉发送方这条消息已被处理（无论是否重复）。
     *
     * @param duplicate true 表示服务端此前已处理过同一 (nickname,msgId)，本次没有再次入库/广播
     */
    public static Message chatAck(String msgId, long serverTime, boolean duplicate) {
        Message m = new Message();
        m.type = "chat_ack";
        m.msgId = msgId;
        m.serverTime = serverTime;
        m.duplicate = duplicate;
        return m;
    }

    /** 断线补齐结果：messages = 命中的原始消息 JSON 列表。 */
    public static Message syncResult(List<String> messages, boolean truncated, Long oldest, Long newest) {
        Message m = new Message();
        m.type = "sync_result";
        m.messages = messages;
        m.count = messages == null ? 0 : messages.size();
        m.truncated = truncated;
        m.oldest = oldest;
        m.newest = newest;
        return m;
    }

    public static Message prompt(String text) {
        Message m = new Message();
        m.type = "prompt";
        m.prompt = text;
        return m;
    }

    public static Message auth(String subtype, String nickname) {
        Message m = new Message();
        m.type = "auth";
        m.subtype = subtype;
        m.nickname = nickname;
        return m;
    }

    public static Message auth(String subtype, String nickname, String password) {
        Message m = new Message();
        m.type = "auth";
        m.subtype = subtype;
        m.nickname = nickname;
        m.content = password;
        return m;
    }

    public static Message authResp(String subtype, String reason) {
        Message m = new Message();
        m.type = "auth_resp";
        m.subtype = subtype;
        m.reason = reason;
        return m;
    }

    public static Message chat(String nickname, String content) {
        Message m = new Message();
        m.type = "chat";
        m.nickname = nickname;
        m.content = content;
        m.msgId = genMsgId();
        return m;
    }

    public static Message chat(String nickname, String content, String quote, String quoteNick) {
        Message m = chat(nickname, content);
        m.quote = quote;
        m.quoteNick = quoteNick;
        return m;
    }

    public static Message privateMsg(String nickname, String receiver, String content) {
        Message m = new Message();
        m.type = "private";
        m.nickname = nickname;
        m.receiver = receiver;
        m.content = content;
        m.msgId = genMsgId();
        return m;
    }

    public static Message privateMsg(String nickname, String receiver, String content, String quote, String quoteNick) {
        Message m = privateMsg(nickname, receiver, content);
        m.quote = quote;
        m.quoteNick = quoteNick;
        return m;
    }

    public static Message recall(String msgId, String nickname) {
        Message m = new Message();
        m.type = "recall";
        m.msgId = msgId;
        m.nickname = nickname;
        return m;
    }

    public static Message system(String content) {
        Message m = new Message();
        m.type = "system";
        m.content = content;
        return m;
    }

    public static Message welcome(String nickname, int online) {
        Message m = new Message();
        m.type = "welcome";
        m.nickname = nickname;
        m.online = online;
        return m;
    }

    public static Message userlist(List<String> users) {
        Message m = new Message();
        m.type = "userlist";
        m.users = users;
        return m;
    }

    public static Message userlist(List<String> users, List<String> offline, java.util.Map<String, String> statuses) {
        Message m = new Message();
        m.type = "userlist";
        m.users = users;
        m.offline = offline;
        m.statuses = statuses;
        return m;
    }

    public static Message userStatus(String nickname, String status) {
        Message m = new Message();
        m.type = "user_status";
        m.nickname = nickname;
        m.status = status;
        return m;
    }

    public static Message recallFail(String reason) {
        Message m = new Message();
        m.type = "recall_fail";
        m.content = reason;
        return m;
    }

    public static Message callStatus(int count) {
        Message m = new Message();
        m.type = "call_status";
        m.count = count;
        return m;
    }

    public static Message of(String type) {
        Message m = new Message();
        m.type = type;
        return m;
    }

    /** 麦克风/摄像头开关状态，转发给同通话房间成员，用于在对端画面上显示角标 */
    public static Message mediaState(String nickname, boolean audioOn, boolean videoOn) {
        Message m = new Message();
        m.type = "media_state";
        m.nickname = nickname;
        m.audioOn = audioOn;
        m.videoOn = videoOn;
        return m;
    }

    /** 通话中掉线（宽限期内），提示同房间成员"重连中"而不是直接拆掉连接 */
    public static Message peerUnstable(String nickname, String subtype) {
        Message m = new Message();
        m.type = "room_peer_unstable";
        m.nickname = nickname;
        m.subtype = subtype;
        m.videoOn = false;
        return m;
    }

    /** 宽限期内重连成功，通知同房间成员恢复 */
    public static Message peerResume(String nickname, String subtype) {
        Message m = new Message();
        m.type = "room_peer_resume";
        m.nickname = nickname;
        m.subtype = subtype;
        m.videoOn = true;
        return m;
    }

    // video call signaling
    public static Message videoOffer(String nickname, String sdp) {
        Message m = new Message();
        m.type = "video_offer";
        m.nickname = nickname;
        m.content = sdp;
        return m;
    }

    public static Message videoAnswer(String nickname, String sdp) {
        Message m = new Message();
        m.type = "video_answer";
        m.nickname = nickname;
        m.content = sdp;
        return m;
    }

    public static Message videoIce(String nickname, String candidate) {
        Message m = new Message();
        m.type = "video_ice";
        m.nickname = nickname;
        m.content = candidate;
        return m;
    }

    // screen share signaling
    public static Message screenOffer(String nickname, String sdp, String quality) {
        Message m = new Message();
        m.type = "screen_offer";
        m.nickname = nickname;
        m.content = sdp;
        m.quality = quality;
        return m;
    }

    public static Message screenAnswer(String nickname, String sdp) {
        Message m = new Message();
        m.type = "screen_answer";
        m.nickname = nickname;
        m.content = sdp;
        return m;
    }

    public static Message screenIce(String nickname, String candidate) {
        Message m = new Message();
        m.type = "screen_ice";
        m.nickname = nickname;
        m.content = candidate;
        return m;
    }

    public static Message fromJson(String json) {
        return GSON.fromJson(json, Message.class);
    }

    public String toJson() {
        return GSON.toJson(this);
    }

    private static int msgCounter = 0;

    private static synchronized String genMsgId() {
        return System.currentTimeMillis() + "_" + (msgCounter++);
    }
}
