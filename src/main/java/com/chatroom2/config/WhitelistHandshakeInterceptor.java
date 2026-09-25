package com.chatroom2.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * WebSocket 握手阶段的白名单拦截器。与 IpWhitelistFilter 共享同一套配置，
 * 在 WebSocket 升级握手时拒绝非白名单 IP。
 */
@Component
public class WhitelistHandshakeInterceptor implements HandshakeInterceptor {

    private static final Logger log = LoggerFactory.getLogger(WhitelistHandshakeInterceptor.class);

    @Value("${chat.ip-whitelist.enabled:false}")
    private boolean enabled;

    @Value("${chat.ip-whitelist.ips:}")
    private String whitelistIps;

    private final Set<String> resolvedIps = new HashSet<>();
    private volatile boolean parsed = false;

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                   org.springframework.web.socket.WebSocketHandler wsHandler,
                                   Map<String, Object> attributes) {
        if (!enabled) return true;

        String remoteIp = getClientIp(request);

        if (isLocalhost(remoteIp)) return true;

        parseOnce();

        if (resolvedIps.contains(remoteIp)) return true;

        log.warn("WebSocket handshake denied for IP: {}", remoteIp);
        response.setStatusCode(HttpStatus.FORBIDDEN);
        return false;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                               org.springframework.web.socket.WebSocketHandler wsHandler,
                               Exception exception) {
        // no-op
    }

    private String getClientIp(ServerHttpRequest request) {
        String ip = request.getHeaders().getFirst("X-Forwarded-For");
        if (ip != null && !ip.isEmpty() && !"unknown".equalsIgnoreCase(ip)) {
            return ip.split(",")[0].trim();
        }
        ip = request.getHeaders().getFirst("X-Real-IP");
        if (ip != null && !ip.isEmpty() && !"unknown".equalsIgnoreCase(ip)) {
            return ip.trim();
        }
        return request.getRemoteAddress() != null
            ? request.getRemoteAddress().getAddress().getHostAddress()
            : "unknown";
    }

    private boolean isLocalhost(String ip) {
        return "127.0.0.1".equals(ip)
            || "0:0:0:0:0:0:0:1".equals(ip)
            || "::1".equals(ip);
    }

    private void parseOnce() {
        if (parsed) return;
        parsed = true;
        if (whitelistIps == null || whitelistIps.trim().isEmpty()) return;
        for (String s : whitelistIps.trim().split("\\s*,\\s*")) {
            String trimmed = s.trim();
            if (!trimmed.isEmpty()) {
                resolvedIps.add(trimmed);
            }
        }
    }
}
