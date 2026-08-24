-- ═══════════════════════════════════════════════════════════════
-- 005 · Vendor master (~949 contractors from vendor-master.js)
-- ═══════════════════════════════════════════════════════════════
create table if not exists vendors (
  id              text primary key,
  legacy_id       text unique,
  vendor_code     text unique,
  name            text not null,
  -- Lower-cased, punctuation-stripped, single-spaced. Written by the Worker
  -- (SQLite cannot express the regex in a generated column) and protected by
  -- the unique index below, so "ABC ENTERPRISE" and "ABC Enterprise" collide.
  name_normalized text not null,
  legal_name      text,
  skillset        text,
  phone           text,
  email           text,
  address         text,
  city            text,
  state           text,
  pincode         text,
  pan             text,
  gstin           text,
  contact_person  text,
  bank_details    text not null default '{}',
  rating          real,
  notes           text,
  logo_key        text,
  status          text not null default 'active' check (status in ('active','inactive','blacklisted')),
  created_by      text references users(id),
  updated_by      text references users(id),
  created_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at      text,
  deleted_by      text references users(id)
);

-- Partial unique index: a soft-deleted vendor must not block re-registering
-- the same name.
create unique index if not exists idx_vendors_norm_live
  on vendors(name_normalized) where deleted_at is null;
create index if not exists idx_vendors_name on vendors(name);
create index if not exists idx_vendors_phone on vendors(phone);
create index if not exists idx_vendors_pan on vendors(pan);
create index if not exists idx_vendors_gstin on vendors(gstin);
create index if not exists idx_vendors_skillset on vendors(skillset);
create index if not exists idx_vendors_status on vendors(status);
