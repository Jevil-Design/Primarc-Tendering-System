import { errors } from '../lib/response.js';
import { requirePerm, MODULE, ACTIONS } from '../permissions.js';
import { validate, requirePassword } from '../validation.js';
import { hashPassword, generateTemporaryPassword, revokeAllForUser } from '../auth.js';
import { logAudit } from '../audit.js';
import { newId, nowIso, publicUser } from '../lib/util.js';

/* password_hash is never selected into a response — every query here lists
   columns explicitly rather than using select *. */
const SAFE = `u.id, u.username, u.email, u.full_name, u.employee_id, u.phone,
  u.designation_id, u.department_id, u.company_id, u.branch_id, u.status, u.is_admin,
  u.must_change_password, u.password_set_by, u.password_changed_at, u.last_login,
  u.created_at, u.updated_at`;

export default function register(router) {
  router.get('/users', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'view');
    const rows = await ctx.env.DB.prepare(
      `select ${SAFE}, d.name as designation_name, dp.name as department_name,
              c.name as company_name, b.name as branch_name
       from users u
       left join designations d on d.id = u.designation_id
       left join departments dp on dp.id = u.department_id
       left join companies c on c.id = u.company_id
       left join branches b on b.id = u.branch_id
       where u.deleted_at is null order by u.created_at`
    ).all();
    return { users: rows.results.map((r) => ({ ...r, is_admin: !!r.is_admin, must_change_password: !!r.must_change_password })) };
  });

  router.get('/users/:id', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'view');
    const row = await ctx.env.DB.prepare(`select ${SAFE} from users u where u.id = ?`).bind(ctx.params.id).first();
    if (!row) throw errors.notFound('User not found.');
    return { user: { ...row, is_admin: !!row.is_admin } };
  });

  router.post('/users', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'create');
    const v = validate(ctx.body)
      .string('username', { required: true, max: 120 })
      .string('fullName', { required: true, max: 160 })
      .email('email')
      .string('phone', { max: 40 })
      .string('employeeId', { max: 60 })
      .id('designationId').id('departmentId').id('companyId').id('branchId')
      .string('password', { max: 200 })
      .done();

    const policy = await ctx.env.DB.prepare('select * from system_policy where id = 1').first();
    const password = v.password || generateTemporaryPassword();
    if (v.password) requirePassword(v.password, policy || {});

    const id = newId();
    await ctx.env.DB.prepare(
      `insert into users (id, username, email, password_hash, full_name, employee_id, phone,
        designation_id, department_id, company_id, branch_id, status, must_change_password,
        password_set_by, password_changed_at)
       values (?,?,?,?,?,?,?,?,?,?,?, 'active', 1, 'admin', ?)`
    ).bind(id, v.username, v.email, await hashPassword(password), v.fullName, v.employeeId, v.phone,
           v.designationId, v.departmentId, v.companyId, v.branchId, nowIso()).run();

    await logAudit(ctx, { module: 'Administration', action: 'create_user', entityType: 'users', entityId: id, target: v.username });

    // Shown once. Never stored in readable form, and not recoverable later.
    return { userId: id, temporaryPassword: v.password ? undefined : password };
  });

  router.patch('/users/:id', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'edit');
    const id = ctx.params.id;
    const before = await ctx.env.DB.prepare(`select ${SAFE} from users u where u.id = ?`).bind(id).first();
    if (!before) throw errors.notFound('User not found.');

    const b = ctx.body || {};
    const sets = [], binds = [];
    const put = (col, val) => { sets.push(`${col} = ?`); binds.push(val); };

    if (b.fullName !== undefined) put('full_name', String(b.fullName).trim());
    if (b.email !== undefined) put('email', b.email ? String(b.email).trim().toLowerCase() : null);
    if (b.phone !== undefined) put('phone', b.phone || null);
    if (b.employeeId !== undefined) put('employee_id', b.employeeId || null);
    if (b.designationId !== undefined) {
      if (id === ctx.user.id && b.designationId !== before.designation_id) {
        throw errors.forbidden('You cannot change your own designation.');
      }
      put('designation_id', b.designationId || null);
    }
    if (b.departmentId !== undefined) put('department_id', b.departmentId || null);
    if (b.companyId !== undefined) put('company_id', b.companyId || null);
    if (b.branchId !== undefined) put('branch_id', b.branchId || null);
    if (b.status !== undefined) {
      if (id === ctx.user.id && b.status !== 'active') throw errors.forbidden('You cannot disable your own account.');
      if (!['active','inactive','suspended'].includes(b.status)) throw errors.validation('Invalid status.');
      put('status', b.status);
    }
    if (b.isAdmin !== undefined) {
      if (!ctx.user.is_admin) throw errors.forbidden('Only an administrator can grant administrator rights.');
      if (id === ctx.user.id) throw errors.forbidden('You cannot change your own administrator flag.');
      put('is_admin', b.isAdmin ? 1 : 0);
    }
    if (b.password) {
      const policy = await ctx.env.DB.prepare('select * from system_policy where id = 1').first();
      requirePassword(b.password, policy || {});
      put('password_hash', await hashPassword(b.password));
      put('must_change_password', 1);
      put('password_set_by', 'admin');
      put('password_changed_at', nowIso());
    }
    if (!sets.length) return { user: before };

    binds.push(id);
    await ctx.env.DB.prepare(`update users set ${sets.join(', ')} where id = ?`).bind(...binds).run();

    if (b.status && b.status !== 'active') await revokeAllForUser(ctx.env, id);
    if (b.password) await revokeAllForUser(ctx.env, id);

    const after = await ctx.env.DB.prepare(`select ${SAFE} from users u where u.id = ?`).bind(id).first();
    await logAudit(ctx, { module: 'Administration', action: 'update_user', entityType: 'users',
                          entityId: id, oldValue: before, newValue: after });
    return { user: { ...after, is_admin: !!after.is_admin } };
  });

  /* Admin issues a temporary password; it is shown once and never readable
     afterwards. An admin cannot read an existing password — only replace it. */
  router.post('/users/:id/reset-password', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'edit');
    const id = ctx.params.id;
    const row = await ctx.env.DB.prepare('select id, username from users where id = ? and deleted_at is null').bind(id).first();
    if (!row) throw errors.notFound('User not found.');

    const pw = generateTemporaryPassword();
    await ctx.env.DB.prepare(
      `update users set password_hash = ?, must_change_password = 1, password_set_by = 'admin',
       password_changed_at = ?, failed_attempts = 0, locked_until = null where id = ?`
    ).bind(await hashPassword(pw), nowIso(), id).run();
    await revokeAllForUser(ctx.env, id);

    await logAudit(ctx, { module: 'Administration', action: 'reset_password', entityType: 'users', entityId: id, target: row.username });
    return { temporaryPassword: pw };
  });

  router.post('/users/bulk/active', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'edit');
    const ids = (ctx.body?.ids || []).filter((i) => typeof i === 'string');
    const active = !!ctx.body?.active;
    const targets = ids.filter((i) => !(i === ctx.user.id && !active));
    if (!targets.length) return { changed: 0 };

    const marks = targets.map(() => '?').join(',');
    await ctx.env.DB.prepare(`update users set status = ? where id in (${marks})`)
      .bind(active ? 'active' : 'inactive', ...targets).run();
    if (!active) for (const id of targets) await revokeAllForUser(ctx.env, id);

    await logAudit(ctx, { module: 'Administration', action: active ? 'enable_users' : 'disable_users',
                          entityType: 'users', target: targets.join(',') });
    return { changed: targets.length };
  });

  router.post('/users/bulk/delete', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'delete');
    const ids = (ctx.body?.ids || []).filter((i) => typeof i === 'string' && i !== ctx.user.id);
    if (!ids.length) return { deleted: 0 };
    const marks = ids.map(() => '?').join(',');
    // Soft delete: BOQs, enquiries and work orders reference these rows, so a
    // hard delete would break the audit trail and every created_by link.
    await ctx.env.DB.prepare(
      `update users set deleted_at = ?, status = 'inactive' where id in (${marks})`
    ).bind(nowIso(), ...ids).run();
    for (const id of ids) await revokeAllForUser(ctx.env, id);
    await logAudit(ctx, { module: 'Administration', action: 'delete_users', entityType: 'users', target: ids.join(',') });
    return { deleted: ids.length };
  });

  // ── RBAC ────────────────────────────────────────────────────
  router.get('/rbac/modules', async (ctx) => {
    const rows = await ctx.env.DB.prepare('select * from modules order by display_order').all();
    return { modules: rows.results };
  });

  router.get('/rbac/permissions', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'view');
    const rows = await ctx.env.DB.prepare('select * from permissions').all();
    return { permissions: rows.results };
  });

  router.post('/rbac/permissions', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'edit');
    const { designationId, moduleId, flags } = ctx.body || {};
    if (!designationId || !moduleId) throw errors.validation('designationId and moduleId are required.');
    const cols = ACTIONS.map((a) => 'can_' + a);
    const vals = ACTIONS.map((a) => (flags && flags[a] ? 1 : 0));
    await ctx.env.DB.prepare(
      `insert into permissions (id, designation_id, module_id, ${cols.join(',')})
       values (?,?,?,${cols.map(() => '?').join(',')})
       on conflict(designation_id, module_id) do update set ${cols.map((c) => `${c}=excluded.${c}`).join(', ')}`
    ).bind(newId(), designationId, moduleId, ...vals).run();
    await logAudit(ctx, { module: 'Administration', action: 'set_permission', entityType: 'permissions',
                          entityId: designationId, newValue: flags });
    return { ok: true };
  });

  router.get('/rbac/overrides/:userId', async (ctx) => {
    if (ctx.params.userId !== ctx.user.id) requirePerm(ctx, MODULE.ADMIN, 'view');
    const rows = await ctx.env.DB.prepare('select * from user_permission_overrides where user_id = ?')
      .bind(ctx.params.userId).all();
    return { overrides: rows.results };
  });

  router.post('/rbac/overrides', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'edit');
    const { userId, moduleId, flags } = ctx.body || {};
    if (!userId || !moduleId) throw errors.validation('userId and moduleId are required.');
    const cols = ACTIONS.map((a) => 'can_' + a);
    // null means "inherit the designation default" — preserved, not coerced to 0.
    const vals = ACTIONS.map((a) => (flags && flags[a] !== undefined && flags[a] !== null ? (flags[a] ? 1 : 0) : null));
    await ctx.env.DB.prepare(
      `insert into user_permission_overrides (id, user_id, module_id, ${cols.join(',')})
       values (?,?,?,${cols.map(() => '?').join(',')})
       on conflict(user_id, module_id) do update set ${cols.map((c) => `${c}=excluded.${c}`).join(', ')}`
    ).bind(newId(), userId, moduleId, ...vals).run();
    await logAudit(ctx, { module: 'Administration', action: 'set_override', entityType: 'users', entityId: userId, newValue: flags });
    return { ok: true };
  });

  // ── Audit ───────────────────────────────────────────────────
  router.get('/audit', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'view');
    const limit = Math.min(parseInt(ctx.query.limit || '200', 10), 1000);
    const where = [], binds = [];
    if (ctx.query.module) { where.push('module = ?'); binds.push(ctx.query.module); }
    if (ctx.query.entityId) { where.push('entity_id = ?'); binds.push(ctx.query.entityId); }
    if (ctx.query.action) { where.push('action = ?'); binds.push(ctx.query.action); }
    const sql = `select * from audit_logs ${where.length ? 'where ' + where.join(' and ') : ''}
                 order by created_at desc limit ?`;
    const rows = await ctx.env.DB.prepare(sql).bind(...binds, limit).all();
    return { events: rows.results };
  });
}
