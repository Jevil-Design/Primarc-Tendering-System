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
