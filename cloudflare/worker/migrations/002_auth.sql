-- ═══════════════════════════════════════════════════════════════
-- 002 · Users and sessions
--
-- password_hash holds "pbkdf2$<iterations>$<salt_b64>$<hash_b64>".
-- PBKDF2-SHA256 via WebCrypto is used rather than bcrypt: Workers have no
-- native bindings, and a pure-JS bcrypt is both slow and CPU-time limited.
-- 210,000 iterations follows current OWASP guidance for PBKDF2-SHA256.
--
-- password_hash is never selected into an API response — see users.js.
-- ═══════════════════════════════════════════════════════════════

create table if not exists users (
  id             text primary key,
  username       text not null unique collate nocase,
  email          text unique collate nocase,
  password_hash  text not null,
  full_name      text not null default '',
  employee_id    text unique,
  phone          text,
  designation_id text references designations(id) on delete set null,
  department_id  text references departments(id)  on delete set null,
  company_id     text references companies(id)    on delete set null,
  branch_id      text references branches(id)     on delete set null,
  status         text not null default 'active' check (status in ('active','inactive','suspended')),
  is_admin       integer not null default 0 check (is_admin in (0,1)),
  must_change_password integer not null default 0 check (must_change_password in (0,1)),
  failed_attempts integer not null default 0,
  locked_until   text,
  password_changed_at text,
  password_set_by text not null default 'admin' check (password_set_by in ('self','admin')),
  last_login     text,
  legacy_id      text unique,
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at     text
);

-- Opaque session tokens. Only a SHA-256 of (token + pepper) is stored, so a
-- database dump cannot be replayed as a live session. Not a JWT: revoking a
-- user must take effect immediately, not at token expiry.
create table if not exists sessions (
  id           text primary key,
  token_hash   text not null unique,
  user_id      text not null references users(id) on delete cascade,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   text not null,
  absolute_expires_at text not null,
  ip           text,
  user_agent   text,
  revoked_at   text
);

create index if not exists idx_users_email on users(email);
create index if not exists idx_users_username on users(username);
create index if not exists idx_users_status on users(status);
create index if not exists idx_sessions_user on sessions(user_id);
create index if not exists idx_sessions_expiry on sessions(expires_at);
