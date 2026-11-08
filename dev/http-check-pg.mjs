// End-to-end HTTPS check of the Node server with a real SQL engine (PGlite).
// Run: node dev/http-check-pg.mjs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from '../server/create-server.mjs';
import { createPgDb } from '../server/db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = await readFileSync(path.join(root, 'schema.sql'), 'utf8');
const pg = new PGlite();
await pg.exec(schema);

const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const { port } = probe.address();
await new Promise((resolve) => probe.close(resolve));

const ORIGIN = `https://localhost:${port}`;
const BASE = ORIGIN;
const appServer = createServer({
  db: createPgDb(pg),
  origin: ORIGIN,
  webRoot: path.join(root, 'web'),
  tls: {
    cert: readFileSync(path.join(root, '.local-tls', 'cert.pem')),
    key: readFileSync(path.join(root, '.local-tls', 'key.pem')),
  },
});
await new Promise((resolve) => appServer.listen(port, '127.0.0.1', resolve));

function jar() {
  let cookie = '';
  return {
    async call(pathname, { method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(BASE + pathname, {
        method,
        headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      return { status: response.status, data, headers: response.headers };
    },
  };
}

const check = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log('ok:', message);
};

const suffix = crypto.randomUUID().slice(0, 6);
const alice = jar();
const bob = jar();

const page = await fetch(`${ORIGIN}/`);
const html = await page.text();
check(page.status === 200 && html.includes('Чат друзей'), 'static page is served');
check((page.headers.get('content-security-policy') ?? '').includes("script-src 'self'"), 'CSP is present');

const health = await alice.call('/api/health');
check(health.status === 200 && health.data.ok === true, 'health endpoint responds');

const anonymous = await alice.call('/api/channels');
check(anonymous.status === 401, 'channels require login');

const badOrigin = await fetch(`${BASE}/api/register`, {
  method: 'POST',
  headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
  body: JSON.stringify({ username: `evil${suffix}`, password: 'password-12345' }),
});
check(badOrigin.status === 403, `foreign origin is rejected (got ${badOrigin.status})`);

const ra = await alice.call('/api/register', {
  method: 'POST',
  body: {
    username: `alice${suffix}`, password: 'password-12345',
    first_name: 'Алиса', last_name: 'Тестова', nickname: `Алиса${suffix}`, class_key: 'mage',
  },
});
check(ra.status === 201, 'alice registered');
const rb = await bob.call('/api/register', {
  method: 'POST',
  body: {
    username: `bob${suffix}`, password: 'password-12345',
    first_name: 'Боб', last_name: 'Тестов', nickname: `Боб${suffix}`, class_key: 'warrior',
  },
});
check(rb.status === 201, 'bob registered');

const users = await alice.call('/api/users');
const bobUser = users.data.find((user) => user.nickname === `Боб${suffix}`);
check(Boolean(bobUser), 'alice sees bob in members');

const open = await alice.call('/api/dm', { method: 'POST', body: { userId: bobUser.id } });
check(open.status === 201 && open.data.peer.nickname === `Боб${suffix}`, 'alice opens DM with bob');
const threadId = open.data.id;

const send = await alice.call(`/api/dm/${threadId}/messages`, {
  method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: 'привет, боб!' },
});
check(send.status === 201, 'alice sends DM');

const bobRead = await bob.call(`/api/dm/${threadId}/messages`);
check(bobRead.data.some((message) => message.body === 'привет, боб!'), 'bob reads alice message');

const reply = await bob.call(`/api/dm/${threadId}/messages`, {
  method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: 'привет, алиса!' },
});
check(reply.status === 201, 'bob replies');
const aliceRead = await alice.call(`/api/dm/${threadId}/messages`);
check(aliceRead.data.some((message) => message.body === 'привет, алиса!'), 'alice reads bob reply');

const channels = await alice.call('/api/channels');
check(channels.data.map((channel) => channel.name).sort().join(',') === 'общий,флуд', 'default channels exist');

const general = channels.data.find((channel) => channel.name === 'общий');
const post = await alice.call(`/api/channels/${general.id}/messages`, {
  method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: 'канал работает' },
});
check(post.status === 201, 'channel message is accepted');

const renamed = await alice.call('/api/me', {
  method: 'PATCH', body: { first_name: 'Алиса', last_name: 'Тестова', nickname: `Аля${suffix}`, class_key: 'assassin' },
});
check(renamed.status === 200 && renamed.data.user.nickname === `Аля${suffix}`, 'profile edit is accepted');

const full = await bob.call(`/api/users/${ra.data.user.id}/profile`);
check(full.status === 200 && full.data.last_name === 'Тестова' && full.data.class_key === 'assassin',
  'full profile exposes the real name and class');
check(!('username' in full.data), 'full profile hides the login');

const history = await alice.call(`/api/channels/${general.id}/messages`);
check(history.data.every((message) => message.author_name === `Аля${suffix}` && message.author_class === 'assassin'),
  'old messages show the updated nickname and class');

const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
));
const avatar = await alice.call('/api/me/avatar', {
  method: 'POST', body: { dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}` },
});
check(avatar.status === 200 && typeof avatar.data.user.avatar_updated_at === 'string', 'avatar upload is accepted');

const image = await bob.call(`/api/avatars/${ra.data.user.id}`);
check(image.status === 200 && image.headers.get('content-type') === 'image/png', 'avatar bytes are served');

const afterAvatar = await bob.call(`/api/channels/${general.id}/messages`);
check(afterAvatar.data.every((message) => typeof message.author_avatar === 'string'), 'messages carry the avatar version');

const removed = await alice.call('/api/me/avatar', { method: 'DELETE' });
check(removed.status === 200 && removed.data.user.avatar_updated_at === null, 'avatar removal is accepted');
check((await bob.call(`/api/avatars/${ra.data.user.id}`)).status === 404, 'removed avatar is gone');

await new Promise((resolve) => appServer.close(resolve));
await pg.close();
console.log('\nALL NODE HTTP CHECKS PASSED');
