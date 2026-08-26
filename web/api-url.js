/* The one place the API URL is set.
   Frontend and API are now one Vercel project on one origin (web/ served as
   static output, /api/* served by api/handler.js) — a relative path is
   correct for `vercel dev`, preview deployments and production alike. */
(function () {
  window.CLOUDFLARE_API_URL = '/api';
})();
