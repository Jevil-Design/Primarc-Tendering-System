/* End-to-end browser suite: starts the real backend on a throwaway SQLite
   database (scripts/local-server.mjs), drives Chrome through the tendering
   workflow (workflow.mjs), every screen (screens.mjs), the BOQ Builder /
   shell UI layer (ui.mjs), Administration (admin.mjs) and Major Terms &
   Conditions (terms.mjs), then stops.

     npm install --no-save puppeteer-core@23
     node tests/e2e/run.mjs            # CHROME_PATH=... if Chrome is elsewhere

   Test data is fictitious ("E2E-TEST …") and lives only in the temp DB —
   never point BASE at a production deployment. */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const TMP = mkdtempSync(join(tmpdir(), 'ts-e2e-'));
const PORT = process.env.PORT || '8793';
const env = { ...process.env, BOOTSTRAP_TOKEN: 'test-bootstrap-token-123', BASE: 'http://localhost:' + PORT,
  E2E_DOWNLOADS: join(TMP, 'downloads') };

const server = spawn(process.execPath, [join(ROOT, 'scripts/local-server.mjs'), '--fresh', '--port', PORT, '--db', join(TMP, 'e2e.db')],
  { cwd: ROOT, env, stdio: 'ignore' });
let code = 1;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(env.BASE + '/api/health')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const run = (file) => new Promise((res) => spawn(process.execPath, [join(HERE, file)], { cwd: TMP, env, stdio: 'inherit' }).on('exit', res));
  code = (await run('workflow.mjs')) || (await run('screens.mjs')) || (await run('ui.mjs')) || (await run('admin.mjs')) || (await run('terms.mjs'));
} finally {
  server.kill();
}
process.exit(code);
