import { requirePerm, MODULE } from '../permissions.js';
import { validate } from '../validation.js';
import { logAudit, notify, usersWhoCan } from '../audit.js';
import { newId, nowIso, num, nextDocNo } from '../lib/util.js';
import { errors } from '../lib/response.js';

export default function register(router) {
  router.get('/enquiries', async (ctx) => {
    requirePerm(ctx, MODULE.ENQUIRY, 'view');
    const where = ['e.deleted_at is null'], binds = [];
    if (ctx.query.status) { where.push('e.status = ?'); binds.push(ctx.query.status); }
    if (ctx.query.projectId) { where.push('e.project_id = ?'); binds.push(ctx.query.projectId); }
    if (ctx.query.search) { where.push('(e.enquiry_no like ? or e.title like ?)');
      const s = '%' + ctx.query.search + '%'; binds.push(s, s); }
    const rows = await ctx.env.DB.prepare(
      `select e.*, p.project_name as project,
        (select count(*) from enquiry_vendors ev where ev.enquiry_id = e.id and ev.deleted_at is null) as vendor_count,
        (select count(*) from enquiry_vendors ev where ev.enquiry_id = e.id
           and ev.invitation_status in ('submitted','revised','locked')) as submitted_count
       from enquiries e left join projects p on p.id = e.project_id
       where ${where.join(' and ')} order by e.created_at desc limit 500`
    ).bind(...binds).all();
    return { enquiries: rows.results };
  });

  router.get('/enquiries/:id', async (ctx) => {
    requirePerm(ctx, MODULE.ENQUIRY, 'view');
    const id = ctx.params.id;
    const enquiry = await ctx.env.DB.prepare(
      'select * from enquiries where id = ? and deleted_at is null').bind(id).first();
    if (!enquiry) throw errors.notFound('Enquiry not found.');

    const [items, vendors] = await Promise.all([
      ctx.env.DB.prepare('select * from enquiry_items where enquiry_id = ? order by item_no').bind(id).all(),
      ctx.env.DB.prepare(
        `select ev.*, v.name as vendor_display, v.email as vendor_email, v.phone as vendor_phone
         from enquiry_vendors ev left join vendors v on v.id = ev.vendor_id
         where ev.enquiry_id = ? and ev.deleted_at is null order by ev.vendor_number`).bind(id).all(),
    ]);

    const evIds = vendors.results.map((v) => v.id);
    let lines = { results: [] }, terms = { results: [] };
    if (evIds.length) {
      const marks = evIds.map(() => '?').join(',');
      [lines, terms] = await Promise.all([
        ctx.env.DB.prepare(`select * from vendor_quote_lines where enquiry_vendor_id in (${marks})`).bind(...evIds).all(),
        ctx.env.DB.prepare(`select * from vendor_quote_terms where enquiry_vendor_id in (${marks})`).bind(...evIds).all(),
      ]);
    }

    // Nest so the UI receives the same shape it already renders.
    const linesByEv = {};
    for (const l of lines.results) (linesByEv[l.enquiry_vendor_id] ||= {})[l.enquiry_item_id] = l;
    const termsByEv = Object.fromEntries(terms.results.map((t) => [t.enquiry_vendor_id, t]));

    return {
      enquiry: { ...enquiry, terms: JSON.parse(enquiry.terms || '{}') },
      items: items.results,
      vendors: vendors.results.map((v) => ({ ...v, lines: linesByEv[v.id] || {}, terms: termsByEv[v.id] || null })),
    };
  });

  router.post('/enquiries', async (ctx) => {
    requirePerm(ctx, MODULE.ENQUIRY, 'create');
    const v = validate(ctx.body)
      .string('title', { max: 300 }).string('description', { max: 4000 })
      .string('clientName', { max: 200 }).string('referenceCode', { max: 12 })
      .date('issueDate').date('submissionDeadline').string('validity', { max: 80 })
      .string('notes', { max: 4000 }).json('terms', { default: {} })
      .id('projectId').id('boqId')
      .done();

    let ref = v.referenceCode;
    let projectName = null;
    if (v.projectId) {
      const p = await ctx.env.DB.prepare('select project_ref, project_code, project_name, client_name from projects where id = ?')
        .bind(v.projectId).first();
      ref = ref || p?.project_ref || p?.project_code;
      projectName = p?.project_name || null;
    }

    const id = newId();
    // Serial allocation is a single upsert in D1 — two users cannot be handed
    // the same number, which the old client-side counter could not guarantee.
    const enquiryNo = await nextDocNo(ctx.env.DB, 'ENQ', ref);

    await ctx.env.DB.prepare(
      `insert into enquiries (id, enquiry_no, project_id, boq_id, project_name, reference_code,
        client_name, title, description, issue_date, submission_deadline, validity, notes, terms,
        created_by, updated_by)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, enquiryNo, v.projectId, v.boqId, projectName, ref ? ref.toUpperCase() : null,
           v.clientName, v.title, v.description, v.issueDate, v.submissionDeadline,
           v.validity, v.notes, JSON.stringify(v.terms || {}), ctx.user.id, ctx.user.id).run();

    await logAudit(ctx, { module: 'Enquiry', action: 'create', entityType: 'enquiries', entityId: id, target: enquiryNo });
    return { id, enquiryNo };
  });

  router.put('/enquiries/:id', async (ctx) => {
    requirePerm(ctx, MODULE.ENQUIRY, 'edit');
    const b = ctx.body || {};
    const map = { title: 'title', description: 'description', clientName: 'client_name',
      issueDate: 'issue_date', submissionDeadline: 'submission_deadline', validity: 'validity',
      status: 'status', notes: 'notes', projectId: 'project_id' };
    const sets = [], binds = [];
    for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col} = ?`); binds.push(b[k]); }
    if (b.terms !== undefined) { sets.push('terms = ?'); binds.push(JSON.stringify(b.terms)); }
    if (!sets.length) throw errors.validation('Nothing to update.');
    sets.push('updated_by = ?'); binds.push(ctx.user.id);
    binds.push(ctx.params.id);
    await ctx.env.DB.prepare(`update enquiries set ${sets.join(', ')} where id = ?`).bind(...binds).run();
    await logAudit(ctx, { module: 'Enquiry', action: 'update', entityType: 'enquiries', entityId: ctx.params.id });
    return { ok: true };
  });

  router.delete('/enquiries/:id', async (ctx) => {
    requirePerm(ctx, MODULE.ENQUIRY, 'delete');
    await ctx.env.DB.prepare('update enquiries set deleted_at = ?, deleted_by = ? where id = ?')
      .bind(nowIso(), ctx.user.id, ctx.params.id).run();
    await logAudit(ctx, { module: 'Enquiry', action: 'delete', entityType: 'enquiries', entityId: ctx.params.id });
    return { ok: true };
  });

  router.put('/enquiries/:id/items', async (ctx) => {
    requirePerm(ctx, MODULE.ENQUIRY, 'edit');
    const id = ctx.params.id;
    const items = Array.isArray(ctx.body?.items) ? ctx.body.items : [];

    // Refuse once any vendor has quoted: changing the item list underneath a
    // submitted quotation would silently invalidate its line references.
    const quoted = await ctx.env.DB.prepare(
      `select count(*) as n from enquiry_vendors
       where enquiry_id = ? and invitation_status in ('submitted','revised','locked')`
    ).bind(id).first();
    if (quoted.n > 0 && !ctx.user.is_admin) {
      throw errors.locked('Vendors have already quoted. Create a revision instead of changing the item list.');
    }

    const stmts = [ctx.env.DB.prepare('delete from enquiry_items where enquiry_id = ?').bind(id)];
    items.forEach((it, i) => {
      stmts.push(ctx.env.DB.prepare(
        `insert into enquiry_items (id, enquiry_id, boq_item_id, master_item_id, item_no, item_type,
          level, short_name, description, category, subcategory, unit, quantity, remarks)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(newId(), id, it.boqItemId || null, it.masterItemId || null, i + 1, it.type || 'item',
             Number(it.level) || 0, it.name || null, it.desc || null, it.cat || null,
             it.subcat || null, it.uom || null, num(it.qty), it.remarks || null));
    });
    for (let i = 0; i < stmts.length; i += 100) await ctx.env.DB.batch(stmts.slice(i, i + 100));

    await logAudit(ctx, { module: 'Enquiry', action: 'save_items', entityType: 'enquiries', entityId: id,
                          newValue: { lines: items.length } });
    return { saved: items.length };
  });

  /** BOQ → Enquiry transfer, atomically. */
  router.post('/enquiries/transfer-from-boq', async (ctx) => {
    requirePerm(ctx, MODULE.ENQUIRY, 'create');
    const { boqId, itemIds, enquiryId, subject } = ctx.body || {};
    if (!boqId) throw errors.validation('boqId is required.');

    const boq = await ctx.env.DB.prepare('select * from boqs where id = ? and deleted_at is null').bind(boqId).first();
    if (!boq) throw errors.notFound('BOQ not found.');

    let enqId = enquiryId;
    let enquiryNo = null;
    if (!enqId) {
      const p = boq.project_id
        ? await ctx.env.DB.prepare('select project_ref, project_code, project_name from projects where id = ?').bind(boq.project_id).first()
        : null;
      const ref = p?.project_ref || p?.project_code || null;
      enquiryNo = await nextDocNo(ctx.env.DB, 'ENQ', ref);
      enqId = newId();
      await ctx.env.DB.prepare(
        `insert into enquiries (id, enquiry_no, project_id, boq_id, project_name, reference_code,
          client_name, title, created_by, updated_by)
         values (?,?,?,?,?,?,?,?,?,?)`
      ).bind(enqId, enquiryNo, boq.project_id, boqId, p?.project_name || boq.name,
             ref ? ref.toUpperCase() : null, boq.client_name,
             subject || `Enquiry from BOQ ${boq.boq_number || ''}`.trim(), ctx.user.id, ctx.user.id).run();
    }

    const startRow = await ctx.env.DB.prepare(
      'select coalesce(max(item_no), 0) as n from enquiry_items where enquiry_id = ?').bind(enqId).first();
    let lineNo = startRow.n;

    const filter = Array.isArray(itemIds) && itemIds.length
      ? ` and id in (${itemIds.map(() => '?').join(',')})` : '';
    const src = await ctx.env.DB.prepare(
      `select * from boq_items where boq_id = ?${filter} order by display_order`
    ).bind(boqId, ...(Array.isArray(itemIds) ? itemIds : [])).all();

    const stmts = src.results.map((b) => {
      lineNo++;
      return ctx.env.DB.prepare(
        `insert into enquiry_items (id, enquiry_id, boq_item_id, master_item_id, item_no, item_type,
          level, short_name, description, category, subcategory, unit, quantity, remarks)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(newId(), enqId, b.id, b.master_item_id, lineNo, b.item_type, b.level,
             b.short_name, b.description, b.category, b.subcategory, b.unit, b.quantity, b.remarks);
    });
    for (let i = 0; i < stmts.length; i += 100) await ctx.env.DB.batch(stmts.slice(i, i + 100));

    await logAudit(ctx, { module: 'Enquiry', action: 'transfer_from_boq', entityType: 'enquiries',
                          entityId: enqId, target: boq.boq_number, newValue: { transferred: stmts.length } });
    return { enquiryId: enqId, enquiryNo, transferred: stmts.length };
  });

  router.post('/enquiries/:id/vendors', async (ctx) => {
    requirePerm(ctx, MODULE.ENQUIRY, 'edit');
    const enquiryId = ctx.params.id;
    const { vendorId, vendorName } = ctx.body || {};
    if (!vendorId && !vendorName) throw errors.validation('A vendor is required.');

    const last = await ctx.env.DB.prepare(
      'select coalesce(max(vendor_number), 0) as n from enquiry_vendors where enquiry_id = ?').bind(enquiryId).first();
    let name = vendorName;
    if (vendorId && !name) {
      const v = await ctx.env.DB.prepare('select name from vendors where id = ?').bind(vendorId).first();
      name = v?.name || null;
    }
    const id = newId();
    await ctx.env.DB.prepare(
      `insert into enquiry_vendors (id, enquiry_id, vendor_id, vendor_name, vendor_number)
       values (?,?,?,?,?)`
    ).bind(id, enquiryId, vendorId || null, name, last.n + 1).run();

    await logAudit(ctx, { module: 'Enquiry', action: 'add_vendor', entityType: 'enquiry_vendors',
                          entityId: id, target: name });
    return { id, vendorNumber: last.n + 1 };
  });

  router.delete('/enquiries/:id/vendors/:evId', async (ctx) => {
    requirePerm(ctx, MODULE.ENQUIRY, 'edit');
    const ev = await ctx.env.DB.prepare('select invitation_status, vendor_name from enquiry_vendors where id = ? and enquiry_id = ?')
      .bind(ctx.params.evId, ctx.params.id).first();
    if (!ev) throw errors.notFound('That vendor is not on this enquiry.');
    if (['submitted', 'revised', 'locked'].includes(ev.invitation_status)) {
      throw errors.locked('This vendor has already submitted a quotation and cannot be removed.');
    }
    await ctx.env.DB.prepare('update enquiry_vendors set deleted_at = ? where id = ? and enquiry_id = ?')
      .bind(nowIso(), ctx.params.evId, ctx.params.id).run();
    await logAudit(ctx, { module: 'Enquiry', action: 'remove_vendor', entityType: 'enquiry_vendors',
                          entityId: ctx.params.evId, target: ev.vendor_name });
    return { ok: true };
  });
}
