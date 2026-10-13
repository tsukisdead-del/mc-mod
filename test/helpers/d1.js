// A stand-in for Cloudflare's D1 binding over Node's built-in SQLite, so tests run the Worker's real SQL
// (including the FTS5 full-text search). Just enough of the API: prepare/bind/first/all/run and batch.
let sqlite = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  // Node without built-in SQLite: tests that need it are skipped.
}

export const skipWithoutSqlite = !sqlite && 'node:sqlite is not available';

export function fakeD1(db) {
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql);
  const statement = (sql, params = []) => {
    const exec = () => {
      const st = db.prepare(sql);
      if (returnsRows(sql)) {
        const results = st.all(...params);
        return { results, meta: { changes: results.length } };
      }
      return { results: [], meta: { changes: Number(st.run(...params).changes) } };
    };
    return {
      bind: (...p) => statement(sql, p),
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      run: async () => exec(),
      exec,
    };
  };
  return {
    queries: 0,
    prepare(sql) {
      // Count round trips like D1 does: each first/all/run or batch is one.
      const count =
        (fn) =>
        (...a) => {
          this.queries++;
          return fn(...a);
        };
      const wrap = (st) => ({ ...st, bind: (...p) => wrap(st.bind(...p)), first: count(st.first), all: count(st.all), run: count(st.run) });
      return wrap(statement(sql));
    },
    async batch(list) {
      this.queries++;
      db.exec('BEGIN');
      try {
        const out = list.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

// A fresh copy of worker/store.js per database (it remembers per isolate that the schema is ready).
let copies = 0;
export async function newStore(setup) {
  const db = new sqlite.DatabaseSync(':memory:');
  setup?.(db);
  const { Store } = await import(`../../worker/store.js?copy=${++copies}`);
  const d1 = fakeD1(db);
  return { db, d1, store: await new Store({ DB: d1 }).init() };
}
