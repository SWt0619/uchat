package com.chatroom2.model;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.*;
import java.util.stream.Stream;

/**
 * 聊天室存储配额（2026-09-25 v2.9.7 用户要求）：
 * 「当聊天室文件占用超过 50G 时禁止后续文件上传，提醒上传者联系管理员清理空间」。
 *
 * 统计范围 = 用户共享文件（data/users/shared/files）+ 听歌房上传的音频（data/music）。
 * 上限用 chat.files.max-total-gb 配置（默认 50）；管理员昵称取 chat.roles.admin 的第一个（展示在提示里）。
 */
@Component
public class StorageQuota {

    public static final Path SHARED_DIR = Paths.get(System.getProperty("user.dir"), "data", "users", "shared", "files");
    public static final Path MUSIC_DIR_PATH = Paths.get(System.getProperty("user.dir"), "data", "music");

    @Value("${chat.files.max-total-gb:50}")
    private double maxTotalGb = 50;

    @Value("${chat.roles.admin:}")
    private String adminRoles = "";

    private volatile long cachedUsed = -1;
    private volatile long cachedAt = 0;

    public long limitBytes() { return (long) (maxTotalGb * 1024L * 1024L * 1024L); }

    /** 管理员昵称（提示上传者联系谁） */
    public String adminName() {
        if (adminRoles == null) return "管理员";
        String first = adminRoles.split(",")[0].trim();
        return first.isEmpty() ? "管理员" : first;
    }

    /** 已用字节（10 秒缓存，避免每次上传都全目录扫描） */
    public long usedBytes() {
        long now = System.currentTimeMillis();
        if (cachedUsed >= 0 && now - cachedAt < 10_000) return cachedUsed;
        long total = 0;
        total += dirSize(SHARED_DIR);
        total += dirSize(MUSIC_DIR_PATH);
        cachedUsed = total;
        cachedAt = now;
        return total;
    }

    private static long dirSize(Path dir) {
        if (dir == null || !Files.isDirectory(dir)) return 0;
        long total = 0;
        try (Stream<Path> s = Files.list(dir)) {
            for (Path p : (Iterable<Path>) s::iterator) {
                try {
                    if (Files.isRegularFile(p) && !p.getFileName().toString().endsWith(".tmp")) total += Files.size(p);
                } catch (IOException ignored) {}
            }
        } catch (IOException ignored) {}
        return total;
    }

    /** 是否已满（超过上限即禁止上传） */
    public boolean isFull() { return usedBytes() >= limitBytes(); }

    /** 给用户看的提示文案 */
    public String fullMessage() {
        double usedGb = usedBytes() / 1024.0 / 1024.0 / 1024.0;
        return String.format("服务器存储空间已满：聊天室文件已占用 %.1f GB（上限 %.0f GB），暂时无法上传。请联系管理员 %s 清理空间。",
                usedGb, maxTotalGb, adminName());
    }

    /** 上传后清掉缓存，让下次检查立刻反映新占用 */
    public void invalidate() { cachedUsed = -1; }
}
