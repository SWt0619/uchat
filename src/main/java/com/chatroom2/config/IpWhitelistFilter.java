package com.chatroom2.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.servlet.*;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * IP 白名单过滤器。启用后仅允许白名单内的 IP 访问所有 HTTP 端点。
 * 通过 chat.ip-whitelist.enabled 和 chat.ip-whitelist.ips 配置。
 */
@Component
public class IpWhitelistFilter implements Filter {

    @Value("${chat.ip-whitelist.enabled:false}")
    private boolean enabled;

    @Value("${chat.ip-whitelist.ips:}")
    private String whitelistIps;

    private final Set<String> resolvedIps = new HashSet<>();
    private volatile boolean parsed = false;

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {

        if (!enabled) {
            chain.doFilter(request, response);
            return;
        }

        String remoteIp = getClientIp((HttpServletRequest) request);

        if (isLocalhost(remoteIp)) {
            chain.doFilter(request, response);
            return;
        }

        parseOnce();

        if (resolvedIps.contains(remoteIp)) {
            chain.doFilter(request, response);
            return;
        }

        HttpServletResponse httpResp = (HttpServletResponse) response;
        httpResp.setStatus(403);
        httpResp.setContentType("text/plain;charset=UTF-8");
        httpResp.getWriter().write("403 Forbidden — IP not in whitelist");
    }

    private String getClientIp(HttpServletRequest request) {
        String ip = request.getHeader("X-Forwarded-For");
        if (ip != null && !ip.isEmpty() && !"unknown".equalsIgnoreCase(ip)) {
            return ip.split(",")[0].trim();
        }
        ip = request.getHeader("X-Real-IP");
        if (ip != null && !ip.isEmpty() && !"unknown".equalsIgnoreCase(ip)) {
            return ip.trim();
        }
        return request.getRemoteAddr();
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
