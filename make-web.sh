#!/usr/bin/env bash
# Assembles web/ — the static output Vercel deploys (outputDirectory in
# vercel.json). Run from the project root:  ./make-web.sh
set -euo pipefail

OUT="web"

# server.js lives only in web/ (a local-dev helper, not generated from
# source) — preserve it across the rebuild.
TMP="$(mktemp -d)"
for keep in server.js; do [ -f "$OUT/$keep" ] && cp "$OUT/$keep" "$TMP/"; done
rm -rf "$OUT"
mkdir -p "$OUT"
for keep in server.js; do [ -f "$TMP/$keep" ] && cp "$TMP/$keep" "$OUT/"; done
rm -rf "$TMP"

# The app itself. Pages serves index.html at the root.
cp "Tendering System.html" "$OUT/index.html"

# App modules the page loads by relative path. api-store.js is the adapter that
# defines window.TSApi (central D1 storage); its <script> tag is already in the
# source HTML, so it only needs copying here.
for f in cloudflare-api.js cloudflare-migration.js api-store.js vendor-master.js \
         erp-admin.js erp-admin-2.js support.js; do
  [ -f "$f" ] && cp "$f" "$OUT/" || echo "  skip (not present): $f"
done

# Where the API lives. Loaded before cloudflare-api.js. Frontend and API are
# one Vercel project on one origin, so a relative path is always correct.
cat > "$OUT/api-url.js" <<'EOF'
/* The one place the API URL is set.
   Frontend and API are now one Vercel project on one origin (web/ served as
   static output, /api/* served by api/[...path].js) — a relative path is
   correct for `vercel dev`, preview deployments and production alike. */
(function () {
  window.CLOUDFLARE_API_URL = '/api';
})();
EOF

# Inject the api-url.js tag ahead of cloudflare-api.js, once.
if ! grep -q 'api-url.js' "$OUT/index.html"; then
  python3 - "$OUT/index.html" <<'EOF'
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
needle = '<script src="cloudflare-api.js">'
tag = '<script src="api-url.js"></script>\n'
if needle in s:
    s = s.replace(needle, tag + needle, 1)
    io.open(p, 'w', encoding='utf-8').write(s)
    print("  injected api-url.js before cloudflare-api.js")
else:
    print("  WARNING: cloudflare-api.js tag not found — add api-url.js by hand")
EOF
fi

echo
echo "web/ ready:"
ls -la "$OUT"
echo
echo "Next:  set the URL in web/api-url.js, then commit web/ and push."
