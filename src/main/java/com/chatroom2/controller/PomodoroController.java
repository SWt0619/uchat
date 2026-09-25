package com.chatroom2.controller;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import org.springframework.web.bind.annotation.*;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

@RestController
@RequestMapping("/api/pomodoro")
public class PomodoroController {

    private static final Gson GSON = new Gson();
    private static final Path DATA_DIR = Paths.get(System.getProperty("user.dir"), "data", "users");

    @GetMapping("/{nickname}")
    public Map<String, Object> load(@PathVariable String nickname,
                                    @RequestParam(required = false) String token) {
        String safe = sanitize(nickname);
        // 2026-09-25 修：原先无鉴权
        if (safe == null || !com.chatroom2.model.AuthTokenStore.getInstance().validate(safe, token)) {
            Map<String, Object> denied = new HashMap<>();
            denied.put("ok", false);
            denied.put("error", "未登录或凭证过期");
            return denied;
        }
        if (safe == null) return Collections.singletonMap("ok", false);

        Path file = DATA_DIR.resolve(safe).resolve("pomodoro.json");
        if (!Files.exists(file)) {
            Map<String, Object> empty = new LinkedHashMap<>();
            empty.put("ok", true);
            empty.put("stats", null);
            return empty;
        }
        try {
            String json = Files.readString(file);
            Map<String, Object> stats = GSON.fromJson(json, new TypeToken<Map<String, Object>>(){}.getType());
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("ok", true);
            result.put("stats", stats);
            return result;
        } catch (Exception e) {
            return Collections.singletonMap("ok", false);
        }
    }

    @PostMapping("/{nickname}")
    public Map<String, Object> save(@PathVariable String nickname, @RequestBody Map<String, Object> body,
                                    @RequestParam(required = false) String token) {
        String safe = sanitize(nickname);
        // 2026-09-25 修：原先无鉴权
        if (safe == null || !com.chatroom2.model.AuthTokenStore.getInstance().validate(safe, token)) {
            Map<String, Object> denied = new HashMap<>();
            denied.put("ok", false);
            denied.put("error", "未登录或凭证过期");
            return denied;
        }
        if (safe == null) return Collections.singletonMap("ok", false);

        Object statsObj = body.get("stats");
        if (statsObj == null) return Collections.singletonMap("ok", false);

        try {
            Path dir = DATA_DIR.resolve(safe);
            Files.createDirectories(dir);
            Path file = dir.resolve("pomodoro.json");
            String json = GSON.toJson(statsObj);
            // 原子写入
            Path tmp = dir.resolve("pomodoro.tmp");
            Files.writeString(tmp, json, StandardCharsets.UTF_8);
            Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            return Collections.singletonMap("ok", true);
        } catch (Exception e) {
            return Collections.singletonMap("ok", false);
        }
    }

    private String sanitize(String nickname) {
        if (nickname == null || nickname.isEmpty() || nickname.length() > 64) return null;
        if (nickname.contains("..") || nickname.contains("/") || nickname.contains("\\") || nickname.contains("\0")) return null;
        return nickname;
    }
}
