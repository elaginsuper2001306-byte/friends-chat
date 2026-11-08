// Профиль и аватар: свои данные редактирует только владелец сессии,
// фотография хранится прямо в базе (небольшая, сжатая в браузере).
import { Buffer } from 'node:buffer';
import { AppError, json, readJson, rows } from './http.mjs';
import { isUuid, validateClassKey, validateNickname, validateRealName } from './validate.mjs';

export const PROFILE_COLUMNS = 'id,username,first_name,last_name,nickname,class_key,avatar_updated_at';
export const MEMBER_COLUMNS = 'id,nickname,class_key,avatar_updated_at';
export const AVATAR_BODY_LIMIT = 128 * 1024;
const AVATAR_MAX_BYTES = 48 * 1024;

const AVATAR_TYPES = new Map([
  ['image/webp', (bytes) => bytes.length > 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'],
  ['image/jpeg', (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ['image/png', (bytes) => bytes.length > 16 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && ascii(bytes, 12, 4) === 'IHDR'],
]);

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export function profileOf(row) {
  return {
    id: row.id,
    username: row.username,
    first_name: row.first_name ?? '',
    last_name: row.last_name ?? '',
    nickname: row.nickname || row.username,
    class_key: row.class_key || null,
    avatar_updated_at: row.avatar_updated_at ?? null,
  };
}

export function memberOf(row) {
  return {
    id: row.id,
    nickname: row.nickname || row.username,
    class_key: row.class_key || null,
    avatar_updated_at: row.avatar_updated_at ?? null,
  };
}

export async function updateProfile(db, request, userId) {
  const body = await readJson(request);
  const values = {
    first_name: validateRealName(body?.first_name),
    last_name: validateRealName(body?.last_name),
    nickname: validateNickname(body?.nickname),
    class_key: validateClassKey(body?.class_key),
  };
  const updated = rows(await db.from('users').update(values).eq('id', userId).select(PROFILE_COLUMNS));
  if (updated.length !== 1) throw new AppError('login_required', 401);
  return json({ user: profileOf(updated[0]) });
}

function parseAvatar(dataUrl) {
  if (typeof dataUrl !== 'string') throw new AppError('invalid_avatar', 400);
  const match = dataUrl.match(/^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new AppError('invalid_avatar', 400);
  const mime = match[1];
  const bytes = new Uint8Array(Buffer.from(match[2], 'base64'));
  if (bytes.length === 0) throw new AppError('invalid_avatar', 400);
  if (bytes.length > AVATAR_MAX_BYTES) throw new AppError('avatar_too_large', 413);
  if (!AVATAR_TYPES.get(mime)(bytes)) throw new AppError('invalid_avatar', 400);
  return { mime, bytes };
}

export async function saveAvatar(db, request, userId) {
  const avatar = parseAvatar((await readJson(request, AVATAR_BODY_LIMIT))?.dataUrl);
  const saved = rows(await db.from('users').update({
    avatar_mime: avatar.mime,
    avatar_data: avatar.bytes,
    avatar_updated_at: new Date().toISOString(),
  }).eq('id', userId).select(PROFILE_COLUMNS));
  if (saved.length !== 1) throw new AppError('login_required', 401);
  return json({ user: profileOf(saved[0]) });
}

export async function removeAvatar(db, userId) {
  const cleared = rows(await db.from('users').update({
    avatar_mime: null, avatar_data: null, avatar_updated_at: null,
  }).eq('id', userId).select(PROFILE_COLUMNS));
  if (cleared.length !== 1) throw new AppError('login_required', 401);
  return json({ user: profileOf(cleared[0]) });
}

// Avatar bytes are only served to signed-in members; the ?v= suffix busts the cache.
export async function serveAvatar(db, userId, request) {
  if (!isUuid(userId)) return new Response(null, { status: 404 });
  const found = rows(await db.from('users')
    .select('avatar_mime,avatar_data,avatar_updated_at').eq('id', userId).limit(1));
  const row = found[0];
  if (!row?.avatar_data || !row.avatar_mime) return new Response(null, { status: 404 });

  const etag = `"${Date.parse(row.avatar_updated_at) || 0}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const bytes = row.avatar_data instanceof Uint8Array
    ? row.avatar_data
    : new Uint8Array(row.avatar_data);
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': row.avatar_mime,
      'content-length': String(bytes.length),
      'cache-control': 'private, max-age=300',
      etag,
      'x-content-type-options': 'nosniff',
    },
  });
}
