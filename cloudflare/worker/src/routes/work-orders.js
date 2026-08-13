import { requirePerm, assertCanApprove, MODULE } from '../permissions.js';
import { logAudit, notify, usersWhoCan } from '../audit.js';
import { newId, nowIso, num, nextDocNo } from '../lib/util.js';
import { errors } from '../lib/response.js';

export default function register(router) {
  router.get('/work-orders', async (ctx) => {
    requirePerm(ctx, MODULE.WORK_ORDER, 'view');
    const rows = await ctx.env.DB.prepare(
      `select w.*, p.project_name as project, v.name as vendor
       from work_orders w
       left join projects p on p.id = w.project_id
       left join vendors v on v.id = w.vendor_id
       where w.deleted_at is null order by w.created_at desc limit 500`
    ).all();
    return { workOrders: rows.results };
  });

  router.get('/work-orders/:id', async (ctx) => {
    requirePerm(ctx, MODULE.WORK_ORDER, 'view');
    const wo = await ctx.env.DB.prepare('select * from work_orders where id = ? and deleted_at is null')
      .bind(ctx.params.id).first();
    if (!wo) throw errors.notFound('Work order not found.');
    const items = await ctx.env.DB.prepare(
      'select * from work_order_items where work_order_id = ? order by line_no').bind(ctx.params.id).all();
    return { workOrder: { ...wo, terms: JSON.parse(wo.terms || '{}') }, items: items.results };
  });

  router.post('/work-orders', async (ctx) => {
    requirePerm(ctx, MODULE.WORK_ORDER, 'create');
    const b = ctx.body || {};
    let ref = b.projectReference;
    if (!ref && b.projectId) {
      const p = await ctx.env.DB.prepare('select project_ref, project_code from projects where id = ?').bind(b.projectId).first();
      ref = p?.project_ref || p?.project_code;
    }
    const id = newId();
    const woNo = await nextDocNo(ctx.env.DB, 'WO', ref);
    await ctx.env.DB.prepare(
      `insert into work_orders (id, work_order_no, project_id, enquiry_id, vendor_id, vendor_name,
        project_name, project_reference, issue_date, payment_terms, delivery_terms, terms, created_by, updated_by)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, woNo, b.projectId || null, b.enquiryId || null, b.vendorId || null, b.vendorName || null,
           b.projectName || null, ref || null, b.issueDate || nowIso().slice(0, 10),
           b.paymentTerms || null, b.deliveryTerms || null, JSON.stringify(b.terms || {}),
           ctx.user.id, ctx.user.id).run();

    if (Array.isArray(b.items) && b.items.length) {
      const stmts = b.items.map((it, i) => ctx.env.DB.prepare(
        `insert into work_order_items (id, work_order_id, boq_item_id, enquiry_item_id, line_no,
          description, unit, quantity, rate, gst_percent, remarks)
         values (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(newId(), id, it.boqItemId || null, it.enquiryItemId || null, i + 1,
             it.description || null, it.unit || null, num(it.quantity), num(it.rate),
             num(it.gstPercent), it.remarks || null));
      for (let i = 0; i < stmts.length; i += 100) await ctx.env.DB.batch(stmts.slice(i, i + 100));
    }

    await logAudit(ctx, { module: 'Work Order', action: 'create', entityType: 'work_orders', entityId: id, target: woNo });
    return { id, workOrderNo: woNo };
  });

  /**
   * Approve the winning vendor and raise the work order in one operation.
   *
   * Everything here is derived server-side from the stored quotation — the
   * browser cannot supply the amounts. The approval ceiling is then checked
   * against the caller's designation, so a user cannot approve past their
   * limit by editing the request.
   */
  router.post('/work-orders/from-enquiry', async (ctx) => {
    requirePerm(ctx, MODULE.WORK_ORDER, 'create');
    if (!ctx.permissions?.tender?.approve && !ctx.permissions?.enquiry?.approve && !ctx.user.is_admin) {
      throw errors.forbidden('You are not permitted to approve tenders.');
    }
    const { enquiryId, enquiryVendorId, remarks } = ctx.body || {};
    if (!enquiryId || !enquiryVendorId) throw errors.validation('enquiryId and enquiryVendorId are required.');

    const ev = await ctx.env.DB.prepare(
      'select * from enquiry_vendors where id = ? and enquiry_id = ? and deleted_at is null')
      .bind(enquiryVendorId, enquiryId).first();
    if (!ev) throw errors.notFound('That vendor is not part of this enquiry.');

    const enq = await ctx.env.DB.prepare('select * from enquiries where id = ? and deleted_at is null').bind(enquiryId).first();
    if (!enq) throw errors.notFound('Enquiry not found.');

    // Authoritative total, read from the database rather than the request body.
    assertCanApprove(ctx, 'workorder', ev.total_amount);

    let ref = enq.reference_code;
    if (enq.project_id) {
      const p = await ctx.env.DB.prepare('select project_ref, project_code from projects where id = ?').bind(enq.project_id).first();
      ref = p?.project_ref || p?.project_code || ref;
    }

    const woId = newId();
    const woNo = await nextDocNo(ctx.env.DB, 'WO', ref);
    await ctx.env.DB.prepare(
      `insert into work_orders (id, work_order_no, project_id, enquiry_id, vendor_id, vendor_name,
        project_name, project_reference, issue_date, status, approved_by, approved_at, created_by, updated_by)
       values (?,?,?,?,?,?,?,?,?, 'approved', ?,?,?,?)`
    ).bind(woId, woNo, enq.project_id, enquiryId, ev.vendor_id, ev.vendor_name,
           enq.project_name, ref, nowIso().slice(0, 10), ctx.user.id, nowIso(),
           ctx.user.id, ctx.user.id).run();

    const lines = await ctx.env.DB.prepare(
      `select ei.id as item_id, ei.description, ei.short_name, ei.unit, ei.quantity,
              vql.rate, vql.gst_percent, vql.remarks
       from enquiry_items ei
       join vendor_quote_lines vql on vql.enquiry_item_id = ei.id and vql.enquiry_vendor_id = ?
       where ei.enquiry_id = ? and ei.item_type = 'item' and vql.rate > 0
       order by ei.item_no`
    ).bind(enquiryVendorId, enquiryId).all();

    const stmts = lines.results.map((l, i) => ctx.env.DB.prepare(
      `insert into work_order_items (id, work_order_id, enquiry_item_id, line_no, description,
        unit, quantity, rate, gst_percent, remarks)
       values (?,?,?,?,?,?,?,?,?,?)`
    ).bind(newId(), woId, l.item_id, i + 1, l.description || l.short_name, l.unit,
           l.quantity, l.rate, l.gst_percent, l.remarks));
    for (let i = 0; i < stmts.length; i += 100) await ctx.env.DB.batch(stmts.slice(i, i + 100));

    await ctx.env.DB.batch([
      ctx.env.DB.prepare("update enquiries set status = 'approved' where id = ?").bind(enquiryId),
      ctx.env.DB.prepare("update enquiry_vendors set locked_at = ?, invitation_status = 'locked' where id = ?")
        .bind(nowIso(), enquiryVendorId),
    ]);

    const watchers = await usersWhoCan(ctx.env, 'workorder', 'view');
    await notify(ctx.env, watchers, {
      title: 'Work order issued',
      message: `${woNo} raised for ${ev.vendor_name || 'vendor'}`,
      type: 'workorder', referenceType: 'work_orders', referenceId: woId,
    });
    await logAudit(ctx, { module: 'Work Order', action: 'create_from_enquiry', entityType: 'work_orders',
                          entityId: woId, target: woNo, reason: remarks,
                          newValue: { vendor: ev.vendor_name, total: ev.total_amount } });

    return { id: woId, workOrderNo: woNo, lines: stmts.length };
  });

  router.post('/work-orders/:id/approve', async (ctx) => {
    requirePerm(ctx, MODULE.WORK_ORDER, 'approve');
    const wo = await ctx.env.DB.prepare('select * from work_orders where id = ? and deleted_at is null')
      .bind(ctx.params.id).first();
    if (!wo) throw errors.notFound('Work order not found.');
    if (wo.status === 'approved') throw errors.conflict('This work order is already approved.');

    // The stored total is authoritative; a client-supplied amount is ignored.
    assertCanApprove(ctx, 'workorder', wo.total_amount);

    await ctx.env.DB.prepare(
      "update work_orders set status = 'approved', approved_by = ?, approved_at = ? where id = ?"
    ).bind(ctx.user.id, nowIso(), ctx.params.id).run();

    await logAudit(ctx, { module: 'Work Order', action: 'approve', entityType: 'work_orders',
                          entityId: ctx.params.id, target: wo.work_order_no,
                          newValue: { total: wo.total_amount } });
    return { ok: true };
  });

  router.post('/work-orders/:id/reject', async (ctx) => {
    requirePerm(ctx, MODULE.WORK_ORDER, 'reject');
    await ctx.env.DB.prepare("update work_orders set status = 'rejected' where id = ?").bind(ctx.params.id).run();
    await logAudit(ctx, { module: 'Work Order', action: 'reject', entityType: 'work_orders',
                          entityId: ctx.params.id, reason: ctx.body?.reason });
    return { ok: true };
  });
}
