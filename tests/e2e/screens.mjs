// Run via tests/e2e/run.mjs. Every screen renders without runtime errors; Comparison Builder vendor add/remove with a section row;
// ERP Admin user creation reaches the server. Run after workflow.mjs on the same server (data present).
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:8793';
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('dialog', (d) => d.accept());
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForSelector('#auU', { visible: true });
await page.type('#auU', 'qa.admin'); await page.type('#auP', 'Test-Passw0rd!x'); await page.keyboard.press('Enter');
await page.waitForFunction(() => window.TSApi && window.TSApi.session); await sleep(2500);

for (const k of ['dash', 'enq', 'rfq', 'cs', 'bid', 'appr', 'wo', 'boq', 'bmaster', 'vmaster', 'vanal', 'audit', 'del', 'admin', 'proj']) {
  const before = errs.length;
  await page.evaluate((key) => PShell.go(key), k); await sleep(700);
  const txt = await page.evaluate(() => document.body.innerText.length);
  check('screen "' + k + '" renders without errors', errs.length === before && txt > 200, errs.slice(before).join(' | '));
}

/* Vendor Master search (debounced, single stats pass) */
await page.evaluate(() => PShell.go('vmaster')); await sleep(400);
const t0 = Date.now();
await page.type('#vmSearch', 'e2e', { delay: 30 }); await sleep(500);
const shown = await page.evaluate(() => document.querySelectorAll('#qmMain tbody tr').length);
check('Vendor Master search filters', shown >= 1, shown + ' rows in ' + (Date.now() - t0) + ' ms');

/* Import dialog: the orphaned vendor-quote tab is hidden, the BOQ tab still works */
const imp = await page.evaluate(() => { const qt = document.querySelector('#importOverlay .import-tab[data-itype="quote"]'); const bt = document.querySelector('#importOverlay .import-tab[data-itype="boq"]'); return { quoteHidden: !qt || qt.style.display === 'none', boq: !!bt && bt.style.display !== 'none' }; });
check('Import dialog: unreachable vendor-quote tab hidden, BOQ import kept', imp.quoteHidden && imp.boq, JSON.stringify(imp));
const cbr = await page.evaluate(() => cbRowRanks(['1,250', '1300', '', '0']));
check('builder ranking parses "1,250" and ignores blank/0', cbr[0] === 1 && cbr[1] === 2 && !cbr[2] && !cbr[3], JSON.stringify(cbr));

/* ERP Admin → server */
const created = await page.evaluate(async () => {
  if (!window.ERP) return 'no ERP';
  await window.TSApi.createUser({ username: 'e2e.viewer', name: 'E2E-TEST Viewer', email: 'e2e.viewer@example.com', password: 'E2e-Viewer-Pass1!', role: 'Viewer' });
  const r = await (await fetch('/api/users', { credentials: 'include' })).json();
  return r.data.users.map((u) => u.username);
});
check('user created through TSApi exists on the server', Array.isArray(created) && created.includes('e2e.viewer'), JSON.stringify(created));
const locked = await page.evaluate(async () => {
  const list = await window.TSApi.listUsers(); const u = list.find((x) => x.username === 'e2e.viewer');
  /* the lock reason is chosen in an in-app dialog (it was a browser prompt) */
  const p = window.ERP.lockUser(u.id);
  await new Promise((res) => setTimeout(res, 300));
  document.querySelector('#erpDlg [data-r="1"]').click();
  await p; await new Promise((res) => setTimeout(res, 1500));
  const r = await (await fetch('/api/users', { credentials: 'include' })).json();
  return r.data.users.find((x) => x.username === 'e2e.viewer').status;
});
check('ERP Admin "Lock account" suspends the user ON THE SERVER', locked === 'suspended', locked);
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'e2e.viewer', password: 'E2e-Viewer-Pass1!' }) });
check('locked user can no longer sign in', login.status === 401, 'status ' + login.status);

/* CSRF guard live */
const csrf = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
check('cross-site POST is refused', csrf.status === 403, 'status ' + csrf.status);

console.log('page errors: ' + JSON.stringify(errs));
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close();
