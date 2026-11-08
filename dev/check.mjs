// Local contract checks: call the real functions/ modules with a credential-free fake database.
// Does not prove real Provider, gateway admission or deployed behavior.
//   node --test dev/check.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createApplication } from '../functions/router.mjs';
import { PBKDF2_ITERATIONS } from '../functions/passwords.mjs';
import { SESSION_COOKIE, SESSION_TTL_MS, sha256Hex } from '../functions/sessions.mjs';
import { LIMITS } from '../functions/limiter.mjs';
import { voiceConfig } from '../functions/voice.mjs';
import { createFakeDb } from './fake-db.mjs';

const PUBLIC_ORIGIN = 'https://messenger.test';
const PASSWORD = `pw-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const TELEMOST_ORIGIN = 'https://telemost.yandex.ru';
const TEST_VOICE = { token: `y0_${'t'.repeat(36)}`, staticUrl: null };

// Telemost answers 201 with a conference id and a join link; no network in tests.
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

function fixture(options = {}) {
  const control = { mode: 'ok', dropTable: null, writes: [] };
  const db = createFakeDb(control);
  const handle = createApplication({
    db, origin: PUBLIC_ORIGIN,
    voice: options.voice === undefined ? TEST_VOICE : options.voice,
    fetchImpl: options.fetchImpl ?? fakeTelemost().fetchImpl,
  });
  return { control, db, handle };
}

function ctx(path, { method = 'GET', body, cookie, origin = PUBLIC_ORIGIN, headers = {}, logical = false } = {}) {
  const merged = { ...headers };
  if (origin !== null) merged.origin = origin;
  if (cookie) merged.cookie = cookie;
  if (body !== undefined) merged['content-type'] = 'application/json';
  const target = logical
    ? `${PUBLIC_ORIGIN}/functions/v1/app${path}`
    : `https://provider.internal/functions/v1/app-d${'a'.repeat(32)}${path}`;
  return {
    request: new Request(target, { method, headers: merged, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    requestId: 'local-check',
  };
}

const call = async (handle, context) => {
  const response = await handle(context);
  let body = null;
  try { body = await response.clone().json(); } catch { body = null; }
  return { status: response.status, body, setCookie: response.headers.get('set-cookie'), headers: response.headers };
};

const cookiePair = (result) => {
  const header = result.setCookie;
  if (!header) return null;
  return header.split(';')[0];
};

const PROFILE_FIELDS = { first_name: 'Иван', last_name: 'Иванов', class_key: 'warrior' };
const profileFor = (username) => ({ ...PROFILE_FIELDS, nickname: username.trim().toLowerCase() });

const register = (handle, username, password = PASSWORD) => call(handle, ctx('/api/register', {
  method: 'POST', body: { username, password, ...profileFor(username) },
}));
const login = (handle, username, password = PASSWORD) => call(handle, ctx('/api/login', { method: 'POST', body: { username, password } }));
const me = (handle, cookie) => call(handle, ctx('/api/me', { cookie }));
const patchMe = (handle, cookie, body) => call(handle, ctx('/api/me', { method: 'PATCH', cookie, body }));
const uniqueName = (prefix = 'user') => `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
const sendChannel = (handle, cookie, channelId, body, key = crypto.randomUUID()) => call(handle, ctx(`/api/channels/${channelId}/messages`, {
  method: 'POST', cookie, headers: { 'idempotency-key': key }, body: { body },
}));

test('register: canonical username, session issued, only derived password stored', async () => {
  const { db, handle } = fixture();
  const created = await register(handle, '  Alpha_01  ');
  assert.equal(created.status, 201);
  assert.equal(created.body.user.username, 'alpha_01');
  assert.deepEqual(Object.keys(created.body.user).sort(),
    ['avatar_updated_at', 'class_key', 'first_name', 'id', 'last_name', 'nickname', 'username']);
  assert.equal(created.body.user.nickname, 'alpha_01');
  assert.equal(created.body.user.first_name, 'Иван');
  assert.equal(created.body.user.last_name, 'Иванов');
  assert.equal(created.body.user.class_key, 'warrior');
  assert.equal(created.body.user.avatar_updated_at, null);

  const cookie = cookiePair(created);
  assert.ok(cookie && cookie.startsWith(`${SESSION_COOKIE}=`));
  assert.match(created.setCookie, /HttpOnly/);
  assert.match(created.setCookie, /Secure/);
  assert.match(created.setCookie, /SameSite=Lax/);
  assert.match(created.setCookie, /Path=\//);
  assert.ok(!/Domain=/i.test(created.setCookie));

  const users = db.dump('users');
  assert.equal(users.length, 1);
  assert.equal(users[0].password_iterations, PBKDF2_ITERATIONS);
  const stored = JSON.stringify([...users, ...db.dump('sessions'), ...db.dump('auth_limiter')]);
  assert.ok(!stored.includes(PASSWORD), 'plaintext password must never be stored');

  const token = cookie.slice(SESSION_COOKIE.length + 1);
  assert.ok(!JSON.stringify(db.dump('sessions')).includes(token), 'session table stores digests only');
  assert.equal(db.dump('sessions')[0].token_digest, await sha256Hex(token));

  const who = await me(handle, cookie);
  assert.equal(who.status, 200);
  assert.deepEqual(who.body.user, created.body.user);
});

test('register: concurrent case/whitespace variants yield exactly one account', async () => {
  const { db, handle } = fixture();
  const results = await Promise.all([
    register(handle, 'Bravo01'), register(handle, 'bravo01'),
    register(handle, ' BRAVO01 '), register(handle, 'Bravo01'),
  ]);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409 && r.body.error === 'username_taken').length, 3);
  assert.equal(db.dump('users').filter((row) => row.username === 'bravo01').length, 1);
});

test('register: username and password policy', async () => {
  const { handle } = fixture();
  for (const bad of ['ab', 'x'.repeat(33), '_leading', 'bad name', 'bad@name', '']) {
    const result = await register(handle, bad);
    assert.equal(result.status, 400, `username must be rejected: ${JSON.stringify(bad)}`);
    assert.equal(result.body.error, 'invalid_username');
  }
  assert.equal((await register(handle, uniqueName(), 'short')).body.error, 'invalid_password');
  assert.equal((await register(handle, uniqueName(), 'x'.repeat(257))).body.error, 'invalid_password');
  assert.equal((await register(handle, uniqueName(), 'a'.repeat(7))).body.error, 'invalid_password');
  assert.equal((await register(handle, uniqueName(), 'a'.repeat(8))).status, 201);
});

test('login: unknown account and wrong password share one error code', async () => {
  const { handle } = fixture();
  const name = uniqueName();
  await register(handle, name);

  const unknown = await login(handle, uniqueName('ghost'));
  const wrong = await login(handle, name, `${PASSWORD}-wrong`);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown.body, { error: 'invalid_credentials' });
  assert.deepEqual(wrong.body, { error: 'invalid_credentials' });

  const ok = await login(handle, name.toUpperCase());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.username, name);
  assert.equal((await me(handle, cookiePair(ok))).body.user.username, name);
});

test('sessions: missing, expired, revoked and tampered cookies return 401', async () => {
  const { db, handle } = fixture();
  const created = await register(handle, uniqueName());
  const cookie = cookiePair(created);
  const userId = created.body.user.id;

  const missing = await me(handle, null);
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, 'login_required');
  assert.equal(missing.setCookie, null);

  const expiredToken = 'A'.repeat(43);
  await db.from('sessions').insertIfAbsent({
    token_digest: await sha256Hex(expiredToken), user_id: userId,
    created_at: new Date(Date.now() - SESSION_TTL_MS * 2).toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(), revoked_at: null,
  }, { onConflict: 'token_digest' }).select('token_digest');
  const expired = await me(handle, `${SESSION_COOKIE}=${expiredToken}`);
  assert.equal(expired.status, 401);
  assert.match(expired.setCookie ?? '', /Max-Age=0/);

  assert.equal((await me(handle, `${SESSION_COOKIE}=${'B'.repeat(43)}`)).status, 401);

  const logout = await call(handle, ctx('/api/logout', { method: 'POST', cookie }));
  assert.equal(logout.status, 200);
  assert.match(logout.setCookie ?? '', /Max-Age=0/);
  assert.ok(db.dump('sessions').some((row) => row.revoked_at != null));
  assert.equal((await me(handle, cookie)).status, 401);
});

test('CSRF: cross-origin unsafe methods are rejected even with a valid session', async () => {
  const { handle } = fixture();
  const created = await register(handle, uniqueName());
  const cookie = cookiePair(created);

  const foreignLogout = await call(handle, ctx('/api/logout', { method: 'POST', cookie, origin: 'https://evil.test' }));
  assert.equal(foreignLogout.status, 403);
  assert.equal(foreignLogout.body.error, 'origin_forbidden');

  const foreignChannel = await call(handle, ctx('/api/channels', {
    method: 'POST', cookie, origin: 'https://evil.test', body: { name: 'взлом' },
  }));
  assert.equal(foreignChannel.status, 403);

  const noOrigin = await call(handle, ctx('/api/logout', { method: 'POST', cookie, origin: null }));
  assert.equal(noOrigin.status, 403);
  assert.equal((await me(handle, cookie)).status, 200);
});

test('auth rate limits: failures capped, unknown accounts counted, success does not reset', async () => {
  const { db, handle } = fixture();
  const name = uniqueName();
  await register(handle, name);

  const statuses = [];
  for (let index = 0; index < LIMITS.login.maxAttempts; index += 1) {
    statuses.push((await login(handle, name, `${PASSWORD}-bad`)).status);
  }
  assert.deepEqual(statuses, Array(LIMITS.login.maxAttempts).fill(401));
  const blocked = await login(handle, name, PASSWORD);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  const ghost = uniqueName('ghost');
  const ghostStatuses = [];
  for (let index = 0; index < LIMITS.login.maxAttempts + 1; index += 1) {
    ghostStatuses.push((await login(handle, ghost, PASSWORD)).status);
  }
  assert.equal(ghostStatuses.at(-1), 429);
  assert.ok(db.dump('auth_limiter').some((row) => row.key === `login:${ghost}`));
});

test('login rate limit: concurrent CAS never over-admits', async () => {
  const { db, handle } = fixture();
  const name = uniqueName();
  await register(handle, name);

  const results = await Promise.all(
    Array.from({ length: LIMITS.login.maxAttempts * 2 }, () => login(handle, name, `${PASSWORD}-bad`)),
  );
  const passed = results.filter((r) => r.status === 401).length;
  const limited = results.filter((r) => r.status === 429).length;
  const failedClosed = results.filter((r) => r.status === 503).length;
  assert.equal(passed, LIMITS.login.maxAttempts);
  assert.equal(limited, LIMITS.login.maxAttempts);
  assert.equal(passed + limited + failedClosed, results.length);
  assert.equal(db.dump('auth_limiter').find((row) => row.key === `login:${name}`).attempt_count, LIMITS.login.maxAttempts);
});

test('uncertain session write: no replay, no false success', async () => {
  const { control, db, handle } = fixture();
  const name = uniqueName();
  await register(handle, name);

  const sessionsBefore = db.dump('sessions').length;
  const writeCount = () => control.writes.filter((table) => table === 'sessions').length;
  let attempts = writeCount();

  control.dropTable = 'sessions';
  const uncertain = await login(handle, name);
  assert.equal(uncertain.status, 503);
  assert.equal(uncertain.body.error, 'service_unavailable');
  assert.equal(cookiePair(uncertain), null);
  assert.equal(db.dump('sessions').length, sessionsBefore + 1);
  assert.equal(writeCount() - attempts, 1);
  attempts = writeCount();

  control.rejectTable = 'sessions';
  const rejected = await login(handle, name);
  assert.equal(rejected.status, 503);
  assert.equal(cookiePair(rejected), null);
  assert.equal(db.dump('sessions').length, sessionsBefore + 1);
  assert.equal(writeCount() - attempts, 1);
});

test('headers and routing: no-store, logical path, unknown paths, wrong methods', async () => {
  const { handle } = fixture();
  const health = await call(handle, ctx('/api/health'));
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true });
  assert.match(health.headers.get('cache-control') ?? '', /no-store/);
  assert.match(health.headers.get('referrer-policy') ?? '', /no-referrer/);

  assert.equal((await call(handle, ctx('/api/health', { logical: true }))).status, 200);
  assert.equal((await call(handle, ctx('/api/unknown'))).status, 404);
  const cookie = cookiePair(await register(handle, uniqueName()));
  assert.equal((await call(handle, ctx('/api/me', { method: 'POST', body: {} }))).status, 401);
  assert.equal((await call(handle, ctx('/api/me', { method: 'POST', body: {}, cookie }))).status, 405);
  assert.equal((await call(handle, ctx('/api/login', { method: 'POST' }))).status, 400);
});

// ----- Messenger -----

test('channels: login required, defaults bootstrapped once, create and duplicate', async () => {
  const { db, handle } = fixture();
  assert.equal((await call(handle, ctx('/api/channels'))).status, 401);

  const cookie = cookiePair(await register(handle, uniqueName()));
  const first = await call(handle, ctx('/api/channels', { cookie }));
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.map((c) => c.name).sort(), ['общий', 'флуд'].sort());

  const second = await call(handle, ctx('/api/channels', { cookie }));
  assert.deepEqual(second.body, first.body, 'bootstrap must not duplicate default channels');
  assert.equal(db.dump('channels').length, 2);

  const created = await call(handle, ctx('/api/channels', { method: 'POST', cookie, body: { name: '  Игры  ' } }));
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'игры');

  const duplicate = await call(handle, ctx('/api/channels', { method: 'POST', cookie, body: { name: 'ИГРЫ' } }));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'channel_exists');

  const bad = await call(handle, ctx('/api/channels', { method: 'POST', cookie, body: { name: '' } }));
  assert.equal(bad.status, 400);
  assert.equal((await call(handle, ctx('/api/channels', { method: 'DELETE', cookie }))).status, 405);
});

test('channel messages: author from session, history order, channel isolation', async () => {
  const { db, handle } = fixture();
  const a = await register(handle, uniqueName('alpha'));
  const b = await register(handle, uniqueName('bravo'));
  const cookieA = cookiePair(a), cookieB = cookiePair(b);

  const channels = (await call(handle, ctx('/api/channels', { cookie: cookieA }))).body;
  const general = channels.find((c) => c.name === 'общий');
  const flood = channels.find((c) => c.name === 'флуд');

  const posted = await sendChannel(handle, cookieA, general.id, 'Всем привет!');
  assert.equal(posted.status, 201);
  assert.equal(posted.body.author_name, a.body.user.username);
  assert.equal(posted.body.author_id, a.body.user.id);
  assert.equal(posted.body.body, 'Всем привет!');

  // A forged author in the body must be ignored.
  const forged = await call(handle, ctx(`/api/channels/${general.id}/messages`, {
    method: 'POST', cookie: cookieB, headers: { 'idempotency-key': crypto.randomUUID() },
    body: { body: 'Ответ Б', author_id: a.body.user.id, author_name: a.body.user.username },
  }));
  assert.equal(forged.status, 201);
  assert.equal(forged.body.author_id, b.body.user.id);
  assert.equal(forged.body.author_name, b.body.user.username);

  await sendChannel(handle, cookieA, flood.id, 'Другой канал');

  const history = await call(handle, ctx(`/api/channels/${general.id}/messages`, { cookie: cookieB }));
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.map((m) => m.body), ['Всем привет!', 'Ответ Б']);
  const floodHistory = await call(handle, ctx(`/api/channels/${flood.id}/messages`, { cookie: cookieA }));
  assert.deepEqual(floodHistory.body.map((m) => m.body), ['Другой канал']);

  // Deterministic ordering with explicit timestamps.
  const base = Date.now();
  for (let i = 0; i < 3; i += 1) {
    await db.from('channel_messages').insert({
      id: crypto.randomUUID(), channel_id: flood.id, author_id: a.body.user.id, author_name: a.body.user.username,
      body: `msg-${i}`, created_at: new Date(base + i * 1000).toISOString(),
    }).select('id');
  }
  const ordered = await call(handle, ctx(`/api/channels/${flood.id}/messages`, { cookie: cookieA }));
  assert.deepEqual(ordered.body.map((m) => m.body), ['Другой канал', 'msg-0', 'msg-1', 'msg-2']);

  assert.equal((await call(handle, ctx(`/api/channels/${general.id}/messages`))).status, 401);
  assert.equal((await call(handle, ctx(`/api/channels/${crypto.randomUUID()}/messages`, { cookie: cookieA }))).status, 404);
  assert.equal((await sendChannel(handle, cookieA, general.id, '   ')).status, 400);
  assert.equal((await sendChannel(handle, cookieA, general.id, 'x'.repeat(2001))).status, 400);
});

test('channel messages: idempotency key semantics', async () => {
  const { handle } = fixture();
  const cookie = cookiePair(await register(handle, uniqueName()));
  const channels = (await call(handle, ctx('/api/channels', { cookie }))).body;
  const channelId = channels[0].id;
  const key = crypto.randomUUID();

  assert.equal((await sendChannel(handle, cookie, channelId, 'первое', key)).status, 201);
  const retry = await sendChannel(handle, cookie, channelId, 'первое', key);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.id, key);
  const conflict = await sendChannel(handle, cookie, channelId, 'другое', key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'idempotency_conflict');
  const badKey = await call(handle, ctx(`/api/channels/${channelId}/messages`, {
    method: 'POST', cookie, headers: { 'idempotency-key': 'not-a-uuid' }, body: { body: 'x' },
  }));
  assert.equal(badKey.status, 400);
  const history = await call(handle, ctx(`/api/channels/${channelId}/messages`, { cookie }));
  assert.equal(history.body.length, 1);
});

test('message rate limit: capped per user within the window', async () => {
  const { handle } = fixture();
  const cookie = cookiePair(await register(handle, uniqueName()));
  const channels = (await call(handle, ctx('/api/channels', { cookie }))).body;
  const channelId = channels[0].id;

  const statuses = [];
  for (let i = 0; i < LIMITS.message.maxAttempts + 1; i += 1) {
    statuses.push((await sendChannel(handle, cookie, channelId, `msg ${i}`)).status);
  }
  assert.equal(statuses.filter((s) => s === 201).length, LIMITS.message.maxAttempts);
  assert.equal(statuses.at(-1), 429);
});

test('DM: one thread per pair, membership enforced, messages isolated', async () => {
  const { handle } = fixture();
  const a = await register(handle, uniqueName('alpha'));
  const b = await register(handle, uniqueName('bravo'));
  const c = await register(handle, uniqueName('charlie'));
  const cookieA = cookiePair(a), cookieB = cookiePair(b), cookieC = cookiePair(c);

  const openAB = await call(handle, ctx('/api/dm', { method: 'POST', cookie: cookieA, body: { userId: b.body.user.id } }));
  assert.equal(openAB.status, 201);
  assert.deepEqual(openAB.body.peer, {
    id: b.body.user.id, nickname: b.body.user.nickname, class_key: 'warrior', avatar_updated_at: null,
  });

  // Opening from the other side returns the same thread.
  const openBA = await call(handle, ctx('/api/dm', { method: 'POST', cookie: cookieB, body: { userId: a.body.user.id } }));
  assert.equal(openBA.status, 200);
  assert.equal(openBA.body.id, openAB.body.id);

  const threadId = openAB.body.id;
  const sent = await call(handle, ctx(`/api/dm/${threadId}/messages`, {
    method: 'POST', cookie: cookieA, headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: 'личное привет' },
  }));
  assert.equal(sent.status, 201);
  const reply = await call(handle, ctx(`/api/dm/${threadId}/messages`, {
    method: 'POST', cookie: cookieB, headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: 'и тебе привет' },
  }));
  assert.equal(reply.status, 201);

  const historyB = await call(handle, ctx(`/api/dm/${threadId}/messages`, { cookie: cookieB }));
  assert.deepEqual(historyB.body.map((m) => m.body), ['личное привет', 'и тебе привет']);

  // A third user must not read or write this thread; missing and foreign look identical.
  assert.equal((await call(handle, ctx(`/api/dm/${threadId}/messages`, { cookie: cookieC }))).status, 404);
  const foreignWrite = await call(handle, ctx(`/api/dm/${threadId}/messages`, {
    method: 'POST', cookie: cookieC, headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: 'взлом' },
  }));
  assert.equal(foreignWrite.status, 404);
  assert.equal((await call(handle, ctx(`/api/dm/${crypto.randomUUID()}/messages`, { cookie: cookieA }))).status, 404);

  // Thread lists are scoped to the participant.
  const listA = await call(handle, ctx('/api/dm', { cookie: cookieA }));
  assert.equal(listA.body.length, 1);
  assert.deepEqual(listA.body[0].peer, {
    id: b.body.user.id, nickname: b.body.user.nickname, class_key: 'warrior', avatar_updated_at: null,
  });
  const listC = await call(handle, ctx('/api/dm', { cookie: cookieC }));
  assert.deepEqual(listC.body, []);

  // Self-DM and unknown targets are rejected.
  assert.equal((await call(handle, ctx('/api/dm', { method: 'POST', cookie: cookieA, body: { userId: a.body.user.id } }))).status, 400);
  assert.equal((await call(handle, ctx('/api/dm', { method: 'POST', cookie: cookieA, body: { userId: crypto.randomUUID() } }))).status, 404);
  assert.equal((await call(handle, ctx('/api/dm'))).status, 401);
});

test('members: list requires login and exposes only public profile fields', async () => {
  const { handle } = fixture();
  assert.equal((await call(handle, ctx('/api/users'))).status, 401);
  const a = await register(handle, uniqueName('alpha'));
  await register(handle, uniqueName('bravo'));
  const list = await call(handle, ctx('/api/users', { cookie: cookiePair(a) }));
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 2);
  for (const member of list.body) {
    assert.deepEqual(Object.keys(member).sort(), ['avatar_updated_at', 'class_key', 'id', 'nickname']);
  }
  assert.ok(list.body.every((m) => !('password_hash' in m) && !('username' in m)));
});

// ----- Profile, classes and avatars -----

const PNG_BYTES = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
));
const uploadAvatar = (handle, cookie, bytes) => call(handle, ctx('/api/me/avatar', {
  method: 'POST', cookie, body: { dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` },
}));

test('register: profile fields are required and validated', async () => {
  const { handle } = fixture();

  const missing = await call(handle, ctx('/api/register', {
    method: 'POST', body: { username: uniqueName(), password: PASSWORD, last_name: 'Иванов', nickname: 'ник', class_key: 'warrior' },
  }));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'invalid_real_name');

  const digitName = await call(handle, ctx('/api/register', {
    method: 'POST',
    body: {
      username: uniqueName(), password: PASSWORD,
      first_name: '123', last_name: 'Иванов', nickname: 'ник', class_key: 'warrior',
    },
  }));
  assert.equal(digitName.status, 400);
  assert.equal(digitName.body.error, 'invalid_real_name');

  const badNick = await call(handle, ctx('/api/register', {
    method: 'POST',
    body: {
      username: uniqueName(), password: PASSWORD,
      first_name: 'Иван', last_name: 'Иванов', nickname: 'x', class_key: 'warrior',
    },
  }));
  assert.equal(badNick.status, 400);
  assert.equal(badNick.body.error, 'invalid_nickname');

  const badClass = await call(handle, ctx('/api/register', {
    method: 'POST',
    body: {
      username: uniqueName(), password: PASSWORD,
      first_name: 'Иван', last_name: 'Иванов', nickname: 'Лучник', class_key: 'ninja',
    },
  }));
  assert.equal(badClass.status, 400);
  assert.equal(badClass.body.error, 'invalid_class');

  const ok = await call(handle, ctx('/api/register', {
    method: 'POST',
    body: {
      username: uniqueName('frodo'), password: PASSWORD,
      first_name: '  Фродо ', last_name: '  Бэггинс ', nickname: '  Хранитель   Кольца  ', class_key: 'archer',
    },
  }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.first_name, 'Фродо');
  assert.equal(ok.body.user.last_name, 'Бэггинс');
  assert.equal(ok.body.user.nickname, 'Хранитель Кольца');
  assert.equal(ok.body.user.class_key, 'archer');
});

test('profile: owner edits fields, strangers see the real name only in the full profile', async () => {
  const { handle } = fixture();
  const a = await register(handle, uniqueName('alpha'));
  const b = await register(handle, uniqueName('bravo'));
  const cookieA = cookiePair(a);
  const cookieB = cookiePair(b);

  assert.equal((await patchMe(handle, null, { first_name: 'И', last_name: 'И', nickname: 'Игрок', class_key: 'mage' })).status, 401);

  const invalid = await patchMe(handle, cookieA, {
    first_name: 'Иван', last_name: 'Иванов', nickname: 'Игрок', class_key: 'нет-такого',
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'invalid_class');
  assert.equal((await me(handle, cookieA)).body.user.class_key, 'warrior');

  const updated = await patchMe(handle, cookieA, {
    first_name: '  Пётр ', last_name: 'Сидоров', nickname: '  Тёмный   Маг ', class_key: 'mage',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.user.nickname, 'Тёмный Маг');
  assert.equal(updated.body.user.first_name, 'Пётр');
  assert.equal(updated.body.user.class_key, 'mage');
  assert.equal(updated.body.user.username, a.body.user.username);
  assert.deepEqual((await me(handle, cookieA)).body.user, updated.body.user);

  const members = await call(handle, ctx('/api/users', { cookie: cookieB }));
  const listed = members.body.find((member) => member.id === a.body.user.id);
  assert.deepEqual(listed, {
    id: a.body.user.id, nickname: 'Тёмный Маг', class_key: 'mage', avatar_updated_at: null,
  });
  assert.ok(!('first_name' in listed) && !('last_name' in listed));

  const full = await call(handle, ctx(`/api/users/${a.body.user.id}/profile`, { cookie: cookieB }));
  assert.equal(full.status, 200);
  assert.deepEqual(full.body, {
    id: a.body.user.id, first_name: 'Пётр', last_name: 'Сидоров',
    nickname: 'Тёмный Маг', class_key: 'mage', avatar_updated_at: null,
  });
  assert.ok(!('username' in full.body));

  assert.equal((await call(handle, ctx(`/api/users/${a.body.user.id}/profile`))).status, 401);
  assert.equal((await call(handle, ctx(`/api/users/${crypto.randomUUID()}/profile`, { cookie: cookieB }))).status, 404);
  assert.equal((await call(handle, ctx('/api/users/not-a-uuid/profile', { cookie: cookieB }))).status, 404);
  assert.equal((await call(handle, ctx(`/api/users/${a.body.user.id}/profile`, { method: 'POST', cookie: cookieB, body: {} }))).status, 405);
});

test('profile changes apply to old messages and DM peers', async () => {
  const { handle } = fixture();
  const a = await register(handle, uniqueName('alpha'));
  const b = await register(handle, uniqueName('bravo'));
  const cookieA = cookiePair(a), cookieB = cookiePair(b);
  const channels = (await call(handle, ctx('/api/channels', { cookie: cookieA }))).body;
  const channelId = channels[0].id;

  assert.equal((await sendChannel(handle, cookieA, channelId, 'сообщение до переименования')).status, 201);

  await patchMe(handle, cookieA, {
    first_name: a.body.user.first_name, last_name: a.body.user.last_name,
    nickname: 'Стражник', class_key: 'guardian',
  });
  const history = await call(handle, ctx(`/api/channels/${channelId}/messages`, { cookie: cookieB }));
  assert.equal(history.body[0].author_name, 'Стражник');
  assert.equal(history.body[0].author_class, 'guardian');
  assert.equal(history.body[0].author_avatar, null);

  const opened = await call(handle, ctx('/api/dm', { method: 'POST', cookie: cookieA, body: { userId: b.body.user.id } }));
  assert.equal(opened.status, 201);
  await patchMe(handle, cookieB, {
    first_name: b.body.user.first_name, last_name: b.body.user.last_name,
    nickname: 'Браво', class_key: 'sorcerer',
  });
  const threads = await call(handle, ctx('/api/dm', { cookie: cookieA }));
  assert.deepEqual(threads.body[0].peer, {
    id: b.body.user.id, nickname: 'Браво', class_key: 'sorcerer', avatar_updated_at: null,
  });
});

test('avatar: validated, stored, served to members with ETag, removable', async () => {
  const { db, handle } = fixture();
  const a = await register(handle, uniqueName('alpha'));
  const b = await register(handle, uniqueName('bravo'));
  const cookieA = cookiePair(a), cookieB = cookiePair(b);

  const wrongType = await call(handle, ctx('/api/me/avatar', {
    method: 'POST', cookie: cookieA, body: { dataUrl: 'data:text/plain;base64,aGk=' },
  }));
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.body.error, 'invalid_avatar');
  assert.equal((await call(handle, ctx('/api/me/avatar', { method: 'POST', body: { dataUrl: 'data:image/png;base64,AA==' } }))).status, 401);

  const huge = new Uint8Array(60 * 1024);
  huge.set(PNG_BYTES.subarray(0, 8));
  const tooLarge = await uploadAvatar(handle, cookieA, huge);
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error, 'avatar_too_large');

  const badMagic = await uploadAvatar(handle, cookieA, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]));
  assert.equal(badMagic.status, 400);
  assert.equal(badMagic.body.error, 'invalid_avatar');

  const saved = await uploadAvatar(handle, cookieA, PNG_BYTES);
  assert.equal(saved.status, 200);
  assert.equal(typeof saved.body.user.avatar_updated_at, 'string');
  const row = db.dump('users').find((user) => user.id === a.body.user.id);
  assert.equal(row.avatar_mime, 'image/png');
  assert.equal(row.avatar_data.length, PNG_BYTES.length);

  await sendChannel(handle, cookieA, (await call(handle, ctx('/api/channels', { cookie: cookieA }))).body[0].id, 'с фото');
  const history = await call(handle, ctx(`/api/channels/${(await call(handle, ctx('/api/channels', { cookie: cookieA }))).body[0].id}/messages`, { cookie: cookieB }));
  assert.equal(history.body[0].author_avatar, saved.body.user.avatar_updated_at);

  assert.equal((await handle(ctx(`/api/avatars/${a.body.user.id}`))).status, 401);
  assert.equal((await handle(ctx(`/api/avatars/${crypto.randomUUID()}`, { cookie: cookieB }))).status, 404);

  const image = await handle(ctx(`/api/avatars/${a.body.user.id}`, { cookie: cookieB }));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.match(image.headers.get('cache-control') ?? '', /private/);
  const etag = image.headers.get('etag');
  assert.ok(etag);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), PNG_BYTES);

  const cached = await handle(ctx(`/api/avatars/${a.body.user.id}`, { cookie: cookieB, headers: { 'if-none-match': etag } }));
  assert.equal(cached.status, 304);

  assert.equal((await call(handle, ctx(`/api/avatars/${a.body.user.id}`, { method: 'DELETE', cookie: cookieA }))).status, 405);

  const removed = await call(handle, ctx('/api/me/avatar', { method: 'DELETE', cookie: cookieA }));
  assert.equal(removed.status, 200);
  assert.equal(removed.body.user.avatar_updated_at, null);
  assert.equal(db.dump('users').find((user) => user.id === a.body.user.id).avatar_data, null);
  assert.equal((await handle(ctx(`/api/avatars/${a.body.user.id}`, { cookie: cookieB }))).status, 404);

  assert.equal((await call(handle, ctx('/api/me/avatar', { method: 'DELETE' }))).status, 401);
});
/* ----- voice ----- */

test('voice: configuration needs a Telemost token or a Telemost room link', () => {
  assert.equal(voiceConfig({}), null);
  assert.equal(voiceConfig({ YANDEX_TELEMOST_TOKEN: 'short' }), null);
  assert.equal(voiceConfig({ YANDEX_TELEMOST_TOKEN: `y0_${'t'.repeat(30)} has space` }), null);
  assert.equal(voiceConfig({ VOICE_ROOM_URL: 'https://evil.test/j/1' }), null);
  assert.equal(voiceConfig({ VOICE_ROOM_URL: 'http://telemost.yandex.ru/j/1' }), null);
  assert.deepEqual(voiceConfig({ YANDEX_TELEMOST_TOKEN: TEST_VOICE.token }),
    { token: TEST_VOICE.token, staticUrl: null, links: {} });
  assert.deepEqual(voiceConfig({ VOICE_ROOM_URL: 'https://telemost.yandex.ru/j/42' }),
    { token: null, staticUrl: 'https://telemost.yandex.ru/j/42', links: {} });
  const perChannel = voiceConfig({
    VOICE_ROOM_URLS: JSON.stringify({
      'общий': 'https://telemost.yandex.ru/j/a',
      'флуд': 'https://evil.test/j/b',
    }),
  });
  assert.deepEqual(perChannel.links, { 'общий': 'https://telemost.yandex.ru/j/a' });
  assert.equal(voiceConfig({ VOICE_ROOM_URLS: '{broken' }), null);
});

test('voice: session, channel existence and method are enforced', async () => {
  const { handle } = fixture();
  const a = await register(handle, uniqueName('voice'));
  const cookie = cookiePair(a);
  const general = (await call(handle, ctx('/api/channels', { cookie }))).body.find((c) => c.name === 'общий');

  assert.equal((await call(handle, ctx(`/api/channels/${general.id}/voice`, { method: 'POST' }))).status, 401);
  assert.equal((await call(handle, ctx(`/api/channels/${general.id}/voice`, { cookie }))).status, 405);
  assert.equal((await call(handle, ctx('/api/channels/not-a-uuid/voice', { method: 'POST', cookie }))).status, 404);
  const missing = await call(handle, ctx(`/api/channels/${crypto.randomUUID()}/voice`, { method: 'POST', cookie }));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'channel_not_found');

  const forged = await call(handle, ctx(`/api/channels/${general.id}/voice`, {
    method: 'POST', cookie, origin: 'https://evil.test',
  }));
  assert.equal(forged.status, 403);
});

test('voice: one Telemost room per channel is created and then reused', async () => {
  const { calls, fetchImpl } = fakeTelemost();
  const { handle } = fixture({ fetchImpl });
  const a = await register(handle, uniqueName('voice'));
  const cookie = cookiePair(a);
  const general = (await call(handle, ctx('/api/channels', { cookie }))).body.find((c) => c.name === 'общий');

  const first = await call(handle, ctx(`/api/channels/${general.id}/voice`, { method: 'POST', cookie }));
  assert.equal(first.status, 200);
  assert.equal(first.body.join_url, `${TELEMOST_ORIGIN}/j/conf-1`);
  assert.equal(first.body.shared, false);
  assert.deepEqual(first.body.channel, { id: general.id, name: 'общий' });
  assert.ok(Date.parse(first.body.expires_at) > Date.now());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cloud-api.yandex.net/v1/telemost-api/conferences');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `OAuth ${TEST_VOICE.token}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { waiting_room_level: 'PUBLIC' });

  // Everyone who clicks the button in the same channel must land in the same room.
  const again = await call(handle, ctx(`/api/channels/${general.id}/voice`, { method: 'POST', cookie }));
  assert.equal(again.status, 200);
  assert.equal(again.body.join_url, first.body.join_url);
  assert.equal(calls.length, 1);

  const created = await call(handle, ctx('/api/channels', {
    method: 'POST', cookie, body: { name: `voice-${crypto.randomUUID().slice(0, 8)}` },
  }));
  assert.equal(created.status, 201);
  const other = await call(handle, ctx(`/api/channels/${created.body.id}/voice`, { method: 'POST', cookie }));
  assert.equal(other.status, 200);
  assert.equal(other.body.join_url, `${TELEMOST_ORIGIN}/j/conf-2`);
  assert.equal(calls.length, 2);
});

test('voice: a Telemost failure is reported without leaking provider details', async () => {
  const { fetchImpl } = fakeTelemost({ fail: true });
  const { handle } = fixture({ fetchImpl });
  const a = await register(handle, uniqueName('voice'));
  const cookie = cookiePair(a);
  const general = (await call(handle, ctx('/api/channels', { cookie }))).body[0];
  const result = await call(handle, ctx(`/api/channels/${general.id}/voice`, { method: 'POST', cookie }));
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'voice_upstream_failed');
});

test('voice: manual links can differ per channel', async () => {
  const voice = { token: null, staticUrl: null, links: { 'общий': 'https://telemost.yandex.ru/j/room-a' } };
  const { handle } = fixture({ voice });
  const a = await register(handle, uniqueName('voice'));
  const cookie = cookiePair(a);
  const channels = (await call(handle, ctx('/api/channels', { cookie }))).body;
  const general = channels.find((c) => c.name === 'общий');
  const flood = channels.find((c) => c.name === 'флуд');
  const ok = await call(handle, ctx(`/api/channels/${general.id}/voice`, { method: 'POST', cookie }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.join_url, 'https://telemost.yandex.ru/j/room-a');
  const missing = await call(handle, ctx(`/api/channels/${flood.id}/voice`, { method: 'POST', cookie }));
  assert.equal(missing.status, 503);
  assert.equal(missing.body.error, 'voice_unavailable');
});

test('voice: a configured shared room works without any API token', async () => {
  const staticUrl = 'https://telemost.yandex.ru/j/shared-room';
  const { calls, fetchImpl } = fakeTelemost();
  const { handle } = fixture({ voice: { token: null, staticUrl }, fetchImpl });
  const a = await register(handle, uniqueName('voice'));
  const cookie = cookiePair(a);
  const general = (await call(handle, ctx('/api/channels', { cookie }))).body[0];
  const result = await call(handle, ctx(`/api/channels/${general.id}/voice`, { method: 'POST', cookie }));
  assert.equal(result.status, 200);
  assert.equal(result.body.join_url, staticUrl);
  assert.equal(result.body.shared, true);
  assert.equal(result.body.expires_at, null);
  assert.equal(calls.length, 0);
});

test('voice: missing configuration reports the feature as unavailable', async () => {
  const { handle } = fixture({ voice: null });
  const a = await register(handle, uniqueName('voice'));
  const cookie = cookiePair(a);
  const general = (await call(handle, ctx('/api/channels', { cookie }))).body[0];
  const result = await call(handle, ctx(`/api/channels/${general.id}/voice`, { method: 'POST', cookie }));
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'voice_unavailable');
});
