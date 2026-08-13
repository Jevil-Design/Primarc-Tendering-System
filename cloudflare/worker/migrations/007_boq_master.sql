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
