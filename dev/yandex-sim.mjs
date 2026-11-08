// Local simulation of the API Gateway v2.0 event for the Yandex handler.
// Creates one throwaway account, checks the main routes, then removes it.
import { createRequire } from 'node:module';
import pg from 'pg';

process.loadEnvFile('.env.local');
process.env.APP_ORIGIN = 'https://friends-chat-test.apigw.yandexcloud.net';
if (process.env.HANDLER_PATH) delete process.env.APP_ROOT;
else process.env.APP_ROOT = process.cwd();

const require = createRequire(import.meta.url);
const { handler } = require(process.env.HANDLER_PATH ?? '../deploy/yandex/index.cjs');

const origin = process.env.APP_ORIGIN;
const username = `ycf${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
const password = 'correct horse battery staple';

function event(rawPath, { method = 'GET', body = null, cookie = null } = {}) {
  return {
    rawPath,
    rawQueryString: '',
    requestContext: { http: { method } },
    headers: {
      origin,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    cookies: cookie ? [cookie] : [],
    body,
    isBase64Encoded: false,
  };
}

const results = [];
async function check(name, promise, expected) {
  const response = await promise;
  results.push({ name, status: response.statusCode, ok: response.statusCode === expected });
  return response;
}

let userId = null;
try {
  await check('health', handler(event('/api/health')), 200);

  const registered = await check('register', handler(event('/api/register', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password,
      first_name: 'Тест',
      last_name: 'Яндекс',
      nickname: 'ТестЯндекс',
      class_key: 'warrior',
    }),
  })), 201);
  const cookie = registered.cookies?.[0]?.split(';')[0] ?? null;
  results.push({ name: 'session cookie', status: cookie ? 1 : 0, ok: cookie?.includes('app_auth.session=') === true });

  const me = await handler(event('/api/me', { cookie }));
  userId = JSON.parse(me.body).user.id;
  results.push({ name: 'me', status: me.statusCode, ok: me.statusCode === 200 });

  const channels = await check('channels', handler(event('/api/channels', { cookie })), 200);
  const channelId = JSON.parse(channels.body)[0].id;
  await check('messages', handler(event(`/api/channels/${channelId}/messages`, { cookie })), 200);

  const index = await check('static index', handler(event('/')), 200);
  results.push({ name: 'html', status: index.body.length, ok: index.body.includes('<title>Чат друзей</title>') });
  await check('static css', handler(event('/styles.css')), 200);

  const badOrigin = await handler({
    ...event('/api/logout', { method: 'POST', cookie }),
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
  });
  results.push({ name: 'csrf rejected', status: badOrigin.statusCode, ok: badOrigin.statusCode === 403 });
} finally {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: true, max: 1 });
  try {
    if (userId) {
      await pool.query('DELETE FROM app.sessions WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM app.channel_messages WHERE author_id = $1', [userId]);
      await pool.query('DELETE FROM app.dm_messages WHERE author_id = $1', [userId]);
      await pool.query('DELETE FROM app.auth_limiter WHERE key LIKE $1', [`%${username}%`]);
      await pool.query('DELETE FROM app.users WHERE id = $1', [userId]);
    }
    await pool.query('DELETE FROM app.auth_limiter WHERE key LIKE $1', [`%${username}%`]);
    const left = await pool.query('SELECT count(*)::int AS n FROM app.users');
    console.log('users left:', left.rows[0].n);
  } finally {
    await pool.end();
  }
}

for (const result of results) console.log(result.ok ? 'ok  ' : 'FAIL', result.name, result.status);
if (results.some((result) => !result.ok)) process.exitCode = 1;
