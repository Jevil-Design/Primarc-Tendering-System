# The failed build, and what fixes it

```
✘ [ERROR] Could not detect a directory containing static files
          (e.g. html, css and js) for the project
Failed: error occurred while running deploy command
```

## What the log actually says

```
Cloning repository...
No build output detected to cache. Skipping.
No dependencies detected to cache. Skipping.
Executing user deploy command: npx wrangler deploy
```

Three separate problems, stacked:

1. **The repository is empty.** `Jevil-Design/Tendering-System@main` holds one
   file — a 44-byte `README.md`. Cloudflare cloned it, looked for HTML, found
   none. Nothing downstream can work until the code is pushed.
2. **No wrangler config at the root.** `npx wrangler deploy` ran in the repo
   root, where there was no `wrangler.toml` — it lives in `cloudflare/worker/`.
   With no config, wrangler 4 assumes a static site and reports the error above.
3. **Two things are being deployed as one.** This project is an API *and* a
   frontend. They need separate Cloudflare projects; one build cannot make both.

---

## Already fixed in this project

| Problem | Fix |
|---|---|
| No static-file directory | `web/` now exists — `index.html` plus the five app modules and `api-url.js` |
| No root config | `wrangler.toml` added at the root: an assets-only Worker named `tendering-system`, serving `./web` |
| API URL scattered | `web/api-url.js` is the one place it is set; it loads before the page's built-in default and overrides it |
| Deep links 404 | `not_found_handling = "single-page-application"` |

Your existing deploy command — `npx wrangler deploy`, unchanged — now works,
because there is finally a config and a directory for it to find.

---

## What you still have to do

### 1 · Push the code

Follow `PUSH.md`. Until `git push` succeeds, Cloudflare has nothing to build.
`web/` must be committed — a git-connected build can only deploy what is in the
repository, so it is deliberately **not** git-ignored.

### 2 · Replace the database id

In `cloudflare/worker/wrangler.toml`, swap
`REPLACE_WITH_YOUR_D1_DATABASE_ID` for the id printed by:

```bash
wrangler d1 create primarc-tendering
```

It appears in **two** blocks — dev near the top, production near the bottom.
Replace both. With the placeholder left in, the deploy succeeds and then every
request returns 500.

### 3 · Deploy the API as its own project

Dashboard → **Workers & Pages** → the API Worker → **Settings → Builds**:

| Field | Value |
|---|---|
| Root directory | `cloudflare/worker` |
| Build command | *(empty)* |
| Deploy command | `npx wrangler deploy --env production` |

**Root directory** is the field that matters — it is what brings the API's
`wrangler.toml` into scope. Note the URL this prints.

### 4 · Point the frontend at it, and the API back at the frontend

Two edits, then commit both:

```js
// web/api-url.js
window.CLOUDFLARE_API_URL = 'https://<your-api>.workers.dev/api';
```

```toml
# cloudflare/worker/wrangler.toml → [env.production.vars]
ALLOWED_ORIGINS = "https://tendering-system.<your-subdomain>.workers.dev"
```

This is circular by nature — each side needs the other's URL — so it takes two
rounds of deploys. **Do not skip the `ALLOWED_ORIGINS` edit.** If the origin
does not match character for character, login appears to succeed while the
session cookie is silently dropped, which a user experiences as being logged
straight back out.

---

## Regenerating web/

`web/` is a copy, so it goes stale when you edit `Tendering System.html`:

```bash
./make-web.sh                                   # default API URL
./make-web.sh https://my-api.workers.dev/api    # or pass your own
```

Then commit `web/` again.

---

## Why not serve both from one Worker

You could — an assets Worker can also run server code. But then the UI and the
API redeploy together, and a broken frontend build takes the API down with it.
Kept apart, you can redeploy the UI freely while a working API keeps running.
Two projects, one repository.
