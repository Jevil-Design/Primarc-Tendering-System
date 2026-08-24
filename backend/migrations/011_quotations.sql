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
