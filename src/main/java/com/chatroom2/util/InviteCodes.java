package com.chatroom2.util;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * 注册码校验工具。
 *
 * <p>要点：
 * <ul>
 *   <li>注册码不再写死在代码里，由配置（环境变量）提供；</li>
 *   <li>未配置时一律拒绝（fail-closed），避免"忘记配置"变成"任何人都能注册"；</li>
 *   <li>用 {@link MessageDigest#isEqual} 做常数时间比较，避免逐字符比较带来的时序差异。</li>
 * </ul>
 */
public final class InviteCodes {

    private InviteCodes() {
    }

    public static boolean matches(String configured, String provided) {
        if (configured == null || configured.trim().isEmpty()) {
            return false;                       // 未配置 = 关闭注册
        }
        if (provided == null) {
            return false;
        }
        byte[] a = configured.trim().getBytes(StandardCharsets.UTF_8);
        byte[] b = provided.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(a, b);
    }
}
