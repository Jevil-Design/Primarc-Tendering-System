import { requirePerm, assertCanApprove, MODULE } from '../permissions.js';
import { logAudit } from '../audit.js';
import { newId, nowIso, num, nextDocNo } from '../lib/util.js';
import { errors } from '../lib/response.js';

export default function register(router) {
  router.get('/purchase-orders', async (ctx) => {
    requirePerm(ctx, MODULE.PURCHASE_ORDER, 'view');
    const rows = await ctx.env.DB.prepare(
      `select po.*, p.project_name as project, v.name as vendor
       from purchase_orders po
       left join projects p on p.id = po.project_id
       left join vendors v on v.id = po.vendor_id
       where po.deleted_at is null order by po.created_at desc limit 500`
    ).all();
    return { purchaseOrders: rows.results };
  });

  router.get('/purchase-orders/:id', async (ctx) => {
    requirePerm(ctx, MODULE.PURCHASE_ORDER, 'view');
    const po = await ctx.env.DB.prepare('select * from purchase_orders where id = ? and deleted_at is null')
      .bind(ctx.params.id).first();
    if (!po) throw errors.notFound('Purchase order not found.');
    const items = await ctx.env.DB.prepare(
      'select * from purchase_order_items where purchase_order_id = ? order by line_no').bind(ctx.params.id).all();
    return { purchaseOrder: { ...po, terms: JSON.parse(po.terms || '{}') }, items: items.results };
  });

  router.post('/purchase-orders', async (ctx) => {
    requirePerm(ctx, MODULE.PURCHASE_ORDER, 'create');
    const b = ctx.body || {};
    let ref = null;
    if (b.projectId) {
      const p = await ctx.env.DB.prepare('select project_ref, project_code from projects where id = ?').bind(b.projectId).first();
      ref = p?.project_ref || p?.project_code;
    }
    const id = newId();
    const poNo = await nextDocNo(ctx.env.DB, 'PO', ref);
    await ctx.env.DB.prepare(
      `insert into purchase_orders (id, po_number, project_id, vendor_id, work_order_id, po_date,
        delivery_date, terms, created_by, updated_by)
       values (?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, poNo, b.projectId || null, b.vendorId || null, b.workOrderId || null,
           b.poDate || nowIso().slice(0, 10), b.deliveryDate || null,
           JSON.stringify(b.terms || {}), ctx.user.id, ctx.user.id).run();

    if (Array.isArray(b.items) && b.items.length) {
      const stmts = b.items.map((it, i) => ctx.env.DB.prepare(
        `insert into purchase_order_items (id, purchase_order_id, material_id, line_no,
          description, unit, quantity, rate, gst_percent, remarks)
         values (?,?,?,?,?,?,?,?,?,?)`
      ).bind(newId(), id, it.materialId || null, i + 1, it.description || null, it.unit || null,
             num(it.quantity), num(it.rate), num(it.gstPercent), it.remarks || null));
      for (let i = 0; i < stmts.length; i += 100) await ctx.env.DB.batch(stmts.slice(i, i + 100));
    }

    await logAudit(ctx, { module: 'Purchase Order', action: 'create', entityType: 'purchase_orders', entityId: id, target: poNo });
    return { id, poNumber: poNo };
  });

  router.put('/purchase-orders/:id', async (ctx) => {
    requirePerm(ctx, MODULE.PURCHASE_ORDER, 'edit');
    const b = ctx.body || {};
    const map = { poDate: 'po_date', deliveryDate: 'delivery_date', status: 'status',
      vendorId: 'vendor_id', projectId: 'project_id', workOrderId: 'work_order_id' };
    const sets = [], binds = [];
    for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col} = ?`); binds.push(b[k]); }
    if (b.terms !== undefined) { sets.push('terms = ?'); binds.push(JSON.stringify(b.terms)); }
    if (!sets.length) throw errors.validation('Nothing to update.');
    sets.push('updated_by = ?'); binds.push(ctx.user.id);
    binds.push(ctx.params.id);
    await ctx.env.DB.prepare(`update purchase_orders set ${sets.join(', ')} where id = ?`).bind(...binds).run();
    await logAudit(ctx, { module: 'Purchase Order', action: 'update', entityType: 'purchase_orders', entityId: ctx.params.id });
    return { ok: true };
  });

  router.post('/purchase-orders/:id/approve', async (ctx) => {
    requirePerm(ctx, MODULE.PURCHASE_ORDER, 'approve');
    const po = await ctx.env.DB.prepare('select * from purchase_orders where id = ? and deleted_at is null')
      .bind(ctx.params.id).first();
    if (!po) throw errors.notFound('Purchase order not found.');
    assertCanApprove(ctx, 'purchase', po.total_amount);
    await ctx.env.DB.prepare(
      "update purchase_orders set status = 'approved', approved_by = ?, approved_at = ? where id = ?"
    ).bind(ctx.user.id, nowIso(), ctx.params.id).run();
    await logAudit(ctx, { module: 'Purchase Order', action: 'approve', entityType: 'purchase_orders',
                          entityId: ctx.params.id, target: po.po_number, newValue: { total: po.total_amount } });
    return { ok: true };
  });
}
