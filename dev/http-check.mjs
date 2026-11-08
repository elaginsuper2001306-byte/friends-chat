// Local two-user integration check against the running HTTPS preview (in-memory DB).
// Run: NODE_TLS_REJECT_UNAUTHORIZED=0 node dev/http-check.mjs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = 'https://localhost:8443/functions/v1/app';
const ORIGIN = 'https://localhost:8443';

function jar() {
  let cookie = '';
  return {
    async call(path, { method = 'GET', body, headers = {} } = {}) {
      const res = await fetch(BASE + path, {
        method,
        headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch {}
      return { status: res.status, data, headers: res.headers };
    },
  };
}

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok:', msg); };
const suffix = crypto.randomUUID().slice(0, 6);
const alice = jar();
const bob = jar();
const profile = (nickname, classKey) => ({
  first_name: 'Тест', last_name: 'Тестов', nickname, class_key: classKey,
});

const ra = await alice.call('/api/register', {
  method: 'POST', body: { username: `alice${suffix}`, password: 'password-12345', ...profile(`Алиса${suffix}`, 'mage') },
});
assert(ra.status === 201, 'alice registered');
const rb = await bob.call('/api/register', {
  method: 'POST', body: { username: `bob${suffix}`, password: 'password-12345', ...profile(`Боб${suffix}`, 'warrior') },
});
assert(rb.status === 201, 'bob registered');

const users = await alice.call('/api/users');
const bobUser = users.data.find((u) => u.nickname === `Боб${suffix}`);
assert(bobUser, 'alice sees bob in members');

const open = await alice.call('/api/dm', { method: 'POST', body: { userId: bobUser.id } });
assert(open.status === 201 && open.data.peer.nickname === `Боб${suffix}`, 'alice opens DM with bob');
const threadId = open.data.id;

const send = await alice.call(`/api/dm/${threadId}/messages`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: 'привет, боб!' } });
assert(send.status === 201, 'alice sends DM');

const bobList = await bob.call('/api/dm');
assert(bobList.data.some((t) => t.id === threadId), 'bob sees the thread');
const bobRead = await bob.call(`/api/dm/${threadId}/messages`);
assert(bobRead.data.some((m) => m.body === 'привет, боб!'), 'bob reads alice message');

const reply = await bob.call(`/api/dm/${threadId}/messages`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: 'привет, алиса!' } });
assert(reply.status === 201, 'bob replies');
const aliceRead = await alice.call(`/api/dm/${threadId}/messages`);
assert(aliceRead.data.some((m) => m.body === 'привет, алиса!'), 'alice reads bob reply');

// bob opening the same pair returns the same thread
const reopen = await bob.call('/api/dm', { method: 'POST', body: { userId: ra.data.user.id } });
assert(reopen.status === 200 && reopen.data.id === threadId, 'same pair reuses one thread');

const renamed = await alice.call('/api/me', {
  method: 'PATCH', body: { first_name: 'Алиса', last_name: 'Тестова', nickname: `Аля${suffix}`, class_key: 'assassin' },
});
assert(renamed.status === 200 && renamed.data.user.nickname === `Аля${suffix}`, 'alice edits her profile');

const full = await bob.call(`/api/users/${ra.data.user.id}/profile`);
assert(full.status === 200 && full.data.last_name === 'Тестова' && !('username' in full.data), 'bob sees the real name in the full profile');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const avatar = await alice.call('/api/me/avatar', { method: 'POST', body: { dataUrl: `data:image/png;base64,${png}` } });
assert(avatar.status === 200 && typeof avatar.data.user.avatar_updated_at === 'string', 'alice uploads an avatar');
const image = await bob.call(`/api/avatars/${ra.data.user.id}`);
assert(image.status === 200 && image.headers.get('content-type') === 'image/png', 'bob can load the avatar image');
const removed = await alice.call('/api/me/avatar', { method: 'DELETE' });
assert(removed.status === 200 && removed.data.user.avatar_updated_at === null, 'alice removes the avatar');

console.log('\nALL HTTP CHECKS PASSED');