package com.chatroom2.controller;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import org.springframework.web.bind.annotation.*;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

@RestController
@RequestMapping("/api/prefs")
public class PrefsController {

    private static final Path DATA_DIR = Paths.get(System.getProperty("user.dir"), "data", "users");
    private static final Gson GSON = new Gson();
    private static final int MAX_PREFS_SIZE = 64 * 1024; // 64KB 上限

    /** 防御路径穿越：拒绝包含危险字符的昵称 */
    private static String sanitizeNickname(String nickname) {
        if (nickname == null || nickname.isEmpty()) return null;
        if (nickname.contains("..") || nickname.contains("/") || nickname.contains("\\")
                || nickname.contains("\0") || nickname.length() > 64) {
            return null;
        }
        return nickname.trim();
    }

    @GetMapping("/{nickname}")
    public Map<String, Object> load(@PathVariable String nickname,
                                    @RequestParam(required = false) String token) {
        nickname = sanitizeNickname(nickname);
        if (nickname == null) return new HashMap<>();
        // 2026-09-25 修：原先无鉴权 —— 知道昵称就能读别人的偏好
        if (!com.chatroom2.model.AuthTokenStore.getInstance().validate(nickname, token)) {
            Map<String, Object> denied = new HashMap<>();
            denied.put("error", "未登录或凭证过期");
            return denied;
        }
        Path file = DATA_DIR.resolve(nickname).resolve("prefs.json");
        if (Files.exists(file)) {
            try {
                String json = Files.readString(file);
                return GSON.fromJson(json, new TypeToken<Map<String, Object>>(){}.getType());
            } catch (Exception e) {
                System.err.println("[Prefs] 加载失败: " + nickname + " — " + e.getMessage());
            }
        }
        return new HashMap<>();
    }

    @PostMapping("/{nickname}")
    public Map<String, String> save(@PathVariable String nickname, @RequestBody Map<String, Object> prefs,
                                    @RequestParam(required = false) String token) {
        nickname = sanitizeNickname(nickname);
        if (nickname == null) return Map.of("status", "error", "message", "昵称无效");
        // 2026-09-25 修：原先无鉴权 —— 知道昵称就能改别人的偏好
        if (!com.chatroom2.model.AuthTokenStore.getInstance().validate(nickname, token)) {
            return Map.of("status", "error", "message", "未登录或凭证过期");
        }
        if (prefs != null) {
            String json = GSON.toJson(prefs);
            if (json.length() > MAX_PREFS_SIZE) {
                return Map.of("status", "error", "message", "数据过大");
            }
        }
        try {
            Path dir = DATA_DIR.resolve(nickname);
            Files.createDirectories(dir);
            Path file = dir.resolve("prefs.json");
            Path tmp = dir.resolve("prefs.json.tmp");
            Files.writeString(tmp, GSON.toJson(prefs), StandardCharsets.UTF_8);
            Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            return Map.of("status", "ok");
        } catch (IOException e) {
            System.err.println("[Prefs] 保存失败: " + nickname + " — " + e.getMessage());
            return Map.of("status", "error", "message", e.getMessage());
        }
    }
}
