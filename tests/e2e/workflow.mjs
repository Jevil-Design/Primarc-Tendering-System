// End-to-end workflow against the local full stack (real backend + SQLite). Test data: "E2E-TEST …".
import puppeteer from 'puppeteer-core';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8793';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DL = resolve(process.env.E2E_DOWNLOADS || 'downloads'); rmSync(DL, { recursive: true, force: true }); mkdirSync(DL);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const boot = await fetch(BASE + '/api/auth/bootstrap', { method: 'POST',
  headers: { 'X-Bootstrap-Token': 'test-bootstrap-token-123', 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'qa.admin', email: 'qa@example.com', fullName: 'QA Admin', password: 'Test-Passw0rd!x' }) });
check('bootstrap first admin', boot.status === 200 || boot.status === 403, 'status ' + boot.status);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
async function openApp(ctx) {
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.errors = []; page.alerts = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', async (d) => { page.alerts.push(d.type() + ': ' + d.message()); await d.accept(); });
  /* Capture every file the app hands the browser to save (blob: anchors — dl(), SheetJS, jsPDF). */
  await page.evaluateOnNewDocument(() => {
    window.__dls = [];
    const grab = (a) => { if (!(a instanceof HTMLAnchorElement) || !a.download || !/^blob:|^data:/.test(a.href)) return false;
      const name = a.download; fetch(a.href).then((r) => r.arrayBuffer()).then((b) => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); window.__dls.push({ name, b64: btoa(s) }); });
      return true; };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (!grab(this)) return click.call(this); };
    const disp = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (e) { if (e && e.type === 'click' && grab(this)) return true; return disp.call(this, e); };
  });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  return page;
}
async function login(page) {
  await page.waitForSelector('#auU', { visible: true });
  await page.type('#auU', 'qa.admin'); await page.type('#auP', 'Test-Passw0rd!x');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.TSApi && window.TSApi.session, { timeout: 15000 });
  await sleep(1500);
}
const settled = (page) => page.waitForFunction(() => !window.TSApi.hasUnsent(), { timeout: 20000 }).then(() => true, () => false);
const serverState = (page) => page.evaluate(async () => (await (await fetch('/api/app-state', { credentials: 'include' })).json()).data);

const ctxA = await browser.createBrowserContext();
const page = await openApp(ctxA);
await login(page);
check('sign in through the login form', await page.evaluate(() => window.TSApi.session.username) === 'qa.admin');

/* ── 1-4: enquiry with items, through the real editor + _saveQ ── */
await page.evaluate(() => QM.openEditor(null));
await page.waitForSelector('#eProj');
await page.evaluate(() => { QM._addItem(); });
await page.evaluate(() => { QM._addItem(); });
await page.evaluate(() => {
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set(document.querySelector('#eProj'), 'E2E-TEST Project'); set(document.querySelector('#eSubj'), 'E2E-TEST Civil package');
  const rows = [...document.querySelectorAll('#eItems tr')].filter((tr) => tr.querySelector('.eDesc'));
  const data = [['Excavation', 'E2E-TEST excavation in all soils', '100', 'cum'], ['PCC', 'E2E-TEST PCC 1:4:8', '50', 'cum'], ['Brickwork', 'E2E-TEST brickwork 230mm', '200', 'sqm']];
  rows.forEach((tr, i) => { set(tr.querySelector('.eShort'), data[i][0]); set(tr.querySelector('.eDesc'), data[i][1]); set(tr.querySelector('.eQty'), data[i][2]); set(tr.querySelector('.eUom'), data[i][3]); });
  QM._saveQ();
});
const q0 = await page.evaluate(() => { const q = QM._data().quotations.find((x) => x.subject === 'E2E-TEST Civil package'); return q && { id: q.id, base: q.base, n: q.items.length, ids: q.items.every((i) => i.id) }; });
check('create enquiry with 3 items via editor', q0 && q0.n === 3 && q0.ids, JSON.stringify(q0));

/* vendors through addVendorPrompt's prompt path (real newVendor/audit/saveDB) */
await page.evaluate((qid) => {
  const pick = window.openVendorPicker; window.openVendorPicker = undefined;
  for (const n of ['E2E-TEST Vendor One', 'E2E-TEST Vendor Two', 'E2E-TEST Vendor Three']) { window.prompt = () => n; QM.addVendorPrompt(qid); }
  window.openVendorPicker = pick;
}, q0.id);
const vendors = await page.evaluate((qid) => QM._data().quotations.find((x) => x.id === qid).vendors.map((v) => ({ vid: v.vid, token: v.token, name: v.name })), q0.id);
check('add three vendors', vendors.length === 3, vendors.map((v) => v.name).join(', '));
check('portal tokens are 22-char random', vendors.every((v) => /^[0-9a-z]{22}$/.test(v.token)));

/* quotes through the admin portal: V1 all items, V2 misses Brickwork, V3 ties V1 */
const quotes = [[100, 4000, 500], [90, 3800, ''], [100, 4000, 500]];
for (let k = 0; k < 3; k++) {
  await page.evaluate((qid, vid) => QM.openPortal ? QM.openPortal(qid, vid) : null, q0.id, vendors[k].vid);
  const hasPortal = await page.evaluate(() => !!document.querySelector('.vpRate'));
  if (!hasPortal) { check('open vendor portal ' + (k + 1), false, 'QM.openPortal missing or no rate inputs'); break; }
  await page.evaluate((rates) => {
    document.querySelectorAll('.vpRate').forEach((el) => { const i = +el.dataset.i; el.value = rates[i]; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  }, quotes[k]);
  await page.evaluate((tok) => { window.confirm = () => true; window.prompt = () => ''; QM._submitVendor(tok); QM._exitPortal(); }, vendors[k].token);
}
const rank = await page.evaluate((qid) => { const q = QM._data().quotations.find((x) => x.id === qid);
  return q.vendors.map((v) => ({ name: v.name, status: v.status, rates: v.lines.map((l) => l.rate) })); }, q0.id);
check('vendor quotes recorded per item', JSON.stringify(rank.map((r) => r.rates.map(String))) === JSON.stringify(quotes.map((r) => r.map(String))), JSON.stringify(rank));

/* ── 8-9: comparative statement ── */
await page.evaluate((qid) => { window.PShell && PShell.go && PShell.go('cs'); }, q0.id);
await page.evaluate((qid) => { const s = document.querySelector('#qmPick'); if (s) { s.value = qid; s.dispatchEvent(new Event('change')); } }, q0.id);
await sleep(400);
const cs = await page.evaluate(() => document.querySelector('#qmMain') ? document.querySelector('#qmMain').innerText : document.body.innerText);
check('CS: partial bid is flagged and not L1', /Incomplete bid/.test(cs) && /Vendor Two \(1 item unpriced\)/.test(cs), (cs.match(/Incomplete bid[^\n]*/) || [''])[0]);
check('CS: tie at L1 is reported', /Tie at L1/.test(cs), (cs.match(/Tie at L1[^\n]*/) || [''])[0]);
check('CS: L1 total is the complete bid ₹3,10,000', /Award to E2E-TEST Vendor One \(L1\) at ₹3,10,000/.test(cs), (cs.match(/Recommendation[^\n]*/) || [''])[0]);

/* ── 4-5: persistence across reload, from the SERVER (local cache wiped) ── */
check('save reaches the server', await settled(page));
let sv = await serverState(page);
const sq = sv.state.quotations.find((x) => x.id === q0.id);
check('server copy has enquiry + all three quotes', sq && sq.vendors.length === 3 && sq.vendors[0].lines[1].rate == 4000);
await page.evaluate(() => { localStorage.removeItem('qm_data_v2'); localStorage.removeItem('ts_sync_meta'); localStorage.removeItem('ts_sync_base'); });
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.TSApi && window.TSApi.session && /Synced|Saved/.test((document.getElementById('tsSyncTxt') || {}).textContent || ''), { timeout: 20000 }).catch(() => {});
await sleep(1000);
const afterReload = await page.evaluate((qid) => { const q = QM._data().quotations.find((x) => x.id === qid); return q && q.vendors.map((v) => v.lines.map((l) => l.rate)); }, q0.id);
check('reload with empty browser cache restores from server', afterReload && afterReload[0][2] == 500, JSON.stringify(afterReload));

/* ── 12: edit — delete the FIRST item; rates must stay on their items ── */
await page.evaluate((qid) => { QM.openEditor(qid); }, q0.id);
await page.evaluate(() => { QM._delItem(0); });
page.alerts.length = 0;
await page.evaluate(() => { QM._saveQ(); });
if (page.alerts.length) console.log('   dialogs during delete+save:', page.alerts);
const afterDel = await page.evaluate((qid) => { const q = QM._data().quotations.find((x) => x.id === qid);
  return { items: q.items.map((i) => i.short), v1: q.vendors[0].lines.map((l) => l.rate), v2: q.vendors[1].lines.map((l) => l.rate) }; }, q0.id);
check('delete item: remaining rates stay on their items', JSON.stringify(afterDel.items) === '["PCC","Brickwork"]' && afterDel.v1[0] == 4000 && afterDel.v1[1] == 500 && afterDel.v2[1] === '', JSON.stringify(afterDel));

/* ── approvals + work order ── */
const stages = await page.evaluate(() => { try { return QM._data() && 5; } catch (e) { return 5; } });
for (let i = 0; i < stages + 1; i++) await page.evaluate((qid) => { window.prompt = () => 'E2E ok'; try { QM._apprAct(qid, 'approved'); } catch (e) {} }, q0.id);
let appr = await page.evaluate((qid) => { const q = QM._data().quotations.find((x) => x.id === qid); return q.approval; }, q0.id);
check('approval workflow reaches fully approved', appr && appr.status === 'approved', appr && appr.status);
check('approver recorded as the signed-in user', appr && appr.history.some((h) => h.by === 'QA Admin'), appr && appr.history.map((h) => h.by).join(','));
// change a rate after approval → approval must restart
await page.evaluate((qid) => { const q = QM._data().quotations.find((x) => x.id === qid); q.vendors[0].lines[0].rate = 3900; window.__tsHooks.push(); PShell.go('appr'); }, q0.id);
await sleep(300);
appr = await page.evaluate((qid) => QM._data().quotations.find((x) => x.id === qid).approval, q0.id);
check('rate change after approval restarts approval', appr.status === 'pending' && appr.stage === 0 && appr.history.some((h) => h.action === 'reset'), appr.status + ' stage ' + appr.stage);
page.alerts.length = 0;
await page.evaluate((qid) => QM._woGen(qid), q0.id);
check('WO refused until re-approved', page.alerts.some((a) => /not fully approved/.test(a)), page.alerts.join(' | '));
for (let i = 0; i < 6; i++) await page.evaluate((qid) => { window.prompt = () => ''; try { QM._apprAct(qid, 'approved'); } catch (e) {} }, q0.id);
// award Vendor Three (L2 on a tie) — the WO must follow the award, not the live L1
await page.evaluate((qid, vid) => { window.confirm = () => true; window.prompt = () => ''; QM.approve(qid, vid); }, q0.id, vendors[2].vid);
appr = await page.evaluate((qid) => QM._data().quotations.find((x) => x.id === qid).approval, q0.id);
check('awarding a vendor after approval also restarts approval', appr.status === 'pending', appr.status);
for (let i = 0; i < 6; i++) await page.evaluate((qid) => { window.prompt = () => ''; try { QM._apprAct(qid, 'approved'); } catch (e) {} }, q0.id);
await page.evaluate((qid) => QM._woGen(qid), q0.id);
const wos = await page.evaluate(() => QM._data().workOrders.map((w) => ({ no: w.no, vendor: w.vendorName, base: w.base })));
check('WO issued to the AWARDED vendor', wos.length === 1 && wos[0].vendor === 'E2E-TEST Vendor Three', JSON.stringify(wos));
page.alerts.length = 0;
await page.evaluate((qid) => QM._woGen(qid), q0.id);
check('second WO for the same enquiry is refused', page.alerts.some((a) => /already been issued/.test(a)) && (await page.evaluate(() => QM._data().workOrders.length)) === 1);

/* ── 10-11: exports reconcile with the screen ── */
await page.evaluate(() => PShell.go('cs'));
await page.evaluate((qid) => { const s = document.querySelector('#qmPick'); if (s) { s.value = qid; s.dispatchEvent(new Event('change')); } }, q0.id);
await page.waitForFunction(() => typeof XLSX !== 'undefined' && window.jspdf, { timeout: 20000 }).catch(() => {});
await page.evaluate(() => { window.__dls = []; });
for (const f of ['csv', 'xls', 'pdf']) { await page.evaluate((fmt) => QM.exportCS(fmt), f); await sleep(1500); }
const got = await page.evaluate(() => window.__dls);
got.forEach((d) => writeFileSync(join(DL, d.name), Buffer.from(d.b64, 'base64')));
const files = readdirSync(DL);
check('CS exports download (csv, xlsx, pdf)', ['.csv', '.xlsx', '.pdf'].every((e) => files.some((n) => n.endsWith(e))), files.join(', '));
const csvName = files.find((n) => n.endsWith('.csv'));
if (csvName) {
  const csv = readFileSync(join(DL, csvName), 'utf8');
  check('CS CSV carries the quoted rates', /4000/.test(csv) && /E2E-TEST Vendor Three/.test(csv));
}

/* BOQ Builder: header + 0% GST item; Excel totals must not double count */
await page.evaluate(() => {
  PShell.go('boq');
  boq.length = 0;
  const h = mkNode({ type: 'header', name: 'E2E-TEST Section' }); bInsert(h, null);
  const it = mkNode({ type: 'item', name: 'E2E-TEST exempt item', desc: 'zero GST', uom: 'nos', qty: '1,250', rate: '₹10', gst: 0 }); bInsert(it, h.sid);
  renderBOQ();
});
const boqTotal = await page.evaluate(() => nodeAmount(boq.find((b) => b.type === 'item')));
check('BOQ amount parses "1,250" × "₹10" = 12,500', boqTotal === 12500, String(boqTotal));
rmSync(DL, { recursive: true, force: true }); mkdirSync(DL);
await page.evaluate(() => { window.__dls = []; });
await page.evaluate(() => document.getElementById('bExpXls').click()); await sleep(1500);
await page.evaluate(() => document.getElementById('bExpCsv').click()); await sleep(1500);
(await page.evaluate(() => window.__dls)).forEach((d) => writeFileSync(join(DL, d.name), Buffer.from(d.b64, 'base64')));
const bfiles = readdirSync(DL);
const xl = bfiles.find((n) => n.endsWith('.xlsx'));
if (xl) {
  const b64 = readFileSync(join(DL, xl)).toString('base64');
  const sheet = await page.evaluate((b) => { const wb = XLSX.read(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)), { type: 'array', cellFormula: true }); console.log(wb.SheetNames); const ws = wb.Sheets[wb.SheetNames[0]]; const out = {}; Object.keys(ws).filter((k) => /^[A-K]\d+$/.test(k)).forEach((k) => { out[k] = ws[k].f ? '=' + ws[k].f : ws[k].v; }); return out; }, b64);
  const sumCell = Object.values(sheet).find((v) => typeof v === 'string' && v.startsWith('=SUMIF'));
  const gstCells = Object.entries(sheet).filter(([k, v]) => k.startsWith('H') && v === 0);
  const vals = await page.evaluate((b) => { const ws = XLSX.read(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)), { type: 'array' }).Sheets.BOQ; return { G7: ws.G7 && ws.G7.v, G8: ws.G8 && ws.G8.v, G10: ws.G10 && ws.G10.v }; }, b64);
  check('BOQ Excel stores values: item 12500, base 12500 (section not double counted), grand 12500', vals.G7 === 12500 && vals.G8 === 12500 && vals.G10 === 12500, JSON.stringify(vals));
  check('BOQ Excel base total excludes section subtotals (SUMIF)', !!sumCell, sumCell || JSON.stringify(Object.fromEntries(Object.entries(sheet).filter(([k]) => /^[EFGH]d+$/.test(k) && sheet[k] !== ''))));
  check('BOQ Excel keeps 0% GST as 0', gstCells.length >= 1);
} else check('BOQ Excel export downloaded', false, bfiles.join(','));
const bcsv = bfiles.find((n) => n.endsWith('.csv'));
if (bcsv) {
  const lines = readFileSync(join(DL, bcsv), 'utf8').split('\n');
  const hdr = lines.find((l) => l.includes('"WBS"')), sec = lines.find((l) => l.includes('SECTION SUBTOTAL')), item = lines.find((l) => l.includes('exempt item'));
  const cols = (l) => (l.match(/"(?:[^"]|"")*"/g) || []).length;
  check('BOQ CSV section row has the same columns as the header', hdr && sec && cols(hdr) === cols(sec), cols(hdr) + ' vs ' + cols(sec));
  check('BOQ CSV exports 0% GST as 0, amount 12500', item && /"0"/.test(item) && /"12500"/.test(item), item);
}

/* ── 13-14: recoverable failure — offline edit, then back online ── */
await page.evaluate(() => { PShell.go('vmaster'); });
await page.setOfflineMode(true);
await page.evaluate(() => { const db = QM._data(); db.vendorMaster.push({ id: 'e2e-offline', name: 'E2E-TEST Offline Vendor' }); window.__tsHooks.push(); });
await sleep(4000);
const off = await page.evaluate(() => ({ pill: document.getElementById('tsSyncTxt').textContent, meta: JSON.parse(localStorage.getItem('ts_sync_meta')) }));
check('offline: status says Offline, change kept as unsent', /Offline|Retrying/.test(off.pill) && off.meta.dirty === true, JSON.stringify(off));
await page.setOfflineMode(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
check('back online: unsent change is retried and saved', await settled(page));
sv = await serverState(page);
check('server has the offline edit', sv.state.vendorMaster.some((v) => v.id === 'e2e-offline'));

/* reload while a change is still unsent → it is pushed, not overwritten */
await page.setRequestInterception(true);
const block = (r) => (r.url().endsWith('/api/app-state') && r.method() === 'PUT') ? r.abort() : r.continue();
page.on('request', block);
await page.evaluate(() => { const db = QM._data(); db.vendorMaster.push({ id: 'e2e-unsent', name: 'E2E-TEST Unsent Vendor' }); window.__tsHooks.push(); });
await sleep(2500);
page.off('request', block); await page.setRequestInterception(false);
await page.evaluate(() => { window.onbeforeunload = null; });
await page.reload({ waitUntil: 'load' }); await sleep(3000); await settled(page);
sv = await serverState(page);
check('unsent change survives a reload and reaches the server', sv.state.vendorMaster.some((v) => v.id === 'e2e-unsent'));

/* ── concurrent edits on two computers ── */
const ctxB = await browser.createBrowserContext();
const pageB = await openApp(ctxB); await login(pageB); await settled(pageB);
await page.evaluate((qid) => { QM._data().quotations.find((x) => x.id === qid).subject = 'E2E-TEST edited on A'; window.__tsHooks.push(); }, q0.id);
await pageB.evaluate(() => { QM._data().vendorMaster.push({ id: 'e2e-from-b', name: 'E2E-TEST Vendor from B' }); window.__tsHooks.push(); });
await Promise.all([settled(page), settled(pageB)]); await sleep(1500); await Promise.all([settled(page), settled(pageB)]);
sv = await serverState(page);
check('different records edited on two computers: both kept', sv.state.quotations.find((x) => x.id === q0.id).subject === 'E2E-TEST edited on A' && sv.state.vendorMaster.some((v) => v.id === 'e2e-from-b'));
// same record on both → server copy kept, ours preserved for recovery
await pageB.evaluate(() => window.TSApi.resync()); await page.evaluate(() => window.TSApi.resync()); await sleep(800);
await page.evaluate((qid) => { QM._data().quotations.find((x) => x.id === qid).client = 'Client per A'; window.__tsHooks.push(); }, q0.id);
await pageB.evaluate((qid) => { QM._data().quotations.find((x) => x.id === qid).client = 'Client per B'; window.__tsHooks.push(); }, q0.id);
await Promise.all([settled(page), settled(pageB)]); await sleep(1500);
const recA = await page.evaluate(() => window.TSApi.recovery()), recB = await pageB.evaluate(() => window.TSApi.recovery());
sv = await serverState(page);
const finalClient = sv.state.quotations.find((x) => x.id === q0.id).client;
const loser = finalClient === 'Client per A' ? recB : recA;
check('same record edited on both: one wins, the other is kept for recovery', ['Client per A', 'Client per B'].includes(finalClient) && loser.length > 0 && JSON.stringify(loser).includes('Client per'), 'server=' + finalClient + ' recoveryA=' + recA.length + ' recoveryB=' + recB.length);

/* ── deleting a vendor does not resurrect it ── */
await page.evaluate(() => PShell.go('vmaster')); await sleep(300);
const vmId = await page.evaluate(() => (QM._data().vendorMaster.find((v) => v.name === 'E2E-TEST Vendor Two') || {}).id);
await page.evaluate((id) => { window.confirm = () => true; QM._vmDel(id); }, vmId);
await sleep(300);
const resurrected = await page.evaluate(() => QM._data().vendorMaster.some((v) => v.name === 'E2E-TEST Vendor Two'));
check('deleted vendor stays deleted (no re-seed from enquiry history)', vmId && !resurrected, 'id=' + vmId);

console.log('\nPage errors A: ' + JSON.stringify(page.errors) + '\nPage errors B: ' + JSON.stringify(pageB.errors));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
