/* The one place the API URL is set.
   Served locally (localhost / 127.0.0.1) it targets the local wrangler dev
   Worker; anywhere else it targets the deployed production API. This keeps a
   single committed file correct for both local dev and deployment. */
(function () {
  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  window.CLOUDFLARE_API_URL = local
    ? 'http://localhost:8787/'
    : 'https://primarc-tendering-api.suvojt740.workers.dev/api';
})();
