/* Small shared helpers. No dependencies — Workers have no node_modules at runtime. */

/** 32-char hex id. crypto.randomUUID is available in Workers. */
export const newId = () => crypto.randomUUID().replace(/-/g, '');

export const nowIso = () => new Date().toISOString();

/** Lower-case, punctuation-stripped, single-spaced. The duplicate-detection key. */
export const normalize = (s) =>
  (s == null ? '' : String(s)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const normalizeTight = (s) =>
  (s == null ? '' : String(s)).toLowerCase().replace(/[^a-z0-9]/g, '');

export const num = (v, d = 0) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : d;
};

export const bool01 = (v) => (v ? 1 : 0);

/** JSON columns are TEXT in SQLite; parse defensively. */
export const parseJson = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

/** Levenshtein-based similarity, 0..1. Used for near-miss vendor detection —
    D1 has no pg_trgm, so this runs in the Worker over a shortlist. */
export function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) / Math.max(m, n) > 0.5) return 0;   // cheap early out
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** Strips fields that must never leave the Worker. */
export function publicUser(row) {
  if (!row) return null;
  const { password_hash, ...safe } = row;
  return {
    ...safe,
    is_admin: !!row.is_admin,
    must_change_password: !!row.must_change_password,
    financial_limits: parseJson(row.financial_limits, {}),
  };
}

export const ipOf = (request) =>
  request.headers.get('CF-Connecting-IP') ||
  (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() || '';

export const uaOf = (request) => (request.headers.get('User-Agent') || '').slice(0, 250);

/** Sequential document numbers: ENQ/AAD/2026/001. */
export async function nextDocNo(db, scope, ref, year) {
  const y = year || new Date().getUTCFullYear();
  const r = (ref || 'GEN').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'GEN';
  // Single-statement upsert. D1 serialises writes, so two callers cannot be
  // handed the same serial.
  const row = await db
    .prepare(
      `insert into doc_sequences (scope, ref, year, last_value) values (?, ?, ?, 1)
       on conflict(scope, ref, year) do update set last_value = last_value + 1
       returning last_value`
    )
    .bind(scope, r, y)
    .first();
  const serial = String(row.last_value).padStart(3, '0');
  return `${scope}/${r}/${y}/${serial}`;
}
