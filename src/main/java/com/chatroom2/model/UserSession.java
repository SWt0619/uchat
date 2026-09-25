package com.chatroom2.model;

import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import java.io.IOException;

public class UserSession {
    private final String nickname;
    private WebSocketSession session;
    private boolean muted = false;
    private boolean disconnected = false;
    private long disconnectTime = 0;
    private String status = null;

    public UserSession(String nickname, WebSocketSession session) {
        this.nickname = nickname;
        this.session = session;
    }

    public String getNickname() { return nickname; }

    public WebSocketSession getSession() { return session; }

    public boolean isMuted() { return muted; }

    public void setMuted(boolean muted) { this.muted = muted; }

    public boolean isDisconnected() { return disconnected; }

    public long getDisconnectTime() { return disconnectTime; }

    public String getStatus() { return status; }

    public void setStatus(String status) { this.status = status; }

    public void markDisconnected() {
        this.disconnected = true;
        this.disconnectTime = System.currentTimeMillis();
    }

    public void reconnect(WebSocketSession newSession) {
        this.session = newSession;
        this.disconnected = false;
        this.disconnectTime = 0;
    }

    public boolean isOnline() {
        return !disconnected && session != null && session.isOpen();
    }

    public void send(String message) {
        if (disconnected) return;
        WebSocketSession s = session;
        if (s == null) return;
        try {
            synchronized (s) {
                if (s.isOpen()) {
                    s.sendMessage(new TextMessage(message));
                }
            }
        } catch (Exception e) {
            // 写失败基本意味着这条 TCP 连接已经废了。
            // 旧版只打印一行日志就返回 —— 服务端会一直认为该用户"在线"，
            // 直到容器 idle 超时（本机配置 30 分钟），期间用户列表、
            // 广播、重连判定全部基于错误状态（重连时还会被判"房间已满"）。
            // 这里改为主动关闭连接：容器随即触发 afterConnectionClosed，
            // 正常的断线宽限期逻辑接管，客户端也会立刻开始重连。
            // 注意：close() 必须放在 synchronized 之外，避免与容器内部锁相互等待。
            System.err.println("[UserSession] " + nickname + " 发送失败，主动关闭连接以触发重连: " + e.getMessage());
            try { s.close(); } catch (Exception ignored) {}
        }
    }

    public void flush() {}

    public void close() {
        try { if (session != null) session.close(); } catch (IOException ignored) {}
    }
}
