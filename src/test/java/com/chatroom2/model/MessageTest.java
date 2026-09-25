package com.chatroom2.model;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class MessageTest {

    @Test
    void chatMessageJsonRoundtrip() {
        Message m = Message.chat("alice", "hello world");
        String json = m.toJson();
        assertTrue(json.contains("\"type\":\"chat\""));
        assertTrue(json.contains("\"nickname\":\"alice\""));
        Message parsed = Message.fromJson(json);
        assertEquals("chat", parsed.type);
        assertEquals("alice", parsed.nickname);
        assertEquals("hello world", parsed.content);
    }

    @Test
    void authMessageJsonRoundtrip() {
        Message m = Message.auth("login", "bob", "secretpw");
        String json = m.toJson();
        Message parsed = Message.fromJson(json);
        assertEquals("auth", parsed.type);
        assertEquals("login", parsed.subtype);
        assertEquals("bob", parsed.nickname);
    }

    @Test
    void systemMessage() {
        Message m = Message.system("server shutting down");
        assertEquals("system", m.type);
        assertEquals("server shutting down", m.content);
    }

    @Test
    void userlistWithOffline() {
        Message m = Message.userlist(
            java.util.List.of("alice", "bob"),
            java.util.List.of("charlie"),
            java.util.Map.of("alice", "学习中")
        );
        assertEquals(2, m.users.size());
        assertEquals(1, m.offline.size());
        assertEquals("学习中", m.statuses.get("alice"));
    }

    @Test
    void msgIdFormat() {
        Message m = Message.chat("test", "msg");
        assertNotNull(m.msgId);
        assertTrue(m.msgId.contains("_"));
    }
}
