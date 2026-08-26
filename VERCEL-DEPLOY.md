# Deploying to Vercel

The app is a single Vercel project: `web/` served as static output, `/api/*`
served by one Edge Function (`api/handler.js`). `backend/` holds all API
logic; only two storage bindings differ from a typical Cloudflare Worker
setup:

| Was (Cloudflare) | Now (Vercel) | Why |
|---|---|---|
| D1 (binding) | **Turso / libSQL** | SQLite-compatible — `schema.sql` and every query in `backend/routes/*.js` work unchanged |
| R2 (binding) | **Vercel Blob** (private store) | Same private-storage model — files are only ever streamed through this server, never a public URL — with no external account or manual API token: OIDC auth is automatic once a store is connected |

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

No CLI for your platform (e.g. Windows)? Use the [Turso dashboard](https://turso.tech)
instead — create a database there, and its page shows the URL plus a
**Create Token** button.

Apply the schema (one idempotent dump of all 18 migrations):

```bash
turso db shell primarc-tendering < backend/schema.sql
```

Individual ordered migration files are also kept under `backend/migrations/`
if you'd rather apply them one at a time, or via the dashboard's SQL console
if the CLI isn't available.

---

## 2 · Vercel Blob store (file storage)

No external account, no manual API token:

1. Project → **Storage** tab → **Create Database** → **Blob**
2. Set access to **Private** (documents must never be reachable by a bare
   URL — `backend/routes/documents.js` always checks permissions before
   streaming a file back, which only works if reads require auth)
3. Connect the store to this project (Production + Preview; add Development
   too if you want `vercel dev` to work locally)

That's it — Vercel adds `BLOB_STORE_ID` and `VERCEL_OIDC_TOKEN` to the
project automatically, and `api/_lib/storage.js` authenticates with them.

---

## 3 · Vercel project

```bash
npm install -g vercel
vercel link
```

Set the remaining environment variables from `.env.vercel.example` in the
dashboard (**Settings → Environment Variables**) — `TURSO_DATABASE_URL`,
`TURSO_AUTH_TOKEN`, `SESSION_PEPPER`, and `BOOTSTRAP_TOKEN` (temporarily —
see below).

```bash
vercel --prod
```

`vercel.json` points `outputDirectory` at `web/` and rewrites `/api/:path*`
to `api/handler.js` explicitly — Vercel's own filesystem-based catch-all
route detection for a bracket-named file (`[...path].js`) generates a
routes-manifest entry that only matches a single path segment outside
Next.js, so a plain-named handler reached via an explicit rewrite is used
instead. The second rewrite rule is the SPA fallback that sends unknown
non-`/api` paths to `index.html`.

### First administrator

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
curl https://<your-project>.vercel.app/api/health         # {"success":true,"data":{"ok":true,...}}
```

In the browser: sign in, open the console, `await CloudflareAPI.probe()` →
`{ ok: true, kind: 'ready' }`. (The adapter file is still named
`cloudflare-api.js` / `window.CloudflareAPI` — cosmetic only, left as-is to
keep the diff small; it now talks to `/api` on the same Vercel origin.)

---

## 4 · Local development

```bash
vercel env pull   # pulls TURSO_*, SESSION_PEPPER, and the Blob store's OIDC token
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
- **`backend/` is the sole source of truth for API logic.**
- **Regenerating `web/`** after editing `Tendering System.html`: `./make-web.sh`
  (no argument needed anymore — it always emits a relative `/api`).
- The security model (PBKDF2 iterations, session cookie design, fail-closed
  auth, permission checks before every document read/write, append-only
  audit) lives in `backend/` and is unchanged by this deploy target — only
  where the bytes physically live moved.
