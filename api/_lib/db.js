/* D1-shaped adapter over Turso (libSQL) — SQLite-compatible, so every query
   already written against `env.DB` in backend/ works unchanged.

   Mirrors the D1 client surface that backend/ actually calls:
     db.prepare(sql).bind(...args).first()/.all()/.run()
     db.batch([stmt, ...])

   Rows come back from libSQL as objects that only expose columns via a proxy
   (index + name access) rather than plain enumerable own properties, and
   backend/auth.js relies on `{ ...row }` / rest-destructuring a row — so every
   row is normalised into a plain object here, once, in one place. */
import { createClient } from '@libsql/client/web';

let _client;
function client() {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) throw new Error('TURSO_DATABASE_URL is not set.');
    _client = createClient({ url, authToken });
  }
  return _client;
}

function toPlainRow(row, columns) {
  const o = {};
  columns.forEach((c, i) => { o[c] = row[i]; });
  return o;
}

function toRunResult(rs) {
  return {
    success: true,
    meta: {
      changes: rs.rowsAffected || 0,
      last_row_id: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : undefined,
    },
  };
}

class Statement {
  constructor(sql) {
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async run() {
    const rs = await client().execute({ sql: this.sql, args: this.args });
    return toRunResult(rs);
  }
  async first() {
    const rs = await client().execute({ sql: this.sql, args: this.args });
    if (!rs.rows.length) return null;
    return toPlainRow(rs.rows[0], rs.columns);
  }
  async all() {
    const rs = await client().execute({ sql: this.sql, args: this.args });
    return {
      results: rs.rows.map((r) => toPlainRow(r, rs.columns)),
      ...toRunResult(rs),
    };
  }
}

export const DB = {
  prepare(sql) {
    return new Statement(sql);
  },
  async batch(stmts) {
    const rsList = await client().batch(
      stmts.map((s) => ({ sql: s.sql, args: s.args })),
      'write'
    );
    return rsList.map(toRunResult);
  },
};
