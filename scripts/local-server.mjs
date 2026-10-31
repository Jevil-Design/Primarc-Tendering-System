/* Local full-stack server — the real backend/ against a local SQLite (libSQL)
   file, serving web/ on the same origin, exactly as Vercel does. For
   development and end-to-end testing; no Vercel, Turso or Blob account needed.

     node scripts/local-server.mjs [--db .local/dev.db] [--port 8787] [--fresh]

   First run creates the database from backend/schema.sql. Create the first
   administrator with the bootstrap call printed on start-up. Uploaded
   documents are kept in memory only. */
import { createServer } from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createClient } from '@libsql/client';
import worker from '../backend/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const PORT = Number(arg('port', process.env.PORT || 8787));
const DB_PATH = resolve(ROOT, arg('db', '.local/dev.db'));

if (process.argv.includes('--fresh')) await rm(DB_PATH, { force: true });
await mkdir(dirname(DB_PATH), { recursive: true });
const isNew = !existsSync(DB_PATH);
const client = createClient({ url: pathToFileURL(DB_PATH).href });
if (isNew) {
  await client.executeMultiple(await readFile(join(ROOT, 'backend/schema.sql'), 'utf8'));
  console.log('Created', DB_PATH, 'from backend/schema.sql');
}

/* Same D1-shaped surface as api/_lib/db.js, over the local client. */
const plain = (row, cols) => Object.fromEntries(cols.map((c, i) => [c, row[i]]));
const runResult = (rs) => ({ success: true, meta: { changes: rs.rowsAffected || 0,
  last_row_id: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : undefined } });
class Statement {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  async run() { return runResult(await client.execute({ sql: this.sql, args: this.args })); }
  async first() { const rs = await client.execute({ sql: this.sql, args: this.args });
    return rs.rows.length ? plain(rs.rows[0], rs.columns) : null; }
  async all() { const rs = await client.execute({ sql: this.sql, args: this.args });
    return { results: rs.rows.map((r) => plain(r, rs.columns)), ...runResult(rs) }; }
}
const DB = {
  prepare: (sql) => new Statement(sql),
  async batch(stmts) { return (await client.batch(stmts.map((s) => ({ sql: s.sql, args: s.args })), 'write')).map(runResult); },
};
const blobs = new Map();
const DOCUMENTS = {
  async put(key, body, opts) { blobs.set(key, { body: new Uint8Array(await new Response(body).arrayBuffer()), opts }); return { key }; },
  async get(key) { const b = blobs.get(key); return b ? { body: b.body, httpMetadata: b.opts?.httpMetadata || {} } : null; },
  async delete(key) { blobs.delete(key); },
};

const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN || randomBytes(12).toString('hex');
const env = {
  DB, DOCUMENTS, ENVIRONMENT: 'development', ALLOWED_ORIGINS: '',
  SESSION_IDLE_MINUTES: '30', SESSION_ABSOLUTE_HOURS: '12', COOKIE_SECURE: 'false',
  SESSION_PEPPER: process.env.SESSION_PEPPER || 'local-dev-pepper', BOOTSTRAP_TOKEN,
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let file = resolve(WEB, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(WEB + sep) || !existsSync(file) || extname(file) === '') file = join(WEB, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end('local server error');
  }
}).listen(PORT, () => {
  console.log(`Tendering System on http://localhost:${PORT}  (db: ${DB_PATH})`);
  console.log(`First admin: curl -X POST http://localhost:${PORT}/api/auth/bootstrap -H "X-Bootstrap-Token: ${BOOTSTRAP_TOKEN}" ` +
    `-H "content-type: application/json" -d '{"username":"admin","email":"admin@example.com","fullName":"Admin","password":"<10+ chars>"}'`);
});
