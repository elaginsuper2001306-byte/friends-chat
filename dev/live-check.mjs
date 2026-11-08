// Live acceptance check against a deployed instance.
// Run: SITE_URL=https://example.vercel.app node dev/live-check.mjs
const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
if (!SITE_URL) {
  console.error('SITE_URL is required');
  process.exit(1);
}

function jar() {
  let cookie = '';
  return {
    async call(pathname, { method = 'GET', body, headers = {}, origin = SITE_URL } = {}) {
      const response = await fetch(SITE_URL + pathname, {
        method,
        headers: {
          ...(origin ? { origin } : {}),
          ...(cookie ? { cookie } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
      if (setCookie) {
        // A cleared cookie (Max-Age=0) must be dropped, like a real browser does.
        cookie = /max-age=0/i.test(setCookie) ? '' : setCookie.split(';')[0];
      }
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      return { status: response.status, data, headers: response.headers, setCookie };
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

const page = await fetch(`${SITE_URL}/`);
const html = await page.text();
check(page.status === 200 && html.includes('Чат друзей'), 'static page is served');
check((page.headers.get('content-security-policy') ?? '').includes("script-src 'self'"), 'CSP is present');

const script = await fetch(`${SITE_URL}/app.js`);
const js = await script.text();
check(script.status === 200 && js.includes("const PATH = '';"), 'frontend uses /api paths');

const health = await alice.call('/api/health');
check(health.status === 200 && health.data?.ok === true, 'health endpoint responds');

const anonymous = await alice.call('/api/channels');
check(anonymous.status === 401, 'channels require login');

const badOrigin = await fetch(`${SITE_URL}/api/register`, {
  method: 'POST',
  headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
  body: JSON.stringify({ username: `evil${suffix}`, password: 'password-12345' }),
});
check(badOrigin.status === 403, 'foreign origin is rejected');

const ra = await alice.call('/api/register', {
  method: 'POST',
  body: {
    username: `alice${suffix}`, password: 'password-12345',
    first_name: 'Алиса', last_name: 'Тестова', nickname: `Алиса${suffix}`, class_key: 'mage',
  },
});
check(ra.status === 201, 'alice registered');
check(/HttpOnly/.test(ra.setCookie ?? '') && /Secure/.test(ra.setCookie ?? '') && /SameSite=Lax/.test(ra.setCookie ?? ''), 'session cookie is hardened');

const rb = await bob.call('/api/register', {
  method: 'POST',
  body: {
    username: `bob${suffix}`, password: 'password-12345',
    first_name: 'Боб', last_name: 'Тестов', nickname: `Боб${suffix}`, class_key: 'warrior',
  },
});
check(rb.status === 201, 'bob registered');

const who = await alice.call('/api/me');
check(who.status === 200 && who.data.user.username === `alice${suffix}`
  && who.data.user.nickname === `Алиса${suffix}` && who.data.user.class_key === 'mage', 'session is valid');

const users = await alice.call('/api/users');
const bobUser = users.data.find((user) => user.nickname === `Боб${suffix}`);
check(Boolean(bobUser), 'members list includes bob');

const channels = await alice.call('/api/channels');
check(channels.status === 200 && channels.data.some((channel) => channel.name === 'общий'), 'default channels exist');
const general = channels.data.find((channel) => channel.name === 'общий');

const key = crypto.randomUUID();
const sent = await alice.call(`/api/channels/${general.id}/messages`, {
  method: 'POST', headers: { 'idempotency-key': key }, body: { body: 'канал работает на хостинге' },
});
check(sent.status === 201, `channel message is stored (got ${sent.status} ${JSON.stringify(sent.data)})`);
const retried = await alice.call(`/api/channels/${general.id}/messages`, {
  method: 'POST', headers: { 'idempotency-key': key }, body: { body: 'канал работает на хостинге' },
});
check(retried.status === 200, 'idempotent retry returns the stored message');

const history = await bob.call(`/api/channels/${general.id}/messages`);
check(history.data.some((message) => message.body === 'канал работает на хостинге'), 'bob reads alice channel message');

const open = await alice.call('/api/dm', { method: 'POST', body: { userId: bobUser.id } });
check(open.status === 201, 'alice opens DM with bob');
const threadId = open.data.id;

const dm = await alice.call(`/api/dm/${threadId}/messages`, {
  method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: 'привет, боб!' },
});
check(dm.status === 201, 'alice sends DM');

const bobRead = await bob.call(`/api/dm/${threadId}/messages`);
check(bobRead.data.some((message) => message.body === 'привет, боб!'), 'bob reads alice DM');

const reply = await bob.call(`/api/dm/${threadId}/messages`, {
  method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: { body: 'привет, алиса!' },
});
check(reply.status === 201, 'bob replies');
const aliceRead = await alice.call(`/api/dm/${threadId}/messages`);
check(aliceRead.data.some((message) => message.body === 'привет, алиса!'), 'alice reads bob reply');

const renamed = await alice.call('/api/me', {
  method: 'PATCH', body: { first_name: 'Алиса', last_name: 'Тестова', nickname: `Аля${suffix}`, class_key: 'assassin' },
});
check(renamed.status === 200 && renamed.data.user.nickname === `Аля${suffix}`, 'profile edit is stored');

const full = await bob.call(`/api/users/${ra.data.user.id}/profile`);
check(full.status === 200 && full.data.last_name === 'Тестова' && full.data.class_key === 'assassin'
  && !('username' in full.data), 'full profile shows the real name and class');

const renamedHistory = await bob.call(`/api/channels/${general.id}/messages`);
check(renamedHistory.data.some((message) => message.author_name === `Аля${suffix}` && message.author_class === 'assassin'),
  'old messages show the updated nickname and class');

const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
));
const avatar = await alice.call('/api/me/avatar', {
  method: 'POST', body: { dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}` },
});
check(avatar.status === 200 && typeof avatar.data.user.avatar_updated_at === 'string', `avatar upload is stored (got ${avatar.status})`);

const image = await bob.call(`/api/avatars/${ra.data.user.id}`);
check(image.status === 200 && image.headers.get('content-type') === 'image/png', 'avatar bytes are served to members');

const withAvatar = await bob.call(`/api/channels/${general.id}/messages`);
check(withAvatar.data.some((message) => message.author_avatar === avatar.data.user.avatar_updated_at),
  'messages carry the avatar version');

const removed = await alice.call('/api/me/avatar', { method: 'DELETE' });
check(removed.status === 200 && removed.data.user.avatar_updated_at === null, 'avatar removal is stored');
check((await bob.call(`/api/avatars/${ra.data.user.id}`)).status === 404, 'removed avatar is gone');

const logout = await alice.call('/api/logout', { method: 'POST' });
check(logout.status === 200, 'logout succeeds');
check((await alice.call('/api/me')).status === 401, 'session is revoked after logout');

console.log(`\nALL LIVE CHECKS PASSED (${SITE_URL})`);
