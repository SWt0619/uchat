package com.chatroom2.controller;

import com.chatroom2.model.AuthTokenStore;
import org.springframework.core.io.InputStreamResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.*;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/files")
public class FileController {

    private static final Path FILES_DIR = Paths.get(System.getProperty("user.dir"), "data", "users", "shared", "files");
    private static final long MAX_FILE_SIZE = 100L * 1024 * 1024;
    private static final long MAX_IMAGE_SIZE = 10L * 1024 * 1024;

    // 聊天室存储配额（用户 2026-09-25 要求：超过 50GB 禁止上传并提示联系管理员）
    // ⚠️ 必须由 Spring 注入：new 出来的实例拿不到 @Value 配置值（上限/管理员昵称会一直是默认值）
    private final com.chatroom2.model.StorageQuota quota;

    public FileController(com.chatroom2.model.StorageQuota quota) {
        this.quota = quota;
    }

    @PostMapping("/upload")
    public ResponseEntity<Map<String, Object>> upload(@RequestParam(value = "file", required = false) MultipartFile file,
                                                      @RequestParam(required = false) String token,
                                                      @RequestParam(required = false) String nickname) {
        Map<String, Object> result = new HashMap<>();
        // 鉴权（2026-09-25 修：早期版本这里没有校验，未登录就能上传 ⇒ 可灌满磁盘把服务拖死）
        if (!AuthTokenStore.getInstance().validate(nickname, token)) {
            result.put("error", "未登录或凭证过期");
            return ResponseEntity.status(403).body(result);
        }
        // 存储配额：超过上限直接拒绝，并提示联系管理员（用户 2026-09-25 要求）
        if (quota.isFull()) {
            result.put("error", quota.fullMessage());
            result.put("quotaFull", true);
            return ResponseEntity.status(507).body(result);
        }
        if (file == null) {           // 畸形请求（没有 file 部件）⇒ 400，而不是 500 + 堆栈
            result.put("error", "缺少文件");
            return ResponseEntity.badRequest().body(result);
        }
        try {
            if (file.isEmpty()) {
                result.put("error", "文件为空");
                return ResponseEntity.badRequest().body(result);
            }

            String filename = sanitize(file.getOriginalFilename());
            if (filename == null) {
                result.put("error", "文件名无效");
                return ResponseEntity.badRequest().body(result);
            }

            long size = file.getSize();
            String contentType = file.getContentType();
            boolean isImage = contentType != null && contentType.startsWith("image/");

            if (isImage && size > MAX_IMAGE_SIZE) {
                result.put("error", "图片不能超过10MB");
                return ResponseEntity.badRequest().body(result);
            }
            if (size > MAX_FILE_SIZE) {
                result.put("error", "文件不能超过100MB");
                return ResponseEntity.badRequest().body(result);
            }

            Files.createDirectories(FILES_DIR);
            // 重名时追加时间戳，避免覆盖他人文件
            Path target = FILES_DIR.resolve(filename);
            if (Files.exists(target)) {
                int dot = filename.lastIndexOf('.');
                String base = dot > 0 ? filename.substring(0, dot) : filename;
                String ext = dot > 0 ? filename.substring(dot) : "";
                target = FILES_DIR.resolve(base + "_" + System.currentTimeMillis() + ext);
            }
            Path tmp = FILES_DIR.resolve(target.getFileName() + "." + System.currentTimeMillis() + ".tmp");
            file.transferTo(tmp.toFile());
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            filename = target.getFileName().toString();
            quota.invalidate();

            result.put("name", filename);
            result.put("size", size);
            // 2026-09-25 v2.9.8：原来只有 image/file，视频会被标成 file。
            // 现在按扩展名细分 image / video / audio / file，前端可直接据此选播放器。
            result.put("type", kindOf(filename, contentType));
            return ResponseEntity.ok(result);
        } catch (IOException e) {
            result.put("error", "上传失败: " + e.getMessage());
            return ResponseEntity.internalServerError().body(result);
        }
    }

    /** 只在共享目录内解析文件名；任何试图跳出目录的写法（..\ 、..\、绝对路径）一律拒绝 */
    private static Path safeResolve(String filename) {
        if (filename == null || filename.isEmpty()) return null;
        try {
            Path p = FILES_DIR.resolve(filename).normalize();
            if (!p.startsWith(FILES_DIR.normalize())) return null;   // 跳出目录 ⇒ 拒绝
            return p;
        } catch (Exception e) {
            return null;
        }
    }

    /** 上传超过服务端上限（multipart 解析阶段就抛）⇒ 给 413 + 明确文案，别 500 刷堆栈 */
    @org.springframework.web.bind.annotation.ExceptionHandler(org.springframework.web.multipart.MaxUploadSizeExceededException.class)
    public ResponseEntity<Map<String, Object>> tooLarge(Exception e) {
        Map<String, Object> result = new HashMap<>();
        result.put("error", "文件过大（服务端上限 100MB）");
        return ResponseEntity.status(413).body(result);
    }

    /** multipart 解析失败/缺部件 ⇒ 400 */
    @org.springframework.web.bind.annotation.ExceptionHandler(org.springframework.web.multipart.MultipartException.class)
    public ResponseEntity<Map<String, Object>> badMultipart(Exception e) {
        Map<String, Object> result = new HashMap<>();
        result.put("error", "上传格式不正确");
        return ResponseEntity.badRequest().body(result);
    }

    /** 按扩展名（辅以 MIME）判断类型；浏览器能播的容器由前端再细分 */
    private static String kindOf(String filename, String contentType) {
        String n = filename == null ? "" : filename.toLowerCase();
        int dot = n.lastIndexOf('.');
        String ext = dot >= 0 ? n.substring(dot + 1) : "";
        if (contentType != null && contentType.startsWith("image/")) return "image";
        if (java.util.Arrays.asList("png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "avif").contains(ext)) return "image";
        if (java.util.Arrays.asList("mp4", "webm", "m4v", "ogv", "mov", "avi", "mkv", "wmv", "flv", "mpg", "mpeg", "3gp", "rmvb").contains(ext)) return "video";
        if (java.util.Arrays.asList("mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba", "wma").contains(ext)) return "audio";
        if (contentType != null && contentType.startsWith("video/")) return "video";
        if (contentType != null && contentType.startsWith("audio/")) return "audio";
        return "file";
    }

    private String sanitize(String name) {
        if (name == null || name.isEmpty()) return null;
        String n = Paths.get(name).getFileName().toString();
        if (n.isEmpty() || ".".equals(n) || "..".equals(n)) return null;
        for (int i = 0; i < n.length(); i++) {
            if (Character.isISOControl(n.charAt(i))) return null;
        }
        return n;
    }

    @GetMapping("/list")
    public ResponseEntity<List<Map<String, Object>>> listFiles(@RequestParam(required = false) String token,
                                                               @RequestParam(required = false) String nickname) {
        // 鉴权（早期版本无校验 ⇒ 未登录可枚举全部共享文件）
        if (!AuthTokenStore.getInstance().validate(nickname, token)) {
            return ResponseEntity.status(403).build();
        }
        try {
            Files.createDirectories(FILES_DIR);
            // ★ Files.list() 必须用 try-with-resources 关掉：
            //   早期版本直接 return 这个流 ⇒ DirectoryStream 句柄不释放，
            //   实测 300 次调用句柄 +296（≈1/次），持续调用会把句柄耗光、新连接全部失败。
            List<Map<String, Object>> list = new ArrayList<>();
            try (java.util.stream.Stream<Path> s = Files.list(FILES_DIR)) {
                for (Path p : (Iterable<Path>) s::iterator) {
                    if (!Files.isRegularFile(p)) continue;
                    Map<String, Object> info = new HashMap<>();
                    info.put("name", p.getFileName().toString());
                    try {
                        info.put("size", Files.size(p));
                    } catch (IOException e) {
                        info.put("size", 0);
                    }
                    list.add(info);
                }
            }
            return ResponseEntity.ok(list);
        } catch (IOException e) {
            return ResponseEntity.ok(Collections.emptyList());
        }
    }

    @GetMapping("/download/{filename}")
    public ResponseEntity<Void> download(@PathVariable String filename,
                                         @RequestParam(required = false) String token,
                                         @RequestParam(required = false) String nickname,
                                         javax.servlet.http.HttpServletRequest req,
                                         javax.servlet.http.HttpServletResponse resp) {
        if (!AuthTokenStore.getInstance().validate(nickname, token)) {
            return ResponseEntity.status(403).build();
        }
        Path file = safeResolve(filename);      // 防穿越（normalize + 前缀校验）
        if (file == null || !Files.exists(file)) {
            return ResponseEntity.notFound().build();
        }
        try {
            streamFile(file, false, req, resp);
        } catch (IOException e) {
            return ResponseEntity.internalServerError().build();
        }
        return null;   // 已直接写出响应
    }

    @GetMapping("/preview/{filename}")
    public ResponseEntity<Void> preview(@PathVariable String filename,
                                        @RequestParam(required = false) String token,
                                        @RequestParam(required = false) String nickname,
                                        javax.servlet.http.HttpServletRequest req,
                                        javax.servlet.http.HttpServletResponse resp) {
        if (!AuthTokenStore.getInstance().validate(nickname, token)) {
            return ResponseEntity.status(403).build();
        }
        Path file = safeResolve(filename);
        if (file == null || !Files.exists(file)) {
            return ResponseEntity.notFound().build();
        }
        try {
            streamFile(file, true, req, resp);
        } catch (IOException e) {
            return ResponseEntity.internalServerError().build();
        }
        return null;   // 已直接写出响应
    }

    /**
     * 带 HTTP Range 的文件输出（2026-09-25 v2.9.7）：
     * 聊天室的音频/视频要在页面上直接播放并可拖动进度，就必须支持分段请求 ——
     * 否则 <video>/<audio> 无法 seek，某些浏览器干脆不播。
     * 支持单区间 `Range: bytes=start-end`（start 可省、end 可省），返回 206 + Content-Range。
     */
    private void streamFile(Path file, boolean inline, javax.servlet.http.HttpServletRequest req,
                            javax.servlet.http.HttpServletResponse resp) throws IOException {
        long size = Files.size(file);
        String mimeType = Files.probeContentType(file);
        if (mimeType == null) mimeType = "application/octet-stream";
        resp.setContentType(mimeType);
        resp.setHeader("Accept-Ranges", "bytes");
        String disp = inline ? "inline"
                : "attachment; filename*=UTF-8''" + URLEncoder.encode(file.getFileName().toString(), StandardCharsets.UTF_8).replace("+", "%20");
        resp.setHeader(HttpHeaders.CONTENT_DISPOSITION, disp);

        long start = 0, end = size - 1;
        boolean partial = false;
        String range = req.getHeader("Range");
        if (range != null && range.startsWith("bytes=")) {
            try {
                String spec = range.substring("bytes=".length()).split(",")[0].trim();
                int dash = spec.indexOf('-');
                if (dash >= 0) {
                    String s1 = spec.substring(0, dash).trim();
                    String s2 = spec.substring(dash + 1).trim();
                    if (!s1.isEmpty()) start = Long.parseLong(s1);
                    if (!s2.isEmpty()) end = Long.parseLong(s2);
                    if (start < 0) start = 0;
                    if (end >= size) end = size - 1;
                    if (start > end) { resp.setStatus(416); resp.setHeader("Content-Range", "bytes */" + size); return; }
                    partial = true;
                }
            } catch (Exception ignored) { start = 0; end = size - 1; partial = false; }
        }
        long len = end - start + 1;
        resp.setStatus(partial ? 206 : 200);
        resp.setHeader("Content-Length", String.valueOf(len));
        if (partial) resp.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + size);
        if ("HEAD".equalsIgnoreCase(req.getMethod())) return;   // HEAD 只要头

        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(file.toFile(), "r")) {
            raf.seek(start);
            java.io.OutputStream os = resp.getOutputStream();
            byte[] buf = new byte[64 * 1024];
            long remaining = len;
            while (remaining > 0) {
                int n = raf.read(buf, 0, (int) Math.min(buf.length, remaining));
                if (n <= 0) break;
                os.write(buf, 0, n);
                remaining -= n;
            }
            os.flush();
        } catch (java.io.IOException e) {
            String m = String.valueOf(e.getMessage());
            if (m.contains("Broken pipe") || m.contains("Connection reset")) return;   // 同上
            throw e;
        }
    }

    // Song name lookup — parses outchain player page title
    @GetMapping("/song-name/{id}")
    public ResponseEntity<Map<String,String>> songName(@PathVariable String id) {
        Map<String,String> result = new HashMap<>();
        try {
            java.net.URL url = new java.net.URL("https://music.163.com/outchain/player?type=2&id=" + id);
            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
            conn.setRequestProperty("Referer", "https://music.163.com/");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            java.io.InputStream is = conn.getInputStream();
            // 限量读取（早期版本 readAllBytes 无上限，远端返回巨大页面会吃内存）
            String html = new String(is.readNBytes(256 * 1024), java.nio.charset.StandardCharsets.UTF_8);
            is.close();
            // Extract title: <title>Song Name - Artist - 网易云音乐</title>
            int ti = html.indexOf("<title>");
            int te = html.indexOf("</title>", ti);
            if (ti >= 0 && te > ti) {
                String title = html.substring(ti + 7, te).trim();
                if (title.contains(" - ")) {
                    String[] parts = title.split(" - ");
                    if (parts.length >= 2) {
                        result.put("name", parts[0].trim());
                        result.put("artist", parts[1].trim());
                        result.put("ok", "true");
                    }
                }
            }
        } catch (Exception ignored) {}
        if (!"true".equals(result.get("ok"))) result.put("ok", "false");
        return ResponseEntity.ok(result);
    }

    // URL 预览：抓取 OG 标签（仅允许公网 HTTP/HTTPS，防 SSRF）
    @GetMapping("/preview")
    public Map<String, String> previewUrl(@RequestParam String url) {
        Map<String, String> result = new HashMap<>();
        result.put("url", url);
        try {
            java.net.URI uri = new java.net.URI(url);
            // 仅允许 http/https
            String scheme = uri.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
                return result;
            }
            String host = uri.getHost();
            if (host == null) return result;
            // 禁止内网/本地地址
            java.net.InetAddress addr = java.net.InetAddress.getByName(host);
            if (addr.isLoopbackAddress() || addr.isSiteLocalAddress() || addr.isLinkLocalAddress()) {
                return result;
            }
            // 额外检查：禁止 IPv4 私有/保留范围
            byte[] octets = addr.getAddress();
            if (octets != null && octets.length == 4) {
                int first = octets[0] & 0xFF;
                int second = octets[1] & 0xFF;
                if (first == 10) return result;
                if (first == 172 && second >= 16 && second <= 31) return result;
                if (first == 192 && second == 168) return result;
                if (first == 127) return result;
                if (first == 0) return result;
                // 169.254.x.x (link-local, cloud metadata)
                if (first == 169 && second == 254) return result;
            }
            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) uri.toURL().openConnection();
            conn.setRequestProperty("User-Agent", "Uchat/1.0 (WebChat; +https://github.com)");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setInstanceFollowRedirects(false); // 禁止重定向绕过检查
            // 只读前 64KB，够取 meta 标签
            byte[] bytes;
            try (InputStream is = conn.getInputStream()) {
                bytes = is.readNBytes(65536);
            }
            String html = new String(bytes, StandardCharsets.UTF_8);
            result.put("title", extractMeta(html, "og:title", "title"));
            result.put("description", extractMeta(html, "og:description", "description"));
            result.put("image", extractMeta(html, "og:image", null));
            conn.disconnect();
        } catch (Exception ignored) {}
        return result;
    }

    private String extractMeta(String html, String ogProp, String fallbackTag) {
        // 查找 og: 标签
        String pattern = "<meta[^>]+property=[\"']" + ogProp + "[\"'][^>]+content=[\"']([^\"']+)[\"']";
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(pattern, java.util.regex.Pattern.CASE_INSENSITIVE).matcher(html);
        if (m.find()) return m.group(1);
        // fallback: 查找 <title>
        if ("title".equals(fallbackTag)) {
            m = java.util.regex.Pattern.compile("<title>([^<]+)</title>", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(html);
            if (m.find()) return m.group(1).trim();
        }
        return "";
    }
}
