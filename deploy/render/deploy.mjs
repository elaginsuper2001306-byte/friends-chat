// Publishes the app to Render (free, no card) from a GitHub repository.
// Reads DATABASE_URL, GITHUB_TOKEN and RENDER_API_KEY from .env.local.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  process.loadEnvFile(join(root, '.env.local'));
} catch {
  // Values may come from the environment instead.
}

const databaseUrl = String(process.env.DATABASE_URL ?? '').trim();
const githubToken = String(process.env.GITHUB_TOKEN ?? '').trim();
const renderKey = String(process.env.RENDER_API_KEY ?? '').trim();
const statePath = join(root, 'deploy/render/service.json');

if (!githubToken || !renderKey) {
  console.log(`Сайт у Вас не открывается из-за блокировки Vercel, а Яндекс просит карту.
Есть бесплатный путь без карты: Render.com + GitHub. Оба открываются в РФ.

Что нужно сделать один раз (10–15 минут):

1. GitHub. Если аккаунта нет — зарегистрируйтесь на https://github.com/signup
   (нужны только почта и пароль).
2. Создайте ключ: https://github.com/settings/tokens → «Generate new token (classic)»
   → имя «friends-chat», срок 90 дней, галочка «repo» → «Generate token».
   Скопируйте строку вида ghp_...
3. Render. Зарегистрируйтесь на https://dashboard.render.com/register
   (карта не нужна, бесплатный тариф Hobby).
4. В Render откройте «Account Settings» → «API Keys» → «Create API Key».
   Скопируйте ключ вида rnd_...
5. В файле .env.local в папке проекта добавьте две строки:
   GITHUB_TOKEN=ваш_ключ_github
   RENDER_API_KEY=ваш_ключ_render
   Ключи никому не отправляйте и в чат не вставляйте.
6. Снова запустите: node deploy/render/deploy.mjs

Код будет лежать в публичном репозитории GitHub (пароли и ключи туда не попадают —
они хранятся только в .env.local и в настройках Render). Сайт при этом закрыт входом.`);
  process.exitCode = 2;
} else if (!databaseUrl) {
  console.error('В .env.local нет DATABASE_URL — без базы сайт работать не будет.');
  process.exitCode = 2;
} else {
  await main().catch((error) => {
    console.error('\nНе удалось развернуть:', error.message);
    process.exitCode = 1;
  });
}

async function main() {
  commitFiles();
  const repo = await ensureGithubRepo();
  pushToGitHub(repo);

  const state = await readState();
  let service = state ? await getService(state.id).catch(() => null) : null;
  let deployId = null;
  let fresh = false;

  if (!service) {
    const created = await createService(repo);
    service = created.service;
    deployId = created.deployId;
    fresh = true;
    await writeFile(statePath, JSON.stringify({
      id: service.id,
      name: service.name,
      url: service.serviceDetails?.url,
    }, null, 2));
  }

  const url = (service.serviceDetails?.url ?? `https://${service.name}.onrender.com`).replace(/\/+$/, '');
  const predicted = `https://${service.name}.onrender.com`;
  const urlChanged = url !== predicted;
  if (!fresh || urlChanged) await updateEnv(service.id, url);
  if (!fresh || urlChanged || !deployId) deployId = await triggerDeploy(service.id);
  if (deployId) await waitDeploy(service.id, deployId);

  await waitForSite(url);
  console.log('сайт отвечает');
  await registerTestAccount(url);
  console.log('вход и регистрация работают');

  console.log(`\nГотово. Сайт в РФ: ${url}\n`);
  console.log('После 15 минут без посетителей Render «засыпает»: первое открытие');
  console.log('займёт до минуты, дальше всё работает быстро. База и аккаунты прежние.');
  console.log('Обновление после правок: node deploy/render/deploy.mjs');
}

function run(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch (error) {
    if (options.allowFail) return null;
    const details = String(error.stderr ?? error.stdout ?? error.message).trim();
    throw new Error(`git ${args[0]} ${details.includes('Authentication failed') ? '— GitHub отклонил ключ. Проверьте GITHUB_TOKEN.' : `— ${details}`}`);
  }
}

function commitFiles() {
  if (!run(['rev-parse', '--git-dir'], { allowFail: true })) run(['init', '-b', 'main']);
  if (!run(['config', 'user.email'], { allowFail: true })) run(['config', 'user.email', 'deploy@friends-chat.local']);
  if (!run(['config', 'user.name'], { allowFail: true })) run(['config', 'user.name', 'friends-chat']);
  run(['add', '-A']);
  if (run(['status', '--porcelain'])) {
    run(['commit', '-m', 'deploy: friends chat']);
  }
  const branch = run(['branch', '--show-current'], { allowFail: true });
  if (branch && branch !== 'main') run(['branch', '-M', 'main']);
}

async function github(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'friends-chat-deploy',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (response.status === 401) throw new Error('GitHub отклонил GITHUB_TOKEN. Создайте новый ключ с галочкой «repo».');
  return { status: response.status, data };
}

async function ensureGithubRepo() {
  const me = await github('GET', '/user');
  if (me.status !== 200) throw new Error('не удалось прочитать аккаунт GitHub. Проверьте GITHUB_TOKEN.');
  const login = me.data.login;

  const existing = await github('GET', `/repos/${login}/friends-chat`);
  if (existing.status === 200) {
    if ((existing.data.size ?? 0) > 0) {
      const pkg = await github('GET', `/repos/${login}/friends-chat/contents/package.json`);
      const content = pkg.data?.content ? Buffer.from(pkg.data.content, 'base64').toString('utf8') : '';
      if (!content.includes('"name": "friends-chat"')) {
        throw new Error('в вашем GitHub уже есть репозиторий friends-chat с другим содержимым. Переименуйте или удалите его и повторите запуск.');
      }
    }
    return `${login}/friends-chat`;
  }

  const created = await github('POST', '/user/repos', {
    name: 'friends-chat',
    private: false,
    description: 'Чат друзей',
    auto_init: false,
  });
  if (created.status === 201) return `${login}/friends-chat`;
  console.error('GitHub не дал создать репозиторий. Скорее всего ключ создан как «fine-grained»');
  console.error('и не имеет прав. Создайте classic-токен: https://github.com/settings/tokens/new');
  console.error('Name: friends-chat, Expiration: 90 days, галочка «repo» → Generate token.');
  console.error('Замените строку GITHUB_TOKEN в .env.local и запустите скрипт снова.');
  throw new Error(created.data?.message ?? `GitHub вернул HTTP ${created.status}`);
}

function pushToGitHub(repo) {
  const auth = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
  if (run(['remote', 'get-url', 'origin'], { allowFail: true })) {
    run(['remote', 'set-url', 'origin', `https://github.com/${repo}.git`]);
  } else {
    run(['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
  }
  const pushed = run(['-c', `http.extraheader=Authorization: Basic ${auth}`, 'push', '-u', 'origin', 'main'], { allowFail: true });
  if (pushed === null) {
    throw new Error('не удалось отправить код на GitHub. Если репозиторий friends-chat уже существовал и не пуст, создайте новый пустой репозиторий и поменяйте его имя в deploy/render/deploy.mjs.');
  }
}

async function render(method, path, body) {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${renderKey}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (response.status === 401) throw new Error('Render отклонил RENDER_API_KEY. Создайте новый ключ в Account Settings → API Keys.');
  if (!response.ok) {
    const error = new Error(data?.message ?? `Render вернул HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function getService(id) {
  return render('GET', `/services/${id}`);
}

async function createService(repo) {
  const owners = await render('GET', '/owners?limit=20');
  const ownerId = owners?.[0]?.owner?.id;
  if (!ownerId) throw new Error('в Render не найден рабочий кабинет (workspace).');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = `friends-chat-${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
    try {
      const result = await render('POST', '/services', {
        type: 'web_service',
        name,
        ownerId,
        repo: `https://github.com/${repo}`,
        branch: 'main',
        autoDeployTrigger: 'off',
        envVars: desiredEnv(`https://${name}.onrender.com`),
        serviceDetails: {
          runtime: 'node',
          plan: 'free',
          region: 'frankfurt',
          envSpecificDetails: {
            buildCommand: 'npm install --omit=dev',
            startCommand: 'node server/index.mjs',
          },
          healthCheckPath: '/api/health',
        },
      });
      const service = result.service ?? result;
      return { service, deployId: result.deployId ?? null };
    } catch (error) {
      if (error.status === 409 || /already exists|taken/i.test(error.message)) continue;
      if (/repository|repo/i.test(error.message)) {
        throw new Error(`${error.message}\nRender не смог прочитать публичный репозиторий. Проверьте, что он существует и открыт: https://github.com/${repo}`);
      }
      throw error;
    }
  }
  throw new Error('не удалось подобрать свободное имя сайта в Render.');
}

function desiredEnv(url) {
  const values = {
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    APP_ORIGIN: url,
  };
  for (const name of ['VOICE_ROOM_URL', 'VOICE_ROOM_URLS', 'YANDEX_TELEMOST_TOKEN', 'VOICE_ICE_SERVERS']) {
    const value = String(process.env[name] ?? '').trim();
    if (value) values[name] = value;
  }
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

async function updateEnv(serviceId, url) {
  await render('PUT', `/services/${serviceId}/env-vars`, desiredEnv(url));
}

async function triggerDeploy(serviceId) {
  const deploy = await render('POST', `/services/${serviceId}/deploys`, {});
  return deploy?.deploy?.id ?? deploy?.id ?? null;
}

async function waitDeploy(serviceId, deployId) {
  const deadline = Date.now() + 25 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const data = await render('GET', `/services/${serviceId}/deploys/${deployId}`);
    const deploy = data?.deploy ?? data;
    const status = deploy?.status ?? 'unknown';
    if (status !== last) {
      console.log('сборка:', status);
      last = status;
    }
    if (status === 'live') return;
    if (['build_failed', 'update_failed', 'canceled', 'pre_deploy_failed'].includes(status)) {
      throw new Error(`сборка Render завершилась статусом ${status}. Подробности на https://dashboard.render.com`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error('Render собирает сайт дольше 25 минут. Проверьте статус на https://dashboard.render.com и запустите скрипт снова.');
}

async function waitForSite(url) {
  const deadline = Date.now() + 6 * 60_000;
  let last = 'нет ответа';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`сайт не ответил за 6 минут (${last}).`);
}

async function registerTestAccount(url) {
  const username = `rcf${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const password = crypto.randomUUID() + 'Aa!';
  let userId = null;
  try {
    const response = await fetch(`${url}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({
        username,
        password,
        first_name: 'Тест',
        last_name: 'Развёртывание',
        nickname: 'ТестРазвёртывание',
        class_key: 'warrior',
      }),
    });
    if (response.status !== 201) throw new Error(`регистрация вернула HTTP ${response.status}`);
    const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
    const me = await fetch(`${url}/api/me`, { headers: { cookie } });
    const data = await me.json();
    userId = data.user?.id ?? null;
    if (me.status !== 200 || !userId) throw new Error('не удалось прочитать профиль после регистрации.');
  } finally {
    const pool = new pg.Pool({ connectionString: databaseUrl, ssl: true, max: 1 });
    try {
      if (userId) {
        await pool.query('DELETE FROM app.sessions WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM app.channel_messages WHERE author_id = $1', [userId]);
        await pool.query('DELETE FROM app.dm_messages WHERE author_id = $1', [userId]);
        await pool.query('DELETE FROM app.users WHERE id = $1', [userId]);
      }
      await pool.query('DELETE FROM app.auth_limiter WHERE key LIKE $1', [`%${username}%`]);
    } finally {
      await pool.end();
    }
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return null;
  }
}
