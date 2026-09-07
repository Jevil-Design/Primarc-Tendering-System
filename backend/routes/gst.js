import { requirePerm, MODULE } from '../permissions.js';
import { validate } from '../validation.js';
import { logAudit } from '../audit.js';
import { newId, nowIso } from '../lib/util.js';
import { errors } from '../lib/response.js';

/* ═══════════════════════════════════════════════════════════════
   GSTIN verification proxy.

   The browser never talks to the GST provider. It POSTs a GSTIN here and
   gets back a normalised, display-safe answer; the provider URL, key and
   secret stay in env vars that only this module reads. Nothing in a
   response body, an audit row or an error message ever carries them.

   Two ideas are kept strictly apart, because conflating them is how a
   vendor master ends up full of "verified" GSTINs nobody ever checked:

     · format valid   — 15 chars, correct layout, correct check digit.
                        Computed locally, free, proves nothing about
                        whether the registration exists.
     · verified       — the configured provider affirmatively confirmed
                        the registration. Only this sets verified = 1.

   With no provider configured the endpoint returns
   PROVIDER_UNCONFIGURED. It does NOT fall back to "format is fine, call
   it verified" — that would be a fake verification, which is worse than
   no feature at all.
   ═══════════════════════════════════════════════════════════════ */

/* ── GSTIN structure ──────────────────────────────────────────────
   NN  PPPPPPPPPP  E  Z  C
   │   │           │  │  └ check digit
   │   │           │  └── literal 'Z' for a normal registration
   │   │           └───── entity number for that PAN in that state
   │   └── PAN (chars 3-12, i.e. index 2..11)
   └────── state code                                              */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const CHECK_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Published GST state codes. A fixed government code list, not provider
    data — safe to resolve locally so the UI can show a state even before
    (or without) a provider round-trip. */
const STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '96': 'Foreign Country', '97': 'Other Territory', '99': 'Centre Jurisdiction',
};

export function normaliseGstin(raw) {
  return String(raw || '').replace(/\s+/g, '').toUpperCase();
}

/** Format + ISO 7064 MOD 36,37-style check digit used by GSTIN. */
export function gstinFormatValid(gstin) {
  if (!GSTIN_RE.test(gstin)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const idx = CHECK_CHARS.indexOf(gstin[i]);
    const v = i % 2 === 0 ? idx : idx * 2;
    sum += Math.floor(v / 36) + (v % 36);
  }
  return CHECK_CHARS[(36 - (sum % 36)) % 36] === gstin[14];
}

export function panFromGstin(gstin) {
  const pan = gstin.slice(2, 12);
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) ? pan : null;
}

/* ── provider adapters ────────────────────────────────────────────
   Each preset only supplies defaults for URL / headers / field paths;
   every one of them is overridable by env, and `custom` reads all of it
   from env. That means a provider whose contract has changed — or one not
   listed here at all — is a config change, never a code change.

   The presets are starting points taken from each provider's published
   integration shape. Confirm the current contract against your provider's
   own docs when you configure it; if a path is wrong you will get
   PROVIDER_BAD_SHAPE (a clear mapping error), never a false "verified".  */
const PRESETS = {
  masters_india: {
    url: 'https://commonapi.mastersindia.co/commonapis/searchgstin?gstin={gstin}',
    method: 'GET',
    headers: { Authorization: 'Bearer {key}', client_id: '{secret}' },
    paths: {
      ok: 'error', okEquals: false,
      status: 'data.sts', legalName: 'data.lgnm', tradeName: 'data.tradeNam',
      state: 'data.pradr.addr.stcd', registrationDate: 'data.rgdt',
      taxpayerType: 'data.dty', constitution: 'data.ctb',
    },
  },
  sandbox: {
    url: 'https://api.sandbox.co.in/gst/compliance/public/gstin/search',
    method: 'POST',
    headers: { 'x-api-key': '{key}', Authorization: '{secret}', 'Content-Type': 'application/json' },
    body: '{"gstin":"{gstin}"}',
    paths: {
      status: 'data.sts', legalName: 'data.lgnm', tradeName: 'data.tradeNam',
      state: 'data.pradr.addr.stcd', registrationDate: 'data.rgdt',
      taxpayerType: 'data.dty', constitution: 'data.ctb',
    },
  },
  surepass: {
    url: 'https://kyc-api.surepass.io/api/v1/corporate/gstin',
    method: 'POST',
    headers: { Authorization: 'Bearer {key}', 'Content-Type': 'application/json' },
    body: '{"id_number":"{gstin}"}',
    paths: {
      ok: 'success', okEquals: true,
      status: 'data.gstin_status', legalName: 'data.legal_name',
      tradeName: 'data.business_name', state: 'data.address.state',
      registrationDate: 'data.date_of_registration', constitution: 'data.constitution_of_business',
    },
  },
  custom: { method: 'GET', headers: {}, paths: {} },
};

function dig(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Map a provider's status wording onto our fixed vocabulary. */
function mapStatus(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return null;
  if (/CANCEL/.test(s)) return 'CANCELLED';
  if (/SUSPEND/.test(s)) return 'SUSPENDED';
  if (/PROVISION/.test(s)) return 'PROVISIONAL';
  if (/INACTIVE|INOPERATIVE/.test(s)) return 'INACTIVE';
  if (/ACTIVE/.test(s)) return 'ACTIVE';
  return s.slice(0, 40);
}

function providerConfig(env) {
  const id = (env.GST_API_PROVIDER || '').trim() || null;
  if (!id) return null;
  const preset = PRESETS[id] || PRESETS.custom;
  const key = env.GST_API_KEY || '';
  const secret = env.GST_API_SECRET || '';
  const url = (env.GST_API_URL || preset.url || '').trim();
  if (!url) return null;
  // A preset with a {key} placeholder in its headers is unusable without one.
  const needsKey = JSON.stringify(preset.headers || {}).includes('{key}') || (env.GST_API_URL || '').includes('{key}');
  if (needsKey && !key) return null;

  let headers = preset.headers || {};
  if (env.GST_API_HEADERS) {
    try { headers = JSON.parse(env.GST_API_HEADERS); }
    catch { throw errors.internal('GST provider configuration is invalid. Ask an administrator to check GST_API_HEADERS.'); }
  }
  let paths = preset.paths || {};
  if (env.GST_API_FIELD_MAP) {
    try { paths = { ...paths, ...JSON.parse(env.GST_API_FIELD_MAP) }; }
    catch { throw errors.internal('GST provider configuration is invalid. Ask an administrator to check GST_API_FIELD_MAP.'); }
  }
  return {
    id, url, headers, paths,
    method: (env.GST_API_METHOD || preset.method || 'GET').toUpperCase(),
    body: env.GST_API_BODY || preset.body || null,
    key, secret,
    timeoutMs: Math.min(Math.max(parseInt(env.GST_API_TIMEOUT_MS || '10000', 10) || 10000, 1000), 30000),
  };
}

const fill = (tpl, gstin, cfg) => String(tpl)
  .replace(/\{gstin\}/g, gstin)
  .replace(/\{key\}/g, cfg.key)
  .replace(/\{secret\}/g, cfg.secret);

/** Calls the provider and returns a normalised record, or throws an
    ApiError whose message is already safe to show a user. */
async function callProvider(cfg, gstin) {
  const url = fill(cfg.url, gstin, cfg);
  const headers = {};
  for (const [k, val] of Object.entries(cfg.headers || {})) headers[k] = fill(val, gstin, cfg);

  const init = { method: cfg.method, headers };
  if (cfg.method !== 'GET' && cfg.body) {
    init.body = fill(cfg.body, gstin, cfg);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  let res;
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), cfg.timeoutMs) : null;
  if (ac) init.signal = ac.signal;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Swallow the cause deliberately: the thrown/logged value must never
    // include `url`, which carries the key for query-string-auth providers.
    if (timer) clearTimeout(timer);
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    throw aborted
      ? Object.assign(errors.validation('GST verification timed out. Please try again.'), { gstResult: 'provider_timeout' })
      : Object.assign(errors.validation('Could not reach the GST verification service. Please try again.'), { gstResult: 'network_error' });
  }
  if (timer) clearTimeout(timer);

  if (res.status === 401 || res.status === 403) {
    throw Object.assign(
      errors.internal('GST verification is not configured correctly. Please contact your administrator.'),
      { gstResult: 'auth_failed' });
  }
  if (res.status === 429) {
    throw Object.assign(errors.rateLimit('The GST verification service is busy. Please try again in a minute.'),
      { gstResult: 'rate_limited' });
  }
  if (res.status === 404) {
    return { found: false, status: 'NOT_FOUND' };
  }
  if (!res.ok) {
    throw Object.assign(errors.validation('GST verification service is temporarily unavailable. Please try again.'),
      { gstResult: 'provider_error' });
  }

  let data;
  try { data = await res.json(); }
  catch {
    throw Object.assign(errors.validation('GST verification returned an unreadable response. Please try again.'),
      { gstResult: 'provider_error' });
  }

  const p = cfg.paths || {};
  if (p.ok) {
    const okVal = dig(data, p.ok);
    const expected = p.okEquals;
    const matches = typeof expected === 'boolean' ? Boolean(okVal) === expected : String(okVal) === String(expected);
    if (!matches) {
      const status = mapStatus(dig(data, p.status));
      if (status) return { found: true, status, data };
      return { found: false, status: 'NOT_FOUND' };
    }
  }

  const status = mapStatus(dig(data, p.status));
  const legalName = dig(data, p.legalName);
  // If neither a status nor a name came back, the field mapping is wrong.
  // Say so plainly instead of reporting an unverifiable "verified".
  if (!status && !legalName) {
    throw Object.assign(
      errors.internal('The GST provider response could not be read. Ask an administrator to check GST_API_FIELD_MAP.'),
      { gstResult: 'provider_bad_shape' });
  }
  return { found: true, status: status || 'ACTIVE', data };
}

/* ── rate limiting ───────────────────────────────────────────────
   Counted from gst_verification_log, so it survives cold starts (this runs
   serverless — an in-memory counter would reset on every new instance). */
async function rateLimited(ctx, limitPerHour) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const row = await ctx.env.DB.prepare(
    'select count(*) as n from gst_verification_log where user_id = ? and created_at > ? and cached = 0'
  ).bind(ctx.user.id, since).first();
  return (row?.n || 0) >= limitPerHour;
}

async function logAttempt(ctx, { gstin, result, message, source, vendorId, cached, ms }) {
  try {
    await ctx.env.DB.prepare(
      `insert into gst_verification_log (id, gstin, result, message, source, vendor_id, user_id, cached, duration_ms)
       values (?,?,?,?,?,?,?,?,?)`
    ).bind(newId(), gstin, result, message ? String(message).slice(0, 300) : null,
           source || null, vendorId || null, ctx.user?.id || null, cached ? 1 : 0, ms ?? null).run();
  } catch (err) {
    console.error('[gst] log failed:', err.message);   // never block the caller
  }
}

function shape(row) {
  let extra = {};
  try { extra = JSON.parse(row.payload || '{}'); } catch { extra = {}; }
  return {
    success: true,
    verified: !!row.verified,
    gstin: row.gstin,
    status: row.status || null,
    legalName: row.legal_name || null,
    tradeName: row.trade_name || null,
    pan: row.pan || null,
    state: row.state || null,
    stateCode: row.state_code || null,
    registrationDate: row.registration_date || null,
    taxpayerType: row.taxpayer_type || null,
    constitution: row.constitution || null,
    verifiedAt: row.verified_at,
    source: row.source,
    ...extra,
  };
}

export default function register(router) {
  /* Tells the UI whether verification is available at all, so it can hide or
     disable the Verify button instead of offering an action that must fail.
     Reports only whether a provider is set — never which key. */
  router.get('/gst/config', async (ctx) => {
    if (!ctx.user) throw errors.unauthorized();
    let cfg = null;
    try { cfg = providerConfig(ctx.env); } catch { cfg = null; }
    return {
      configured: !!cfg,
      provider: cfg ? cfg.id : null,
      cacheDays: Number(ctx.env.GST_CACHE_DAYS || 30),
    };
  });

  router.post('/gst/verify', async (ctx) => {
    requirePerm(ctx, MODULE.VENDOR, 'view');
    const v = validate(ctx.body).string('gstin', { required: true, max: 20 }).done();
    const vendorId = ctx.body?.vendorId ? String(ctx.body.vendorId).slice(0, 60) : null;
    const force = !!ctx.body?.force;                       // Re-verify: bypass cache
    const gstin = normaliseGstin(v.gstin);
    const started = Date.now();

    /* 1 — format. Cheap, local, and never reported as "verified". */
    if (!gstinFormatValid(gstin)) {
      await logAttempt(ctx, { gstin, result: 'invalid_format', message: 'Failed format/checksum check', vendorId });
      throw errors.validation('Enter a valid 15-character GSTIN.', { gstin: 'Check the GSTIN and try again.' });
    }

    const pan = panFromGstin(gstin);
    const stateCode = gstin.slice(0, 2);
    const state = STATE_CODES[stateCode] || null;

    /* 2 — cache. A GSTIN verified recently is not re-fetched. */
    const cacheDays = Math.min(Math.max(Number(ctx.env.GST_CACHE_DAYS || 30), 0), 365);
    if (!force && cacheDays > 0) {
      const hit = await ctx.env.DB.prepare(
        `select * from gst_verifications
         where gstin = ? and verified = 1 and (expires_at is null or expires_at > ?)`
      ).bind(gstin, nowIso()).first();
      if (hit) {
        await logAttempt(ctx, { gstin, result: 'cached', source: hit.source, vendorId, cached: 1, ms: Date.now() - started });
        return { ...shape(hit), cached: true };
      }
    }

    /* 3 — provider. Unconfigured is reported as such, never faked. */
    const cfg = providerConfig(ctx.env);
    if (!cfg) {
      await logAttempt(ctx, { gstin, result: 'provider_unconfigured', vendorId });
      return {
        success: true, verified: false, gstin, pan, state, stateCode,
        status: null, legalName: null, tradeName: null,
        formatValid: true, configured: false,
        code: 'PROVIDER_UNCONFIGURED',
        message: 'GST verification is not set up yet. The GSTIN format is valid but has not been government-verified.',
      };
    }

    const perHour = Math.min(Math.max(Number(ctx.env.GST_RATE_LIMIT_PER_HOUR || 120), 1), 5000);
    if (await rateLimited(ctx, perHour)) {
      await logAttempt(ctx, { gstin, result: 'rate_limited', source: cfg.id, vendorId });
      throw errors.rateLimit(`You have reached the hourly limit of ${perHour} GST verifications. Please try again later.`);
    }

    let out;
    try {
      out = await callProvider(cfg, gstin);
    } catch (err) {
      await logAttempt(ctx, { gstin, result: err.gstResult || 'provider_error', message: err.message,
                              source: cfg.id, vendorId, ms: Date.now() - started });
      throw err;
    }

    /* 4 — not found: a real, authoritative answer, but not a verification. */
    if (!out.found) {
      await logAttempt(ctx, { gstin, result: 'not_found', source: cfg.id, vendorId, ms: Date.now() - started });
      return {
        success: true, verified: false, gstin, pan, state, stateCode,
        status: 'NOT_FOUND', formatValid: true, configured: true,
        code: 'NOT_FOUND',
        message: 'This GSTIN was not found on the GST portal.',
      };
    }

    const p = cfg.paths || {};
    const d = out.data;
    const legalName = (dig(d, p.legalName) || '').toString().trim() || null;
    const tradeName = (dig(d, p.tradeName) || '').toString().trim() || null;
    const provState = (dig(d, p.state) || '').toString().trim() || null;
    const regDate = (dig(d, p.registrationDate) || '').toString().trim() || null;
    const taxpayerType = (dig(d, p.taxpayerType) || '').toString().trim() || null;
    const constitution = (dig(d, p.constitution) || '').toString().trim() || null;
    const status = out.status;
    // Only ACTIVE / PROVISIONAL count as a usable, verified registration.
    const verified = status === 'ACTIVE' || status === 'PROVISIONAL';

    const row = {
      gstin, verified: verified ? 1 : 0, status,
      legal_name: legalName, trade_name: tradeName, pan,
      state: provState || state, state_code: stateCode,
      registration_date: regDate, taxpayer_type: taxpayerType, constitution,
      payload: JSON.stringify({}),   // display fields are all columns already
      source: cfg.id,
      verified_at: nowIso(),
      expires_at: cacheDays > 0 ? new Date(Date.now() + cacheDays * 86400_000).toISOString() : null,
    };

    await ctx.env.DB.prepare(
      `insert into gst_verifications (gstin, verified, status, legal_name, trade_name, pan, state,
        state_code, registration_date, taxpayer_type, constitution, payload, source, verified_at, expires_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict(gstin) do update set verified = excluded.verified, status = excluded.status,
         legal_name = excluded.legal_name, trade_name = excluded.trade_name, pan = excluded.pan,
         state = excluded.state, state_code = excluded.state_code,
         registration_date = excluded.registration_date, taxpayer_type = excluded.taxpayer_type,
         constitution = excluded.constitution, payload = excluded.payload, source = excluded.source,
         verified_at = excluded.verified_at, expires_at = excluded.expires_at, updated_at = excluded.updated_at`
    ).bind(row.gstin, row.verified, row.status, row.legal_name, row.trade_name, row.pan, row.state,
           row.state_code, row.registration_date, row.taxpayer_type, row.constitution, row.payload,
           row.source, row.verified_at, row.expires_at, nowIso()).run();

    await logAttempt(ctx, { gstin, result: verified ? 'verified' : 'inactive', source: cfg.id,
                            vendorId, ms: Date.now() - started });
    await logAudit(ctx, { module: 'Vendor', action: verified ? 'gst_verified' : 'gst_verify_inactive',
                          entityType: 'gst_verifications', entityId: gstin,
                          target: legalName || gstin, newValue: { status, source: cfg.id } });

    const shaped = shape(row);
    if (!verified) {
      shaped.code = status === 'CANCELLED' ? 'CANCELLED' : status === 'SUSPENDED' ? 'SUSPENDED' : 'INACTIVE';
      shaped.message = status === 'CANCELLED'
        ? 'This GSTIN is registered but has been cancelled.'
        : status === 'SUSPENDED'
          ? 'This GSTIN is registered but is currently suspended.'
          : 'This GSTIN is registered but currently inactive.';
    }
    return { ...shaped, formatValid: true, configured: true, cached: false };
  });

  /* Verification history for a GSTIN — used by the vendor screen to show
     who checked what, when. Read-only; the log itself is append-only. */
  router.get('/gst/history', async (ctx) => {
    requirePerm(ctx, MODULE.VENDOR, 'view');
    const gstin = normaliseGstin(ctx.query.gstin || '');
    if (!gstin) throw errors.validation('A GSTIN is required.');
    const rows = await ctx.env.DB.prepare(
      `select l.gstin, l.result, l.message, l.source, l.cached, l.created_at, u.full_name as by_name
       from gst_verification_log l left join users u on u.id = l.user_id
       where l.gstin = ? order by l.created_at desc limit 25`
    ).bind(gstin).all();
    return { history: rows.results };
  });
}
