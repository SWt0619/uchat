package com.chatroom2;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

@SpringBootApplication
public class ChatRoomApplication {

    private static final Path LOG_DIR = Paths.get(System.getProperty("user.dir"), "logs");

    public static void main(String[] args) {
        setupLogFile();
        SpringApplication.run(ChatRoomApplication.class, args);
    }

    /** 将 System.out 和 System.err 同时输出到控制台和 logs/ 下的 UTF-8 时间戳文件 */
    private static void setupLogFile() {
        try {
            Files.createDirectories(LOG_DIR);
            String ts = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss"));
            Path logFile = LOG_DIR.resolve("server_" + ts + ".txt");
            // 文件用 UTF-8 写入，控制台保持系统默认编码
            OutputStreamWriter fileWriter = new OutputStreamWriter(
                    new FileOutputStream(logFile.toFile(), true), StandardCharsets.UTF_8);
            System.setOut(createTeePrintStream(System.out, fileWriter));
            System.setErr(createTeePrintStream(System.err, fileWriter));
            System.out.println("日志文件: " + logFile.toAbsolutePath());
        } catch (IOException e) {
            System.err.println("无法创建日志文件: " + e.getMessage());
        }
    }

    private static java.nio.charset.Charset consoleCharset = java.nio.charset.Charset.defaultCharset();

    private static PrintStream createTeePrintStream(PrintStream console, Writer fileWriter) {
        return new PrintStream(console, true) {
            @Override
            public void write(int b) {
                console.write(b);
                try { fileWriter.write(b); fileWriter.flush(); } catch (IOException ignored) {}
            }
            @Override
            public void write(byte[] buf, int off, int len) {
                console.write(buf, off, len);
                try {
                    // 控制台编码 → UTF-8 写入文件
                    String s = new String(buf, off, len, consoleCharset);
                    fileWriter.write(s);
                    fileWriter.flush();
                } catch (IOException ignored) {}
            }
            @Override
            public void flush() { console.flush(); }
        };
    }
}
