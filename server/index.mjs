import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './create-server.mjs';
import { createPgDb } from './db.mjs';
import { createPool } from './pg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.APP_ORIGIN;
const connectionString = process.env.DATABASE_URL;

if (!origin) {
  console.error('APP_ORIGIN is required (for example https://friends-chat.example.com)');
  process.exit(1);
}
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const tls = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
  : null;

const server = createServer({
  db: createPgDb(createPool(connectionString)),
  origin,
  webRoot: path.join(root, 'web'),
  tls,
});

const port = Number(process.env.PORT ?? 8443);
const host = process.env.HOST ?? '0.0.0.0';
server.listen(port, host, () => {
  console.log(`Friends chat listening on ${host}:${port}`);
});
