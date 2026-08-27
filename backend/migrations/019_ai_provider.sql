-- ═══════════════════════════════════════════════════════════════
-- 019 · Shared AI provider config (BOQ description enhancement)
--
-- Previously each user pasted their own API key into browser localStorage
-- and the browser called the AI provider directly. This centralises it:
-- one org-wide key, entered once by an admin, used by everyone.
--
-- The key never leaves this table -- no route ever returns api_key in a
-- response body or an audit log entry; only the POST /ai/call proxy reads
-- it internally to sign the outbound request to the provider.
-- ═══════════════════════════════════════════════════════════════
create table if not exists ai_provider_config (
  id          text primary key,
  provider    text not null,
  model       text not null,
  api_key     text not null,
  updated_by  text references users(id),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
