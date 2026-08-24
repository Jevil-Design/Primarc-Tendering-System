# Deploying to Vercel

The app moves from Cloudflare (Pages + Workers + D1 + R2) to a single Vercel
project: `web/` served as static output, `/api/*` served by one Edge
Function. Nothing in `backend/` (copied from `cloudflare/worker/src/`, itself
untouched) had to be rewritten — only the two storage bindings did:

| Was (Cloudflare) | Now (Vercel) | Why |
|---|---|---|
| D1 (binding) | **Turso / libSQL** | SQLite-compatible — `schema.sql` and every query in `backend/routes/*.js` work unchanged |
| R2 (binding) | **R2, via its S3 API** | Same bucket, same files, no data migration — just a different way to reach it, since Vercel has no R2 binding |

`api/_lib/db.js` and `api/_lib/storage.js` are the only new backend code;
they present the same `prepare/bind/first/all/run/batch` and `put/get/delete`
shapes the Worker's bindings did.

---

## 1 · Turso database

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create primarc-tendering
turso db show primarc-tendering --url          # -> TURSO_DATABASE_URL
turso db tokens create primarc-tendering       # -> TURSO_AUTH_TOKEN
```

Apply the schema (same file the Cloudflare setup used — one idempotent dump
of all 18 migrations):

```bash
turso db shell primarc-tendering < cloudflare/worker/schema.sql
```

### Migrating existing data out of D1

Skip this if there's nothing in the live D1 database worth keeping yet.
Otherwise, both are SQLite, so a straight dump/load works:

```bash
wrangler d1 export primarc-tendering --remote --output=d1-export.sql
turso db shell primarc-tendering < d1-export.sql
```

Sanity-check row counts on both sides afterwards (`select count(*) from users`,
`vendors`, `boqs`, ...).

---

## 2 · R2 API token (S3-compatible access)

The bucket stays exactly where it is — `primarc-tendering-documents` — and no
file needs to move. Vercel just reaches it over R2's S3-compatible endpoint
instead of a Workers binding:

Cloudflare dashboard → **R2 → Manage R2 API Tokens → Create API Token**, with
Object Read & Write scoped to `primarc-tendering-documents`. Note down:

- Account ID (top-right of the R2 dashboard) → `R2_ACCOUNT_ID`
- Access Key ID → `R2_ACCESS_KEY_ID`
- Secret Access Key → `R2_SECRET_ACCESS_KEY`

---

## 3 · Vercel project

```bash
npm install -g vercel
vercel link
```

Set the environment variables from `.env.vercel.example` in the dashboard
(**Settings → Environment Variables**) — `TURSO_DATABASE_URL`,
`TURSO_AUTH_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `SESSION_PEPPER`, and
`BOOTSTRAP_TOKEN` (temporarily — see below).

```bash
vercel --prod
```

`vercel.json` points `outputDirectory` at `web/`; `api/[...path].js` (an Edge
Function) handles everything under `/api/*` automatically — no rewrite needed
for it, only the SPA fallback that sends unknown paths to `index.html`.

### First administrator

Same bootstrap flow as before:

```bash
curl -X POST https://<your-project>.vercel.app/api/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  -d '{"username":"admin","email":"you@primarc.in","fullName":"Administrator","password":"<strong>"}'
```

Then remove `BOOTSTRAP_TOKEN` from the Vercel env vars — the endpoint also
refuses once any admin exists.

### Verify

```bash
curl https://<your-project>.vercel.app/api/health         # {"success":true,...}
```

In the browser: sign in, open the console, `await CloudflareAPI.probe()` →
`{ ok: true, kind: 'ready' }`. (The adapter file is still named
`cloudflare-api.js` / `window.CloudflareAPI` — cosmetic only, left as-is to
keep the diff small; it now talks to `/api` on the same Vercel origin.)

---

## 4 · Local development

```bash
vercel dev
```

Serves `web/` and `/api/*` together on one local origin, matching production
— `web/api-url.js` always points at the relative `/api`, so no per-environment
URL juggling is needed.

---

## Notes

- **CORS mostly stops mattering.** Frontend and API share one origin now, so
  `ALLOWED_ORIGINS` / cookie `SameSite` only matter if you serve the frontend
  from somewhere else too. `corsHeaders()` in `backend/lib/response.js` is
  unchanged and harmless either way.
- **`backend/` is the source of truth for API logic** going forward; keep
  `cloudflare/worker/src/` only if you intend to keep the Cloudflare Worker
  running in parallel. They will drift once one is edited and not the other.
- **Regenerating `web/`** after editing `Tendering System.html`: `./make-web.sh`
  (no argument needed anymore — it always emits a relative `/api`).
- Everything in `CLOUDFLARE-README.md` about the security model (PBKDF2
  iterations, session cookie design, fail-closed auth, permission checks
  before every document read/write, append-only audit) is unchanged — only
  where the bytes physically live moved.
