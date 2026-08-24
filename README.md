# Primarc Tendering System

Construction tendering and procurement — BOQ build-up, vendor enquiry, quotation
comparison, work orders and purchase orders, with role-based approval limits and
an append-only audit trail.

Single-page frontend, with the API deployable to either Vercel (primary —
see `VERCEL-DEPLOY.md`) or Cloudflare Workers (`CLOUDFLARE-README.md`). Both
share the same route/auth/permission logic; only the two storage bindings
differ.

---

## Stack

| Layer | Vercel (`api/`, `backend/`) | Cloudflare (`cloudflare/worker/`) |
|---|---|---|
| Frontend | One HTML file, vanilla JS, no build step | (same) |
| API | Vercel Edge Function | Cloudflare Worker |
| Database | Turso (libSQL, SQLite-compatible) | Cloudflare D1 (SQLite) — 39 tables, 2 views |
| File storage | Cloudflare R2, via its S3 API | Cloudflare R2, via a Workers binding |
| Auth | Session cookie (HttpOnly, SameSite), PBKDF2-SHA256 @ 100 000 iterations | (same) |
| Hosting | Vercel | Cloudflare Pages |

No build step for the frontend either way. `backend/` is an unmodified copy
of `cloudflare/worker/src/` — see `VERCEL-DEPLOY.md` for what changed and why.

---

## Layout

```
Tendering System.html        the application — 9 638 lines
Backend Structure.dc.html    visual map: lifecycle, schema, 101-endpoint route map
cloudflare-api.js            frontend API adapter (falls back to localStorage)
cloudflare-migration.js      CFMigrate — one-shot localStorage → D1 import
vendor-master.js             vendor master data module
erp-admin.js, erp-admin-2.js admin modules
CLOUDFLARE-README.md         setup, security model, testing checklist

cloudflare/worker/
  wrangler.toml              D1 + R2 bindings, vars, production env
  schema.sql                 all 18 migrations, idempotent, one command
  migrations/                18 ordered .sql files
  src/
    index.js                 fetch entry — fail-closed session gate
    router.js                path router, body parsing, D1 error translation
    auth.js                  sessions, password hashing
    permissions.js           designation permissions + per-user overrides
    validation.js            field rules → 422 with the field named
    audit.js                 append-only audit_logs writer
    lib/                     response envelope, ids, doc sequences
    routes/                  17 modules, 101 endpoints
```

---

## Data model

39 tables across organisation, identity, RBAC, masters (projects, vendors,
materials), BOQ, rate analysis, enquiry, quotations, award (WO/PO) and governance.

Vendor comparison is a **view**, not a table — ranking is
`row_number() over (partition by enquiry_item_id order by amount)`, so the
on-screen sheet, the Excel export and bid analysis cannot disagree about who is L1.

Quote revisions and audit logs are append-only: a vendor's earlier price stays
provable after a lock.

---

## Enforced server-side

Approval ceilings, permission checks, session expiry (30 min idle / 12 h absolute)
and R2 download authorisation all live in the Worker. A patched frontend cannot
raise its own approval limit or read a document it lacks permission for —
downloads stream through the Worker rather than via presigned URLs that would
outlive the permission that issued them.

---

## Deploy

Full instructions, including the first-admin bootstrap and the data import, are in
[CLOUDFLARE-README.md](./CLOUDFLARE-README.md). Short version:

```bash
cd cloudflare/worker && npm install
wrangler d1 create primarc-tendering          # paste database_id into wrangler.toml (both blocks)
wrangler r2 bucket create primarc-tendering-documents
wrangler d1 execute primarc-tendering --remote --file=./schema.sql
wrangler secret put SESSION_PEPPER
wrangler secret put BOOTSTRAP_TOKEN
wrangler deploy --env production
```

Then deploy the frontend to Pages and set `ALLOWED_ORIGINS` in
`wrangler.toml` to that exact Pages origin — never `*`. The API is cookie
authenticated; a wildcard origin with credentials is rejected by browsers anyway.

> **Status:** the backend is written and internally consistent but has **not been
> deployed or run** — no query has executed against D1. Use a throwaway database
> for the first deploy and work through the testing checklist.
