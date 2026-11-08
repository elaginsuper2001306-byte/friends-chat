import { ApiError, requestJson, isWriteOutcomeUnknown } from './api.js';
import { CLASSES, classColor, className } from './classes.js';
import { createVoiceEngine } from './voice.js';

const PATH = '';
const POLL_MS = 8000;
const LISTS_EVERY_TICKS = 5;
const AVATAR_SOFT_LIMIT = 42 * 1024;
const AVATAR_HARD_LIMIT = 47 * 1024;
const AVATAR_FILE_LIMIT = 12 * 1024 * 1024;

const MESSAGES = {
  invalid_username: 'Логин: 3–32 символа — латинские буквы, цифры, _ и -, начиная с буквы или цифры.',
  invalid_password: 'Пароль должен быть не короче 8 символов и не длиннее 256.',
  invalid_input: 'Некорректный запрос. Проверьте введённые данные.',
  invalid_nickname: 'Игровой ник: 2–24 символа — буквы, цифры, пробел, точка, _ и -.',
  invalid_real_name: 'Имя и фамилия: только буквы, до 40 символов.',
  invalid_class: 'Выберите класс из списка.',
  invalid_avatar: 'Не удалось прочитать изображение. Выберите файл JPG, PNG или WEBP.',
  avatar_too_large: 'Фото слишком большое даже после сжатия. Выберите другое.',
  username_taken: 'Этот логин уже занят. Придумайте другой.',
  invalid_credentials: 'Неверный логин или пароль.',
  rate_limited: 'Слишком много попыток или сообщений. Подождите немного и повторите.',
  login_required: 'Сессия истекла. Войдите снова.',
  origin_forbidden: 'Запрос отклонён. Обновите страницу и повторите.',
  registration_unconfirmed: 'Не удалось подтвердить регистрацию. Попробуйте ещё раз тем же логином.',
  logout_unconfirmed: 'Не удалось подтвердить выход. Повторите попытку.',
  message_unconfirmed: 'Отправка не подтверждена. Повторите тем же сообщением.',
  dm_unconfirmed: 'Не удалось подтвердить создание чата. Повторите попытку.',
  idempotency_conflict: 'Это сообщение уже отправлено. Обновите переписку.',
  channel_exists: 'Канал с таким названием уже есть.',
  invalid_channel_name: 'Название канала: 1–40 символов — буквы, цифры, пробелы, _ и -.',
  invalid_message: 'Сообщение должно быть от 1 до 2000 символов.',
  dm_self_forbidden: 'Нельзя открыть чат с самим собой.',
  user_not_found: 'Пользователь не найден.',
  channel_not_found: 'Канал не найден.',
  dm_not_found: 'Чат не найден.',
  database_unavailable: 'Сервис данных временно недоступен. Попробуйте позже.',
  service_unavailable: 'Сервис временно недоступен. Попробуйте позже.',
  payload_too_large: 'Слишком большой запрос.',
  method_not_allowed: 'Действие не поддерживается.',
  not_found: 'Не найдено.',
  voice_unavailable: 'Голосовой чат пока не настроен. Попробуйте позже.',
  voice_upstream_failed: 'Не удалось создать голосовую комнату. Попробуйте ещё раз.',
  voice_full: 'В голосовой комнате уже 6 человек. Попробуйте чуть позже.',
  voice_connect_failed: 'Не удалось войти в голосовую комнату. Проверьте интернет и попробуйте ещё раз.',
  voice_replaced: 'Голос открыт в другой вкладке — здесь комната закрыта.',
  mic_denied: 'Браузер не дал доступ к микрофону. Разрешите его для этого сайта и попробуйте снова.',
  mic_missing: 'Микрофон не найден. Подключите его и попробуйте снова.',
};

const el = {
  authScreen: document.getElementById('auth-screen'),
  appScreen: document.getElementById('app-screen'),
  tabLogin: document.getElementById('tab-login'),
  tabRegister: document.getElementById('tab-register'),
  loginForm: document.getElementById('login-form'),
  loginUsername: document.getElementById('login-username'),
  loginPassword: document.getElementById('login-password'),
  loginSubmit: document.getElementById('login-submit'),
  loginToggle: document.getElementById('login-toggle'),
  registerForm: document.getElementById('register-form'),
  registerUsername: document.getElementById('register-username'),
  registerFirst: document.getElementById('register-first'),
  registerLast: document.getElementById('register-last'),
  registerNickname: document.getElementById('register-nickname'),
  registerClass: document.getElementById('register-class'),
  registerPreview: document.getElementById('register-preview'),
  registerPassword: document.getElementById('register-password'),
  registerSubmit: document.getElementById('register-submit'),
  registerToggle: document.getElementById('register-toggle'),
  authError: document.getElementById('auth-error'),
  sidebar: document.getElementById('sidebar'),
  backdrop: document.getElementById('sidebar-backdrop'),
  menuToggle: document.getElementById('menu-toggle'),
  channelList: document.getElementById('channel-list'),
  dmList: document.getElementById('dm-list'),
  dmEmpty: document.getElementById('dm-empty'),
  addChannel: document.getElementById('add-channel'),
  addDm: document.getElementById('add-dm'),
  meAvatar: document.getElementById('me-avatar'),
  meName: document.getElementById('me-name'),
  logout: document.getElementById('logout'),
  viewIcon: document.getElementById('view-icon'),
  viewTitle: document.getElementById('view-title'),
  messages: document.getElementById('messages'),
  sendBar: document.getElementById('send-bar'),
  sendBarText: document.getElementById('send-bar-text'),
  retrySend: document.getElementById('retry-send'),
  dismissSend: document.getElementById('dismiss-send'),
  composer: document.getElementById('composer'),
  input: document.getElementById('message-input'),
  sendBtn: document.getElementById('send-btn'),
  membersCount: document.getElementById('members-count'),
  memberList: document.getElementById('member-list'),
  channelDialog: document.getElementById('channel-dialog'),
  channelForm: document.getElementById('channel-form'),
  channelName: document.getElementById('channel-name'),
  channelError: document.getElementById('channel-error'),
  channelCancel: document.getElementById('channel-cancel'),
  dmDialog: document.getElementById('dm-dialog'),
  dmUserList: document.getElementById('dm-user-list'),
  dmError: document.getElementById('dm-error'),
  dmCancel: document.getElementById('dm-cancel'),
  profileDialog: document.getElementById('profile-dialog'),
  profileForm: document.getElementById('profile-form'),
  profileAvatar: document.getElementById('profile-avatar'),
  avatarFile: document.getElementById('avatar-file'),
  profilePreview: document.getElementById('profile-preview'),
  profileClassLabel: document.getElementById('profile-class-label'),
  profileFirst: document.getElementById('profile-first'),
  profileLast: document.getElementById('profile-last'),
  profileNickname: document.getElementById('profile-nickname'),
  profileClass: document.getElementById('profile-class'),
  profileLogin: document.getElementById('profile-login'),
  profileError: document.getElementById('profile-error'),
  profileRemoveAvatar: document.getElementById('profile-remove-avatar'),
  profileCancel: document.getElementById('profile-cancel'),
  profileSave: document.getElementById('profile-save'),
  userDialog: document.getElementById('user-dialog'),
  userAvatar: document.getElementById('user-avatar'),
  userNickname: document.getElementById('user-nickname'),
  userClass: document.getElementById('user-class'),
  userRealname: document.getElementById('user-realname'),
  userError: document.getElementById('user-error'),
  userClose: document.getElementById('user-close'),
  userDm: document.getElementById('user-dm'),
  voiceJoin: document.getElementById('voice-join'),
  voiceJoinLabel: document.getElementById('voice-join-label'),
  voiceNote: document.getElementById('voice-note'),
  voicePanel: document.getElementById('voice-panel'),
  voicePanelTitle: document.getElementById('voice-panel-title'),
  voicePanelCount: document.getElementById('voice-panel-count'),
  voicePanelPeers: document.getElementById('voice-peers'),
  voiceMute: document.getElementById('voice-mute'),
  voiceLeave: document.getElementById('voice-leave'),
  voiceFallback: document.getElementById('voice-fallback'),
};

const state = {
  user: null,
  channels: [],
  dms: [],
  users: [],
  view: null,
  messages: [],
  pending: null,
  busy: false,
  pollTimer: null,
  tick: 0,
  viewToken: 0,
  userDialogId: null,
};

// Voice runs inside the page over WebRTC; Telemost stays as a fallback room.
let voiceBusy = false;

/* ----- helpers ----- */

function setAuthError(message) {
  el.authError.textContent = message;
  el.authError.hidden = !message;
}

function hueOf(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return hash;
}

function displayName(user) {
  return user?.nickname || user?.username || 'Игрок';
}

function fillAvatar(node, name) {
  node.textContent = [...name][0] || '?';
  node.style.background = `hsl(${hueOf(name)} 55% 45%)`;
}

function avatarUrl(user) {
  if (!user?.id || !user.avatar_updated_at) return null;
  return `${PATH}/api/avatars/${user.id}?v=${encodeURIComponent(user.avatar_updated_at)}`;
}

function applyAvatar(node, user) {
  const url = avatarUrl(user);
  if (url) {
    node.classList.add('has-photo');
    node.style.backgroundImage = `url("${url}")`;
    node.textContent = '';
  } else {
    node.classList.remove('has-photo');
    node.style.backgroundImage = '';
    fillAvatar(node, displayName(user));
  }
}

function makeAvatar(user, small = false) {
  const node = document.createElement('div');
  node.className = small ? 'avatar small' : 'avatar';
  node.setAttribute('aria-hidden', 'true');
  applyAvatar(node, user);
  return node;
}

function paintNickname(node, user) {
  node.textContent = displayName(user);
  node.style.color = classColor(user?.class_key) ?? '';
}

function realNameText(profile) {
  const text = `${profile?.last_name ?? ''} ${profile?.first_name ?? ''}`.trim();
  return text || 'не указано';
}

function fillClassSelect(select, value) {
  select.innerHTML = '';
  for (const item of CLASSES) {
    const option = document.createElement('option');
    option.value = item.key;
    option.textContent = item.name;
    select.append(option);
  }
  select.value = CLASSES.some((item) => item.key === value) ? value : CLASSES[0].key;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`;
}

function dayLabel(iso) {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Сегодня';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function isMessage(row) {
  return row && typeof row.id === 'string' && typeof row.author_id === 'string'
    && typeof row.author_name === 'string' && typeof row.body === 'string' && typeof row.created_at === 'string';
}

function messageEndpoint(view) {
  return view.kind === 'channel'
    ? `${PATH}/api/channels/${view.id}/messages`
    : `${PATH}/api/dm/${view.id}/messages`;
}

function failText(cause) {
  return cause instanceof Error ? cause.message : 'Сервис временно недоступен. Попробуйте позже.';
}

function handleAuthFailure(cause) {
  if (cause instanceof ApiError && cause.status === 401) {
    sessionExpired();
    return true;
  }
  return false;
}

function setProfileError(message) {
  el.profileError.textContent = message;
  el.profileError.hidden = !message;
}

function applySelfToMessages() {
  if (!state.user) return;
  let changed = false;
  state.messages = state.messages.map((message) => {
    if (message.author_id !== state.user.id) return message;
    if (message.author_name === state.user.nickname
      && message.author_class === state.user.class_key
      && message.author_avatar === state.user.avatar_updated_at) return message;
    changed = true;
    return {
      ...message,
      author_name: state.user.nickname,
      author_class: state.user.class_key,
      author_avatar: state.user.avatar_updated_at,
    };
  });
  if (changed) renderMessages();
}

/* ----- auth ----- */

function switchAuthMode(mode) {
  const login = mode === 'login';
  el.tabLogin.setAttribute('aria-selected', String(login));
  el.tabRegister.setAttribute('aria-selected', String(!login));
  el.loginForm.hidden = !login;
  el.registerForm.hidden = login;
  setAuthError('');
}

function bindPasswordToggle(button, input) {
  button.addEventListener('click', () => {
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    button.textContent = shown ? 'Показать' : 'Скрыть';
    button.setAttribute('aria-pressed', String(!shown));
  });
}

function setAuthBusy(busy) {
  state.busy = busy;
  el.loginSubmit.disabled = busy;
  el.registerSubmit.disabled = busy;
}

function acceptUser(body) {
  if (!body?.user || typeof body.user.id !== 'string' || typeof body.user.username !== 'string') {
    throw new ApiError('Сервис вернул некорректный ответ.', 'invalid_response');
  }
  return body.user;
}

async function submitLogin() {
  if (state.busy) return;
  const username = el.loginUsername.value.trim();
  const password = el.loginPassword.value;
  el.loginPassword.value = '';
  setAuthError('');
  setAuthBusy(true);
  try {
    const body = await requestJson(`${PATH}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }, MESSAGES);
    el.loginUsername.value = '';
    state.user = acceptUser(body);
    await enterApp();
  } catch (cause) {
    setAuthError(failText(cause));
  } finally {
    setAuthBusy(false);
  }
}

async function submitRegister() {
  if (state.busy) return;
  const username = el.registerUsername.value.trim();
  const password = el.registerPassword.value;
  const firstName = el.registerFirst.value.trim();
  const lastName = el.registerLast.value.trim();
  const nickname = el.registerNickname.value.trim();
  const classKey = el.registerClass.value;
  setAuthError('');
  if (!firstName || !lastName) {
    setAuthError('Укажите имя и фамилию — их увидят только в вашем полном профиле.');
    return;
  }
  if (!nickname) {
    setAuthError('Придумайте игровой ник — именно его видят остальные.');
    return;
  }
  if (!classKey) {
    setAuthError('Выберите класс.');
    return;
  }
  el.registerPassword.value = '';
  setAuthBusy(true);
  try {
    const body = await requestJson(`${PATH}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        first_name: firstName,
        last_name: lastName,
        nickname,
        class_key: classKey,
      }),
    }, MESSAGES);
    el.registerUsername.value = '';
    el.registerFirst.value = '';
    el.registerLast.value = '';
    el.registerNickname.value = '';
    state.user = acceptUser(body);
    await enterApp();
  } catch (cause) {
    setAuthError(failText(cause));
  } finally {
    setAuthBusy(false);
  }
}

async function loadSession() {
  try {
    const body = await requestJson(`${PATH}/api/me`, {}, MESSAGES);
    state.user = acceptUser(body);
    await enterApp();
  } catch (cause) {
    showAuth(false);
    if (!(cause instanceof ApiError && cause.status === 401)) setAuthError(failText(cause));
  }
}

function showAuth(expired) {
  stopTimers();
  voice.leave();
  el.voicePanel.hidden = true;
  el.voicePanelPeers.replaceChildren();
  state.user = null;
  state.view = null;
  state.messages = [];
  state.pending = null;
  state.channels = [];
  state.dms = [];
  state.users = [];
  voiceBusy = false;
  setVoiceNote('');
  el.appScreen.hidden = true;
  el.authScreen.hidden = false;
  closeSidebar();
  switchAuthMode('login');
  if (expired) setAuthError('Сессия истекла. Войдите снова.');
}

function sessionExpired() {
  showAuth(true);
}

async function logout() {
  try {
    await requestJson(`${PATH}/api/logout`, { method: 'POST' }, MESSAGES);
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 401)) {
      showAuth(false);
      setAuthError(failText(cause));
      return;
    }
  }
  showAuth(false);
}

/* ----- app entry and lists ----- */

function syncMe() {
  if (!state.user) return;
  applyAvatar(el.meAvatar, state.user);
  paintNickname(el.meName, state.user);
}

async function enterApp() {
  el.authScreen.hidden = true;
  el.appScreen.hidden = false;
  setAuthError('');
  syncMe();
  startTimers();
  await refreshLists();
  if (!state.view) {
    const general = state.channels.find((c) => c.name === 'общий') || state.channels[0];
    if (general) await selectView({ kind: 'channel', id: general.id, title: general.name });
  }
}

async function refreshLists() {
  if (!state.user) return;
  try {
    const [channels, dms, users] = await Promise.all([
      requestJson(`${PATH}/api/channels`, {}, MESSAGES),
      requestJson(`${PATH}/api/dm`, {}, MESSAGES),
      requestJson(`${PATH}/api/users`, {}, MESSAGES),
    ]);
    if (!Array.isArray(channels) || !Array.isArray(dms) || !Array.isArray(users)) {
      throw new ApiError('Сервис вернул некорректный ответ.', 'invalid_response');
    }
    state.channels = channels;
    state.dms = dms;
    state.users = users;
    renderChannels();
    renderDms();
    renderMembers();
    updateVoiceJoinButton();
    if (state.view?.kind === 'channel' && !channels.some((c) => c.id === state.view.id)) {
      state.view = null;
      const first = channels[0];
      if (first) await selectView({ kind: 'channel', id: first.id, title: first.name });
    }
    if (state.view?.kind === 'dm') {
      const thread = dms.find((dm) => dm.id === state.view.id);
      if (thread) {
        state.view = { ...state.view, title: thread.peer.nickname, classKey: thread.peer.class_key };
        paintViewTitle();
      }
    }
  } catch (cause) {
    handleAuthFailure(cause);
  }
}

function renderChannels() {
  el.channelList.innerHTML = '';
  for (const channel of state.channels) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    if (state.view?.kind === 'channel' && state.view.id === channel.id) button.classList.add('active');
    const hash = document.createElement('span');
    hash.className = 'channel-hash';
    hash.textContent = '#';
    hash.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'nav-name';
    name.textContent = channel.name;
    button.append(hash, name);
    button.addEventListener('click', () => selectView({ kind: 'channel', id: channel.id, title: channel.name }));
    li.append(button);
    el.channelList.append(li);
  }
}

function renderDms() {
  el.dmList.innerHTML = '';
  el.dmEmpty.hidden = state.dms.length > 0;
  for (const dm of state.dms) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    if (state.view?.kind === 'dm' && state.view.id === dm.id) button.classList.add('active');
    button.append(makeAvatar(dm.peer, true));
    const name = document.createElement('span');
    name.className = 'nav-name';
    paintNickname(name, dm.peer);
    button.append(name);
    button.addEventListener('click', () => selectView({
      kind: 'dm', id: dm.id, title: dm.peer.nickname, classKey: dm.peer.class_key,
    }));
    li.append(button);
    el.dmList.append(li);
  }
}

function renderMembers() {
  el.memberList.innerHTML = '';
  el.membersCount.textContent = `Участники — ${state.users.length}`;
  for (const user of state.users) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.append(makeAvatar(user, true));
    const text = document.createElement('span');
    text.className = 'member-text';
    const name = document.createElement('span');
    name.className = 'member-name';
    paintNickname(name, user);
    const role = document.createElement('span');
    role.className = 'member-class';
    role.textContent = className(user.class_key) || 'без класса';
    text.append(name, role);
    button.append(text);
    if (user.id === state.user?.id) {
      const self = document.createElement('span');
      self.className = 'member-self';
      self.textContent = 'это вы';
      button.append(self);
      button.title = 'Открыть мой профиль';
      button.addEventListener('click', openProfileEditor);
    } else {
      button.title = 'Открыть профиль';
      button.addEventListener('click', () => openUserProfile(user));
    }
    li.append(button);
    el.memberList.append(li);
  }
}

/* ----- views and messages ----- */

function paintViewTitle() {
  if (!state.view) return;
  el.viewTitle.textContent = state.view.title;
  el.viewTitle.style.color = state.view.kind === 'dm' ? classColor(state.view.classKey) ?? '' : '';
}

async function selectView(view) {
  state.view = view;
  state.messages = [];
  state.pending = null;
  hideSendBar();
  const token = ++state.viewToken;
  el.viewIcon.textContent = view.kind === 'channel' ? '#' : '@';
  paintViewTitle();
  updateVoiceJoinButton();
  setVoiceNote('');
  el.input.placeholder = view.kind === 'channel' ? `Написать в #${view.title}` : `Написать @${view.title}`;
  el.input.value = '';
  renderChannels();
  renderDms();
  closeSidebar();
  renderMessages();
  try {
    const rows = await requestJson(messageEndpoint(view), {}, MESSAGES);
    if (token !== state.viewToken) return;
    if (!Array.isArray(rows) || rows.some((row) => !isMessage(row))) {
      throw new ApiError('Сервис вернул некорректный ответ.', 'invalid_response');
    }
    state.messages = rows.map(withOwnProfile);
    renderMessages(true);
  } catch (cause) {
    if (token !== state.viewToken) return;
    if (!handleAuthFailure(cause)) showSendBar(failText(cause), false);
  }
}

// A poll started before a profile edit can land after it, so own messages always
// take the author fields from the current profile instead of the stale response.
function withOwnProfile(row) {
  if (!state.user || row.author_id !== state.user.id) return row;
  return {
    ...row,
    author_name: state.user.nickname,
    author_class: state.user.class_key,
    author_avatar: state.user.avatar_updated_at,
  };
}

function mergeMessages(rows) {
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  let changed = false;
  for (const raw of rows) {
    const row = withOwnProfile(raw);
    const previous = byId.get(row.id);
    if (!previous) {
      byId.set(row.id, row);
      changed = true;
      continue;
    }
    if (previous.author_name !== row.author_name
      || previous.author_class !== row.author_class
      || previous.author_avatar !== row.author_avatar) {
      byId.set(row.id, {
        ...previous,
        author_name: row.author_name,
        author_class: row.author_class,
        author_avatar: row.author_avatar,
      });
      changed = true;
    }
  }
  if (!changed) return false;
  state.messages = [...byId.values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .slice(-200);
  return true;
}

async function pollMessages() {
  if (!state.user || !state.view || document.hidden) return;
  const view = state.view;
  const token = state.viewToken;
  try {
    const rows = await requestJson(messageEndpoint(view), {}, MESSAGES);
    if (token !== state.viewToken || !Array.isArray(rows) || rows.some((row) => !isMessage(row))) return;
    if (mergeMessages(rows)) renderMessages();
  } catch (cause) {
    handleAuthFailure(cause);
  }
}

function nearBottom() {
  return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 100;
}

function authorOf(message) {
  return {
    id: message.author_id,
    nickname: message.author_name,
    class_key: message.author_class ?? null,
    avatar_updated_at: message.author_avatar ?? null,
  };
}

function renderMessages(forceScroll = false) {
  const stick = forceScroll || nearBottom();
  el.messages.innerHTML = '';
  if (state.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const big = document.createElement('div');
    big.className = 'big';
    big.textContent = state.view?.kind === 'channel' ? '#' : '@';
    const text = document.createElement('p');
    text.textContent = state.view?.kind === 'channel'
      ? `Добро пожаловать в #${state.view.title}! Здесь пока нет сообщений — напишите первым.`
      : `Это начало вашей переписки с ${state.view?.title ?? ''}. Напишите первым.`;
    empty.append(big, text);
    el.messages.append(empty);
    return;
  }
  let lastDay = '';
  let prev = null;
  for (const message of state.messages) {
    const day = new Date(message.created_at).toDateString();
    if (day !== lastDay) {
      const divider = document.createElement('div');
      divider.className = 'day-divider';
      divider.textContent = dayLabel(message.created_at);
      el.messages.append(divider);
      lastDay = day;
      prev = null;
    }
    const compact = prev && prev.author_id === message.author_id
      && Date.parse(message.created_at) - Date.parse(prev.created_at) < 5 * 60 * 1000;
    const row = document.createElement('div');
    row.className = compact ? 'msg compact' : 'msg';
    const author = authorOf(message);
    if (!compact) row.append(makeAvatar(author));
    const body = document.createElement('div');
    body.className = 'msg-body';
    if (!compact) {
      const head = document.createElement('div');
      head.className = 'msg-head';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'msg-author';
      paintNickname(name, author);
      name.title = 'Открыть профиль';
      name.addEventListener('click', () => openUserProfile(author));
      const time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = formatTime(message.created_at);
      head.append(name, time);
      body.append(head);
    }
    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = message.body;
    body.append(text);
    row.append(body);
    el.messages.append(row);
    prev = message;
  }
  if (stick) el.messages.scrollTop = el.messages.scrollHeight;
}

/* ----- sending ----- */

function showSendBar(text, retryable) {
  el.sendBarText.textContent = text;
  el.retrySend.hidden = !retryable;
  el.sendBar.hidden = false;
  el.input.disabled = retryable;
  el.sendBtn.disabled = retryable;
}

function hideSendBar() {
  el.sendBar.hidden = true;
  el.input.disabled = false;
  el.sendBtn.disabled = false;
}

async function sendMessage() {
  if (!state.user || !state.view) return;
  const text = el.input.value;
  if (!state.pending && !text.trim()) return;
  const command = state.pending ?? { key: crypto.randomUUID(), body: text, viewId: state.view.id };
  const view = state.view;
  const token = state.viewToken;
  el.sendBtn.disabled = true;
  try {
    const created = await requestJson(messageEndpoint(view), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': command.key },
      body: JSON.stringify({ body: command.body }),
    }, MESSAGES);
    if (!isMessage(created)) throw new ApiError('Сервис вернул некорректный ответ.', 'invalid_response');
    state.pending = null;
    el.input.value = '';
    autoResize();
    hideSendBar();
    if (token === state.viewToken) {
      mergeMessages([created]);
      renderMessages(true);
    }
  } catch (cause) {
    if (handleAuthFailure(cause)) return;
    if (isWriteOutcomeUnknown(cause)) {
      state.pending = command;
      showSendBar('Отправка не подтверждена. Повторите то же сообщение или отмените.', true);
      return;
    }
    if (cause instanceof ApiError && cause.code === 'idempotency_conflict') {
      state.pending = null;
      hideSendBar();
      showSendBar(cause.message, false);
      return;
    }
    showSendBar(failText(cause), false);
  } finally {
    if (!state.pending) el.sendBtn.disabled = false;
  }
}

function autoResize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 140)}px`;
}

/* ----- profile ----- */

function updateRegisterPreview() {
  const nickname = el.registerNickname.value.trim() || 'ВашНик';
  el.registerPreview.textContent = nickname;
  el.registerPreview.style.color = classColor(el.registerClass.value) ?? '';
}

function updateProfilePreview() {
  const nickname = el.profileNickname.value.trim() || 'ВашНик';
  el.profilePreview.textContent = nickname;
  el.profilePreview.style.color = classColor(el.profileClass.value) ?? '';
  el.profileClassLabel.textContent = className(el.profileClass.value) || '';
}

function openProfileEditor() {
  if (!state.user) return;
  setProfileError('');
  el.profileFirst.value = state.user.first_name ?? '';
  el.profileLast.value = state.user.last_name ?? '';
  el.profileNickname.value = state.user.nickname ?? '';
  fillClassSelect(el.profileClass, state.user.class_key);
  el.profileLogin.textContent = state.user.username;
  el.profileRemoveAvatar.hidden = !state.user.avatar_updated_at;
  applyAvatar(el.profileAvatar, state.user);
  el.profileAvatar.title = state.user.avatar_updated_at ? 'Заменить фото' : 'Загрузить фото';
  updateProfilePreview();
  el.profileDialog.showModal();
}

async function saveProfile(event) {
  event.preventDefault();
  if (!state.user) return;
  const firstName = el.profileFirst.value.trim();
  const lastName = el.profileLast.value.trim();
  const nickname = el.profileNickname.value.trim();
  const classKey = el.profileClass.value;
  setProfileError('');
  if (!firstName || !lastName) {
    setProfileError('Имя и фамилия не могут быть пустыми.');
    return;
  }
  if (!nickname) {
    setProfileError('Игровой ник не может быть пустым.');
    return;
  }
  el.profileSave.disabled = true;
  try {
    const body = await requestJson(`${PATH}/api/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        first_name: firstName,
        last_name: lastName,
        nickname,
        class_key: classKey,
      }),
    }, MESSAGES);
    state.user = acceptUser(body);
    syncMe();
    applySelfToMessages();
    await refreshLists();
    el.profileDialog.close();
    showSendBar('Профиль обновлён.', false);
    setTimeout(() => {
      if (!el.sendBar.hidden && el.sendBarText.textContent === 'Профиль обновлён.') hideSendBar();
    }, 2500);
  } catch (cause) {
    if (handleAuthFailure(cause)) {
      el.profileDialog.close();
      return;
    }
    setProfileError(failText(cause));
  } finally {
    el.profileSave.disabled = false;
  }
}

function fillUserDialog(profile, loaded) {
  applyAvatar(el.userAvatar, profile);
  paintNickname(el.userNickname, profile);
  el.userClass.textContent = className(profile.class_key) || 'класс не выбран';
  el.userClass.style.color = classColor(profile.class_key) ?? '';
  el.userRealname.textContent = loaded ? realNameText(profile) : 'загружается…';
}

async function openUserProfile(user) {
  if (!user?.id) return;
  if (user.id === state.user?.id) {
    openProfileEditor();
    return;
  }
  state.userDialogId = user.id;
  el.userError.hidden = true;
  el.userDm.hidden = false;
  fillUserDialog({
    id: user.id,
    nickname: user.nickname,
    class_key: user.class_key ?? null,
    avatar_updated_at: user.avatar_updated_at ?? null,
    first_name: '',
    last_name: '',
  }, false);
  el.userDialog.showModal();
  try {
    const profile = await requestJson(`${PATH}/api/users/${user.id}/profile`, {}, MESSAGES);
    if (state.userDialogId !== user.id) return;
    fillUserDialog(profile, true);
  } catch (cause) {
    if (state.userDialogId !== user.id) return;
    if (handleAuthFailure(cause)) {
      el.userDialog.close();
      return;
    }
    el.userError.textContent = failText(cause);
    el.userError.hidden = false;
  }
}

/* ----- avatar ----- */

function dataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return Infinity;
  return Math.floor((dataUrl.length - comma - 1) * 3 / 4);
}

// createImageBitmap decodes the file directly; some environments block blob: URLs
// that an <img> would need, so that path is only a fallback.
async function openImageFile(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
    } catch { /* try again without options, then fall back to <img> */ }
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
    } catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  const loaded = new Promise((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
  });
  image.src = url;
  if (!(await loaded)) {
    URL.revokeObjectURL(url);
    return null;
  }
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

async function shrinkAvatar(file) {
  if (!file.type.startsWith('image/')) {
    throw new ApiError('Это не изображение. Выберите файл JPG, PNG или WEBP.', 'invalid_avatar');
  }
  if (file.size > AVATAR_FILE_LIMIT) {
    throw new ApiError('Файл больше 12 МБ. Выберите фото поменьше.', 'invalid_avatar');
  }
  const image = await openImageFile(file);
  if (!image) throw new ApiError('Не удалось прочитать изображение. Выберите другой файл.', 'invalid_avatar');
  try {
    const side = Math.min(image.width, image.height);
    if (!side) throw new ApiError('Не удалось прочитать изображение.', 'invalid_avatar');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new ApiError('Браузер не смог обработать фото.', 'invalid_avatar');
    context.imageSmoothingQuality = 'high';
    const sx = (image.width - side) / 2;
    const sy = (image.height - side) / 2;
    for (const size of [256, 192, 160, 128]) {
      canvas.width = size;
      canvas.height = size;
      context.drawImage(image.source, sx, sy, side, side, 0, 0, size, size);
      for (const quality of [0.82, 0.72, 0.62]) {
        const dataUrl = canvas.toDataURL('image/webp', quality);
        if (dataUrlBytes(dataUrl) <= AVATAR_SOFT_LIMIT) return dataUrl;
      }
    }
    const fallback = canvas.toDataURL('image/webp', 0.6);
    if (dataUrlBytes(fallback) > AVATAR_HARD_LIMIT) {
      throw new ApiError('Не удалось уместить фото. Выберите другое.', 'invalid_avatar');
    }
    return fallback;
  } finally {
    image.release();
  }
}

async function uploadAvatar(file) {
  if (!file) return;
  setProfileError('');
  el.profileAvatar.disabled = true;
  try {
    const dataUrl = await shrinkAvatar(file);
    const body = await requestJson(`${PATH}/api/me/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
    }, MESSAGES);
    state.user = acceptUser(body);
    syncMe();
    applyAvatar(el.profileAvatar, state.user);
    el.profileRemoveAvatar.hidden = false;
    el.profileAvatar.title = 'Заменить фото';
    applySelfToMessages();
    await refreshLists();
  } catch (cause) {
    if (handleAuthFailure(cause)) {
      el.profileDialog.close();
      return;
    }
    setProfileError(failText(cause));
  } finally {
    el.profileAvatar.disabled = false;
  }
}

async function removeAvatar() {
  if (!state.user?.avatar_updated_at) return;
  setProfileError('');
  el.profileRemoveAvatar.disabled = true;
  try {
    const body = await requestJson(`${PATH}/api/me/avatar`, { method: 'DELETE' }, MESSAGES);
    state.user = acceptUser(body);
    syncMe();
    applyAvatar(el.profileAvatar, state.user);
    el.profileRemoveAvatar.hidden = true;
    el.profileAvatar.title = 'Загрузить фото';
    applySelfToMessages();
    await refreshLists();
  } catch (cause) {
    if (handleAuthFailure(cause)) {
      el.profileDialog.close();
      return;
    }
    setProfileError(failText(cause));
  } finally {
    el.profileRemoveAvatar.disabled = false;
  }
}

/* ----- channels and DM creation ----- */

async function createChannel(event) {
  event.preventDefault();
  const name = el.channelName.value.trim();
  if (!name) return;
  el.channelError.hidden = true;
  const submit = document.getElementById('channel-submit');
  submit.disabled = true;
  try {
    const created = await requestJson(`${PATH}/api/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }, MESSAGES);
    if (typeof created?.id !== 'string' || typeof created?.name !== 'string') {
      throw new ApiError('Сервис вернул некорректный ответ.', 'invalid_response');
    }
    el.channelDialog.close();
    el.channelName.value = '';
    await refreshLists();
    await selectView({ kind: 'channel', id: created.id, title: created.name });
  } catch (cause) {
    if (!handleAuthFailure(cause)) {
      el.channelError.textContent = failText(cause);
      el.channelError.hidden = false;
    }
  } finally {
    submit.disabled = false;
  }
}

function openDmDialog() {
  el.dmError.hidden = true;
  el.dmUserList.innerHTML = '';
  const candidates = state.users.filter((u) => u.id !== state.user?.id);
  if (candidates.length === 0) {
    const li = document.createElement('li');
    li.className = 'list-hint';
    li.textContent = 'Пока больше никого нет. Пригласите друзей зарегистрироваться!';
    el.dmUserList.append(li);
  }
  for (const user of candidates) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.append(makeAvatar(user, true));
    const name = document.createElement('span');
    name.className = 'nav-name';
    paintNickname(name, user);
    button.append(name);
    button.addEventListener('click', async () => {
      el.dmDialog.close();
      await openDmWith(user.id);
    });
    li.append(button);
    el.dmUserList.append(li);
  }
  el.dmDialog.showModal();
}

async function openDmWith(userId) {
  try {
    const opened = await requestJson(`${PATH}/api/dm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    }, MESSAGES);
    if (typeof opened?.id !== 'string' || typeof opened?.peer?.nickname !== 'string') {
      throw new ApiError('Сервис вернул некорректный ответ.', 'invalid_response');
    }
    await refreshLists();
    await selectView({
      kind: 'dm',
      id: opened.id,
      title: opened.peer.nickname,
      classKey: opened.peer.class_key,
    });
  } catch (cause) {
    if (!handleAuthFailure(cause)) showSendBar(failText(cause), false);
  }
}

/* ----- sidebar (mobile) ----- */

function openSidebar() {
  el.sidebar.classList.add('open');
  el.backdrop.hidden = false;
}

function closeSidebar() {
  el.sidebar.classList.remove('open');
  el.backdrop.hidden = true;
}

/* ----- timers ----- */

function startTimers() {
  stopTimers();
  state.tick = 0;
  state.pollTimer = setInterval(() => {
    if (document.hidden) return;
    state.tick += 1;
    void pollMessages();
    if (state.tick % LISTS_EVERY_TICKS === 0) void refreshLists();
  }, POLL_MS);
}

function stopTimers() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* ----- voice ----- */

let voiceRoom = { peers: [], limit: 6 };

const voice = createVoiceEngine({
  onPeers: renderVoicePeers,
  onStatus: (text) => setVoiceNote(text),
  onError: (code) => {
    setVoiceNote(MESSAGES[code] ?? MESSAGES.voice_connect_failed);
    updateVoiceJoinButton();
  },
  onState: () => {
    updateVoiceJoinButton();
    updateVoicePanel();
  },
  onAuthError: () => sessionExpired(),
});

function setVoiceNote(text, link) {
  el.voiceNote.replaceChildren();
  el.voiceNote.hidden = !text;
  if (!text) return;
  el.voiceNote.append(document.createTextNode(text));
  if (!link) return;
  el.voiceNote.append(document.createTextNode(' '));
  const anchor = document.createElement('a');
  anchor.href = link;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = 'Открыть комнату';
  el.voiceNote.append(anchor);
}

function renderVoicePeers(list, limit) {
  voiceRoom = { peers: list, limit };
  el.voicePanelPeers.replaceChildren(...list.map((peer) => {
    const item = document.createElement('li');
    item.className = peer.self ? 'voice-peer self' : 'voice-peer';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    applyAvatar(avatar, { id: peer.id, nickname: peer.name, avatar_updated_at: peer.avatar_updated_at });
    const name = document.createElement('span');
    name.textContent = peer.name || 'Игрок';
    item.append(avatar, name);
    if (peer.self) {
      const you = document.createElement('span');
      you.className = 'voice-panel-count';
      you.textContent = 'вы';
      item.append(you);
    }
    if (peer.muted) {
      const off = document.createElement('span');
      off.className = 'voice-peer-off';
      off.textContent = 'микрофон выкл.';
      item.append(off);
    }
    return item;
  }));
  el.voiceMute.textContent = voice.muted ? 'Включить микрофон' : 'Выключить микрофон';
  el.voiceMute.setAttribute('aria-pressed', voice.muted ? 'true' : 'false');
  updateVoicePanel();
}

function updateVoicePanel() {
  const engaged = voice.connected || voice.connecting;
  el.voicePanel.hidden = !engaged;
  if (!engaged) {
    el.voicePanelPeers.replaceChildren();
    return;
  }
  el.voicePanelTitle.textContent = voice.channelName ? `Голос · #${voice.channelName}` : 'Голосовая комната';
  el.voicePanelCount.textContent = `${voiceRoom.peers.length} / ${voiceRoom.limit}`;
}

function updateVoiceJoinButton() {
  const view = state.view?.kind === 'channel' ? state.view : null;
  el.voiceJoin.hidden = !view;
  if (!view) return;
  el.voiceJoin.disabled = voice.connecting || voice.connected;
  el.voiceJoinLabel.textContent = voice.connecting ? 'Подключаемся…' : voice.connected ? 'Вы в голосе' : 'Голос';
  el.voiceJoin.title = voice.connected
    ? `Вы в голосовом канале #${voice.channelName ?? view.title}`
    : `Войти в голосовой канал #${view.title}`;
}

async function joinVoiceRoom() {
  const view = state.view;
  if (!state.user || view?.kind !== 'channel') return;
  if (voice.connected) {
    setVoiceNote('Вы уже в голосовой комнате. Выйдите из неё, чтобы зайти в другой канал.');
    return;
  }
  if (voice.connecting) return;
  setVoiceNote('Подключаемся к голосовому каналу…');
  await voice.join({ id: view.id, name: view.title });
  updateVoiceJoinButton();
}

function leaveVoiceRoom() {
  voice.leave();
  setVoiceNote('');
}

// Fallback only: the permanent Telemost room opens in its own tab if in-site sound fails.
function openTelemostRoom() {
  const view = state.view;
  if (voiceBusy || view?.kind !== 'channel' || !state.user) return;
  voiceBusy = true;
  setVoiceNote('Открываем запасную комнату в Телемосте…');

  const tab = window.open('', '_blank');
  void (async () => {
    try {
      if (tab) tab.document.title = 'Открываем голосовую комнату…';
      const info = await requestJson(`${PATH}/api/channels/${view.id}/voice`, { method: 'POST' }, MESSAGES);
      if (typeof info?.join_url !== 'string' || !info.join_url.startsWith('https://')) {
        throw new ApiError('Сервис вернул некорректный ответ.', 'invalid_response');
      }
      if (tab) {
        try { tab.opener = null; } catch { /* detached opener is best-effort */ }
        tab.location.href = info.join_url;
        setVoiceNote('');
      } else {
        setVoiceNote('Браузер не открыл новую вкладку.', info.join_url);
      }
    } catch (cause) {
      try { if (tab) tab.close(); } catch { /* the tab may already be gone */ }
      if (!handleAuthFailure(cause)) setVoiceNote(failText(cause));
    } finally {
      voiceBusy = false;
    }
  })();
}

/* ----- bindings ----- */

el.tabLogin.addEventListener('click', () => switchAuthMode('login'));
el.tabRegister.addEventListener('click', () => switchAuthMode('register'));
bindPasswordToggle(el.loginToggle, el.loginPassword);
bindPasswordToggle(el.registerToggle, el.registerPassword);
fillClassSelect(el.registerClass, 'warrior');
fillClassSelect(el.profileClass, 'warrior');
updateRegisterPreview();
el.registerNickname.addEventListener('input', updateRegisterPreview);
el.registerClass.addEventListener('change', updateRegisterPreview);
el.loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitLogin();
});
el.registerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitRegister();
});
el.logout.addEventListener('click', () => void logout());
el.voiceJoin.addEventListener('click', () => void joinVoiceRoom());
el.voiceLeave.addEventListener('click', leaveVoiceRoom);
el.voiceMute.addEventListener('click', () => {
  if (voice.connected) voice.toggleMute();
});
el.voiceFallback.addEventListener('click', () => void openTelemostRoom());
el.meAvatar.addEventListener('click', openProfileEditor);
el.meName.addEventListener('click', openProfileEditor);
el.menuToggle.addEventListener('click', openSidebar);
el.backdrop.addEventListener('click', closeSidebar);
el.addChannel.addEventListener('click', () => {
  el.channelError.hidden = true;
  el.channelDialog.showModal();
  el.channelName.focus();
});
el.channelCancel.addEventListener('click', () => el.channelDialog.close());
el.channelForm.addEventListener('submit', (event) => void createChannel(event));
el.addDm.addEventListener('click', openDmDialog);
el.dmCancel.addEventListener('click', () => el.dmDialog.close());
el.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  void sendMessage();
});
el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});
el.input.addEventListener('input', autoResize);
el.retrySend.addEventListener('click', () => void sendMessage());
el.dismissSend.addEventListener('click', () => {
  state.pending = null;
  hideSendBar();
});

el.profileNickname.addEventListener('input', updateProfilePreview);
el.profileClass.addEventListener('change', updateProfilePreview);
el.profileForm.addEventListener('submit', (event) => void saveProfile(event));
el.profileCancel.addEventListener('click', () => el.profileDialog.close());
el.profileAvatar.addEventListener('click', () => el.avatarFile.click());
el.avatarFile.addEventListener('change', () => {
  const file = el.avatarFile.files?.[0] ?? null;
  el.avatarFile.value = '';
  void uploadAvatar(file);
});
el.profileRemoveAvatar.addEventListener('click', () => void removeAvatar());
el.profileDialog.addEventListener('close', () => setProfileError(''));

el.userClose.addEventListener('click', () => el.userDialog.close());
el.userDm.addEventListener('click', () => {
  const id = state.userDialogId;
  el.userDialog.close();
  if (id) void openDmWith(id);
});
el.userDialog.addEventListener('close', () => {
  state.userDialogId = null;
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.user) {
    void pollMessages();
    void refreshLists();
  }
});

window.addEventListener('pagehide', () => voice.leave());

void loadSession();
