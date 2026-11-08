// 仅用于本地演练的凭据无关假数据库。
// 复刻真实适配器用到的语义：from().select()/insertIfAbsent()/update() 返回可链式、可 await 的
// 构建器；order() 只接受普通列名。
// 写入结果控制（一次性）：control.mode = 'reject' | 'drop' 影响下一次写入；
// control.dropTable = '<table>' 只让指定表的下一次写入「已提交但响应丢失」。
// control.rejectTable = '<table>' 只让指定表的下一次写入被明确拒绝（没有提交）。
// control.writes 记录每一次写入尝试的表名，用于断言「不重放」。
// 不要把它打进 Function 包。
export function createFakeDb(control = { mode: 'ok', dropTable: null, rejectTable: null, writes: [] }) {
  if (!Array.isArray(control.writes)) control.writes = [];
  const tables = new Map();
  const sequences = new Map();
  const rows = (table) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  };
  const nextSeq = (table) => {
    const next = (sequences.get(table) ?? 0) + 1;
    sequences.set(table, next);
    return next;
  };
  const pick = (row, columns) => (columns === '*' || columns === null
    ? { ...row }
    : Object.fromEntries(columns.split(',').map((c) => [c.trim(), row[c.trim()]])));

  const takeMode = (table) => {
    if (control.dropTable === table) { control.dropTable = null; return 'drop'; }
    if (control.rejectTable === table) { control.rejectTable = null; return 'reject'; }
    const mode = control.mode ?? 'ok';
    control.mode = 'ok';
    return mode;
  };

  function builder(table, mode, values) {
    const filters = [];
    let columns = '*';
    let orderBy = null, orderAsc = true, maxRows = Infinity, execution;
    const run = () => {
      const list = rows(table);
      const match = (row) => filters.every(([key, value]) => row[key] === value);

      if (mode === 'read') {
        const selected = list.filter(match);
        if (orderBy) {
          selected.sort((a, b) => String(a[orderBy]).localeCompare(String(b[orderBy])) * (orderAsc ? 1 : -1));
        }
        return { data: selected.slice(0, maxRows).map((row) => pick(row, columns)), error: null };
      }

      control.writes.push(table);

      if (mode === 'insert') {
        const stored = { ...values.row };
        if (stored.seq === undefined && (table === 'channel_messages' || table === 'dm_messages')) {
          stored.seq = nextSeq(table);
        }
        const unique = (values.onConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean);
        if (unique.length && list.some((row) => unique.every((key) => row[key] === stored[key]))) {
          return { data: [], error: null };
        }
        const writeMode = takeMode(table);
        if (writeMode === 'reject') return { data: null, error: { code: 'write_failed', status: 409 } };
        // 'drop'：数据已提交，只是响应没回来。
        list.push(stored);
        if (writeMode === 'drop') throw new Error('simulated response loss');
        return { data: [pick(stored, columns)], error: null };
      }

      const writeMode = takeMode(table);
      if (writeMode === 'reject') return { data: null, error: { code: 'write_failed', status: 409 } };
      const matched = list.filter(match);
      for (const row of matched) Object.assign(row, values.row);
      if (writeMode === 'drop') throw new Error('simulated response loss');
      return { data: matched.map((row) => pick(row, columns)), error: null };
    };

    const chain = {
      eq(key, value) { filters.push([key, value]); return chain; },
      limit(count) { maxRows = count; return chain; },
      order(name, options = {}) { orderBy = String(name); orderAsc = options.ascending !== false; return chain; },
      select(names) { if (typeof names === 'string') columns = names; return chain; },
      then(resolve, reject) { execution ??= Promise.resolve().then(run); return execution.then(resolve, reject); },
    };
    return chain;
  }

  return {
    from(table) {
      return {
        select: (columns) => builder(table, 'read', null).select(columns),
        insert: (row) => builder(table, 'insert', { row, onConflict: null }),
        insertIfAbsent: (row, options) => builder(table, 'insert', { row, onConflict: options?.onConflict }),
        update: (row) => builder(table, 'update', { row }),
      };
    },
    // 仅测试使用：读取原始行，用于断言存储内容（例如不含明文口令）。
    dump: (table) => rows(table).map((row) => ({ ...row })),
  };
}
