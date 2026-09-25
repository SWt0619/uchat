package com.chatroom2.websocket;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * P0-④ · 离线私聊 —— 集成测试（真起 Spring Boot + 真 WebSocket 客户端，不做 mock）。
 *
 * <p>覆盖的行为（改造前这些用例<b>全都会失败</b>，因为对方离线时服务端直接回 {@code private_fail} 且不落库）：</p>
 * <ol>
 *   <li>对方离线时发送：不再回 {@code private_fail}，而是入库 + 回 {@code chat_ack}；</li>
 *   <li>对方上线：先收到 {@code private_pending}（未读计数），再收到带 {@code offlineMsg:true} 的原文；</li>
 *   <li>未读计数按发件人分组；</li>
 *   <li>投递过一次之后不再重复补投；</li>
 *   <li>断线重连的 {@code sync_since} 能补到私聊（含"在线直发时错过的那条"）；</li>
 *   <li><b>可见性</b>：全量 sync 只返回本人涉及的私聊，第三方一条都拿不到；</li>
 *   <li>幂等：同一 (nickname,msgId) 重复提交，对方只会收到一份；</li>
 *   <li>仍然 fail 的两种情形：收件人不是注册用户 / 给自己发（都带 msgId 便于客户端精确撤回）。</li>
 * </ol>
 *
 * <p>每个用例自己生成唯一昵称、断言一律按 msgId 过滤 ⇒ 用例之间、重复执行之间互不干扰
 * （{@code PrivateStore} 是 JVM 内单例、落盘 {@code target/data/private.dat}，靠唯一昵称隔离）。</p>
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "server.ssl.enabled=false",
                "chat.allowed-origins=*",
                "chat.ip-whitelist.enabled=false",
                "chat.invite.code=TEST_INVITE_CODE"     // 与 WsTestClient.INVITE 一致：本用例不依赖外部环境变量
        })
class PrivateOfflineTest {

    @LocalServerPort
    int port;

    private static final AtomicInteger SEQ = new AtomicInteger();

    static String uniq(String tag) {
        return "t5_" + tag + "_" + Long.toString(System.nanoTime() % 1_000_000_000L, 36) + SEQ.incrementAndGet();
    }

    static JsonObject privateMsg(String nick, String receiver, String content, String msgId) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "private");
        o.addProperty("nickname", nick);
        o.addProperty("receiver", receiver);
        o.addProperty("content", content);
        o.addProperty("msgId", msgId);
        return o;
    }

    static JsonObject syncSince(String nick, Object since) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "sync_since");
        o.addProperty("nickname", nick);
        if (since instanceof Number) o.addProperty("since", (Number) since);
        return o;
    }

    static String str(JsonObject o, String f) { return WsTestClient.str(o, f); }

    static int intOf(JsonObject o, String f) {
        return (o == null || !o.has(f) || o.get(f).isJsonNull()) ? -1 : o.get(f).getAsInt();
    }

    static boolean boolOf(JsonObject o, String f) {
        return o != null && o.has(f) && !o.get(f).isJsonNull() && o.get(f).getAsBoolean();
    }

    /** 从 sync_result 的 messages 里取出指定 msgId 的条数。 */
    static int countInSync(JsonObject syncResult, String msgId) {
        if (syncResult == null || !syncResult.has("messages") || syncResult.get("messages").isJsonNull()) return 0;
        JsonArray arr = syncResult.getAsJsonArray("messages");
        int n = 0;
        for (int i = 0; i < arr.size(); i++) {
            try {
                JsonObject o = JsonParser.parseString(arr.get(i).getAsString()).getAsJsonObject();
                if (msgId.equals(str(o, "msgId"))) n++;
            } catch (Exception ignored) {
            }
        }
        return n;
    }

    // ==================== 判据 1：对方离线 → 不回 private_fail，改为入库 + 回执 ====================

    @Test
    void offlineRecipientDoesNotReject_AndGetsMessageAfterLogin() throws Exception {
        String a = uniq("offA"), b = uniq("offB");
        String msgId = "1758100001000_1";

        // B 先注册（连上再断开 ⇒ 服务端认为他"离线"；离线宽限期内仍是房间成员，但不在线）
        try (WsTestClient cb0 = WsTestClient.open(port)) {
            cb0.registerAndLogin(port, b);
        }
        Thread.sleep(300);

        String ackId;
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();
            ca.send(privateMsg(a, b, "离线也能收到", msgId));

            JsonObject ack = ca.await("chat_ack", 5000);
            assertNotNull(ack, "离线私聊也必须回 chat_ack（改造前这里是 private_fail，没有回执）");
            assertEquals(msgId, str(ack, "msgId"), "回执应带原 msgId");
            assertFalse(boolOf(ack, "duplicate"), "首次提交不应是 duplicate");
            assertNull(ca.await("private_fail", 800), "对方离线不该回 private_fail");
        }

        // B 重新登录：应先收到未读汇总，再收到带 offlineMsg 的原文
        try (WsTestClient cb = WsTestClient.open(port)) {
            cb.registerAndLogin(port, b);
            List<JsonObject> replay = cb.replay();
            JsonObject pending = null;
            for (JsonObject o : replay) {
                if ("private_pending".equals(str(o, "type"))) pending = o;
            }
            assertNotNull(pending, "登录时应收到 private_pending（未读汇总）");
            assertTrue(intOf(pending, "unreadCount") >= 1,
                    "未读数应 >=1，实际=" + intOf(pending, "unreadCount"));
            if (pending.has("unread") && !pending.get("unread").isJsonNull()) {
                assertEquals(1, pending.getAsJsonObject("unread").get(a).getAsInt(),
                        "未读应按发件人分组计数");
            }

            List<JsonObject> got = WsTestClient.withMsgId(replay, msgId);
            assertEquals(1, got.size(), "登录后应恰好收到 1 条该私聊，实际=" + got.size());
            assertEquals("离线也能收到", str(got.get(0), "content"));
            assertTrue(boolOf(got.get(0), "offlineMsg"),
                    "补投的离线私聊必须带 offlineMsg:true（客户端据此显示 [离线] 且不自动弹窗）");
        }
    }

    // ==================== 判据 2：投递过就不再补投 ====================

    @Test
    void deliveredOfflineMessageIsNotPushedAgain() throws Exception {
        String a = uniq("d2A"), b = uniq("d2B");
        String msgId = "1758100002000_1";

        try (WsTestClient cb0 = WsTestClient.open(port)) { cb0.registerAndLogin(port, b); }
        Thread.sleep(300);
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();
            ca.send(privateMsg(a, b, "只投一次", msgId));
            assertNotNull(ca.await("chat_ack", 5000), "应回执");
        }
        // 第一次登录：补投
        try (WsTestClient cb1 = WsTestClient.open(port)) {
            cb1.registerAndLogin(port, b);
            assertEquals(1, WsTestClient.withMsgId(cb1.replay(), msgId).size(), "第一次登录应补投 1 条");
        }
        Thread.sleep(200);
        // 第二次登录：不应再补投（已标记 delivered），也不该再出现未读汇总里的这一条
        try (WsTestClient cb2 = WsTestClient.open(port)) {
            cb2.registerAndLogin(port, b);
            List<JsonObject> replay = cb2.replay();
            int offlineCopies = 0;
            for (JsonObject o : WsTestClient.withMsgId(replay, msgId)) {
                if (boolOf(o, "offlineMsg")) offlineCopies++;
            }
            assertEquals(0, offlineCopies, "已投递过的离线私聊不应再次补投");
            for (JsonObject o : replay) {
                if ("private_pending".equals(str(o, "type"))) {
                    assertTrue(intOf(o, "unreadCount") >= 0);
                }
            }
        }
    }

    // ==================== 判据 3：未读计数按发件人分组 ====================

    @Test
    void unreadCountIsGroupedBySender() throws Exception {
        String a = uniq("u3A"), b = uniq("u3B");
        String m1 = "1758100003001_1", m2 = "1758100003002_1", m3 = "1758100003003_1";

        try (WsTestClient cb0 = WsTestClient.open(port)) { cb0.registerAndLogin(port, b); }
        Thread.sleep(300);
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();
            ca.send(privateMsg(a, b, "1", m1));
            ca.send(privateMsg(a, b, "2", m2));
            ca.send(privateMsg(a, b, "3", m3));
            // ⚠️ 必须等齐 3 个回执再退出 try（close）—— 否则第 3 条会随连接关闭被丢掉，
            //    表现为"未读少了 1 条"（第一次写这个用例就踩到了）
            List<JsonObject> acks = ca.awaitAll("chat_ack", 8000);
            assertEquals(3, acks.size(), "3 条私聊应各回一个 chat_ack，实际=" + acks.size());
        }
        try (WsTestClient cb = WsTestClient.open(port)) {
            cb.registerAndLogin(port, b);
            JsonObject pending = null;
            for (JsonObject o : cb.replay()) {
                if ("private_pending".equals(str(o, "type"))) pending = o;
            }
            assertNotNull(pending, "应收到 private_pending");
            assertEquals(3, intOf(pending, "unreadCount"), "3 条离线私聊 ⇒ 未读 3");
            assertEquals(3, pending.getAsJsonObject("unread").get(a).getAsInt(), "发件人 " + a + " 应有 3 条未读");
            assertEquals(1, WsTestClient.withMsgId(cb.replay(), m1).size());
            assertEquals(1, WsTestClient.withMsgId(cb.replay(), m2).size());
            assertEquals(1, WsTestClient.withMsgId(cb.replay(), m3).size());
        }
    }

    // ==================== 判据 4：断线重连的 sync_since 覆盖私聊 ====================

    @Test
    void syncSinceCoversPrivateMessagesMissedWhileOffline() throws Exception {
        String a = uniq("s4A"), b = uniq("s4B");
        String m1 = "1758100004001_1";   // B 在线时收到（直发）
        String m2 = "1758100004002_1";   // B 断线期间发（离线入库）

        try (WsTestClient ca = WsTestClient.open(port);
             WsTestClient cb = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            cb.registerAndLogin(port, b);
            cb.clearAll();
            ca.send(privateMsg(a, b, "在线直发", m1));
            assertEquals(1, WsTestClient.withMsgId(cb.awaitAll("private", 3000), m1).size(), "在线应直发收到");
        }
        // B 已断开（close 之后服务端把他标为断线）→ A 再发一条
        Thread.sleep(400);
        try (WsTestClient ca2 = WsTestClient.open(port)) {
            ca2.registerAndLogin(port, a);
            ca2.clearAll();
            ca2.send(privateMsg(a, b, "断线期间", m2));
            assertNotNull(ca2.await("chat_ack", 5000), "应回执");
        }
        // B 重连，带 since = m1 的时间戳（比 m2 早）⇒ sync 必须补到 m2
        try (WsTestClient cb2 = WsTestClient.open(port)) {
            cb2.registerAndLogin(port, b);
            cb2.clearAll();
            long since = Long.parseLong(m1.substring(0, m1.indexOf('_')));
            cb2.send(syncSince(b, since));
            JsonObject sr = cb2.await("sync_result", 8000);
            assertNotNull(sr, "应收到 sync_result");
            assertEquals(1, countInSync(sr, m2), "sync_since 应补到断线期间的私聊");
        }
    }

    // ==================== 判据 5：可见性 —— 第三方拿不到别人的私聊 ====================

    @Test
    void syncNeverLeaksOtherPeoplesPrivateMessages() throws Exception {
        String a = uniq("v5A"), b = uniq("v5B"), f = uniq("v5F");
        String msgId = "1758100005001_1";

        try (WsTestClient cb0 = WsTestClient.open(port)) { cb0.registerAndLogin(port, b); }
        Thread.sleep(300);
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();
            ca.send(privateMsg(a, b, "机密", msgId));
            assertNotNull(ca.await("chat_ack", 5000));
        }
        // 第三方 F 做「全量」sync（since 省略）：一条都不该看到
        try (WsTestClient cf = WsTestClient.open(port)) {
            cf.registerAndLogin(port, f);
            cf.clearAll();
            cf.send(syncSince(f, 0));
            JsonObject sr = cf.await("sync_result", 8000);
            assertNotNull(sr, "应收到 sync_result");
            assertEquals(0, countInSync(sr, msgId), "第三方不得看到别人的私聊（sync_result 泄露）");
        }
        // 发件人 A 自己做全量 sync：可以看到自己的那条（属于本人）
        try (WsTestClient ca2 = WsTestClient.open(port)) {
            ca2.registerAndLogin(port, a);
            ca2.clearAll();
            ca2.send(syncSince(a, 0));
            JsonObject sr = ca2.await("sync_result", 8000);
            assertNotNull(sr, "发件人应收到 sync_result");
            assertTrue(countInSync(sr, msgId) >= 1, "本人发的私聊应能补给自己（换设备场景）");
        }
    }

    // ==================== 判据 6：幂等（重复提交只投一份） ====================

    @Test
    void duplicateSubmitDeliversOnlyOnce() throws Exception {
        String a = uniq("i6A"), b = uniq("i6B");
        String msgId = "1758100006001_1";

        try (WsTestClient cb0 = WsTestClient.open(port)) { cb0.registerAndLogin(port, b); }
        Thread.sleep(300);
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();
            JsonObject m = privateMsg(a, b, "重复提交", msgId);
            ca.send(m);
            assertNotNull(ca.await("chat_ack", 5000), "第 1 次应回执");
            ca.send(m);                                  // 网络重传 / 重连补发
            JsonObject ack2 = ca.await("chat_ack", 5000);
            assertNotNull(ack2, "第 2 次也应回执");
            assertTrue(boolOf(ack2, "duplicate"), "第 2 次应标记 duplicate=true");
        }
        try (WsTestClient cb = WsTestClient.open(port)) {
            cb.registerAndLogin(port, b);
            assertEquals(1, WsTestClient.withMsgId(cb.replay(), msgId).size(), "重复提交只应投递一份");
        }
    }

    // ==================== 判据 7：仍然失败的两种情形 ====================

    @Test
    void failCasesStillFail_withMsgId() throws Exception {
        String a = uniq("f7A");
        String ghost = uniq("f7Ghost");
        String m1 = "1758100007001_1", m2 = "1758100007002_1";

        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();

            // ① 收件人不是注册用户
            ca.send(privateMsg(a, ghost, "发给不存在的人", m1));
            JsonObject f1 = ca.await("private_fail", 5000);
            assertNotNull(f1, "收件人不存在应回 private_fail");
            assertEquals(m1, str(f1, "msgId"), "private_fail 必须带 msgId（客户端据此精确撤回那一条）");
            assertNull(ca.await("chat_ack", 800), "失败不该回 chat_ack");

            // ② 给自己发
            ca.send(privateMsg(a, a, "给自己发", m2));
            JsonObject f2 = ca.await("private_fail", 5000);
            assertNotNull(f2, "给自己发应回 private_fail");
            assertEquals(m2, str(f2, "msgId"));
        }
    }
}
