import { json, fail, corsHeaders, ApiError } from './lib/response.js';

/* ═══════════════════════════════════════════════════════════════
   Tiny path router. No dependencies — this runs on the edge and every
   kilobyte of bundle is startup latency.

   Routes are registered as ('GET', '/vendors/:id', handler). Params land in
   ctx.params, query in ctx.query, parsed body in ctx.body.
   ═══════════════════════════════════════════════════════════════ */

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler, opts = {}) {
    const names = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:[A-Za-z_]\w*/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; }) + '$'
    );
    this.routes.push({ method, regex, names, handler, opts });
    return this;
  }

  get(p, h, o)    { return this.add('GET', p, h, o); }
  post(p, h, o)   { return this.add('POST', p, h, o); }
  put(p, h, o)    { return this.add('PUT', p, h, o); }
  patch(p, h, o)  { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, path) {
    let pathExists = false;
    for (const r of this.routes) {
      const m = path.match(r.regex);
      if (!m) continue;
      pathExists = true;
      if (r.method !== method) continue;
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathExists ? { methodMismatch: true } : null;
  }
}

export async function handle(router, request, env, ctxExtra) {
  const url = new URL(request.url);
  let path = url.pathname.replace(/^\/api/, '') || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const hit = router.match(request.method, path);
  if (!hit) return fail('NOT_FOUND', 'No such endpoint.', { status: 404, request, env });
  if (hit.methodMismatch) {
    return fail('METHOD_NOT_ALLOWED', `${request.method} is not supported here.`, { status: 405, request, env });
  }

  const query = Object.fromEntries(url.searchParams.entries());
  let body = {};
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    const type = request.headers.get('Content-Type') || '';
    if (type.includes('application/json')) {
      try { body = await request.json(); }
      catch { return fail('BAD_JSON', 'The request body was not valid JSON.', { status: 400, request, env }); }
    } else if (type.includes('multipart/form-data')) {
      body = await request.formData();          // documents.js handles uploads
    }
  }

  const ctx = { request, env, url, path, query, body, params: hit.params, ...ctxExtra };

  try {
    const result = await hit.route.handler(ctx);
    if (result instanceof Response) return result;
    return json(result === undefined ? null : result, { request, env });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, { status: err.status, request, env, details: err.details });
    }
    // D1 surfaces constraint violations as plain errors; translate the common ones.
    const msg = String(err?.message || '');
    if (/UNIQUE constraint failed/i.test(msg)) {
      const field = (msg.match(/UNIQUE constraint failed: [\w]+\.(\w+)/) || [])[1];
      return fail('CONFLICT',
        field ? `A record with that ${field.replace(/_/g, ' ')} already exists.` : 'That record already exists.',
        { status: 409, request, env });
    }
    if (/FOREIGN KEY constraint failed/i.test(msg)) {
      return fail('CONFLICT', 'A linked record is missing or still in use.', { status: 409, request, env });
    }
    if (/CHECK constraint failed/i.test(msg)) {
      return fail('VALIDATION', 'One of the values is not allowed.', { status: 422, request, env });
    }
    console.error('[worker]', request.method, path, err);
    return fail('INTERNAL', 'Something went wrong. Please try again.', { status: 500, request, env });
  }
}

export const preflight = (request, env) =>
  new Response(null, { status: 204, headers: corsHeaders(request, env) });
