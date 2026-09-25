package com.chatroom2.model;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

public class Room {
    private static final int MAX_HISTORY = 200;
    private static final Path DATA_DIR = Paths.get(System.getProperty("user.dir"), "data");
    private static final Path ROOM_FILE = DATA_DIR.resolve("room.dat");

    private final String name;
    private final int maxCapacity;
    private final ConcurrentHashMap<String, UserSession> sessions = new ConcurrentHashMap<>();
    private final List<String> history = Collections.synchronizedList(new ArrayList<>());
    private volatile boolean shutdown = false;
    private volatile boolean dirty = false;
    private volatile long lastSaveTime = 0;

    public Room(String name, int maxCapacity) {
        this.name = name;
        this.maxCapacity = maxCapacity;
        // 每 10 秒检查一次是否需要写入磁盘，兼顾性能与数据安全
        Thread saver = new Thread(() -> {
            while (!shutdown) {
                try { Thread.sleep(10000); } catch (InterruptedException e) { break; }
                if (dirty) { dirty = false; saveToFile(); }
            }
            // 线程退出前最后一次保存
            if (dirty) saveToFile();
        }, "room-saver");
        saver.setDaemon(true);
        saver.start();
    }

    public void addHistory(String msg) {
        history.add(msg);
        if (history.size() > MAX_HISTORY) {
            history.remove(0);
        }
        // 标记脏数据：10 秒内只写一次磁盘，高并发时 1 秒节流
        dirty = true;
        long now = System.currentTimeMillis();
        if (now - lastSaveTime > 1000) {
            lastSaveTime = now;
            dirty = false;
            saveToFile();
        }
    }

    public List<String> getHistory() {
        synchronized (history) {
            return new ArrayList<>(history);
        }
    }

    public synchronized boolean join(UserSession session) {
        // 重连：替换已有的断线 session
        UserSession existing = sessions.get(session.getNickname());
        if (existing != null && existing.isDisconnected()) {
            existing.reconnect(session.getSession());
            return true;
        }
        // 有在线 session 则拒绝
        if (existing != null && existing.isOnline()) return false;
        // 检查容量时排除断线用户
        long onlineCount = sessions.values().stream().filter(UserSession::isOnline).count();
        if (onlineCount >= maxCapacity) return false;
        sessions.put(session.getNickname(), session);
        return true;
    }

    public void leave(String nickname) {
        sessions.remove(nickname);
    }

    // 断线但不离开房间（6分钟宽限期）
    public void disconnect(String nickname) {
        UserSession s = sessions.get(nickname);
        if (s != null) s.markDisconnected();
    }

    // 获取所有超时的断线用户（不移除，仅查询）
    public List<String> getExpiredDisconnected(long timeoutMs) {
        long now = System.currentTimeMillis();
        List<String> expired = new ArrayList<>();
        for (Map.Entry<String, UserSession> e : sessions.entrySet()) {
            UserSession s = e.getValue();
            if (s.isDisconnected() && (now - s.getDisconnectTime()) > timeoutMs) {
                expired.add(e.getKey());
            }
        }
        return expired;
    }

    // 移除所有超时未重连的断线用户
    public int removeExpiredDisconnected(long timeoutMs) {
        long now = System.currentTimeMillis();
        int removed = 0;
        for (Map.Entry<String, UserSession> e : sessions.entrySet()) {
            UserSession s = e.getValue();
            if (s.isDisconnected() && (now - s.getDisconnectTime()) > timeoutMs) {
                sessions.remove(e.getKey());
                removed++;
            }
        }
        return removed;
    }

    public void broadcast(String message, String excludeNickname) {
        for (Map.Entry<String, UserSession> entry : sessions.entrySet()) {
            if (!entry.getKey().equals(excludeNickname)) {
                entry.getValue().send(message);
            }
        }
    }

    public void broadcast(String message) {
        for (UserSession session : sessions.values()) {
            session.send(message);
        }
    }

    /**
     * 安全广播：只发给确认在线的 Session，跳过所有断连/半死 Session。
     * 避免对已关闭 WebSocket 调用 sendMessage() 触发底层容器级联关闭。
     */
    public void broadcastToAllOnline(String message) {
        for (UserSession session : sessions.values()) {
            if (session.isOnline()) {
                session.send(message);
            }
        }
    }

    /**
     * 安全广播（排除指定用户）：只发给确认在线的 Session
     */
    public void broadcastToAllOnline(String message, String excludeNickname) {
        for (Map.Entry<String, UserSession> entry : sessions.entrySet()) {
            if (entry.getKey().equals(excludeNickname)) continue;
            UserSession session = entry.getValue();
            if (session.isOnline()) {
                session.send(message);
            }
        }
    }

    public void sendTo(String nickname, String message) {
        UserSession session = sessions.get(nickname);
        if (session != null) session.send(message);
    }

    public int getUserCount() {
        return (int) sessions.values().stream().filter(UserSession::isOnline).count();
    }

    public boolean isFull() { return getUserCount() >= maxCapacity; }

    public boolean hasUser(String nickname) {
        UserSession s = sessions.get(nickname);
        return s != null && s.isOnline();
    }

    public UserSession getSession(String nickname) { return sessions.get(nickname); }

    public java.util.Map<String, String> getUserStatuses() {
        java.util.Map<String, String> map = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, UserSession> e : sessions.entrySet()) {
            String s = e.getValue().getStatus();
            if (s != null && !s.isEmpty()) map.put(e.getKey(), s);
        }
        return map;
    }

    public ConcurrentHashMap<String, UserSession> getSessions() { return sessions; }

    // 返回所有用户（含断线），断线用户标记 offline
    public List<String> getUserNames() {
        return new ArrayList<>(sessions.keySet());
    }

    public List<String> getOnlineUserNames() {
        List<String> names = new ArrayList<>();
        for (Map.Entry<String, UserSession> e : sessions.entrySet()) {
            if (e.getValue().isOnline()) names.add(e.getKey());
        }
        return names;
    }

    public List<String> getDisconnectedUserNames() {
        List<String> names = new ArrayList<>();
        for (Map.Entry<String, UserSession> e : sessions.entrySet()) {
            if (e.getValue().isDisconnected()) names.add(e.getKey());
        }
        return names;
    }

    public String getName() { return name; }

    public void shutdown() {
        shutdown = true;
        broadcast("{\"type\":\"system\",\"content\":\"服务器已关闭\"}");
        for (UserSession session : sessions.values()) {
            session.flush();
            session.close();
        }
        sessions.clear();
    }

    // 加锁：saver 线程（每 10 秒）与消息线程（addHistory 里的节流保存）会同时进来，
    // 两者写的是同一个 room.dat.tmp ⇒ 不加锁可能互相踩、把 room.dat 写坏。
    public synchronized void saveToFile() {
        try {
            Files.createDirectories(DATA_DIR);
            Path tmp = DATA_DIR.resolve("room.dat.tmp");
            try (BufferedWriter w = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
                w.write("name=" + name + "\n");
                w.write("maxCapacity=" + maxCapacity + "\n");
                synchronized (history) {
                    for (String h : history) {
                        w.write(h + "\n");
                    }
                }
            }
            Files.move(tmp, ROOM_FILE, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            System.err.println("[Room] 保存房间数据失败: " + e.getMessage());
        }
    }

    public static Room loadFromFile() {
        try {
            if (!Files.exists(ROOM_FILE)) return null;
            List<String> lines = Files.readAllLines(ROOM_FILE, StandardCharsets.UTF_8);
            if (lines.size() < 2) return null;
            String nameLine = lines.get(0);
            String capLine = lines.get(1);
            if (!nameLine.startsWith("name=") || !capLine.startsWith("maxCapacity=")) {
                System.err.println("room.dat 格式异常，已忽略");
                return null;
            }
            String name = nameLine.substring("name=".length());
            int cap = Integer.parseInt(capLine.substring("maxCapacity=".length()));
            Room room = new Room(name, cap);
            List<String> hist = new ArrayList<>();
            for (int i = 2; i < lines.size(); i++) hist.add(lines.get(i));
            room.setHistory(hist);
            return room;
        } catch (Exception e) {
            System.err.println("room.dat 加载失败: " + e.getMessage());
            return null;
        }
    }

    public void setHistory(List<String> loaded) {
        history.clear();
        history.addAll(loaded);
    }
}
