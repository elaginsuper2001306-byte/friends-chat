// Подключает свой домен к сайту на Render и делает его основным адресом.
// Запуск: node deploy/render/domain.mjs friends-chat.mooo.com
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  process.loadEnvFile(join(root, '.env.local'));
} catch {
  // Значения могут прийти из окружения.
}

const key = String(process.env.RENDER_API_KEY ?? '').trim();
const statePath = join(root, 'deploy/render/service.json');
const raw = String(process.argv[2] ?? '').trim().toLowerCase()
  .replace(/^https?:\/\//, '')
  .replace(/[/?#].*$/, '');
const domain = raw;

if (!key) {
  console.error('В .env.local нет RENDER_API_KEY.');
  process.exitCode = 2;
} else if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
  console.log(`Укажите домен без https и слэшей, например:
  node deploy/render/domain.mjs friends-chat.mooo.com`);
  process.exitCode = 2;
} else {
  await main().catch((error) => {
    console.error('\nНе удалось подключить домен:', error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const target = `${state.name}.onrender.com`;

  console.log(`Домен: ${domain}`);
  console.log(`Куда должен вести CNAME: ${target}`);
  const records = await checkDns(domain);
  if (!records.ok) {
    console.log('\nDNS пока не настроен или указывает не туда. Сейчас домен отдаёт:');
    console.log(`  CNAME: ${records.cname.join(', ') || 'нет'}`);
    console.log(`  A:     ${records.a.join(', ') || 'нет'}`);
    console.log(`\nВ панели домена создайте запись CNAME «${domain.split('.')[0]}» → ${target}`);
    console.log('и запустите команду снова через пару минут.');
    process.exitCode = 1;
    return;
  }

  const existing = await api('GET', `/services/${state.id}/custom-domains`);
  const already = pick(existing, domain);
  if (!already) {
    console.log('добавляю домен в Render…');
    await api('POST', `/services/${state.id}/custom-domains`, { name: domain });
  } else {
    console.log('домен уже добавлен в Render');
  }

  const deadline = Date.now() + 20 * 60_000;
  let last = '';
  let ready = false;
  while (Date.now() < deadline) {
    const list = await api('GET', `/services/${state.id}/custom-domains`);
    const entry = pick(list, domain) ?? {};
    const status = entry.verificationStatus ?? 'pending';
    if (status !== last) {
      console.log('статус домена:', status);
      last = status;
    }
    if (await siteAnswers(domain)) {
      ready = true;
      break;
    }
    await sleep(15_000);
  }

  if (!ready) {
    console.log('\nRender ещё не подтвердил домен. Подождите 5–10 минут и повторите команду,');
    console.log('или нажмите «Verify» рядом с доменом в Render → Settings → Custom Domains.');
    process.exitCode = 1;
    return;
  }

  const saved = { ...state, domain };
  await writeFile(statePath, JSON.stringify(saved, null, 2));
  console.log(`\nДомен работает: https://${domain}`);
  console.log('Теперь включите его в приложении: node deploy/render/deploy.mjs');
}

function pick(list, name) {
  const items = Array.isArray(list) ? list : [];
  for (const item of items) {
    const entry = item?.customDomain ?? item;
    if (entry?.name === name) return entry;
  }
  return null;
}

async function siteAnswers(name) {
  try {
    const response = await fetch(`https://${name}/api/health`, { signal: AbortSignal.timeout(20_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function checkDns(name) {
  const cname = await doh(name, 'CNAME');
  const a = await doh(name, 'A');
  const ok = cname.some((value) => value.replace(/\.$/, '').endsWith('.onrender.com'))
    || a.some((value) => value.startsWith('216.24.57.'));
  return { ok, cname, a };
}

async function doh(name, type) {
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
    const response = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json();
    return (data.Answer ?? [])
      .filter((answer) => answer.type === (type === 'CNAME' ? 5 : 1))
      .map((answer) => answer.data);
  } catch {
    return [];
  }
}

async function api(method, path, body) {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
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
  if (response.status === 401) throw new Error('Render отклонил RENDER_API_KEY.');
  if (!response.ok) throw new Error(data?.message ?? `Render вернул HTTP ${response.status}`);
  return data;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
