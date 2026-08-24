import { requirePerm, MODULE } from '../permissions.js';
import { logAudit } from '../audit.js';
import { newId, num } from '../lib/util.js';
import { errors } from '../lib/response.js';

export default function register(router) {
  router.get('/rate-analyses', async (ctx) => {
    requirePerm(ctx, MODULE.RATE_ANALYSIS, 'view');
    const rows = await ctx.env.DB.prepare(
      'select * from rate_analyses where deleted_at is null order by created_at desc limit 500').all();
    return { analyses: rows.results };
  });

  router.get('/rate-analyses/:id', async (ctx) => {
    requirePerm(ctx, MODULE.RATE_ANALYSIS, 'view');
    const ra = await ctx.env.DB.prepare('select * from rate_analyses where id = ?').bind(ctx.params.id).first();
    if (!ra) throw errors.notFound('Rate analysis not found.');
    const comps = await ctx.env.DB.prepare(
      'select * from rate_analysis_components where rate_analysis_id = ?').bind(ctx.params.id).all();
    return { analysis: ra, components: comps.results };
  });

  router.post('/rate-analyses', async (ctx) => {
    requirePerm(ctx, MODULE.RATE_ANALYSIS, 'create');
    const b = ctx.body || {};
    const id = newId();
    await ctx.env.DB.prepare(
      `insert into rate_analyses (id, boq_item_id, project_id, name, description, unit,
        wastage_percent, profit_percent, assumptions, created_by, updated_by)
       values (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, b.boqItemId || null, b.projectId || null, b.name || null, b.description || null,
           b.unit || null, num(b.wastagePercent), num(b.profitPercent),
           JSON.stringify(b.assumptions || {}), ctx.user.id, ctx.user.id).run();

    if (Array.isArray(b.components) && b.components.length) {
      await saveComponents(ctx, id, b.components);
    }
    await logAudit(ctx, { module: 'Rate Analysis', action: 'create', entityType: 'rate_analyses', entityId: id });
    return { id };
  });

  router.put('/rate-analyses/:id/components', async (ctx) => {
    requirePerm(ctx, MODULE.RATE_ANALYSIS, 'edit');
    await saveComponents(ctx, ctx.params.id, ctx.body?.components || []);
    return { ok: true };
  });
}

/* Components are replaced wholesale, then the parent's cost buckets are
   recomputed here. SQLite triggers cannot easily express the wastage/profit
   compounding, so it lives in one place rather than being duplicated. */
async function saveComponents(ctx, raId, components) {
  const stmts = [ctx.env.DB.prepare('delete from rate_analysis_components where rate_analysis_id = ?').bind(raId)];
  for (const c of components) {
    stmts.push(ctx.env.DB.prepare(
      `insert into rate_analysis_components (id, rate_analysis_id, component_type, material_id,
        supplier_vendor_id, description, unit, quantity, rate, percentage, remarks)
       values (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(newId(), raId, c.type || 'material', c.materialId || null, c.vendorId || null,
           c.description || null, c.unit || null, num(c.quantity), num(c.rate),
           c.percentage == null ? null : num(c.percentage), c.remarks || null));
  }
  await ctx.env.DB.batch(stmts);

  const sums = await ctx.env.DB.prepare(
    `select component_type, sum(amount) as total from rate_analysis_components
     where rate_analysis_id = ? group by component_type`
  ).bind(raId).all();
  const by = Object.fromEntries(sums.results.map((r) => [r.component_type, r.total || 0]));
  const total = Object.values(by).reduce((a, b) => a + b, 0);

  const ra = await ctx.env.DB.prepare('select wastage_percent, profit_percent from rate_analyses where id = ?').bind(raId).first();
  const final = total * (1 + (ra?.wastage_percent || 0) / 100) * (1 + (ra?.profit_percent || 0) / 100);

  await ctx.env.DB.prepare(
    `update rate_analyses set material_cost = ?, labour_cost = ?, equipment_cost = ?,
      subcontract_cost = ?, overhead_cost = ?, total_rate = ?, final_rate = ? where id = ?`
  ).bind(by.material || 0, by.labour || 0, by.equipment || 0, by.subcontract || 0,
         by.overhead || 0, total, Math.round(final * 10000) / 10000, raId).run();
}
