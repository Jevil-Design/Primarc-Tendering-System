import { requirePerm, MODULE } from '../permissions.js';
import { logAudit } from '../audit.js';
import { newId } from '../lib/util.js';
import { errors } from '../lib/response.js';

/* Ranking comes from the database views, never from the browser. The sheet,
   the exports and bid analysis therefore cannot disagree — which matters,
   because an approval decision is made from this number. */
export default function register(router) {
  router.get('/comparison/:enquiryId', async (ctx) => {
    requirePerm(ctx, MODULE.COMPARISON, 'view');
    const id = ctx.params.enquiryId;

    const [items, totals, enquiry] = await Promise.all([
      ctx.env.DB.prepare(
        'select * from vendor_comparison_view where enquiry_id = ? order by item_no, rank').bind(id).all(),
      ctx.env.DB.prepare(
        'select * from vendor_total_ranking_view where enquiry_id = ? order by rank').bind(id).all(),
      ctx.env.DB.prepare('select id, enquiry_no, title, project_name, status from enquiries where id = ?').bind(id).first(),
    ]);
    if (!enquiry) throw errors.notFound('Enquiry not found.');

    // L1..Ln per item, in the shape the existing sheet renders.
    const byItem = {};
    for (const r of items.results) {
      (byItem[r.enquiry_item_id] ||= { itemNo: r.item_no, name: r.short_name, unit: r.unit,
                                        quantity: r.quantity, vendors: [] });
      byItem[r.enquiry_item_id].vendors.push({
        enquiryVendorId: r.enquiry_vendor_id, vendorId: r.vendor_id, vendorName: r.vendor_name,
        rate: r.rate, amount: r.amount, gstPercent: r.gst_percent, gstAmount: r.gst_amount,
        totalAmount: r.total_amount, rank: r.rank, label: 'L' + r.rank,
      });
    }

    return {
      enquiry,
      items: Object.entries(byItem).map(([enquiryItemId, v]) => ({ enquiryItemId, ...v })),
      totals: totals.results.map((t) => ({ ...t, label: 'L' + t.rank })),
    };
  });

  router.get('/bid-analysis/:enquiryId', async (ctx) => {
    requirePerm(ctx, MODULE.COMPARISON, 'view');
    const rows = await ctx.env.DB.prepare(
      'select * from bid_analysis where enquiry_id = ? order by created_at desc').bind(ctx.params.enquiryId).all();
    return { analyses: rows.results.map((r) => ({ ...r, analysis: JSON.parse(r.analysis || '{}'),
                                                  is_ai_generated: !!r.is_ai_generated })) };
  });

  router.post('/bid-analysis', async (ctx) => {
    requirePerm(ctx, MODULE.COMPARISON, 'create');
    const b = ctx.body || {};
    if (!b.enquiryId) throw errors.validation('enquiryId is required.');
    const id = newId();
    await ctx.env.DB.prepare(
      `insert into bid_analysis (id, enquiry_id, vendor_id, enquiry_vendor_id, rank, quoted_amount,
        gst_amount, total_amount, recommendation, reasoning, risk_notes, savings_opportunity,
        analysis, is_ai_generated, remarks, created_by)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, b.enquiryId, b.vendorId || null, b.enquiryVendorId || null, b.rank || null,
           Number(b.quotedAmount) || 0, Number(b.gstAmount) || 0, Number(b.totalAmount) || 0,
           b.recommendation || null, b.reasoning || null, b.riskNotes || null,
           b.savingsOpportunity == null ? null : Number(b.savingsOpportunity),
           JSON.stringify(b.analysis || {}), b.isAiGenerated ? 1 : 0, b.remarks || null, ctx.user.id).run();

    await logAudit(ctx, { module: 'Comparison', action: 'save_bid_analysis',
                          entityType: 'bid_analysis', entityId: id, target: b.enquiryId });
    return { id };
  });

  /* AI output is advisory. Acceptance is a separate, recorded human act — it is
     never applied to a commercial decision automatically. */
  router.post('/bid-analysis/:id/accept', async (ctx) => {
    requirePerm(ctx, MODULE.COMPARISON, 'approve');
    await ctx.env.DB.prepare('update bid_analysis set accepted_by = ?, accepted_at = ? where id = ?')
      .bind(ctx.user.id, new Date().toISOString(), ctx.params.id).run();
    await logAudit(ctx, { module: 'Comparison', action: 'accept_recommendation',
                          entityType: 'bid_analysis', entityId: ctx.params.id });
    return { ok: true };
  });
}
