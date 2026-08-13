-- ═══════════════════════════════════════════════════════════════
-- 017 · Approval workflows, system policy and settings
-- ═══════════════════════════════════════════════════════════════
create table if not exists workflows (
  id          text primary key,
  name        text not null,
  module      text not null,
  description text,
  status      text not null default 'active' check (status in ('active','inactive')),
  legacy_id   text unique,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists workflow_steps (
  id             text primary key,
  workflow_id    text not null references workflows(id) on delete cascade,
  step_no        integer not null,
  name           text not null,
  designation_id text references designations(id) on delete set null,
  approval_limit real,
  required       integer not null default 1 check (required in (0,1)),
  status         text not null default 'active',
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (workflow_id, step_no)
);

create table if not exists workflow_actions (
  id               text primary key,
  workflow_step_id text references workflow_steps(id) on delete cascade,
  entity_type text not null,
  entity_id   text not null,
  user_id     text references users(id) on delete set null,
  action      text not null,      -- approved | rejected | returned
  remarks     text,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists system_policy (
  id integer primary key check (id = 1),
  password_min_length     integer not null default 8,
  password_complexity     text not null default 'medium',
  password_expiry_days    integer not null default 90,
  password_history        integer not null default 3,
  must_change_first_login integer not null default 1,
  lock_after_attempts     integer not null default 5,
  idle_lock_days          integer not null default 30,
  session_timeout_minutes integer not null default 30,
  concurrent_session_mode text not null default 'allow',
  concurrent_session_max  integer not null default 3,
  two_factor_enabled      integer not null default 0,
  remember_me             integer not null default 1,
  ip_mode                 text not null default 'any',
  allowed_ip_list         text not null default '[]',
  schedule_enabled        integer not null default 0,
  schedule_days           text not null default '[]',
  schedule_from           text,
  schedule_to             text,
  license_total           integer,
  license_expiry          text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Non-sensitive configuration only. Secrets belong in Worker secrets.
create table if not exists system_settings (
  id            text primary key,
  setting_key   text not null unique,
  setting_value text not null default '{}',
  updated_by    text references users(id),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create index if not exists idx_wfsteps_wf on workflow_steps(workflow_id, step_no);
create index if not exists idx_wfactions_entity on workflow_actions(entity_type, entity_id, created_at desc);

insert or ignore into system_policy (id) values (1);
