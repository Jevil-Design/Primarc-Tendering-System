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
