import { errors } from './lib/response.js';
import { newId, nowIso, ipOf, uaOf, publicUser } from './lib/util.js';

/* ═══════════════════════════════════════════════════════════════
   Passwords and sessions.

   PBKDF2-SHA256 via WebCrypto rather than bcrypt: Workers have no native
   bindings, and pure-JS bcrypt is slow enough to burn the CPU-time budget.

   Iterations are capped at 100,000: the Cloudflare Workers runtime rejects
   PBKDF2 requests above that ceiling ("iteration counts above 100000 are not
   supported"), so anything higher makes hashPassword/verifyPassword throw and
   breaks login, bootstrap and password changes. 100,000 is the platform max.
   The stored hash records its own iteration count, so verifyPassword keeps
   working if the ceiling is ever raised and the constant increased.

   Sessions are opaque random tokens in an httpOnly cookie. Only a SHA-256 of
   (token + pepper) is stored, so a database dump cannot be replayed. Not a JWT:
   disabling a user or revoking a session must take effect immediately.
   ═══════════════════════════════════════════════════════════════ */

const ITERATIONS = 100000;
const MAX_FAILED = 8;
const LOCK_MINUTES = 15;
export const COOKIE = 'ts_sid';

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function hashPassword(password, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  try {
    const salt = unb64(saltB64);
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: parseInt(iterStr, 10) }, key, 256);
    // Constant-time comparison.
    const a = new Uint8Array(bits), b = unb64(hashB64);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch { return false; }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const tokenHash = (token, env) => sha256Hex(token + '|' + (env.SESSION_PEPPER || ''));

export function generateTemporaryPassword(len = 12) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export function sessionCookie(token, env, maxAgeSeconds) {
  const secure = env.COOKIE_SECURE === 'true';
  const parts = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    // SameSite=None is required when the API and Pages app are on different
    // subdomains; it demands Secure, which is why the two travel together.
    secure ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearCookie = (env) =>
  `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; ${env.COOKIE_SECURE === 'true' ? 'SameSite=None; Secure' : 'SameSite=Lax'}`;

export function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function createSession(env, userId, request) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const idle = parseInt(env.SESSION_IDLE_MINUTES || '30', 10) * 60000;
  const absolute = parseInt(env.SESSION_ABSOLUTE_HOURS || '12', 10) * 3600000;
  const now = Date.now();

  await env.DB.prepare(
    `insert into sessions (id, token_hash, user_id, expires_at, absolute_expires_at, ip, user_agent)
     values (?, ?, ?, ?, ?, ?, ?)`
  ).bind(newId(), await tokenHash(token, env), userId,
         new Date(now + Math.min(idle, absolute)).toISOString(),
         new Date(now + absolute).toISOString(),
         ipOf(request), uaOf(request)).run();

  return { token, maxAge: Math.floor(absolute / 1000) };
}

/**
 * Validates the cookie, enforces idle + absolute expiry, slides the window,
 * and returns the user. Returns null rather than throwing so public routes can
 * call it too.
 */
export async function resolveSession(env, request) {
  const token = readCookie(request, COOKIE);
  if (!token) return null;

  const th = await tokenHash(token, env);
  const row = await env.DB.prepare(
    `select s.id as sid, s.expires_at, s.absolute_expires_at, u.*
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = ? and s.revoked_at is null`
  ).bind(th).first();
  if (!row) return null;

  const now = Date.now();
  if (now > Date.parse(row.expires_at) || now > Date.parse(row.absolute_expires_at)) {
    await env.DB.prepare('update sessions set revoked_at = ? where id = ?')
      .bind(nowIso(), row.sid).run();
    return null;
  }
  if (row.status !== 'active' || row.deleted_at) {
    await env.DB.prepare('update sessions set revoked_at = ? where id = ?')
      .bind(nowIso(), row.sid).run();
    return null;
  }

  const idle = parseInt(env.SESSION_IDLE_MINUTES || '30', 10) * 60000;
  const nextExpiry = Math.min(now + idle, Date.parse(row.absolute_expires_at));
  await env.DB.prepare('update sessions set last_seen_at = ?, expires_at = ? where id = ?')
    .bind(nowIso(), new Date(nextExpiry).toISOString(), row.sid).run();

  const { sid, expires_at, absolute_expires_at, ...user } = row;
  return { sessionId: sid, user };
}

export async function revokeSession(env, request) {
  const token = readCookie(request, COOKIE);
  if (!token) return;
  await env.DB.prepare('update sessions set revoked_at = ? where token_hash = ?')
    .bind(nowIso(), await tokenHash(token, env)).run();
}

export const revokeAllForUser = (env, userId) =>
  env.DB.prepare('update sessions set revoked_at = ? where user_id = ? and revoked_at is null')
    .bind(nowIso(), userId).run();

/** Username or email, plus lockout handling. */
export async function login(env, request, identifier, password) {
  const id = String(identifier || '').trim().toLowerCase();
  const row = await env.DB.prepare(
    'select * from users where (lower(username) = ? or lower(email) = ?) and deleted_at is null'
  ).bind(id, id).first();

  // Always spend comparable time so a missing user is not distinguishable.
  if (!row) {
    await hashPassword(password || 'x');
    throw errors.unauthorized('Incorrect username or password.');
  }
  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    throw errors.unauthorized(`Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`);
  }
  if (row.status !== 'active') {
    throw errors.unauthorized('This account has been disabled. Contact an administrator.');
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    const failed = (row.failed_attempts || 0) + 1;
    const lock = failed >= MAX_FAILED;
    await env.DB.prepare('update users set failed_attempts = ?, locked_until = ? where id = ?')
      .bind(lock ? 0 : failed, lock ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null, row.id)
      .run();
    throw errors.unauthorized('Incorrect username or password.');
  }

  await env.DB.prepare('update users set failed_attempts = 0, locked_until = null, last_login = ? where id = ?')
    .bind(nowIso(), row.id).run();

  const session = await createSession(env, row.id, request);
  return { user: publicUser(row), session };
}
