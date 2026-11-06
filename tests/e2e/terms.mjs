// Run via tests/e2e/run.mjs, after workflow.mjs. Major Terms & Conditions: the 35 clauses import verbatim from
// tests/fixtures/Major Terms.xlsx; edit / include / exclude / reset / save / reopen in the enquiry editor; unsaved-
// changes guard; legacy enquiries are not changed silently; legacy-field reconciliation; vendor portal answers
// (no implied acceptance), revision records, Comparative Statement, PDF text, server persistence; admin import →
// new master version without touching existing enquiries.
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(HERE, '../fixtures/Major Terms.xlsx');
const BASE = process.env.BASE || 'http://localhost:8793';
const results = []; const check = (n, ok, d = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = [], dialogs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForSelector('#auU', { visible: true });
await page.type('#auU', 'qa.admin'); await page.type('#auP', 'Test-Passw0rd!x'); await page.keyboard.press('Enter');
await page.waitForFunction(() => window.TSApi && window.TSApi.session); await sleep(2500);
await page.waitForFunction(() => typeof XLSX !== 'undefined' && window.jspdf, { timeout: 20000 });
const fixB64 = readFileSync(FIX).toString('base64');
const SUBJ = 'TERMS-TEST road work ' + Date.now().toString(36);   // unique: the app offers to reopen a same-named enquiry

/* ── 1. the built-in master is the workbook, verbatim ── */
let st = await page.evaluate((b64) => {
  const wb = XLSX.read(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { type: 'array' });
  const p = QM.mtParseWorkbook(wb); const v1 = QM.mtVersion(1).clauses;
  const diff = v1.filter((c, i) => { const x = p.clauses[i]; return !x || x.id !== c.id || x.sl !== c.sl || x.heading !== c.heading || x.text !== c.text || x.acceptance !== c.acceptance; }).map((c) => c.sl);
  return { n: p.clauses.length, errors: p.errors, diff, v1n: v1.length, h6: v1[5].heading, h31: v1[30].heading, t4: v1[3].text, t15len: v1[14].text.length, acc: v1.filter((c) => c.acceptance).length };
}, fixB64);
check('workbook SUMMARY parses: 35 clauses, no errors', st.n === 35 && !st.errors.length, JSON.stringify(st.errors));
check('built-in master v1 = workbook text, field for field', st.v1n === 35 && !st.diff.length, 'differs at ' + st.diff.join(','));
check('original wording kept (no silent corrections, N/A kept)', st.h31 === 'General submission by the contarctor ' && st.t4 === 'N/A' && st.h6 === 'Recovery Mechanism\n(For free issue materials)', JSON.stringify([st.h31, st.t4, st.h6]));
check('blank Contractor Acceptance stays blank', st.acc === 0);

/* ── 2. new enquiry: all 35 standard clauses, editable ── */
await page.evaluate(() => PShell.go('enq')); await sleep(300);
await page.evaluate(() => QM.openEditor(null)); await sleep(700);
st = await page.evaluate(() => ({ rows: document.querySelectorAll('#mtEd .mt-row').length, on: document.querySelectorAll('#mtEd .mtOn:checked').length,
  secs: [...document.querySelectorAll('#mtEd details.mt-sec summary')].map((s) => s.textContent.replace(/\s+/g, ' ').trim()),
  t15: document.querySelector('.mt-row[data-id="mt15"] .mtT').value, std15: QM.mtVersion(1).clauses[14].text }));
check('editor loads 35 clauses, all included', st.rows === 35 && st.on === 35);
check('grouped into Sections A–D', st.secs.length === 4 && /Section A — General & Site Conditions/.test(st.secs[0]) && /Section D — Contractor Obligations & Dispute Resolution/.test(st.secs[3]), st.secs.join(' | '));
check('long clause (Payment Terms) loaded in full', st.t15 === st.std15 && st.t15.length > 1000);
await page.evaluate((subj) => {
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set(document.querySelector('#eProj'), 'TERMS-TEST Project'); set(document.querySelector('#eSubj'), subj);
  const tr = [...document.querySelectorAll('#eItems tr')].find((t) => t.querySelector('.eDesc')); set(tr.querySelector('.eShort'), 'GSB'); set(tr.querySelector('.eDesc'), 'TERMS-TEST granular sub-base'); set(tr.querySelector('.eQty'), '40');
  document.querySelectorAll('#mtEd details.mt-sec').forEach((d) => { d.open = true; });
  const t15 = document.querySelector('.mt-row[data-id="mt15"] .mtT'); set(t15, t15.value + '\nTERMS-TEST added line.');
  const on4 = document.querySelector('.mt-row[data-id="mt04"] .mtOn'); on4.checked = false; on4.dispatchEvent(new Event('change', { bubbles: true }));
  set(document.querySelector('.mt-row[data-id="mt01"] .mtA'), 'Accepted at negotiation');
}, SUBJ);
st = await page.evaluate(() => ({ count: document.getElementById('mtCount').textContent, mod15: document.querySelector('.mt-row[data-id="mt15"]').classList.contains('mod'), off4: document.querySelector('.mt-row[data-id="mt04"]').classList.contains('off') }));
check('edits are highlighted and counted', st.mod15 && st.off4 && /34 of 35 included/.test(st.count) && /2 modified/.test(st.count), st.count);
await page.type('#mtSearch', 'arbitration'); await sleep(150);
st = await page.evaluate(() => [...document.querySelectorAll('#mtEd .mt-row')].filter((r) => !r.hidden).map((r) => r.dataset.id));
check('search by keyword finds the clause', st.length === 1 && st[0] === 'mt35', st.join(','));
await page.evaluate(() => { const s = document.getElementById('mtSearch'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); });
await page.evaluate(() => QM._saveQ()); await sleep(500);
const qid = await page.evaluate((subj) => (QM._data().quotations.find((x) => x.subject === subj) || {}).id, SUBJ);
st = await page.evaluate((id) => { const t = QM._data().quotations.find((x) => x.id === id).majorTerms; const c = (k) => t.clauses.find((x) => x.id === k);
  return { master: t.master, n: t.clauses.length, en4: c('mt04').enabled, t15: c('mt15').text, a01: c('mt01').acceptance, compact: t.clauses.filter((x) => x.text != null || x.heading != null || x.acceptance != null).length }; }, qid);
check('saved with the enquiry: master v1, 35 clauses', !!qid && st.master === 1 && st.n === 35);
check('only the edits are stored (clause text, acceptance, exclusion)', st.en4 === false && /TERMS-TEST added line\.$/.test(st.t15) && st.a01 === 'Accepted at negotiation' && st.compact === 2, JSON.stringify(st).slice(0, 300) + ' …' + String(st.t15).slice(-60));

/* ── 3. reopen, reset one clause, unsaved-changes guard ── */
await page.evaluate((id) => QM.editQ(id), qid); await sleep(600);
st = await page.evaluate(() => ({ t15: document.querySelector('.mt-row[data-id="mt15"] .mtT').value, mod: document.querySelector('.mt-row[data-id="mt15"]').classList.contains('mod'), on4: document.querySelector('.mt-row[data-id="mt04"] .mtOn').checked }));
check('reopening shows the saved clauses, not defaults', /TERMS-TEST added line\.$/.test(st.t15) && st.mod && st.on4 === false);
await page.evaluate(() => { document.querySelector('details.mt-sec[data-sec="B"]').open = true; document.querySelector('.mt-row[data-id="mt15"] .mtReset').click(); });
st = await page.evaluate(() => ({ eq: document.querySelector('.mt-row[data-id="mt15"] .mtT').value === QM.mtVersion(1).clauses[14].text, mod: document.querySelector('.mt-row[data-id="mt15"]').classList.contains('mod') }));
check('Reset to standard restores the workbook text', st.eq && !st.mod);
await page.evaluate(() => QM._closeEditor()); await sleep(300);
check('closing with unsaved edits asks first (in-app)', await page.evaluate(() => !!document.querySelector('.ui-confirm') && document.getElementById('qmEditorOv').classList.contains('on')));
await page.click('.ui-confirm [data-r="0"]'); await sleep(200);
check('"Cancel" keeps the editor and the edit', await page.evaluate(() => document.getElementById('qmEditorOv').classList.contains('on') && !document.querySelector('.mt-row[data-id="mt15"]').classList.contains('mod')));
await page.evaluate(() => QM._saveQ()); await sleep(500);
st = await page.evaluate((id) => { const q = QM._data().quotations.find((x) => x.id === id); return { t: q.majorTerms.clauses.find((x) => x.id === 'mt15').text, sum: q.versions[q.versions.length - 1].summary, snap: !!q.versions[q.versions.length - 1].snapshot.majorTerms }; }, qid);
check('after reset + save the clause is back to standard (nothing stored)', st.t === undefined);
check('version history records the clause change and keeps the previous terms', /major terms/.test(st.sum) && st.snap, st.sum);

/* ── 4. legacy enquiry: nothing added silently; explicit add ── */
/* an enquiry as saved before this feature existed: same shape, no majorTerms */
const legacyId = await page.evaluate((id) => { const D = QM._data(); const src = D.quotations.find((x) => x.id === id);
  const q = JSON.parse(JSON.stringify(src)); q.id = 'legacy' + Date.now().toString(36); q.base = src.base + '-LEGACY'; q.subject = 'TERMS-TEST legacy enquiry'; q.vendors = []; q.versions = []; delete q.majorTerms;
  D.quotations.push(q); return q.id; }, qid);
await page.evaluate((id) => QM.editQ(id), legacyId); await sleep(500);
check('pre-existing enquiry without terms: offered, not auto-added', await page.evaluate(() => !!document.querySelector('#mtEd [data-mt="add"]') && !document.querySelector('#mtEd .mt-row')));
await page.evaluate(() => QM._saveQ()); await sleep(400);
check('…saving it leaves it without terms', await page.evaluate((id) => !QM._data().quotations.find((x) => x.id === id).majorTerms, legacyId));
await page.evaluate((id) => QM.editQ(id), legacyId); await sleep(400);
await page.evaluate(() => document.querySelector('#mtEd [data-mt="add"]').click()); await sleep(400);
await page.evaluate(() => QM._saveQ()); await sleep(400);
check('…and "Add the standard clauses" adds them on request', await page.evaluate((id) => (QM._data().quotations.find((x) => x.id === id).majorTerms || {}).clauses.length === 35, legacyId));

/* ── 5. legacy commercial field vs clause: reconciliation, no silent overwrite ── */
await page.evaluate((id) => QM.editQ(id), qid); await sleep(400);
await page.evaluate(() => { const e = document.getElementById('et_paymentTerms'); e.value = 'TERMS-TEST 40% advance'; QM._addNote(); }); await sleep(400);
check('different legacy Payment Terms value is flagged against Clause 15', await page.evaluate(() => /Payment Terms[\s\S]*Clause 15/.test((document.querySelector('.mt-recon-row') || {}).textContent || '')));
await page.evaluate(() => document.querySelector('[data-mtr="keep"]').click()); await sleep(300);
st = await page.evaluate(() => ({ row: !!document.querySelector('.mt-recon-row'), field: document.getElementById('et_paymentTerms').value, t15: document.querySelector('.mt-row[data-id="mt15"] .mtT').value === QM.mtVersion(1).clauses[14].text }));
check('"Keep both" keeps both values unchanged', !st.row && st.field === 'TERMS-TEST 40% advance' && st.t15);
await page.evaluate(() => { const rows = [...document.querySelectorAll('#eItems tr')]; const i = rows.findIndex((t) => t.dataset.type === 'note'); if (i >= 0) QM._delItem(i); });
await page.evaluate(() => QM._saveQ()); await sleep(400);

/* ── 6. vendor portal: client terms read-only, answers recorded, nothing implied ── */
await page.evaluate((id) => { const pick = window.openVendorPicker; window.openVendorPicker = undefined; window.prompt = () => 'TERMS-TEST Vendor'; QM.addVendorPrompt(id); window.openVendorPicker = pick; }, qid); await sleep(300);
const vend = await page.evaluate((id) => { const v = QM._data().quotations.find((x) => x.id === id).vendors[0]; return { vid: v.vid, token: v.token }; }, qid);
await page.evaluate((id, vid) => QM.openPortal(id, vid), qid, vend.vid); await sleep(500);
st = await page.evaluate(() => ({ n: document.querySelectorAll('#mtPortal .mt-pc').length, has4: !!document.querySelector('#mtPortal .mt-pc[data-id="mt04"]'), editable: !!document.querySelector('#mtPortal textarea.mtT, #mtPortal input.mtA'),
  tally: document.getElementById('mtTally').textContent.replace(/\s+/g, ' '), order: [...document.querySelectorAll('#mtPortal .mt-pc .mt-sl')].map((s) => +s.textContent) }));
check('portal shows the 34 included clauses in order (excluded clause 4 hidden)', st.n === 34 && !st.has4 && st.order.every((x, i, a) => !i || a[i - 1] < x));
check('client terms are read-only in the portal', !st.editable);
check('opening the portal records no acceptance', /0 accepted/.test(st.tally) && /34 no response/.test(st.tally), st.tally);
await page.evaluate(() => {
  document.querySelector('#mtPortal .mt-pc[data-id="mt01"] [data-mts="accept"]').click();
  document.querySelector('#mtPortal .mt-pc[data-id="mt16"] [data-mts="deviation"]').click();
  const r = document.querySelector('.vpRate'); r.value = '950'; r.dispatchEvent(new Event('input', { bubbles: true }));
});
dialogs.length = 0;
await page.evaluate((tok) => QM._submitVendor(tok), vend.token); await sleep(300);
check('a deviation without a description blocks submission', dialogs.some((d) => /deviation you propose for clause 16/.test(d)) && await page.evaluate((id) => !QM._data().quotations.find((x) => x.id === id).vendors[0].locked, qid));
await page.evaluate(() => { const t = document.querySelector('#mtPortal .mt-pc[data-id="mt16"] .mtNote'); t.value = 'TERMS-TEST LD capped at 3%'; t.dispatchEvent(new Event('input', { bubbles: true })); });
dialogs.length = 0;
await page.evaluate((tok) => { QM._submitVendor(tok); }, vend.token); await sleep(500);
check('submit confirmation states unanswered clauses are not acceptance', dialogs.some((d) => /1 accepted, 1 deviation\(s\), 32 with no response \(recorded as no response — not as accepted\)/.test(d)), dialogs.join(' | '));
st = await page.evaluate((id) => { const v = QM._data().quotations.find((x) => x.id === id).vendors[0]; const rv = v.revisions[v.revisions.length - 1];
  return { locked: v.locked, n: Object.keys(v.mtResp).length, a: v.mtResp.mt01.s, d: v.mtResp.mt16, rv: !!(rv.majorTerms && rv.mtResp && rv.mtResp.mt16 && rv.mtResp.mt16.note), locked_ro: !document.querySelector('#mtPortal [data-mts]') && /Deviation proposed/.test(document.getElementById('mtPortal').innerText) }; }, qid);
check('answers stored per clause; others left as no response', st.locked && st.n === 2 && st.a === 'accept' && st.d.s === 'deviation' && st.d.note === 'TERMS-TEST LD capped at 3%');
check('the revision keeps the clause configuration and the answers', st.rv);
check('submitted view shows the answers read-only', st.locked_ro);

/* ── 7. PDF carries the full applicable clause text + the vendor's answers ── */
await page.evaluate(() => { window.__pdf = ''; const P = window.jspdf.jsPDF.API; P.__save = P.__save || P.save; P.save = function () { window.__pdf = this.output(); return this; }; QM._downloadPortalPdf(); });
await sleep(800);
st = await page.evaluate(() => { const s = window.__pdf || ''; return { len: s.length, title: s.includes('MAJOR TERMS & CONDITIONS'), arb: s.includes('Arbitration'), cgst: s.includes('Rule 46 of CGST Rules'), dev: s.includes('Deviation proposed'), none: s.includes('No response'), mt4: s.includes('Material Free Issue') }; });
check('PDF includes the Major Terms section with full clause text', st.title && st.arb && st.cgst, JSON.stringify(st));
check('PDF shows vendor answers and leaves out the excluded clause', st.dev && st.none && !st.mt4, JSON.stringify(st));
await page.evaluate(() => QM._exitPortal()); await sleep(400);

/* ── 8. Comparative Statement shows the answers side by side ── */
await page.evaluate(() => PShell.go('cs')); await sleep(300);
await page.evaluate((id) => { const s = document.querySelector('#qmPick'); if (s) { s.value = id; s.dispatchEvent(new Event('change')); } }, qid); await sleep(400);
st = await page.evaluate(() => document.getElementById('qmMain').innerText);
check('CS: Major Terms vendor responses with the deviation text', /Major Terms — Vendor Responses/.test(st) && /TERMS-TEST LD capped at 3%/.test(st) && /32 no response/.test(st));

/* ── 9. persisted on the server ── */
check('changes reach the server', await page.waitForFunction(() => !window.TSApi.hasUnsent(), { timeout: 20000 }).then(() => true, () => false));
st = await page.evaluate(async (id) => { const s = (await (await fetch('/api/app-state', { credentials: 'include' })).json()).data.state; const q = s.quotations.find((x) => x.id === id); return { mt: q && q.majorTerms && q.majorTerms.clauses.length, resp: q && q.vendors[0].mtResp && q.vendors[0].mtResp.mt16 && q.vendors[0].mtResp.mt16.s }; }, qid);
check('server copy holds the enquiry clauses and vendor answers', st.mt === 35 && st.resp === 'deviation', JSON.stringify(st));

/* ── 10. admin import: preview, new version, existing enquiries untouched ── */
await page.evaluate(() => PShell.go('admin')); await sleep(800);
await page.evaluate(() => ERP.go('majorterms')); await sleep(400);
check('Administration › Major Terms lists v1 (built in, current)', await page.evaluate(() => /v1[\s\S]*Built in[\s\S]*Current/.test(document.getElementById('erpBody').innerText)));
const fileInput = await page.$('#mtFile');
await fileInput.uploadFile(FIX); await sleep(800);
check('importing the same workbook: preview says identical, nothing to save', await page.evaluate(() => /Identical to the current master v1/.test(document.querySelector('#erpOv').innerText) && document.getElementById('mtApply').disabled));
await page.evaluate(() => ERP._closeOv()); await sleep(300);
const tmp = mkdtempSync(join(tmpdir(), 'mt-'));
const mk = async (fn, name) => { const b64 = await page.evaluate(fn, fixB64); const p = join(tmp, name); writeFileSync(p, Buffer.from(b64, 'base64')); return p; };
const badPath = await mk((b) => { const wb = XLSX.read(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)), { type: 'array' }); wb.SheetNames = ['Sheet1']; wb.Sheets = { Sheet1: wb.Sheets.SUMMARY }; return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }); }, 'bad.xlsx');
await (await page.$('#mtFile')).uploadFile(badPath); await sleep(800);
check('workbook without SUMMARY sheet: clear error, cannot apply', await page.evaluate(() => /No worksheet named “SUMMARY”/.test(document.querySelector('#erpOv').innerText) && document.getElementById('mtApply').disabled));
await page.evaluate(() => ERP._closeOv()); await sleep(300);
const v2Path = await mk((b) => { const wb = XLSX.read(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)), { type: 'array' }); const ws = wb.Sheets.SUMMARY; ws.C18 = { t: 's', v: 'TERMS-TEST revised LD: 0.25% per week, max 4%.' }; return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }); }, 'v2.xlsx');
await (await page.$('#mtFile')).uploadFile(v2Path); await sleep(800);
check('changed workbook: preview lists exactly the changed clause', await page.evaluate(() => { const t = document.querySelector('#erpOv').innerText; return /Clause 16/.test(t) && !document.getElementById('mtApply').disabled; }));
await page.type('#mtNote', 'TERMS-TEST revision'); await page.click('#mtApply'); await sleep(800);
st = await page.evaluate((id) => ({ cur: QM.mtInfo().current, old: QM.mtResolve(id).find((c) => c.id === 'mt16').text === QM.mtVersion(1).clauses[15].text, master: QM._data().quotations.find((x) => x.id === id).majorTerms.master }), qid);
check('approved import becomes master v2', st.cur === 2);
check('existing enquiry keeps v1 wording', st.master === 1 && st.old);
await page.evaluate(() => { PShell.go('enq'); QM.openEditor(null); }); await sleep(600);
st = await page.evaluate(() => ({ m: document.querySelector('#mtEd') && /Standard terms v2/.test(document.getElementById('mtEd').innerText), t: document.querySelector('.mt-row[data-id="mt16"] .mtT').value }));
check('new enquiries start from v2', st.m && st.t === 'TERMS-TEST revised LD: 0.25% per week, max 4%.');
await page.evaluate(() => { document.getElementById('qmEditorOv').classList.remove('on'); });
await page.evaluate((id) => QM.editQ(id), qid); await sleep(500);
check('older enquiry is offered an explicit switch to v2', await page.evaluate(() => !!document.querySelector('#mtEd [data-mt="upgrade"]')));
await page.evaluate(() => { document.getElementById('qmEditorOv').classList.remove('on'); });

check('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
