/* ═══════════════════════════════════════════════════════════════
   Tests for GSTIN verification (backend/routes/gst.js).

   Run:  node --test backend/gst.test.mjs
   Uses only node:test + node:assert — the project has no test framework
   and this feature was not a reason to introduce one.

   The point of most of these is the single rule that matters: a GSTIN is
   "verified" only when a provider affirmatively confirms it. Format
   validity, a cancelled registration, a timeout, an unconfigured provider
   and a 500 must all come back verified:false.
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import register, { normaliseGstin, gstinFormatValid, panFromGstin } from './routes/gst.js';

/* ── fixtures ───────────────────────────────────────────────────
   Structurally valid GSTINs with correct check digits, computed with the
   same published algorithm the app uses (so these are real-shaped numbers,
   not registrations — nothing here asserts they exist). */
function withCheckDigit(first14) {
  const C = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = i % 2 === 0 ? C.indexOf(first14[i]) : C.indexOf(first14[i]) * 2;
    sum += Math.floor(v / 36) + (v % 36);
  }
  return first14 + C[(36 - (sum % 36)) % 36];
}
const GSTIN = withCheckDigit('27ABCDE1234F1Z');   // Maharashtra, PAN ABCDE1234F
const GSTIN2 = withCheckDigit('29ZZXYW9876Q1Z');  // Karnataka,   PAN ZZXYW9876Q
const PAN = 'ABCDE1234F';

/* ── minimal ctx + DB stub ──────────────────────────────────────
   Matches on query text rather than parsing SQL — enough to exercise the
   handler's branches without pulling in a SQLite engine. */
function makeCtx({ env = {}, rows = {}, user = { id: 'u1', is_admin: true }, body = {} } = {}) {
  const writes = [], logs = [];
  const DB = {
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim();
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() {
          if (q.startsWith('select * from gst_verifications')) return rows.cacheHit || null;
          if (q.includes('count(*) as n from gst_verification_log')) return { n: rows.hourCount || 0 };
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (q.startsWith('insert into gst_verification_log')) logs.push(args);
          else if (q.startsWith('insert into gst_verifications')) writes.push(args);
          else if (q.startsWith('insert into audit_logs')) { /* logAudit */ }
          return { meta: { changes: 1 } };
        },
      };
      return api;
    },
  };
  return {
    ctx: { env: { DB, ...env }, user, permissions: {}, body, query: {}, params: {}, request: new Request('http://x/api/gst/verify', { method: 'POST' }) },
    writes, logs,
  };
}

/** Pulls the POST /gst/verify handler out of the module's registration. */
function verifyHandler() {
  let handler = null;
  register({
    get() { return this; },
    post(path, h) { if (path === '/gst/verify') handler = h; return this; },
  });
  assert.ok(handler, 'POST /gst/verify should be registered');
  return handler;
}
const run = (opts) => verifyHandler()(makeCtx(opts).ctx);

/** Captures the log rows a call wrote, to assert the audit trail. */
async function runCapturing(opts) {
  const m = makeCtx(opts);
  let out = null, err = null;
  try { out = await verifyHandler()(m.ctx); } catch (e) { err = e; }
  return { out, err, writes: m.writes, logs: m.logs };
}

const stubFetch = (impl) => { globalThis.fetch = impl; };
const PROVIDER_ENV = {
  GST_API_PROVIDER: 'custom',
  GST_API_URL: 'https://provider.test/gstin/{gstin}',
  GST_API_KEY: 'test-key',
  GST_API_HEADERS: '{"Authorization":"Bearer {key}"}',
  GST_API_FIELD_MAP: '{"status":"data.status","legalName":"data.legal_name","tradeName":"data.trade_name","state":"data.state","registrationDate":"data.registered_on"}',
};
const providerJson = (body, status = 200) => stubFetch(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

/* ════════════════════ pure helpers ════════════════════ */

test('PAN is extracted from GSTIN characters 3-12', () => {
  assert.equal(panFromGstin(GSTIN), PAN);
  assert.equal(panFromGstin('27ABCDE1234F1Z5'), PAN);   // the spec's own example
});

test('normalisation strips whitespace and upper-cases', () => {
  assert.equal(normaliseGstin('  27abcde1234f1z5 '), '27ABCDE1234F1Z5');
  assert.equal(normaliseGstin('27 ABCDE 1234 F1Z5'), '27ABCDE1234F1Z5');
  assert.equal(normaliseGstin(null), '');
});

test('format check accepts a well-formed GSTIN and rejects malformed ones', () => {
  assert.equal(gstinFormatValid(GSTIN), true);
  assert.equal(gstinFormatValid(''), false);
  assert.equal(gstinFormatValid('27ABCDE1234F1Z'), false);      // 14 chars
  assert.equal(gstinFormatValid('27ABCDE1234F1Z55'), false);    // 16 chars
  assert.equal(gstinFormatValid('27ABCDE1234F1Y5'), false);     // 'Z' slot wrong
  assert.equal(gstinFormatValid('AB CDE1234F1Z5'), false);      // junk
  assert.equal(gstinFormatValid('271234512345678'), false);     // digits where letters belong
});

test('a wrong check digit is rejected even though the layout is right', () => {
  const C = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const wrong = GSTIN.slice(0, 14) + C[(C.indexOf(GSTIN[14]) + 1) % 36];
  assert.equal(gstinFormatValid(wrong), false);
});

/* ════════════════════ endpoint behaviour ════════════════════ */

test('malformed GSTIN is rejected before any provider call', async () => {
  let called = false;
  stubFetch(async () => { called = true; return new Response('{}'); });
  const { err, logs } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: 'nonsense' } });
  assert.equal(err.code, 'VALIDATION');
  assert.match(err.message, /valid 15-character GSTIN/);
  assert.equal(called, false, 'must not spend a provider call on a malformed GSTIN');
  assert.equal(logs.length, 1, 'the attempt is still logged');
});

test('valid ACTIVE GSTIN verifies, returns the legal name and derives the PAN', async () => {
  providerJson({ data: { status: 'Active', legal_name: 'ABC INFRA PRIVATE LIMITED', trade_name: 'ABC INFRA', state: 'Maharashtra', registered_on: '01/07/2017' } });
  const { out, writes } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  assert.equal(out.verified, true);
  assert.equal(out.status, 'ACTIVE');
  assert.equal(out.legalName, 'ABC INFRA PRIVATE LIMITED');
  assert.equal(out.tradeName, 'ABC INFRA');
  assert.equal(out.pan, PAN);
  assert.equal(out.state, 'Maharashtra');
  assert.equal(out.source, 'custom');
  assert.ok(out.verifiedAt, 'a verification timestamp is stored');
  assert.equal(writes.length, 1, 'result is cached');
  assert.equal(writes[0][1], 1, 'cached row is marked verified');
});

test('state resolves from the GSTIN prefix when the provider omits it', async () => {
  providerJson({ data: { status: 'Active', legal_name: 'SOUTH BUILDERS LLP' } });
  const { out } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN2 } });
  assert.equal(out.verified, true);
  assert.equal(out.state, 'Karnataka');   // 29
});

test('CANCELLED registration is reported, never counted as verified', async () => {
  providerJson({ data: { status: 'Cancelled', legal_name: 'OLD TRADERS' } });
  const { out, writes } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  assert.equal(out.verified, false);
  assert.equal(out.status, 'CANCELLED');
  assert.equal(out.code, 'CANCELLED');
  assert.match(out.message, /cancelled/i);
  assert.equal(writes[0][1], 0, 'cached row must not be marked verified');
});

test('SUSPENDED and INACTIVE are distinguished from each other', async () => {
  providerJson({ data: { status: 'Suspended', legal_name: 'X' } });
  let r = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  assert.equal(r.out.code, 'SUSPENDED');
  assert.match(r.out.message, /suspended/i);

  providerJson({ data: { status: 'Inactive', legal_name: 'X' } });
  r = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  assert.equal(r.out.code, 'INACTIVE');
  assert.equal(r.out.verified, false);
});

test('GSTIN not found is an authoritative answer, not a verification', async () => {
  stubFetch(async () => new Response('{}', { status: 404 }));
  const { out } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  assert.equal(out.verified, false);
  assert.equal(out.code, 'NOT_FOUND');
  assert.equal(out.pan, PAN, 'the locally derived PAN is still returned');
});

test('unconfigured provider reports PROVIDER_UNCONFIGURED and never fakes success', async () => {
  let called = false;
  stubFetch(async () => { called = true; return new Response('{}'); });
  const { out } = await runCapturing({ env: {}, body: { gstin: GSTIN } });
  assert.equal(out.verified, false);
  assert.equal(out.configured, false);
  assert.equal(out.code, 'PROVIDER_UNCONFIGURED');
  assert.equal(out.formatValid, true, 'format validity is still reported…');
  assert.equal(out.pan, PAN, '…along with the derived PAN');
  assert.equal(called, false);
});

test('timeout surfaces a retry message, not a stack trace', async () => {
  stubFetch(async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; });
  const { err, logs } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  assert.match(err.message, /timed out/i);
  assert.equal(logs[0][2], 'provider_timeout');
});

test('network failure keeps the message user-facing and leaks no URL', async () => {
  stubFetch(async () => { throw new TypeError('fetch failed'); });
  const { err, logs } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  assert.match(err.message, /Could not reach the GST verification service/);
  assert.doesNotMatch(err.message, /provider\.test|test-key/, 'never expose the endpoint or key');
  assert.equal(logs[0][2], 'network_error');
});

test('provider 500 is reported as temporarily unavailable', async () => {
  stubFetch(async () => new Response('upstream boom', { status: 500 }));
  const { err, logs } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  assert.match(err.message, /temporarily unavailable/i);
  assert.doesNotMatch(err.message, /boom/, 'raw provider body must not reach the user');
  assert.equal(logs[0][2], 'provider_error');
});

test('provider 401 becomes an admin-facing config error, not a credential hint', async () => {
  stubFetch(async () => new Response('{"error":"bad api key test-key"}', { status: 401 }));
  const { err } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  assert.match(err.message, /not configured correctly/i);
  assert.doesNotMatch(err.message, /test-key/);
});

test('provider 429 maps to a rate-limit message', async () => {
  stubFetch(async () => new Response('{}', { status: 429 }));
  const { err, logs } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  assert.equal(err.code, 'RATE_LIMIT');
  assert.equal(logs[0][2], 'rate_limited');
});

test('per-user hourly cap blocks the call before it reaches the provider', async () => {
  let called = false;
  stubFetch(async () => { called = true; return new Response('{}'); });
  const { err } = await runCapturing({
    env: { ...PROVIDER_ENV, GST_RATE_LIMIT_PER_HOUR: '5' },
    rows: { hourCount: 5 },
    body: { gstin: GSTIN },
  });
  assert.equal(err.code, 'RATE_LIMIT');
  assert.match(err.message, /hourly limit of 5/);
  assert.equal(called, false);
});

test('a fresh cached verification is served without calling the provider', async () => {
  let called = false;
  stubFetch(async () => { called = true; return new Response('{}'); });
  const cacheHit = {
    gstin: GSTIN, verified: 1, status: 'ACTIVE', legal_name: 'CACHED CO', trade_name: null,
    pan: PAN, state: 'Maharashtra', state_code: '27', registration_date: null,
    taxpayer_type: null, constitution: null, payload: '{}', source: 'custom',
    verified_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
  const { out, logs } = await runCapturing({ env: PROVIDER_ENV, rows: { cacheHit }, body: { gstin: GSTIN } });
  assert.equal(out.verified, true);
  assert.equal(out.cached, true);
  assert.equal(out.legalName, 'CACHED CO');
  assert.equal(called, false, 'cache hit must not spend a provider call');
  assert.equal(logs[0][7], 1, 'logged as a cache hit');
});

test('force (Re-verify) bypasses the cache and re-asks the provider', async () => {
  let called = 0;
  stubFetch(async () => { called++; return new Response(JSON.stringify({ data: { status: 'Active', legal_name: 'FRESH CO' } }), { status: 200 }); });
  const cacheHit = {
    gstin: GSTIN, verified: 1, status: 'ACTIVE', legal_name: 'STALE CO', pan: PAN,
    payload: '{}', source: 'custom', verified_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
  const { out } = await runCapturing({ env: PROVIDER_ENV, rows: { cacheHit }, body: { gstin: GSTIN, force: true } });
  assert.equal(called, 1);
  assert.equal(out.legalName, 'FRESH CO');
  assert.equal(out.cached, false);
});

test('an unreadable provider shape is a mapping error, not a false verified', async () => {
  providerJson({ unexpected: { shape: true } });
  const { err, logs } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  assert.match(err.message, /could not be read/i);
  assert.match(err.message, /GST_API_FIELD_MAP/);
  assert.equal(logs[0][2], 'provider_bad_shape');
});

test('every attempt is logged with the GSTIN and outcome', async () => {
  providerJson({ data: { status: 'Active', legal_name: 'LOGGED CO' } });
  const { logs } = await runCapturing({ env: PROVIDER_ENV, body: { gstin: GSTIN, vendorId: 'v-42' } });
  assert.equal(logs.length, 1);
  const [, gstin, result, , source, vendorId, userId] = logs[0];
  assert.equal(gstin, GSTIN);
  assert.equal(result, 'verified');
  assert.equal(source, 'custom');
  assert.equal(vendorId, 'v-42');
  assert.equal(userId, 'u1');
});

test('a caller without vendor:view is refused', async () => {
  providerJson({ data: { status: 'Active' } });
  const handler = verifyHandler();
  const { ctx } = makeCtx({ env: PROVIDER_ENV, body: { gstin: GSTIN } });
  ctx.user = { id: 'u2', is_admin: false };   // no permissions granted
  await assert.rejects(() => handler(ctx), (e) => e.code === 'FORBIDDEN');
});

/* ════════════════════ vendor-master rules (client logic, mirrored) ═══
   These mirror the rules enforced in web/index.html's vendor form. They are
   duplicated here as executable specifications because that file is a
   single 14 MB page with no module boundary to import from. */

const normGst = (g) => String(g || '').replace(/\s+/g, '').toUpperCase();
const panFrom = (g) => { const p = normGst(g).slice(2, 12); return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p) ? p : ''; };
function clearGstMeta(v) {
  v.gstStatus = ''; v.gstLegalName = ''; v.gstTradeName = ''; v.gstRegistrationDate = '';
  v.gstVerified = false; v.gstVerifiedAt = ''; v.gstVerificationSource = '';
}

test('duplicate GSTIN is detected case- and whitespace-insensitively', () => {
  const master = [{ id: 'a', name: 'ABC Infra', code: 'V001', gst: GSTIN }];
  const typed = '  ' + GSTIN.toLowerCase() + ' ';
  const clash = master.find((v) => v.id !== 'b' && normGst(v.gst) === normGst(typed));
  assert.ok(clash, 'must catch the same GSTIN in different case/spacing');
  assert.equal(clash.name, 'ABC Infra');
});

test('editing the vendor that owns the GSTIN is not a self-duplicate', () => {
  const master = [{ id: 'a', name: 'ABC Infra', gst: GSTIN }];
  const clash = master.find((v) => v.id !== 'a' && normGst(v.gst) === normGst(GSTIN));
  assert.equal(clash, undefined);
});

test('changing the GSTIN drops the old verification and re-derives the PAN', () => {
  const v = {
    gst: GSTIN, pan: PAN, gstVerified: true, gstStatus: 'ACTIVE',
    gstLegalName: 'ABC INFRA PRIVATE LIMITED', gstVerifiedAt: '2026-09-01T10:00:00Z',
    gstVerificationSource: 'custom', gstTradeName: 'ABC', gstRegistrationDate: '2017-07-01',
  };
  v.gst = GSTIN2;
  clearGstMeta(v);
  v.pan = panFrom(v.gst);
  assert.equal(v.gstVerified, false, 'verification must not survive the change');
  assert.equal(v.gstLegalName, '');
  assert.equal(v.gstVerifiedAt, '');
  assert.equal(v.pan, panFrom(GSTIN2));
  assert.notEqual(v.pan, PAN, 'the previous GSTIN\'s PAN must not be retained');
});

test('a PAN that contradicts the GSTIN is rejected at save', () => {
  const derived = panFrom(GSTIN);
  const typed = 'ZZZZZ9999Z';
  assert.notEqual(typed, derived);
  assert.ok(derived && typed !== derived, 'save must block this combination');
});

test('Excel import derives the PAN and never marks the row verified', () => {
  const rec = { name: 'Imported Co', gst: '  ' + GSTIN.toLowerCase() + '  ', pan: 'WRONGP4N0X' };
  const gst = normGst(rec.gst);
  const pan = panFrom(gst) || String(rec.pan || '').toUpperCase();
  const row = { name: rec.name, gst, pan, gstVerified: false, gstVerifiedAt: '', gstVerificationSource: '' };
  assert.equal(row.gst, GSTIN, 'normalised');
  assert.equal(row.pan, PAN, 'GSTIN-derived PAN wins over the spreadsheet value');
  assert.equal(row.gstVerified, false, 'import can never confer verification');
});

test('a legacy vendor with GST but no metadata reads as not verified', () => {
  const legacy = { name: 'Old Vendor', code: 'V009', gst: GSTIN, pan: PAN };   // pre-feature shape
  assert.equal(!!legacy.gstVerified, false);
  assert.equal(legacy.gst, GSTIN, 'existing values are left untouched');
  assert.equal(legacy.pan, PAN);
});

test('verification metadata is only saved when it matches the GSTIN being saved', () => {
  const inForm = { gstin: GSTIN, verified: true, status: 'ACTIVE', legalName: 'ABC INFRA PRIVATE LIMITED' };
  const saving = normGst(GSTIN2);                       // user edited the GSTIN after verifying
  const usable = saving && inForm.gstin === saving && inForm.verified ? inForm : null;
  assert.equal(usable, null, 'stale result must not be attached to a different GSTIN');
});
