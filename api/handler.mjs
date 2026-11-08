import { createApplication } from '../functions/router.mjs';
import { createPgDb } from '../server/db.mjs';
import { createPool } from '../server/pg.mjs';
import { buildWebRequest, readNodeBody, sendWebResponse } from '../server/http-bridge.mjs';

let application = null;

function applicationOrigin() {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN;
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return production ? `https://${production}` : null;
}

function getApplication() {
  if (!application) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing');
    application = createApplication({
      db: createPgDb(createPool(process.env.DATABASE_URL)),
      origin: applicationOrigin,
    });
  }
  return application;
}

// vercel.json rewrites /api/<rest> to /api/handler?path=<rest>; restore the
// original URL so the application router sees the real path.
function restoreOriginalUrl(req) {
  const parsed = new URL(req.url ?? '/', 'http://internal');
  const rest = parsed.searchParams.get('path');
  if (rest === null) return;
  parsed.searchParams.delete('path');
  const search = parsed.searchParams.toString();
  req.url = `/api/${rest}${search ? `?${search}` : ''}`;
}

function parsedBody(req) {
  if (req.body === undefined) return undefined;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body);
}

// Avatars travel as a base64 data URL; everything else keeps the small default limit.
function bodyLimit(req) {
  const pathname = new URL(req.url ?? '/', 'http://internal').pathname;
  return pathname === '/api/me/avatar' ? 256 * 1024 : 64 * 1024;
}

export default async function handler(req, res) {
  restoreOriginalUrl(req);
  const origin = applicationOrigin();
  if (!origin) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end('{"error":"application_auth_not_configured"}');
    return;
  }

  try {
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body !== undefined) {
        body = parsedBody(req);
      } else {
        const read = await readNodeBody(req, bodyLimit(req));
        if (read.tooLarge) {
          res.statusCode = 413;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end('{"error":"payload_too_large"}');
          return;
        }
        body = read.body;
      }
    }

    const request = buildWebRequest(req, { origin, body, prefix: '/app' });
    const response = await getApplication()({ request });
    await sendWebResponse(res, response);
  } catch {
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end('{"error":"service_unavailable"}');
    } else {
      res.end();
    }
  }
}
