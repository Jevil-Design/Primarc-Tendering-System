# localStorage → Cloudflare D1 migration

**The application now uses Cloudflare D1 as the central source of truth.**
Verified end-to-end against the live D1 (see *Testing results* below): two
independent clients shared the same data through the Worker, and authentication,
user management and permissions all read/write D1.

---

## 1. What was actually wrong

The Cloudflare backend (D1 + 17 REST route modules + R2 + auth) and the REST
client (`cloudflare-api.js` → `window.CloudflareAPI`) already existed. The app
never used them because:

1. **The bridge was missing.** The HTML calls `window.TSApi.*` for auth, user
   management and data sync, but `TSApi` was never defined — the `api-store.js`
   that was meant to define it did not exist. Every `if(API())` branch was dead,
   so the app silently ran on `localStorage`.
2. **Server auth never worked.** `auth.js` used **210,000** PBKDF2 iterations;
   the Cloudflare Workers runtime rejects anything above **100,000**, so login,
   bootstrap and password-change all threw `500` on the Worker. This is almost
   certainly why the frontend was never wired up.

Both are fixed. The migration is a **bridge, not a rewrite** — the UI is
untouched except for one `<script>` tag and a 2-line data hook.

## 2. Persistent data found & where it now lives

| Browser store (key) | Data | Now |
|---|---|---|
| `qm_data_v2` (the `DB` blob) | quotations/enquiries, work orders, vendor master, notifications, deleted, seq | **D1** — shared `/app-state` document (source of truth) |
| `ts_users` | user accounts | **D1** `users` table via `/users` |
| `ts_perms` | role→permission matrix | **D1** `system_settings.ui_perms` |
| `ts_login_hist` | login history | **D1** `audit_logs` via `/audit` |
| `ts_session` | session | **D1** `sessions` + httpOnly `ts_sid` cookie |
| `ts_theme`, `boq_find_collapsed`, column widths, `boq_ai_*`, `boq_aic_*` cache, `aiStudioFavs` | UI prefs / AI cache | **kept local** (correct — not authoritative) |

## 3. Database (D1)

No new tables were invented. The 38-table normalised schema in
`cloudflare/worker/migrations/001…018_*.sql` already models projects, vendors,
BOQ, enquiries, quotations, work orders, purchase orders, comparison, etc.

The live app's shared dataset is stored as **one row in the existing
`system_settings` table** under key `app_state_v1` (JSON document, versioned).
No migration/new table was needed for it. The normalised tables remain the
structured/reporting layer and the target of `/migrate/import`.

## 4. New / changed API routes

- **`GET /app-state`** — returns the shared tender document + version (any signed-in user).
- **`PUT /app-state`** — saves it with optimistic-concurrency (`baseVersion`); a stale write is refused with **409** and the server copy attached, so no computer clobbers another.

All other routes pre-existed (`/auth/*`, `/users`, `/rbac/*`, `/settings`,
`/projects`, `/vendors`, `/enquiries`, `/work-orders`, `/migrate/import`, …).

## 5. Files changed

| File | Change |
|---|---|
| `cloudflare/worker/src/auth.js` | PBKDF2 iterations 210000 → **100000** (Workers cap) — the fix that makes auth work |
| `cloudflare/worker/src/routes/app-state.js` | **new** — shared-state GET/PUT with conflict guard |
| `cloudflare/worker/src/index.js` | register the new route |
| `cloudflare/worker/wrangler.toml` | production `ALLOWED_ORIGINS` → the real frontend origin |
| `api-store.js` + `web/api-store.js` | **new** — the `window.TSApi` bridge (auth, users, perms, data sync) |
| `Tendering System.html` + `web/index.html` | one `<script src="api-store.js">` tag; `saveDB()` pushes to D1; `window.__tsHooks` exposes DB to the bridge |
| `web/api-url.js`, `make-web.sh`, `cloudflare-api.js` | API URL fixes; copy `api-store.js`; preserve `server.js`/`_routes.json` on rebuild |
| `.env.example` | corrected API URL + secret notes |

## 6. Environment / secrets

Frontend: `CLOUDFLARE_API_URL` (set automatically by `web/api-url.js`).
Worker (`cloudflare/worker/.dev.vars` locally; `wrangler secret put … --env production` for prod):
- `SESSION_PEPPER` — random 32-byte hex (recommended; sessions work without it, with less entropy).
- `BOOTSTRAP_TOKEN` — only to create the first admin; leave unset afterwards. **The first admin already exists in your D1**, so you do not need this for production.

## 7. Local development

```bash
# Terminal 1 — frontend (http://localhost:8000)
node web/server.js

# Terminal 2 — API bound to the real D1 (http://localhost:8787)
cd "cloudflare/worker" && npx wrangler dev --remote --port 8787
```

`web/api-url.js` auto-points the app at `localhost:8787` when opened on
localhost. Log in with your admin account.

> Local D1 (`wrangler dev` without `--remote`) currently fails on this machine
> with an "internal error" — the `.wrangler` state dir sits under a OneDrive
> path with spaces. `--remote` (real D1) is used instead and is the correct
> target anyway.

## 8. Production deployment

```bash
# 1. Deploy the API (auth fix + /app-state). From cloudflare/worker:
cd "cloudflare/worker" && npx wrangler deploy --env production

# 2. (recommended) set the session secret on the deployed Worker:
npx wrangler secret put SESSION_PEPPER --env production

# 3. Deploy the frontend. From the repo root:
npx wrangler deploy
```

Frontend origin: `https://primarc-tendering-system.suvojt740.workers.dev`
API origin: `https://primarc-tendering-api.suvojt740.workers.dev`
(These already match `ALLOWED_ORIGINS`.)

## 9. Database migration commands

The schema is already applied to your remote D1. To (re)apply or inspect:

```bash
cd "cloudflare/worker"
npx wrangler d1 migrations apply primarc-tendering --remote   # apply schema
npx wrangler d1 execute primarc-tendering --remote --command "select count(*) from users"
```

To import your **existing browser localStorage** tender data into the
normalised tables (optional; the live app already syncs via /app-state), open
the app on the computer that holds the data and run in the console:
`await CFMigrate.dryRun()` then `await CFMigrate.run()`.

## 10. Manual Cloudflare dashboard steps

None required for the code to work — everything is `wrangler`-driven. Optionally,
in **Workers & Pages → the API Worker → Settings**, confirm the D1 binding
`primarc-tendering` and R2 binding `primarc-tendering-documents` are present
(they are, since the API already runs).

## 11. Testing results (against the live D1)

- ✅ Bootstrapped the first admin; **login** returns `{user, permissions}` + cookie; **`/auth/me`** round-trips.
- ✅ **`PUT /app-state`** seeds (v1); **stale write → 409** with server copy attached (data-loss guard).
- ✅ Browser (empty localStorage) **pulled** the server-seeded enquiry on load — data came from D1, not the browser.
- ✅ Browser **created** an enquiry → `saveDB` → pushed to D1 (v2); read back independently via the API. → **two clients, one dataset.**
- ✅ **User management**: create → list (role mapped) → delete, all against D1.

## 12. Remaining limitations / next steps

- **Whole-document sync, last-write-wins per save.** The live app syncs the
  `DB` blob as one versioned document; concurrent edits on the *same* save
  window resolve by 409-reload, not field-level merge. For the current team size
  this is safe; field-level/normalised per-entity sync is the documented next
  step (the normalised tables + `/migrate/import` already exist for it).
- **Document size.** The blob lives in one D1 row; extremely large datasets
  (many MB) should move to R2 — the `documents`/R2 plumbing already exists.
- **BOQ-master custom items & vendor logos** (`tnd_master_custom_v1`,
  `boq_vendor_logos`) are not yet in `/app-state`; they remain local for now.
- **RBAC.** The Worker enforces its own `is_admin`/designation permissions on
  every route (defense in depth); the UI's 6-role×8-flag matrix is stored
  centrally in `system_settings` and is UI-gating.
- **First-load seeding.** The first client to load seeds the shared document
  from its localStorage; migrate from the computer holding the authoritative
  data first. The shared document is currently empty, ready for that seed.
