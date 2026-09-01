import { requirePerm, MODULE } from '../permissions.js';
import { logAudit, notify, usersWhoCan } from '../audit.js';
import { newId, nowIso, num } from '../lib/util.js';
import { errors } from '../lib/response.js';

/* ═══════════════════════════════════════════════════════════════
   Vendor portal.

   A vendor has no account. They hold a link token, and every portal route is
   reached WITHOUT a session — which is why authorisation happens here, on the
   token, and each query is scoped to the single invite it resolves to.

   Only the SHA-256 of the token is stored, so a database dump cannot be
   replayed as vendor access. The raw token exists once, in the link.
   ═══════════════════════════════════════════════════════════════ */

const enc = new TextEncoder();
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function resolveToken(env, token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const row = await env.DB.prepare(
    `select ev.*, e.id as enq_id, e.enquiry_no, e.title, e.project_name, e.client_name,
            e.submission_deadline, e.validity, e.notes, e.terms
     from enquiry_vendors ev join enquiries e on e.id = ev.enquiry_id
     where ev.access_token_hash = ? and ev.deleted_at is null and e.deleted_at is null`
  ).bind(await sha256Hex(token)).first();
  if (!row) return null;
  if (row.token_expires_at && Date.parse(row.token_expires_at) < Date.now()) return null;
  return row;
}

export default function register(router) {
  /** Issue a portal link. Returned once — build the URL immediately. */
  router.post('/enquiries/:id/vendors/:evId/link', async (ctx) => {
    requirePerm(ctx, MODULE.ENQUIRY, 'share');
    const days = Math.max(1, Math.min(parseInt(ctx.body?.expiryDays || '14', 10), 120));
    const token = [...crypto.getRandomValues(new Uint8Array(24))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');

    const res = await ctx.env.DB.prepare(
      `update enquiry_vendors set access_token_hash = ?, token_expires_at = ?,
        invitation_status = case when invitation_status = 'pending' then 'sent' else invitation_status end,
        invited_at = coalesce(invited_at, ?)
       where id = ? and enquiry_id = ?`
    ).bind(await sha256Hex(token), new Date(Date.now() + days * 86400000).toISOString(),
           nowIso(), ctx.params.evId, ctx.params.id).run();
    if (!res.meta.changes) throw errors.notFound('That vendor is not on this enquiry.');

    await logAudit(ctx, { module: 'Enquiry', action: 'issue_vendor_link',
                          entityType: 'enquiry_vendors', entityId: ctx.params.evId });
    return { token, expiresInDays: days };
  });

  /* ── Public portal routes (no session) ── */

  router.post('/vendor-portal/load', async (ctx) => {
    const ev = await resolveToken(ctx.env, ctx.body?.token);
    if (!ev) throw errors.unauthorized('This link is invalid or has expired.');

    await ctx.env.DB.prepare(
      `update enquiry_vendors set viewed_at = coalesce(viewed_at, ?),
        invitation_status = case when invitation_status in ('pending','sent') then 'opened' else invitation_status end
       where id = ?`
    ).bind(nowIso(), ev.id).run();

    const [items, lines, terms] = await Promise.all([
      ctx.env.DB.prepare('select id, item_no, item_type, level, short_name, description, unit, quantity, remarks from enquiry_items where enquiry_id = ? order by item_no').bind(ev.enq_id).all(),
      ctx.env.DB.prepare('select enquiry_item_id, rate, gst_percent, remarks from vendor_quote_lines where enquiry_vendor_id = ?').bind(ev.id).all(),
      ctx.env.DB.prepare('select * from vendor_quote_terms where enquiry_vendor_id = ?').bind(ev.id).first(),
    ]);

    const lineMap = {};
    for (const l of lines.results) lineMap[l.enquiry_item_id] = { rate: l.rate, gst: l.gst_percent, remarks: l.remarks };

    // Deliberately narrow: this payload contains one invite. No other vendor,
    // no other enquiry, no rates but their own, no users, no audit.
    return {
      invite: { id: ev.id, vendorName: ev.vendor_name, vendorNumber: ev.vendor_number,
                status: ev.invitation_status, revision: ev.revision, locked: !!ev.locked_at,
                submittedAt: ev.submitted_at, expiresAt: ev.token_expires_at },
      enquiry: { no: ev.enquiry_no, title: ev.title, project: ev.project_name,
                 client: ev.client_name, dueDate: ev.submission_deadline,
                 validity: ev.validity, notes: ev.notes, terms: JSON.parse(ev.terms || '{}') },
      items: items.results,
      lines: lineMap,
      terms: terms || {},
    };
  });

  router.post('/vendor-portal/save', (ctx) => submitQuote(ctx, false));
  router.post('/vendor-portal/submit', (ctx) => submitQuote(ctx, true));

  /* ── Staff-side quotation entry (for quotes received offline, and for
     negotiating an already-submitted rate) ── */
  router.put('/enquiries/:id/vendors/:evId/lines', async (ctx) => {
    requirePerm(ctx, MODULE.COMPARISON, 'edit');
    const ev = await ctx.env.DB.prepare('select * from enquiry_vendors where id = ? and enquiry_id = ?')
      .bind(ctx.params.evId, ctx.params.id).first();
    if (!ev) throw errors.notFound('That vendor is not on this enquiry.');
    if (ev.locked_at && !ctx.user.is_admin) {
      throw errors.locked('This quotation is locked. Create a revision instead of editing it.');
    }
    const before = await snapshotBeforeStaffEdit(ctx, ev);
    const written = await writeLines(ctx.env, ev, ctx.body?.lines || {}, ctx.body?.terms);
    await logAudit(ctx, { module: 'Comparison', action: 'enter_quote', entityType: 'enquiry_vendors',
                          entityId: ev.id, target: ev.vendor_name,
                          oldValue: before && { lines: before }, newValue: { lines: written } });
    return { saved: written };
  });

  router.post('/enquiries/:id/vendors/:evId/lock', async (ctx) => {
    requirePerm(ctx, MODULE.COMPARISON, 'lock');
    const locked = ctx.body?.locked !== false;
    await ctx.env.DB.prepare(
      `update enquiry_vendors set locked_at = ?, invitation_status = ? where id = ? and enquiry_id = ?`
    ).bind(locked ? nowIso() : null, locked ? 'locked' : 'submitted', ctx.params.evId, ctx.params.id).run();
    await logAudit(ctx, { module: 'Comparison', action: locked ? 'lock_quote' : 'unlock_quote',
                          entityType: 'enquiry_vendors', entityId: ctx.params.evId });
    return { ok: true };
  });

  router.get('/enquiries/:id/vendors/:evId/revisions', async (ctx) => {
    requirePerm(ctx, MODULE.COMPARISON, 'view');
    const rows = await ctx.env.DB.prepare(
      'select * from vendor_quote_revisions where enquiry_vendor_id = ? order by revision_no desc'
    ).bind(ctx.params.evId).all();
    return { revisions: rows.results.map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot_json || '{}') })) };
  });
}

/** Preserve whatever is about to be overwritten by a staff edit (offline entry
    or negotiation) as its own revision — the same append-only pattern a vendor
    resubmission already uses below (see submitQuote) — so a negotiated rate
    never silently erases what the vendor actually submitted. Returns the
    preserved lines, or null when there was nothing recorded yet to preserve
    (the very first offline entry has no prior value). */
async function snapshotBeforeStaffEdit(ctx, ev) {
  const lines = await ctx.env.DB.prepare(
    'select * from vendor_quote_lines where enquiry_vendor_id = ?').bind(ev.id).all();
  if (!lines.results.length) return null;

  const terms = await ctx.env.DB.prepare(
    'select * from vendor_quote_terms where enquiry_vendor_id = ?').bind(ev.id).first();
  const next = await ctx.env.DB.prepare(
    'select coalesce(max(revision_no), 0) + 1 as n from vendor_quote_revisions where enquiry_vendor_id = ?'
  ).bind(ev.id).first();

  await ctx.env.DB.prepare(
    `insert into vendor_quote_revisions (id, enquiry_vendor_id, revision_no, submitted_by,
      base_amount, gst_amount, total_amount, snapshot_json, status, remarks)
     values (?,?,?,?,?,?,?,?,?,?)`
  ).bind(newId(), ev.id, next.n, ctx.user?.full_name || ctx.user?.username || 'Staff',
         ev.base_amount || 0, ev.gst_amount || 0, ev.total_amount || 0,
         JSON.stringify({ lines: lines.results, terms: terms || {} }),
         'pre_edit', 'Snapshot taken automatically before a staff edit overwrote these values').run();

  return lines.results;
}

/** Writes this vendor's lines. Items are verified to belong to THIS enquiry, so
    a crafted payload cannot write into another one. */
async function writeLines(env, ev, lines, terms) {
  const valid = await env.DB.prepare('select id, quantity from enquiry_items where enquiry_id = ?')
    .bind(ev.enquiry_id || ev.enq_id).all();
  const qtyById = new Map(valid.results.map((r) => [r.id, r.quantity]));

  const stmts = [];
  let n = 0;
  for (const [itemId, payload] of Object.entries(lines || {})) {
    if (!qtyById.has(itemId)) continue;               // silently ignore foreign ids
    const rate = num(payload?.rate);
    const gst = num(payload?.gst);
    stmts.push(env.DB.prepare(
      `insert into vendor_quote_lines (id, enquiry_vendor_id, enquiry_item_id, quantity, rate, gst_percent, remarks)
       values (?,?,?,?,?,?,?)
       on conflict(enquiry_vendor_id, enquiry_item_id) do update set
         quantity = excluded.quantity, rate = excluded.rate,
         gst_percent = excluded.gst_percent, remarks = excluded.remarks`
    ).bind(newId(), ev.id, itemId, qtyById.get(itemId) || 0, rate, gst, payload?.remarks || null));
    n++;
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));

  if (terms && typeof terms === 'object') {
    await env.DB.prepare(
      `insert into vendor_quote_terms (id, enquiry_vendor_id, payment_terms, credit_period,
        delivery_period, delivery_schedule, material_base_rate, warranty, validity, escalation,
        gst_inclusion, exclusions, other_terms, custom_terms)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict(enquiry_vendor_id) do update set
         payment_terms=excluded.payment_terms, credit_period=excluded.credit_period,
         delivery_period=excluded.delivery_period, delivery_schedule=excluded.delivery_schedule,
         material_base_rate=excluded.material_base_rate, warranty=excluded.warranty,
         validity=excluded.validity, escalation=excluded.escalation,
         gst_inclusion=excluded.gst_inclusion, exclusions=excluded.exclusions,
         other_terms=excluded.other_terms, custom_terms=excluded.custom_terms`
    ).bind(newId(), ev.id, terms.paymentTerms || null, terms.creditPeriod || null,
           terms.deliveryPeriod || null, terms.deliverySchedule || null, terms.materialBaseRate || null,
           terms.warranty || null, terms.validity || null, terms.escalation || null,
           terms.gstInclusion || null, terms.exclusions || null, terms.otherTerms || null,
           JSON.stringify(terms.custom || {})).run();
  }
  return n;
}

async function submitQuote(ctx, isSubmit) {
  const ev = await resolveToken(ctx.env, ctx.body?.token);
  if (!ev) throw errors.unauthorized('This link is invalid or has expired.');
  if (ev.locked_at) throw errors.locked('Your quotation is locked and can no longer be changed.');

  await writeLines(ctx.env, { id: ev.id, enquiry_id: ev.enq_id }, ctx.body?.lines || {}, ctx.body?.terms);

  if (!isSubmit) {
    await ctx.env.DB.prepare(
      `update enquiry_vendors set invitation_status = 'draft'
       where id = ? and invitation_status in ('pending','sent','opened')`).bind(ev.id).run();
    return { ok: true, draft: true };
  }

  const totals = await ctx.env.DB.prepare(
    'select base_amount, gst_amount, total_amount from enquiry_vendors where id = ?').bind(ev.id).first();
  const rev = (ev.revision || 0) + 1;

  // Immutable snapshot. Revising never overwrites what was submitted before.
  const [lines, terms] = await Promise.all([
    ctx.env.DB.prepare('select * from vendor_quote_lines where enquiry_vendor_id = ?').bind(ev.id).all(),
    ctx.env.DB.prepare('select * from vendor_quote_terms where enquiry_vendor_id = ?').bind(ev.id).first(),
  ]);

  await ctx.env.DB.prepare(
    `insert into vendor_quote_revisions (id, enquiry_vendor_id, revision_no, submitted_by,
      base_amount, gst_amount, total_amount, snapshot_json, remarks)
     values (?,?,?,?,?,?,?,?,?)`
  ).bind(newId(), ev.id, rev, ev.vendor_name, totals.base_amount, totals.gst_amount,
         totals.total_amount, JSON.stringify({ lines: lines.results, terms: terms || {} }),
         ctx.body?.remarks || null).run();

  await ctx.env.DB.prepare(
    `update enquiry_vendors set invitation_status = ?, revision = ?, submitted_at = ? where id = ?`
  ).bind(rev > 1 ? 'revised' : 'submitted', rev, nowIso(), ev.id).run();

  // Enquiry rolls to received once every invited vendor is in, else partial.
  const counts = await ctx.env.DB.prepare(
    `select count(*) as total,
       sum(case when invitation_status in ('submitted','revised','locked') then 1 else 0 end) as done
     from enquiry_vendors where enquiry_id = ? and deleted_at is null`
  ).bind(ev.enq_id).first();
  await ctx.env.DB.prepare(
    `update enquiries set status = ? where id = ? and status in ('draft','sent','partial')`
  ).bind(counts.done >= counts.total ? 'received' : 'partial', ev.enq_id).run();

  const watchers = await usersWhoCan(ctx.env, 'enquiry', 'view');
  await notify(ctx.env, watchers, {
    title: 'Quotation received',
    message: `${ev.vendor_name || 'A vendor'} submitted revision ${rev} for ${ev.enquiry_no}`,
    type: 'quote', referenceType: 'enquiries', referenceId: ev.enq_id,
  });

  await ctx.env.DB.prepare(
    `insert into audit_logs (id, user_name, module, action, entity_type, entity_id, target)
     values (?,?,?,?,?,?,?)`
  ).bind(newId(), ev.vendor_name || 'Vendor', 'Enquiry', 'vendor_submitted',
         'enquiry_vendors', ev.id, `${ev.enquiry_no} Rev ${rev}`).run();

  return { ok: true, revision: rev };
}
