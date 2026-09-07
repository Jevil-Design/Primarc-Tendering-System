-- ═══════════════════════════════════════════════════════════════
-- 020 · GSTIN verification — provider cache + audit trail
--
-- Two tables, deliberately keyed by GSTIN rather than by vendor:
-- a GSTIN is verified once with the provider and that answer is true for
-- every vendor carrying it, so caching per-GSTIN is what actually avoids
-- duplicate outbound calls (and duplicate spend) across the vendor master.
--
-- Note there is no `alter table vendors add column ...` here on purpose.
-- schema.sql is documented as "one idempotent dump" applied with
-- `turso db shell ... < backend/schema.sql`, and ADD COLUMN is not
-- idempotent — re-running would abort with "duplicate column name".
-- Vendor-facing verification state is therefore read by joining
-- gst_verifications on the vendor's GSTIN, which also means a vendor can
-- never drift out of sync with the provider answer it claims to have.
--
-- Provider credentials are never written to either table. `payload` holds
-- only the normalised, user-safe subset that the UI displays.
-- ═══════════════════════════════════════════════════════════════

create table if not exists gst_verifications (
  -- 15-char GSTIN, upper-cased and whitespace-stripped before it gets here
  gstin             text primary key,
  -- 1 only when the provider affirmatively confirmed the registration.
  -- Format/checksum validity alone must never set this.
  verified          integer not null default 0 check (verified in (0,1)),
  status            text,          -- ACTIVE | INACTIVE | CANCELLED | SUSPENDED | PROVISIONAL | NOT_FOUND
  legal_name        text,
  trade_name        text,
  pan               text,
  state             text,
  state_code        text,
  registration_date text,
  taxpayer_type     text,
  constitution      text,
  -- Normalised, display-safe JSON only. Never the raw provider envelope
  -- (which can echo request headers) and never credentials.
  payload           text not null default '{}',
  source            text not null, -- provider id, e.g. 'masters_india'
  verified_at       text not null,
  -- Cache horizon. A row past this is re-fetched rather than served.
  expires_at        text,
  created_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_gstv_expires on gst_verifications(expires_at);
create index if not exists idx_gstv_pan     on gst_verifications(pan);

-- Append-only attempt log: every verification attempt, successful or not.
-- Doubles as the source for per-user rate limiting, so an abusive caller
-- cannot both hammer the provider and leave no trace.
create table if not exists gst_verification_log (
  id          text primary key,
  gstin       text not null,
  -- verified | inactive | not_found | invalid_format | duplicate
  -- | provider_error | provider_timeout | provider_unconfigured
  -- | rate_limited | auth_failed | network_error | cached
  result      text not null,
  -- Operator-facing summary. Never a raw provider body or stack trace.
  message     text,
  source      text,
  vendor_id   text,
  user_id     text references users(id) on delete set null,
  cached      integer not null default 0 check (cached in (0,1)),
  duration_ms integer,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_gstlog_created on gst_verification_log(created_at desc);
create index if not exists idx_gstlog_user    on gst_verification_log(user_id, created_at desc);
create index if not exists idx_gstlog_gstin   on gst_verification_log(gstin, created_at desc);
