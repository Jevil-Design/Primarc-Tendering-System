import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

/* ═══════════════════════════════════════════════════════════════
   End-to-end through the real router: session gate → permission load →
   route handler. The unit tests in state-acl.test.mjs prove the ACL logic;
   these prove it is actually WIRED IN, which is the part that was missing
   before (the route had no permission check at all).

   env.DB is a hand-rolled stand-in for D1 that answers by SQL shape. It is
   deliberately dumb: if a query it does not recognise shows up, it throws,
   so a future change to these routes cannot quietly pass by hitting an
   unstubbed statement that returns undefined.
   ═══════════════════════════════════════════════════════════════ */

const SECRET = 'test-pepper';
const TOKEN = 'a'.repeat(40);

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MODULES = [
  'dashboard', 'projects', 'boqmaster', 'boqcreation', 'rateanalysis', 'enquiry',
  'tender', 'vendor', 'comparison', 'workorder', 'purchaseorder', 'materialmaster',
  'reports', 'administration', 'settings',
].map((code, i) => ({ id: 'm' + i, code }));

const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'reject',
                 'import', 'export', 'print', 'lock', 'unlock', 'share'];

const tenderData = () => ({
  quotations: [{ id: 'q1', base: 'ENQ/AAD/2026/001', items: [{ desc: 'Earthwork' }],
                 vendors: [{ name: 'Cheap Co', lines: [{ rate: 385, gst: 18 }] }] }],
  deleted: [], vendorMaster: [{ id: 'v1', name: 'Cheap Co' }],
  workOrders: [{ id: 'w1', no: 'WO/001', amount: 770000 }],
  masterCustom: [], notifications: [], seq: { ENQ: 1 },
});

/**
 * @param isAdmin      admin short-circuits the whole matrix
 * @param grants       { moduleCode: ['view', ...] } for a designation
 */
function makeEnv({ isAdmin = false, grants = {} } = {}) {
  const settings = new Map([
    ['app_state_v1', JSON.stringify({ __version: 7, data: tenderData() })],
    ['ui_perms', JSON.stringify({ Viewer: { export: 1 } })],
    ['migration_report', JSON.stringify({ rows: 999, note: 'legacy dump' })],
    ['company_profile', JSON.stringify({ name: 'Primarc' })],
  ]);
  const audits = [];

  const permRows = Object.entries(grants).map(([code, acts]) => {
    const row = { designation_id: 'd1', module_id: MODULES.find((m) => m.code === code).id };
    for (const a of ACTIONS) row['can_' + a] = acts.includes(a) ? 1 : 0;
    return row;
  });

  const user = {
    id: 'u1', username: 'tester', full_name: 'Tester', status: 'active', deleted_at: null,
    is_admin: isAdmin ? 1 : 0, designation_id: 'd1', financial_limits: '{}',
  };

  const db = {
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim();
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() {
          if (q.startsWith('select s.id as sid')) {
            const future = new Date(Date.now() + 3600e3).toISOString();
            return (args[0] === db.__sessionHash)
              ? { sid: 's1', expires_at: future, absolute_expires_at: future, ...user }
              : null;
          }
          if (q.startsWith('select setting_value from system_settings')) {
            const v = settings.get(args[0]);
            return v ? { setting_value: v } : null;
          }
          if (q.startsWith('select * from system_policy')) return { id: 1, min_password_length: 8 };
          throw new Error('unstubbed first(): ' + q);
        },
        async all() {
          if (q.startsWith('select id, code from modules')) return { results: MODULES };
          if (q.startsWith('select * from permissions where designation_id')) return { results: permRows };
          if (q.startsWith('select * from user_permission_overrides')) return { results: [] };
          if (q.startsWith('select setting_key, setting_value from system_settings')) {
            return { results: [...settings].map(([k, v]) => ({ setting_key: k, setting_value: v })) };
          }
          throw new Error('unstubbed all(): ' + q);
        },
        async run() {
          if (q.startsWith('update sessions set last_seen_at')) return { meta: { changes: 1 } };
          if (q.startsWith('insert into system_settings')) {
            settings.set(args[1], args[2]);
            return { meta: { changes: 1 } };
          }
          if (q.startsWith('insert into audit_logs')) { audits.push(args); return { meta: { changes: 1 } }; }
          throw new Error('unstubbed run(): ' + q);
        },
      };
      return api;
    },
  };
  db.__sessionHash = null;
  return { env: { DB: db, SESSION_PEPPER: SECRET, SESSION_IDLE_MINUTES: '30' },
           settings, audits, db };
}

async function call(ctxEnv, method, path, body) {
  ctxEnv.db.__sessionHash = await sha256Hex(TOKEN + '|' + SECRET);
  const res = await worker.fetch(new Request('https://x.test/api' + path, {
    method,
    headers: { cookie: 'ts_sid=' + TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), ctxEnv.env);
  return { status: res.status, body: await res.json() };
}

/* ── the hole that was reported ── */

test('a signed-in account with no tender rights is refused the whole document', async () => {
  const e = makeEnv({ grants: { dashboard: ['view'] } });
  const r = await call(e, 'GET', '/app-state');
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'FORBIDDEN');
});

test('a Vendor-only account gets vendors and nothing else', async () => {
  const e = makeEnv({ grants: { vendor: ['view'] } });
  const r = await call(e, 'GET', '/app-state');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.state.vendorMaster.length, 1);
  assert.deepEqual(r.body.data.state.quotations, [], 'no enquiries');
  assert.deepEqual(r.body.data.state.workOrders, [], 'no work orders');
  assert.ok(r.body.data.withheld.includes('workOrders'));
});

test('an enquiry reader without Comparison rights never receives a rate', async () => {
  const e = makeEnv({ grants: { enquiry: ['view'] } });
  const r = await call(e, 'GET', '/app-state');
  assert.equal(r.status, 200);
  const wire = JSON.stringify(r.body);
  assert.ok(!wire.includes('385'), 'the quoted rate must not appear anywhere in the response');
  assert.ok(!wire.includes('Cheap Co'), 'nor the vendor who quoted it');
  assert.equal(r.body.data.state.quotations[0].base, 'ENQ/AAD/2026/001');
});

test('an admin still receives everything', async () => {
  const e = makeEnv({ isAdmin: true });
  const r = await call(e, 'GET', '/app-state');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.state.quotations[0].vendors[0].lines[0].rate, 385);
  assert.equal(r.body.data.state.workOrders.length, 1);
});

/* ── writes ── */

test("a redacted client's save cannot wipe the sections it never saw", async () => {
  const e = makeEnv({ grants: { enquiry: ['view', 'edit'], comparison: ['view', 'edit'] } });
  const got = await call(e, 'GET', '/app-state');
  const sent = got.body.data.state;                       // workOrders/vendorMaster blank
  sent.quotations[0].items.push({ desc: 'New line' });

  const put = await call(e, 'PUT', '/app-state', { data: sent, baseVersion: got.body.data.version });
  assert.equal(put.status, 200);

  const stored = JSON.parse(e.settings.get('app_state_v1')).data;
  assert.equal(stored.workOrders.length, 1, 'work orders survived a save by someone who cannot see them');
  assert.equal(stored.vendorMaster.length, 1);
  assert.equal(stored.quotations[0].items.length, 2, 'their own edit was applied');
});

test('tampering with a read-only section is refused with 403 and changes nothing', async () => {
  const e = makeEnv({ grants: { enquiry: ['view', 'edit'], comparison: ['view', 'edit'], workorder: ['view'] } });
  const got = await call(e, 'GET', '/app-state');
  const sent = got.body.data.state;
  sent.workOrders[0].amount = 1;

  const put = await call(e, 'PUT', '/app-state', { data: sent, baseVersion: got.body.data.version });
  assert.equal(put.status, 403);
  const stored = JSON.parse(e.settings.get('app_state_v1')).data;
  assert.equal(stored.workOrders[0].amount, 770000, 'nothing was written');
});

test('a rate-blind editor cannot blank a vendor quote by saving', async () => {
  const e = makeEnv({ grants: { enquiry: ['view', 'edit'] } });
  const got = await call(e, 'GET', '/app-state');
  const sent = got.body.data.state;
  assert.deepEqual(sent.quotations[0].vendors, [], 'they were given blanks');

  const put = await call(e, 'PUT', '/app-state', { data: sent, baseVersion: got.body.data.version });
  assert.equal(put.status, 200);
  const stored = JSON.parse(e.settings.get('app_state_v1')).data;
  assert.equal(stored.quotations[0].vendors[0].lines[0].rate, 385, 'the real rate is still there');
  assert.ok(e.audits.length > 0, 'and the preservation was audited');
});

test('a version conflict does not become a way to read the hidden sections', async () => {
  /* The 409 body carries the server's copy so the client can adopt it in one
     round trip. That copy has to be redacted too — otherwise deliberately
     saving a stale baseVersion would dump the whole document to any account. */
  const e = makeEnv({ grants: { enquiry: ['view', 'edit'] } });
  const put = await call(e, 'PUT', '/app-state', { data: tenderData(), baseVersion: 1 });
  assert.equal(put.status, 409);
  const wire = JSON.stringify(put.body);
  assert.ok(!wire.includes('385'), 'no vendor rate in the conflict body');
  assert.ok(!wire.includes('WO/001'), 'no work orders in the conflict body');
  assert.equal(put.body.error.details.state.quotations.length, 1, 'what they may see is still returned');
});

/* ── the second leak: /settings was a back door to the same blob ── */

test('/settings no longer hands out the tender database', async () => {
  const e = makeEnv({ isAdmin: true });
  const r = await call(e, 'GET', '/settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.settings.app_state_v1, undefined, 'not even for an admin');
  assert.equal(r.body.data.settings.migration_report, undefined);
  assert.ok(!JSON.stringify(r.body).includes('385'), 'no rate leaks through this route');
});

test('/settings gives an ordinary user only the UI keys', async () => {
  const e = makeEnv({ grants: { enquiry: ['view'] } });
  const r = await call(e, 'GET', '/settings');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.data.settings), ['ui_perms']);
  assert.equal(r.body.data.settings.company_profile, undefined);
});

test('/settings still gives a settings admin the real configuration', async () => {
  const e = makeEnv({ grants: { settings: ['view'] } });
  const r = await call(e, 'GET', '/settings');
  assert.equal(r.body.data.settings.company_profile.name, 'Primarc');
  assert.equal(r.body.data.settings.app_state_v1, undefined, 'but never the dataset');
});

/* ── the gate itself ── */

test('no cookie means no data, whatever the route', async () => {
  const e = makeEnv({ isAdmin: true });
  for (const p of ['/app-state', '/settings']) {
    const res = await worker.fetch(new Request('https://x.test/api' + p), e.env);
    assert.equal(res.status, 401, p + ' must refuse an anonymous caller');
  }
});
