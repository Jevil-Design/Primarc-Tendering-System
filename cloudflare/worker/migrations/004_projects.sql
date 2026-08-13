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
