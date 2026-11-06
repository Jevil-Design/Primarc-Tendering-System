// Run via tests/e2e/run.mjs, after workflow.mjs. Administration: navigation, every section renders, user
// create / edit / lock / unlock / reset / delete THROUGH THE UI against the real server, in-app dialogs (no browser
// dialogs), unsaved-changes guard, local master data, System & Data, command palette, responsive layout.
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:8793';
const results = []; const check = (n, ok, d = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = [], dialogs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
page.on('dialog', (d) => { dialogs.push(d.type() + ': ' + d.message()); d.accept(); });
await page.evaluateOnNewDocument(() => {
  window.__dls = [];
  const grab = (a) => { if (!(a instanceof HTMLAnchorElement) || !a.download || !/^blob:|^data:/.test(a.href)) return false; window.__dls.push(a.download); return true; };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (!grab(this)) return click.call(this); };
});
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForSelector('#auU', { visible: true });
await page.type('#auU', 'qa.admin'); await page.type('#auP', 'Test-Passw0rd!x'); await page.keyboard.press('Enter');
await page.waitForFunction(() => window.TSApi && window.TSApi.session); await sleep(2500);
const server = async () => page.evaluate(async () => (await (await fetch('/api/users', { credentials: 'include' })).json()).data.users);
const dlg = async (which) => { await page.waitForSelector('#erpDlg', { visible: true, timeout: 4000 }); await page.click(`#erpDlg ${which === 'ok' ? '[data-r="1"]' : '.erp-dfoot [data-r="0"]'}`); await sleep(400); };

/* ── shell ── */
await page.evaluate(() => PShell.go('admin')); await sleep(1200);
let st = await page.evaluate(() => ({
  groups: [...document.querySelectorAll('#erpNav .erp-nav-sec')].map((s) => s.textContent),
  items: [...document.querySelectorAll('#erpNav a')].map((a) => a.textContent.replace(/[↗☆★\d]/g, '').trim()),
  focusable: [...document.querySelectorAll('#erpNav a')].every((a) => a.tabIndex === 0),
  oldBar: !!document.querySelector('.erp-bar'), top: document.getElementById('pwsTitle').textContent }));
check('admin nav grouped by purpose', ['Users & Access', 'Organisation & Data', 'Audit & Maintenance'].every((g) => st.groups.includes(g)), st.groups.join(' | '));
check('nav reaches existing features (Role Access, BOQ Master, Vendor Master, Deleted Items, System & Data)', ['Role Access', 'BOQ Master', 'Vendor Master', 'Deleted Items', 'System & Data'].every((x) => st.items.includes(x)), st.items.join(', '));
check('nav links are keyboard-focusable', st.focusable);
check('single header: no second admin bar; app top bar names the section', !st.oldBar && st.top === 'Dashboard', st.top);

/* ── dashboard: real figures only ── */
st = await page.evaluate(() => ({ text: document.getElementById('erpBody').innerText, n: JSON.parse(localStorage.getItem('ts_users') || '[]').length,
  tile: [...document.querySelectorAll('.erp-tile')].find((t) => /Users/i.test(t.querySelector('.l').textContent)).querySelector('.n').textContent,
  lib: typeof CATALOG !== 'undefined' ? CATALOG.length : null }));
check('dashboard Users tile = actual user count', +st.tile.replace(/,/g, '') === st.n, st.tile + ' vs ' + st.n);
check('dashboard shows BOQ library count from the catalog', st.lib != null && st.text.includes(st.lib.toLocaleString('en-IN')));
check('no invented figures (Pending Approvals +3, Online now, Today\'s logins, System Health)', !/Pending Approvals|Online Now|Today's Logins|System Health|SHA-256/i.test(st.text));

/* ── every section renders ── */
for (const v of ['dashboard', 'users', 'designations', 'permissions', 'workflow', 'security', 'departments', 'organization', 'projects', 'system', 'audit', 'notifications']) {
  const before = errs.length;
  await page.evaluate((x) => ERP.go(x), v); await sleep(350);
  const ok = await page.evaluate(() => !!document.querySelector('#erpBody h1.erp-h') && document.querySelector('#erpNav a.on') !== null);
  check(`section "${v}" renders`, ok && errs.length === before, errs.slice(before).join(' | '));
}
check('top bar follows the admin section', await page.evaluate(() => { ERP.go('security'); return new Promise((r) => setTimeout(() => r(document.getElementById('pwsTitle').textContent), 200)); }) === 'Security Policy');

/* ── user drawer ── */
await page.evaluate(() => ERP.go('users')); await sleep(300);
await page.evaluate(() => ERP.addUser()); await sleep(600);
st = await page.evaluate(() => { const s = document.querySelector('.erp-fsec svg').getBoundingClientRect(); const i = getComputedStyle(document.getElementById('fName'));
  return { w: s.width, h: s.height, bw: i.borderTopWidth, bc: i.borderTopColor, lblFor: document.querySelector('label[for="fName"]') !== null, req: document.getElementById('fName').getAttribute('aria-required') }; });
check('drawer section icons are icon-sized (were a full-width silhouette)', st.w <= 20 && st.h <= 20, st.w + '×' + st.h);
check('drawer inputs have a visible border', st.bw === '1px' && !/rgba\(0, 0, 0, 0\)/.test(st.bc), st.bw + ' ' + st.bc);
check('drawer labels are tied to their fields; required marked', st.lblFor && st.req === 'true');
await page.click('.erp-dfoot .erp-btn.primary'); await sleep(300);
check('missing fields: drawer stays open with a message', await page.evaluate(() => document.getElementById('erpOv').classList.contains('on') && /name/i.test(document.getElementById('uMsg').textContent)));
/* unsaved-changes guard */
await page.type('#fName', 'UI-ADMIN Temp'); await page.keyboard.press('Escape'); await sleep(300);
check('Escape on a dirty form asks before discarding', await page.evaluate(() => !!document.getElementById('erpDlg') && document.getElementById('erpOv').classList.contains('on')));
await dlg('cancel');
check('"Keep editing" keeps the form and its text', await page.evaluate(() => document.getElementById('erpOv').classList.contains('on') && document.getElementById('fName').value === 'UI-ADMIN Temp'));
/* create through the UI → server */
await page.evaluate(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
  set('fName', 'UI-ADMIN Person'); set('fEmail', 'ui.admin.person@example.com'); set('fUser', 'ui.admin.person'); set('fPw', 'Ui-Admin-Pass1!'); set('fPw2', 'Ui-Admin-Pass1!'); });
await page.click('.erp-dfoot .erp-btn.primary'); await sleep(2500);
let srv = await server();
const made = srv.find((u) => u.username === 'ui.admin.person');
check('Add user (drawer) creates the account on the server', !!made && !(await page.evaluate(() => document.getElementById('erpOv').classList.contains('on'))));
check('new account listed in the table without "sign-in disabled"', await page.evaluate(() => { const tr = [...document.querySelectorAll('#erpBody tr[data-uid]')].find((t) => /UI-ADMIN Person/.test(t.textContent)); return !!tr && !/Sign-in disabled|access off/i.test(tr.textContent); }));
check('signed-in admin no longer shown as "access off"', await page.evaluate(() => !/access off|Sign-in disabled/i.test([...document.querySelectorAll('#erpBody tr[data-uid]')].find((t) => /qa\.admin/.test(t.textContent)).textContent)));
/* search + clear */
await page.type('#uSearch', 'ui.admin'); await sleep(300);
st = await page.evaluate(() => [...document.querySelectorAll('#erpBody tr[data-uid]')].map((t) => t.textContent));
check('search filters the user table', st.length === 1 && /UI-ADMIN Person/.test(st[0]), st.length + ' rows');
await page.evaluate(() => ERP._uClear()); await sleep(200);
check('Clear filters resets the search', await page.evaluate(() => document.getElementById('uSearch').value === '' && document.querySelectorAll('#erpBody tr[data-uid]').length >= 2));
/* row click → edit */
await page.evaluate(() => [...document.querySelectorAll('#erpBody tr[data-uid]')].find((t) => /UI-ADMIN Person/.test(t.textContent)).querySelector('td:nth-child(3)').click()); await sleep(600);
check('clicking a row opens it for editing', await page.evaluate(() => /Edit User/.test(document.querySelector('#erpOv h3').textContent) && document.getElementById('fName').value === 'UI-ADMIN Person'));
await page.evaluate(() => ERP._closeOv()); await sleep(300);
/* lock (dialog) → server suspended; unlock */
const uid = made.id;
await page.evaluate((id) => { ERP.lockUser(id); }, uid); await dlg('ok'); await sleep(1500);
srv = await server(); check('Lock (in-app dialog) suspends the account on the server', srv.find((u) => u.id === uid).status === 'suspended');
await page.evaluate((id) => ERP.unlockUser(id), uid); await sleep(1500);
srv = await server(); check('Unlock restores it', srv.find((u) => u.id === uid).status === 'active');
/* reset password (dialog): validation, then success */
await page.evaluate((id) => { ERP.resetPw(id); }, uid); await page.waitForSelector('#rpPw');
await page.type('#rpPw', 'short'); await page.type('#rpPw2', 'short'); await page.click('#erpDlg [data-r="1"]'); await sleep(250);
check('reset password: too-short password is refused in the dialog', await page.evaluate(() => /at least/i.test(document.getElementById('erpDlgMsg').textContent)));
await page.evaluate(() => { document.getElementById('rpPw').value = 'Ui-Admin-Pass2!'; document.getElementById('rpPw2').value = 'Ui-Admin-Pass9!'; });
await page.click('#erpDlg [data-r="1"]'); await sleep(250);
check('reset password: mismatch is refused', await page.evaluate(() => /match/i.test(document.getElementById('erpDlgMsg').textContent)));
await page.evaluate(() => { document.getElementById('rpPw2').value = 'Ui-Admin-Pass2!'; }); await page.click('#erpDlg [data-r="1"]'); await sleep(1800);
const relog = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ui.admin.person', password: 'Ui-Admin-Pass2!' }) });
check('reset password reaches the server (new password signs in)', relog.status === 200, 'status ' + relog.status);
/* delete (dialog) */
await page.evaluate((id) => { ERP.delUser(id); }, uid); await dlg('cancel'); await sleep(300);
check('cancelling delete keeps the user', !!(await server()).find((u) => u.id === uid));
await page.evaluate((id) => { ERP.delUser(id); }, uid); await dlg('ok'); await sleep(1800);
check('Delete (in-app confirm) removes the user on the server', !(await server()).find((u) => u.id === uid));

/* ── local master data ── */
await page.evaluate(() => ERP.go('departments')); await sleep(300);
await page.evaluate(() => ERP.editDept('')); await sleep(400);
await page.type('#dpName', 'UI-ADMIN Dept'); await page.click('.erp-dfoot .erp-btn.primary'); await sleep(400);
const depts = () => page.evaluate(() => JSON.parse(localStorage.getItem('erp_departments') || '[]'));
const dep = (await depts()).find((d) => d.name === 'UI-ADMIN Dept');
check('New department saves', !!dep);
await page.evaluate((id) => { ERP._delDept(id); }, dep.id); await dlg('ok');
check('Delete department asks in-app, then removes it', !(await depts()).some((d) => d.name === 'UI-ADMIN Dept'));
await page.evaluate(() => ERP.go('permissions')); await sleep(300);
const before = await page.evaluate(() => { const id = document.getElementById('permDesig').value; const d = JSON.parse(localStorage.getItem('erp_designations')).find((x) => x.id === id); const m = Object.keys(d.perms || {})[0]; return { id, m, v: !!(d.perms[m] || {}).share }; });
await page.evaluate((m) => ERP._permTog(m, 'share'), before.m); await sleep(200);
const after = await page.evaluate((b) => !!JSON.parse(localStorage.getItem('erp_designations')).find((x) => x.id === b.id).perms[b.m].share, before);
check('Designation matrix toggle saves', after !== before.v);
await page.evaluate((m) => ERP._permTog(m, 'share'), before.m);
check('Designation matrix says it is reference-only and links Role Access', await page.evaluate(() => /Reference only/.test(document.getElementById('erpBody').innerText) && !/apply across the app/.test(document.getElementById('erpBody').innerText)));
await page.evaluate(() => ERP.go('workflow')); await sleep(300);
const wf0 = await page.evaluate(() => JSON.parse(localStorage.getItem('erp_workflows'))[0]);
await page.evaluate((id) => { ERP._wfAdd(id); }, wf0.id); await page.waitForSelector('#wfPick'); await dlg('ok');
const wf1 = await page.evaluate((id) => JSON.parse(localStorage.getItem('erp_workflows')).find((w) => w.id === id), wf0.id);
check('Add approval level (picked from a list) saves', wf1.steps.length === wf0.steps.length + 1);
await page.evaluate((id, n) => ERP._wfRemove(id, n), wf0.id, wf1.steps.length - 1);

/* ── audit: no invented IP addresses ── */
st = await page.evaluate(() => JSON.parse(localStorage.getItem('erp_audit')).slice(0, 5));
check('new audit entries carry no made-up IP', st.length > 0 && st.every((a) => !a.ip), JSON.stringify(st.map((a) => a.ip)));

/* ── System & Data ── */
await page.evaluate(() => ERP.go('system')); await sleep(300);
await page.evaluate(() => { window.__dls = []; TSBackup.backup(); }); await sleep(400);
check('System & Data › Download backup produces the backup file', await page.evaluate(() => window.__dls.some((n) => /^Tendering-Backup-.*\.json$/.test(n))));
const theme0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
await page.click('#sysTheme button:not(.on)'); await sleep(300);
const theme1 = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'dark');
check('System & Data › theme switch works', theme1 !== (theme0 || 'dark'), theme0 + ' → ' + theme1);
await page.evaluate(() => ERP.go('dashboard')); await sleep(400);
check('dark theme renders the admin dashboard without errors', errs.length === 0);
await page.evaluate(() => ERP.go('system')); await sleep(300);
await page.click('#sysTheme button:not(.on)'); await sleep(200);
await page.evaluate(() => ERP._navAct('roleAccess')); await sleep(800);
check('Role Access opens the enforced role/permission editor', await page.evaluate(() => { const o = document.getElementById('authModalOv'); return !!o && o.classList.contains('on') && /access control/i.test(o.innerText)   /* innerText follows CSS text-transform (the heading is uppercase) */; }));
await page.evaluate(() => document.getElementById('authModalOv').classList.remove('on'));

/* ── command palette ── */
await page.evaluate(() => ERP.go('dashboard')); await sleep(200);
await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control'); await sleep(250);
await page.type('#erpCmdIn', 'system'); await sleep(150);
check('Ctrl+K palette finds System & Data', await page.evaluate(() => /System & Data/.test(document.getElementById('erpCmdRes').textContent)));
await page.keyboard.press('Enter'); await sleep(300);
check('…and Enter opens it', await page.evaluate(() => document.querySelector('#erpNav a.on').dataset.v === 'system'));

/* ── responsive ── */
for (const [w, h] of [[1366, 768], [1024, 768], [390, 844]]) {
  await page.setViewport({ width: w, height: h }); await sleep(300);
  const over = [];
  for (const v of ['dashboard', 'users', 'permissions', 'security', 'system']) {
    await page.evaluate((x) => ERP.go(x), v); await sleep(250);
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    if (o.sw > o.iw) over.push(v + ': ' + o.sw + '>' + o.iw);
  }
  check(`admin: no page-level horizontal overflow at ${w}px`, !over.length, over.join('; '));
}
check('narrow screens: admin nav becomes a horizontal strip', await page.evaluate(() => getComputedStyle(document.getElementById('erpNav')).display === 'flex'));

check('no browser alert/confirm/prompt used by Administration', dialogs.length === 0, dialogs.join(' | '));
check('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
