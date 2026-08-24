-- ═══════════════════════════════════════════════════════════════
-- 003 · RBAC: modules, designation permissions, per-user overrides
--
-- Effective permission = designation default, then user override where the
-- override column is NOT NULL. Resolved in permissions.js and enforced by the
-- Worker on every mutating route — hiding a button is not access control.
-- ═══════════════════════════════════════════════════════════════

create table if not exists modules (
  id            text primary key,
  code          text not null unique,
  name          text not null,
  display_order integer not null default 0,
  is_core       integer not null default 1 check (is_core in (0,1)),
  status        text not null default 'active' check (status in ('active','inactive')),
  legacy_id     text unique
);

create table if not exists permissions (
  id             text primary key,
  designation_id text not null references designations(id) on delete cascade,
  module_id      text not null references modules(id) on delete cascade,
  can_view    integer not null default 0,
  can_create  integer not null default 0,
  can_edit    integer not null default 0,
  can_delete  integer not null default 0,
  can_approve integer not null default 0,
  can_reject  integer not null default 0,
  can_import  integer not null default 0,
  can_export  integer not null default 0,
  can_print   integer not null default 0,
  can_lock    integer not null default 0,
  can_unlock  integer not null default 0,
  can_share   integer not null default 0,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (designation_id, module_id)
);

-- NULL on a column means "inherit the designation default".
create table if not exists user_permission_overrides (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  module_id  text not null references modules(id) on delete cascade,
  can_view integer, can_create integer, can_edit   integer, can_delete integer,
  can_approve integer, can_reject integer, can_import integer, can_export integer,
  can_print integer, can_lock   integer, can_unlock integer, can_share  integer,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (user_id, module_id)
);

create index if not exists idx_perm_desig on permissions(designation_id);
create index if not exists idx_upo_user on user_permission_overrides(user_id);
