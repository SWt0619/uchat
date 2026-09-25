package com.chatroom2.controller;

import com.chatroom2.model.AuthTokenStore;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.*;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 听歌房「本地音频」上传接口（2026-09-24 v2.9.0）。
 *
 * 背景：原来只能粘网易云的 song?id=数字，走 music.163.com 的 outer 外链 —— 那接口对
 * 无版权/收费曲目会 302 到 404 或返回 HTML，用户看到"正在播放"却没声音，而且
 * 客户端把 play() 的失败吞掉了。现在支持两条腿：
 *   ① 网易云链接（仍可能有版权限制 ⇒ 客户端必须给出明确提示 + 自动跳过）
 *   ② 本地音频文件：上传到这里，房间内所有人用同一个 URL 播放 ⇒ 音源可控 + 时长可算 + 真同步
 *
 * 存储：<user.dir>/data/music/<yyyyMMdd_HHmmss>_<6位随机>.<ext>
 * 播放：由 {@link com.chatroom2.config.CorsConfig} 把 /music/** 映射到这个目录
 *      （Spring 的静态资源处理自带 HTTP Range 支持 —— <audio> 要 seek 到同步位置就必须有它）。
 */
@RestController
@RequestMapping("/api/music")
public class MusicController {

    /** 本地音频目录（ChatWebSocketHandler 校验 local 曲目时也用这个常量） */
    public static final Path MUSIC_DIR =
            Paths.get(System.getProperty("user.dir"), "data", "music");

    private static final long MAX_MUSIC_SIZE = 30L * 1024 * 1024;   // 单曲 ≤30MB（约 30 分钟的 128kbps mp3）
    private static final int KEEP_FILES = 40;                       // 目录里最多留 40 个（自动清最旧）
    private static final Set<String> OK_EXT = Set.of(
            "mp3", "ogg", "oga", "wav", "m4a", "aac", "flac", "opus", "webm");
    private static final SecureRandom RND = new SecureRandom();

    // 聊天室存储配额（与共享文件同一个上限）；由 Spring 注入才能拿到配置值
    private final com.chatroom2.model.StorageQuota quota;

    public MusicController(com.chatroom2.model.StorageQuota quota) {
        this.quota = quota;
    }

    @PostMapping("/upload")
    public ResponseEntity<Map<String, Object>> upload(@RequestParam("file") MultipartFile file,
                                                      @RequestParam(required = false) String nickname,
                                                      @RequestParam(required = false) String token) {
        Map<String, Object> result = new HashMap<>();
        if (!AuthTokenStore.getInstance().validate(nickname, token)) {
            result.put("error", "未登录或凭证过期");
            return ResponseEntity.status(403).body(result);
        }

        // 存储配额：超过上限直接拒绝并提示联系管理员（用户 2026-09-25 要求）
        if (quota.isFull()) {
            result.put("error", quota.fullMessage());
            result.put("quotaFull", true);
            return ResponseEntity.status(507).body(result);
        }
        if (file == null || file.isEmpty()) {
            result.put("error", "文件为空");
            return ResponseEntity.badRequest().body(result);
        }
        if (file.getSize() > MAX_MUSIC_SIZE) {
            result.put("error", "音频不能超过 30MB");
            return ResponseEntity.badRequest().body(result);
        }
        String original = file.getOriginalFilename() == null ? "" : file.getOriginalFilename();
        int dot = original.lastIndexOf('.');
        String ext = dot >= 0 ? original.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        if (!OK_EXT.contains(ext)) {
            result.put("error", "只支持音频格式：" + String.join(" / ", new TreeSet<>(OK_EXT)));
            return ResponseEntity.badRequest().body(result);
        }
        String ct = file.getContentType();
        if (ct != null && !ct.isEmpty() && !ct.startsWith("audio/") && !"application/octet-stream".equals(ct)) {
            result.put("error", "文件类型不是音频（" + ct + "）");
            return ResponseEntity.badRequest().body(result);
        }

        String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss").format(new Date());
        String name = stamp + "_" + randomSuffix() + "." + ext;
        try {
            Files.createDirectories(MUSIC_DIR);
            Path target = MUSIC_DIR.resolve(name);
            Path tmp = MUSIC_DIR.resolve(name + ".tmp");
            file.transferTo(tmp.toFile());
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            pruneOld();
            result.put("ok", true);
            result.put("name", name);                                  // 房间内用它作为 local 曲目 spec
            result.put("displayName", sanitizeDisplayName(original));   // 只用于界面显示
            result.put("size", Files.size(target));
            result.put("url", "/music/" + name);                        // <audio> 直接播这个
            return ResponseEntity.ok(result);
        } catch (IOException e) {
            result.put("error", "保存失败: " + e.getMessage());
            return ResponseEntity.status(500).body(result);
        }
    }

    /** 只保留最近的 KEEP_FILES 个音频，避免目录无限增长 */
    private void pruneOld() {
        try (var s = Files.list(MUSIC_DIR)) {
            List<Path> files = s.filter(Files::isRegularFile)
                    .filter(p -> !p.getFileName().toString().endsWith(".tmp"))
                    .collect(Collectors.toList());
            files.sort((a, b) -> Long.compare(lastModified(b), lastModified(a)));   // 新 → 旧
            for (int i = KEEP_FILES; i < files.size(); i++) {
                try { Files.deleteIfExists(files.get(i)); } catch (Exception ignored) {}
            }
        } catch (IOException ignored) {
        }
    }

    private static long lastModified(Path p) {
        try { return Files.getLastModifiedTime(p).toMillis(); } catch (Exception e) { return 0L; }
    }

    private static String randomSuffix() {
        String s = Long.toString(RND.nextLong() & 0x7fffffffffffffffL, 36);
        return s.length() > 6 ? s.substring(0, 6) : String.format("%-6s", s).replace(' ', '0');
    }

    /** 把上传时的原始文件名洗成安全短名（仅用于显示，不参与路径） */
    private static String sanitizeDisplayName(String original) {
        String base = original.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) base = base.substring(slash + 1);
        int dot = base.lastIndexOf('.');
        if (dot > 0) base = base.substring(0, dot);
        base = base.replaceAll("[\\p{Cntrl}]", "").trim();
        if (base.length() > 60) base = base.substring(0, 60);
        return base.isEmpty() ? "未命名音轨" : base;
    }
}
