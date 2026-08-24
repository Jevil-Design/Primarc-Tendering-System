# Primarc Tendering System

Construction tendering and procurement — BOQ build-up, vendor enquiry, quotation
comparison, work orders and purchase orders, with role-based approval limits and
an append-only audit trail.

Single-page frontend with a Vercel-hosted API — see `VERCEL-DEPLOY.md` for
full deploy instructions.

---

## Stack

| Layer | Detail |
|---|---|
| Frontend | One HTML file, vanilla JS, no build step |
| API | Vercel Edge Function (`api/`, `backend/`) |
| Database | Turso (libSQL, SQLite-compatible) — 39 tables, 2 views |
| File storage | Cloudflare R2, via its S3-compatible API |
| Auth | Session cookie (HttpOnly, SameSite), PBKDF2-SHA256 @ 100 000 iterations |
| Hosting | Vercel |

No build step for the frontend.

---

## Layout

```
Tendering System.html        the application — 9 638 lines
Backend Structure.dc.html    visual map: lifecycle, schema, 101-endpoint route map
cloudflare-api.js            frontend API adapter (falls back to localStorage)
cloudflare-migration.js      CFMigrate — one-shot localStorage → D1/Turso import
api-store.js                 defines window.TSApi on top of cloudflare-api.js
vendor-master.js             vendor master data module
erp-admin.js, erp-admin-2.js admin modules

api/
  [...path].js                Vercel Edge Function entry — wires env into backend/
  _lib/db.js                  D1-shaped adapter over Turso/libSQL
  _lib/storage.js              R2-shaped adapter using aws4fetch (S3 API)

backend/
  schema.sql                  all 18 migrations, idempotent, one command
  migrations/                 18 ordered .sql files
  index.js                    fetch entry — fail-closed session gate
  router.js                   path router, body parsing, D1/Turso error translation
  auth.js                     sessions, password hashing
  permissions.js               designation permissions + per-user overrides
  validation.js                field rules → 422 with the field named
  audit.js                     append-only audit_logs writer
  lib/                         response envelope, ids, doc sequences
  routes/                      17 modules, 101 endpoints
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
and R2 download authorisation all live in `backend/`. A patched frontend cannot
raise its own approval limit or read a document it lacks permission for —
downloads stream through the API rather than via presigned URLs that would
outlive the permission that issued them.

---

## Deploy

Full instructions, including the first-admin bootstrap and the Turso/R2 setup,
are in [VERCEL-DEPLOY.md](./VERCEL-DEPLOY.md).
