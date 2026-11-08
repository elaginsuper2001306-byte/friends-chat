// Live check of the in-site voice signaling on the deployed site.
// Creates two temporary accounts, joins them into the same channel over WebSocket,
// relays a fake offer, then removes the accounts. Run: node dev/voice-live-ws-check.mjs
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import pg from 'pg';

process.loadEnvFile('.env.local');
const url = (process.argv[2] ?? JSON.parse(readFileSync('deploy/render/service.json', 'utf8')).url).replace(/\/+$/, '');
const socketUrl = `${url.replace(/^http/, 'ws')}/api/voice/socket`;
const usernames = [];
let failed = false;

const check = (condition, message) => {
  if (!condition) failed = true;
  console.log(`${condition ? 'ok' : 'FAIL'}: ${message}`);
};

function client(cookie) {
  const ws = new WebSocket(socketUrl, { headers: { origin: url, cookie } });
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const at = waiters.findIndex((waiter) => waiter.match(message));
    if (at >= 0) {
      const [waiter] = waiters.splice(at, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  });
  const next = (match, timeout = 8000) => new Promise((resolve, reject) => {
    const test = typeof match === 'string' ? (message) => message.type === match : match;
    const at = queue.findIndex(test);
    if (at >= 0) {
      resolve(queue.splice(at, 1)[0]);
      return;
    }
    const waiter = { match: test, resolve };
    waiter.timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`timeout waiting for ${typeof match === 'string' ? match : 'message'}`));
    }, timeout);
    waiters.push(waiter);
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, opened, next };
}

async function register(nickname) {
  const username = `wcf${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const response = await fetch(`${url}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({
      username,
      password: crypto.randomUUID() + 'Aa!',
      first_name: 'Проверка',
      last_name: 'Голоса',
      nickname,
      class_key: 'warrior',
    }),
  });
  if (response.status !== 201) throw new Error(`регистрация ${nickname}: HTTP ${response.status}`);
  usernames.push(username);
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  const me = await (await fetch(`${url}/api/me`, { headers: { cookie } })).json();
  return { username, cookie, id: me.user?.id };
}

try {
  const first = await register('ПроверкаГолосА');
  const second = await register('ПроверкаГолосБ');
  check(Boolean(first.id && second.id), 'временные аккаунты созданы');

  const channels = await (await fetch(`${url}/api/channels`, { headers: { cookie: first.cookie } })).json();
  const channel = channels.find((item) => item.name === 'общий') ?? channels[0];
  check(Boolean(channel?.id), `канал найден (${channel?.name})`);

  const a = client(first.cookie);
  const b = client(second.cookie);
  await Promise.all([a.opened, b.opened]);
  a.ws.send(JSON.stringify({ type: 'join', channel_id: channel.id }));
  const joinedA = await a.next('joined');
  check(joinedA.limit === 6 && Array.isArray(joinedA.ice_servers) && joinedA.ice_servers.length > 0, 'первый вошёл, лимит 6 и ICE-серверы получены');

  b.ws.send(JSON.stringify({ type: 'join', channel_id: channel.id }));
  const joinedB = await b.next('joined');
  check(joinedB.peers.some((peer) => peer.id === first.id), 'второй видит первого');
  const notice = await a.next((message) => message.type === 'peer-joined' && message.peer.id === second.id);
  check(Boolean(notice), 'первый получил уведомление о втором');

  a.ws.send(JSON.stringify({ type: 'signal', to: second.id, data: { description: { type: 'offer', sdp: 'v=0' } } }));
  const relayed = await b.next('signal');
  check(relayed.from === first.id && relayed.data.description.type === 'offer', 'сигнал доставлен адресату');

  b.ws.send(JSON.stringify({ type: 'mute', muted: true }));
  const muted = await a.next((message) => message.type === 'peer-updated' && message.peer.id === second.id);
  check(muted.peer.muted === true, 'mute передаётся участникам');

  a.ws.close();
  b.ws.close();
} catch (error) {
  failed = true;
  console.error('FAIL:', error.message);
} finally {
  const pool = new pg.Pool({ connectionString: String(process.env.DATABASE_URL).trim(), ssl: true, max: 1 });
  try {
    for (const username of usernames) {
      const found = await pool.query('SELECT id FROM app.users WHERE username = $1', [username]);
      const id = found.rows[0]?.id;
      if (!id) continue;
      await pool.query('DELETE FROM app.sessions WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM app.channel_messages WHERE author_id = $1', [id]);
      await pool.query('DELETE FROM app.dm_messages WHERE author_id = $1', [id]);
      await pool.query('DELETE FROM app.users WHERE id = $1', [id]);
    }
    await pool.query("DELETE FROM app.auth_limiter WHERE key LIKE '%wcf%'");
    const left = await pool.query('SELECT count(*)::int AS n FROM app.users');
    console.log(`пользователей в базе: ${left.rows[0].n}`);
  } finally {
    await pool.end();
  }
}

if (failed) process.exitCode = 1;
