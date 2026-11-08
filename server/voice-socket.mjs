// WebSocket signaling for in-site voice. Only connection handshakes travel here;
// the audio itself is peer-to-peer between browsers.
import { WebSocketServer } from 'ws';
import { validateSession } from '../functions/sessions.mjs';
import { rows } from '../functions/http.mjs';
import { isUuid } from '../functions/validate.mjs';
import { createVoiceRooms } from './voice-rooms.mjs';

const SOCKET_PATH = '/api/voice/socket';
const MAX_PAYLOAD = 64 * 1024;
const MESSAGE_WINDOW_MS = 10_000;
const MESSAGE_LIMIT = 160;
const HEARTBEAT_MS = 30_000;
const JOIN_TIMEOUT_MS = 15_000;
const MAX_SDP_CHARS = 24 * 1024;

const DEFAULT_STUN = [
  'stun:stun.sipnet.ru:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

// A TURN relay can be added later through VOICE_ICE_SERVERS without code changes.
export function iceServers(env = process.env) {
  const raw = String(env.VOICE_ICE_SERVERS ?? '').trim();
  if (!raw) return [{ urls: DEFAULT_STUN }];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [{ urls: DEFAULT_STUN }];
  }
  if (!Array.isArray(parsed)) return [{ urls: DEFAULT_STUN }];
  const servers = [];
  for (const item of parsed) {
    const urls = (Array.isArray(item?.urls) ? item.urls : [item?.urls])
      .filter((url) => typeof url === 'string' && /^(stun|turn|turns):[^/\s]+$/.test(url));
    if (urls.length === 0) continue;
    const server = { urls };
    if (typeof item.username === 'string' && typeof item.credential === 'string') {
      server.username = item.username;
      server.credential = item.credential;
    }
    servers.push(server);
  }
  return servers.length > 0 ? servers : [{ urls: DEFAULT_STUN }];
}

function originAllowed(origin, configured) {
  if (!configured || origin !== configured) return false;
  try {
    const url = new URL(configured);
    return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

const isDescription = (value) => value
  && (value.type === 'offer' || value.type === 'answer')
  && typeof value.sdp === 'string'
  && value.sdp.length > 0
  && value.sdp.length <= MAX_SDP_CHARS;

const isCandidate = (value) => value
  && typeof value.candidate === 'string'
  && value.candidate.length <= 2048
  && (value.sdpMid === null || value.sdpMid === undefined || typeof value.sdpMid === 'string')
  && (value.sdpMLineIndex === null || value.sdpMLineIndex === undefined || Number.isInteger(value.sdpMLineIndex));

function validSignalData(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.description !== undefined && data.candidate !== undefined) return false;
  if (data.description !== undefined) return isDescription(data.description);
  return isCandidate(data.candidate);
}

function requestFor(request) {
  return new Request('https://voice.invalid/', { headers: { cookie: request.headers.cookie ?? '' } });
}

export function attachVoiceSocket(server, { db, origin, rooms = createVoiceRooms() }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://internal').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== SOCKET_PATH) {
      socket.destroy();
      return;
    }
    if (!originAllowed(request.headers.origin, origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => onConnection(ws, request));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isVoiceAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isVoiceAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  function onConnection(ws, request) {
    const conn = {
      channelId: null,
      userId: null,
      entry: null,
      joined: false,
      joining: false,
      windowStart: Date.now(),
      messages: 0,
      auth: null,
    };
    ws.isVoiceAlive = true;

    const send = (message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const closeWith = (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    };
    const joinTimer = setTimeout(() => {
      if (!conn.joined) send({ type: 'error', code: 'join_timeout' });
      if (!conn.joined) closeWith(4008, 'join timeout');
    }, JOIN_TIMEOUT_MS);
    joinTimer.unref?.();

    async function join(message) {
      if (conn.joining || conn.joined) {
        send({ type: 'error', code: 'already_joined' });
        return;
      }
      conn.joining = true;
      try {
        await enterRoom(message);
      } finally {
        conn.joining = false;
      }
    }

    async function enterRoom(message) {
      const channelId = message.channel_id;
      if (!isUuid(channelId)) {
        send({ type: 'error', code: 'channel_not_found' });
        return;
      }
      try {
        conn.auth ??= await validateSession(db, requestFor(request));
      } catch {
        closeWith(4008, 'auth failed');
        return;
      }
      if (conn.auth.state !== 'valid') {
        send({ type: 'error', code: 'login_required' });
        closeWith(4001, 'login required');
        return;
      }
      const user = rows(await db.from('users')
        .select('id,username,nickname,class_key,avatar_updated_at')
        .eq('id', conn.auth.session.userId).limit(1))[0];
      if (!user) {
        closeWith(4001, 'login required');
        return;
      }
      const channel = rows(await db.from('channels').select('id,name').eq('id', channelId).limit(1))[0];
      if (!channel) {
        send({ type: 'error', code: 'channel_not_found' });
        return;
      }
      if (ws.readyState !== ws.OPEN) return;

      const entry = {
        meta: {
          name: user.nickname || user.username,
          class_key: user.class_key ?? null,
          avatar_updated_at: user.avatar_updated_at ?? null,
        },
        muted: false,
        send,
        close: closeWith,
      };
      const result = rooms.join(channelId, user.id, entry);
      if (!result.ok) {
        send({ type: 'error', code: result.code });
        closeWith(4003, 'voice full');
        return;
      }
      conn.channelId = channelId;
      conn.userId = user.id;
      conn.entry = entry;
      conn.joined = true;
      clearTimeout(joinTimer);
      send({
        type: 'joined',
        me: result.self,
        peers: result.peers,
        limit: rooms.limit,
        channel: { id: channel.id, name: channel.name },
        ice_servers: iceServers(),
      });
    }

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        closeWith(4000, 'binary not supported');
        return;
      }
      const now = Date.now();
      if (now - conn.windowStart > MESSAGE_WINDOW_MS) {
        conn.windowStart = now;
        conn.messages = 0;
      }
      conn.messages += 1;
      if (conn.messages > MESSAGE_LIMIT) {
        send({ type: 'error', code: 'rate_limited' });
        closeWith(4008, 'rate limited');
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send({ type: 'error', code: 'invalid_input' });
        return;
      }
      if (!message || typeof message !== 'object') return;

      if (message.type === 'join') {
        void join(message);
        return;
      }
      if (message.type === 'ping') {
        send({ type: 'pong' });
        return;
      }
      if (!conn.joined) {
        send({ type: 'error', code: 'not_joined' });
        return;
      }
      if (message.type === 'mute') {
        if (typeof message.muted !== 'boolean') {
          send({ type: 'error', code: 'invalid_input' });
          return;
        }
        rooms.setMuted(conn.channelId, conn.userId, message.muted);
        return;
      }
      if (message.type === 'signal') {
        if (typeof message.to !== 'string' || !isUuid(message.to) || !validSignalData(message.data)) {
          send({ type: 'error', code: 'invalid_input' });
          return;
        }
        rooms.signal(conn.channelId, conn.userId, message.to, message.data);
      }
    });

    ws.on('pong', () => {
      ws.isVoiceAlive = true;
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (conn.channelId) rooms.leave(conn.channelId, conn.userId, conn.entry);
    });

    ws.on('error', () => {
      // The close handler performs room cleanup.
    });
  }

  return wss;
}
