// Application routes: register / login / logout / current user + messenger (chat.mjs).
// Application identity always comes from this app's own session verification (digest in
// the database); never from ctx.user, platform identity, Host headers or client owner ids.
import { AppError, applicationPath, errorJson, json, readJson, requireTrustedOrigin, rows } from './http.mjs';
import { canonicalUsername, validateClassKey, validateNickname, validatePassword, validateRealName } from './validate.mjs';
import { hashPassword, verifyPassword, verifyPasswordAgainstDummy } from './passwords.mjs';
import { SESSION_TTL_MS, clearSessionCookie, createSession, revokeSession, sessionCookie, validateSession } from './sessions.mjs';
import { consume } from './limiter.mjs';
import { handleChat, isChatPath } from './chat.mjs';
import { handleVoice, isVoicePath, voiceConfig } from './voice.mjs';
import { PROFILE_COLUMNS, profileOf, removeAvatar, saveAvatar, serveAvatar, updateProfile } from './profile.mjs';

const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const encoder = new TextEncoder();

class SessionRequired extends Error {
  constructor(state) {
    super('login_required');
    this.state = state;
  }
}

const retryAfter = (result) => ({ 'retry-after': String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) });

// An invalid cookie (expired / revoked / tampered) is cleared so the browser stops resending it.
function unauthorized(state) {
  return state === 'invalid'
    ? errorJson('login_required', 401, { 'set-cookie': clearSessionCookie() })
    : errorJson('login_required', 401);
}

async function requireSession(db, request) {
  const result = await validateSession(db, request);
  if (result.state !== 'valid') throw new SessionRequired(result.state);
  return result.session;
}

// Session credentials are verified server-side only; the profile is read separately.
async function loadUser(db, userId) {
  const found = rows(await db.from('users').select(PROFILE_COLUMNS).eq('id', userId).limit(1));
  if (found.length !== 1 || typeof found[0]?.username !== 'string') {
    throw new SessionRequired('invalid');
  }
  return found[0];
}

function boundedPassword(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || encoder.encode(raw).length > 256) {
    throw new AppError('invalid_input', 400);
  }
  return raw;
}

async function register(db, request) {
  const body = await readJson(request);
  const username = canonicalUsername(body?.username);
  const password = validatePassword(body?.password);
  // Registration is rate limited too (counted per canonical username).
  const limit = await consume(db, 'register', username);
  if (!limit.allowed) return errorJson('rate_limited', 429, retryAfter(limit));

  const firstName = validateRealName(body?.first_name);
  const lastName = validateRealName(body?.last_name);
  const nickname = validateNickname(body?.nickname);
  const classKey = validateClassKey(body?.class_key);

  const existing = rows(await db.from('users').select('id').eq('username', username).limit(1));
  if (existing.length > 0) return errorJson('username_taken', 409);

  const derived = await hashPassword(password);
  const id = crypto.randomUUID();
  // Uniqueness is decided by the database UNIQUE constraint under concurrent registration.
  const created = rows(await db.from('users').insertIfAbsent({
    id,
    username,
    first_name: firstName,
    last_name: lastName,
    nickname,
    class_key: classKey,
    password_salt: derived.salt,
    password_hash: derived.hash,
    password_iterations: derived.iterations,
    created_at: new Date().toISOString(),
  }, { onConflict: 'username' }).select(PROFILE_COLUMNS));

  if (created.length !== 1) {
    const winner = rows(await db.from('users').select('id').eq('username', username).limit(1));
    if (winner.length === 1) return errorJson('username_taken', 409);
    // Neither written nor readable: outcome unconfirmed; never replay.
    return errorJson('registration_unconfirmed', 503);
  }

  const { token } = await createSession(db, id);
  return json({ user: profileOf(created[0]) }, 201, { 'set-cookie': sessionCookie(token, SESSION_TTL_SECONDS) });
}

async function login(db, request) {
  const body = await readJson(request);
  const username = canonicalUsername(body?.username);
  // Consume quota first: unknown accounts count too, so failures cannot probe existence.
  const limit = await consume(db, 'login', username);
  if (!limit.allowed) return errorJson('rate_limited', 429, retryAfter(limit));

  const password = boundedPassword(body?.password);
  const found = rows(await db.from('users')
    .select(`${PROFILE_COLUMNS},password_salt,password_hash,password_iterations`).eq('username', username).limit(1));

  if (found.length !== 1) {
    // Pay the same derivation cost for unknown usernames, then return the shared error code.
    await verifyPasswordAgainstDummy(password);
    return errorJson('invalid_credentials', 401);
  }

  const user = found[0];
  const ok = await verifyPassword(password, {
    salt: user.password_salt, hash: user.password_hash, iterations: user.password_iterations,
  });
  if (!ok) return errorJson('invalid_credentials', 401);

  // A successful login does not reset the window counter.
  const { token } = await createSession(db, user.id);
  return json({ user: profileOf(user) }, 200, { 'set-cookie': sessionCookie(token, SESSION_TTL_SECONDS) });
}

async function logout(db, request) {
  const result = await validateSession(db, request);
  if (result.state === 'valid' && result.session) {
    try {
      await revokeSession(db, result.session.digest);
    } catch {
      // Revocation outcome unknown: keep the cookie so logout can be retried; no replay, no false success.
      return errorJson('logout_unconfirmed', 503);
    }
  }
  // Revoke the database session first, then clear the cookie.
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
}

async function route(db, request, origin, voice, fetchImpl) {
  requireTrustedOrigin(request, origin);
  const path = applicationPath(request);

  if (path === '/api/health' && request.method === 'GET') return json({ ok: true });
  if (path === '/api/register' && request.method === 'POST') return register(db, request);
  if (path === '/api/login' && request.method === 'POST') return login(db, request);
  if (path === '/api/logout' && request.method === 'POST') return logout(db, request);

  if (path === '/api/me') {
    const session = await requireSession(db, request);
    if (request.method === 'GET') return json({ user: profileOf(await loadUser(db, session.userId)) });
    if (request.method === 'PATCH') return updateProfile(db, request, session.userId);
    throw new AppError('method_not_allowed', 405);
  }

  if (path === '/api/me/avatar') {
    const session = await requireSession(db, request);
    if (request.method === 'POST') return saveAvatar(db, request, session.userId);
    if (request.method === 'DELETE') return removeAvatar(db, session.userId);
    throw new AppError('method_not_allowed', 405);
  }

  const avatarPath = path.match(/^\/api\/avatars\/([^/]+)$/);
  if (avatarPath) {
    await requireSession(db, request);
    if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
    return serveAvatar(db, avatarPath[1], request);
  }

  if (isChatPath(path) || isVoicePath(path)) {
    const session = await requireSession(db, request);
    const user = await loadUser(db, session.userId);
    if (isVoicePath(path)) return handleVoice(db, request, path, user, voice, fetchImpl);
    const handled = await handleChat(db, request, path, user);
    if (handled) return handled;
  }

  if (path === '/api/logout' || path === '/api/register' || path === '/api/login') {
    throw new AppError('method_not_allowed', 405);
  }
  throw new AppError('not_found', 404);
}

// Dependency injection is for local tests only; ctx supplies the request, not platform identity.
export function createApplication({ db, origin, voice = voiceConfig(), fetchImpl = fetch }) {
  return async function handle(ctx) {
    try {
      return await route(db, ctx.request, typeof origin === 'function' ? origin() : origin, voice, fetchImpl);
    } catch (error) {
      if (error instanceof SessionRequired) return unauthorized(error.state);
      if (error instanceof AppError) return errorJson(error.code, error.status);
      return errorJson('service_unavailable', 503);
    }
  };
}