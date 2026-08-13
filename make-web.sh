#!/usr/bin/env bash
# Assembles web/ — the folder Cloudflare Pages deploys.
# Run from the project root:  ./make-web.sh
set -euo pipefail

OUT="web"
API_URL="${1:-https://primarc-tendering-api.workers.dev/api}"

rm -rf "$OUT"
mkdir -p "$OUT"

# The app itself. Pages serves index.html at the root.
cp "Tendering System.html" "$OUT/index.html"

# App modules the page loads by relative path.
for f in cloudflare-api.js cloudflare-migration.js vendor-master.js \
         erp-admin.js erp-admin-2.js support.js; do
  [ -f "$f" ] && cp "$f" "$OUT/" || echo "  skip (not present): $f"
done

# Where the API lives. Loaded before cloudflare-api.js.
cat > "$OUT/api-url.js" <<EOF
/* Edit this after deploying the Worker — it is the only place the URL appears. */
window.CLOUDFLARE_API_URL = '$API_URL';
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
