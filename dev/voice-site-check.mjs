// Two real headless Chrome instances join the same in-site voice room with fake
// microphones. Verifies UI wiring, signaling over our WebSocket and the P2P audio
// element. Run: SITE_URL=https://localhost:8443 node dev/voice-site-check.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!SITE_URL) {
  console.error('SITE_URL is required');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = false;
const check = (condition, message) => {
  if (!condition) {
    failed = true;
    console.error('FAIL:', message);
    return;
  }
  console.log('ok:', message);
};

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

const instances = [];

async function launch() {
  const profile = await mkdtemp(path.join(tmpdir(), 'ff-voice-site-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  instances.push({ chrome, profile });

  let port = null;
  for (let attempt = 0; attempt < 150 && !port; attempt += 1) {
    await sleep(100);
    try {
      port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim();
    } catch { /* not written yet */ }
  }
  if (!port) throw new Error('Chrome did not start');

  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

async function openAs(cdp, nickname) {
  await cdp.send('Page.navigate', { url: SITE_URL });
  await sleep(2000);
  const username = `vsc${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const status = await cdp.eval(`fetch('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ${JSON.stringify(username)}, password: 'correct horse battery staple',
      first_name: 'Голос', last_name: 'Тестов', nickname: ${JSON.stringify(nickname)}, class_key: 'warrior' }),
  }).then((response) => response.status)`);
  if (status !== 201) throw new Error(`register failed with ${status}`);
  await cdp.send('Page.navigate', { url: SITE_URL });
  await sleep(2000);
  const ready = await cdp.eval(`!document.getElementById('app-screen').hidden && !document.getElementById('voice-join').hidden`);
  if (!ready) throw new Error('app did not open');
}

const room = (cdp) => cdp.eval(`({
  panel: !document.getElementById('voice-panel').hidden,
  count: document.getElementById('voice-panel-count').textContent,
  title: document.getElementById('voice-panel-title').textContent,
  peers: [...document.querySelectorAll('#voice-peers li')].map((item) => item.textContent),
  note: document.getElementById('voice-note').hidden ? '' : document.getElementById('voice-note').textContent,
  button: document.getElementById('voice-join-label').textContent,
  remote: [...document.querySelectorAll('audio[data-voice-peer]')].map((audio) => ({
    tracks: audio.srcObject ? audio.srcObject.getAudioTracks().map((track) => track.muted) : [],
    live: audio.srcObject ? audio.srcObject.active : false,
  })),
})`);

async function until(cdp, expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression)) return true;
    await sleep(250);
  }
  return false;
}

try {
  const first = await launch();
  const second = await launch();

  await openAs(first, 'ПроверкаА');
  await openAs(second, 'ПроверкаБ');

  await first.eval(`document.getElementById('voice-join').click()`);
  const joinedFirst = await until(first, `!document.getElementById('voice-panel').hidden && document.getElementById('voice-panel-count').textContent.startsWith('1 / ')`);
  check(joinedFirst, 'first user joined the in-site room');
  const firstRoom = await room(first);
  check(firstRoom.title.includes('общий'), `room title names the channel (${firstRoom.title})`);
  check(firstRoom.count === '1 / 6', `first user sees 1 / 6 (${firstRoom.count})`);
  check(firstRoom.peers.length === 1 && firstRoom.peers[0].includes('ПроверкаА'), 'first user sees themself in the room');
  check(firstRoom.button === 'Вы в голосе', 'header button reports the active call');

  await second.eval(`document.getElementById('voice-join').click()`);
  const bothJoined = await until(second, `document.getElementById('voice-panel-count').textContent === '2 / 6'`)
    && await until(first, `document.getElementById('voice-panel-count').textContent === '2 / 6'`);
  check(bothJoined, 'both users see 2 / 6');

  const connectedAudio = await until(first, `[...document.querySelectorAll('audio[data-voice-peer]')].some((audio) => audio.srcObject && audio.srcObject.getAudioTracks().some((track) => !track.muted))`, 20000);
  check(connectedAudio, 'peer audio track is flowing in the first tab');
  const secondRoom = await room(second);
  check(secondRoom.peers.some((text) => text.includes('ПроверкаА')), 'second user sees the first participant');
  check(secondRoom.remote.length === 1, 'second user has one remote audio element');

  await first.eval(`document.getElementById('voice-mute').click()`);
  const mutedSeen = await until(second, `[...document.querySelectorAll('#voice-peers li')].some((item) => item.textContent.includes('микрофон выкл.'))`);
  check(mutedSeen, 'mute state is visible to the other participant');
  await first.eval(`document.getElementById('voice-mute').click()`);

  await first.eval(`document.getElementById('voice-leave').click()`);
  const left = await until(second, `document.getElementById('voice-panel-count').textContent === '1 / 6'`);
  check(left, 'leaving removes the participant from the room');
  check(await second.eval(`document.querySelectorAll('audio[data-voice-peer]').length === 0`), 'remote audio is cleaned up after leave');

  for (const [label, cdp] of [['first', first], ['second', second]]) {
    const errors = cdp.consoleErrors.filter((text) => !text.includes('favicon'));
    check(errors.length === 0, `${label} tab has no console errors (${errors.join(' | ')})`);
  }
} catch (error) {
  failed = true;
  console.error('FAIL:', error.message);
} finally {
  for (const { chrome, profile } of instances) {
    try { chrome.kill(); } catch { /* already gone */ }
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

if (failed) process.exitCode = 1;
