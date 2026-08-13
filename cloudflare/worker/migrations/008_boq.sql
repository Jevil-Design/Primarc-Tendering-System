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

-- Per-user working draft (replaces boq_autosave_v3). One row per user, so an
-- in-progress BOQ survives a refresh, a different device, and a crash.
create table if not exists boq_drafts (
  user_id    text primary key references users(id) on delete cascade,
  payload    text not null,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
