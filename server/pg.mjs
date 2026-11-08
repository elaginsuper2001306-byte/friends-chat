import pg from 'pg';

function sslConfig() {
  if (process.env.PGSSL === 'disable') return false;
  if (process.env.PGSSL_NO_VERIFY === '1') return { rejectUnauthorized: false };
  return true;
}

export function createPool(connectionString) {
  return new pg.Pool({
    connectionString,
    ssl: sslConfig(),
    max: Number(process.env.PG_POOL_MAX ?? 3),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 8_000,
    query_timeout: 9_000,
  });
}

export function createClient(connectionString) {
  return new pg.Client({
    connectionString,
    ssl: sslConfig(),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    query_timeout: 16_000,
  });
}
