// Real-SQL checks against an in-process PostgreSQL (PGlite).
// These validate the PostgreSQL adapter, schema constraints and CAS semantics
// without a local database server.
//   node --test dev/check-pg.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createApplication } from '../functions/router.mjs';
import { createPgDb } from '../server/db.mjs';
import { consume } from '../functions/limiter.mjs';
import { SESSION_COOKIE } from '../functions/sessions.mjs';

const PUBLIC_ORIGIN = 'https://messenger.test';
const PASSWORD = 'correct horse battery staple';
const TELEMOST_ORIGIN = 'https://telemost.yandex.ru';
const TEST_VOICE = { token: `y0_${'t'.repeat(36)}`, staticUrl: null };
const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');

function fakeTelemost({ calls = [], fail = false } = {}) {
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (fail) return new Response('{"error":"boom"}', { status: 500 });
    return new Response(JSON.stringify({
      id: `conf-${calls.length}`,
      join_url: `${TELEMOST_ORIGIN}/j/conf-${calls.length}`,
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

async function fixture(options = {}) {
  const pg = new PGlite();
  await pg.exec(schema);
  const db = createPgDb(pg);
  const handle = createApplication({
    db, origin: PUBLIC_ORIGIN,
    voice: options.voice === undefined ? TEST_VOICE : options.voice,
    fetchImpl: options.fetchImpl ?? fakeTelemost().fetchImpl,
  });
  return { pg, db, handle };
}

function ctx(path, { method = 'GET', body, cookie, origin = PUBLIC_ORIGIN, headers = {} } = {}) {
  const merged = { ...headers };
  if (origin !== null) merged.origin = origin;
  if (cookie) merged.cookie = cookie;
  if (body !== undefined) merged['content-type'] = 'application/json';
  return {
    request: new Request(`${PUBLIC_ORIGIN}/app${path}`, {
      method,
      headers: merged,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    requestId: 'pg-check',
  };
}

async function call(handle, context) {
  const response = await handle(context);
  let body = null;
  try { body = await response.clone().json(); } catch { body = null; }
  return { status: response.status, body, setCookie: response.headers.get('set-cookie'), headers: response.headers };
}

const cookiePair = (result) => result.setCookie?.split(';')[0] ?? null;
const register = (handle, username) => call(handle, ctx('/api/register', {
  method: 'POST',
  body: {
    username, password: PASSWORD,
    first_name: 'Иван', last_name: 'Иванов', nickname: username.toLowerCase(), class_key: 'warrior',
  },
}));
const login = (handle, username, password = PASSWORD) => call(handle, ctx('/api/login', { method: 'POST', body: { username, password } }));
const me = (handle, cookie) => call(handle, ctx('/api/me', { cookie }));
const patchMe = (handle, cookie, body) => call(handle, ctx('/api/me', { method: 'PATCH', cookie, body }));
const uniqueName = (prefix = 'user') => `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

test('SQL: registration, login and sessions', async () => {
  const { db, handle } = await fixture();
  const name = uniqueName('sql');
  const created = await register(handle, name.toUpperCase());
  assert.equal(created.status, 201);
  assert.equal(created.body.user.username, name);
  const cookie = cookiePair(created);
  assert.ok(cookie?.startsWith(`${SESSION_COOKIE}=`));

  const who = await me(handle, cookie);
  assert.equal(who.status, 200);
  assert.equal(who.body.user.username, name);

  assert.equal((await login(handle, name, `${PASSWORD}-wrong`)).status, 401);
  const ok = await login(handle, name);
  assert.equal(ok.status, 200);
  assert.equal((await me(handle, cookiePair(ok))).status, 200);

  const created_at = await db.from('users').select('created_at').eq('username', name).limit(1);
  assert.equal(typeof created_at.data[0].created_at, 'string');
  assert.match(created_at.data[0].created_at, /^\d{4}-\d{2}-\d{2}T/);

  const logout = await call(handle, ctx('/api/logout', { method: 'POST', cookie }));
  assert.equal(logout.status, 200);
  assert.equal((await me(handle, cookie)).status, 401);
});

test('SQL: default channels, creation, ordering and idempotent sends', async () => {
  const { pg, handle } = await fixture();
  const user = await register(handle, uniqueName('chan'));
  const cookie = cookiePair(user);

  const first = await call(handle, ctx('/api/channels', { cookie }));
  const second = await call(handle, ctx('/api/channels', { cookie }));
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.map((channel) => channel.name).sort(), ['общий', 'флуд'].sort());
  assert.deepEqual(second.body, first.body);
  const defaults = await pg.query('SELECT count(*)::int AS count FROM app.channels');
  assert.equal(defaults.rows[0].count, 2);

  const general = first.body.find((channel) => channel.name === 'общий');
  const key = crypto.randomUUID();
  const send = (body, idempotencyKey = crypto.randomUUID()) => call(handle, ctx(`/api/channels/${general.id}/messages`, {
    method: 'POST', cookie, headers: { 'idempotency-key': idempotencyKey }, body: { body },
  }));

  assert.equal((await send('первое', key)).status, 201);
  assert.equal((await send('первое', key)).status, 200);
  assert.equal((await send('другое', key)).body.error, 'idempotency_conflict');
  assert.equal((await send('второе')).status, 201);

  const history = await call(handle, ctx(`/api/channels/${general.id}/messages`, { cookie }));
  assert.deepEqual(history.body.map((message) => message.body), ['первое', 'второе']);
  for (const message of history.body) assert.equal(typeof message.created_at, 'string');

  const rows = await pg.query('SELECT count(*)::int AS count FROM app.channel_messages');
  assert.equal(rows.rows[0].count, 2);
});

test('SQL: DM thread reuse and membership isolation', async () => {
  const { handle } = await fixture();
  const a = await register(handle, uniqueName('dma'));
  const b = await register(handle, uniqueName('dmb'));
  const c = await register(handle, uniqueName('dmc'));
  const cookieA = cookiePair(a), cookieB = cookiePair(b), cookieC = cookiePair(c);

  const openAB = await call(handle, ctx('/api/dm', { method: 'POST', cookie: cookieA, body: { userId: b.body.user.id } }));
  const openBA = await call(handle, ctx('/api/dm', { method: 'POST', cookie: cookieB, body: { userId: a.body.user.id } }));
  assert.equal(openAB.status, 201);
  assert.equal(openBA.status, 200);
  assert.equal(openAB.body.id, openBA.body.id);

  const threadId = openAB.body.id;
  const post = (cookie, text) => call(handle, ctx(`/api/dm/${threadId}/messages`, {
    method: 'POST', cookie, headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: text },
  }));
  assert.equal((await post(cookieA, 'привет')).status, 201);
  assert.equal((await post(cookieB, 'ответ')).status, 201);

  const history = await call(handle, ctx(`/api/dm/${threadId}/messages`, { cookie: cookieB }));
  assert.deepEqual(history.body.map((message) => message.body), ['привет', 'ответ']);
  assert.equal((await call(handle, ctx(`/api/dm/${threadId}/messages`, { cookie: cookieC }))).status, 404);
  assert.equal((await call(handle, ctx('/api/users', { cookie: cookieC }))).status, 200);
});

test('SQL: concurrent registration keeps a single account', async () => {
  const { handle } = await fixture();
  const name = uniqueName('race');
  const results = await Promise.all([
    register(handle, name),
    register(handle, name.toUpperCase()),
    register(handle, ` ${name} `),
  ]);
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => result.body?.error === 'username_taken').length, 2);
});

test('SQL: limiter CAS never over-admits', async () => {
  const { db } = await fixture();
  const key = uniqueName('limit');
  const results = await Promise.all(
    Array.from({ length: 20 }, () => consume(db, 'login', key)),
  );
  assert.equal(results.filter((result) => result.allowed).length, 10);
  assert.equal(results.filter((result) => !result.allowed).length, 10);
  const stored = await db.from('auth_limiter').select('attempt_count').eq('key', `login:${key}`).limit(1);
  assert.equal(stored.data[0].attempt_count, 10);
});

test('SQL: profile update and full profile read', async () => {
  const { handle } = await fixture();
  const a = await register(handle, uniqueName('prof'));
  const b = await register(handle, uniqueName('view'));
  const cookieA = cookiePair(a), cookieB = cookiePair(b);

  const updated = await patchMe(handle, cookieA, {
    first_name: 'Пётр', last_name: 'Сидоров', nickname: 'Тёмный Маг', class_key: 'mage',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.user.nickname, 'Тёмный Маг');
  assert.equal(updated.body.user.class_key, 'mage');

  const full = await call(handle, ctx(`/api/users/${a.body.user.id}/profile`, { cookie: cookieB }));
  assert.equal(full.status, 200);
  assert.deepEqual(full.body, {
    id: a.body.user.id, first_name: 'Пётр', last_name: 'Сидоров',
    nickname: 'Тёмный Маг', class_key: 'mage', avatar_updated_at: null,
  });

  const members = await call(handle, ctx('/api/users', { cookie: cookieB }));
  const listed = members.body.find((member) => member.id === a.body.user.id);
  assert.deepEqual(listed, {
    id: a.body.user.id, nickname: 'Тёмный Маг', class_key: 'mage', avatar_updated_at: null,
  });
});

test('SQL: avatar bytes round-trip through bytea and are served with ETag', async () => {
  const { pg, handle } = await fixture();
  const png = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ));
  const a = await register(handle, uniqueName('ava'));
  const b = await register(handle, uniqueName('see'));
  const cookieA = cookiePair(a), cookieB = cookiePair(b);

  const saved = await call(handle, ctx('/api/me/avatar', {
    method: 'POST', cookie: cookieA,
    body: { dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}` },
  }));
  assert.equal(saved.status, 200);
  assert.equal(typeof saved.body.user.avatar_updated_at, 'string');
  const stored = await pg.query('SELECT avatar_mime, octet_length(avatar_data)::int AS size FROM app.users WHERE id = $1', [a.body.user.id]);
  assert.equal(stored.rows[0].avatar_mime, 'image/png');
  assert.equal(stored.rows[0].size, png.length);

  const image = await handle(ctx(`/api/avatars/${a.body.user.id}`, { cookie: cookieB }));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  const etag = image.headers.get('etag');
  const cached = await handle(ctx(`/api/avatars/${a.body.user.id}`, { cookie: cookieB, headers: { 'if-none-match': etag } }));
  assert.equal(cached.status, 304);

  await call(handle, ctx(`/api/channels/${(await call(handle, ctx('/api/channels', { cookie: cookieB }))).body[0].id}/messages`, {
    method: 'POST', cookie: cookieA, headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: 'с аватаром' },
  }));
  const history = await call(handle, ctx(`/api/channels/${(await call(handle, ctx('/api/channels', { cookie: cookieB }))).body[0].id}/messages`, { cookie: cookieB }));
  assert.equal(history.body[0].author_avatar, saved.body.user.avatar_updated_at);
  assert.equal(history.body[0].author_name, a.body.user.nickname);

  const removed = await call(handle, ctx('/api/me/avatar', { method: 'DELETE', cookie: cookieA }));
  assert.equal(removed.status, 200);
  assert.equal((await handle(ctx(`/api/avatars/${a.body.user.id}`, { cookie: cookieB }))).status, 404);
});

test('SQL: a Telemost room is cached per channel in the database', async () => {
  const { calls, fetchImpl } = fakeTelemost();
  const { pg, handle } = await fixture({ fetchImpl });
  const a = await register(handle, uniqueName('voi'));
  const cookie = cookiePair(a);
  const channels = (await call(handle, ctx('/api/channels', { cookie }))).body;
  const general = channels.find((channel) => channel.name === 'общий');

  const issued = await call(handle, ctx(`/api/channels/${general.id}/voice`, { method: 'POST', cookie }));
  assert.equal(issued.status, 200);
  assert.equal(issued.body.join_url, `${TELEMOST_ORIGIN}/j/conf-1`);
  const stored = await pg.query('SELECT conference_id, join_url FROM app.voice_rooms WHERE channel_id = $1', [general.id]);
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].conference_id, 'conf-1');
  assert.equal(stored.rows[0].join_url, issued.body.join_url);

  const again = await call(handle, ctx(`/api/channels/${general.id}/voice`, { method: 'POST', cookie }));
  assert.equal(again.status, 200);
  assert.equal(again.body.join_url, issued.body.join_url);
  assert.equal(calls.length, 1);

  assert.equal((await call(handle, ctx(`/api/channels/${crypto.randomUUID()}/voice`, { method: 'POST', cookie }))).status, 404);
  assert.equal((await call(handle, ctx(`/api/channels/${general.id}/voice`, { method: 'POST' }))).status, 401);

  const disabled = await fixture({ voice: null });
  const d = await register(disabled.handle, uniqueName('voi'));
  const blocked = await call(disabled.handle, ctx(`/api/channels/${general.id}/voice`, { method: 'POST', cookie: cookiePair(d) }));
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error, 'voice_unavailable');
});
