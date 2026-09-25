package com.chatroom2.controller;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * TURN 凭据生成的回归测试。
 *
 * <p>coturn 的 {@code use-auth-secret}（REST API）机制的凭据约定是：
 * {@code base64(HMAC-SHA1(secret, username))}，其中
 * {@code username = "<过期时间戳>:<标识>"}。这里的期望值是独立算出来的
 * （Python {@code hmac.new(secret, user, hashlib.sha1)} → base64），
 * 用来锁死算法与编码，避免以后改动悄悄破坏 TURN 鉴权。</p>
 */
class TurnControllerTest {

    /** 已知向量 1：secret=secret123, username=1700000000:uchat */
    private static final String SECRET_A = "secret123";
    private static final String USER_A = "1700000000:uchat";
    private static final String EXPECT_A = "QHOOgysqVFR544zWvrfbpOcmW7w=";

    /** 已知向量 2：换一个 secret，确认确实参与了运算 */
    private static final String SECRET_B = "s3cr3t";
    private static final String EXPECT_B = "0jKzzVSh0IgWd1YTbOXdo4pOIQ0=";

    @Test
    void credentialMatchesKnownVector() {
        assertEquals(EXPECT_A, TurnController.buildCredential(SECRET_A, USER_A));
    }

    @Test
    void credentialChangesWithSecret() {
        assertEquals(EXPECT_B, TurnController.buildCredential(SECRET_B, USER_A));
        assertNotEquals(TurnController.buildCredential(SECRET_A, USER_A),
                        TurnController.buildCredential(SECRET_B, USER_A));
    }

    @Test
    void credentialIsDeterministicAndBase64() {
        String one = TurnController.buildCredential(SECRET_A, USER_A);
        String two = TurnController.buildCredential(SECRET_A, USER_A);
        assertEquals(one, two, "同输入必须得到同凭据（coturn 校验依赖这一点）");
        assertNotNull(one);
        // HMAC-SHA1 = 20 字节 → base64 定长 28 字符（含 '=' 补位）
        assertEquals(28, one.length());
        assertTrue(one.matches("[A-Za-z0-9+/]+={0,2}"), "必须是合法 base64");
    }

    @Test
    void credentialChangesWithUsername() {
        assertNotEquals(TurnController.buildCredential(SECRET_A, "1700000000:uchat"),
                        TurnController.buildCredential(SECRET_A, "1700000999:uchat"));
    }
}
