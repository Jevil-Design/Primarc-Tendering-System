# Audit Report — Primarc Tendering System

**Date:** 31 Oct 2026 · **Scope:** `web/` (frontend), `backend/` + `api/` (API), sync layer, exports
**Backup taken first:** branch `backup/pre-audit-2026-10-31` (the code as it was, including the uncommitted `web/index.html` edits). Nothing was committed after it — every change below is in the working tree for review.

**Readiness: Ready with limitations** (see §H).

---

## A. Module summary

| Module | Before | After | How verified |
|---|---|---|---|
| Data sync / persistence | **FAIL** — four separate ways to lose saved work (B1–B4) | PASS | Browser E2E (offline, reload-while-unsent, two computers) + 10 unit tests |
| Comparative Statement / L1–L3 | **FAIL** — rates shift onto wrong items after an edit; a partial bid ranks L1; mixed GST basis | PASS | Browser E2E against the real backend |
| Approvals → Work Order | **FAIL** — WO went to the live L1, not the awarded vendor; could be issued twice; approval survived rate changes | PASS | Browser E2E |
| BOQ Builder exports | **FAIL** — Excel base total double-counted sections; 0 % GST exported as 18 %; "1,250" priced as 1 | PASS | Browser E2E (files parsed back) |
| BOQ draft / revisions | FAIL — older/empty drafts could overwrite newer work; revisions lost on reload | Fixed | Code-traced; not separately browser-tested |
| Vendor Master | FAIL — deleted/renamed vendors reappeared; legacy GSTINs blocked editing; search froze | PASS | Browser E2E + screen smoke |
| ERP Admin → users | **FAIL** — create/lock/reset/delete only changed this browser ("success" with no effect) | PASS (account actions) | Browser: lock → server status `suspended` → sign-in refused |
| Backend security | FAIL — admin takeover, PO approval bypass, settings back door, CSRF, lost-update race | PASS | Unit/integration tests + live checks |
| Every screen renders | — | PASS (15 screens, 0 page errors) | Browser smoke |
| Comparison Sheet Builder / Tender Analysis | **BLOCKED** — their HTML is not in the page (only the JS remains) | Guarded | See §G |
| Live Vercel / Turso / Blob | **BLOCKED** — no credentials in this environment | — | Same code verified on local libSQL with the production `schema.sql` |

---

## B. Bug register (fixed)

Severity: C = Critical, H = High, M = Medium. "E2E" = proven in Chrome against the real backend; "Test" = automated unit/integration test.

| # | Sev | Area | Bug | Root cause | Fix | Verified |
|---|---|---|---|---|---|---|
| B1 | C | Sync | Edits made while a save was in flight were never sent | `doPush()` dropped a second request unless it was "forced" | Queue a follow-up push | E2E |
| B2 | C | Sync | "Retrying…" shown, but nothing retried | No retry existed | Real backoff (2 s → 60 s) + retry on reconnect; honest "Offline" state | E2E |
| B3 | C | Sync | Unsent changes overwritten by the server copy on reload | `resync()` always adopted the server copy | Unsent flag survives reloads; unsent work is pushed or merged, never discarded | E2E |
| B4 | C | Sync | Two people saving → the second person's work silently thrown away, even on different enquiries | Whole-document "server wins" on conflict | Record-level 3-way merge (`web/sync-merge.js`); a true same-record clash keeps the server copy and saves yours to a downloadable recovery list | E2E + 10 tests |
| B5 | C | API | Two simultaneous saves could both "succeed", one erased | Version check and write were separate statements | Atomic compare-and-swap on the version | Test + real SQLite |
| B6 | H | API | Logout/"force" save overwrote everything others saved since | Missing `baseVersion` meant "overwrite" | Missing version now means "expect empty"; never overwrites | Test |
| B7 | C | Enquiry | Editing an enquiry (delete/insert/reorder items) moved every vendor's rates onto the wrong items | Rates stored by row position, re-cut by position | Rates carried across by item id (also rollback & cloud submissions) | E2E (original issued a ₹7,64,500 WO instead of ₹3,10,000) |
| B8 | H | CS | Vendor who priced 1 item of 10 ranked L1 and "recommended" | Ranking compared partial totals | Complete bids rank first; partial bids labelled with unpriced count; ties flagged | E2E |
| B9 | M | CS | With "Include GST" on, L1 / highest / savings / deviation mixed bases (negative savings possible) | Ranking used incl. GST, figures used base | One basis everywhere (screen + PDF), labelled | E2E |
| B10 | H | WO | WO issued to whoever is L1 now, not the awarded vendor | `woGenerate` ignored the award | Uses the awarded vendor; requires full approval | E2E |
| B11 | H | WO | Same enquiry could get two WOs; numbers re-used after a delete | No guard; count-based numbering | One WO per enquiry; monotonic numbering | E2E |
| B12 | H | Approval | Rates/award changed after sign-off, approval stayed "approved" | No link between approval and figures | Approval fingerprints the figures; any change restarts it (history kept) | E2E |
| B13 | M | Approval/Audit | Every approval logged as "Admin" | Hard-coded name | Records the signed-in user | E2E |
| B14 | M | Portal | Awarded vendor could re-price; due date not enforced | Missing checks | Revisions closed after award or due date (admin override kept) | Code-traced |
| B15 | C | BOQ Excel | BASE TOTAL counted every section twice (thrice nested) | `SUM` over a column that also holds section subtotals | `SUMIF` excluding section rows; values stored with formulas | E2E |
| B16 | H | BOQ export | 0 % GST exported as 18 % (CSV, Excel, PDF) | `r.gst \|\| 18` | Uses the row's real GST | E2E |
| B17 | H | BOQ | "1,250" or "₹500" priced as 1 or 0 | `parseFloat` stops at a comma | `bNum()` parses Indian/₹/Rs. formats (BOQ, import, paste, builder) | E2E |
| B18 | M | BOQ Excel | Excel files showed blank amounts in previewers | Formulas stored without values | Cached values written | E2E |
| B19 | M | BOQ CSV | Section rows had 13 columns against 12 headers | Extra field | Fixed | E2E |
| B20 | H | BOQ draft | An older draft or stale tab overwrote newer work; Transfer/Clear re-created a cleared draft | Unconditional 25 s autosave; offline copy ignored on restore | Save only when changed; newer offline copy preferred | Code-traced |
| B21 | M | BOQ | Loading a crafted `.boq.json` could run script (stored XSS) | `sid` written into HTML unescaped | IDs renumbered on load | Code-traced |
| B22 | M | BOQ import | Real items "Total Station…", "Project signage…" silently dropped | Over-broad summary-row filter | Filter only true summary rows | Code-traced |
| B23 | M | BOQ | Revisions lost on reload; label off by one | Not persisted | Stored with the draft; numbering fixed | Code-traced |
| B24 | H | Vendor Master | Deleted or renamed vendors reappeared instantly | Auto-seed from enquiry history | Deletions remembered; renames kept as aliases (history stays linked) | E2E |
| B25 | M | Vendor Master | Editing any legacy vendor (even a phone number) blocked by GSTIN rules | Validation ran on unchanged GSTIN | Validate only when GSTIN/PAN changes | Code-traced |
| B26 | M | Vendor Master | Typing a duplicate GSTIN inline erased the vendor's own GSTIN | Overwrite before duplicate check | Check first | Code-traced |
| B27 | M | Vendor Master | Search re-ranked every enquiry once per vendor per keystroke | O(vendors × enquiries) | One pass per render + debounce | Smoke |
| B28 | H | ERP Admin | Create/lock/reset/delete users changed only this browser | Wrote to `localStorage`, not the API | Routed to the server; list reloaded from it | E2E (locked user can't sign in) |
| B29 | H | API | Non-admin with Administration "edit" could reset an admin's password and take over | No target-is-admin check | Only admins can modify/disable/delete admins | Syntax + review |
| B30 | H | API | PO could be set "approved" through PUT, skipping approval limits | `status` writable via PUT | Removed; approved POs locked | Review |
| B31 | H | API | `POST /settings` could overwrite the whole tender dataset | Deny-list applied to reads only | Applied to writes | Review |
| B32 | M | API | Rate-blind user's save erased quotes of enquiries in the Deleted bin | Only live enquiries guarded | Both lists guarded | 2 tests |
| B33 | M | API | CSRF on state-changing routes | Cookie sent cross-site, no Origin check | Origin must be this site or `ALLOWED_ORIGINS` | Test + live |
| B34 | M | API | Login lockout bypassable with parallel guesses | Read-modify-write counter | Atomic increment in SQL | Review |
| B35 | M | API | Vendor portal: rates changed after submission without a revision; deadline not enforced | Missing checks | Both enforced | Review |
| B36 | M | Portal | Vendor link tokens predictable | `Math.random` | `crypto.getRandomValues` | E2E |
| B37 | M | Builder | Adding/removing a vendor with a section row threw mid-way, misaligning rates | Section rows have no `rates` | Guarded; tied L1s all exported; Excel header merges fixed | Smoke |
| B38 | L | Exports | CSV formula injection (`=HYPERLINK(…)`) | No neutralising | `csvCell()` on all CSV exports | Review |
| B39 | M | Import dialog | "Import Vendor Enquiry" failed silently | Fed a screen no longer in the page | Tab hidden while that screen is absent; clear message | Smoke |
| B40 | L | Docs | `nosniff` missing on document downloads | — | Added | Review |

---

## C. Files changed

| File | Why |
|---|---|
| `web/sync-merge.js` *(new)* | Record-level merge + fingerprints (B4) |
| `web/sync-merge.test.mjs` *(new)* | 10 merge tests |
| `web/api-store.js` | Sync rewrite: queueing, retry, unsent-across-reload, merge, recovery list, unload warning (B1–B4, B6); user `status` exposed |
| `web/index.html` | B7–B27, B36–B39; save-status pill states; `sync-merge.js` script tag |
| `web/erp-admin-2.js` | ERP Admin account actions go to the server (B28) |
| `backend/routes/app-state.js` | Atomic version CAS; no blind overwrite (B5, B6) |
| `backend/routes/users.js` | Admin-protection (B29) |
| `backend/routes/purchase-orders.js` | B30 |
| `backend/routes/org.js` | B31 |
| `backend/lib/state-acl.js` | B32 |
| `backend/index.js` | CSRF Origin check (B33) |
| `backend/auth.js` | Atomic lockout counter (B34) |
| `backend/routes/quotations.js` | B35 |
| `backend/routes/documents.js` | B40 |
| `backend/app-state-route.test.mjs`, `backend/state-acl.test.mjs` | +6 regression tests; test stub understands the CAS statement |
| `scripts/local-server.mjs` *(new)* | Full stack locally on SQLite — no Vercel/Turso needed |
| `tests/e2e/*` *(new)* | Browser suite: workflow (35 checks) + screens (22 checks) |
| `package.json` | `npm test` also runs `web/**/*.test.mjs` |
| `.gitignore` | `.local/` (local server's default DB) |

No database schema change. No new environment variables.

---

## D. Test results (all actually run)

| Check | Command | Result |
|---|---|---|
| Unit + integration | `npm test` | **72 / 72 pass** (baseline before work: 56 / 56) |
| Syntax | `node --check` on every `.js/.mjs`; inline `<script>` blocks compiled | All pass |
| Real database | backend on local libSQL with `backend/schema.sql`: bootstrap, login, save v1→v2, stale save → 409 | Pass |
| Browser workflow | `node tests/e2e/run.mjs` (Chrome, real backend) | **35 / 35** — 0 page errors |
| Screens / admin / CSRF | same runner | **22 / 22** |
| Same workflow on the **original** code | backup branch | **19 checks fail** — confirms the suite detects these bugs |

Workflow covered: sign-in → enquiry with 3 items → 3 vendors → quotes (one missing item, one tie) → comparative statement → save → reload from server with browser cache wiped → delete an item → 5-stage approval → change after approval → award → WO → duplicate WO refused → CS export CSV/XLSX/PDF → BOQ export Excel/CSV parsed back → offline edit → back online → reload with an unsent change → two computers editing different and the same record → vendor delete.

Not run: anything against live Vercel/Turso/Blob, the GST provider, AI providers, Power Automate/Apps Script cloud forms (no credentials).

---

## E. Workflow improvements

- **Saving is trustworthy.** The status pill now tells the truth: *Saving… / Saved / Offline (kept on this computer) / Retrying… / Conflict*. Changes are never silently dropped; a closed tab with unsent work warns first.
- **Teams can work in parallel.** Two people on different enquiries no longer overwrite each other. A real clash on the same record keeps the server copy and offers **Download mine**.
- **Comparison you can act on.** Partial bids and ties are called out in plain words instead of producing a misleading L1. One commercial basis throughout.
- **Award → WO is controlled.** WO follows the award, requires completed approval, can't be duplicated, and approvals restart automatically if figures change.
- **Less re-typing.** Pasting "1,25,000.50" or "₹500" just works; renamed vendors keep their bid history; legacy vendor records can be edited without fighting the GSTIN rules.

---

## F. Deployment

1. Review the diff, then commit and push as usual — Vercel builds from the repo (`VERCEL-DEPLOY.md`). **No new env vars, no migration.**
2. If any deployment serves the frontend from a different origin than the API (e.g. the older Cloudflare Pages + Worker setup), list that frontend origin in `ALLOWED_ORIGINS`, or state-changing requests will now get 403. Same-origin Vercel needs nothing.
3. After deploying, ask users to reload open tabs once. An old tab still running the previous code is protected (its save is refused with 409 and it reloads the server copy) but anything unsent in it is not merged.
4. Local full stack for testing: `node scripts/local-server.mjs` (prints the first-admin bootstrap command). Browser suite: `npm install --no-save puppeteer-core@23` then `node tests/e2e/run.mjs`.
5. The Cloudflare Worker copy of the backend (`cloudflare/worker/src`) is not in this checkout. If that deployment is still in use elsewhere, port the `backend/` changes to it.

---

## G. Remaining issues

**Business decisions to confirm** (implemented the conservative option; easy to change):
1. **Partial bids** rank after complete bids. Alternative QS practice: load each missing item at the highest rate quoted by others, then rank.
2. **A rate of 0** counts as "not quoted" (existing rule). Confirm whether 0 can mean "included".
3. **Ranking basis** defaults to base (ex-GST); the CS toggle switches to incl. GST for screen and PDF. Confirm the default.
4. Approval restart on any change to quantities, rates or award — confirm this matches policy.

**Not fixed — known, lower priority:**
- CS CSV/Excel exports have no L-rank columns and number rows flat; print view lacks section formatting.
- BOQ Excel/CSV round-trip is not lossless (notes, sub-headers, Rate-Only/LS/PS types); only `.boq.json` is. "Item No." columns can be read as names; multi-line Excel cells split on paste.
- Seed vendor data: 247 vendors share 56 GSTINs (13 fail checksum). Needs a data clean-up; bulk GST verify should de-duplicate.
- ERP Admin: departments, designations, project access, workflows and photos are still stored per browser (no server columns). Per-user "force logout" isn't available server-side.
- Comparison Sheet Builder and Tender Analysis: JS present, screens absent. Decide restore or remove.
- Security (low): forced password change not enforced server-side; empty `SESSION_PEPPER` falls back silently; PBKDF2 at 100k iterations; `/ai/call` has no rate limit; authorisation is per module, not per project.
- Portal OTP "verified" flag is stored in shared data; vendor revision history snapshots are positional.
- Logging out leaves a cached copy of the data in that browser (shared computers).
- Architecture: the whole tender dataset is one JSON document and the page embeds a 13 MB catalogue (loads in ~1 s locally). Fine at current scale; plan a move to the existing normalised tables / server-side catalogue search before data grows much.

---

## H. Readiness

**Ready with limitations.** Every critical data-loss, calculation, ranking and security defect found is fixed and verified — 72 automated tests, 57 browser checks against the real backend on the production schema, and the same browser suite failing 19 checks on the original code. Limits: not exercised against the live Vercel/Turso/Blob stack (no credentials here), the business rules in §G need sign-off, and the lower-priority items above remain open.
