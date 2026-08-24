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
