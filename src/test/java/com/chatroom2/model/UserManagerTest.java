package com.chatroom2.model;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class UserManagerTest {
    private UserManager um;

    @BeforeEach
    void setUp() {
        // 清掉上一次运行残留的持久化文件，保证用例自身可重复执行。
        // UserManager 把 users.dat 写在 user.dir\data 下（surefire 的工作目录被指到 target\），
        // 残留文件会让 register("alice") 返回 false ⇒ 表现为"不带 clean 连跑第二次必挂 3 个用例"。
        deleteDataFile("users.dat");
        deleteDataFile("users.dat.tmp");
        um = new UserManager();
    }

    /** 删除 user.dir\data\<name>；不存在就跳过（删不掉的异常留给后续断言去暴露，不在这里掩盖） */
    private static void deleteDataFile(String name) {
        try {
            java.nio.file.Files.deleteIfExists(
                    java.nio.file.Paths.get(System.getProperty("user.dir"), "data", name));
        } catch (Exception ignored) {
            // 忽略：删不掉时用例会以自身断言失败的方式暴露
        }
    }

    @Test
    void registerNewUser() {
        assertTrue(um.register("alice", "pass123"));
        assertTrue(um.isRegistered("alice"));
    }

    @Test
    void registerDuplicate() {
        assertTrue(um.register("bob", "pass123"));
        assertFalse(um.register("bob", "other456"));
    }

    @Test
    void registerShortPassword() {
        assertFalse(um.register("bob", "12345"));
    }

    @Test
    void registerLongPassword() {
        assertFalse(um.register("bob", "1234567890123456789"));
    }

    @Test
    void registerNonAlphanumeric() {
        // ⚠️ 2026-09-23 修正：原断言 assertFalse 与生产行为不符，且过去是"靠昵称撞车"意外通过的
        //（同一轮里更早的用例已注册过 bob ⇒ register 因"用户已存在"返回 false，掩盖了真实行为）。
        // 事实三处不一致：
        //   · UserManager.register 的注释写着「v2.1.1: 移除 [a-zA-Z0-9] 限制，允许特殊字符」⇒ 模型层接受；
        //   · ChatWebSocketHandler.handleAuth 的 register 分支仍有 password.matches("[a-zA-Z0-9]+") ⇒ WS 层拒绝；
        //   · CHANGELOG v2.1.1 写「密码字符集开放，允许任意字符」⇒ 与 WS 层矛盾。
        // 该不一致已记入 prompts/_待协调.md 待用户拍板；此处只断言模型层的真实行为，不改生产代码。
        assertTrue(um.register("bob", "pass!!@"));
        assertTrue(um.isRegistered("bob"));
    }

    @Test
    void authenticateSuccess() {
        um.register("charlie", "abc1234");
        assertTrue(um.authenticate("charlie", "abc1234"));
    }

    @Test
    void authenticateWrongPassword() {
        um.register("dave", "abc1234");
        assertFalse(um.authenticate("dave", "wrongpw"));
    }

    @Test
    void authenticateNonexistent() {
        assertFalse(um.authenticate("nobody", "abc1234"));
    }

    @Test
    void changePassword() {
        um.register("eve", "oldpass1");
        assertTrue(um.changePassword("eve", "oldpass1", "newpass1"));
        assertTrue(um.authenticate("eve", "newpass1"));
        assertFalse(um.authenticate("eve", "oldpass1"));
    }

    @Test
    void changePasswordWrongOld() {
        um.register("frank", "correct1");
        assertFalse(um.changePassword("frank", "wrongold", "newpass1"));
    }
}
