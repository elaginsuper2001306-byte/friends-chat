import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { attachVoiceSocket } from '../server/voice-socket.mjs';
import { sha256Hex } from '../functions/sessions.mjs';
import { createFakeDb } from './fake-db.mjs';

const uuid = () => crypto.randomUUID();

function client(url, headers) {
  const ws = new WebSocket(url, { headers });
  ws.on('error', () => {});
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.match(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
    ws.once('error', reject);
  });
  const next = (match, timeout = 4000) => new Promise((resolve, reject) => {
    const testMessage = typeof match === 'string' ? (message) => message.type === match : match;
    const index = queue.findIndex(testMessage);
    if (index >= 0) {
      resolve(queue.splice(index, 1)[0]);
      return;
    }
    const waiter = { match: testMessage, resolve };
    waiter.timer = setTimeout(() => {
      const at = waiters.indexOf(waiter);
      if (at >= 0) waiters.splice(at, 1);
      reject(new Error(`timeout waiting for ${typeof match === 'string' ? match : 'message'}`));
    }, timeout);
    waiters.push(waiter);
  });
  return { ws, opened, next };
}

async function startService(count) {
  const db = createFakeDb();
  const channel = { id: uuid(), name: 'общий', created_by: uuid(), created_at: new Date().toISOString() };
  const other = { id: uuid(), name: 'флуд', created_by: uuid(), created_at: new Date().toISOString() };
  await db.from('channels').insert(channel);
  await db.from('channels').insert(other);

  const users = [];
  for (let index = 0; index < count; index += 1) {
    const user = {
      id: uuid(),
      username: `voice${index}`,
      nickname: `Голос${index}`,
      class_key: 'warrior',
      avatar_updated_at: null,
    };
    await db.from('users').insert(user);
    const token = crypto.randomBytes(32).toString('base64url');
    await db.from('sessions').insert({
      token_digest: await sha256Hex(token),
      user_id: user.id,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
    });
    users.push({ ...user, cookie: `__Host-app_auth.session=${token}` });
  }

  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const wss = attachVoiceSocket(server, { db, origin });
  const url = `ws://127.0.0.1:${port}/api/voice/socket`;

  const close = async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };

  return { db, channel, other, users, url, origin, close };
}

async function join(url, origin, user, channelId) {
  const socket = client(url, { origin, cookie: user.cookie });
  await socket.opened;
  socket.ws.send(JSON.stringify({ type: 'join', channel_id: channelId }));
  const joined = await socket.next('joined');
  return { socket, joined };
}

test('voice socket: join, relay, limit of six and channel isolation', async (t) => {
  const service = await startService(7);
  t.after(service.close);
  const sockets = [];
  t.after(() => {
    for (const socket of sockets) {
      try {
        socket.ws.close();
      } catch {
        // Already closed.
      }
    }
  });

  for (let index = 0; index < 6; index += 1) {
    const { socket, joined } = await join(service.url, service.origin, service.users[index], service.channel.id);
    sockets.push(socket);
    assert.equal(joined.type, 'joined');
    assert.equal(joined.limit, 6);
    assert.ok(Array.isArray(joined.ice_servers) && joined.ice_servers.length > 0);
    assert.equal(joined.me.name, service.users[index].nickname);
  }

  const [first, second] = sockets;
  assert.equal((await first.next('peer-joined')).peer.id, service.users[1].id);

  first.ws.send(JSON.stringify({
    type: 'signal',
    to: service.users[1].id,
    data: { description: { type: 'offer', sdp: 'v=0' } },
  }));
  const signal = await second.next('signal');
  assert.equal(signal.from, service.users[0].id);
  assert.equal(signal.data.description.type, 'offer');

  const seventh = client(service.url, { origin: service.origin, cookie: service.users[6].cookie });
  await seventh.opened;
  const closed = new Promise((resolve) => seventh.ws.once('close', resolve));
  seventh.ws.send(JSON.stringify({ type: 'join', channel_id: service.channel.id }));
  const refusal = await seventh.next('error');
  assert.equal(refusal.code, 'voice_full');
  const closeEvent = await closed;
  assert.equal(closeEvent, 4003);

  const outsider = await join(service.url, service.origin, service.users[6], service.other.id);
  sockets.push(outsider.socket);
  assert.equal(outsider.joined.channel.id, service.other.id);
  assert.equal(outsider.joined.peers.length, 0);

  first.ws.send(JSON.stringify({ type: 'mute', muted: true }));
  const update = await second.next((message) => message.type === 'peer-updated' && message.peer.id === service.users[0].id);
  assert.equal(update.peer.muted, true);

  second.ws.close();
  const left = await first.next('peer-left');
  assert.equal(left.peer_id, service.users[1].id);
});

test('voice socket: rejects a foreign origin and an unauthenticated join', async (t) => {
  const service = await startService(1);
  t.after(service.close);

  const foreign = client(service.url, { origin: 'https://evil.example', cookie: service.users[0].cookie });
  await assert.rejects(foreign.opened, /HTTP 403/);

  const anonymous = client(service.url, { origin: service.origin, cookie: `__Host-app_auth.session=${'A'.repeat(43)}` });
  await anonymous.opened;
  const closed = new Promise((resolve) => anonymous.ws.once('close', resolve));
  anonymous.ws.send(JSON.stringify({ type: 'join', channel_id: service.channel.id }));
  const refusal = await anonymous.next('error');
  assert.equal(refusal.code, 'login_required');
  assert.equal(await closed, 4001);
});
