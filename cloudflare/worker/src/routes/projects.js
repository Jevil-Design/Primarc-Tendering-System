import { requirePerm, MODULE } from '../permissions.js';
import { validate } from '../validation.js';
import { logAudit } from '../audit.js';
import { newId, nowIso } from '../lib/util.js';
import { errors } from '../lib/response.js';

export default function register(router) {
  router.get('/projects', async (ctx) => {
    requirePerm(ctx, MODULE.PROJECTS, 'view');
    const rows = await ctx.env.DB.prepare(
      `select p.*, c.name as company_name, u.full_name as manager_name
       from projects p
       left join companies c on c.id = p.company_id
       left join users u on u.id = p.project_manager_id
       where p.deleted_at is null order by p.project_name`
    ).all();
    return { projects: rows.results };
  });

  router.get('/projects/:id', async (ctx) => {
    requirePerm(ctx, MODULE.PROJECTS, 'view');
    const row = await ctx.env.DB.prepare('select * from projects where id = ? and deleted_at is null').bind(ctx.params.id).first();
    if (!row) throw errors.notFound('Project not found.');
    return { project: row };
  });

  router.post('/projects', async (ctx) => {
    requirePerm(ctx, MODULE.PROJECTS, 'create');
    const v = validate(ctx.body)
      .string('projectName', { required: true, max: 200 })
      .string('projectCode', { required: true, max: 40 })
      .string('projectRef', { max: 12 })
      .string('clientName', { max: 200 })
      .string('location', { max: 200 })
      .string('projectType', { max: 80 })
      .date('startDate').date('completionDate')
      .string('description', { max: 4000 })
      .id('companyId').id('branchId').id('projectManagerId')
      .done();

    const id = newId();
    await ctx.env.DB.prepare(
      `insert into projects (id, project_code, project_ref, project_name, client_name, location,
        project_type, start_date, completion_date, description, company_id, branch_id,
        project_manager_id, created_by, updated_by)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, v.projectCode, v.projectRef ? v.projectRef.toUpperCase() : null, v.projectName,
           v.clientName, v.location, v.projectType, v.startDate, v.completionDate, v.description,
           v.companyId, v.branchId, v.projectManagerId, ctx.user.id, ctx.user.id).run();

    await logAudit(ctx, { module: 'Projects', action: 'create', entityType: 'projects', entityId: id, target: v.projectName });
    return { id };
  });

  router.put('/projects/:id', async (ctx) => {
    requirePerm(ctx, MODULE.PROJECTS, 'edit');
    const id = ctx.params.id;
    const before = await ctx.env.DB.prepare('select * from projects where id = ?').bind(id).first();
    if (!before) throw errors.notFound('Project not found.');

    const b = ctx.body || {};
    const map = {
      projectName: 'project_name', projectCode: 'project_code', projectRef: 'project_ref',
      clientName: 'client_name', location: 'location', address: 'address', projectType: 'project_type',
      startDate: 'start_date', completionDate: 'completion_date', status: 'status',
      description: 'description', companyId: 'company_id', branchId: 'branch_id',
      projectManagerId: 'project_manager_id',
    };
    const sets = [], binds = [];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] !== undefined) { sets.push(`${col} = ?`); binds.push(b[k] || null); }
    }
    if (!sets.length) return { project: before };
    sets.push('updated_by = ?'); binds.push(ctx.user.id);
    binds.push(id);
    await ctx.env.DB.prepare(`update projects set ${sets.join(', ')} where id = ?`).bind(...binds).run();

    const after = await ctx.env.DB.prepare('select * from projects where id = ?').bind(id).first();
    await logAudit(ctx, { module: 'Projects', action: 'update', entityType: 'projects', entityId: id, oldValue: before, newValue: after });
    return { project: after };
  });

  router.delete('/projects/:id', async (ctx) => {
    requirePerm(ctx, MODULE.PROJECTS, 'delete');
    await ctx.env.DB.prepare('update projects set deleted_at = ?, deleted_by = ? where id = ?')
      .bind(nowIso(), ctx.user.id, ctx.params.id).run();
    await logAudit(ctx, { module: 'Projects', action: 'delete', entityType: 'projects', entityId: ctx.params.id, reason: ctx.query.reason });
    return { ok: true };
  });
}
