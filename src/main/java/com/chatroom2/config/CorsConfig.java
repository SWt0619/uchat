package com.chatroom2.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 全局 CORS 配置，取代各 Controller 上硬编码的 @CrossOrigin(origins = "*")。
 * 可通过 chat.allowed-origins 属性指定允许的来源，默认 "*"。
 * 部署到公网时应设为具体域名，如 https://chat.example.com
 */
@Configuration
public class CorsConfig implements WebMvcConfigurer {

    @Value("${chat.allowed-origins:*}")
    private String allowedOrigins;

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                // 注意：allowedOriginPatterns(String...) 不会按逗号拆分，
                // 直接传整串逗号列表会导致任何 Origin 都匹配不上（跨源一律 403）。
                .allowedOriginPatterns(allowedOrigins.split("\\s*,\\s*"))
                .allowedMethods("GET", "POST", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(true);
    }

    /**
     * 听歌房的「本地音频」静态映射（2026-09-24 v2.9.0）：
     *   data/music/<file>  →  /music/<file>
     *
     * 用 Spring 的静态资源处理而不是自己写 Controller 读流，是因为它**自带 HTTP Range 支持** ——
     * 「真同步」要求客户端能 seek 到 (当前时间 - 服务端起点) 的位置，没有 Range 就只能从头播。
     * 文件名 = 时间戳 + 随机后缀（不可猜），和静态资源一样同源访问，不需要额外鉴权头。
     */
    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/music/**")
                .addResourceLocations("file:./data/music/")
                .setCachePeriod(3600);
    }
}
