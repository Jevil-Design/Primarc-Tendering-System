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
