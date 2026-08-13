import { requirePerm, MODULE } from '../permissions.js';
import { logAudit } from '../audit.js';
import { newId } from '../lib/util.js';
import { errors } from '../lib/response.js';

/* Companies, branches, departments, designations — reference data every
   signed-in user can read, but only Administration can change. */
export default function register(router) {
  router.get('/org/companies', async (ctx) => {
    const rows = await ctx.env.DB.prepare('select * from companies where deleted_at is null order by name').all();
    return { companies: rows.results };
  });

  router.get('/org/branches', async (ctx) => {
    const q = ctx.query.companyId
      ? ctx.env.DB.prepare('select * from branches where deleted_at is null and company_id = ? order by name').bind(ctx.query.companyId)
      : ctx.env.DB.prepare('select * from branches where deleted_at is null order by name');
    const rows = await q.all();
    return { branches: rows.results };
  });

  router.get('/org/departments', async (ctx) => {
    const rows = await ctx.env.DB.prepare('select * from departments order by name').all();
    return { departments: rows.results };
  });

  router.get('/org/designations', async (ctx) => {
    const rows = await ctx.env.DB.prepare(
      `select d.*, dp.name as department_name from designations d
       left join departments dp on dp.id = d.department_id
       order by d.hierarchy_level, d.name`
    ).all();
    return { designations: rows.results.map((r) => ({ ...r, financial_limits: JSON.parse(r.financial_limits || '{}') })) };
  });

  router.post('/org/designations', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'edit');
    const b = ctx.body || {};
    if (!b.name) throw errors.validation('Name is required.');
    const id = b.id || newId();
    await ctx.env.DB.prepare(
      `insert into designations (id, name, department_id, reports_to, hierarchy_level, financial_limits)
       values (?,?,?,?,?,?)
       on conflict(id) do update set name=excluded.name, department_id=excluded.department_id,
         reports_to=excluded.reports_to, hierarchy_level=excluded.hierarchy_level,
         financial_limits=excluded.financial_limits`
    ).bind(id, b.name, b.departmentId || null, b.reportsTo || null,
           b.hierarchyLevel || 9, JSON.stringify(b.financialLimits || {})).run();
    await logAudit(ctx, { module: 'Administration', action: 'save_designation', entityType: 'designations', entityId: id, target: b.name });
    return { id };
  });

  router.get('/settings', async (ctx) => {
    const rows = await ctx.env.DB.prepare('select setting_key, setting_value from system_settings').all();
    const out = {};
    for (const r of rows.results) { try { out[r.setting_key] = JSON.parse(r.setting_value); } catch { out[r.setting_key] = r.setting_value; } }
    const policy = await ctx.env.DB.prepare('select * from system_policy where id = 1').first();
    return { settings: out, policy };
  });

  router.post('/settings', async (ctx) => {
    requirePerm(ctx, MODULE.SETTINGS, 'edit');
    const { key, value } = ctx.body || {};
    if (!key) throw errors.validation('key is required.');
    await ctx.env.DB.prepare(
      `insert into system_settings (id, setting_key, setting_value, updated_by) values (?,?,?,?)
       on conflict(setting_key) do update set setting_value = excluded.setting_value, updated_by = excluded.updated_by`
    ).bind(newId(), key, JSON.stringify(value ?? {}), ctx.user.id).run();
    await logAudit(ctx, { module: 'Settings', action: 'update_setting', entityType: 'system_settings', target: key, newValue: value });
    return { ok: true };
  });
}
