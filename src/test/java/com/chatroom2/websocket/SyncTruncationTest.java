package com.chatroom2.websocket;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 断线补齐的「截断」判定 —— 纯单元测试（不起 Spring、不连 WS，毫秒级）。
 *
 * <p>盯的是一个真踩到的 bug：旧实现 {@code truncated = !hasTimed || since < oldest} 把
 * <b>空缓冲区</b>也判成截断，于是"清空聊天记录之后"，任何带着旧 {@code since} 重连的客户端
 * 都会收到 {@code truncated=true}，前端状态条冒出"更早的消息已无法恢复"（其实一条都没丢）。
 * 2026-09-24 起改由 {@link ChatWebSocketHandler#isTruncated} 统一判定。</p>
 */
class SyncTruncationTest {

    /** 缓冲区为空（= 刚清空聊天记录 / 全新服务）：无论 since 多老，都不是截断。 */
    @Test
    void emptyBufferIsNeverTruncated() {
        assertFalse(ChatWebSocketHandler.isTruncated(false, 1L, Long.MAX_VALUE, true),
                "空缓冲区 + 很老的 since：没有任何消息可丢 ⇒ 不应报截断");
        assertFalse(ChatWebSocketHandler.isTruncated(true, 1L, 123L, true),
                "空缓冲区（占位参数自相矛盾也要以 bufferEmpty 为准）⇒ 不应报截断");
    }

    /** 缓冲区非空、且有可判定时间戳：since 早于最早一条才算截断。 */
    @Test
    void timedBufferTruncatesOnlyWhenSinceIsOlderThanOldest() {
        assertTrue(ChatWebSocketHandler.isTruncated(true, 100L, 200L, false),
                "since(100) 早于缓冲区最早一条(200) ⇒ 缺口可能已被淘汰，应报截断");
        assertFalse(ChatWebSocketHandler.isTruncated(true, 200L, 200L, false),
                "since 正好等于最早一条 ⇒ 边界为严格大于，不算截断");
        assertFalse(ChatWebSocketHandler.isTruncated(true, 500L, 200L, false),
                "since 晚于缓冲区最早一条 ⇒ 没漏消息，不报截断");
    }

    /** 缓冲区非空、但一条时间戳都判不了（全是系统消息）：保守标记截断（保持 v2.5.0 行为）。 */
    @Test
    void untimedNonEmptyBufferIsTruncated() {
        assertTrue(ChatWebSocketHandler.isTruncated(false, 1L, Long.MAX_VALUE, false),
                "有消息但判不了先后 ⇒ 保守报截断");
    }
}
