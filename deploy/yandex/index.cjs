// Yandex Cloud Functions entry point for the API Gateway v2.0 HTTP integration.
// The gateway reaches us as an HTTPS event; the app itself stays a normal Web
// Request/Response handler shared with Vercel and the local Node server.
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : __dirname;
const WEB_ROOT = path.join(ROOT, 'web');
const ORIGIN = (process.env.APP_ORIGIN ?? '').replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
};

const fileCache = new Map();
let appPromise = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);
      const { createApplication } = await load('functions/router.mjs');
      const { createPgDb } = await load('server/db.mjs');
      const { createPool } = await load('server/pg.mjs');
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing');
      if (!ORIGIN) throw new Error('APP_ORIGIN is missing');
      const db = createPgDb(createPool(process.env.DATABASE_URL));
      return createApplication({ db, origin: () => ORIGIN });
    })();
  }
  return appPromise;
}

function textResponse(statusCode, body, contentType = 'text/plain; charset=utf-8') {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': contentType, 'cache-control': 'no-store' },
    cookies: [],
    body,
    isBase64Encoded: false,
  };
}

function isText(contentType) {
  return /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/.test(contentType);
}

async function serveStatic(rawPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath || '/');
  } catch {
    return textResponse(404, 'Not found');
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(WEB_ROOT, relative);
  if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) {
    return textResponse(404, 'Not found');
  }
  let data = fileCache.get(filePath);
  if (!data) {
    try {
      data = await readFile(filePath);
      fileCache.set(filePath, data);
    } catch {
      return textResponse(404, 'Not found');
    }
  }
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME[extension] ?? 'application/octet-stream';
  return {
    statusCode: 200,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': contentType,
      'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=300',
    },
    cookies: [],
    body: isText(contentType) ? data.toString('utf8') : data.toString('base64'),
    isBase64Encoded: !isText(contentType),
  };
}

function requestFromEvent(event) {
  const http = event.requestContext?.http ?? {};
  const method = String(http.method ?? event.httpMethod ?? 'GET').toUpperCase();
  const rawPath = event.rawPath ?? event.path ?? '/';
  const query = event.rawQueryString ?? '';
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined && value !== null) headers.set(name, String(value));
  }
  if (Array.isArray(event.cookies) && event.cookies.length > 0) {
    headers.set('cookie', event.cookies.join('; '));
  }
  const url = `${ORIGIN}/app${rawPath}${query ? `?${query}` : ''}`;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && event.body != null) {
    init.body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  }
  return new Request(url, init);
}

async function apiResponse(event) {
  const app = await getApp();
  const response = await app({ request: requestFromEvent(event) });
  const headers = {};
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== 'set-cookie') headers[name] = value;
  }
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  const binary = buffer.length > 0 && !isText(contentType) && contentType !== '';
  return {
    statusCode: response.status,
    headers,
    cookies,
    body: binary ? buffer.toString('base64') : buffer.toString('utf8'),
    isBase64Encoded: binary,
  };
}

exports.handler = async function handler(event) {
  try {
    const rawPath = event.rawPath ?? event.path ?? '/';
    if (rawPath === '/api' || rawPath.startsWith('/api/')) return await apiResponse(event);
    return await serveStatic(rawPath);
  } catch (error) {
    console.error('yandex handler failed:', error?.stack ?? error);
    return textResponse(503, JSON.stringify({ error: 'service_unavailable' }), 'application/json; charset=utf-8');
  }
};
