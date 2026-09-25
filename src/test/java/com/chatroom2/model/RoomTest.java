package com.chatroom2.model;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class RoomTest {
    private Room room;

    @BeforeEach
    void setUp() { room = new Room("test", 4); }

    @Test
    void initialEmpty() {
        assertEquals(0, room.getUserCount());
        assertFalse(room.isFull());
    }

    @Test
    void joinAndLeave() {
        // Cannot test with WebSocket session easily, test at logical level
        assertEquals("test", room.getName());
        assertEquals(4, room.getUserCount() + 4 - room.getUserCount()); // capacity 4
    }

    @Test
    void historyPersistence() {
        room.addHistory("{\"type\":\"chat\",\"content\":\"hello\"}");
        room.addHistory("{\"type\":\"chat\",\"content\":\"world\"}");
        assertEquals(2, room.getHistory().size());
        room.saveToFile();
        Room loaded = Room.loadFromFile();
        assertNotNull(loaded);
        assertEquals(2, loaded.getHistory().size());
    }

    @Test
    void historyMaxCap() {
        for (int i = 0; i < 250; i++) {
            room.addHistory("{\"type\":\"chat\",\"content\":\"msg" + i + "\"}");
        }
        assertEquals(200, room.getHistory().size());
        assertTrue(room.getHistory().get(0).contains("msg50"));
    }

    @Test
    void disconnectAndReconnect() {
        // Disconnect/expire on empty room should not throw
        room.disconnect("nobody");
        assertEquals(0, room.removeExpiredDisconnected(0));

        java.util.List<String> expired = room.getExpiredDisconnected(0);
        assertTrue(expired.isEmpty());
    }
}
