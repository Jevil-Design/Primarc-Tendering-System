import { requirePerm, MODULE } from '../permissions.js';
import { validate } from '../validation.js';
import { logAudit } from '../audit.js';
import { newId, nowIso, normalize } from '../lib/util.js';
import { errors } from '../lib/response.js';

export default function register(router) {
  router.get('/boq-master', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ_MASTER, 'view');
    const limit = Math.min(parseInt(ctx.query.limit || '500', 10), 2000);
    const where = ['deleted_at is null'], binds = [];
    if (ctx.query.search) {
      where.push('(short_name like ? or description like ?)');
      const s = '%' + ctx.query.search + '%'; binds.push(s, s);
    }
    for (const [k, col] of [['category','category'],['subcategory','subcategory'],['unit','unit']]) {
      if (ctx.query[k]) { where.push(`${col} = ?`); binds.push(ctx.query[k]); }
    }
    const rows = await ctx.env.DB.prepare(
      `select * from boq_master_items where ${where.join(' and ')} order by short_name limit ?`
    ).bind(...binds, limit).all();
    return { items: rows.results.map((r) => ({ ...r, is_codes: JSON.parse(r.is_codes || '[]') })) };
  });

  router.post('/boq-master', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ_MASTER, 'create');
    const v = validate(ctx.body)
      .string('shortName', { required: true, max: 300 })
      .string('description', { max: 4000 }).string('unit', { max: 20 })
      .string('category', { max: 80 }).string('subcategory', { max: 80 })
      .string('workGroup', { max: 80 }).number('defaultRate', { min: 0 })
      .json('isCodes', { default: [] }).string('notes', { max: 2000 })
      .done();
    const id = newId();
    await ctx.env.DB.prepare(
      `insert into boq_master_items (id, short_name, short_name_normalized, description, unit,
        category, subcategory, work_group, default_rate, is_codes, notes, source, created_by, updated_by)
       values (?,?,?,?,?,?,?,?,?,?,?,'manual',?,?)`
    ).bind(id, v.shortName, normalize(v.shortName), v.description, v.unit, v.category,
           v.subcategory, v.workGroup, v.defaultRate, JSON.stringify(v.isCodes || []),
           v.notes, ctx.user.id, ctx.user.id).run();
    await logAudit(ctx, { module: 'BOQ Master', action: 'create', entityType: 'boq_master_items', entityId: id, target: v.shortName });
    return { id };
  });

  router.put('/boq-master/:id', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ_MASTER, 'edit');
    const b = ctx.body || {};
    const map = { shortName: 'short_name', description: 'description', unit: 'unit',
      category: 'category', subcategory: 'subcategory', workGroup: 'work_group',
      defaultRate: 'default_rate', notes: 'notes', status: 'status' };
    const sets = [], binds = [];
    for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col} = ?`); binds.push(b[k]); }
    if (b.shortName !== undefined) { sets.push('short_name_normalized = ?'); binds.push(normalize(b.shortName)); }
    if (b.isCodes !== undefined) { sets.push('is_codes = ?'); binds.push(JSON.stringify(b.isCodes)); }
    if (!sets.length) throw errors.validation('Nothing to update.');
    sets.push('updated_by = ?'); binds.push(ctx.user.id);
    binds.push(ctx.params.id);
    await ctx.env.DB.prepare(`update boq_master_items set ${sets.join(', ')} where id = ?`).bind(...binds).run();
    await logAudit(ctx, { module: 'BOQ Master', action: 'update', entityType: 'boq_master_items', entityId: ctx.params.id });
    return { ok: true };
  });

  router.delete('/boq-master/:id', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ_MASTER, 'delete');
    await ctx.env.DB.prepare('update boq_master_items set deleted_at = ? where id = ?')
      .bind(nowIso(), ctx.params.id).run();
    await logAudit(ctx, { module: 'BOQ Master', action: 'delete', entityType: 'boq_master_items', entityId: ctx.params.id });
    return { ok: true };
  });

  /* Historical rates. Append-only: a newer rate never replaces an older row,
     which is what makes the rate-trend view meaningful. */
  router.get('/boq-master/:id/rates', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ_MASTER, 'view');
    const rows = await ctx.env.DB.prepare(
      `select r.*, v.name as vendor_display from boq_master_rates r
       left join vendors v on v.id = r.vendor_id
       where r.master_item_id = ? order by coalesce(r.effective_date, r.created_at) desc limit 100`
    ).bind(ctx.params.id).all();
    return { rates: rows.results };
  });

  router.post('/boq-master/:id/rates', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ_MASTER, 'edit');
    const b = ctx.body || {};
    const id = newId();
    await ctx.env.DB.prepare(
      `insert into boq_master_rates (id, master_item_id, vendor_id, vendor_name, project_id,
        project_name, rate, unit, work_order_no, effective_date, source)
       values (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, ctx.params.id, b.vendorId || null, b.vendorName || null, b.projectId || null,
           b.projectName || null, Number(b.rate) || 0, b.unit || null, b.workOrderNo || null,
           b.effectiveDate || nowIso(), b.source || 'manual').run();
    return { id };
  });

  /* Template round-trip import. Matching is by (name, category) so the same
     item name under a different category is not wrongly merged. */
  router.post('/boq-master/bulk', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ_MASTER, 'import');
    const items = Array.isArray(ctx.body?.items) ? ctx.body.items : [];
    if (!items.length) return { added: 0, updated: 0 };

    let added = 0, updated = 0;
    for (const it of items) {
      const name = String(it?.shortName || it?.name || '').trim();
      if (!name) continue;
      const norm = normalize(name);
      const cat = it.category || null;
      const existing = await ctx.env.DB.prepare(
        `select id from boq_master_items where short_name_normalized = ?
         and coalesce(category,'') = coalesce(?,'') and deleted_at is null`
      ).bind(norm, cat).first();

      if (existing) {
        await ctx.env.DB.prepare(
          `update boq_master_items set description = coalesce(?, description), unit = coalesce(?, unit),
           subcategory = coalesce(?, subcategory), updated_by = ? where id = ?`
        ).bind(it.description || null, it.unit || null, it.subcategory || null, ctx.user.id, existing.id).run();
        updated++;
        if (Array.isArray(it.rates)) {
          for (const r of it.rates) {
            if (!r?.vendorName || !(Number(r.rate) > 0)) continue;
            await ctx.env.DB.prepare(
              `insert into boq_master_rates (id, master_item_id, vendor_name, project_name, rate, unit, source)
               values (?,?,?,?,?,?, 'import')`
            ).bind(newId(), existing.id, r.vendorName, r.projectName || null, Number(r.rate), it.unit || null).run();
          }
        }
      } else {
        const id = newId();
        await ctx.env.DB.prepare(
          `insert into boq_master_items (id, short_name, short_name_normalized, description, unit,
            category, subcategory, source, created_by, updated_by)
           values (?,?,?,?,?,?,?, 'import', ?,?)`
        ).bind(id, name, norm, it.description || name, it.unit || null, cat,
               it.subcategory || null, ctx.user.id, ctx.user.id).run();
        added++;
        if (Array.isArray(it.rates)) {
          for (const r of it.rates) {
            if (!r?.vendorName || !(Number(r.rate) > 0)) continue;
            await ctx.env.DB.prepare(
              `insert into boq_master_rates (id, master_item_id, vendor_name, project_name, rate, unit, source)
               values (?,?,?,?,?,?, 'import')`
            ).bind(newId(), id, r.vendorName, r.projectName || null, Number(r.rate), it.unit || null).run();
          }
        }
      }
    }
    await logAudit(ctx, { module: 'BOQ Master', action: 'bulk_import', entityType: 'boq_master_items',
                          newValue: { received: items.length, added, updated } });
    return { added, updated, received: items.length };
  });
}
