package com.chatroom2.websocket;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T3 · 服务端消息可靠性 —— 集成测试（真起 Spring Boot + 真 WebSocket 客户端，不做 mock）。
 *
 * <p>判据全部走协议层（发 JSON / 收 JSON），不触碰服务端内部字段：
 * <ul>
 *   <li>「只广播一次」= 另一个在线客户端实际收到的 chat 条数</li>
 *   <li>「只入库一次」= 新客户端登录时 history 回放里该 msgId 的条数，以及 sync_result 里的条数</li>
 * </ul>
 *
 * <p>每个用例自己生成唯一昵称，且所有断言都按 msgId 过滤 —— 因此用例之间、重复执行之间互不干扰。</p>
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
          "chat.invite.code=" + WsTestClient.INVITE,   // 与本类用的注册码常量一致（注册码已不再硬编码在配置里）
                "server.ssl.enabled=false",     // 测试用明文 ws，避免依赖 keystore.p12
                "chat.allowed-origins=*",       // 测试客户端不带 Origin，放开握手来源校验
                "chat.ip-whitelist.enabled=false"
        })
class ChatReliabilityTest {

    @LocalServerPort
    int port;

    private static final AtomicInteger SEQ = new AtomicInteger();

    /** 每个用例一个唯一昵称：避免 users.dat 与房间历史在重复跑测试时互相污染。 */
    static String uniq(String tag) {
        return "t3_" + tag + "_" + Long.toString(System.nanoTime() % 1_000_000_000L, 36) + SEQ.incrementAndGet();
    }

    static JsonObject chat(String nick, String content, String msgId) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "chat");
        o.addProperty("nickname", nick);
        o.addProperty("content", content);
        o.addProperty("msgId", msgId);
        return o;
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
        if (since != null) {
            if (since instanceof Number) o.addProperty("since", (Number) since);
            else o.addProperty("since", String.valueOf(since));
        }
        return o;
    }

    /** 统计 sync_result 的 messages 里该 msgId 出现几次。 */
    static int countInSync(JsonObject syncResult, String msgId) {
        if (syncResult == null || !syncResult.has("messages") || syncResult.get("messages").isJsonNull()) return 0;
        JsonArray arr = syncResult.getAsJsonArray("messages");
        int n = 0;
        for (JsonElement e : arr) {
            try {
                JsonObject o = JsonParser.parseString(e.getAsString()).getAsJsonObject();
                if (msgId.equals(WsTestClient.str(o, "msgId"))) n++;
            } catch (Exception ignored) {
            }
        }
        return n;
    }

    static boolean syncContains(JsonObject syncResult, String msgId) {
        return countInSync(syncResult, msgId) > 0;
    }

    static int intOf(JsonObject o, String field) {
        return (o == null || !o.has(field) || o.get(field).isJsonNull()) ? -1 : o.get(field).getAsInt();
    }

    static boolean boolOf(JsonObject o, String field) {
        return o != null && o.has(field) && !o.get(field).isJsonNull() && o.get(field).getAsBoolean();
    }

    // ==================== 基线：管线本身是活的 ====================

    @Test
    void harnessSanity_differentMsgIdsAreEachStoredOnce() throws Exception {
        String a = uniq("saneA"), b = uniq("saneB"), c = uniq("saneC");
        String m1 = "1758000001000_1", m2 = "1758000001000_2";
        try (WsTestClient ca = WsTestClient.open(port);
             WsTestClient cb = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            cb.registerAndLogin(port, b);
            cb.clearAll();

            ca.send(chat(a, "sanity-1", m1));
            ca.send(chat(a, "sanity-2", m2));

            List<JsonObject> got = cb.awaitAll("chat", 3000);
            assertEquals(1, WsTestClient.withMsgId(got, m1).size(), "不同 msgId 应各广播一次: " + m1);
            assertEquals(1, WsTestClient.withMsgId(got, m2).size(), "不同 msgId 应各广播一次: " + m2);

            try (WsTestClient cc = WsTestClient.open(port)) {
                cc.registerAndLogin(port, c);
                // history 里也应各一条
                assertEquals(1, WsTestClient.withMsgId(cc.replay(), m1).size(), "history 应有 " + m1 + " 一条");
                assertEquals(1, WsTestClient.withMsgId(cc.replay(), m2).size(), "history 应有 " + m2 + " 一条");
            }
        }
    }

    // ==================== 判据 1：同一 msgId 提交两次 ====================

    @Test
    void duplicateSubmitMustNotBeRebroadcastOrStoredTwice() throws Exception {
        String a = uniq("dupA"), b = uniq("dupB"), c = uniq("dupC");
        String msgId = "1758000002000_1";
        try (WsTestClient ca = WsTestClient.open(port);
             WsTestClient cb = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            cb.registerAndLogin(port, b);
            cb.clearAll();

            JsonObject msg = chat(a, "重复提交", msgId);
            ca.send(msg);
            assertEquals(1, WsTestClient.withMsgId(cb.awaitAll("chat", 2500), msgId).size(), "首次提交应广播一次");

            // 同一 (nickname, msgId) 再提交一次 —— 网络重传/重连补发的模拟
            ca.send(msg);

            List<JsonObject> after = cb.awaitAll("chat", 2500);
            assertEquals(0, WsTestClient.withMsgId(after, msgId).size(),
                    "重复提交不得再广播（对方收到的额外 chat 条数）");

            try (WsTestClient cc = WsTestClient.open(port)) {
                cc.registerAndLogin(port, c);
                assertEquals(1, WsTestClient.withMsgId(cc.replay(), msgId).size(),
                        "重复提交不得重复入库（history 回放里该 msgId 的条数）");
            }
        }
    }

    /** 第二次提交必须回 duplicate=true（客户端据此把本地队列里那条标成成功）。 */
    @Test
    void duplicateSubmitGetsAckWithDuplicateFlag() throws Exception {
        String a = uniq("ackA");
        String msgId = "1758000003000_1";
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();

            JsonObject msg = chat(a, "ack 测试", msgId);
            ca.send(msg);
            JsonObject first = ca.await("chat_ack", 4000);
            assertNotNull(first, "首次提交必须收到 chat_ack");
            assertEquals(msgId, WsTestClient.str(first, "msgId"), "chat_ack.msgId 应原样回带");
            assertFalse(boolOf(first, "duplicate"), "首次提交 duplicate 应为 false");
            assertTrue(first.has("serverTime") && first.get("serverTime").getAsLong() > 0,
                    "chat_ack.serverTime 应为正的时间戳");

            ca.send(msg);
            JsonObject second = ca.await("chat_ack", 4000);
            assertNotNull(second, "重复提交也必须收到 chat_ack（客户端才知道可以出队）");
            assertEquals(msgId, WsTestClient.str(second, "msgId"));
            assertTrue(boolOf(second, "duplicate"), "重复提交 duplicate 应为 true");
        }
    }

    /** 重复提交不得让 sync_result（全量）里出现两条。 */
    @Test
    void duplicateSubmitDoesNotGrowSyncResult() throws Exception {
        String a = uniq("syncDup");
        String msgId = "1758000004000_1";
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();

            JsonObject msg = chat(a, "sync 去重", msgId);
            ca.send(msg);
            assertNotNull(ca.await("chat_ack", 4000), "首次提交应回执");
            ca.send(msg);
            assertNotNull(ca.await("chat_ack", 4000), "重复提交应回执");

            ca.send(syncSince(a, null));
            JsonObject sr = ca.await("sync_result", 4000);
            assertNotNull(sr, "sync_since 应有 sync_result 响应");
            assertEquals(1, countInSync(sr, msgId), "全量 sync_result 里该 msgId 只应有 1 条");
        }
    }

    /** 私聊同样幂等（同一 msgId 重复提交，接收方只收到一条）。 */
    @Test
    void privateDuplicateIsIdempotent() throws Exception {
        String a = uniq("pA"), b = uniq("pB");
        String msgId = "1758000005000_1";
        try (WsTestClient ca = WsTestClient.open(port);
             WsTestClient cb = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            cb.registerAndLogin(port, b);
            cb.clearAll();

            JsonObject msg = privateMsg(a, b, "私聊去重", msgId);
            ca.send(msg);
            assertEquals(1, WsTestClient.withMsgId(cb.awaitAll("private", 2500), msgId).size(), "首次私聊应到达一次");
            JsonObject firstAck = ca.await("chat_ack", 4000);
            assertNotNull(firstAck, "首次私聊应回执");
            assertFalse(boolOf(firstAck, "duplicate"), "首次私聊 duplicate 应为 false");

            ca.send(msg);
            JsonObject ack = ca.await("chat_ack", 4000);
            assertNotNull(ack, "重复私聊也应回执");
            assertTrue(boolOf(ack, "duplicate"), "重复私聊 duplicate=true");
            assertEquals(0, WsTestClient.withMsgId(cb.awaitAll("private", 2500), msgId).size(),
                    "重复私聊不得再次投递");
        }
    }

    // ==================== 判据 2：sync_since 四种边界 ====================

    @Test
    void syncSinceOmittedReturnsWholeBuffer() throws Exception {
        String a = uniq("sy1");
        long base = System.currentTimeMillis();
        String m1 = base + "_1";
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();
            ca.send(chat(a, "sync 全量", m1));
            assertNotNull(ca.await("chat_ack", 4000));

            ca.send(syncSince(a, null));                 // since 省略
            JsonObject sr = ca.await("sync_result", 4000);
            assertNotNull(sr, "省略 since 应返回 sync_result");
            assertTrue(syncContains(sr, m1), "全量应包含刚发的消息 " + m1);
            assertEquals(intOf(sr, "count"), sr.getAsJsonArray("messages").size(), "count 应等于 messages.size()");
            assertFalse(boolOf(sr, "truncated"), "全量不应标记截断");
        }
    }

    @Test
    void syncSinceZeroReturnsWholeBuffer() throws Exception {
        String a = uniq("sy0");
        long base = System.currentTimeMillis();
        String m1 = base + "_1";
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();
            ca.send(chat(a, "sync 0", m1));
            assertNotNull(ca.await("chat_ack", 4000));

            ca.send(syncSince(a, 0));                    // since = 0
            JsonObject sr = ca.await("sync_result", 4000);
            assertNotNull(sr, "since=0 应返回 sync_result");
            assertTrue(syncContains(sr, m1), "since=0 应包含刚发的消息 " + m1);
            assertFalse(boolOf(sr, "truncated"), "since=0（全量）不应标记截断");
        }
    }

    @Test
    void syncSinceEarlierThanOldestIsTruncated() throws Exception {
        String a = uniq("sy2");
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();

            ca.send(syncSince(a, 1L));                   // since 早于缓冲区最早一条
            JsonObject sr = ca.await("sync_result", 4000);
            assertNotNull(sr, "since 早于缓冲区起点应返回 sync_result");
            assertTrue(boolOf(sr, "truncated"), "since 早于缓冲区最早消息必须标记 truncated=true");
            assertTrue(intOf(sr, "count") > 0, "仍应返回缓冲区全部消息（count>0）");
            assertTrue(sr.has("oldest") && !sr.get("oldest").isJsonNull(), "应给出缓冲区最早时间戳用于诊断");
            assertTrue(sr.get("oldest").getAsLong() > 0, "oldest 应为正的时间戳");
        }
    }

    @Test
    void syncSinceLaterThanNewestReturnsEmpty() throws Exception {
        String a = uniq("sy3");
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();

            ca.send(syncSince(a, System.currentTimeMillis() + 3_600_000L));  // since 晚于最新
            JsonObject sr = ca.await("sync_result", 4000);
            assertNotNull(sr, "since 晚于最新应返回 sync_result（而不是不响应）");
            assertEquals(0, intOf(sr, "count"), "count 应为 0");
            assertTrue(sr.getAsJsonArray("messages").isEmpty(), "messages 应为空数组");
            assertFalse(boolOf(sr, "truncated"), "没漏消息，不应标记截断");
        }
    }

    /** 严格大于语义：since 正好等于某条的时间戳时，该条不再返回，之后的仍返回。 */
    @Test
    void syncSinceBoundaryIsExclusive() throws Exception {
        String a = uniq("sy4");
        long base = System.currentTimeMillis();
        String m1 = base + "_1", m2 = (base + 1) + "_1";
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();
            ca.send(chat(a, "边界-1", m1));
            assertNotNull(ca.await("chat_ack", 4000));
            ca.send(chat(a, "边界-2", m2));
            assertNotNull(ca.await("chat_ack", 4000));

            ca.send(syncSince(a, base));                 // 正好等于 m1 的时间戳
            JsonObject sr = ca.await("sync_result", 4000);
            assertNotNull(sr);
            assertFalse(syncContains(sr, m1), "since 等于该条时间戳时不应再返回它（严格大于）");
            assertTrue(syncContains(sr, m2), "比 since 新的那条必须返回");
        }
    }

    @Test
    void syncSinceIllegalDoesNotThrow() throws Exception {
        String a = uniq("sy5");
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();

            // ① 非数字字符串
            ca.send(syncSince(a, "not-a-number"));
            JsonObject r1 = ca.await("sync_result", 4000);
            assertNotNull(r1, "非法 since（非数字）必须仍返回 sync_result，不能抛异常/静默");
            assertTrue(intOf(r1, "count") > 0, "非法 since 按全量处理，count>0");

            // ② 负数
            ca.send(syncSince(a, -5L));
            JsonObject r2 = ca.await("sync_result", 4000);
            assertNotNull(r2, "非法 since（负数）必须仍返回 sync_result");
            assertTrue(intOf(r2, "count") > 0, "负数 since 按全量处理，count>0");

            // ③ 超大数（超出 long 范围）
            ca.send(syncSince(a, 1.0E30));
            JsonObject r3 = ca.await("sync_result", 4000);
            assertNotNull(r3, "非法 since（超大）必须仍返回 sync_result");

            // 连接仍然可用（没有因为非法输入崩掉会话）
            ca.send("{\"type\":\"heartbeat\"}");
            assertNotNull(ca.await("heartbeat_ack", 4000), "被非法 since 处理后会话必须仍然可用");
        }
    }

    /** 超大但合法的 since（能塞进 long 的未来值）按"晚于最新"处理 → 空。 */
    @Test
    void syncSinceHugeButValidReturnsEmpty() throws Exception {
        String a = uniq("sy6");
        try (WsTestClient ca = WsTestClient.open(port)) {
            ca.registerAndLogin(port, a);
            ca.clearAll();

            ca.send(syncSince(a, 4102444800000L));    // 2100-01-01
            JsonObject sr = ca.await("sync_result", 4000);
            assertNotNull(sr, "超大但合法的 since 必须返回 sync_result");
            assertEquals(0, intOf(sr, "count"), "超出最新时间的 since 应返回空");
        }
    }
}
