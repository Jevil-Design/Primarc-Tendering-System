import { json, errors } from '../lib/response.js';
import { login, revokeSession, revokeAllForUser, sessionCookie, clearCookie,
         hashPassword, verifyPassword, generateTemporaryPassword } from '../auth.js';
import { loadPermissions } from '../permissions.js';
import { validate, requirePassword } from '../validation.js';
import { logAudit } from '../audit.js';
import { publicUser, newId, nowIso } from '../lib/util.js';

export default function register(router) {
  router.post('/auth/login', async (ctx) => {
    const v = validate(ctx.body).string('username', { required: true, max: 120 })
                                .string('password', { required: true, max: 200 }).done();
    const { user, session } = await login(ctx.env, ctx.request, v.username, v.password);
    const permissions = await loadPermissions(ctx.env, user);

    await logAudit({ ...ctx, user }, { module: 'Authentication', action: 'login', entityType: 'users', entityId: user.id });

    return json({ user, permissions }, {
      request: ctx.request, env: ctx.env,
      headers: { 'Set-Cookie': sessionCookie(session.token, ctx.env, session.maxAge) },
    });
  });

  router.post('/auth/logout', async (ctx) => {
    if (ctx.user) await logAudit(ctx, { module: 'Authentication', action: 'logout', entityType: 'users', entityId: ctx.user.id });
    await revokeSession(ctx.env, ctx.request);
    return json({ ok: true }, { request: ctx.request, env: ctx.env, headers: { 'Set-Cookie': clearCookie(ctx.env) } });
  });

  /* Cheap poll used by the frontend to know whether it is still signed in.
     Public so it can answer "no" rather than 401-ing the whole app. */
  router.get('/auth/me', async (ctx) => {
    if (!ctx.user) return { user: null, permissions: {} };
    return { user: publicUser(ctx.user), permissions: ctx.permissions };
  });

  router.post('/auth/change-password', async (ctx) => {
    if (!ctx.user) throw errors.unauthorized();
    const v = validate(ctx.body).string('currentPassword', { max: 200 })
                                .string('newPassword', { required: true, max: 200 }).done();

    const row = await ctx.env.DB.prepare('select password_hash, must_change_password from users where id = ?')
      .bind(ctx.user.id).first();

    // A forced first-time change does not demand the temporary password again.
    if (!row.must_change_password) {
      const ok = await verifyPassword(v.currentPassword || '', row.password_hash);
      if (!ok) throw errors.unauthorized('Your current password is incorrect.');
    }

    const policy = await ctx.env.DB.prepare('select * from system_policy where id = 1').first();
    requirePassword(v.newPassword, policy || {});

    await ctx.env.DB.prepare(
      `update users set password_hash = ?, must_change_password = 0,
       password_set_by = 'self', password_changed_at = ? where id = ?`
    ).bind(await hashPassword(v.newPassword), nowIso(), ctx.user.id).run();

    // Every other session for this user is invalidated on a password change.
    await ctx.env.DB.prepare(
      'update sessions set revoked_at = ? where user_id = ? and id != ? and revoked_at is null'
    ).bind(nowIso(), ctx.user.id, ctx.sessionId).run();

    await logAudit(ctx, { module: 'Authentication', action: 'change_password', entityType: 'users', entityId: ctx.user.id });
    return { ok: true };
  });

  router.post('/auth/refresh', async (ctx) => {
    if (!ctx.user) throw errors.unauthorized();
    return { user: publicUser(ctx.user), permissions: ctx.permissions };
  });

  /**
   * First administrator.
   *
   * No admin password is seeded — shipping a known credential is precisely the
   * hole this backend closes. This endpoint is guarded by the BOOTSTRAP_TOKEN
   * secret and refuses once any admin exists.
   */
  router.post('/auth/bootstrap', async (ctx) => {
    const token = ctx.request.headers.get('X-Bootstrap-Token') || '';
    if (!ctx.env.BOOTSTRAP_TOKEN) throw errors.forbidden('Bootstrap is disabled. Set the BOOTSTRAP_TOKEN secret to enable it.');
    if (token !== ctx.env.BOOTSTRAP_TOKEN) throw errors.forbidden('Invalid bootstrap token.');

    const existing = await ctx.env.DB.prepare('select count(*) as n from users where is_admin = 1 and deleted_at is null').first();
    if (existing.n > 0) throw errors.forbidden('An administrator already exists. Use Administration to add users.');

    const v = validate(ctx.body).string('username', { required: true, max: 120 })
                                .email('email', { required: true })
                                .string('fullName', { required: true, max: 160 })
                                .string('password', { required: true, max: 200 }).done();
    requirePassword(v.password, { password_min_length: 10, password_complexity: 'medium' });

    const desig = await ctx.env.DB.prepare("select id, department_id from designations where legacy_id = 'dg_sysadmin'").first();
    const id = newId();
    await ctx.env.DB.prepare(
      `insert into users (id, username, email, password_hash, full_name, designation_id,
        department_id, status, is_admin, must_change_password, password_set_by, password_changed_at)
       values (?,?,?,?,?,?,?, 'active', 1, 0, 'self', ?)`
    ).bind(id, v.username, v.email, await hashPassword(v.password), v.fullName,
           desig?.id || null, desig?.department_id || null, nowIso()).run();

    await logAudit({ ...ctx, user: { id, full_name: v.fullName } },
      { module: 'Administration', action: 'bootstrap_admin', entityType: 'users', entityId: id, target: v.email });

    return { ok: true, userId: id,
             note: 'Clear the BOOTSTRAP_TOKEN secret now — this endpoint is no longer needed.' };
  });

  router.get('/auth/sessions', async (ctx) => {
    if (!ctx.user?.is_admin) throw errors.forbidden();
    const rows = await ctx.env.DB.prepare(
      `select s.id, s.user_id, s.last_seen_at, s.ip, s.user_agent, u.username, u.full_name
       from sessions s join users u on u.id = s.user_id
       where s.revoked_at is null and s.expires_at > ?
       order by s.last_seen_at desc limit 200`
    ).bind(nowIso()).all();
    return { sessions: rows.results };
  });
}
