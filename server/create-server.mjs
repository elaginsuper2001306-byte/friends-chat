import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { buildWebRequest, readNodeBody, sendWebResponse } from './http-bridge.mjs';
import { createApplication } from '../functions/router.mjs';

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

function applySecurityHeaders(res, { html = false } = {}) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.setHeader('cache-control', html ? 'no-cache' : 'public, max-age=300');
}

async function serveStatic(req, res, url, webRoot) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end('{"error":"method_not_allowed"}');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = '';
  }
  if (!pathname || pathname.includes('\0')) {
    res.statusCode = 404;
    res.end();
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(webRoot, relative);
  if (filePath !== webRoot && !filePath.startsWith(webRoot + path.sep)) {
    res.statusCode = 404;
    res.end();
    return;
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    info = null;
  }
  if (!info?.isFile()) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader('content-type', MIME[extension] ?? 'application/octet-stream');
  applySecurityHeaders(res, { html: extension === '.html' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

export function createServer({ db, origin, webRoot, tls = null }) {
  if (!origin) throw new Error('origin is required');
  const handle = createApplication({ db, origin: () => origin });

  const listener = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', origin);

      if (url.pathname.startsWith('/api/')) {
        const limit = url.pathname === '/api/me/avatar' ? 256 * 1024 : 64 * 1024;
        const { tooLarge, body } = await readNodeBody(req, limit);
        if (tooLarge) {
          res.statusCode = 413;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end('{"error":"payload_too_large"}');
          return;
        }
        const request = buildWebRequest(req, { origin, body, prefix: '/app' });
        const response = await handle({ request });
        await sendWebResponse(res, response);
        return;
      }

      await serveStatic(req, res, url, webRoot);
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') console.error('request failed:', error);
      if (!res.headersSent) {
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"error":"service_unavailable"}');
      } else {
        res.end();
      }
    }
  };

  return tls ? https.createServer(tls, listener) : http.createServer(listener);
}
