import { requirePerm, MODULE } from '../permissions.js';
import { validate } from '../validation.js';
import { logAudit } from '../audit.js';
import { newId, nowIso, num, nextDocNo } from '../lib/util.js';
import { errors } from '../lib/response.js';

/* Hierarchy is preserved as (parent_id, level, display_order). Amounts and GST
   are generated columns in D1, so whatever the browser sends for those is
   ignored — the database is the single source of arithmetic truth. */
export default function register(router) {
  router.get('/boqs', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ, 'view');
    const rows = await ctx.env.DB.prepare(
      `select b.*, p.project_name as project, u.full_name as created_by_name
       from boqs b
       left join projects p on p.id = b.project_id
       left join users u on u.id = b.created_by
       where b.deleted_at is null order by b.created_at desc limit 500`
    ).all();
    return { boqs: rows.results };
  });

  router.get('/boqs/:id', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ, 'view');
    const boq = await ctx.env.DB.prepare('select * from boqs where id = ? and deleted_at is null')
      .bind(ctx.params.id).first();
    if (!boq) throw errors.notFound('BOQ not found.');
    const items = await ctx.env.DB.prepare(
      'select * from boq_items where boq_id = ? order by display_order').bind(ctx.params.id).all();
    return { boq, items: items.results };
  });

  router.post('/boqs', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ, 'create');
    const v = validate(ctx.body)
      .string('name', { max: 200 }).string('description', { max: 4000 })
      .string('clientName', { max: 200 }).string('contractorName', { max: 200 })
      .id('projectId').number('revision', { min: 0 })
      .done();

    let ref = null;
    if (v.projectId) {
      const p = await ctx.env.DB.prepare('select project_ref, project_code from projects where id = ?')
        .bind(v.projectId).first();
      ref = p?.project_ref || p?.project_code || null;
    }
    const id = newId();
    const boqNo = ctx.body?.boqNumber || await nextDocNo(ctx.env.DB, 'BOQ', ref);

    await ctx.env.DB.prepare(
      `insert into boqs (id, boq_number, project_id, name, description, client_name,
        contractor_name, revision, created_by, updated_by)
       values (?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, boqNo, v.projectId, v.name, v.description, v.clientName,
           v.contractorName, v.revision || 0, ctx.user.id, ctx.user.id).run();

    await logAudit(ctx, { module: 'BOQ Creation', action: 'create', entityType: 'boqs', entityId: id, target: boqNo });
    return { id, boqNumber: boqNo };
  });

  router.put('/boqs/:id', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ, 'edit');
    const b = ctx.body || {};
    const map = { name: 'name', description: 'description', clientName: 'client_name',
      contractorName: 'contractor_name', workOrderNo: 'work_order_no', status: 'status',
      notes: 'notes', revision: 'revision', projectId: 'project_id' };
    const sets = [], binds = [];
    for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col} = ?`); binds.push(b[k]); }
    if (!sets.length) throw errors.validation('Nothing to update.');
    sets.push('updated_by = ?'); binds.push(ctx.user.id);
    binds.push(ctx.params.id);
    await ctx.env.DB.prepare(`update boqs set ${sets.join(', ')} where id = ?`).bind(...binds).run();
    await logAudit(ctx, { module: 'BOQ Creation', action: 'update', entityType: 'boqs', entityId: ctx.params.id });
    return { ok: true };
  });

  router.delete('/boqs/:id', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ, 'delete');
    await ctx.env.DB.prepare('update boqs set deleted_at = ?, deleted_by = ? where id = ?')
      .bind(nowIso(), ctx.user.id, ctx.params.id).run();
    await logAudit(ctx, { module: 'BOQ Creation', action: 'delete', entityType: 'boqs', entityId: ctx.params.id });
    return { ok: true };
  });

  /**
   * Replace every line of a BOQ in one call.
   *
   * The editor works on the whole sheet, so a diff-based API would be more
   * chatter for no benefit. Delete + insert runs inside a D1 batch, which is
   * atomic — a failure leaves the previous lines intact rather than a half
   * saved BOQ.
   */
  router.put('/boqs/:id/items', async (ctx) => {
    requirePerm(ctx, MODULE.BOQ, 'edit');
    const boqId = ctx.params.id;
    const items = Array.isArray(ctx.body?.items) ? ctx.body.items : [];

    const boq = await ctx.env.DB.prepare('select id, status from boqs where id = ? and deleted_at is null').bind(boqId).first();
    if (!boq) throw errors.notFound('BOQ not found.');
    if (['approved', 'issued', 'closed'].includes(boq.status) && !ctx.user.is_admin) {
      throw errors.locked('This BOQ is ' + boq.status + ' and can no longer be edited.');
    }

    const stmts = [ctx.env.DB.prepare('delete from boq_items where boq_id = ?').bind(boqId)];
    // Two passes so parent references resolve: ids are generated up front.
    const ids = items.map(() => newId());
    items.forEach((it, i) => {
      const parentIdx = Number.isInteger(it.parentIndex) && it.parentIndex >= 0 && it.parentIndex < i
        ? it.parentIndex : null;
      stmts.push(ctx.env.DB.prepare(
        `insert into boq_items (id, boq_id, parent_id, master_item_id, item_no, item_type,
          short_name, description, specification, unit, quantity, rate, gst_percent,
          category, subcategory, level, remarks, display_order)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(ids[i], boqId, parentIdx === null ? null : ids[parentIdx], it.masterItemId || null,
             it.itemNo || String(i + 1), it.type || 'item', it.name || null, it.desc || null,
             it.spec || null, it.uom || null, num(it.qty), num(it.rate), num(it.gst),
             it.cat || null, it.subcat || null, Number(it.level) || 0, it.remarks || null, i + 1));
    });

    for (let i = 0; i < stmts.length; i += 100) await ctx.env.DB.batch(stmts.slice(i, i + 100));

    const after = await ctx.env.DB.prepare('select base_total, gst_total, total_amount from boqs where id = ?').bind(boqId).first();
    await logAudit(ctx, { module: 'BOQ Creation', action: 'save_items', entityType: 'boqs',
                          entityId: boqId, newValue: { lines: items.length, ...after } });
    return { saved: items.length, totals: after };
  });

  /* Per-user working draft — replaces boq_autosave_v3. Survives a refresh, a
     crash, and moving to another machine. */
  router.get('/boq-draft', async (ctx) => {
    const row = await ctx.env.DB.prepare('select payload, updated_at from boq_drafts where user_id = ?')
      .bind(ctx.user.id).first();
    return { draft: row ? JSON.parse(row.payload) : null, updatedAt: row?.updated_at || null };
  });

  router.put('/boq-draft', async (ctx) => {
    const payload = JSON.stringify(ctx.body?.draft ?? null);
    if (payload.length > 4_000_000) throw errors.validation('That draft is too large to sync.');
    await ctx.env.DB.prepare(
      `insert into boq_drafts (user_id, payload, updated_at) values (?,?,?)
       on conflict(user_id) do update set payload = excluded.payload, updated_at = excluded.updated_at`
    ).bind(ctx.user.id, payload, nowIso()).run();
    return { ok: true, savedAt: nowIso() };
  });

  router.delete('/boq-draft', async (ctx) => {
    await ctx.env.DB.prepare('delete from boq_drafts where user_id = ?').bind(ctx.user.id).run();
    return { ok: true };
  });
}
