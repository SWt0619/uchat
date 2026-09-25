package com.chatroom2.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.lang.management.ManagementFactory;
import java.util.HashMap;
import java.util.Map;

@RestController
public class HealthController {

    private static final long startTime = System.currentTimeMillis();

    @GetMapping("/api/health")
    public Map<String, Object> health() {
        Map<String, Object> result = new HashMap<>();
        result.put("status", "ok");
        result.put("uptime", System.currentTimeMillis() - startTime);
        result.put("java", System.getProperty("java.version"));
        result.put("memory", ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed());
        return result;
    }
}
