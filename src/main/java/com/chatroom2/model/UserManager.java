package com.chatroom2.model;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.spec.KeySpec;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

public class UserManager {
    private static final Path DATA_DIR = Paths.get(System.getProperty("user.dir"), "data");
    private static final Path USERS_FILE = DATA_DIR.resolve("users.dat");
    private static final SecureRandom RNG = new SecureRandom();
    // PBKDF2 参数：100,000 次迭代，256 位密钥
    private static final int PBKDF2_ITERATIONS = 100_000;
    private static final int PBKDF2_KEY_LENGTH = 256;
    private static final String PBKDF2_ALGO = "PBKDF2WithHmacSHA256";
    // 存储格式前缀，区分新旧算法：2=PBKDF2, 1=SHA-256+salt, 0=SHA-256无盐
    private static final String PREFIX_PBKDF2 = "2:";
    private static final String PREFIX_SALTED_SHA = "1:";

    /** 注册 / 改密 / 存盘 的串行化锁：三者必须原子，否则并发注册会丢账号（整表写回被覆盖） */
    private final Object writeLock = new Object();
    private final ConcurrentHashMap<String, String> users = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> salts = new ConcurrentHashMap<>();

    public UserManager() { load(); }


    /**
     * 统一的密码规则（前端 / HTTP / WebSocket 三处必须一致）：
     * 6-18 位，且不含空白与冒号（冒号会破坏 昵称:盐:哈希 的存储格式）。
     * 注意：仅用于“新设置的密码”（注册 / 改密）；登录只做校验不做规则限制。
     */
    public static boolean isPasswordAcceptable(String pwd) {
        if (pwd == null) return false;
        int n = pwd.length();
        if (n < 6 || n > 18) return false;
        for (int i = 0; i < n; i++) {
            char ch = pwd.charAt(i);
            if (Character.isWhitespace(ch) || ch == ':') return false;
        }
        return true;
    }

    public boolean isRegistered(String nickname) { return users.containsKey(nickname); }

    public boolean register(String nickname, String password) {
      synchronized (writeLock) {
        if (isRegistered(nickname)) return false;
        if (nickname == null || nickname.trim().isEmpty()) return false;
        if (!isPasswordAcceptable(password)) return false;
        // v2.1.1: 移除 [a-zA-Z0-9] 限制，允许特殊字符
        String salt = generateSalt();
        salts.put(nickname, salt);
        users.put(nickname, hashPdkdf2(password, salt));
        save();
        return true;
      }
    }

    public boolean changePassword(String nickname, String oldPwd, String newPwd) {
      synchronized (writeLock) {
        if (!authenticate(nickname, oldPwd)) return false;
        if (!isPasswordAcceptable(newPwd)) return false;
        String salt = salts.get(nickname);
        if (salt == null) { salt = generateSalt(); salts.put(nickname, salt); }
        users.put(nickname, hashPdkdf2(newPwd, salt));
        save();
        return true;
      }
    }

    public boolean authenticate(String nickname, String password) {
        String stored = users.get(nickname);
        if (stored == null) return false;

        // 根据存储的算法前缀选择验证方式
        if (stored.startsWith(PREFIX_PBKDF2)) {
            String salt = salts.get(nickname);
            if (salt == null) return false;
            return stored.equals(hashPdkdf2(password, salt));
        } else if (stored.startsWith(PREFIX_SALTED_SHA)) {
            String salt = salts.get(nickname);
            if (salt != null && stored.equals(hashSaltedSha256(password, salt))) {
                // 升级到 PBKDF2
                upgradeToPdkdf2(nickname, password, salt);
                return true;
            }
            return false;
        } else {
            // 遗留格式无前缀：可能是 SHA-256(salt+password) 或 SHA-256(password)
            String salt = salts.get(nickname);
            if (salt != null) {
                // 旧格式有盐：SHA-256(salt + password)
                if (stored.equals(hashSaltedSha256Raw(password, salt))) {
                    upgradeToPdkdf2(nickname, password, salt);
                    return true;
                }
            } else {
                // 最旧格式：纯 SHA-256(password)
                if (stored.equals(hashLegacySha256(password))) {
                    String newSalt = generateSalt();
                    salts.put(nickname, newSalt);
                    users.put(nickname, hashPdkdf2(password, newSalt));
                    save();
                    return true;
                }
            }
            return false;
        }
    }

    private void upgradeToPdkdf2(String nickname, String password, String salt) {
        salts.put(nickname, salt);
        users.put(nickname, hashPdkdf2(password, salt));
        save();
    }

    private void load() {
        try {
            Files.createDirectories(DATA_DIR);
            if (Files.exists(USERS_FILE)) {
                for (String line : Files.readAllLines(USERS_FILE, StandardCharsets.UTF_8)) {
                    // 限制 split 次数为 3，避免哈希值中的 ":" 被误分割
                    String[] parts = line.split(":", 3);
                    if (parts.length >= 3) {
                        salts.put(parts[0], parts[1]);
                        users.put(parts[0], parts[2]);
                    } else if (parts.length == 2) {
                        users.put(parts[0], parts[1]);
                    }
                }
            }
        } catch (IOException e) {
            System.err.println("[UserManager] 加载用户数据失败: " + e.getMessage());
        }
    }

    private void save() {
      synchronized (writeLock) {
        try {
            Files.createDirectories(DATA_DIR);
            List<String> lines = new ArrayList<>();
            for (Map.Entry<String, String> e : users.entrySet()) {
                String salt = salts.get(e.getKey());
                if (salt != null) {
                    lines.add(e.getKey() + ":" + salt + ":" + e.getValue());
                } else {
                    lines.add(e.getKey() + ":" + e.getValue());
                }
            }
            Path tmp = DATA_DIR.resolve("users.dat.tmp");
            Files.write(tmp, lines, StandardCharsets.UTF_8);
            Files.move(tmp, USERS_FILE, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            System.err.println("[UserManager] 保存用户数据失败: " + e.getMessage());
        }
      }
    }

    private static String generateSalt() {
        byte[] b = new byte[16];
        RNG.nextBytes(b);
        StringBuilder sb = new StringBuilder(32);
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    /** PBKDF2WithHmacSHA256 — v2.1.1 默认算法 */
    private static String hashPdkdf2(String password, String hexSalt) {
        try {
            byte[] salt = hexToBytes(hexSalt);
            KeySpec spec = new PBEKeySpec(password.toCharArray(), salt,
                    PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH);
            SecretKeyFactory factory = SecretKeyFactory.getInstance(PBKDF2_ALGO);
            byte[] hash = factory.generateSecret(spec).getEncoded();
            return PREFIX_PBKDF2 + bytesToHex(hash);
        } catch (Exception e) {
            throw new RuntimeException("PBKDF2 hash failed", e);
        }
    }

    /** 旧格式：SHA-256(salt + password)，v1.x 兼容（带 "1:" 前缀） */
    private static String hashSaltedSha256(String password, String hexSalt) {
        return PREFIX_SALTED_SHA + hashSaltedSha256Raw(password, hexSalt);
    }

    /** 旧格式：SHA-256(salt + password)，无前缀（用于验证遗留数据） */
    private static String hashSaltedSha256Raw(String password, String hexSalt) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            md.update(hexToBytes(hexSalt));
            byte[] digest = md.digest(password.getBytes(StandardCharsets.UTF_8));
            return bytesToHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }

    /** 最旧格式：无盐 SHA-256(password)，v1.0 兼容 */
    private static String hashLegacySha256(String password) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(password.getBytes(StandardCharsets.UTF_8));
            return bytesToHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static byte[] hexToBytes(String hex) {
        int len = hex.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            data[i / 2] = (byte) ((Character.digit(hex.charAt(i), 16) << 4)
                    + Character.digit(hex.charAt(i + 1), 16));
        }
        return data;
    }
}
