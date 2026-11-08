// Small adapter over PostgreSQL for the query subset used by functions/*.mjs:
// select/eq/order/limit, insertIfAbsent (ON CONFLICT DO NOTHING) and update.
// Every identifier is validated and quoted; every value goes through a parameter.
// The executor only needs .query(text, params) returning { rows }.

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const SCHEMA = 'app';

function identifier(name) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) throw new Error('invalid identifier');
  return `"${name}"`;
}

function tableSql(table) {
  return `${SCHEMA}.${identifier(table)}`;
}

function columnsSql(columns) {
  if (columns === '*' || columns == null) return '*';
  const list = String(columns).split(',').map((column) => column.trim()).filter(Boolean);
  if (list.length === 0) throw new Error('empty column list');
  return list.map(identifier).join(', ');
}

function conflictSql(columns) {
  const list = String(columns ?? '').split(',').map((column) => column.trim()).filter(Boolean);
  if (list.length === 0) throw new Error('empty conflict target');
  return list.map(identifier).join(', ');
}

function normalizeValue(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const next = {};
    for (const [key, value] of Object.entries(row)) next[key] = normalizeValue(value);
    return next;
  });
}

function builder(executor, table, kind, payload) {
  const filters = [];
  let returning = null;
  let order = null;
  let limit = null;
  let execution = null;

  const whereSql = (params) => {
    if (filters.length === 0) return '';
    const parts = filters.map(([column, value]) => {
      params.push(normalizeValue(value));
      return `${identifier(column)} = $${params.length}`;
    });
    return ` WHERE ${parts.join(' AND ')}`;
  };

  const run = async () => {
    try {
      if (kind === 'select') {
        const params = [];
        let sql = `SELECT ${columnsSql(payload.columns)} FROM ${tableSql(table)}`;
        sql += whereSql(params);
        if (order) sql += ` ORDER BY ${identifier(order.column)} ${order.ascending ? 'ASC' : 'DESC'}`;
        if (limit != null) sql += ` LIMIT ${limit}`;
        const result = await executor.query(sql, params);
        return { data: normalizeRows(result.rows), error: null };
      }

      if (kind === 'insert') {
        const keys = Object.keys(payload.row);
        if (keys.length === 0) throw new Error('empty row');
        const params = keys.map((key) => normalizeValue(payload.row[key]));
        let sql = `INSERT INTO ${tableSql(table)} (${keys.map(identifier).join(', ')}) `
          + `VALUES (${keys.map((_, index) => `$${index + 1}`).join(', ')})`;
        if (payload.onConflict) sql += ` ON CONFLICT (${conflictSql(payload.onConflict)}) DO NOTHING`;
        sql += ` RETURNING ${columnsSql(returning)}`;
        const result = await executor.query(sql, params);
        return { data: normalizeRows(result.rows), error: null };
      }

      if (kind === 'update') {
        const keys = Object.keys(payload.row);
        if (keys.length === 0) throw new Error('empty row');
        if (filters.length === 0) throw new Error('update without predicate');
        const params = [];
        const assignments = keys.map((key) => {
          params.push(normalizeValue(payload.row[key]));
          return `${identifier(key)} = $${params.length}`;
        });
        let sql = `UPDATE ${tableSql(table)} SET ${assignments.join(', ')}`;
        sql += whereSql(params);
        sql += ` RETURNING ${columnsSql(returning)}`;
        const result = await executor.query(sql, params);
        return { data: normalizeRows(result.rows), error: null };
      }

      throw new Error('unknown operation');
    } catch {
      // Provider details stay out of the application; callers see a stable error code.
      return { data: null, error: { code: 'database_error' } };
    }
  };

  const chain = {
    eq(column, value) { filters.push([column, value]); return chain; },
    order(column, options = {}) {
      order = { column, ascending: options?.ascending !== false };
      return chain;
    },
    limit(count) {
      const parsed = Math.trunc(Number(count));
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1000) throw new Error('invalid limit');
      limit = parsed;
      return chain;
    },
    select(columns = '*') { returning = columns; return chain; },
    then(resolve, reject) {
      execution ??= Promise.resolve().then(run);
      return execution.then(resolve, reject);
    },
  };

  return chain;
}

export function createPgDb(executor) {
  if (!executor || typeof executor.query !== 'function') throw new Error('executor with query() is required');
  return {
    from(table) {
      return {
        select: (columns = '*') => builder(executor, table, 'select', { columns }),
        insert: (row) => builder(executor, table, 'insert', { row }),
        insertIfAbsent: (row, options) => builder(executor, table, 'insert', { row, onConflict: options?.onConflict }),
        update: (row) => builder(executor, table, 'update', { row }),
      };
    },
  };
}
