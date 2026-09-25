package com.chatroom2.model;

import java.security.SecureRandom;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 认证令牌存储 —— 桥接 WebSocket 登录与 HTTP 文件访问。
 * WebSocket 登录成功后发放 token，前端在文件下载/预览请求中携带，
 * FileController 据此验证用户身份。
 */
public class AuthTokenStore {

    private static final AuthTokenStore INSTANCE = new AuthTokenStore();
    private static final SecureRandom RNG = new SecureRandom();

    private final ConcurrentHashMap<String, String> tokenToNick = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> nickToToken = new ConcurrentHashMap<>();

    private AuthTokenStore() {}

    public static AuthTokenStore getInstance() { return INSTANCE; }

    /** 为用户生成新 token，覆盖旧 token */
    public String generate(String nickname) {
        String old = nickToToken.remove(nickname);
        if (old != null) tokenToNick.remove(old);
        String token = randomToken();
        tokenToNick.put(token, nickname);
        nickToToken.put(nickname, token);
        return token;
    }

    /** 验证 token 是否属于该用户 */
    public boolean validate(String nickname, String token) {
        if (nickname == null || token == null) return false;
        String owner = tokenToNick.get(token);
        return nickname.equals(owner);
    }

    /** 用户登出时清除 token */
    public void remove(String nickname) {
        String token = nickToToken.remove(nickname);
        if (token != null) tokenToNick.remove(token);
    }

    private static String randomToken() {
        byte[] b = new byte[32];
        RNG.nextBytes(b);
        StringBuilder sb = new StringBuilder(64);
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }
}
