// Run via tests/e2e/run.mjs, after workflow.mjs (data present). UI workflow layer: shell header, BOQ Builder
// progress steps, project details → exports, missing qty/rate filter, selection + bulk actions, delete/clear
// with undo, Review & Preview totals, File menu, theme default, and no page-level horizontal overflow.
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:8793';
const results = []; const check = (n, ok, d = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; const dialogs = [];
page.on('pageerror', (e) => errs.push(e.message)); page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
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
check('first visit defaults to the light theme', await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'light');
await page.waitForSelector('#auU', { visible: true });
await page.type('#auU', 'qa.admin'); await page.type('#auP', 'Test-Passw0rd!x'); await page.keyboard.press('Enter');
await page.waitForFunction(() => window.TSApi && window.TSApi.session); await sleep(2500);

/* ── shell ── */
const shell = await page.evaluate(() => ({
  inTop: !!document.querySelector('.topbar #pwsHead'), who: document.getElementById('sbWho')?.textContent,
  cap: document.querySelector('#home .pp-tot')?.textContent || '', m: QM.metrics().byStatus }));
const realN = ['draft', 'sent', 'opened', 'submitted', 'approved', 'expired'].reduce((t, s) => t + (shell.m[s] || 0), 0);
check('page title lives in the top bar', shell.inTop);
check('sidebar footer shows the signed-in user', shell.who && shell.who !== 'Signed in' && shell.who !== '—', shell.who);
check('dashboard pipeline caption reports the real count', realN ? shell.cap.startsWith(realN + ' enquir') : /No enquiries/.test(shell.cap), shell.cap + ' / ' + realN);
await page.evaluate(() => PShell.go('cs')); await sleep(600);
check('New Enquiry + bell shown in the top bar on Enquiry screens',
  await page.evaluate(() => getComputedStyle(document.getElementById('qmNew')).display !== 'none' && !!document.querySelector('#pwsActions #qmBell')));

/* ── BOQ Builder: seed through the builder's own functions ── */
await page.evaluate(() => {
  PShell.go('boq');
  boq.length = 0; bMissOnly = false; bSel.clear();
  ['#bProj', '#bRef', '#bWO', '#bClient'].forEach((s) => { document.querySelector(s).value = ''; });
  const h = mkNode({ type: 'header', name: 'UI-TEST Section' }); bInsert(h, null);
  bInsert(mkNode({ type: 'item', name: 'UI-TEST complete', desc: 'd', uom: 'cum', qty: '10', rate: '100', gst: 18 }), h.sid);
  bInsert(mkNode({ type: 'item', name: 'UI-TEST no qty', desc: 'd', uom: 'cum', qty: '', rate: '50', gst: 18 }), h.sid);
  bInsert(mkNode({ type: 'item', name: 'UI-TEST no rate', desc: 'd', uom: 'sqm', qty: '4', rate: '', gst: 18 }), h.sid);
  renderBOQ();
});
await sleep(300);
let st = await page.evaluate(() => ({
  miss: document.getElementById('bMissCnt').textContent,
  s1: document.querySelector('.bq-step[data-step="1"]').className, s2: document.querySelector('.bq-step[data-step="2"]').className,
  s3: document.querySelector('.bq-step[data-step="3"]').className, inv: document.getElementById('bProj').classList.contains('ui-invalid'),
  missInputs: document.querySelectorAll('#boqScroll .ui-missing').length }));
check('missing qty/rate counter = 2', st.miss === '2', st.miss);
check('steps: items done, qty/rate warns, project name flagged', /done/.test(st.s2) && /warn/.test(st.s3) && !/done/.test(st.s1) && st.inv, JSON.stringify(st));
check('missing inputs are highlighted (1 qty + 1 rate)', st.missInputs === 2, String(st.missInputs));

await page.type('#bProj', 'UI-TEST Project');
await page.click('#bDetailsTog'); await sleep(100);
await page.type('#bRef', 'UIT-REF-9'); await page.type('#bWO', 'WO/UIT/1'); await page.type('#bClient', 'UI-TEST Contractor');
st = await page.evaluate(() => ({ s1: document.querySelector('.bq-step[data-step="1"]').className, snap: _revSnapshot(), meta: boqMeta() }));
check('project details: step 1 done', /done/.test(st.s1));
check('code / WO / contractor carried into meta and revision snapshots', st.meta.ref === 'UIT-REF-9' && st.meta.wo === 'WO/UIT/1' && st.snap.ref === 'UIT-REF-9' && st.snap.wo === 'WO/UIT/1' && st.meta.client === 'UI-TEST Contractor');

await page.click('#bMissTog'); await sleep(200);
st = await page.evaluate(() => [...document.querySelectorAll('#boqScroll tr[data-sid]')].map((tr) => boq.find((n) => n.sid === +tr.dataset.sid).name));
check('missing filter shows only incomplete items (+ section context)', st.length === 3 && !st.includes('UI-TEST complete'), st.join(', '));
await page.click('[data-clear-filters]'); await sleep(200);
check('"Show all rows" clears the filter', await page.evaluate(() => document.querySelectorAll('#boqScroll tr[data-sid]').length) === 4);

/* ── selection + bulk ── */
const itemBoxes = async () => page.$$('#boqScroll tr.bq-item input[data-sel]');
let bx = await itemBoxes(); await bx[0].click(); await bx[1].click();
check('bulk bar appears with the selection count', await page.evaluate(() => document.getElementById('bBulk').classList.contains('on') && /2 rows selected/.test(document.getElementById('bBulkCnt').textContent)));
await page.select('#bBulkGst', '5'); await sleep(150);
st = await page.evaluate(() => ({ g: boq.filter((n) => n.type === 'item').map((n) => +n.gst), t: bTotals(), foot: document.getElementById('bGst').textContent }));
check('bulk GST applies to the selected items only', st.g.join() === '5,5,18', st.g.join());
check('footer GST follows (₹' + st.t.gstAmt + ')', st.foot === '₹' + (await page.evaluate((v) => inr(Math.round(v * 100) / 100), st.t.gstAmt)), st.foot);
await page.click('[data-bulk="dup"]'); await sleep(200);
check('bulk duplicate adds 2 rows', await page.evaluate(() => boq.length) === 6);
await page.click('[data-bulk="del"]'); await sleep(200);
const confirmShown = await page.evaluate(() => !!document.querySelector('.ui-confirm'));
check('deleting several rows asks for confirmation in-app (no browser dialog)', confirmShown && dialogs.length === 0);
await page.click('.ui-confirm [data-r="1"]'); await sleep(200);
check('bulk delete removes the selected rows', await page.evaluate(() => boq.length) === 4);
await page.evaluate(() => [...document.querySelectorAll('#toastEl button')].find((b) => b.textContent === 'Undo').click()); await sleep(200);
check('Undo restores them', await page.evaluate(() => boq.length) === 6);
check('toast with Undo accepts clicks', await page.evaluate(() => { const t = document.getElementById('toastEl'); t.classList.add('show'); return getComputedStyle(t).pointerEvents; }) === 'auto');
await page.evaluate(() => { bSel.clear(); renderBOQ(); });
/* single leaf delete: immediate, with Undo */
await page.evaluate(() => { const tr = document.querySelector('#boqScroll tr.bq-item:last-of-type'); tr.querySelector('[data-act="del"]').click(); }); await sleep(200);
check('single-row delete is immediate (no confirm) and undoable', await page.evaluate(() => boq.length) === 5 && !(await page.evaluate(() => !!document.querySelector('.ui-confirm'))));
await page.evaluate(() => [...document.querySelectorAll('#toastEl button')].find((b) => b.textContent === 'Undo').click()); await sleep(200);
check('…and Undo brings it back', await page.evaluate(() => boq.length) === 6);

/* ── Review & Preview ── */
await page.click('#bReviewBtn'); await sleep(300);
st = await page.evaluate(() => {
  const ov = document.getElementById('bReviewOverlay'); const g = [...ov.querySelectorAll('.rv-sum tr.g td')].pop().textContent;
  return { on: ov.classList.contains('on'), g, foot: document.getElementById('bGrand').textContent,
    rows: ov.querySelectorAll('.rv-tbl tbody tr').length, expect: boqRows().rows.length, warn: ov.querySelectorAll('.rv-check.warn').length };
});
check('Review opens; grand total equals the footer', st.on && st.g === st.foot, st.g + ' vs ' + st.foot);
check('Review previews every exported row', st.rows === st.expect, st.rows + '/' + st.expect);
check('Review flags the missing quantity', st.warn >= 1);
await page.keyboard.press('Escape'); await sleep(150);
check('Escape closes Review; step 4 marked done', await page.evaluate(() => !document.getElementById('bReviewOverlay').classList.contains('on') && /done/.test(document.querySelector('.bq-step[data-step="4"]').className)));

/* ── exports carry code / WO ── */
await page.evaluate(() => { window.__dls = []; document.getElementById('bExpCsv').click(); document.getElementById('bExpXls').click(); }); await sleep(1500);
const dls = await page.evaluate(() => window.__dls.map((d) => ({ name: d.name, b64: d.b64 })));
const csv = dls.find((d) => d.name.endsWith('.csv'));
const csvTxt = csv ? Buffer.from(csv.b64, 'base64').toString('utf8') : '';
check('CSV export includes project code and WO number', /UIT-REF-9/.test(csvTxt) && /WO\/UIT\/1/.test(csvTxt));
const xl = dls.find((d) => d.name.endsWith('.xlsx'));
const xv = xl ? await page.evaluate((b) => { const ws = XLSX.read(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)), { type: 'array' }).Sheets.BOQ; return { a4: ws.A4 && ws.A4.v, b4: ws.B4 && ws.B4.v, a5: ws.A5 && ws.A5.v }; }, xl.b64) : {};
check('Excel: reference in row 4, column headers still in row 5', xv.a4 === 'Reference:' && /UIT-REF-9/.test(xv.b4 || '') && xv.a5 === 'Sl No', JSON.stringify(xv));
check('step 5 marked done after export', await page.evaluate(() => /done/.test(document.querySelector('.bq-step[data-step="5"]').className)));

/* ── File menu + Clear with undo ── */
await page.click('#bFileMenuBtn'); await sleep(100);
check('File menu opens', await page.evaluate(() => document.getElementById('bFileDd').classList.contains('open') && document.getElementById('bFileMenuBtn').getAttribute('aria-expanded') === 'true'));
await page.keyboard.press('Escape'); await sleep(100);
check('Escape closes the File menu', await page.evaluate(() => !document.getElementById('bFileDd').classList.contains('open')));
await page.evaluate(() => document.getElementById('bClear').click()); await sleep(200);
await page.click('.ui-confirm [data-r="1"]'); await sleep(200);
check('Clear BOQ (confirmed) empties it and shows next-step actions', await page.evaluate(() => boq.length === 0 && document.querySelectorAll('[data-empty-act]').length === 3));
await page.evaluate(() => [...document.querySelectorAll('#toastEl button')].find((b) => b.textContent === 'Undo').click()); await sleep(200);
check('Undo restores the cleared BOQ', await page.evaluate(() => boq.length) === 6);
check('no browser alert/confirm used by the BOQ Builder in this run', dialogs.length === 0, dialogs.join(' | '));

/* ── responsive: components scroll, the page never does ── */
for (const [w, h] of [[1366, 768], [1024, 768], [390, 844]]) {
  await page.setViewport({ width: w, height: h }); await sleep(400);
  const over = [];
  for (const k of ['boq', 'cs', 'enq', 'bmaster']) {
    await page.evaluate((key) => PShell.go(key), k); await sleep(350);
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (o.sw > o.iw) over.push(`${k}: ${o.sw} > ${o.iw}`);
  }
  check(`no page-level horizontal overflow at ${w}px (boq, cs, enq, bmaster)`, !over.length, over.join('; '));
}
check('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
