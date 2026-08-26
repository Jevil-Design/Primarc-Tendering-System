/* Vercel Node.js Function — catch-all for /api/*, reached via the explicit
   "/api/:path*" rewrite in vercel.json (NOT the filesystem [...path] bracket
   convention: that generates a routes-manifest entry — ^/api/([^/]+)$ — that
   only matches a single path segment, so anything with an extra slash, like
   /api/auth/login, 404s. This handler already reads the full path itself
   from request.url, so it doesn't need Vercel's route param at all.

   Node.js runtime, not Edge: @vercel/blob's SDK depends on `undici`, which
   needs real Node builtins (node:stream, node:net, node:tls, ...) that the
   Edge Runtime doesn't provide — Vercel's bundler rejects it outright
   ("referencing unsupported modules") if this file declares
   `runtime: 'edge'`. Nothing else here needs Edge specifically: backend/
   only touches Web APIs (fetch, Request/Response, WebCrypto), all of which
   Node 18+ also provides natively, so it works unchanged either way.

   backend/ is an unmodified copy of the Cloudflare Worker's src/: it exports
   the same `{ fetch(request, env) }` shape and only ever touches storage
   through `env.DB` / `env.DOCUMENTS` — the two bindings below are what got
   re-homed onto Turso and Vercel Blob. */
import worker from '../backend/index.js';
import { DB } from './_lib/db.js';
import { DOCUMENTS } from './_lib/storage.js';

function buildEnv() {
  return {
    DB,
    DOCUMENTS,
    ENVIRONMENT: process.env.ENVIRONMENT || 'production',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '',
    SESSION_IDLE_MINUTES: process.env.SESSION_IDLE_MINUTES || '30',
    SESSION_ABSOLUTE_HOURS: process.env.SESSION_ABSOLUTE_HOURS || '12',
    COOKIE_SECURE: process.env.COOKIE_SECURE || 'true',
    SESSION_PEPPER: process.env.SESSION_PEPPER,
    BOOTSTRAP_TOKEN: process.env.BOOTSTRAP_TOKEN,
  };
}

/* Vercel's Node.js runtime hands the handler a Request whose `.url` is a
   relative path ("/api/health?path=health") — unlike Edge, where it's
   always absolute. backend/index.js and router.js both do `new URL
   (request.url)`, which throws on a relative string. Rather than touch
   backend/ (kept as an unmodified, portable mirror), patch just the `.url`
   getter here via a Proxy — every other property (headers, method, body,
   .json(), ...) stays bound to the real request, untouched. */
function withAbsoluteUrl(request) {
  if (/^https?:\/\//i.test(request.url)) return request;
  const host = request.headers.get('host') || request.headers.get('x-forwarded-host');
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const absoluteUrl = new URL(request.url, `${proto}://${host}`).toString();
  return new Proxy(request, {
    get(target, prop, receiver) {
      if (prop === 'url') return absoluteUrl;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/* A default `(req, res)` export puts Vercel's Node.js runtime into its
   legacy Node-handler mode: `req` is a plain `http.IncomingMessage` (headers
   as a bare object, no `.json()`/`.headers.get()`), and a returned Response
   is silently ignored — Vercel's own runtime warns exactly this and points
   at exporting a named `fetch` function instead, which gets a real
   Web-standard Request/Response, Node.js builtins and all. */
export function fetch(request) {
  return worker.fetch(withAbsoluteUrl(request), buildEnv());
}
