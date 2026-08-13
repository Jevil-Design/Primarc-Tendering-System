repo: Jevil-Design/Tendering-System
branch: main

## Last sync

date: 2026-08-13T07:10:14Z

Nothing was pulled and no screen was rebuilt — **there is nothing upstream to pull.**
The repository has been reset to a bare skeleton: one file, `README.md` (44 bytes,
title and one line of description). The 82 files present at the 9 Aug sync — every
JS module, both deploy folders, the whole NestJS backend, the Supabase stack — are
all gone from `main`.

Access was also briefly lost before this sync: `main` and `master` both 404'd until
the GitHub App was reinstalled. Read succeeded immediately afterwards.

### Updated in this project
- Upstream is now effectively empty (1 file). Every screen and module in this project is local-only and untracked; the repo is a destination, not a source.
- No file was overwritten or reintroduced. Pulling would have deleted working code, so nothing was applied.
- `## Screen map` rewritten: no project screen is backed by an upstream file any more.
- No `commit:` recorded — the tree call resolves a tree hash, not a commit sha. Record one on the first real push.

## State — initial push required

The repository no longer mirrors this project in any part. What needs to go up, in
one initial commit:

| Local | Notes |
|---|---|
| `Tendering System.html` | the app, 9 638 lines — was never tracked upstream (size) |
| `cloudflare/worker/**` | 47 files: 18 D1 migrations, `schema.sql`, 17 route modules, auth/RBAC/audit/validation, `wrangler.toml` |
| `cloudflare-api.js`, `cloudflare-migration.js` | frontend adapter + `CFMigrate` import tool |
| `Backend Structure.dc.html` | visual map of the backend — lifecycle, schema, 101-endpoint route map |
| `CLOUDFLARE-README.md`, `.env.example` | setup, test checklist, `CLOUDFLARE_API_URL` |
| `vendor-master.js`, `erp-admin.js`, `erp-admin-2.js`, `support.js` | app modules |
| `github-deploy/**` | Pages mirror — stale, regenerate before pushing |

Deliberately **not** pushed: `server/**` (NestJS/MongoDB), `cloud/**` (Apps Script),
`uploads/**`. All unreferenced dead code; the Supabase and Netlify stacks are already
deleted locally and no longer exist upstream either — that divergence resolved itself
when the repo was reset.

## Screen map

| Project screen / module | Repo files |
|---|---|
| App shell — Home, Create BOQ, Comparison, BOQ Master, Quotation Mgmt | *(local only — `Tendering System.html`)* |
| Vendor master data | *(local only — `vendor-master.js`)* |
| Admin / ERP modules | *(local only — `erp-admin.js`, `erp-admin-2.js`)* |
| Backend structure map | *(local only — `Backend Structure.dc.html`)* |
| Database schema (D1) | *(local only — `cloudflare/worker/migrations/**`, `schema.sql`)* |
| API routes, auth, RBAC, audit | *(local only — `cloudflare/worker/src/**`)* |
| Frontend API adapter + data migration | *(local only — `cloudflare-api.js`, `cloudflare-migration.js`)* |
| DC runtime support | *(local only — `support.js`)* |
| GitHub Pages deployment | *(local only — `github-deploy/**`)* |
| — | `README.md` — the only tracked file |

## Notes

- Treat the next push as an initial commit, not a merge: upstream history no longer contains this project's work.
- `Tendering System.html` has never been tracked (14 MB at the time of the first sync). Decide whether it goes in or stays a build artefact copied into `github-deploy/` at deploy time.
- If the reset was accidental, the old files may still be recoverable from a pre-reset commit or the reflog before pushing over `main`.

## Sync history

**2026-08-09T04:10:41Z** — Nothing pulled; upstream was *behind* the project. All 82
tracked files compared. `server/public/api-store.js` read larger upstream (12,733 B vs
12,091 B) but matched on every behaviour marker — formatting only. Upstream still
carried the Supabase stack (33 files) and `netlify-deploy/`, both deleted locally, and
had no Cloudflare files at all.

**2026-08-08T07:48:09Z** — Verified the repo mirrored the app's JS modules, both deploy
folders and the full NestJS backend. Noted that no `.html` was tracked upstream, and
that local `api-store.js`, `state/keys.ts` and `state.controller.ts` were ahead of
upstream (sessionStorage-receiver fix, terminal-403 handling, per-key write permissions).
