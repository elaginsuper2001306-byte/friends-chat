// Real-browser smoke check for the Telemost voice button.
// Without a configured room it verifies the "unavailable" path; with EXPECT_ROOM=1
// (a local server configured with VOICE_ROOM_URL) it verifies that a new tab opens
// with the Telemost link.
// Run: SITE_URL=https://friends-chat-iota.vercel.app node dev/voice-ui-check.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXPECT_ROOM = process.env.EXPECT_ROOM === '1';
if (!SITE_URL) {
  console.error('SITE_URL is required');
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

const profile = await mkdtemp(path.join(tmpdir(), 'ff-voice-check-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-popup-blocking', '--ignore-certificate-errors',
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
    this.consoleErrors = [];
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('devtools socket failed'));
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? 'exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
      }
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

  await cdp.send('Page.navigate', { url: SITE_URL });
  await sleep(2500);

  const username = `vui${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const registered = await cdp.eval(`fetch('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ${JSON.stringify(username)}, password: 'correct horse battery staple',
      first_name: 'Голос', last_name: 'Тестов', nickname: 'ГолосТест', class_key: 'warrior' }),
  }).then((response) => response.status)`);
  check(registered === 201, 'test account registered');

  await cdp.send('Page.navigate', { url: SITE_URL });
  await sleep(2500);

  const view = await cdp.eval(`({
    loggedIn: !document.getElementById('app-screen').hidden,
    buttonVisible: !document.getElementById('voice-join').hidden,
    buttonLabel: document.getElementById('voice-join-label').textContent,
    noteHidden: document.getElementById('voice-note').hidden,
  })`);
  check(view.loggedIn, 'app opened after registration');
  check(view.buttonVisible, 'voice button is visible in a channel');
  check(view.buttonLabel === 'Голос', 'voice button is labelled');
  check(view.noteHidden, 'no voice note before the click');

  const listPages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .filter((item) => item.type === 'page');
  const baselineTabs = (await listPages()).length;

  await cdp.eval(`document.getElementById('voice-join').click()`);

  if (EXPECT_ROOM) {
    let opened = null;
    for (let attempt = 0; attempt < 40 && !opened; attempt += 1) {
      await sleep(250);
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      opened = targets.find((item) => item.type === 'page' && item.url.startsWith('https://telemost.yandex.ru/'));
    }
    check(!!opened, `Telemost room opened in a new tab (${opened?.url ?? 'none'})`);
  } else {
    await sleep(1800);
    const afterClick = await cdp.eval(`({
      note: document.getElementById('voice-note').hidden ? '' : document.getElementById('voice-note').textContent,
      buttonEnabled: !document.getElementById('voice-join').disabled,
    })`);
    check(afterClick.buttonEnabled, 'voice button is usable again after the failure');
    check(afterClick.note.includes('Голосовой чат пока не настроен'), 'unavailable voice reports a clear message');
    check((await listPages()).length === baselineTabs, 'no blank tab is left behind');
  }

  const errors = cdp.consoleErrors.filter((text) => !text.includes('favicon'));
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  console.log('test username:', username);
} finally {
  await teardown();
}
