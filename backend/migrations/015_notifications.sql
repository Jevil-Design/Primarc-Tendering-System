-- ═══════════════════════════════════════════════════════════════
-- 015 · Notifications and documents (R2 metadata)
-- ═══════════════════════════════════════════════════════════════
create table if not exists notifications (
  id             text primary key,
  user_id        text not null references users(id) on delete cascade,
  title          text not null,
  message        text,
  type           text not null default 'info',
  reference_type text,
  reference_id   text,
  link           text,
  is_read        integer not null default 0 check (is_read in (0,1)),
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_notif_user on notifications(user_id, is_read, created_at desc);
create index if not exists idx_notif_created on notifications(created_at desc);

-- Metadata only. The bytes live in R2 under file_key; D1 rows stay small.
create table if not exists documents (
  id           text primary key,
  owner_type   text not null,   -- vendor | boq | enquiry | quotation | work_order | purchase_order | vendor_logo
  owner_id     text,
  file_name    text not null,
  file_key     text not null unique,
  content_type text,
  file_size    integer,
  bucket       text not null default 'primarc-tendering-documents',
  uploaded_by  text references users(id),
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at   text
);

create index if not exists idx_documents_owner on documents(owner_type, owner_id);
