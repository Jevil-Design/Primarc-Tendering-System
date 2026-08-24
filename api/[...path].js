/* Vercel Edge Function — catch-all for /api/*.

   backend/ is an unmodified copy of the Cloudflare Worker's src/: it exports
   the same `{ fetch(request, env) }` shape and only ever touches storage
   through `env.DB` / `env.DOCUMENTS`. Vercel's Edge Runtime is, like Workers,
   plain Web APIs (fetch, Request/Response, WebCrypto) with no Node globals,
   which is what let backend/ move over with zero code changes — only the two
   bindings below had to be re-homed onto Turso and R2-over-S3. */
export const config = { runtime: 'edge' };

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

export default function handler(request) {
  return worker.fetch(request, buildEnv());
}
