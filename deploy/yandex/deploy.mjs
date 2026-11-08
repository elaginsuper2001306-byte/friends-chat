// Deploys the site to Yandex Cloud Functions + API Gateway via the REST API.
// Uses YC_OAUTH_TOKEN from .env.local and prints a ready HTTPS address.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  process.loadEnvFile(join(root, '.env.local'));
} catch {
  // .env.local may be absent; values may come from the environment instead.
}

const oauthToken = String(process.env.YC_OAUTH_TOKEN ?? '').trim();
const databaseUrl = String(process.env.DATABASE_URL ?? '').trim();

if (!oauthToken) {
  console.log(`Всё готово к переносу сайта в Яндекс Облако, но нужен ваш аккаунт.

Что сделать один раз (займёт минут 10, денег в бесплатном лимите не спишут):

1. Откройте https://console.yandex.cloud и войдите в свой Яндекс-аккаунт.
2. Создайте облако и каталог, если их ещё нет (кнопка «Создать облако»).
3. Слева откройте «Биллинг» → создайте платёжный аккаунт и привяжите карту.
   Это обязательное требование Яндекса. В пределах бесплатных лимитов
   (1 млн вызовов функций и 100 тыс. запросов шлюза в месяц) списаний не будет.
4. Получите ключ доступа по ссылке:
   https://oauth.yandex.ru/authorize?response_type=token&client_id=1a6990aa636648e9b2ef855fa7bec2fb
   Скопируйте длинную строку из адресной строки (часть после access_token=).
5. Откройте файл .env.local в папке проекта (Блокнот подойдёт) и добавьте строку:
   YC_OAUTH_TOKEN=ваш_ключ
   Никому его не отправляйте и не вставляйте в чат.
6. Снова запустите: node deploy/yandex/deploy.mjs

Если каталогов несколько, добавьте в .env.local ещё строку YC_FOLDER_ID=идентификатор_каталога.`);
  process.exitCode = 2;
} else if (!databaseUrl) {
  console.error('В .env.local нет DATABASE_URL — без базы сайт работать не будет.');
  process.exitCode = 2;
} else {
  await main().catch((error) => {
    console.error('Не удалось развернуть:', error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const iam = await yandex('POST', 'https://iam.api.cloud.yandex.net/iam/v1/tokens', {
    body: { yandexPassportOauthToken: oauthToken },
    auth: false,
  });
  const token = iam.iamToken;
  if (!token) throw new Error('Яндекс не выдал ключ доступа. Проверьте YC_OAUTH_TOKEN.');

  const folderId = await resolveFolder(token);
  console.log('каталог:', folderId);

  await checkBilling(token);

  const serviceAccountId = await ensureServiceAccount(token, folderId);
  console.log('сервисный аккаунт готов');

  const functionId = await ensureFunction(token, folderId);
  console.log('функция готова');

  let gateway = await findGateway(token, folderId);
  if (gateway) {
    console.log('шлюз уже есть');
  } else {
    try {
      gateway = await createGateway(token, folderId, functionId, serviceAccountId);
    } catch (error) {
      if (!/version|версии/i.test(error.message)) throw error;
      console.log('шлюз ждёт первую версию функции, создаю временную…');
      await createFunctionVersion(token, functionId, serviceAccountId, 'https://placeholder.invalid');
      gateway = await createGateway(token, folderId, functionId, serviceAccountId);
    }
  }
  const baseUrl = `https://${gateway.domain}`;
  console.log('адрес шлюза:', baseUrl);

  const environment = { APP_ORIGIN: baseUrl, DATABASE_URL: databaseUrl, NODE_ENV: 'production' };
  for (const name of ['VOICE_ROOM_URL', 'VOICE_ROOM_URLS', 'YANDEX_TELEMOST_TOKEN']) {
    const value = String(process.env[name] ?? '').trim();
    if (value) environment[name] = value;
  }

  const versionId = await createFunctionVersion(token, functionId, serviceAccountId, null, environment);
  console.log('версия сайта загружена:', versionId);

  await waitForSite(baseUrl);
  console.log('сайт отвечает');

  await registerTestAccount(baseUrl);
  console.log('вход и регистрация работают');

  console.log(`\nГотово. Сайт в РФ: ${baseUrl}\n`);
  console.log('Обновление после правок: node deploy/yandex/build.mjs && node deploy/yandex/deploy.mjs');
}

async function yandex(method, url, { body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${authToken}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data?.message ?? data?.error?.message ?? text.slice(0, 300) ?? '';
    const error = new Error(`${method} ${new URL(url).pathname} → ${response.status}: ${message}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

let authToken = '';

async function resolveFolder(token) {
  authToken = token;
  const clouds = await yandex('GET', 'https://resource-manager.api.cloud.yandex.net/resource-manager/v1/clouds');
  const cloudList = clouds.clouds ?? [];
  if (!cloudList.length) {
    throw new Error('в аккаунте нет облака. Создайте его на https://console.yandex.cloud и запустите снова.');
  }
  const wanted = String(process.env.YC_FOLDER_ID ?? '').trim();
  for (const cloud of cloudList) {
    const folders = await yandex('GET', `https://resource-manager.api.cloud.yandex.net/resource-manager/v1/folders?cloudId=${encodeURIComponent(cloud.id)}`);
    const list = folders.folders ?? [];
    if (wanted) {
      const found = list.find((folder) => folder.id === wanted);
      if (found) return found.id;
    } else if (list.length) {
      return (list.find((folder) => folder.name === 'default') ?? list[0]).id;
    }
  }
  if (wanted) throw new Error(`каталог ${wanted} не найден. Проверьте YC_FOLDER_ID.`);
  throw new Error('в облаке нет каталога. Создайте каталог на https://console.yandex.cloud и запустите снова.');
}

async function checkBilling(token) {
  let accounts;
  try {
    const data = await yandex('GET', 'https://billing.api.cloud.yandex.net/billing/v1/billingAccounts');
    accounts = data.billingAccounts ?? [];
  } catch (error) {
    console.warn('проверить биллинг не удалось (не критично):', error.message);
    return;
  }
  if (!accounts.some((account) => account.active)) {
    throw new Error([
      'нет активного платёжного аккаунта — Яндекс не включит функции и шлюз.',
      'Откройте https://console.yandex.cloud → «Биллинг» → создайте аккаунт и привяжите карту.',
      'В бесплатных лимитах списаний не будет, затем запустите скрипт снова.',
    ].join('\n'));
  }
}

async function ensureServiceAccount(token, folderId) {
  const data = await yandex('GET', `https://iam.api.cloud.yandex.net/iam/v1/serviceAccounts?folderId=${encodeURIComponent(folderId)}`);
  let account = (data.serviceAccounts ?? []).find((item) => item.name === 'friends-chat');
  if (!account) {
    const operation = await yandex('POST', 'https://iam.api.cloud.yandex.net/iam/v1/serviceAccounts', {
      body: { folderId, name: 'friends-chat', description: 'Чат друзей: вызов функции из шлюза' },
    });
    const done = await waitOperation(operation);
    account = done.response ?? { id: done.metadata?.serviceAccountId };
  }
  if (!account?.id) throw new Error('не удалось создать сервисный аккаунт.');

  const bindings = await yandex('GET', `https://resource-manager.api.cloud.yandex.net/resource-manager/v1/folders/${folderId}:listAccessBindings`);
  const hasRole = (bindings.accessBindings ?? []).some(
    (binding) => binding.roleId === 'functions.functionInvoker' && binding.subject?.id === account.id,
  );
  if (!hasRole) {
    try {
      await yandex('POST', `https://resource-manager.api.cloud.yandex.net/resource-manager/v1/folders/${folderId}:updateAccessBindings`, {
        body: {
          accessBindingDeltas: [{
            action: 'ADD',
            accessBinding: {
              roleId: 'functions.functionInvoker',
              subject: { id: account.id, type: 'serviceAccount' },
            },
          }],
        },
      });
    } catch (error) {
      if (error.status !== 403) throw error;
      console.warn('роль уже назначена или недоступна для выдачи');
    }
  }
  return account.id;
}

async function ensureFunction(token, folderId) {
  const data = await yandex('GET', `https://serverless-functions.api.cloud.yandex.net/functions/v1/functions?folderId=${encodeURIComponent(folderId)}`);
  const existing = (data.functions ?? []).find((item) => item.name === 'friends-chat');
  if (existing) return existing.id;
  const operation = await yandex('POST', 'https://serverless-functions.api.cloud.yandex.net/functions/v1/functions', {
    body: { folderId, name: 'friends-chat', description: 'Чат друзей' },
  });
  const done = await waitOperation(operation);
  if (!done.response?.id) throw new Error('не удалось создать функцию.');
  return done.response.id;
}

async function findGateway(token, folderId) {
  const data = await yandex('GET', `https://serverless-apigateway.api.cloud.yandex.net/apigateways/v1/apigateways?folderId=${encodeURIComponent(folderId)}`);
  return (data.apiGateways ?? []).find((item) => item.name === 'friends-chat') ?? null;
}

async function createGateway(token, folderId, functionId, serviceAccountId) {
  const integration = {
    type: 'cloud_functions',
    function_id: functionId,
    tag: '$latest',
    service_account_id: serviceAccountId,
    payload_format_version: '2.0',
  };
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Чат друзей', version: '1.0.0' },
    paths: {
      '/': { 'x-yc-apigateway-any-method': { 'x-yc-apigateway-integration': integration } },
      '/{proxy+}': {
        parameters: [{ name: 'proxy', in: 'path', required: true, schema: { type: 'string' } }],
        'x-yc-apigateway-any-method': { 'x-yc-apigateway-integration': integration },
      },
    },
  };
  const operation = await yandex('POST', 'https://serverless-apigateway.api.cloud.yandex.net/apigateways/v1/apigateways', {
    body: { folderId, name: 'friends-chat', openapiSpec: JSON.stringify(spec) },
  });
  const done = await waitOperation(operation);
  let gateway = done.response;
  if (!gateway?.domain && gateway?.id) {
    gateway = await yandex('GET', `https://serverless-apigateway.api.cloud.yandex.net/apigateways/v1/apigateways/${gateway.id}`);
  }
  if (!gateway?.domain) throw new Error('шлюз создан, но адрес не получен. Повторите запуск.');
  return gateway;
}

async function createFunctionVersion(token, functionId, serviceAccountId, placeholderOrigin, environment) {
  const zip = await readFile(join(root, 'deploy/yandex/friends-chat.zip'));
  if (!environment) environment = { APP_ORIGIN: placeholderOrigin, DATABASE_URL: databaseUrl };
  const operation = await yandex('POST', 'https://serverless-functions.api.cloud.yandex.net/functions/v1/versions', {
    body: {
      functionId,
      runtime: 'nodejs22',
      entrypoint: 'index.handler',
      resources: { memory: '268435456' },
      executionTimeout: '10s',
      serviceAccountId,
      environment,
      content: zip.toString('base64'),
      description: `friends-chat ${new Date().toISOString()}`,
    },
  });
  const done = await waitOperation(operation);
  if (!done.response?.id) throw new Error('версия не загрузилась.');
  return done.response.id;
}

async function waitOperation(operation) {
  const deadline = Date.now() + 180_000;
  let current = operation;
  while (!current.done) {
    if (Date.now() > deadline) throw new Error('Яндекс слишком долго выполняет операцию. Повторите запуск позже.');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    current = await yandex('GET', `https://operation.api.cloud.yandex.net/operations/${current.id}`);
  }
  if (current.error) {
    throw new Error(current.error.message ?? 'операция завершилась ошибкой.');
  }
  return current;
}

async function waitForSite(baseUrl) {
  const deadline = Date.now() + 180_000;
  let last = 'нет ответа';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`сайт не ответил за 3 минуты (${last}).`);
}

async function registerTestAccount(baseUrl) {
  const username = `ycf${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const password = crypto.randomUUID() + 'Aa!';
  let userId = null;
  try {
    const response = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({
        username,
        password,
        first_name: 'Тест',
        last_name: 'Развёртывание',
        nickname: 'ТестРазвёртывание',
        class_key: 'warrior',
      }),
    });
    if (response.status !== 201) {
      throw new Error(`регистрация вернула HTTP ${response.status}`);
    }
    const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
    const me = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
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
        await pool.query('DELETE FROM app.auth_limiter WHERE key LIKE $1', [`%${username}%`]);
        await pool.query('DELETE FROM app.users WHERE id = $1', [userId]);
      }
      await pool.query('DELETE FROM app.auth_limiter WHERE key LIKE $1', [`%${username}%`]);
    } finally {
      await pool.end();
    }
  }
}
