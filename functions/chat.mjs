// Messenger business routes: channels, channel messages, members, direct messages.
// Identity always comes from the verified application session, never from the request body.
import { AppError, errorJson, json, readJson, rows } from './http.mjs';
import { canonicalChannelName, isUuid, validateMessageBody } from './validate.mjs';
import { consume } from './limiter.mjs';
import { MEMBER_COLUMNS, memberOf } from './profile.mjs';

const MESSAGE_PAGE_LIMIT = 200;
const USER_PAGE_LIMIT = 500;
const CHANNEL_PAGE_LIMIT = 100;
const DEFAULT_CHANNELS = ['общий', 'флуд'];

const retryAfter = (result) => ({ 'retry-after': String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) });
const messageColumns = (scopeColumn) => `id,${scopeColumn},author_id,author_name,body,created_at`;

export function isChatPath(path) {
  return /^\/api\/(users|channels|dm)(\/|$)/.test(path);
}

// Idempotent default channels: UNIQUE(name) makes concurrent bootstrap safe.
async function ensureDefaultChannels(db) {
  for (const name of DEFAULT_CHANNELS) {
    rows(await db.from('channels').insertIfAbsent({
      id: crypto.randomUUID(), name, created_by: '00000000-0000-0000-0000-000000000000',
      created_at: new Date().toISOString(),
    }, { onConflict: 'name' }).select('id'));
  }
}

async function requireChannel(db, id) {
  if (!isUuid(id)) throw new AppError('channel_not_found', 404);
  const found = rows(await db.from('channels').select('id,name').eq('id', id).limit(1));
  if (found.length !== 1) throw new AppError('channel_not_found', 404);
  return found[0];
}

async function memberIndex(db) {
  const found = rows(await db.from('users').select(MEMBER_COLUMNS)
    .order('nickname').limit(USER_PAGE_LIMIT));
  return new Map(found.map((row) => [row.id, row]));
}

// Authors are resolved from the current profile, so a renamed nickname or a new
// class colour shows up in old messages too.
function messageOf(row, members) {
  const author = members.get(row.author_id);
  return {
    id: row.id,
    author_id: row.author_id,
    author_name: author?.nickname || row.author_name,
    author_class: author?.class_key || null,
    author_avatar: author?.avatar_updated_at ?? null,
    body: row.body,
    created_at: row.created_at,
  };
}

async function latestMessages(db, table, scopeColumn, scopeId) {
  const found = rows(await db.from(table).select(messageColumns(scopeColumn))
    .eq(scopeColumn, scopeId).order('seq', { ascending: false }).limit(MESSAGE_PAGE_LIMIT));
  const members = await memberIndex(db);
  return found.reverse().map((row) => messageOf(row, members));
}

// One send path for channels and DMs. The idempotency key is the message id:
// an uncertain write is recovered by repeating the exact same command, never by replay.
async function sendMessage(db, request, table, scopeColumn, scopeId, user) {
  const body = await readJson(request);
  const text = validateMessageBody(body?.body);
  const key = request.headers.get('idempotency-key');
  if (!isUuid(key)) throw new AppError('invalid_input', 400);

  const limit = await consume(db, 'message', user.id);
  if (!limit.allowed) return errorJson('rate_limited', 429, retryAfter(limit));

  const message = {
    id: key, [scopeColumn]: scopeId, author_id: user.id, author_name: user.nickname || user.username,
    body: text, created_at: new Date().toISOString(),
  };
  const inserted = rows(await db.from(table).insertIfAbsent(message, { onConflict: 'id' })
    .select(messageColumns(scopeColumn)));
  if (inserted.length === 1) return json(messageOf(inserted[0], await memberIndex(db)), 201);

  const existing = rows(await db.from(table).select(messageColumns(scopeColumn)).eq('id', key).limit(1));
  if (existing.length !== 1) return errorJson('message_unconfirmed', 503);
  const row = existing[0];
  if (row[scopeColumn] !== scopeId || row.author_id !== user.id || row.body !== text) {
    return errorJson('idempotency_conflict', 409);
  }
  return json(messageOf(row, await memberIndex(db)), 200);
}

function peerOf(thread, userId, members) {
  const peerId = thread.user_a === userId ? thread.user_b : thread.user_a;
  const storedName = thread.user_a === userId ? thread.user_b_name : thread.user_a_name;
  const peer = members.get(peerId);
  return {
    id: peerId,
    nickname: peer?.nickname || storedName,
    class_key: peer?.class_key || null,
    avatar_updated_at: peer?.avatar_updated_at ?? null,
  };
}

// Missing threads and threads owned by other pairs return the same 404.
async function requireDmThread(db, id, userId) {
  if (!isUuid(id)) throw new AppError('dm_not_found', 404);
  const found = rows(await db.from('dm_threads')
    .select('id,pair_key,user_a,user_b,user_a_name,user_b_name,created_at').eq('id', id).limit(1));
  if (found.length !== 1) throw new AppError('dm_not_found', 404);
  const thread = found[0];
  if (thread.user_a !== userId && thread.user_b !== userId) throw new AppError('dm_not_found', 404);
  return thread;
}

async function listDmThreads(db, user) {
  const columns = 'id,pair_key,user_a,user_b,user_a_name,user_b_name,created_at';
  const [asA, asB, members] = await Promise.all([
    db.from('dm_threads').select(columns).eq('user_a', user.id)
      .order('created_at', { ascending: false }).limit(CHANNEL_PAGE_LIMIT),
    db.from('dm_threads').select(columns).eq('user_b', user.id)
      .order('created_at', { ascending: false }).limit(CHANNEL_PAGE_LIMIT),
    memberIndex(db),
  ]);
  return [...rows(asA), ...rows(asB)]
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    .map((thread) => ({ id: thread.id, peer: peerOf(thread, user.id, members), created_at: thread.created_at }));
}

async function openDmThread(db, request, user) {
  const body = await readJson(request);
  const targetId = body?.userId;
  if (!isUuid(targetId)) throw new AppError('invalid_input', 400);
  if (targetId === user.id) throw new AppError('dm_self_forbidden', 400);
  const found = rows(await db.from('users').select(MEMBER_COLUMNS).eq('id', targetId).limit(1));
  if (found.length !== 1) throw new AppError('user_not_found', 404);
  const target = found[0];

  // Canonical pair order makes the pair key unique regardless of who opens the DM first.
  const [a, b] = [user, target].sort((left, right) => left.id.localeCompare(right.id));
  const pairKey = `${a.id}:${b.id}`;
  const thread = {
    id: crypto.randomUUID(), pair_key: pairKey,
    user_a: a.id, user_b: b.id,
    user_a_name: a.nickname || a.username || '', user_b_name: b.nickname || b.username || '',
    created_at: new Date().toISOString(),
  };
  const inserted = rows(await db.from('dm_threads').insertIfAbsent(thread, { onConflict: 'pair_key' }).select('id'));
  if (inserted.length === 1) return json({ id: thread.id, peer: memberOf(target) }, 201);

  const existing = rows(await db.from('dm_threads').select('id').eq('pair_key', pairKey).limit(1));
  if (existing.length !== 1) return errorJson('dm_unconfirmed', 503);
  return json({ id: existing[0].id, peer: memberOf(target) }, 200);
}

export async function handleChat(db, request, path, user) {
  if (path === '/api/users') {
    if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
    const found = rows(await db.from('users').select(MEMBER_COLUMNS).order('nickname').limit(USER_PAGE_LIMIT));
    return json(found.map(memberOf));
  }

  // Full profile (including the real name) for a signed-in member.
  const userProfile = path.match(/^\/api\/users\/([^/]+)\/profile$/);
  if (userProfile) {
    if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
    if (!isUuid(userProfile[1])) throw new AppError('user_not_found', 404);
    const found = rows(await db.from('users')
      .select('id,first_name,last_name,nickname,class_key,avatar_updated_at')
      .eq('id', userProfile[1]).limit(1));
    if (found.length !== 1) throw new AppError('user_not_found', 404);
    const row = found[0];
    return json({
      id: row.id,
      first_name: row.first_name ?? '',
      last_name: row.last_name ?? '',
      nickname: row.nickname || 'Игрок',
      class_key: row.class_key || null,
      avatar_updated_at: row.avatar_updated_at ?? null,
    });
  }

  if (path === '/api/channels') {
    if (request.method === 'GET') {
      await ensureDefaultChannels(db);
      const found = rows(await db.from('channels').select('id,name,created_at')
        .order('created_at').limit(CHANNEL_PAGE_LIMIT));
      return json(found.map((row) => ({ id: row.id, name: row.name })));
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      const name = canonicalChannelName(body?.name);
      const channel = { id: crypto.randomUUID(), name, created_by: user.id, created_at: new Date().toISOString() };
      const inserted = rows(await db.from('channels').insertIfAbsent(channel, { onConflict: 'name' }).select('id,name'));
      if (inserted.length !== 1) return errorJson('channel_exists', 409);
      return json({ id: channel.id, name }, 201);
    }
    throw new AppError('method_not_allowed', 405);
  }

  const channelMessages = path.match(/^\/api\/channels\/([^/]+)\/messages$/);
  if (channelMessages) {
    const channel = await requireChannel(db, channelMessages[1]);
    if (request.method === 'GET') return json(await latestMessages(db, 'channel_messages', 'channel_id', channel.id));
    if (request.method === 'POST') return sendMessage(db, request, 'channel_messages', 'channel_id', channel.id, user);
    throw new AppError('method_not_allowed', 405);
  }

  if (path === '/api/dm') {
    if (request.method === 'GET') return json(await listDmThreads(db, user));
    if (request.method === 'POST') return openDmThread(db, request, user);
    throw new AppError('method_not_allowed', 405);
  }

  const dmMessages = path.match(/^\/api\/dm\/([^/]+)\/messages$/);
  if (dmMessages) {
    const thread = await requireDmThread(db, dmMessages[1], user.id);
    if (request.method === 'GET') return json(await latestMessages(db, 'dm_messages', 'thread_id', thread.id));
    if (request.method === 'POST') return sendMessage(db, request, 'dm_messages', 'thread_id', thread.id, user);
    throw new AppError('method_not_allowed', 405);
  }

  if (/^\/api\/(channels|dm)\/[^/]+$/.test(path)) throw new AppError('not_found', 404);
  return null;
}