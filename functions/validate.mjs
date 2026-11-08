// Input normalization and bounded validation. Pure functions only; no database access.
import { AppError } from './http.mjs';
import { CLASS_KEYS } from '../web/classes.js';

export const USERNAME_MIN_CHARS = 3;
export const USERNAME_MAX_CHARS = 32;
export const PASSWORD_MIN_CHARS = 8;
export const PASSWORD_MAX_BYTES = 256;
export const CHANNEL_NAME_MAX_CHARS = 40;
export const MESSAGE_MAX_CHARS = 2000;
export const NICKNAME_MIN_CHARS = 2;
export const NICKNAME_MAX_CHARS = 24;
export const REAL_NAME_MAX_CHARS = 40;

// Canonical username: trim + lowercase, then a strict character set.
// The database also enforces UNIQUE on username; the canonical form decides uniqueness.
export function canonicalUsername(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_username', 400);
  const canonical = raw.trim().toLowerCase();
  if (canonical.length < USERNAME_MIN_CHARS || canonical.length > USERNAME_MAX_CHARS) {
    throw new AppError('invalid_username', 400);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(canonical)) throw new AppError('invalid_username', 400);
  return canonical;
}

// Passwords are only bounded; never logged, never echoed. Length in code points, cap in UTF-8 bytes.
export function validatePassword(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_password', 400);
  if ([...raw].length < PASSWORD_MIN_CHARS) throw new AppError('invalid_password', 400);
  if (new TextEncoder().encode(raw).length > PASSWORD_MAX_BYTES) throw new AppError('invalid_password', 400);
  return raw;
}

// Channel names may use any letters (including Cyrillic), digits, spaces, hyphens and underscores.
export function canonicalChannelName(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_channel_name', 400);
  const name = raw.trim().toLowerCase();
  if (!name || [...name].length > CHANNEL_NAME_MAX_CHARS) throw new AppError('invalid_channel_name', 400);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(name)) throw new AppError('invalid_channel_name', 400);
  return name;
}

// Game nickname is what everyone sees: letters, digits, space, dot, underscore, hyphen.
export function validateNickname(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_nickname', 400);
  const nickname = raw.trim().replace(/\s+/g, ' ');
  const length = [...nickname].length;
  if (length < NICKNAME_MIN_CHARS || length > NICKNAME_MAX_CHARS) throw new AppError('invalid_nickname', 400);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(nickname)) throw new AppError('invalid_nickname', 400);
  return nickname;
}

// Real first/last name: any letters, plus hyphen, apostrophe and inner spaces.
export function validateRealName(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_real_name', 400);
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || [...name].length > REAL_NAME_MAX_CHARS) throw new AppError('invalid_real_name', 400);
  if (!/^\p{L}[\p{L}' -]*$/u.test(name)) throw new AppError('invalid_real_name', 400);
  return name;
}

export function validateClassKey(raw) {
  if (typeof raw !== 'string' || !CLASS_KEYS.has(raw)) throw new AppError('invalid_class', 400);
  return raw;
}

// Message bodies keep inner whitespace; trim edges, reject empty/oversized/control characters.
export function validateMessageBody(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_message', 400);
  const body = raw.trim();
  if (!body || [...body].length > MESSAGE_MAX_CHARS) throw new AppError('invalid_message', 400);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body)) throw new AppError('invalid_message', 400);
  return body;
}

export function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}