package com.chatroom2.config;

import com.chatroom2.websocket.ChatWebSocketHandler;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final WhitelistHandshakeInterceptor whitelistInterceptor;

    @Value("${chat.allowed-origins:*}")
    private String allowedOrigins;

    public WebSocketConfig(WhitelistHandshakeInterceptor whitelistInterceptor) {
        this.whitelistInterceptor = whitelistInterceptor;
    }

    @Bean
    public ChatWebSocketHandler chatWebSocketHandler() {
        return new ChatWebSocketHandler();
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(chatWebSocketHandler(), "/ws/chat")
                .addInterceptors(whitelistInterceptor)
                .setAllowedOrigins(allowedOrigins);
    }

    /**
     * 配置 WebSocket 消息缓冲区大小。
     * Tomcat 默认 8KB，SDP offer/answer（含视频编解码信息）可达 5-10KB，
     * 必须放大到 256KB 以容纳带视频的 WebRTC 信令。
     */
    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(256 * 1024);   // 256KB
        container.setMaxBinaryMessageBufferSize(256 * 1024); // 256KB
        container.setMaxSessionIdleTimeout(1800000L);        // 30min idle timeout (was 10min, caused frequent disconnects)
        return container;
    }
}
