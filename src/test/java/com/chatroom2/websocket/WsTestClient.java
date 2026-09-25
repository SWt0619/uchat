package com.chatroom2.websocket;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 最小 WebSocket 测试客户端（T3 集成测试用）。
 *
 * <p>只用 JDK 17 自带的 {@code java.net.http.WebSocket}，不引入任何新依赖（pom.xml 本轮冻结）。
 * 收到的每个文本帧按 JSON 解析后进队列，{@link #await} 按 {@code type} 匹配取用，
 * 不匹配的留在 {@link #pending} 里，后续还能取到（避免把 history 回放之类顺手丢掉）。</p>
 */
final class WsTestClient implements AutoCloseable {

    static final String PWD = "t3pass123";
    static final String INVITE = "TEST_INVITE_CODE";   // 测试自用占位值（真实注册码只从环境变量 / 本机 invite.pwd 来）

    private final WebSocket ws;
    private final BlockingQueue<JsonObject> inbox;
    private final List<JsonObject> pending = new ArrayList<>();
    /** 登录时服务端回放的 history（含 welcome / userlist 等，断言自己按 msgId 过滤）。 */
    private final List<JsonObject> replay = new ArrayList<>();
    private volatile String nick;

    private WsTestClient(WebSocket ws, BlockingQueue<JsonObject> inbox) {
        this.ws = ws;
        this.inbox = inbox;
    }

    /** 建立连接（不做认证）。 */
    static WsTestClient open(int port) throws Exception {
        final BlockingQueue<JsonObject> inbox = new LinkedBlockingQueue<>();
        WebSocket.Listener listener = new WebSocket.Listener() {
            private final StringBuilder buf = new StringBuilder();

            @Override
            public void onOpen(WebSocket webSocket) {
                webSocket.request(1);
            }

            @Override
            public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                buf.append(data);
                if (last) {
                    String text = buf.toString();
                    buf.setLength(0);
                    try {
                        inbox.add(JsonParser.parseString(text).getAsJsonObject());
                    } catch (Exception ignored) {
                        // 非 JSON 帧（本项目不会发）直接忽略
                    }
                }
                webSocket.request(1);
                return null;
            }
        };
        HttpClient http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        WebSocket socket = http.newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/chat"), listener)
                .get(20, TimeUnit.SECONDS);
        return new WsTestClient(socket, inbox);
    }

    /** 注册并登录（昵称必须唯一，每个用例自己生成）。 */
    void registerAndLogin(int port, String nickname) throws Exception {
        this.nick = nickname;
        send(auth("register", nickname));
        JsonObject r = await("auth_resp", 15_000);
        if (r == null) throw new IllegalStateException("注册无响应: " + nickname);
        if (!"ok".equals(str(r, "subtype"))) {
            // 昵称已存在（重复跑测试且 users.dat 未清理）→ 回退登录
            send(auth("login", nickname));
            r = await("auth_resp", 15_000);
            if (r == null || !"ok".equals(str(r, "subtype"))) {
                throw new IllegalStateException("登录失败: " + nickname + " → " + r);
            }
        }
        // 收集登录时的 history 回放：一直收到队列静止为止（history 为空时服务端不发 history_start/end）
        long start = System.currentTimeMillis();
        long last = start;
        while (System.currentTimeMillis() - last < 250 && System.currentTimeMillis() - start < 4000) {
            JsonObject o;
            try {
                o = inbox.poll(250, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            if (o != null) {
                replay.add(o);
                last = System.currentTimeMillis();
            }
        }
        inbox.clear();
    }

    /** 登录时服务端回放的历史消息快照（含 welcome/userlist 等，断言按 msgId 过滤）。 */
    List<JsonObject> replay() {
        return new ArrayList<>(replay);
    }

    String nick() {
        return nick;
    }

    void send(JsonObject o) {
        ws.sendText(o.toString(), true).join();
    }

    void send(String json) {
        ws.sendText(json, true).join();
    }

    /** 取一条指定 type 的消息；不匹配的留在队列/暂存区。超时返回 null。 */
    JsonObject await(String type, long timeoutMs) {
        synchronized (pending) {
            for (int i = 0; i < pending.size(); i++) {
                if (type.equals(str(pending.get(i), "type"))) return pending.remove(i);
            }
        }
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (true) {
            long left = deadline - System.currentTimeMillis();
            if (left <= 0) return null;
            JsonObject o;
            try {
                o = inbox.poll(left, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            }
            if (o == null) return null;
            if (type.equals(str(o, "type"))) return o;
            synchronized (pending) {
                pending.add(o);
            }
        }
    }

    /** 在 timeoutMs 内收集全部指定 type 的消息。 */
    List<JsonObject> awaitAll(String type, long timeoutMs) {
        List<JsonObject> got = new ArrayList<>();
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (true) {
            long left = deadline - System.currentTimeMillis();
            if (left <= 0) break;
            JsonObject o = await(type, left);
            if (o == null) break;
            got.add(o);
        }
        return got;
    }

    void clearAll() {
        inbox.clear();
        synchronized (pending) {
            pending.clear();
        }
    }

    static List<JsonObject> withMsgId(List<JsonObject> list, String msgId) {
        List<JsonObject> out = new ArrayList<>();
        for (JsonObject o : list) {
            if (msgId.equals(str(o, "msgId"))) out.add(o);
        }
        return out;
    }

    static String str(JsonObject o, String field) {
        return (o == null || !o.has(field) || o.get(field).isJsonNull()) ? null : o.get(field).getAsString();
    }

    static JsonObject auth(String subtype, String nickname) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "auth");
        o.addProperty("subtype", subtype);
        o.addProperty("nickname", nickname);
        o.addProperty("content", PWD);
        o.addProperty("invite", INVITE);
        return o;
    }

    @Override
    public void close() {
        try {
            ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye").get(5, TimeUnit.SECONDS);
        } catch (Exception ignored) {
        }
        try {
            ws.abort();
        } catch (Exception ignored) {
        }
        try {
            Thread.sleep(150); // 让服务端先处理完 afterConnectionClosed，别把房间挤满
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
