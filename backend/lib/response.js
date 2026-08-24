/* Consistent envelopes. Every route returns through these so the frontend has
   exactly one shape to handle: { success, data } or { success, error }. */

export const CORS_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';

/** Echoes the request origin only when it is on the allow-list. */
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With, X-Bootstrap-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  // Credentials are cookies, so a wildcard origin is both unsafe and rejected
  // by browsers. Only an exact match is echoed back.
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Credentials'] = 'true';
  }
  return h;
}

export function json(data, { status = 200, request, env, headers = {} } = {}) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(request ? corsHeaders(request, env) : {}),
      ...headers,
    },
  });
}

export function fail(code, message, { status = 400, request, env, details } = {}) {
  return new Response(JSON.stringify({ success: false, error: { code, message, ...(details ? { details } : {}) } }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(request ? corsHeaders(request, env) : {}),
    },
  });
}

/** Thrown anywhere in a handler; the router turns it into a fail() envelope. */
export class ApiError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const errors = {
  unauthorized: (m = 'Please sign in to continue.') => new ApiError('UNAUTHORIZED', m, 401),
  forbidden:    (m = 'You do not have permission to perform this action.') => new ApiError('FORBIDDEN', m, 403),
  notFound:     (m = 'That record could not be found.') => new ApiError('NOT_FOUND', m, 404),
  conflict:     (m = 'That record already exists.', d) => new ApiError('CONFLICT', m, 409, d),
  validation:   (m = 'Some fields need attention.', d) => new ApiError('VALIDATION', m, 422, d),
  locked:       (m = 'This record is locked and cannot be changed.') => new ApiError('LOCKED', m, 423),
  rateLimit:    (m = 'Too many attempts. Please wait and try again.') => new ApiError('RATE_LIMIT', m, 429),
  internal:     (m = 'Something went wrong. Please try again.') => new ApiError('INTERNAL', m, 500),
};
