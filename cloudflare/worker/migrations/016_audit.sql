-- ═══════════════════════════════════════════════════════════════
-- 016 · Audit log — append only
--
-- There is no UPDATE or DELETE path to this table anywhere in the Worker.
-- user_name is denormalised on purpose so the trail survives user deletion.
-- ═══════════════════════════════════════════════════════════════
create table if not exists audit_logs (
  id          text primary key,
  user_id     text references users(id) on delete set null,
  user_name   text,
  action      text not null,
  module      text,
  entity_type text,
  entity_id   text,
  target      text,
  old_value   text,
  new_value   text,
  reason      text,
  ip_address  text,
  user_agent  text,
  browser     text,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_audit_user on audit_logs(user_id, created_at desc);
create index if not exists idx_audit_entity on audit_logs(entity_type, entity_id);
create index if not exists idx_audit_module on audit_logs(module, created_at desc);
create index if not exists idx_audit_created on audit_logs(created_at desc);
create index if not exists idx_audit_action on audit_logs(action);
