import { requirePerm, MODULE } from '../permissions.js';
import { validate } from '../validation.js';
import { logAudit } from '../audit.js';
import { newId, normalize } from '../lib/util.js';
import { errors } from '../lib/response.js';

export default function register(router) {
  router.get('/materials', async (ctx) => {
    requirePerm(ctx, MODULE.MATERIAL, 'view');
    const where = ['deleted_at is null'], binds = [];
    if (ctx.query.search) { where.push('name like ?'); binds.push('%' + ctx.query.search + '%'); }
    if (ctx.query.category) { where.push('category = ?'); binds.push(ctx.query.category); }
    const rows = await ctx.env.DB.prepare(
      `select * from materials where ${where.join(' and ')} order by name limit 1000`).bind(...binds).all();
    return { materials: rows.results };
  });

  router.post('/materials', async (ctx) => {
    requirePerm(ctx, MODULE.MATERIAL, 'create');
    const v = validate(ctx.body)
      .string('name', { required: true, max: 200 })
      .string('materialCode', { max: 40 }).string('description', { max: 2000 })
      .string('unit', { max: 20 }).string('category', { max: 80 })
      .string('subcategory', { max: 80 }).string('specification', { max: 500 })
      .string('brand', { max: 80 }).number('defaultRate', { min: 0 }).gst('gstPercent')
      .done();
    const id = newId();
    await ctx.env.DB.prepare(
      `insert into materials (id, material_code, name, name_normalized, description, unit, category,
        subcategory, specification, brand, default_rate, gst_percent, created_by, updated_by)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, v.materialCode, v.name, normalize(v.name), v.description, v.unit, v.category,
           v.subcategory, v.specification, v.brand, v.defaultRate, v.gstPercent, ctx.user.id, ctx.user.id).run();
    await logAudit(ctx, { module: 'Material Master', action: 'create', entityType: 'materials', entityId: id, target: v.name });
    return { id };
  });

  router.put('/materials/:id', async (ctx) => {
    requirePerm(ctx, MODULE.MATERIAL, 'edit');
    const b = ctx.body || {};
    const map = { name: 'name', materialCode: 'material_code', description: 'description', unit: 'unit',
      category: 'category', subcategory: 'subcategory', specification: 'specification',
      brand: 'brand', defaultRate: 'default_rate', gstPercent: 'gst_percent', status: 'status' };
    const sets = [], binds = [];
    for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col} = ?`); binds.push(b[k]); }
    if (b.name !== undefined) { sets.push('name_normalized = ?'); binds.push(normalize(b.name)); }
    if (!sets.length) throw errors.validation('Nothing to update.');
    binds.push(ctx.params.id);
    await ctx.env.DB.prepare(`update materials set ${sets.join(', ')} where id = ?`).bind(...binds).run();
    await logAudit(ctx, { module: 'Material Master', action: 'update', entityType: 'materials', entityId: ctx.params.id });
    return { ok: true };
  });
}
