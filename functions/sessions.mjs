// 会话：32 字节随机不透明令牌放在 __Host- Cookie 中；数据库只保存令牌的 SHA-256 摘要、
// 用户 ID、签发/过期时间与撤销时间。明文令牌从不落库、从不记录。
import { AppError, rows } from './http.mjs';

export const SESSION_COOKIE = '__Host-app_auth.session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
const MAX_COOKIE_HEADER = 8192;

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function newSessionToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return token;
}

export function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// 只读取本应用自己的 Cookie；重复或超长一律视为无效，不猜测、不回退。
function sessionTokenFrom(request) {
  const header = request.headers.get('cookie') ?? '';
  if (!header) return null;
  if (header.length > MAX_COOKIE_HEADER) throw new AppError('invalid_credentials', 400);
  const values = [];
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    if (trimmed.slice(0, at).trim() === SESSION_COOKIE) values.push(trimmed.slice(at + 1));
  }
  if (values.length === 0) return null;
  if (values.length > 1) throw new AppError('invalid_credentials', 400);
  const token = values[0];
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('invalid_credentials', 400);
  return token;
}

export async function createSession(db, userId, now = Date.now()) {
  const token = newSessionToken();
  const digest = await sha256Hex(token);
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  const created = rows(await db.from('sessions').insertIfAbsent({
    token_digest: digest, user_id: userId, created_at: new Date(now).toISOString(), expires_at: expiresAt,
  }, { onConflict: 'token_digest' }).select('token_digest'));
  // 32 字节随机令牌碰撞实际不会发生；真出现时不覆盖既有会话，直接失败。
  if (created.length !== 1) throw new AppError('session_unavailable', 503);
  return { token, digest, expiresAt };
}

// 每个请求都重新校验：Cookie 存在 → 摘要查库 → 未撤销且未过期才算通过。
// 返回 { state, session }，state 取值 missing | invalid | valid。
export async function validateSession(db, request, now = Date.now()) {
  const token = sessionTokenFrom(request);
  if (!token) return { state: 'missing', session: null };
  const digest = await sha256Hex(token);
  const found = rows(await db.from('sessions').select('token_digest,user_id,expires_at,revoked_at').eq('token_digest', digest).limit(1));
  if (found.length !== 1) return { state: 'invalid', session: null };
  const row = found[0];
  if (row.token_digest !== digest || typeof row.user_id !== 'string') return { state: 'invalid', session: null };
  if (row.revoked_at != null) return { state: 'invalid', session: null };
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { state: 'invalid', session: null };
  return { state: 'valid', session: { digest, userId: row.user_id, expiresAt } };
}

// 先撤销数据库中的会话，再由调用方清除 Cookie。
// 谓词只用主键摘要，不依赖 NULL 比较的方言；重复撤销是幂等的（同一个值再写一次）。
export async function revokeSession(db, digest, now = Date.now()) {
  const revoked = rows(await db.from('sessions').update({ revoked_at: new Date(now).toISOString() })
    .eq('token_digest', digest).select('token_digest'));
  return revoked.length === 1;
}
