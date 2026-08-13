/* ═══════════════════════════════════════════════════════════════
   Where the API lives.

   This file loads BEFORE index.html's built-in default, so whatever is set
   here wins. It is the only place you need to edit after deploying the Worker.

   Leave it as-is and the app falls back to localStorage (offline mode), which
   is useful for a smoke test of the UI before the backend is up.
   ═══════════════════════════════════════════════════════════════ */

window.CLOUDFLARE_API_URL = 'https://primarc-tendering-api.workers.dev/api';
