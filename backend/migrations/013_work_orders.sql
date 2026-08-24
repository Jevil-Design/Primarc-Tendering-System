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
