import { Buffer } from 'node:buffer';

// Headers that describe the connection rather than the request are not forwarded
// into the Web Request built for the application handler.
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

export function buildWebRequest(req, { origin, body, prefix = null } = {}) {
  const url = new URL(req.url ?? '/', origin);
  if (prefix && url.pathname.startsWith('/api/')) url.pathname = `${prefix}${url.pathname}`;

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (value === undefined || HOP_HEADERS.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }

  const method = String(req.method ?? 'GET').toUpperCase();
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && body !== undefined) init.body = body;
  return new Request(url, init);
}

export async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === 'set-cookie') continue;
    res.setHeader(name, value);
  }
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');

  const buffer = Buffer.from(await response.arrayBuffer());
  res.setHeader('content-length', String(buffer.length));
  res.end(buffer);
}

export async function readNodeBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) return { tooLarge: true, body: undefined };
    chunks.push(chunk);
  }
  return { tooLarge: false, body: chunks.length > 0 ? Buffer.concat(chunks) : undefined };
}
