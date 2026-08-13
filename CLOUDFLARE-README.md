# Cloudflare Backend — Primarc Tendering System

Workers + D1 + R2. Replaces localStorage with a real database, server-enforced
RBAC, approval limits and an append-only audit trail.

> **Status: written and internally consistent, but NOT yet deployed or run.**
> I have no Cloudflare access from here — no `wrangler`, no D1, no way to
> execute a query. Section 49 of your brief says not to claim success without
> testing, so I am not claiming it. Deploy to a throwaway D1 first and work the
> testing checklist; expect to fix a few things on the first run.

---

## A. What exists

**39 tables, 2 views** across 18 migrations.

| Area | Tables |
|---|---|
| Organisation | companies, branches, departments, designations |
| Identity | users, sessions |
| RBAC | modules, permissions, user_permission_overrides |
| Core | projects, vendors, materials, doc_sequences |
| BOQ | boq_master_items, boq_master_rates, boqs, boq_items, boq_drafts |
| Rate analysis | rate_analyses, rate_analysis_components |
| Enquiry | enquiries, enquiry_items, enquiry_vendors |
| Quotations | vendor_quote_lines, vendor_quote_terms, vendor_quote_revisions |
| Award | bid_analysis, work_orders, work_order_items, purchase_orders, purchase_order_items |
| Governance | notifications, audit_logs, workflows, workflow_steps, workflow_actions |
| System | system_policy, system_settings, documents |

**Views** — `vendor_comparison_view` (item-wise L1…Ln), `vendor_total_ranking_view`.

Comparison is a **view, not a table**: ranking is `row_number() over (partition
by item order by amount)`, so the sheet, the exports and bid analysis cannot
disagree. An approval decision is made from that number.

---

## B. Relationships

```
companies ─┬─ branches ─┬─ users ── designations ── departments
           │            │              │
           │            │              └── permissions ── modules
           │            └── user_permission_overrides ── modules
           │
           └── projects ─┬── boqs ── boq_items ──┐
                         │                        │ POST /enquiries/transfer-from-boq
                         ├── enquiries ◄──────────┘
                         │      ├── enquiry_items
                         │      └── enquiry_vendors ── vendors
                         │             ├── vendor_quote_lines
                         │             ├── vendor_quote_terms
                         │             ├── vendor_quote_revisions  (append-only)
                         │             └── documents (R2)
                         │
                         ├── vendor_comparison_view   (L1/L2/L3…)
                         ├── bid_analysis
                         ├── work_orders ── work_order_items
                         └── purchase_orders ── purchase_order_items ── materials
```

---

## C. Deployment

```bash
npm install -g wrangler
wrangler login

cd cloudflare/worker
npm install

# 1 · D1 — paste the returned database_id into wrangler.toml (both places)
wrangler d1 create primarc-tendering

# 2 · R2
wrangler r2 bucket create primarc-tendering-documents

# 3 · Migrations — local first, then remote
wrangler d1 migrations apply primarc-tendering --local
wrangler d1 migrations apply primarc-tendering --remote

# 4 · Secrets (never in wrangler.toml)
openssl rand -hex 32                       # use the output below
wrangler secret put SESSION_PEPPER --env production
wrangler secret put BOOTSTRAP_TOKEN --env production

# 5 · Deploy
wrangler deploy --env production
```

Set `ALLOWED_ORIGINS` in `wrangler.toml` to your exact Pages origin.
A wildcard is not an option: these APIs are cookie-authenticated, and browsers
reject `*` with credentials anyway.

### First administrator

No admin password is seeded — shipping a known credential is the hole this
backend exists to close.

```bash
curl -X POST https://<your-worker>/api/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  -d '{"username":"admin","email":"you@primarc.in","fullName":"Administrator","password":"<strong>"}'
```

Then **clear the secret** — the endpoint also refuses once any admin exists:
`wrangler secret delete BOOTSTRAP_TOKEN --env production`

### Frontend (Pages)

```bash
wrangler pages project create primarc-tendering
wrangler pages deploy . --project-name primarc-tendering
```

Set the API URL before `cloudflare-api.js` loads:

```html
<script>window.CLOUDFLARE_API_URL = 'https://primarc-tendering-api.<subdomain>.workers.dev/api';</script>
```

### Verify

```bash
curl https://<your-worker>/api/health          # {"success":true,...}
wrangler d1 execute primarc-tendering --remote --command "select count(*) from modules"       # 15
wrangler d1 execute primarc-tendering --remote --command "select count(*) from permissions"   # 240
```

In the browser: `await CloudflareAPI.probe()` → `{ ok: true, kind: 'ready' }`.

---

## D. Migrating existing data

```js
CFMigrate.survey()          // what is in localStorage
CFMigrate.backup()          // download a JSON snapshot
await CFMigrate.dryRun()    // report only — writes nothing
await CFMigrate.run()       // perform the import
```

Counted per key: found / migrated / skipped / errors / needs-review.
**localStorage is never cleared** — run `CFMigrate.clearLocal()` only after
you have verified the data.

> **The namespace is `CFMigrate`.** It is the only migration tool loaded by the
> page; the Supabase build that once shared this slot has been removed.

**Users do not migrate.** The old client stored SHA-256 hashes; this backend
uses PBKDF2, and re-hashing a hash is not the same credential. Every existing
user is listed for re-invitation through Administration.

---

## D2. One-shot schema

`migrations/` is the ordered history — apply it file by file when you want the
steps auditable. `schema.sql` is the same 18 migrations concatenated into one
idempotent file (39 tables · 72 indexes · 27 triggers), for standing a database
up in a single command:

```bash
# remote (production D1)
wrangler d1 execute primarc-tendering --remote --file=./schema.sql
# local dev database
wrangler d1 execute primarc-tendering --local  --file=./schema.sql
```

Every statement is `create ... if not exists` / `insert or ignore`, so
re-running it against a live database is safe and changes nothing. Keep the two
in sync: a new migration file must also be appended to `schema.sql`.

---

## E. Security

**Passwords** — PBKDF2-SHA256, 210,000 iterations (OWASP guidance), via
WebCrypto. Not bcrypt: Workers have no native bindings and pure-JS bcrypt burns
the CPU budget. `password_hash` is never selected into a response — every user
query lists columns explicitly rather than `select *`.

**Sessions** — opaque 32-byte token in an httpOnly cookie; only a SHA-256 of
(token + pepper) is stored, so a database dump cannot be replayed. Not a JWT:
disabling a user or revoking a session takes effect immediately.

**Authorisation** — the router **fails closed**. Anything not in the explicit
`PUBLIC` list requires a live session, so forgetting to guard a new route
denies rather than exposes. Each handler then calls
`requirePerm(ctx, module, action)`.

**Approval limits** — `assertCanApprove()` reads the amount **from the
database**, never from the request body, then checks it against the caller's
designation ceiling. The old client checked this in JavaScript, which any user
could edit; it was advisory in practice.

**Vendor portal** — the sharpest edge. A vendor has no account, so the token
*is* the authorisation. Only its SHA-256 is stored. `/vendor-portal/load`
returns exactly one invite: that vendor's items, their own lines and terms.
Other vendors, other enquiries, users, audit and settings are never selected —
not filtered in the UI, absent from the query. On submit, each item id is
verified to belong to that enquiry, so a crafted payload cannot write elsewhere.

**R2** — buckets are private and bytes are never served directly. Downloads
stream through the Worker, which re-checks permission first. That is stricter
than a presigned URL, which outlives the permission that created it.

**Audit** — append-only. No update or delete path exists anywhere in the Worker.

**Quote immutability** — a locked quotation cannot be edited; revising writes a
new `vendor_quote_revisions` row and the prior snapshot stays exactly as
submitted.

---

## F. API

```
GET    /api/health

POST   /api/auth/login | logout | refresh | change-password | bootstrap
GET    /api/auth/me | sessions

GET    /api/users            POST /api/users          PATCH /api/users/:id
POST   /api/users/:id/reset-password
POST   /api/users/bulk/active | bulk/delete
GET    /api/rbac/modules | permissions | overrides/:userId
POST   /api/rbac/permissions | overrides
GET    /api/audit

GET    /api/org/companies | branches | departments | designations
GET    /api/settings         POST /api/settings

GET    /api/projects         POST /api/projects       PUT/DELETE /api/projects/:id
GET    /api/vendors | vendors/search | vendors/:id
POST   /api/vendors | vendors/bulk                    PUT/DELETE /api/vendors/:id
GET    /api/materials        POST /api/materials      PUT /api/materials/:id

GET    /api/boq-master       POST /api/boq-master | boq-master/bulk
GET    /api/boq-master/:id/rates                      POST /api/boq-master/:id/rates
GET    /api/boqs | boqs/:id  POST /api/boqs           PUT /api/boqs/:id
PUT    /api/boqs/:id/items
GET/PUT/DELETE /api/boq-draft

GET    /api/rate-analyses | :id                       POST /api/rate-analyses
PUT    /api/rate-analyses/:id/components

GET    /api/enquiries | enquiries/:id                 POST /api/enquiries
PUT    /api/enquiries/:id | :id/items
POST   /api/enquiries/transfer-from-boq
POST   /api/enquiries/:id/vendors                     DELETE .../vendors/:evId
POST   /api/enquiries/:id/vendors/:evId/link          → token, once
PUT    /api/enquiries/:id/vendors/:evId/lines
POST   /api/enquiries/:id/vendors/:evId/lock
GET    /api/enquiries/:id/vendors/:evId/revisions

POST   /api/vendor-portal/load | save | submit        (token, no session)

GET    /api/comparison/:enquiryId                     → L1…Ln
GET    /api/bid-analysis/:enquiryId                   POST /api/bid-analysis
POST   /api/bid-analysis/:id/accept

GET    /api/work-orders | :id   POST /api/work-orders
POST   /api/work-orders/from-enquiry | :id/approve | :id/reject
GET    /api/purchase-orders | :id  POST /api/purchase-orders
PUT    /api/purchase-orders/:id    POST /api/purchase-orders/:id/approve

GET    /api/notifications    POST /api/notifications/:id/read | read-all
GET    /api/documents        POST /api/documents/upload
GET    /api/documents/:id/download                    DELETE /api/documents/:id

POST   /api/migrate/import   (admin, dry-run capable)
```

Responses: `{ success: true, data }` or
`{ success: false, error: { code, message, details? } }`.

---

## G. Files

**New**
```
cloudflare/worker/wrangler.toml          bindings: DB (D1), DOCUMENTS (R2)
cloudflare/worker/.dev.vars.example
cloudflare/worker/migrations/001…018     schema + seed
cloudflare/worker/src/index.js           entry, fail-closed auth gate
cloudflare/worker/src/router.js          path router, error translation
cloudflare/worker/src/auth.js            PBKDF2, sessions, lockout
cloudflare/worker/src/permissions.js     effective rights, approval ceilings
cloudflare/worker/src/validation.js      server-side field validation
cloudflare/worker/src/audit.js           audit + notifications
cloudflare/worker/src/lib/{response,util}.js
cloudflare/worker/src/routes/*.js        17 route modules
cloudflare-api.js                        frontend adapter
cloudflare-migration.js                  localStorage → D1
```

**Modified** — `Tendering System.html`: three script tags. No UI, workflow,
calculation or export logic was changed.

---

## H. Testing checklist

Run against a **throwaway D1**, not production data.

**Deploy** — migrations apply 001→018; `/api/health` returns success;
modules = 15, permissions = 240.

**Auth** — bootstrap admin; sign in by username and by email; wrong password
rejected; 8 failures locks for 15 min; session survives reload; logout clears
it; disabled account refused; forced password change on first login.

**RBAC (the important one)** — sign in as QS Engineer: can create a BOQ and an
enquiry, cannot issue a work order. Then from the console call
`CloudflareAPI.workOrders.create({...})` directly and confirm it returns
**403** — that is the test that matters, because it proves the rule is not just
a hidden button. Repeat for Purchase and Accounts. Add a user override and
confirm it beats the designation default.

**Vendors** — search; create; add "ABC Enterprise" when "ABC ENTERPRISE" exists
→ reported as duplicate, not created; near miss returns `CONFLICT` with
`details.similar[]`; `force: true` overrides.

**BOQ** — create; save items with sections/notes/levels and confirm hierarchy
survives a reload; totals match; draft autosaves and restores on another
device; Excel/CSV import unchanged; exports unchanged.

**Enquiry** — create (number sequential and unique); transfer BOQ items; add
vendors; issue a link; open it in a private window; save draft; submit; revise
(new revision row, previous snapshot intact); lock.

**Comparison** — L1…L5 match the old sheet on the same data; ties stable;
amounts and GST unchanged.

**Approval** — approve within limit; exceed it and confirm **403** with the
limit named; check the audit entry.

**Work order** — generated from the approved vendor with correct vendor,
project, amounts, GST, terms; number sequential and unique.

**Security** — alter a vendor token and confirm nothing returns; confirm the
portal payload contains no other vendor; signed out, confirm
`fetch(API + '/enquiries')` returns 401.

**Failure handling** — go offline mid-edit: BOQ draft is retained locally and
syncs on reconnect; expired session shows a friendly message.

---

## I. Known gaps

1. **The UI still writes to localStorage.** This delivers the database, the
   security model and the full API layer, wired into the page — Phase 1 and 2
   of your ten. Repointing each screen (Phases 3–10) touches thousands of call
   sites across 14,000 lines and must go module by module with testing between,
   exactly as your brief specifies. Doing it blind in one pass would break the
   functionality you asked me to preserve. Order: Vendors → BOQ Master → BOQ →
   Enquiry → Quotations/Comparison → Work Orders/POs → Administration.

2. **Nothing has been executed.** No deployment, no migration run, no request
   served. The checklist above is the work, not a formality.

3. **Cloudflare is now the only database.** The Supabase stack (client SDK,
   adapters, 25 Postgres migrations, RLS policies, Edge Functions) and the
   Netlify deployment have been deleted, and the page no longer loads them.
   `server/` (NestJS/MongoDB) and `cloud/` (Apps Script) remain on disk as
   dead code — delete them when you are ready; nothing references them.
