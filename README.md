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
| File storage | Vercel Blob (private store), streamed through the API — never a public URL |
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
  handler.js                   Vercel Edge Function entry — wires env into backend/
  _lib/db.js                   D1-shaped adapter over Turso/libSQL
  _lib/storage.js               R2-shaped adapter over Vercel Blob (private store)

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
and document download authorisation all live in `backend/`. A patched frontend cannot
raise its own approval limit or read a document it lacks permission for —
downloads stream through the API rather than via presigned URLs that would
outlive the permission that issued them.

---

## GSTIN verification

`POST /api/gst/verify` (`backend/routes/gst.js`) is the only thing that talks to the
GST provider; the key stays in env vars and never reaches the browser.

Two states are kept strictly apart, and the UI labels them differently:

| | Meaning | Sets `gstVerified` |
|---|---|---|
| **Format valid** | 15 chars, correct layout and check digit. Computed locally. | no |
| **Verified** | The configured provider confirmed the registration is `ACTIVE`/`PROVISIONAL`. | yes |

A cancelled, suspended, inactive or not-found GSTIN returns a definite answer but is
never marked verified — and neither is anything imported from Excel. **With no
provider configured the endpoint returns `PROVIDER_UNCONFIGURED`; it does not fall
back to treating a valid format as verified.**

### What you need to configure

Verification is inactive until you set these (see `.env.vercel.example` for the full
notes and per-provider examples):

| Variable | Required | Notes |
|---|---|---|
| `GST_API_PROVIDER` | yes | `masters_india` \| `sandbox` \| `surepass` \| `custom` |
| `GST_API_KEY` | yes | Your provider account's key/token |
| `GST_API_SECRET` | provider-dependent | Client id or secret, where the provider uses one |
| `GST_API_URL` / `_METHOD` / `_HEADERS` / `_BODY` / `_FIELD_MAP` | for `custom` | Also override any preset field |
| `GST_CACHE_DAYS` | no (30) | Reuse window for a successful verification |
| `GST_RATE_LIMIT_PER_HOUR` | no (120) | Per-user cap on live provider calls |

You need a commercial account with a GST verification provider — the government GST
portal has no open public API. The three presets are starting points; confirm the
current request/response contract against your provider's own docs. A wrong field
path surfaces as an explicit mapping error (`GST_API_FIELD_MAP`), never as a false
"verified".

Caching lives in `gst_verifications`, and every attempt — success or failure — is
appended to `gst_verification_log`, which also backs the per-user rate limit.
Credentials are written to neither. Apply migration `020_gst_verification.sql`
(or re-run `schema.sql`, which stays idempotent) before enabling this.

Tests: `npm test` (`backend/gst.test.mjs`, 29 cases — no framework needed).

---

## Deploy

Full instructions, including the first-admin bootstrap and the Turso/Blob
store setup, are in [VERCEL-DEPLOY.md](./VERCEL-DEPLOY.md).
