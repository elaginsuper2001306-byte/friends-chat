import { readFile } from 'node:fs/promises';
import { createClient } from '../server/pg.mjs';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const client = createClient(connectionString);
await client.connect();
try {
  await client.query(sql);
  console.log('Database schema is ready.');
} finally {
  await client.end();
}
