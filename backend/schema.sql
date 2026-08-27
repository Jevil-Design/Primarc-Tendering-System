-- ═══════════════════════════════════════════════════════════════════════
-- Primarc Tendering System · Cloudflare D1 — COMPLETE SCHEMA
--
-- Single-file build of migrations 001–018. Apply with:
--     wrangler d1 execute primarc-tendering --remote --file=./schema.sql
-- or, for the local dev database:
--     wrangler d1 execute primarc-tendering --local  --file=./schema.sql
--
-- Every statement is idempotent (create ... if not exists / insert or ignore),
-- so re-running this file over an existing database is safe.
--
-- Dialect: SQLite. Ids are 32-char hex TEXT, timestamps are ISO-8601 UTC TEXT,
-- enumerations are CHECK constraints, updated_at is maintained by triggers.
-- ═══════════════════════════════════════════════════════════════════════

pragma foreign_keys = on;


-- ▓▓▓ migration 001_organisation.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 001 · Organisation: companies, branches, departments, designations
--
-- D1 is SQLite. Notes on the dialect choices used throughout:
--   · Ids are TEXT holding a 32-char hex value (crypto.randomUUID minus
--     dashes) — SQLite has no uuid type and TEXT keys index fine here.
--   · Enumerations are CHECK constraints, not enum types.
--   · Timestamps are TEXT in ISO-8601 UTC, which sorts lexicographically
--     and round-trips through JSON without a driver conversion.
--   · updated_at is maintained by triggers, as SQLite has no ON UPDATE.
-- ═══════════════════════════════════════════════════════════════

create table if not exists companies (
  id          text primary key,
  name        text not null,
  code        text not null unique,
  address     text,
  phone       text,
  email       text,
  gstin       text,
  pan         text,
  status      text not null default 'active' check (status in ('active','inactive')),
  legacy_id   text unique,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  text
);

create table if not exists branches (
  id          text primary key,
  company_id  text not null references companies(id) on delete restrict,
  name        text not null,
  code        text not null,
  address     text,
  city        text,
  status      text not null default 'active' check (status in ('active','inactive')),
  legacy_id   text unique,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  text,
  unique (company_id, code)
);

create table if not exists departments (
  id          text primary key,
  company_id  text references companies(id) on delete set null,
  name        text not null,
  code        text not null unique,
  description text,
  status      text not null default 'active' check (status in ('active','inactive')),
  legacy_id   text unique,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists designations (
  id              text primary key,
  department_id   text references departments(id) on delete set null,
  reports_to      text references designations(id) on delete set null,
  name            text not null unique,
  code            text,
  hierarchy_level integer not null default 9,
  -- JSON: {"quotation":n,"tender":n,"workorder":n,"purchase":n} in rupees
  financial_limits text not null default '{}',
  description     text,
  status          text not null default 'active' check (status in ('active','inactive')),
  legacy_id       text unique,
  created_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_branches_company on branches(company_id);
create index if not exists idx_desig_dept on designations(department_id);
create index if not exists idx_desig_reports on designations(reports_to);

create trigger if not exists tg_companies_updated after update on companies
begin update companies set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;
create trigger if not exists tg_branches_updated after update on branches
begin update branches set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;
create trigger if not exists tg_departments_updated after update on departments
begin update departments set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;
create trigger if not exists tg_designations_updated after update on designations
begin update designations set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

-- ▓▓▓ migration 002_auth.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 002 · Users and sessions
--
-- password_hash holds "pbkdf2$<iterations>$<salt_b64>$<hash_b64>".
-- PBKDF2-SHA256 via WebCrypto is used rather than bcrypt: Workers have no
-- native bindings, and a pure-JS bcrypt is both slow and CPU-time limited.
-- 210,000 iterations follows current OWASP guidance for PBKDF2-SHA256.
--
-- password_hash is never selected into an API response — see users.js.
-- ═══════════════════════════════════════════════════════════════

create table if not exists users (
  id             text primary key,
  username       text not null unique collate nocase,
  email          text unique collate nocase,
  password_hash  text not null,
  full_name      text not null default '',
  employee_id    text unique,
  phone          text,
  designation_id text references designations(id) on delete set null,
  department_id  text references departments(id)  on delete set null,
  company_id     text references companies(id)    on delete set null,
  branch_id      text references branches(id)     on delete set null,
  status         text not null default 'active' check (status in ('active','inactive','suspended')),
  is_admin       integer not null default 0 check (is_admin in (0,1)),
  must_change_password integer not null default 0 check (must_change_password in (0,1)),
  failed_attempts integer not null default 0,
  locked_until   text,
  password_changed_at text,
  password_set_by text not null default 'admin' check (password_set_by in ('self','admin')),
  last_login     text,
  legacy_id      text unique,
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at     text
);

-- Opaque session tokens. Only a SHA-256 of (token + pepper) is stored, so a
-- database dump cannot be replayed as a live session. Not a JWT: revoking a
-- user must take effect immediately, not at token expiry.
create table if not exists sessions (
  id           text primary key,
  token_hash   text not null unique,
  user_id      text not null references users(id) on delete cascade,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   text not null,
  absolute_expires_at text not null,
  ip           text,
  user_agent   text,
  revoked_at   text
);

create index if not exists idx_users_email on users(email);
create index if not exists idx_users_username on users(username);
create index if not exists idx_users_status on users(status);
create index if not exists idx_sessions_user on sessions(user_id);
create index if not exists idx_sessions_expiry on sessions(expires_at);

create trigger if not exists tg_users_updated after update on users
begin update users set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

-- ▓▓▓ migration 003_rbac.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 003 · RBAC: modules, designation permissions, per-user overrides
--
-- Effective permission = designation default, then user override where the
-- override column is NOT NULL. Resolved in permissions.js and enforced by the
-- Worker on every mutating route — hiding a button is not access control.
-- ═══════════════════════════════════════════════════════════════

create table if not exists modules (
  id            text primary key,
  code          text not null unique,
  name          text not null,
  display_order integer not null default 0,
  is_core       integer not null default 1 check (is_core in (0,1)),
  status        text not null default 'active' check (status in ('active','inactive')),
  legacy_id     text unique
);

create table if not exists permissions (
  id             text primary key,
  designation_id text not null references designations(id) on delete cascade,
  module_id      text not null references modules(id) on delete cascade,
  can_view    integer not null default 0,
  can_create  integer not null default 0,
  can_edit    integer not null default 0,
  can_delete  integer not null default 0,
  can_approve integer not null default 0,
  can_reject  integer not null default 0,
  can_import  integer not null default 0,
  can_export  integer not null default 0,
  can_print   integer not null default 0,
  can_lock    integer not null default 0,
  can_unlock  integer not null default 0,
  can_share   integer not null default 0,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (designation_id, module_id)
);

-- NULL on a column means "inherit the designation default".
create table if not exists user_permission_overrides (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  module_id  text not null references modules(id) on delete cascade,
  can_view integer, can_create integer, can_edit   integer, can_delete integer,
  can_approve integer, can_reject integer, can_import integer, can_export integer,
  can_print integer, can_lock   integer, can_unlock integer, can_share  integer,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (user_id, module_id)
);

create index if not exists idx_perm_desig on permissions(designation_id);
create index if not exists idx_upo_user on user_permission_overrides(user_id);

-- ▓▓▓ migration 004_projects.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 004 · Projects
-- ═══════════════════════════════════════════════════════════════
create table if not exists projects (
  id             text primary key,
  project_code   text not null unique,
  -- Short reference used inside ENQ/WO/PO numbers (AAD, RDB…). Distinct from
  -- project_code because the existing numbering scheme uses 3-letter refs.
  project_ref    text,
  project_name   text not null,
  client_name    text,
  location       text,
  address        text,
  project_type   text,
  start_date     text,
  completion_date text,
  status         text not null default 'active' check (status in ('active','inactive','completed','on_hold')),
  company_id     text references companies(id) on delete set null,
  branch_id      text references branches(id)  on delete set null,
  project_manager_id text references users(id) on delete set null,
  description    text,
  metadata       text not null default '{}',
  legacy_id      text unique,
  created_by     text references users(id),
  updated_by     text references users(id),
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at     text,
  deleted_by     text references users(id)
);

create index if not exists idx_projects_code on projects(project_code);
create unique index if not exists idx_projects_ref on projects(project_ref) where project_ref is not null and deleted_at is null;
create index if not exists idx_projects_company on projects(company_id);
create index if not exists idx_projects_status on projects(status);
create index if not exists idx_projects_created on projects(created_at desc);

create trigger if not exists tg_projects_updated after update on projects
begin update projects set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

-- Concurrency-safe document numbering. D1 serialises writes, and the UPSERT
-- below is a single statement, so two callers cannot be handed the same serial
-- the way the old client-side DB.seq[ref]++ could.
create table if not exists doc_sequences (
  scope      text not null,
  ref        text not null,
  year       integer not null,
  last_value integer not null default 0,
  primary key (scope, ref, year)
);

-- ▓▓▓ migration 005_vendors.sql ▓▓▓
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

create trigger if not exists tg_vendors_updated after update on vendors
begin update vendors set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

-- ▓▓▓ migration 006_materials.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 006 · Material master
-- ═══════════════════════════════════════════════════════════════
create table if not exists materials (
  id            text primary key,
  material_code text unique,
  name          text not null,
  name_normalized text not null,
  description   text,
  unit          text,
  category      text,
  subcategory   text,
  specification text,
  brand         text,
  default_rate  real,
  gst_percent   real not null default 18,
  status        text not null default 'active' check (status in ('active','inactive')),
  metadata      text not null default '{}',
  created_by    text references users(id),
  updated_by    text references users(id),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

create unique index if not exists idx_materials_norm
  on materials(name_normalized, coalesce(brand,'')) where deleted_at is null;
create index if not exists idx_materials_cat on materials(category, subcategory);

create trigger if not exists tg_materials_updated after update on materials
begin update materials set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

-- ▓▓▓ migration 007_boq_master.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 007 · BOQ master items + historical vendor rates
-- ═══════════════════════════════════════════════════════════════
create table if not exists boq_master_items (
  id            text primary key,
  legacy_id     text unique,
  item_code     text unique,
  short_name    text not null,
  short_name_normalized text not null,
  description   text,
  unit          text,
  category      text,
  subcategory   text,
  work_group    text,
  default_quantity real,
  default_rate  real,
  is_custom     integer not null default 1 check (is_custom in (0,1)),
  source        text not null default 'manual',   -- manual | import | history | ai
  is_codes      text not null default '[]',
  notes         text,
  status        text not null default 'active' check (status in ('active','inactive')),
  created_by    text references users(id),
  updated_by    text references users(id),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text
);

-- The same item name can legitimately exist under a different category, so the
-- key is (name, category). Uncertain matches are surfaced to the user rather
-- than merged automatically.
create unique index if not exists idx_boqmaster_norm
  on boq_master_items(short_name_normalized, coalesce(category,'')) where deleted_at is null;
create index if not exists idx_boqmaster_cat on boq_master_items(category, subcategory);
create index if not exists idx_boqmaster_unit on boq_master_items(unit);

-- Append-only rate history. A newer rate never replaces an older row.
create table if not exists boq_master_rates (
  id             text primary key,
  master_item_id text not null references boq_master_items(id) on delete cascade,
  vendor_id      text references vendors(id) on delete set null,
  vendor_name    text,
  project_id     text references projects(id) on delete set null,
  project_name   text,
  rate           real not null,
  unit           text,
  work_order_no  text,
  effective_date text,
  source         text not null default 'history',
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_bmr_item on boq_master_rates(master_item_id);
create index if not exists idx_bmr_vendor on boq_master_rates(vendor_id);
create index if not exists idx_bmr_project on boq_master_rates(project_id);
create index if not exists idx_bmr_date on boq_master_rates(effective_date desc);

create trigger if not exists tg_boqmaster_updated after update on boq_master_items
begin update boq_master_items set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

-- ▓▓▓ migration 008_boq.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 008 · BOQ documents and hierarchical BOQ lines
-- ═══════════════════════════════════════════════════════════════
create table if not exists boqs (
  id           text primary key,
  boq_number   text unique,
  project_id   text references projects(id) on delete set null,
  name         text,
  description  text,
  client_name  text,
  contractor_name text,
  work_order_no text,
  revision     integer not null default 0,
  status       text not null default 'draft'
               check (status in ('draft','pending_approval','approved','rejected','issued','closed','cancelled')),
  base_total   real not null default 0,
  gst_total    real not null default 0,
  total_amount real not null default 0,
  notes        text,
  metadata     text not null default '{}',
  legacy_id    text unique,
  created_by   text references users(id),
  updated_by   text references users(id),
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at   text,
  deleted_by   text references users(id)
);

-- Hierarchy is preserved through parent_id + level + display_order, matching
-- the existing section / item / note structure. It is never flattened.
create table if not exists boq_items (
  id             text primary key,
  boq_id         text not null references boqs(id) on delete cascade,
  parent_id      text references boq_items(id) on delete cascade,
  master_item_id text references boq_master_items(id) on delete set null,
  item_no        text,
  item_type      text not null default 'item' check (item_type in ('item','section','note','subtotal')),
  short_name     text,
  description    text,
  specification  text,
  unit           text,
  quantity       real not null default 0,
  rate           real not null default 0,
  -- Generated columns keep the arithmetic identical everywhere it is read.
  -- These mirror the existing client formulas exactly.
  amount         real generated always as (round(quantity * rate, 2)) stored,
  gst_percent    real not null default 0,
  gst_amount     real generated always as (round(quantity * rate * gst_percent / 100.0, 2)) stored,
  category       text,
  subcategory    text,
  level          integer not null default 0,
  remarks        text,
  display_order  integer not null default 0,
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_boqs_project on boqs(project_id);
create index if not exists idx_boqs_status on boqs(status);
create index if not exists idx_boqs_number on boqs(boq_number);
create index if not exists idx_boqitems_boq on boq_items(boq_id, display_order);
create index if not exists idx_boqitems_parent on boq_items(parent_id);
create index if not exists idx_boqitems_master on boq_items(master_item_id);

create trigger if not exists tg_boqs_updated after update on boqs
begin update boqs set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

-- Roll line changes up into the parent document. Three triggers because
-- SQLite has no "after insert or update or delete" form.
create trigger if not exists tg_boqitems_ins after insert on boq_items
begin
  update boqs set
    base_total   = (select coalesce(sum(amount),0)     from boq_items where boq_id = new.boq_id and item_type='item'),
    gst_total    = (select coalesce(sum(gst_amount),0) from boq_items where boq_id = new.boq_id and item_type='item'),
    total_amount = (select coalesce(sum(amount),0) + coalesce(sum(gst_amount),0)
                    from boq_items where boq_id = new.boq_id and item_type='item')
  where id = new.boq_id;
end;

create trigger if not exists tg_boqitems_upd after update on boq_items
begin
  update boqs set
    base_total   = (select coalesce(sum(amount),0)     from boq_items where boq_id = new.boq_id and item_type='item'),
    gst_total    = (select coalesce(sum(gst_amount),0) from boq_items where boq_id = new.boq_id and item_type='item'),
    total_amount = (select coalesce(sum(amount),0) + coalesce(sum(gst_amount),0)
                    from boq_items where boq_id = new.boq_id and item_type='item')
  where id = new.boq_id;
end;

create trigger if not exists tg_boqitems_del after delete on boq_items
begin
  update boqs set
    base_total   = (select coalesce(sum(amount),0)     from boq_items where boq_id = old.boq_id and item_type='item'),
    gst_total    = (select coalesce(sum(gst_amount),0) from boq_items where boq_id = old.boq_id and item_type='item'),
    total_amount = (select coalesce(sum(amount),0) + coalesce(sum(gst_amount),0)
                    from boq_items where boq_id = old.boq_id and item_type='item')
  where id = old.boq_id;
end;

-- Per-user working draft (replaces boq_autosave_v3). One row per user, so an
-- in-progress BOQ survives a refresh, a different device, and a crash.
create table if not exists boq_drafts (
  user_id    text primary key references users(id) on delete cascade,
  payload    text not null,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ▓▓▓ migration 009_rate_analysis.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 009 · Rate analysis
-- ═══════════════════════════════════════════════════════════════
create table if not exists rate_analyses (
  id           text primary key,
  boq_item_id  text references boq_items(id) on delete set null,
  project_id   text references projects(id) on delete set null,
  name         text,
  description  text,
  unit         text,
  wastage_percent real not null default 0,
  profit_percent  real not null default 0,
  material_cost   real not null default 0,
  labour_cost     real not null default 0,
  equipment_cost  real not null default 0,
  subcontract_cost real not null default 0,
  overhead_cost   real not null default 0,
  total_rate   real not null default 0,
  final_rate   real not null default 0,
  assumptions  text not null default '{}',
  status       text not null default 'draft',
  created_by   text references users(id),
  updated_by   text references users(id),
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at   text
);

create table if not exists rate_analysis_components (
  id               text primary key,
  rate_analysis_id text not null references rate_analyses(id) on delete cascade,
  component_type   text not null check (component_type in ('material','labour','equipment','subcontract','overhead')),
  material_id      text references materials(id) on delete set null,
  supplier_vendor_id text references vendors(id) on delete set null,
  description      text,
  unit             text,
  quantity         real not null default 0,
  rate             real not null default 0,
  amount           real generated always as (round(quantity * rate, 2)) stored,
  percentage       real,
  remarks          text,
  created_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_ra_item on rate_analyses(boq_item_id);
create index if not exists idx_rac_parent on rate_analysis_components(rate_analysis_id);

create trigger if not exists tg_ra_updated after update on rate_analyses
begin update rate_analyses set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

-- ▓▓▓ migration 010_enquiries.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 010 · Enquiries, enquiry items, invited vendors
-- ═══════════════════════════════════════════════════════════════
create table if not exists enquiries (
  id           text primary key,
  enquiry_no   text not null unique,
  project_id   text references projects(id) on delete set null,
  boq_id       text references boqs(id) on delete set null,
  project_name text,
  reference_code text,
  client_name  text,
  title        text,
  description  text,
  issue_date   text,
  submission_deadline text,
  validity     text,
  status       text not null default 'draft'
               check (status in ('draft','sent','partial','received','under_review','approved','rejected','cancelled','expired')),
  revision     integer not null default 0,
  notes        text,
  terms        text not null default '{}',
  legacy_id    text unique,
  created_by   text references users(id),
  updated_by   text references users(id),
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at   text,
  deleted_by   text references users(id)
);

create table if not exists enquiry_items (
  id           text primary key,
  enquiry_id   text not null references enquiries(id) on delete cascade,
  boq_item_id  text references boq_items(id) on delete set null,
  master_item_id text references boq_master_items(id) on delete set null,
  item_no      integer not null default 0,
  item_type    text not null default 'item' check (item_type in ('item','section','note')),
  level        integer not null default 0,
  short_name   text,
  description  text,
  category     text,
  subcategory  text,
  unit         text,
  quantity     real not null default 0,
  remarks      text,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (enquiry_id, item_no)
);

create table if not exists enquiry_vendors (
  id            text primary key,
  enquiry_id    text not null references enquiries(id) on delete cascade,
  vendor_id     text references vendors(id) on delete set null,
  vendor_name   text,
  vendor_number integer not null default 1,
  -- Only the SHA-256 of the portal token is stored. The raw token exists once,
  -- in the link handed to the vendor, and is never recoverable from the DB.
  access_token_hash text unique,
  token_expires_at  text,
  invitation_status text not null default 'pending'
    check (invitation_status in ('pending','sent','opened','draft','submitted','revised','locked','declined','expired')),
  revision      integer not null default 0,
  invited_at    text,
  viewed_at     text,
  submitted_at  text,
  locked_at     text,
  device        text,
  browser       text,
  base_amount   real not null default 0,
  gst_amount    real not null default 0,
  total_amount  real not null default 0,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  unique (enquiry_id, vendor_number)
);

create index if not exists idx_enq_no on enquiries(enquiry_no);
create index if not exists idx_enq_project on enquiries(project_id);
create index if not exists idx_enq_status on enquiries(status);
create index if not exists idx_enq_created on enquiries(created_at desc);
create index if not exists idx_enqitems_enq on enquiry_items(enquiry_id, item_no);
create index if not exists idx_ev_enq on enquiry_vendors(enquiry_id);
create index if not exists idx_ev_vendor on enquiry_vendors(vendor_id);
create index if not exists idx_ev_token on enquiry_vendors(access_token_hash);

create trigger if not exists tg_enq_updated after update on enquiries
begin update enquiries set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

-- ▓▓▓ migration 011_quotations.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 011 · Vendor quotation lines, commercial terms, immutable revisions
-- ═══════════════════════════════════════════════════════════════
create table if not exists vendor_quote_lines (
  id                text primary key,
  enquiry_vendor_id text not null references enquiry_vendors(id) on delete cascade,
  enquiry_item_id   text not null references enquiry_items(id) on delete cascade,
  quantity     real not null default 0,
  rate         real not null default 0,
  amount       real generated always as (round(quantity * rate, 2)) stored,
  gst_percent  real not null default 0,
  gst_amount   real generated always as (round(quantity * rate * gst_percent / 100.0, 2)) stored,
  total_amount real generated always as
    (round(quantity * rate, 2) + round(quantity * rate * gst_percent / 100.0, 2)) stored,
  remarks      text,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (enquiry_vendor_id, enquiry_item_id)
);

create table if not exists vendor_quote_terms (
  id                text primary key,
  enquiry_vendor_id text not null unique references enquiry_vendors(id) on delete cascade,
  payment_terms      text,
  credit_period      text,
  delivery_period    text,
  delivery_schedule  text,
  material_base_rate text,
  warranty           text,
  validity           text,
  escalation         text,
  gst_inclusion      text,
  exclusions         text,
  other_terms        text,
  custom_terms       text not null default '{}',
  remarks            text,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Append-only. A locked quotation is never overwritten; revising writes a new
-- row here and the previous snapshot stays exactly as submitted.
create table if not exists vendor_quote_revisions (
  id                text primary key,
  enquiry_vendor_id text not null references enquiry_vendors(id) on delete cascade,
  revision_no  integer not null,
  submitted_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  submitted_by text,
  base_amount  real not null default 0,
  gst_amount   real not null default 0,
  total_amount real not null default 0,
  snapshot_json text not null default '{}',
  status       text not null default 'submitted',
  remarks      text,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (enquiry_vendor_id, revision_no)
);

create index if not exists idx_vql_ev on vendor_quote_lines(enquiry_vendor_id);
create index if not exists idx_vql_item on vendor_quote_lines(enquiry_item_id);
create index if not exists idx_vqr_ev on vendor_quote_revisions(enquiry_vendor_id, revision_no desc);

create trigger if not exists tg_vql_updated after update on vendor_quote_lines
begin update vendor_quote_lines set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

-- Vendor header totals follow their lines.
create trigger if not exists tg_vql_tot_ins after insert on vendor_quote_lines
begin
  update enquiry_vendors set
    base_amount  = (select coalesce(sum(amount),0)     from vendor_quote_lines where enquiry_vendor_id = new.enquiry_vendor_id),
    gst_amount   = (select coalesce(sum(gst_amount),0) from vendor_quote_lines where enquiry_vendor_id = new.enquiry_vendor_id),
    total_amount = (select coalesce(sum(total_amount),0) from vendor_quote_lines where enquiry_vendor_id = new.enquiry_vendor_id)
  where id = new.enquiry_vendor_id;
end;

create trigger if not exists tg_vql_tot_upd after update on vendor_quote_lines
begin
  update enquiry_vendors set
    base_amount  = (select coalesce(sum(amount),0)     from vendor_quote_lines where enquiry_vendor_id = new.enquiry_vendor_id),
    gst_amount   = (select coalesce(sum(gst_amount),0) from vendor_quote_lines where enquiry_vendor_id = new.enquiry_vendor_id),
    total_amount = (select coalesce(sum(total_amount),0) from vendor_quote_lines where enquiry_vendor_id = new.enquiry_vendor_id)
  where id = new.enquiry_vendor_id;
end;

create trigger if not exists tg_vql_tot_del after delete on vendor_quote_lines
begin
  update enquiry_vendors set
    base_amount  = (select coalesce(sum(amount),0)     from vendor_quote_lines where enquiry_vendor_id = old.enquiry_vendor_id),
    gst_amount   = (select coalesce(sum(gst_amount),0) from vendor_quote_lines where enquiry_vendor_id = old.enquiry_vendor_id),
    total_amount = (select coalesce(sum(total_amount),0) from vendor_quote_lines where enquiry_vendor_id = old.enquiry_vendor_id)
  where id = old.enquiry_vendor_id;
end;

-- ▓▓▓ migration 012_comparison.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 012 · Comparison views
--
-- Ranking lives in the database so the comparison sheet, the exports and bid
-- analysis cannot drift apart. SQLite supports window functions (3.25+), so
-- the same ROW_NUMBER() logic as the Postgres version applies.
--
-- Only vendors that actually quoted (rate > 0) are ranked, matching the
-- existing itemRank() / vendorRank() behaviour. Ties break on vendor name so
-- the ordering is stable between reloads.
-- ═══════════════════════════════════════════════════════════════

create view if not exists vendor_comparison_view as
select
  e.id                as enquiry_id,
  ei.id               as enquiry_item_id,
  ei.item_no,
  ei.short_name,
  ei.description,
  ei.unit,
  ei.quantity,
  ev.id               as enquiry_vendor_id,
  ev.vendor_id,
  coalesce(v.name, ev.vendor_name) as vendor_name,
  vql.rate,
  vql.amount,
  vql.gst_percent,
  vql.gst_amount,
  vql.total_amount,
  row_number() over (
    partition by ei.id
    order by vql.amount asc, coalesce(v.name, ev.vendor_name) asc
  ) as rank
from enquiry_items ei
join enquiries e            on e.id = ei.enquiry_id and e.deleted_at is null
join vendor_quote_lines vql on vql.enquiry_item_id = ei.id
join enquiry_vendors ev     on ev.id = vql.enquiry_vendor_id and ev.deleted_at is null
left join vendors v         on v.id = ev.vendor_id
where vql.rate > 0 and ei.item_type = 'item';

create view if not exists vendor_total_ranking_view as
select
  ev.enquiry_id,
  ev.id as enquiry_vendor_id,
  ev.vendor_id,
  coalesce(v.name, ev.vendor_name) as vendor_name,
  ev.invitation_status,
  ev.revision,
  ev.base_amount,
  ev.gst_amount,
  ev.total_amount,
  (select count(*) from vendor_quote_lines l where l.enquiry_vendor_id = ev.id and l.rate > 0) as items_quoted,
  row_number() over (
    partition by ev.enquiry_id
    order by ev.base_amount asc, coalesce(v.name, ev.vendor_name) asc
  ) as rank
from enquiry_vendors ev
left join vendors v on v.id = ev.vendor_id
where ev.deleted_at is null and ev.base_amount > 0;

-- ▓▓▓ migration 013_work_orders.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 013 · Bid analysis and work orders
-- ═══════════════════════════════════════════════════════════════
create table if not exists bid_analysis (
  id            text primary key,
  enquiry_id    text not null references enquiries(id) on delete cascade,
  vendor_id     text references vendors(id) on delete set null,
  enquiry_vendor_id text references enquiry_vendors(id) on delete set null,
  rank          integer,
  quoted_amount real not null default 0,
  gst_amount    real not null default 0,
  total_amount  real not null default 0,
  recommendation text,
  reasoning     text,
  risk_notes    text,
  savings_opportunity real,
  analysis      text not null default '{}',
  -- AI output is advisory only. It is never applied to a commercial decision
  -- without an explicit human acceptance, recorded here.
  is_ai_generated integer not null default 0 check (is_ai_generated in (0,1)),
  accepted_by   text references users(id),
  accepted_at   text,
  remarks       text,
  created_by    text references users(id),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists work_orders (
  id            text primary key,
  work_order_no text not null unique,
  project_id    text references projects(id) on delete set null,
  enquiry_id    text references enquiries(id) on delete set null,
  vendor_id     text references vendors(id) on delete set null,
  bid_analysis_id text references bid_analysis(id) on delete set null,
  vendor_name   text,
  project_name  text,
  project_reference text,
  issue_date    text,
  amount        real not null default 0,
  gst_amount    real not null default 0,
  total_amount  real not null default 0,
  payment_terms text,
  delivery_terms text,
  terms         text not null default '{}',
  status        text not null default 'draft'
                check (status in ('draft','pending_approval','approved','rejected','issued','closed','cancelled')),
  approved_by   text references users(id),
  approved_at   text,
  legacy_id     text unique,
  created_by    text references users(id),
  updated_by    text references users(id),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  deleted_by    text references users(id)
);

create table if not exists work_order_items (
  id            text primary key,
  work_order_id text not null references work_orders(id) on delete cascade,
  boq_item_id   text references boq_items(id) on delete set null,
  enquiry_item_id text references enquiry_items(id) on delete set null,
  line_no       integer not null default 0,
  description   text,
  unit          text,
  quantity      real not null default 0,
  rate          real not null default 0,
  amount        real generated always as (round(quantity * rate, 2)) stored,
  gst_percent   real not null default 0,
  gst_amount    real generated always as (round(quantity * rate * gst_percent / 100.0, 2)) stored,
  remarks       text,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_bid_enq on bid_analysis(enquiry_id);
create index if not exists idx_wo_no on work_orders(work_order_no);
create index if not exists idx_wo_project on work_orders(project_id);
create index if not exists idx_wo_vendor on work_orders(vendor_id);
create index if not exists idx_wo_enq on work_orders(enquiry_id);
create index if not exists idx_wo_status on work_orders(status);
create index if not exists idx_woi_wo on work_order_items(work_order_id, line_no);

create trigger if not exists tg_wo_updated after update on work_orders
begin update work_orders set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

create trigger if not exists tg_woi_tot_ins after insert on work_order_items
begin
  update work_orders set
    amount       = (select coalesce(sum(amount),0)     from work_order_items where work_order_id = new.work_order_id),
    gst_amount   = (select coalesce(sum(gst_amount),0) from work_order_items where work_order_id = new.work_order_id),
    total_amount = (select coalesce(sum(amount),0) + coalesce(sum(gst_amount),0)
                    from work_order_items where work_order_id = new.work_order_id)
  where id = new.work_order_id;
end;

create trigger if not exists tg_woi_tot_upd after update on work_order_items
begin
  update work_orders set
    amount       = (select coalesce(sum(amount),0)     from work_order_items where work_order_id = new.work_order_id),
    gst_amount   = (select coalesce(sum(gst_amount),0) from work_order_items where work_order_id = new.work_order_id),
    total_amount = (select coalesce(sum(amount),0) + coalesce(sum(gst_amount),0)
                    from work_order_items where work_order_id = new.work_order_id)
  where id = new.work_order_id;
end;

create trigger if not exists tg_woi_tot_del after delete on work_order_items
begin
  update work_orders set
    amount       = (select coalesce(sum(amount),0)     from work_order_items where work_order_id = old.work_order_id),
    gst_amount   = (select coalesce(sum(gst_amount),0) from work_order_items where work_order_id = old.work_order_id),
    total_amount = (select coalesce(sum(amount),0) + coalesce(sum(gst_amount),0)
                    from work_order_items where work_order_id = old.work_order_id)
  where id = old.work_order_id;
end;

-- ▓▓▓ migration 014_purchase_orders.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 014 · Purchase orders
-- ═══════════════════════════════════════════════════════════════
create table if not exists purchase_orders (
  id            text primary key,
  po_number     text not null unique,
  project_id    text references projects(id) on delete set null,
  vendor_id     text references vendors(id) on delete set null,
  work_order_id text references work_orders(id) on delete set null,
  po_date       text,
  delivery_date text,
  amount        real not null default 0,
  gst_amount    real not null default 0,
  total_amount  real not null default 0,
  terms         text not null default '{}',
  status        text not null default 'draft'
                check (status in ('draft','pending_approval','approved','rejected','issued','closed','cancelled')),
  approved_by   text references users(id),
  approved_at   text,
  legacy_id     text unique,
  created_by    text references users(id),
  updated_by    text references users(id),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    text,
  deleted_by    text references users(id)
);

create table if not exists purchase_order_items (
  id                text primary key,
  purchase_order_id text not null references purchase_orders(id) on delete cascade,
  material_id       text references materials(id) on delete set null,
  line_no      integer not null default 0,
  description  text,
  unit         text,
  quantity     real not null default 0,
  rate         real not null default 0,
  amount       real generated always as (round(quantity * rate, 2)) stored,
  gst_percent  real not null default 0,
  gst_amount   real generated always as (round(quantity * rate * gst_percent / 100.0, 2)) stored,
  remarks      text,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_po_number on purchase_orders(po_number);
create index if not exists idx_po_project on purchase_orders(project_id);
create index if not exists idx_po_vendor on purchase_orders(vendor_id);
create index if not exists idx_po_status on purchase_orders(status);
create index if not exists idx_poi_po on purchase_order_items(purchase_order_id, line_no);

create trigger if not exists tg_po_updated after update on purchase_orders
begin update purchase_orders set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id; end;

create trigger if not exists tg_poi_tot_ins after insert on purchase_order_items
begin
  update purchase_orders set
    amount       = (select coalesce(sum(amount),0)     from purchase_order_items where purchase_order_id = new.purchase_order_id),
    gst_amount   = (select coalesce(sum(gst_amount),0) from purchase_order_items where purchase_order_id = new.purchase_order_id),
    total_amount = (select coalesce(sum(amount),0) + coalesce(sum(gst_amount),0)
                    from purchase_order_items where purchase_order_id = new.purchase_order_id)
  where id = new.purchase_order_id;
end;

create trigger if not exists tg_poi_tot_upd after update on purchase_order_items
begin
  update purchase_orders set
    amount       = (select coalesce(sum(amount),0)     from purchase_order_items where purchase_order_id = new.purchase_order_id),
    gst_amount   = (select coalesce(sum(gst_amount),0) from purchase_order_items where purchase_order_id = new.purchase_order_id),
    total_amount = (select coalesce(sum(amount),0) + coalesce(sum(gst_amount),0)
                    from purchase_order_items where purchase_order_id = new.purchase_order_id)
  where id = new.purchase_order_id;
end;

create trigger if not exists tg_poi_tot_del after delete on purchase_order_items
begin
  update purchase_orders set
    amount       = (select coalesce(sum(amount),0)     from purchase_order_items where purchase_order_id = old.purchase_order_id),
    gst_amount   = (select coalesce(sum(gst_amount),0) from purchase_order_items where purchase_order_id = old.purchase_order_id),
    total_amount = (select coalesce(sum(amount),0) + coalesce(sum(gst_amount),0)
                    from purchase_order_items where purchase_order_id = old.purchase_order_id)
  where id = old.purchase_order_id;
end;

-- ▓▓▓ migration 015_notifications.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 015 · Notifications and documents (R2 metadata)
-- ═══════════════════════════════════════════════════════════════
create table if not exists notifications (
  id             text primary key,
  user_id        text not null references users(id) on delete cascade,
  title          text not null,
  message        text,
  type           text not null default 'info',
  reference_type text,
  reference_id   text,
  link           text,
  is_read        integer not null default 0 check (is_read in (0,1)),
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_notif_user on notifications(user_id, is_read, created_at desc);
create index if not exists idx_notif_created on notifications(created_at desc);

-- Metadata only. The bytes live in R2 under file_key; D1 rows stay small.
create table if not exists documents (
  id           text primary key,
  owner_type   text not null,   -- vendor | boq | enquiry | quotation | work_order | purchase_order | vendor_logo
  owner_id     text,
  file_name    text not null,
  file_key     text not null unique,
  content_type text,
  file_size    integer,
  bucket       text not null default 'primarc-tendering-documents',
  uploaded_by  text references users(id),
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at   text
);

create index if not exists idx_documents_owner on documents(owner_type, owner_id);

-- ▓▓▓ migration 016_audit.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 016 · Audit log — append only
--
-- There is no UPDATE or DELETE path to this table anywhere in the Worker.
-- user_name is denormalised on purpose so the trail survives user deletion.
-- ═══════════════════════════════════════════════════════════════
create table if not exists audit_logs (
  id          text primary key,
  user_id     text references users(id) on delete set null,
  user_name   text,
  action      text not null,
  module      text,
  entity_type text,
  entity_id   text,
  target      text,
  old_value   text,
  new_value   text,
  reason      text,
  ip_address  text,
  user_agent  text,
  browser     text,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_audit_user on audit_logs(user_id, created_at desc);
create index if not exists idx_audit_entity on audit_logs(entity_type, entity_id);
create index if not exists idx_audit_module on audit_logs(module, created_at desc);
create index if not exists idx_audit_created on audit_logs(created_at desc);
create index if not exists idx_audit_action on audit_logs(action);

-- ▓▓▓ migration 017_workflows.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 017 · Approval workflows, system policy and settings
-- ═══════════════════════════════════════════════════════════════
create table if not exists workflows (
  id          text primary key,
  name        text not null,
  module      text not null,
  description text,
  status      text not null default 'active' check (status in ('active','inactive')),
  legacy_id   text unique,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists workflow_steps (
  id             text primary key,
  workflow_id    text not null references workflows(id) on delete cascade,
  step_no        integer not null,
  name           text not null,
  designation_id text references designations(id) on delete set null,
  approval_limit real,
  required       integer not null default 1 check (required in (0,1)),
  status         text not null default 'active',
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (workflow_id, step_no)
);

create table if not exists workflow_actions (
  id               text primary key,
  workflow_step_id text references workflow_steps(id) on delete cascade,
  entity_type text not null,
  entity_id   text not null,
  user_id     text references users(id) on delete set null,
  action      text not null,      -- approved | rejected | returned
  remarks     text,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists system_policy (
  id integer primary key check (id = 1),
  password_min_length     integer not null default 8,
  password_complexity     text not null default 'medium',
  password_expiry_days    integer not null default 90,
  password_history        integer not null default 3,
  must_change_first_login integer not null default 1,
  lock_after_attempts     integer not null default 5,
  idle_lock_days          integer not null default 30,
  session_timeout_minutes integer not null default 30,
  concurrent_session_mode text not null default 'allow',
  concurrent_session_max  integer not null default 3,
  two_factor_enabled      integer not null default 0,
  remember_me             integer not null default 1,
  ip_mode                 text not null default 'any',
  allowed_ip_list         text not null default '[]',
  schedule_enabled        integer not null default 0,
  schedule_days           text not null default '[]',
  schedule_from           text,
  schedule_to             text,
  license_total           integer,
  license_expiry          text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Non-sensitive configuration only. Secrets belong in Worker secrets.
create table if not exists system_settings (
  id            text primary key,
  setting_key   text not null unique,
  setting_value text not null default '{}',
  updated_by    text references users(id),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_wfsteps_wf on workflow_steps(workflow_id, step_no);
create index if not exists idx_wfactions_entity on workflow_actions(entity_type, entity_id, created_at desc);

insert or ignore into system_policy (id) values (1);

-- ▓▓▓ migration 018_seed.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 018 · Seed data
--
-- Reference data only. NO administrator password is seeded — shipping a known
-- credential is exactly the hole this backend exists to close. Create the first
-- admin through POST /api/auth/bootstrap, guarded by the BOOTSTRAP_TOKEN secret.
--
-- Ids are deterministic so re-running this file updates rather than duplicates.
-- ═══════════════════════════════════════════════════════════════

-- companies
insert into companies (id,legacy_id,name,code,gstin) values ('2841bdc81ee80f54636f5f7070000000','co_pp','Primarc Projects Pvt Ltd','PPPL','19AABCP1234A1Z5')
  on conflict(id) do update set name=excluded.name, code=excluded.code, gstin=excluded.gstin;
insert into companies (id,legacy_id,name,code,gstin) values ('2b41c281a23de8a3636f5f7073000000','co_ps','Primarc Spaces','PSPC','19AABCP5678B1Z2')
  on conflict(id) do update set name=excluded.name, code=excluded.code, gstin=excluded.gstin;

-- branches
insert into branches (id,legacy_id,company_id,name,code,city) values ('dd908904b2fa58d062725f6b6f6c0000','br_kol','2841bdc81ee80f54636f5f7070000000','Kolkata — Head Office','KOL','Kolkata')
  on conflict(id) do update set name=excluded.name, city=excluded.city;
insert into branches (id,legacy_id,company_id,name,code,city) values ('25b4c55b49ec8e9162725f6d756d0000','br_mum','2841bdc81ee80f54636f5f7070000000','Mumbai','MUM','Mumbai')
  on conflict(id) do update set name=excluded.name, city=excluded.city;
insert into branches (id,legacy_id,company_id,name,code,city) values ('ee0dc5ce49aa566062725f626c720000','br_blr','2b41c281a23de8a3636f5f7073000000','Bengaluru','BLR','Bengaluru')
  on conflict(id) do update set name=excluded.name, city=excluded.city;
insert into branches (id,legacy_id,company_id,name,code,city) values ('e799ec9930fec83f62725f70756e0000','br_pun','2b41c281a23de8a3636f5f7073000000','Pune','PUN','Pune')
  on conflict(id) do update set name=excluded.name, city=excluded.city;

-- departments
insert into departments (id,legacy_id,name,code) values ('533d6c7e2b0aaca264705f6d67740000','dp_mgt','Management','MGT')
  on conflict(id) do update set name=excluded.name, code=excluded.code;
insert into departments (id,legacy_id,name,code) values ('435ab58ed46ce23864705f61646d0000','dp_adm','Administration','ADM')
  on conflict(id) do update set name=excluded.name, code=excluded.code;
insert into departments (id,legacy_id,name,code) values ('7d8330475da1042164705f7173630000','dp_qsc','QS & Contracts','QSC')
  on conflict(id) do update set name=excluded.name, code=excluded.code;
insert into departments (id,legacy_id,name,code) values ('03cb7e502c4863fa64705f706c6e0000','dp_pln','Planning','PLN')
  on conflict(id) do update set name=excluded.name, code=excluded.code;
insert into departments (id,legacy_id,name,code) values ('f9e134e12c56abe764705f7075720000','dp_pur','Purchase','PUR')
  on conflict(id) do update set name=excluded.name, code=excluded.code;
insert into departments (id,legacy_id,name,code) values ('4d5276873ec1fc6164705f6163630000','dp_acc','Accounts','ACC')
  on conflict(id) do update set name=excluded.name, code=excluded.code;
insert into departments (id,legacy_id,name,code) values ('ed99bb360230513064705f6578650000','dp_exe','Execution','EXE')
  on conflict(id) do update set name=excluded.name, code=excluded.code;
insert into departments (id,legacy_id,name,code) values ('07e389827b144c5064705f70726a0000','dp_prj','Projects','PRJ')
  on conflict(id) do update set name=excluded.name, code=excluded.code;
insert into departments (id,legacy_id,name,code) values ('fcbf0d34ed18cf7264705f6872000000','dp_hr','HR','HR')
  on conflict(id) do update set name=excluded.name, code=excluded.code;
insert into departments (id,legacy_id,name,code) values ('855b2795ba09e36964705f7374720000','dp_str','Store','STR')
  on conflict(id) do update set name=excluded.name, code=excluded.code;
insert into departments (id,legacy_id,name,code) values ('6c9d590151db1a5d64705f716c740000','dp_qlt','Quality','QLT')
  on conflict(id) do update set name=excluded.name, code=excluded.code;
insert into departments (id,legacy_id,name,code) values ('937dcfe1aecf29dd64705f7366740000','dp_sft','Safety','SFT')
  on conflict(id) do update set name=excluded.name, code=excluded.code;

-- modules
insert into modules (id,legacy_id,name,code,display_order) values ('9f0e65fb34dc24956d5f64617368626f','m_dashboard','Dashboard','dashboard',0)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('cdd65157946dc9a36d5f70726f6a6563','m_projects','Projects','projects',1)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('7c89dbdb3aea1b496d5f626f716d6173','m_boqmaster','BOQ Master','boqmaster',2)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('3da2dfac7cc898c06d5f626f71637265','m_boqcreation','BOQ Creation','boqcreation',3)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('373896495a4803556d5f72617465616e','m_rateanalysis','Rate Analysis','rateanalysis',4)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('27f0c3faa68d29c46d5f656e71756972','m_enquiry','Enquiry','enquiry',5)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('a21ee087693655a56d5f74656e646572','m_tender','Tender','tender',6)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('4c64f6f35ac0452d6d5f76656e646f72','m_vendor','Vendor','vendor',7)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('897f8de4d6676bcc6d5f636f6d706172','m_comparison','Comparison','comparison',8)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('b2bca8186c8d83ee6d5f776f726b6f72','m_workorder','Work Order','workorder',9)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('ca272fbad94efa046d5f707572636861','m_purchaseorder','Purchase Order','purchaseorder',10)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('f6fe5e668e01f87a6d5f6d6174657269','m_materialmaster','Material Master','materialmaster',11)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('1d9fbc681b2e7c606d5f7265706f7274','m_reports','Reports','reports',12)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('df88686f34fd712b6d5f61646d696e69','m_administration','Administration','administration',13)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;
insert into modules (id,legacy_id,name,code,display_order) values ('b3de33a806e7f1006d5f73657474696e','m_settings','Settings','settings',14)
  on conflict(id) do update set name=excluded.name, code=excluded.code, display_order=excluded.display_order;

-- designations (reports_to resolved in a second pass below)
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('cb32d745410b66b764675f6469726563','dg_director','Director','533d6c7e2b0aaca264705f6d67740000',1,'{"quotation":1000000000,"tender":1000000000,"workorder":1000000000,"purchase":1000000000}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('5fe51095dd7d8d4164675f676d000000','dg_gm','General Manager','533d6c7e2b0aaca264705f6d67740000',2,'{"quotation":50000000,"tender":100000000,"workorder":150000000,"purchase":100000000}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('f5acc0c139ea95d564675f7379736164','dg_sysadmin','System Administrator','435ab58ed46ce23864705f61646d0000',2,'{"quotation":0,"tender":0,"workorder":0,"purchase":0}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('3fb102d27d970d3664675f706d000000','dg_pm','Project Manager','07e389827b144c5064705f70726a0000',3,'{"quotation":10000000,"tender":25000000,"workorder":50000000,"purchase":20000000}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('3fdbe3d98de5857d64675f636d000000','dg_cm','Commercial Manager','7d8330475da1042164705f7173630000',4,'{"quotation":2500000,"tender":10000000,"workorder":2500000,"purchase":10000000}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('43f884cf2cdd669564675f7075726d00','dg_purm','Purchase Manager','f9e134e12c56abe764705f7075720000',4,'{"quotation":0,"tender":0,"workorder":10000000,"purchase":20000000}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('276a1d4113ed5b7364675f6163636d00','dg_accm','Accounts Manager','4d5276873ec1fc6164705f6163630000',4,'{"quotation":0,"tender":0,"workorder":0,"purchase":5000000}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('496d656a2606f0d064675f68726d0000','dg_hrm','HR Manager','fcbf0d34ed18cf7264705f6872000000',4,'{"quotation":0,"tender":0,"workorder":0,"purchase":500000}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('6974ad0aab229b6264675f7371730000','dg_sqs','Senior QS','7d8330475da1042164705f7173630000',5,'{"quotation":1000000,"tender":0,"workorder":0,"purchase":0}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('5a8c4b862c24939c64675f706c616e00','dg_plan','Planning Engineer','03cb7e502c4863fa64705f706c6e0000',5,'{"quotation":0,"tender":0,"workorder":0,"purchase":0}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('51aee091a2052d3164675f7173000000','dg_qs','QS Engineer','7d8330475da1042164705f7173630000',6,'{"quotation":500000,"tender":0,"workorder":0,"purchase":0}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('633e131ef24ca4c464675f7065786563','dg_pexec','Purchase Executive','f9e134e12c56abe764705f7075720000',6,'{"quotation":0,"tender":0,"workorder":0,"purchase":250000}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('eab1a2e2ce4b7a7c64675f7369746500','dg_site','Site Engineer','ed99bb360230513064705f6578650000',6,'{"quotation":0,"tender":0,"workorder":0,"purchase":0}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('8190fd52cfaebcc864675f73746f7265','dg_store','Store Incharge','855b2795ba09e36964705f7374720000',6,'{"quotation":0,"tender":0,"workorder":0,"purchase":100000}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('5faef69b92748c6b64675f7161000000','dg_qa','QA/QC Engineer','6c9d590151db1a5d64705f716c740000',6,'{"quotation":0,"tender":0,"workorder":0,"purchase":0}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;
insert into designations (id,legacy_id,name,department_id,hierarchy_level,financial_limits) values ('94efa3d34675907f64675f7361666574','dg_safety','Safety Officer','937dcfe1aecf29dd64705f7366740000',6,'{"quotation":0,"tender":0,"workorder":0,"purchase":0}')
  on conflict(id) do update set name=excluded.name, department_id=excluded.department_id, hierarchy_level=excluded.hierarchy_level, financial_limits=excluded.financial_limits;

update designations set reports_to='cb32d745410b66b764675f6469726563' where id='5fe51095dd7d8d4164675f676d000000';
update designations set reports_to='cb32d745410b66b764675f6469726563' where id='f5acc0c139ea95d564675f7379736164';
update designations set reports_to='5fe51095dd7d8d4164675f676d000000' where id='3fb102d27d970d3664675f706d000000';
update designations set reports_to='3fb102d27d970d3664675f706d000000' where id='3fdbe3d98de5857d64675f636d000000';
update designations set reports_to='5fe51095dd7d8d4164675f676d000000' where id='43f884cf2cdd669564675f7075726d00';
update designations set reports_to='5fe51095dd7d8d4164675f676d000000' where id='276a1d4113ed5b7364675f6163636d00';
update designations set reports_to='5fe51095dd7d8d4164675f676d000000' where id='496d656a2606f0d064675f68726d0000';
update designations set reports_to='3fdbe3d98de5857d64675f636d000000' where id='6974ad0aab229b6264675f7371730000';
update designations set reports_to='3fb102d27d970d3664675f706d000000' where id='5a8c4b862c24939c64675f706c616e00';
update designations set reports_to='6974ad0aab229b6264675f7371730000' where id='51aee091a2052d3164675f7173000000';
update designations set reports_to='43f884cf2cdd669564675f7075726d00' where id='633e131ef24ca4c464675f7065786563';
update designations set reports_to='3fb102d27d970d3664675f706d000000' where id='eab1a2e2ce4b7a7c64675f7369746500';
update designations set reports_to='3fb102d27d970d3664675f706d000000' where id='8190fd52cfaebcc864675f73746f7265';
update designations set reports_to='3fb102d27d970d3664675f706d000000' where id='5faef69b92748c6b64675f7161000000';
update designations set reports_to='3fb102d27d970d3664675f706d000000' where id='94efa3d34675907f64675f7361666574';

-- projects
insert into projects (id,legacy_id,project_name,project_code,project_ref) values ('c8e9b96070223cb670725f7264627400','pr_rdbt','RDB Techpark','RDBT','RDB')
  on conflict(id) do update set project_name=excluded.project_name, project_code=excluded.project_code, project_ref=excluded.project_ref;
insert into projects (id,legacy_id,project_name,project_code,project_ref) values ('992109e2ccb54b7670725f61726e7900','pr_arny','Aaranya','ARNY','AAR')
  on conflict(id) do update set project_name=excluded.project_name, project_code=excluded.project_code, project_ref=excluded.project_ref;
insert into projects (id,legacy_id,project_name,project_code,project_ref) values ('5cc31aae0f0a5a6a70725f6164766b00','pr_advk','Aadvika','ADVK','AAD')
  on conflict(id) do update set project_name=excluded.project_name, project_code=excluded.project_code, project_ref=excluded.project_ref;
insert into projects (id,legacy_id,project_name,project_code,project_ref) values ('0a201475f2f5e2eb70725f616e647600','pr_andv','Anandavilas','ANDV','ANV')
  on conflict(id) do update set project_name=excluded.project_name, project_code=excluded.project_code, project_ref=excluded.project_ref;
insert into projects (id,legacy_id,project_name,project_code,project_ref) values ('53e58466cab5beba70725f7073717200','pr_psqr','Primarc Square','PSQR','PSQ')
  on conflict(id) do update set project_name=excluded.project_name, project_code=excluded.project_code, project_ref=excluded.project_ref;
insert into projects (id,legacy_id,project_name,project_code,project_ref) values ('e897a2669264e82e70725f616b727400','pr_akrt','Akriti','AKRT','AKR')
  on conflict(id) do update set project_name=excluded.project_name, project_code=excluded.project_code, project_ref=excluded.project_ref;

-- permission matrix (mirrors erp-admin.js permTemplate)
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('86fe251cc7e230d0706d5f64675f6469','cb32d745410b66b764675f6469726563','9f0e65fb34dc24956d5f64617368626f',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('0165d7da548a9d8a706d5f64675f6469','cb32d745410b66b764675f6469726563','cdd65157946dc9a36d5f70726f6a6563',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('b4f45fccd7c9a314706d5f64675f6469','cb32d745410b66b764675f6469726563','7c89dbdb3aea1b496d5f626f716d6173',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ce587d2746726955706d5f64675f6469','cb32d745410b66b764675f6469726563','3da2dfac7cc898c06d5f626f71637265',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7c85c4f873c75024706d5f64675f6469','cb32d745410b66b764675f6469726563','373896495a4803556d5f72617465616e',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('77eab665a0831191706d5f64675f6469','cb32d745410b66b764675f6469726563','27f0c3faa68d29c46d5f656e71756972',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('e3e1851209dad8cc706d5f64675f6469','cb32d745410b66b764675f6469726563','a21ee087693655a56d5f74656e646572',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('8c686cee644d88f4706d5f64675f6469','cb32d745410b66b764675f6469726563','4c64f6f35ac0452d6d5f76656e646f72',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('6e913da945539fcd706d5f64675f6469','cb32d745410b66b764675f6469726563','897f8de4d6676bcc6d5f636f6d706172',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('3b204e173b5c0993706d5f64675f6469','cb32d745410b66b764675f6469726563','b2bca8186c8d83ee6d5f776f726b6f72',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('b05b5e45489ab021706d5f64675f6469','cb32d745410b66b764675f6469726563','ca272fbad94efa046d5f707572636861',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('4eab6e07047a18b3706d5f64675f6469','cb32d745410b66b764675f6469726563','f6fe5e668e01f87a6d5f6d6174657269',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ffd6fbe371aa7e9d706d5f64675f6469','cb32d745410b66b764675f6469726563','1d9fbc681b2e7c606d5f7265706f7274',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('c76191ce9aa80f72706d5f64675f6469','cb32d745410b66b764675f6469726563','df88686f34fd712b6d5f61646d696e69',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('735d42e5dc8108f1706d5f64675f6469','cb32d745410b66b764675f6469726563','b3de33a806e7f1006d5f73657474696e',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('3ac432108c91a00e706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','9f0e65fb34dc24956d5f64617368626f',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('c79b8d76da55148c706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','cdd65157946dc9a36d5f70726f6a6563',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('8644a2d8f5912a6a706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','7c89dbdb3aea1b496d5f626f716d6173',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('191bdccb3b2e5703706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','3da2dfac7cc898c06d5f626f71637265',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('df5a00bccc01c5e2706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','373896495a4803556d5f72617465616e',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('250cc619b7464cff706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','27f0c3faa68d29c46d5f656e71756972',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('87de6d1e089c78f2706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','a21ee087693655a56d5f74656e646572',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('283cbeba717ca86a706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','4c64f6f35ac0452d6d5f76656e646f72',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('9ff0ec5d1046f4bb706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','897f8de4d6676bcc6d5f636f6d706172',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ea81e30b3c4e784d706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','b2bca8186c8d83ee6d5f776f726b6f72',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('b967ebe9d3d98adf706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','ca272fbad94efa046d5f707572636861',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('c3fe1b93f9b64715706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','f6fe5e668e01f87a6d5f6d6174657269',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('745b6217c398343b706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','1d9fbc681b2e7c606d5f7265706f7274',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('d193b99a44dff104706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','df88686f34fd712b6d5f61646d696e69',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('584c5a51009ed667706d5f64675f676d','5fe51095dd7d8d4164675f676d000000','b3de33a806e7f1006d5f73657474696e',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('19ced4bccc650de2706d5f64675f7379','f5acc0c139ea95d564675f7379736164','9f0e65fb34dc24956d5f64617368626f',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('6099f8fa762cb2c0706d5f64675f7379','f5acc0c139ea95d564675f7379736164','cdd65157946dc9a36d5f70726f6a6563',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('3bc47c6ce8413846706d5f64675f7379','f5acc0c139ea95d564675f7379736164','7c89dbdb3aea1b496d5f626f716d6173',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('408f86c7984b2cc7706d5f64675f7379','f5acc0c139ea95d564675f7379736164','3da2dfac7cc898c06d5f626f71637265',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('fa79511878d3469e706d5f64675f7379','f5acc0c139ea95d564675f7379736164','373896495a4803556d5f72617465616e',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('53082e057be70073706d5f64675f7379','f5acc0c139ea95d564675f7379736164','27f0c3faa68d29c46d5f656e71756972',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('943e8432d78a2766706d5f64675f7379','f5acc0c139ea95d564675f7379736164','a21ee087693655a56d5f74656e646572',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('b555480e406a56de706d5f64675f7379','f5acc0c139ea95d564675f7379736164','4c64f6f35ac0452d6d5f76656e646f72',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7b105fc9ad1378b7706d5f64675f7379','f5acc0c139ea95d564675f7379736164','897f8de4d6676bcc6d5f636f6d706172',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('cdf0fdb7d3ca4dd1706d5f64675f7379','f5acc0c139ea95d564675f7379736164','b2bca8186c8d83ee6d5f776f726b6f72',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('587423e559d6b573706d5f64675f7379','f5acc0c139ea95d564675f7379736164','ca272fbad94efa046d5f707572636861',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f037862769093679706d5f64675f7379','f5acc0c139ea95d564675f7379736164','f6fe5e668e01f87a6d5f6d6174657269',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f4412883585605af706d5f64675f7379','f5acc0c139ea95d564675f7379736164','1d9fbc681b2e7c606d5f7265706f7274',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('67bd92ee31d0e248706d5f64675f7379','f5acc0c139ea95d564675f7379736164','df88686f34fd712b6d5f61646d696e69',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('96811e05e454792b706d5f64675f7379','f5acc0c139ea95d564675f7379736164','b3de33a806e7f1006d5f73657474696e',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('d0b486cf21610db1706d5f64675f706d','3fb102d27d970d3664675f706d000000','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('4c27b2b3090848ff706d5f64675f706d','3fb102d27d970d3664675f706d000000','cdd65157946dc9a36d5f70726f6a6563',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('c1419fe7899c361d706d5f64675f706d','3fb102d27d970d3664675f706d000000','7c89dbdb3aea1b496d5f626f716d6173',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ab76c0307573b9fc706d5f64675f706d','3fb102d27d970d3664675f706d000000','3da2dfac7cc898c06d5f626f71637265',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('4bc7b24dfbbeb769706d5f64675f706d','3fb102d27d970d3664675f706d000000','373896495a4803556d5f72617465616e',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ac67b47ec92d7340706d5f64675f706d','3fb102d27d970d3664675f706d000000','27f0c3faa68d29c46d5f656e71756972',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('3d63a2930f3d1cd1706d5f64675f706d','3fb102d27d970d3664675f706d000000','a21ee087693655a56d5f74656e646572',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('3438ae3fc369c179706d5f64675f706d','3fb102d27d970d3664675f706d000000','4c64f6f35ac0452d6d5f76656e646f72',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('5bc44a1811137c70706d5f64675f706d','3fb102d27d970d3664675f706d000000','897f8de4d6676bcc6d5f636f6d706172',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('d698f98c9868f08a706d5f64675f706d','3fb102d27d970d3664675f706d000000','b2bca8186c8d83ee6d5f776f726b6f72',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('26d5cece3dc74440706d5f64675f706d','3fb102d27d970d3664675f706d000000','ca272fbad94efa046d5f707572636861',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('9b4736a2d0fcef66706d5f64675f706d','3fb102d27d970d3664675f706d000000','f6fe5e668e01f87a6d5f6d6174657269',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('5d1757ec19335eac706d5f64675f706d','3fb102d27d970d3664675f706d000000','1d9fbc681b2e7c606d5f7265706f7274',1,1,1,1,1,1,1,1,1,1,1,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=1, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=1, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('36d31e0b930e03f7706d5f64675f706d','3fb102d27d970d3664675f706d000000','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('42164e64b586833c706d5f64675f706d','3fb102d27d970d3664675f706d000000','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('d60b3654ba835e9a706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('4a62fec28d014e18706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','cdd65157946dc9a36d5f70726f6a6563',1,1,1,0,1,1,1,1,1,1,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('71fbc144264fd87e706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','7c89dbdb3aea1b496d5f626f716d6173',1,1,1,0,1,1,1,1,1,1,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('78cc115f1f6c4d1f706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','3da2dfac7cc898c06d5f626f71637265',1,1,1,0,1,1,1,1,1,1,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('8d1735c0ccaacc96706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','373896495a4803556d5f72617465616e',1,1,1,0,1,1,1,1,1,1,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f86894ed880bfb9b706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','27f0c3faa68d29c46d5f656e71756972',1,1,1,0,1,1,1,1,1,1,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('6792c62a7fc1dace706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','a21ee087693655a56d5f74656e646572',1,1,1,0,1,1,1,1,1,1,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('bb972e9672c7e616706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','4c64f6f35ac0452d6d5f76656e646f72',1,1,1,0,1,1,1,1,1,1,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('d14651216f59889f706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','897f8de4d6676bcc6d5f636f6d706172',1,1,1,0,1,1,1,1,1,1,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('8f0fe9ff58bac6f9706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','b2bca8186c8d83ee6d5f776f726b6f72',1,0,0,0,0,0,0,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('1a37ab7d148b134b706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','ca272fbad94efa046d5f707572636861',1,0,0,0,0,0,0,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('b6618bcfa661be71706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','f6fe5e668e01f87a6d5f6d6174657269',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('6f98b20bd4a84217706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','1d9fbc681b2e7c606d5f7265706f7274',1,1,1,0,1,1,1,1,1,1,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=1, can_import=1, can_export=1, can_print=1, can_lock=1, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('e3c6c0a675e535b0706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('5aae824d4ad9bde3706d5f64675f636d','3fdbe3d98de5857d64675f636d000000','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('8ddb486a45fbbbb2706d5f64675f7075','43f884cf2cdd669564675f7075726d00','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f325eb7885c58e10706d5f64675f7075','43f884cf2cdd669564675f7075726d00','cdd65157946dc9a36d5f70726f6a6563',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('992bf08ab9ff0a96706d5f64675f7075','43f884cf2cdd669564675f7075726d00','7c89dbdb3aea1b496d5f626f716d6173',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ab1582d5144780b7706d5f64675f7075','43f884cf2cdd669564675f7075726d00','3da2dfac7cc898c06d5f626f71637265',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f689530add16558e706d5f64675f7075','43f884cf2cdd669564675f7075726d00','373896495a4803556d5f72617465616e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('e92f6703b9bb7403706d5f64675f7075','43f884cf2cdd669564675f7075726d00','27f0c3faa68d29c46d5f656e71756972',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('df72955cf38eb0f6706d5f64675f7075','43f884cf2cdd669564675f7075726d00','a21ee087693655a56d5f74656e646572',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('36ea1a8023dc9aae706d5f64675f7075','43f884cf2cdd669564675f7075726d00','4c64f6f35ac0452d6d5f76656e646f72',1,1,1,0,1,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f3e3581be1b8f1a7706d5f64675f7075','43f884cf2cdd669564675f7075726d00','897f8de4d6676bcc6d5f636f6d706172',1,1,1,0,1,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('cbee51a120db2d21706d5f64675f7075','43f884cf2cdd669564675f7075726d00','b2bca8186c8d83ee6d5f776f726b6f72',1,1,1,0,1,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('b122e3f3cc2a2d03706d5f64675f7075','43f884cf2cdd669564675f7075726d00','ca272fbad94efa046d5f707572636861',1,1,1,0,1,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f57ddc95c2d07e29706d5f64675f7075','43f884cf2cdd669564675f7075726d00','f6fe5e668e01f87a6d5f6d6174657269',1,1,1,0,1,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f3a4eab93edd819f706d5f64675f7075','43f884cf2cdd669564675f7075726d00','1d9fbc681b2e7c606d5f7265706f7274',1,1,1,0,1,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=1, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('c3d8de54be8a1f98706d5f64675f7075','43f884cf2cdd669564675f7075726d00','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('32dd4e6f2f7d727b706d5f64675f7075','43f884cf2cdd669564675f7075726d00','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('4c6cd9c84c7110cc706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('bbbaca7ea09489a6706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','cdd65157946dc9a36d5f70726f6a6563',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('09918bd02c9bb928706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','7c89dbdb3aea1b496d5f626f716d6173',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('978adb637a5ded81706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','3da2dfac7cc898c06d5f626f71637265',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('61ce72e4760db9b8706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','373896495a4803556d5f72617465616e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('1d2ceba18857da0d706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','27f0c3faa68d29c46d5f656e71756972',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('9a2306d61dd52a48706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','a21ee087693655a56d5f74656e646572',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7318cfa2c826c430706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','4c64f6f35ac0452d6d5f76656e646f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('9246d6b575bb0461706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','897f8de4d6676bcc6d5f636f6d706172',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('35ffc0f39eab6e9f706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','b2bca8186c8d83ee6d5f776f726b6f72',1,0,0,0,0,0,0,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('94042ce1df7fc1fd706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','ca272fbad94efa046d5f707572636861',1,0,0,0,0,0,0,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('defe4a7bb96f89df706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','f6fe5e668e01f87a6d5f6d6174657269',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f61063bf02904ab9706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','1d9fbc681b2e7c606d5f7265706f7274',1,0,0,0,0,0,0,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('68424af2b8d3447e706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('a08e4f99eabee95d706d5f64675f6163','276a1d4113ed5b7364675f6163636d00','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ce65e57f808feeb7706d5f64675f6872','496d656a2606f0d064675f68726d0000','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('63703183498de109706d5f64675f6872','496d656a2606f0d064675f68726d0000','cdd65157946dc9a36d5f70726f6a6563',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('83aea457d1f0460b706d5f64675f6872','496d656a2606f0d064675f68726d0000','7c89dbdb3aea1b496d5f626f716d6173',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('586db4409021a362706d5f64675f6872','496d656a2606f0d064675f68726d0000','3da2dfac7cc898c06d5f626f71637265',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('a5743afd322adcdf706d5f64675f6872','496d656a2606f0d064675f68726d0000','373896495a4803556d5f72617465616e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ae4235aea2e82136706d5f64675f6872','496d656a2606f0d064675f68726d0000','27f0c3faa68d29c46d5f656e71756972',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ce83b2e323b85d0f706d5f64675f6872','496d656a2606f0d064675f68726d0000','a21ee087693655a56d5f74656e646572',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7721668f760c13e7706d5f64675f6872','496d656a2606f0d064675f68726d0000','4c64f6f35ac0452d6d5f76656e646f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('5c66614892c5b286706d5f64675f6872','496d656a2606f0d064675f68726d0000','897f8de4d6676bcc6d5f636f6d706172',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7d5e343c6267adbc706d5f64675f6872','496d656a2606f0d064675f68726d0000','b2bca8186c8d83ee6d5f776f726b6f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('73c49ffe06a1ff26706d5f64675f6872','496d656a2606f0d064675f68726d0000','ca272fbad94efa046d5f707572636861',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('edbfebd2ebe7c710706d5f64675f6872','496d656a2606f0d064675f68726d0000','f6fe5e668e01f87a6d5f6d6174657269',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('92dcbffc66cf8ca2706d5f64675f6872','496d656a2606f0d064675f68726d0000','1d9fbc681b2e7c606d5f7265706f7274',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('0b73ae1baf80ca71706d5f64675f6872','496d656a2606f0d064675f68726d0000','df88686f34fd712b6d5f61646d696e69',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('639f3134eb0b9e4a706d5f64675f6872','496d656a2606f0d064675f68726d0000','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('3850f4632ebf7375706d5f64675f7371','6974ad0aab229b6264675f7371730000','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('aa27210fcd726f43706d5f64675f7371','6974ad0aab229b6264675f7371730000','cdd65157946dc9a36d5f70726f6a6563',1,1,1,0,0,0,1,1,1,0,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7cfb85833febcd29706d5f64675f7371','6974ad0aab229b6264675f7371730000','7c89dbdb3aea1b496d5f626f716d6173',1,1,1,0,0,0,1,1,1,0,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('80e62ad4a3cf45a0706d5f64675f7371','6974ad0aab229b6264675f7371730000','3da2dfac7cc898c06d5f626f71637265',1,1,1,0,0,0,1,1,1,0,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('243d45e1b5c4d3f5706d5f64675f7371','6974ad0aab229b6264675f7371730000','373896495a4803556d5f72617465616e',1,1,1,0,0,0,1,1,1,0,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ec2e1d52e78beaa4706d5f64675f7371','6974ad0aab229b6264675f7371730000','27f0c3faa68d29c46d5f656e71756972',1,1,1,0,0,0,1,1,1,0,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('179ed38fea4f3245706d5f64675f7371','6974ad0aab229b6264675f7371730000','a21ee087693655a56d5f74656e646572',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f885df8bd47398cd706d5f64675f7371','6974ad0aab229b6264675f7371730000','4c64f6f35ac0452d6d5f76656e646f72',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('05d8e44c38ce406c706d5f64675f7371','6974ad0aab229b6264675f7371730000','897f8de4d6676bcc6d5f636f6d706172',1,1,1,0,0,0,1,1,1,0,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7589f4707b7f60ce706d5f64675f7371','6974ad0aab229b6264675f7371730000','b2bca8186c8d83ee6d5f776f726b6f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('43bfe8828758ace4706d5f64675f7371','6974ad0aab229b6264675f7371730000','ca272fbad94efa046d5f707572636861',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('0ec53b7eb969731a706d5f64675f7371','6974ad0aab229b6264675f7371730000','f6fe5e668e01f87a6d5f6d6174657269',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('1d7299c0e795ec40706d5f64675f7371','6974ad0aab229b6264675f7371730000','1d9fbc681b2e7c606d5f7265706f7274',1,1,1,0,0,0,1,1,1,0,0,1)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=1;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('a71fbaf7bcc79ecb706d5f64675f7371','6974ad0aab229b6264675f7371730000','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('c613dc8051424aa0706d5f64675f7371','6974ad0aab229b6264675f7371730000','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('8da322df67fcc78b706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('09a1a5638cc97ddd706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','cdd65157946dc9a36d5f70726f6a6563',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('9c40afb7339882f7706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','7c89dbdb3aea1b496d5f626f716d6173',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('727c18a02ef92716706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','3da2dfac7cc898c06d5f626f71637265',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('6a2d64dd1d85106b706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','373896495a4803556d5f72617465616e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('14c2a10efd00f93a706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','27f0c3faa68d29c46d5f656e71756972',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('629557c3de7b3983706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','a21ee087693655a56d5f74656e646572',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f1e7e96f77181c0b706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','4c64f6f35ac0452d6d5f76656e646f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('fdcc3e2824320d52706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','897f8de4d6676bcc6d5f636f6d706172',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('9555419c535e5080706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','b2bca8186c8d83ee6d5f776f726b6f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('1953ed5e7840963a706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','ca272fbad94efa046d5f707572636861',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('6430cbb220a3d694706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','f6fe5e668e01f87a6d5f6d6174657269',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7726215c6d11e816706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','1d9fbc681b2e7c606d5f7265706f7274',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('95b365fbaf4cf6c5706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('3387fa14e31f359e706d5f64675f706c','5a8c4b862c24939c64675f706c616e00','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('2963092cc1a2963e706d5f64675f7173','51aee091a2052d3164675f7173000000','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('b6d00fcac589907c706d5f64675f7173','51aee091a2052d3164675f7173000000','cdd65157946dc9a36d5f70726f6a6563',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('786a375c3ea9adda706d5f64675f7173','51aee091a2052d3164675f7173000000','7c89dbdb3aea1b496d5f626f716d6173',1,1,1,0,0,0,0,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('a05d7657b6bc0e13706d5f64675f7173','51aee091a2052d3164675f7173000000','3da2dfac7cc898c06d5f626f71637265',1,1,1,0,0,0,0,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('e6543ec8095d1c32706d5f64675f7173','51aee091a2052d3164675f7173000000','373896495a4803556d5f72617465616e',1,1,1,0,0,0,0,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f545c135ae6660af706d5f64675f7173','51aee091a2052d3164675f7173000000','27f0c3faa68d29c46d5f656e71756972',1,1,1,0,0,0,0,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('a2cfcbc2b4e4e2a2706d5f64675f7173','51aee091a2052d3164675f7173000000','a21ee087693655a56d5f74656e646572',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('35e9ee9e36de79da706d5f64675f7173','51aee091a2052d3164675f7173000000','4c64f6f35ac0452d6d5f76656e646f72',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7daa0cf9daef514b706d5f64675f7173','51aee091a2052d3164675f7173000000','897f8de4d6676bcc6d5f636f6d706172',1,1,1,0,0,0,0,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f18cc92754c1f67d706d5f64675f7173','51aee091a2052d3164675f7173000000','b2bca8186c8d83ee6d5f776f726b6f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f9902695dc57b18f706d5f64675f7173','51aee091a2052d3164675f7173000000','ca272fbad94efa046d5f707572636861',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('19b75217078873e5706d5f64675f7173','51aee091a2052d3164675f7173000000','f6fe5e668e01f87a6d5f6d6174657269',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('d6d588d3c44c044b706d5f64675f7173','51aee091a2052d3164675f7173000000','1d9fbc681b2e7c606d5f7265706f7274',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7158d77ef22f1e74706d5f64675f7173','51aee091a2052d3164675f7173000000','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('029264550b18bf17706d5f64675f7173','51aee091a2052d3164675f7173000000','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('a40118636786a26b706d5f64675f7065','633e131ef24ca4c464675f7065786563','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('975ced0f9b12507d706d5f64675f7065','633e131ef24ca4c464675f7065786563','cdd65157946dc9a36d5f70726f6a6563',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('e8aba983157d7fd7706d5f64675f7065','633e131ef24ca4c464675f7065786563','7c89dbdb3aea1b496d5f626f716d6173',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('e54ceed4ff402bf6706d5f64675f7065','633e131ef24ca4c464675f7065786563','3da2dfac7cc898c06d5f626f71637265',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('3203d1e1c792fa0b706d5f64675f7065','633e131ef24ca4c464675f7065786563','373896495a4803556d5f72617465616e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('25f0a1521deae51a706d5f64675f7065','633e131ef24ca4c464675f7065786563','27f0c3faa68d29c46d5f656e71756972',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('2b74bf8fbd49c623706d5f64675f7065','633e131ef24ca4c464675f7065786563','a21ee087693655a56d5f74656e646572',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('0c5bcb8b816419ab706d5f64675f7065','633e131ef24ca4c464675f7065786563','4c64f6f35ac0452d6d5f76656e646f72',1,1,1,0,0,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('8c21904cef032cf2706d5f64675f7065','633e131ef24ca4c464675f7065786563','897f8de4d6676bcc6d5f636f6d706172',1,1,1,0,0,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('e13a1870a8ebaf60706d5f64675f7065','633e131ef24ca4c464675f7065786563','b2bca8186c8d83ee6d5f776f726b6f72',1,1,1,0,0,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f34e4c8299413d1a706d5f64675f7065','633e131ef24ca4c464675f7065786563','ca272fbad94efa046d5f707572636861',1,1,1,0,0,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('6beca77edcde8e34706d5f64675f7065','633e131ef24ca4c464675f7065786563','f6fe5e668e01f87a6d5f6d6174657269',1,1,1,0,0,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('57351dc0d61709f6706d5f64675f7065','633e131ef24ca4c464675f7065786563','1d9fbc681b2e7c606d5f7265706f7274',1,1,1,0,0,0,1,1,1,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=1, can_edit=1, can_delete=0, can_approve=0, can_reject=0, can_import=1, can_export=1, can_print=1, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('044726f730f8c565706d5f64675f7065','633e131ef24ca4c464675f7065786563','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('b349a8801419ec3e706d5f64675f7065','633e131ef24ca4c464675f7065786563','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('8cc0031b3c1acbab706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('96eb2af711d3f93d706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','cdd65157946dc9a36d5f70726f6a6563',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('685da0fbf5475917706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','7c89dbdb3aea1b496d5f626f716d6173',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('865dafcc6eb0b836706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','3da2dfac7cc898c06d5f626f71637265',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('4c8ce0e9419937cb706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','373896495a4803556d5f72617465616e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('051a601a1db9715a706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','27f0c3faa68d29c46d5f656e71756972',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('41faa027fb0eaee3706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','a21ee087693655a56d5f74656e646572',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('d9143f93b049566b706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','4c64f6f35ac0452d6d5f76656e646f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7c21a584377b85b2706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','897f8de4d6676bcc6d5f636f6d706172',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('9e906d389b24b6a0706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','b2bca8186c8d83ee6d5f776f726b6f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ed4e15da448ca55a706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','ca272fbad94efa046d5f707572636861',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('2b894c06b73234f4706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','f6fe5e668e01f87a6d5f6d6174657269',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('9f96b288aa682536706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','1d9fbc681b2e7c606d5f7265706f7274',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('a4f2fb0f3b111525706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('01ea5b480d8a8efe706d5f64675f7369','eab1a2e2ce4b7a7c64675f7369746500','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('1bbbec1f3a34c4ef706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('a4fe9ea3b530dea1706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','cdd65157946dc9a36d5f70726f6a6563',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('0b6363f709855943706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','7c89dbdb3aea1b496d5f626f716d6173',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('053f8ae08ecf233a706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','3da2dfac7cc898c06d5f626f71637265',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('48d0b71dab597157706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','373896495a4803556d5f72617465616e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7db21d4ead7d4ffe706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','27f0c3faa68d29c46d5f656e71756972',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('e8c856032a159c37706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','a21ee087693655a56d5f74656e646572',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('91679cafb182cf5f706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','4c64f6f35ac0452d6d5f76656e646f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('34d34e6887d2584e706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','897f8de4d6676bcc6d5f636f6d706172',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('db5a0bdc28b4d0e4706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','b2bca8186c8d83ee6d5f776f726b6f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('2f4d4c9ed361673e706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','ca272fbad94efa046d5f707572636861',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('b7be65f2004993a8706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','f6fe5e668e01f87a6d5f6d6174657269',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('cceab99c1ee16b0a706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','1d9fbc681b2e7c606d5f7265706f7274',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('e6fbcd3b79725db9706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('0db7105494a0c262706d5f64675f7374','8190fd52cfaebcc864675f73746f7265','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f4df3e82ed87c5e4706d5f64675f7161','5faef69b92748c6b64675f7161000000','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('9644be006079f4be706d5f64675f7161','5faef69b92748c6b64675f7161000000','cdd65157946dc9a36d5f70726f6a6563',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('cb33bf0253477fc0706d5f64675f7161','5faef69b92748c6b64675f7161000000','7c89dbdb3aea1b496d5f626f716d6173',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('a905b0adc1ffbf79706d5f64675f7161','5faef69b92748c6b64675f7161000000','3da2dfac7cc898c06d5f626f71637265',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('9f22565272929350706d5f64675f7161','5faef69b92748c6b64675f7161000000','373896495a4803556d5f72617465616e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('da232e2baefed815706d5f64675f7161','5faef69b92748c6b64675f7161000000','27f0c3faa68d29c46d5f656e71756972',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('27b746546d97dbb0706d5f64675f7161','5faef69b92748c6b64675f7161000000','a21ee087693655a56d5f74656e646572',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('6888a108b4c8e8c8706d5f64675f7161','5faef69b92748c6b64675f7161000000','4c64f6f35ac0452d6d5f76656e646f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('b2ba679303e80069706d5f64675f7161','5faef69b92748c6b64675f7161000000','897f8de4d6676bcc6d5f636f6d706172',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('0e89858998ced247706d5f64675f7161','5faef69b92748c6b64675f7161000000','b2bca8186c8d83ee6d5f776f726b6f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('cfb78bab7cfb2695706d5f64675f7161','5faef69b92748c6b64675f7161000000','ca272fbad94efa046d5f707572636861',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('fe91217ded443637706d5f64675f7161','5faef69b92748c6b64675f7161000000','f6fe5e668e01f87a6d5f6d6174657269',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('9ecd4e411e2ac221706d5f64675f7161','5faef69b92748c6b64675f7161000000','1d9fbc681b2e7c606d5f7265706f7274',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('40fc0b6c930cfc66706d5f64675f7161','5faef69b92748c6b64675f7161000000','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('155bcfd7eca432d5706d5f64675f7161','5faef69b92748c6b64675f7161000000','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('e0490fa286c3e448706d5f64675f7361','94efa3d34675907f64675f7361666574','9f0e65fb34dc24956d5f64617368626f',1,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('f46c76a078927962706d5f64675f7361','94efa3d34675907f64675f7361666574','cdd65157946dc9a36d5f70726f6a6563',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('b9f8d22211c68d8c706d5f64675f7361','94efa3d34675907f64675f7361666574','7c89dbdb3aea1b496d5f626f716d6173',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('e72378cdd140b78d706d5f64675f7361','94efa3d34675907f64675f7361666574','3da2dfac7cc898c06d5f626f71637265',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('35119ff2f42c725c706d5f64675f7361','94efa3d34675907f64675f7361666574','373896495a4803556d5f72617465616e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('0abc094bf77dbf19706d5f64675f7361','94efa3d34675907f64675f7361666574','27f0c3faa68d29c46d5f656e71756972',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('fac5cbf458e055d4706d5f64675f7361','94efa3d34675907f64675f7361666574','a21ee087693655a56d5f74656e646572',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('7b02aea807d9f3ac706d5f64675f7361','94efa3d34675907f64675f7361666574','4c64f6f35ac0452d6d5f76656e646f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('72f8b13316dbbf35706d5f64675f7361','94efa3d34675907f64675f7361666574','897f8de4d6676bcc6d5f636f6d706172',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('ffc901a9babde3db706d5f64675f7361','94efa3d34675907f64675f7361666574','b2bca8186c8d83ee6d5f776f726b6f72',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('eea8adcbc6b6a199706d5f64675f7361','94efa3d34675907f64675f7361666574','ca272fbad94efa046d5f707572636861',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('d714bd1d7eeafd6b706d5f64675f7361','94efa3d34675907f64675f7361666574','f6fe5e668e01f87a6d5f6d6174657269',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('76ac59617cc9ae25706d5f64675f7361','94efa3d34675907f64675f7361666574','1d9fbc681b2e7c606d5f7265706f7274',1,0,0,0,0,0,0,1,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=1, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=1, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('c6b14c0c88e96afa706d5f64675f7361','94efa3d34675907f64675f7361666574','df88686f34fd712b6d5f61646d696e69',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;
insert into permissions (id,designation_id,module_id,can_view,can_create,can_edit,can_delete,can_approve,can_reject,can_import,can_export,can_print,can_lock,can_unlock,can_share) values ('4742e4775c12cb69706d5f64675f7361','94efa3d34675907f64675f7361666574','b3de33a806e7f1006d5f73657474696e',0,0,0,0,0,0,0,0,0,0,0,0)
  on conflict(designation_id,module_id) do update set can_view=0, can_create=0, can_edit=0, can_delete=0, can_approve=0, can_reject=0, can_import=0, can_export=0, can_print=0, can_lock=0, can_unlock=0, can_share=0;

-- workflows
insert into workflows (id,legacy_id,name,module) values ('3b08b42fbd77b4a977665f74656e6465','wf_tender','Tender Approval','Tender') on conflict(id) do nothing;
insert into workflows (id,legacy_id,name,module) values ('ff747f0348c16aed77665f776f000000','wf_wo','Work Order Approval','Work Order') on conflict(id) do nothing;
insert into workflows (id,legacy_id,name,module) values ('ff7b3ac8e706fdea77665f706f000000','wf_po','Purchase Order Approval','Purchase Order') on conflict(id) do nothing;
insert into workflow_steps (id,workflow_id,step_no,name,designation_id,approval_limit) values ('ce86b6ef0014f14f77735f77665f7465','3b08b42fbd77b4a977665f74656e6465',1,'Commercial review','3fdbe3d98de5857d64675f636d000000',10000000) on conflict(workflow_id,step_no) do nothing;
insert into workflow_steps (id,workflow_id,step_no,name,designation_id,approval_limit) values ('cf86b8827cbf180077735f77665f7465','3b08b42fbd77b4a977665f74656e6465',2,'Project Manager approval','3fb102d27d970d3664675f706d000000',25000000) on conflict(workflow_id,step_no) do nothing;
insert into workflow_steps (id,workflow_id,step_no,name,designation_id,approval_limit) values ('d086ba15fddbb5c577735f77665f7465','3b08b42fbd77b4a977665f74656e6465',3,'GM approval','5fe51095dd7d8d4164675f676d000000',100000000) on conflict(workflow_id,step_no) do nothing;
insert into workflow_steps (id,workflow_id,step_no,name,designation_id,approval_limit) values ('c44f0f43826b9eeb77735f77665f776f','ff747f0348c16aed77665f776f000000',1,'Purchase Manager','43f884cf2cdd669564675f7075726d00',10000000) on conflict(workflow_id,step_no) do nothing;
insert into workflow_steps (id,workflow_id,step_no,name,designation_id,approval_limit) values ('c54f10d6ff15c59c77735f77665f776f','ff747f0348c16aed77665f776f000000',2,'Project Manager','3fb102d27d970d3664675f706d000000',50000000) on conflict(workflow_id,step_no) do nothing;
insert into workflow_steps (id,workflow_id,step_no,name,designation_id,approval_limit) values ('908a26be3002cb5877735f77665f706f','ff7b3ac8e706fdea77665f706f000000',1,'Purchase Manager','43f884cf2cdd669564675f7075726d00',20000000) on conflict(workflow_id,step_no) do nothing;
insert into workflow_steps (id,workflow_id,step_no,name,designation_id,approval_limit) values ('8f8a252bb358a4a777735f77665f706f','ff7b3ac8e706fdea77665f706f000000',2,'Accounts Manager','276a1d4113ed5b7364675f6163636d00',5000000) on conflict(workflow_id,step_no) do nothing;

-- settings
insert into system_settings (id,setting_key,setting_value) values ('6264f80566f2a1b373745f636f6d7061','company_defaults','{"currency":"INR","gstDefault":18,"locale":"en-IN"}') on conflict(setting_key) do nothing;
insert into system_settings (id,setting_key,setting_value) values ('9137356ab375919073745f6e756d6265','numbering','{"enquiry":"ENQ/{REF}/{YEAR}/{SERIAL}","workOrder":"WO/{REF}/{YEAR}/{SERIAL}","purchaseOrder":"PO/{REF}/{YEAR}/{SERIAL}"}') on conflict(setting_key) do nothing;

insert or ignore into system_policy (id) values (1);

-- ▓▓▓ migration 019_ai_provider.sql ▓▓▓
-- ═══════════════════════════════════════════════════════════════
-- 019 · Shared AI provider config (BOQ description enhancement)
--
-- Previously each user pasted their own API key into browser localStorage
-- and the browser called the AI provider directly. This centralises it:
-- one org-wide key, entered once by an admin, used by everyone.
--
-- The key never leaves this table -- no route ever returns api_key in a
-- response body or an audit log entry; only the POST /ai/call proxy reads
-- it internally to sign the outbound request to the provider.
-- ═══════════════════════════════════════════════════════════════
create table if not exists ai_provider_config (
  id          text primary key,
  provider    text not null,
  model       text not null,
  api_key     text not null,
  updated_by  text references users(id),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- End of schema. 40 tables · 72 indexes · 27 triggers.
