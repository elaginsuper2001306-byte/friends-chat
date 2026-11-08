// Voice rooms live in Yandex Telemost, which is reachable in Russia and free.
// This server only creates a conference per channel and returns its join link;
// the call itself runs in a separate Telemost tab, so no audio touches us.
import { AppError, json, rows } from './http.mjs';
import { isUuid } from './validate.mjs';

export const VOICE_LINK_TTL_MS = 20 * 60 * 60 * 1000;
const TELEMOST_CREATE_URL = 'https://cloud-api.yandex.net/v1/telemost-api/conferences';
const TELEMOST_HOSTS = new Set(['telemost.yandex.ru', 'telemost.360.yandex.ru']);

export function isTelemostUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !TELEMOST_HOSTS.has(url.hostname)) return null;
  return url.href;
}

// Manual mode: permanent Telemost links, optionally one per channel name.
// VOICE_ROOM_URLS is a JSON object like {"общий":"https://telemost.yandex.ru/j/1"}.
function roomLinks(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const links = {};
  for (const [name, url] of Object.entries(parsed)) {
    const valid = isTelemostUrl(String(url ?? '').trim());
    if (name.trim().length > 0 && valid) links[name] = valid;
  }
  return links;
}

export function voiceConfig(env = process.env) {
  const token = String(env.YANDEX_TELEMOST_TOKEN ?? '').trim();
  const staticUrl = isTelemostUrl(String(env.VOICE_ROOM_URL ?? '').trim());
  const links = roomLinks(env.VOICE_ROOM_URLS);
  const hasToken = token.length >= 20 && !/\s/.test(token);
  if (!hasToken && !staticUrl && Object.keys(links).length === 0) return null;
  return { token: hasToken ? token : null, staticUrl, links };
}

export function isVoicePath(path) {
  return /^\/api\/channels\/[^/]+\/voice$/.test(path);
}

// The token is sent only to Yandex; it is never returned to the browser.
export async function createConference({ token, fetchImpl = fetch, now = Date.now() }) {
  let response;
  try {
    response = await fetchImpl(TELEMOST_CREATE_URL, {
      method: 'POST',
      headers: { authorization: `OAuth ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ waiting_room_level: 'PUBLIC' }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new AppError('voice_upstream_failed', 502);
  }
  if (!response?.ok) throw new AppError('voice_upstream_failed', 502);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new AppError('voice_upstream_failed', 502);
  }
  const joinUrl = isTelemostUrl(body?.join_url);
  if (typeof body?.id !== 'string' || body.id.length === 0 || !joinUrl) {
    throw new AppError('voice_upstream_failed', 502);
  }
  return { id: body.id, joinUrl };
}

function usable(row, now) {
  const expires = Date.parse(row?.expires_at ?? '');
  return Number.isFinite(expires) && expires - now > 5 * 60 * 1000;
}

// Concurrent first joins can create two conferences; the stored one wins and is
// returned to everyone, so the channel never splits into parallel rooms.
async function linkForChannel(db, channel, config, fetchImpl, now) {
  if (!config.token) {
    const joinUrl = config.links?.[channel.name] ?? config.staticUrl;
    if (!joinUrl) throw new AppError('voice_unavailable', 503);
    return { joinUrl, expiresAt: null, shared: true };
  }

  const cached = rows(await db.from('voice_rooms')
    .select('conference_id,join_url,expires_at').eq('channel_id', channel.id).limit(1))[0];
  if (cached && usable(cached, now)) {
    return { joinUrl: cached.join_url, expiresAt: cached.expires_at, shared: false };
  }

  const conference = await createConference({ token: config.token, fetchImpl, now });
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + VOICE_LINK_TTL_MS).toISOString();
  const row = { conference_id: conference.id, join_url: conference.joinUrl, created_at: createdAt, expires_at: expiresAt };

  const stored = cached
    ? rows(await db.from('voice_rooms').update(row)
      .eq('channel_id', channel.id).eq('expires_at', cached.expires_at).select('join_url,expires_at'))
    : rows(await db.from('voice_rooms').insertIfAbsent({ channel_id: channel.id, ...row }, { onConflict: 'channel_id' })
      .select('join_url,expires_at'));

  if (stored.length === 0) {
    const current = rows(await db.from('voice_rooms')
      .select('join_url,expires_at').eq('channel_id', channel.id).limit(1))[0];
    if (current) return { joinUrl: current.join_url, expiresAt: current.expires_at, shared: false };
  }
  return { joinUrl: conference.joinUrl, expiresAt, shared: false };
}

export async function handleVoice(db, request, path, user, config, fetchImpl = fetch) {
  const match = path.match(/^\/api\/channels\/([^/]+)\/voice$/);
  if (!match) return null;
  if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
  if (!config) throw new AppError('voice_unavailable', 503);
  if (!isUuid(match[1])) throw new AppError('channel_not_found', 404);

  const found = rows(await db.from('channels').select('id,name').eq('id', match[1]).limit(1));
  if (found.length !== 1) throw new AppError('channel_not_found', 404);

  const link = await linkForChannel(db, found[0], config, fetchImpl, Date.now());
  return json({
    join_url: link.joinUrl,
    shared: link.shared,
    expires_at: link.expiresAt,
    channel: { id: found[0].id, name: found[0].name },
  });
}
