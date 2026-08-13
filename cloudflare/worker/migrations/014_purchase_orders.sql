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
