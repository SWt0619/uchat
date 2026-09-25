package com.chatroom2.controller;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 音视频通话 ICE 服务器下发接口。
 *
 * <p>背景：纯 P2P WebRTC 在对称 NAT / 运营商 CGNAT / 企业防火墙后面无法靠 STUN 打通，
 * 必须依赖 TURN 中继。早期版本前端只硬编码了一条 {@code stun:stun.l.google.com:19302}，
 * 导致双方不在同一 NAT 后时必然连接失败。本接口把 ICE 服务器列表（含 TURN 短期凭据）
 * 下发给浏览器。</p>
 *
 * <p>凭据采用 coturn 的 {@code use-auth-secret}（REST API）机制：
 * username = {@code "<过期时间戳>:<标识>"}，password = base64(HMAC-SHA1(secret, username))。
 * 这样前端拿到的是一次性的、默认 1 小时过期的凭据，长期密钥不下发到浏览器。</p>
 *
 * <p>未配置 {@code chat.turn.host} / {@code chat.turn.secret} 时，
 * 本接口只返回 STUN 列表，前端行为与改造前一致（不会因为没配 TURN 而报错）。</p>
 */
@RestController
@RequestMapping("/api")
public class TurnController {

    /** 逗号分隔的 STUN 列表；Google 的 STUN 在国内常不可达，建议同时配自建 STUN */
    @Value("${chat.stun.urls:stun:stun.l.google.com:19302}")
    private String stunUrls = "stun:stun.l.google.com:19302";

    /** 例如 turn:turn.example.com:3478 ；留空表示未启用 TURN */
    @Value("${chat.turn.host:}")
    private String turnHost = "";

    /** 例如 turns:turn.example.com:5349 （UDP 被封时的 TCP/TLS 通道） */
    @Value("${chat.turn.tls-host:}")
    private String turnTlsHost = "";

    /** 与 coturn 的 static-auth-secret 一致；留空表示未启用 TURN */
    @Value("${chat.turn.secret:}")
    private String turnSecret = "";

    /** 静态 TURN 凭据（用于 node-turn 这类不支持 REST secret 的中继） */
    @Value("${chat.turn.username:}")
    private String turnUsername = "";

    @Value("${chat.turn.password:}")
    private String turnPassword = "";

    /** coturn realm，需要与 turnserver.conf 中的 realm 一致 */
    @Value("${chat.turn.realm:uchat}")
    private String turnRealm = "uchat";

    /** 公共 TURN（跨网络兜底；凭据与本地 TURN 不同）：逗号分隔的地址列表 */
    @Value("${chat.turn.public-urls:}")
    private String publicUrls = "";

    @Value("${chat.turn.public-username:}")
    private String publicUsername = "";

    @Value("${chat.turn.public-password:}")
    private String publicPassword = "";

    /** 凭据有效期（秒） */
    @Value("${chat.turn.ttl:3600}")
    private long turnTtl = 3600L;

    @GetMapping("/turn")
    public Map<String, Object> iceServers() {
        List<Map<String, String>> servers = new ArrayList<>();

        // ---- STUN（无论是否配 TURN 都下发）----
        if (stunUrls != null) {
            for (String raw : stunUrls.split(",")) {
                String url = raw.trim();
                if (url.isEmpty()) continue;
                Map<String, String> m = new LinkedHashMap<>();
                m.put("urls", url);
                if (!servers.contains(m)) servers.add(m);
            }
        }

        // ---- TURN（配置齐全才下发）----
        boolean staticCred = turnUsername != null && !turnUsername.isBlank()
                && turnPassword != null && !turnPassword.isBlank();
        boolean turnEnabled = turnHost != null && !turnHost.isBlank()
                && (staticCred || (turnSecret != null && !turnSecret.isBlank()));
        if (turnEnabled) {
            String username;
            String credential;
            if (staticCred) {
                // 静态凭据（node-turn 等）：直接下发固定用户名/口令
                username = turnUsername;
                credential = turnPassword;
            } else {
                long expiry = System.currentTimeMillis() / 1000L + Math.max(60L, turnTtl);
                // coturn 的 username 格式固定为 "<expiry>:<任意标识>"
                username = expiry + ":" + turnRealm;
                credential = buildCredential(turnSecret, username);
            }
            // 支持逗号分隔的多个地址：例如「局域网 3478 + 公网隧道端口」同时下发，
            // 同 WiFi 走内网地址（低延迟），跨网络自动回退到公网隧道地址。
            for (String rawHost : turnHost.split(",")) {
                String h = rawHost.trim();
                if (!h.isEmpty()) addTurnServer(servers, h, username, credential);
            }
            if (turnTlsHost != null && !turnTlsHost.isBlank()) {
                for (String rawHost : turnTlsHost.split(",")) {
                    String h = rawHost.trim();
                    if (!h.isEmpty()) addTurnServer(servers, h, username, credential);
                }
            }
        }

        // ---- 公共 TURN（跨网络兜底，自带凭据）----
        if (publicUrls != null && !publicUrls.isBlank()
                && publicUsername != null && !publicUsername.isBlank()
                && publicPassword != null && !publicPassword.isBlank()) {
            for (String rawUrl : publicUrls.split(",")) {
                String u = rawUrl.trim();
                if (u.isEmpty()) continue;
                Map<String, String> m = new LinkedHashMap<>();
                m.put("urls", u);
                m.put("username", publicUsername);
                m.put("credential", publicPassword);
                boolean dup = false;
                for (Map<String, String> ex : servers) { if (u.equals(ex.get("urls"))) { dup = true; break; } }
                if (!dup) servers.add(m);
            }
        }

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("iceServers", servers);
        resp.put("ttl", turnTtl);
        resp.put("turnEnabled", turnEnabled);
        return resp;
    }

    private static void addTurnServer(List<Map<String, String>> servers,
                                      String url, String username, String credential) {
        // 去重：同一 urls 只下发一次
        for (Map<String, String> existing : servers) {
            if (url.equals(existing.get("urls"))) return;
        }
        Map<String, String> m = new LinkedHashMap<>();
        m.put("urls", url);
        m.put("username", username);
        m.put("credential", credential);
        servers.add(m);
    }

    /**
     * coturn REST 凭据：base64(HMAC-SHA1(secret, username))。
     * 抽成包级静态方法便于单元测试（不依赖 Spring 容器）。
     */
    static String buildCredential(String secret, String username) {
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
            byte[] raw = mac.doFinal(username.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(raw);
        } catch (Exception e) {
            // 配置错误时不要让整个接口 500 —— 退化为不带凭据（前端会走 STUN）
            System.err.println("[TURN] 凭据生成失败: " + e.getMessage());
            return "";
        }
    }
}
