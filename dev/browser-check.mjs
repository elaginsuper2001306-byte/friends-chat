// Real-browser UI check through the Chrome DevTools Protocol (no extra dependencies).
// Run: SITE_URL=https://friends-chat-iota.vercel.app AVATAR_FILE=path/to/photo.png node dev/browser-check.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
const AVATAR_FILE = process.env.AVATAR_FILE ?? '';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT = process.env.SHOT_FILE ?? '';
if (!SITE_URL || !AVATAR_FILE) {
  console.error('SITE_URL and AVATAR_FILE are required');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log('ok:', message);
};

const profile = await mkdtemp(path.join(tmpdir(), 'ff-ui-check-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

let port = null;
for (let attempt = 0; attempt < 150 && !port; attempt += 1) {
  await sleep(100);
  try {
    port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim();
  } catch { /* not written yet */ }
}
if (!port) throw new Error('Chrome did not start');

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.waiters = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('devtools socket failed'));
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.waiters.get(message.id);
      if (!waiter) return;
      this.waiters.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    };
  }

  send(method, params = {}) {
    const id = (this.nextId += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.waiters.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'eval failed');
    }
    return result.result.value;
  }
}

const teardown = async () => {
  try { chrome.kill(); } catch { /* already gone */ }
  await sleep(400);
  await rm(profile, { recursive: true, force: true });
};

let cdp = null;
try {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.navigate', { url: `${SITE_URL}/` });

  const waitFor = async (expression, message, timeout = 15000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await cdp.eval(expression)) return;
      await sleep(150);
    }
    throw new Error(`timeout: ${message}`);
  };
  await waitFor('document.readyState === "complete" && !!document.getElementById("register-form")', 'page loads');

  const suffix = crypto.randomUUID().slice(0, 6);
  const login = `ui${suffix}`;
  const firstNick = `Тень${suffix}`;
  const nextNick = `Ник${suffix}`;
  const messageText = `проверка интерфейса ${suffix}`;
  const fill = (id, value) => `(() => { const n = document.getElementById('${id}'); n.value = ${JSON.stringify(value)};`
    + 'n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true })); })();';

  await cdp.eval('document.getElementById("tab-register").click()');
  await waitFor('!document.getElementById("register-form").hidden', 'register form opens');
  for (const [id, value] of Object.entries({
    'register-username': login,
    'register-first': 'Иван',
    'register-last': 'Тестов',
    'register-nickname': firstNick,
    'register-class': 'assassin',
    'register-password': 'password-12345',
  })) await cdp.eval(fill(id, value));

  const preview = await cdp.eval('getComputedStyle(document.getElementById("register-preview")).color');
  check(preview === 'rgb(185, 140, 240)', 'class colour preview follows the selected class');

  await cdp.eval('document.getElementById("register-form").requestSubmit()');
  await waitFor('!document.getElementById("app-screen").hidden', 'registration signs the user in', 20000);
  const header = await cdp.eval('({ name: document.getElementById("me-name").textContent, color: getComputedStyle(document.getElementById("me-name")).color })');
  check(header.name === firstNick && header.color === 'rgb(185, 140, 240)', 'header shows the nickname in its class colour');

  await waitFor('!!document.querySelector("#channel-list button")', 'channel list loads');
  await cdp.eval('document.querySelector("#channel-list button").click()');
  await sleep(800);
  await cdp.eval(fill('message-input', messageText).replace('n.dispatchEvent(new Event("change", { bubbles: true }));', '')
    + 'document.getElementById("composer").requestSubmit();');
  const hasMessage = `Array.from(document.querySelectorAll('.msg-text')).some((n) => n.textContent === ${JSON.stringify(messageText)})`;
  await waitFor(hasMessage, 'own message appears');

  await cdp.eval('document.getElementById("me-name").click()');
  await waitFor('document.getElementById("profile-dialog").open', 'profile editor opens');
  const filled = await cdp.eval('({ nick: document.getElementById("profile-nickname").value, cls: document.getElementById("profile-class").value, first: document.getElementById("profile-first").value, last: document.getElementById("profile-last").value, login: document.getElementById("profile-login").textContent })');
  check(filled.nick === firstNick && filled.cls === 'assassin' && filled.first === 'Иван' && filled.last === 'Тестов' && filled.login === login, 'profile editor is prefilled with the saved fields');

  await cdp.eval(fill('profile-nickname', nextNick));
  await cdp.eval(fill('profile-class', 'druid'));
  await cdp.eval('document.getElementById("profile-form").requestSubmit()');
  await waitFor('!document.getElementById("profile-dialog").open', 'profile saves and closes');
  const recolored = await cdp.eval(`(() => {
    const row = Array.from(document.querySelectorAll('.msg')).find((n) => n.querySelector('.msg-text')?.textContent === ${JSON.stringify(messageText)});
    const author = row?.querySelector('.msg-author');
    return author ? { name: author.textContent, color: getComputedStyle(author).color } : null;
  })()`);
  check(recolored?.name === nextNick && recolored.color === 'rgb(242, 153, 74)', 'old message takes the new nickname and class colour');

  await cdp.eval('document.getElementById("me-name").click()');
  await waitFor('document.getElementById("profile-dialog").open', 'profile editor reopens');
  const document = await cdp.send('DOM.getDocument', { depth: -1 });
  const node = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#avatar-file' });
  check(node.nodeId > 0, 'avatar file input is present');
  await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [AVATAR_FILE] });
  await cdp.eval('document.getElementById("avatar-file").dispatchEvent(new Event("change", { bubbles: true }))');
  const uploadStarted = Date.now();
  while (Date.now() - uploadStarted < 20000) {
    if (await cdp.eval('document.getElementById("profile-avatar").classList.contains("has-photo")')) break;
    const error = await cdp.eval('document.getElementById("profile-error").textContent');
    if (error) check(false, `avatar upload error: ${error}`);
    await sleep(200);
  }
  const uploaded = await cdp.eval(`(async () => {
    const node = document.getElementById('profile-avatar');
    const match = node.style.backgroundImage.match(/url\\("(.+)"\\)/);
    if (!match) return { hasPhoto: node.classList.contains('has-photo'), url: null };
    const response = await fetch(match[1]);
    return {
      hasPhoto: node.classList.contains('has-photo'),
      url: match[1],
      status: response.status,
      type: response.headers.get('content-type'),
      cache: response.headers.get('cache-control'),
      bytes: (await response.arrayBuffer()).byteLength,
      removeVisible: !document.getElementById('profile-remove-avatar').hidden,
    };
  })()`);
  check(uploaded.hasPhoto && uploaded.removeVisible, 'avatar is shown inside the profile editor');
  check(uploaded.status === 200 && /^image\//.test(uploaded.type ?? '') && uploaded.bytes > 0, `avatar is served back (${uploaded.status} ${uploaded.type} ${uploaded.bytes}B)`);
  check(/private/.test(uploaded.cache ?? ''), 'avatar response stays private');

  await cdp.eval('document.getElementById("profile-cancel").click()');
  await sleep(1200);
  const footer = await cdp.eval('document.getElementById("me-avatar").classList.contains("has-photo")');
  check(footer, 'footer avatar shows the uploaded photo');
  const authorAvatar = await cdp.eval(`(() => {
    const row = Array.from(document.querySelectorAll('.msg')).find((n) => n.querySelector('.msg-text')?.textContent === ${JSON.stringify(messageText)});
    const avatar = row?.querySelector('.avatar');
    return {
      authorFound: Boolean(row?.querySelector('.msg-author')),
      avatarFound: Boolean(avatar),
      hasPhoto: avatar?.classList.contains('has-photo') ?? null,
      bg: avatar?.style.backgroundImage ?? '',
    };
  })()`);
  check(authorAvatar.hasPhoto === true, `message author avatar shows the photo (${JSON.stringify(authorAvatar)})`);
  const memberAvatar = await cdp.eval(`Array.from(document.querySelectorAll('.member-name')).find((n) => n.textContent === ${JSON.stringify(nextNick)})?.closest('li')?.querySelector('.avatar')?.classList.contains('has-photo') ?? null`);
  check(memberAvatar === true, 'members list shows the photo');

  if (SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('screenshot:', SHOT);
  }

  await cdp.eval('document.getElementById("me-name").click()');
  await waitFor('document.getElementById("profile-dialog").open', 'profile editor reopens for removal');
  await cdp.eval('document.getElementById("profile-remove-avatar").click()');
  await waitFor('!document.getElementById("profile-avatar").classList.contains("has-photo")', 'avatar removal clears the editor');
  // bypass the private 5-minute HTTP cache the earlier avatar fetch filled
  const gone = await cdp.eval(`fetch(${JSON.stringify(uploaded.url)}, { cache: 'reload' }).then((r) => r.status).catch(() => 0)`);
  check(gone === 404, `removed avatar is no longer served (${gone})`);
  const fallback = await cdp.eval('({ text: document.getElementById("profile-avatar").textContent, bg: document.getElementById("profile-avatar").style.backgroundImage, footer: document.getElementById("me-avatar").classList.contains("has-photo") })');
  check(Boolean(fallback.text) && !fallback.bg.includes('url(') && fallback.footer === false, `avatar falls back to the initial letter everywhere (${JSON.stringify(fallback)})`);

  console.log(`\nALL BROWSER CHECKS PASSED (${SITE_URL})`);
} finally {
  if (cdp) try { await cdp.send('Browser.close'); } catch { /* already closing */ }
  await teardown();
}
