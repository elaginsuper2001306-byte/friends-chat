// Local-only HTTPS preview: serves web/ and runs the real router with an in-memory fake DB.
// No cloud credentials; data resets on restart. Keep this file out of upload roots.
import { createServer } from 'node:https';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { createApplication } from '../functions/router.mjs';
import { createFakeDb } from './fake-db.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: { port: { type: 'string', default: '8443' }, cert: { type: 'string' }, key: { type: 'string' } },
});
const port = Number(values.port);
const origin = `https://localhost:${port}`;
const db = createFakeDb();
const handle = createApplication({ db, origin });
const web = await realpath(resolve(root, 'web'));

const server = createServer({ cert: await readFile(values.cert), key: await readFile(values.key) }, async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.origin !== origin) throw new Error('invalid_origin');
    if (url.pathname === '/__local_health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ localOnly: true }));
      return;
    }
    // The browser calls /api/...; map it the same way the Vercel rewrite does.
    const appPath = url.pathname.startsWith('/api/') ? `/functions/v1/app${url.pathname}` : url.pathname;
    if (appPath.startsWith('/functions/v1/app')) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const request = new Request(`${origin}${appPath}${url.search}`, {
        method: req.method,
        headers: req.headers,
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
      });
      const response = await handle({ request, requestId: crypto.randomUUID() });
      const headers = Object.fromEntries(response.headers);
      delete headers['set-cookie'];
      res.writeHead(response.status, { ...headers, 'set-cookie': response.headers.getSetCookie() });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const file = await realpath(resolve(web, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!file.startsWith(web + sep) || !(await stat(file)).isFile()) throw new Error('not_found');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    if (!types[extname(file)]) throw new Error('not_found');
    res.writeHead(200, { 'content-type': types[extname(file)], 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});

await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
console.log(`Local preview: ${origin} (in-memory data; resets on restart)`);
const close = () => { server.close(); server.closeAllConnections(); };
process.once('SIGINT', close);
process.once('SIGTERM', close);