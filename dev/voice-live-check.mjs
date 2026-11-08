import { readFileSync } from 'node:fs';
import pg from 'pg';

process.loadEnvFile('.env.local');
const env = { DATABASE_URL: String(process.env.DATABASE_URL ?? '').trim() };

const url = (process.argv[2] ?? JSON.parse(readFileSync('deploy/render/service.json', 'utf8')).url).replace(/\/+$/, '');
const username = `vcf${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
const password = crypto.randomUUID() + 'Aa!';
let userId = null;
let failed = false;

try {
  const registered = await fetch(`${url}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({
      username,
      password,
      first_name: 'Проверка',
      last_name: 'Голоса',
      nickname: 'ПроверкаГолоса',
      class_key: 'warrior',
    }),
  });
  if (registered.status !== 201) throw new Error(`регистрация: HTTP ${registered.status}`);
  const cookie = registered.headers.getSetCookie()[0]?.split(';')[0];
  const me = await (await fetch(`${url}/api/me`, { headers: { cookie } })).json();
  userId = me.user?.id ?? null;
  if (!userId) throw new Error('нет профиля после регистрации');

  const channels = await (await fetch(`${url}/api/channels`, { headers: { cookie } })).json();
  const channel = channels.find((item) => item.name === 'общий') ?? channels[0];
  if (!channel) throw new Error('нет ни одного канала');

  const response = await fetch(`${url}/api/channels/${channel.id}/voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: url },
    body: '{}',
  });
  const text = await response.text();
  console.log(`канал «${channel.name}»: HTTP ${response.status}`);
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (body) {
    const join = body.join_url ? new URL(body.join_url) : null;
    console.log(`ключи: ${Object.keys(body).join(', ')}`);
    console.log(`ссылка: ${join ? join.origin + join.pathname.slice(0, 12) + '…' : 'нет'}`);
    console.log(`общая комната: ${body.shared === true ? 'да' : body.shared === false ? 'нет (создана на канале)' : '?'}`);
  } else {
    console.log(`тело: ${text.slice(0, 120)}`);
  }
  if (response.status !== 200 || !body?.join_url) failed = true;
} catch (error) {
  failed = true;
  console.error('ошибка проверки:', error.message);
} finally {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: true, max: 1 });
  try {
    if (userId) {
      await pool.query('DELETE FROM app.sessions WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM app.channel_messages WHERE author_id = $1', [userId]);
      await pool.query('DELETE FROM app.dm_messages WHERE author_id = $1', [userId]);
      await pool.query('DELETE FROM app.users WHERE id = $1', [userId]);
    }
    await pool.query('DELETE FROM app.auth_limiter WHERE key LIKE $1', [`%${username}%`]);
    const left = await pool.query("SELECT count(*)::int AS n FROM app.users");
    console.log(`пользователей в базе: ${left.rows[0].n}`);
  } finally {
    await pool.end();
  }
}

if (failed) process.exitCode = 1;
