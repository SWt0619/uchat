package com.chatroom2.model;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 私聊消息存储 —— P0-④「离线私聊」的唯一数据源。
 *
 * <p>改造前：{@code private} 消息只 {@code sendTo} 收发双方，对方离线时直接回 {@code private_fail}，
 * 消息**不落库** ⇒ 对方永远收不到、断线重连也补不回来。本类把每条私聊都落盘，解决三件事：</p>
 * <ol>
 *   <li><b>离线投递</b>：收件人登录时把未投递的私聊逐条补发（带 {@code offlineMsg:true}）；</li>
 *   <li><b>未读计数</b>：按发件人统计「尚未投递给收件人」的条数，登录时下发给客户端做角标；</li>
 *   <li><b>断线补齐</b>：{@code sync_since} 除了公共历史，还能按时间戳补自己涉及的私聊。</li>
 * </ol>
 *
 * <p><b>可见性</b>：查询一律以「本人是发件人 <u>或</u> 收件人」为条件（{@link #relatedTo}），
 * 任何一条私聊都不会出现在第三方的结果里。</p>
 *
 * <p><b>容量与诚实边界</b>：全局 {@link #MAX_TOTAL} 条、单个收件人 {@link #MAX_PER_USER} 条，
 * 超出丢最旧的，并按收件人累计 {@link #droppedFor} 计数 —— 客户端据此如实提示"有消息补不齐"，
 * 而不是假装没丢。落盘文件 {@code user.dir/data/private.dat}，格式：第 1 行元数据 JSON，
 * 之后每行一条记录 JSON。写入是「临时文件 + 原子替换」，与 {@link Room} 相同的 1 秒节流 + 10 秒兜底线程。</p>
 */
public class PrivateStore {

    /** 一条私聊记录。{@link #json} 与广播出去的消息逐字一致，客户端据此按 msgId 去重。 */
    public static class Entry {
        public String json;
        public String from;
        public String to;
        public long ts;
        public boolean delivered;

        public Entry() {}

        public Entry(String json, String from, String to, long ts, boolean delivered) {
            this.json = json;
            this.from = from;
            this.to = to;
            this.ts = ts;
            this.delivered = delivered;
        }
    }

    private static final Gson GSON = new Gson();
    private static final Path DATA_DIR = Paths.get(System.getProperty("user.dir"), "data");
    private static final Path STORE_FILE = DATA_DIR.resolve("private.dat");

    /** 全局上限：私聊总量（超出丢最旧）。 */
    static final int MAX_TOTAL = 2000;
    /** 单个收件人上限：一个人最多攒这么多条离线私聊。 */
    static final int MAX_PER_USER = 200;

    private static final PrivateStore INSTANCE = new PrivateStore();

    /** 按时间升序（{@link #add} 追加 + 丢弃最旧，天然有序）。 */
    private final List<Entry> entries = new ArrayList<>();
    /** 收件人 -> 因容量上限被丢弃的条数（如实告知"补不齐"）。 */
    private final Map<String, Integer> dropped = new ConcurrentHashMap<>();

    private volatile boolean loaded = false;
    private volatile boolean dirty = false;
    private volatile long lastSaveAt = 0;
    private volatile boolean shutdown = false;

    private PrivateStore() {
        Thread saver = new Thread(() -> {
            while (!shutdown) {
                try {
                    Thread.sleep(10000);
                } catch (InterruptedException e) {
                    break;
                }
                if (dirty) {
                    dirty = false;
                    saveToFile();
                }
            }
            if (dirty) saveToFile();
        }, "private-saver");
        saver.setDaemon(true);
        saver.start();
    }

    public static PrivateStore getInstance() {
        return INSTANCE;
    }

    // ==================== 写入 ====================

    /**
     * 落库一条私聊（无论收件人在线与否 —— 在线只是"顺手直发"，落库是为了断线/离线的补齐）。
     *
     * @return 写入的记录，调用方可用它 {@link #markDelivered} 标记"已投递给收件人"
     */
    public synchronized Entry add(Message msg, String json) {
        ensureLoaded();
        Entry e = new Entry(json, msg.nickname, msg.receiver, msgTs(msg), false);
        entries.add(e);
        prune(e.to);
        markDirty();
        return e;
    }

    /** 标记单条已投递给收件人。 */
    public synchronized void markDelivered(Entry e) {
        if (e == null || e.delivered) return;
        ensureLoaded();
        e.delivered = true;
        markDirty();
    }

    /** 批量标记（登录补投 / sync 补齐之后调用）。 */
    public synchronized void markDelivered(Collection<Entry> list) {
        if (list == null || list.isEmpty()) return;
        ensureLoaded();
        boolean changed = false;
        for (Entry e : list) {
            if (!e.delivered) {
                e.delivered = true;
                changed = true;
            }
        }
        if (changed) markDirty();
    }

    /** 把某收件人名下所有未投递的私聊标记为已投递。 */
    public synchronized int markDeliveredFor(String nick) {
        if (nick == null) return 0;
        ensureLoaded();
        int n = 0;
        for (Entry e : entries) {
            if (nick.equals(e.to) && !e.delivered) {
                e.delivered = true;
                n++;
            }
        }
        if (n > 0) markDirty();
        return n;
    }

    private void prune(String recipient) {
        // ① 单个收件人上限
        int count = 0;
        for (Entry e : entries) {
            if (recipient != null && recipient.equals(e.to)) count++;
        }
        while (count > MAX_PER_USER) {
            for (int i = 0; i < entries.size(); i++) {
                if (recipient.equals(entries.get(i).to)) {
                    entries.remove(i);
                    bumpDropped(recipient);
                    count--;
                    break;
                }
            }
        }
        // ② 全局上限
        while (entries.size() > MAX_TOTAL) {
            Entry removed = entries.remove(0);
            bumpDropped(removed.to);
        }
    }

    private void bumpDropped(String recipient) {
        if (recipient == null) return;
        dropped.merge(recipient, 1, Integer::sum);
    }

    // ==================== 查询 ====================

    /** 尚未投递给 {@code nick} 的私聊条数（= 未读数）。 */
    public synchronized int undeliveredCount(String nick) {
        ensureLoaded();
        return pendingFor(nick).size();
    }

    /** 未读数按发件人分组（登录时下发给客户端做"每个联系人有几条未读"的角标）。 */
    public synchronized Map<String, Integer> undeliveredBySender(String nick) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (Entry e : pendingFor(nick)) {
            out.merge(e.from == null ? "?" : e.from, 1, Integer::sum);
        }
        return out;
    }

    /** 待投递列表（时间升序）。 */
    public synchronized List<Entry> pendingFor(String nick) {
        ensureLoaded();
        List<Entry> out = new ArrayList<>();
        if (nick == null) return out;
        for (Entry e : entries) {
            if (nick.equals(e.to) && !e.delivered) out.add(e);
        }
        return out;
    }

    /** 本人涉及的私聊（发件人或收件人），时间升序。 */
    public synchronized List<Entry> relatedTo(String nick) {
        ensureLoaded();
        List<Entry> out = new ArrayList<>();
        if (nick == null) return out;
        for (Entry e : entries) {
            if (nick.equals(e.from) || nick.equals(e.to)) out.add(e);
        }
        return out;
    }

    /** 本人涉及的、时间戳严格晚于 {@code since} 的私聊（断线补齐）。 */
    public synchronized List<Entry> sinceFor(String nick, long since) {
        ensureLoaded();
        List<Entry> out = new ArrayList<>();
        if (nick == null) return out;
        for (Entry e : entries) {
            if ((nick.equals(e.from) || nick.equals(e.to)) && e.ts > since) out.add(e);
        }
        return out;
    }

    /** 本人涉及的私聊里最早/最晚的时间戳；没有则返回 null。 */
    public synchronized Long oldestFor(String nick) {
        Long v = null;
        for (Entry e : relatedTo(nick)) {
            if (v == null || e.ts < v) v = e.ts;
        }
        return v;
    }

    public synchronized Long newestFor(String nick) {
        Long v = null;
        for (Entry e : relatedTo(nick)) {
            if (v == null || e.ts > v) v = e.ts;
        }
        return v;
    }

    /** 因容量上限被丢弃的条数（>0 表示该用户有私聊补不齐）。 */
    public synchronized int droppedFor(String nick) {
        if (nick == null) return 0;
        ensureLoaded();
        Integer v = dropped.get(nick);
        return v == null ? 0 : v;
    }

    public synchronized int size() {
        ensureLoaded();
        return entries.size();
    }

    // ==================== 落盘 ====================

    private void markDirty() {
        dirty = true;
        long now = System.currentTimeMillis();
        if (now - lastSaveAt > 1000) {
            lastSaveAt = now;
            dirty = false;
            saveToFile();
        }
    }

    public synchronized void saveToFile() {
        try {
            Files.createDirectories(DATA_DIR);
            Path tmp = DATA_DIR.resolve("private.dat.tmp");
            JsonObject meta = new JsonObject();
            JsonObject droppedJson = new JsonObject();
            for (Map.Entry<String, Integer> e : dropped.entrySet()) {
                droppedJson.addProperty(e.getKey(), e.getValue());
            }
            meta.add("dropped", droppedJson);
            try (BufferedWriter w = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
                w.write(GSON.toJson(meta));
                w.write("\n");
                for (Entry e : entries) {
                    w.write(GSON.toJson(e));
                    w.write("\n");
                }
            }
            Files.move(tmp, STORE_FILE, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            System.err.println("[PrivateStore] 保存私聊数据失败: " + e.getMessage());
        }
    }

    private void ensureLoaded() {
        if (loaded) return;
        loaded = true;
        try {
            if (!Files.exists(STORE_FILE)) return;
            List<String> lines = Files.readAllLines(STORE_FILE, StandardCharsets.UTF_8);
            if (lines.isEmpty()) return;
            // 第 1 行：本格式写的是元数据（含 dropped）；若第 1 行就是一条记录（旧文件/无元数据）则从 0 开始
            int start = 0;
            try {
                JsonObject meta = JsonParser.parseString(lines.get(0)).getAsJsonObject();
                if (meta.has("dropped") && meta.get("dropped").isJsonObject()) {
                    for (Map.Entry<String, com.google.gson.JsonElement> e : meta.getAsJsonObject("dropped").entrySet()) {
                        dropped.put(e.getKey(), e.getValue().getAsInt());
                    }
                    start = 1;
                } else if (!meta.has("json")) {
                    start = 1;      // 无法识别的表头行，跳过
                }
            } catch (Exception e) {
                start = 0;
            }
            for (int i = start; i < lines.size(); i++) {
                String ln = lines.get(i);
                if (ln == null || ln.trim().isEmpty()) continue;
                try {
                    Entry e = GSON.fromJson(ln, Entry.class);
                    if (e != null && e.json != null) entries.add(e);
                } catch (Exception ignored) {
                }
            }
            System.out.println("[PrivateStore] 已加载私聊记录 " + entries.size() + " 条");
        } catch (Exception e) {
            System.err.println("[PrivateStore] 加载私聊数据失败: " + e.getMessage());
        }
    }

    /** 清空（仅测试用；生产路径不调用）。 */
    public synchronized void clearAll() {
        entries.clear();
        dropped.clear();
        loaded = true;
        saveToFile();
    }

    /**
     * 私聊时间戳（毫秒）：优先 msgId 前缀（客户端时钟，与 sync_since 的 since 同源），
     * 其次 serverTime；都取不到则用当前时间（保证新消息永远排在旧消息之后）。
     */
    static long msgTs(Message m) {
        if (m != null) {
            if (m.msgId != null) {
                int idx = m.msgId.indexOf('_');
                if (idx > 0) {
                    try {
                        long t = Long.parseLong(m.msgId.substring(0, idx));
                        if (t > 0) return t;
                    } catch (NumberFormatException ignored) {
                    }
                }
            }
            if (m.serverTime != null && m.serverTime > 0) return m.serverTime;
        }
        return System.currentTimeMillis();
    }
}
