// In-memory voice rooms. Audio never passes through the server: it only groups
// participants and relays connection handshakes between their browsers.
export const VOICE_ROOM_LIMIT = 6;

const peerOf = (id, entry, self) => ({
  id,
  name: entry.meta.name,
  class_key: entry.meta.class_key ?? null,
  avatar_updated_at: entry.meta.avatar_updated_at ?? null,
  muted: entry.muted === true,
  self,
});

export function createVoiceRooms({ limit = VOICE_ROOM_LIMIT } = {}) {
  const rooms = new Map();

  const roomOf = (channelId) => {
    if (!rooms.has(channelId)) rooms.set(channelId, new Map());
    return rooms.get(channelId);
  };

  const broadcast = (room, exceptId, message) => {
    for (const [id, entry] of room) {
      if (id === exceptId) continue;
      try {
        entry.send(message);
      } catch {
        // A dead socket is removed by its own close handler.
      }
    }
  };

  return {
    limit,
    join(channelId, userId, entry) {
      const room = roomOf(channelId);
      const replaced = room.get(userId) ?? null;
      if (!replaced && room.size >= limit) return { ok: false, code: 'voice_full' };
      room.set(userId, entry);
      const self = peerOf(userId, entry, true);
      const peers = [...room].filter(([id]) => id !== userId).map(([id, other]) => peerOf(id, other, false));
      if (replaced) {
        try {
          replaced.close(4004, 'replaced');
        } catch {
          // The old socket may already be gone.
        }
      } else {
        broadcast(room, userId, { type: 'peer-joined', peer: peerOf(userId, entry, false) });
      }
      return { ok: true, self, peers, replaced: replaced !== null };
    },

    leave(channelId, userId, entry = null) {
      const room = space(channelId);
      if (!room) return false;
      const current = room.get(userId);
      if (!current || (entry && current !== entry)) return false;
      room.delete(userId);
      if (room.size === 0) rooms.delete(channelId);
      else broadcast(room, userId, { type: 'peer-left', peer_id: userId });
      return true;
    },

    signal(channelId, fromId, toId, data) {
      const room = space(channelId);
      if (!room || !room.has(fromId)) return false;
      const target = room.get(toId);
      if (!target) return false;
      try {
        target.send({ type: 'signal', from: fromId, data });
        return true;
      } catch {
        return false;
      }
    },

    setMuted(channelId, userId, muted) {
      const room = space(channelId);
      const entry = room?.get(userId);
      if (!entry) return false;
      entry.muted = muted === true;
      broadcast(room, null, { type: 'peer-updated', peer: peerOf(userId, entry, false) });
      return true;
    },

    size(channelId) {
      return space(channelId)?.size ?? 0;
    },
  };

  function space(channelId) {
    return rooms.get(channelId) ?? null;
  }
}
