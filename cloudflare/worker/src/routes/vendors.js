import { requirePerm, MODULE } from '../permissions.js';
import { validate } from '../validation.js';
import { logAudit } from '../audit.js';
import { newId, nowIso, normalize, similarity } from '../lib/util.js';
import { errors } from '../lib/response.js';

/* Duplicate prevention runs at two levels:
     · exact  — a unique index on name_normalized (live rows only)
     · fuzzy  — similarity scoring in the Worker over a shortlist, because D1
                has no pg_trgm. Near misses are REPORTED, never auto-merged;
                merging "Sharma Constructions" into "Sharma Construction" without
                asking would silently corrupt rate history. */
export default function register(router) {
  router.get('/vendors', async (ctx) => {
    requirePerm(ctx, MODULE.VENDOR, 'view');
    const limit = Math.min(parseInt(ctx.query.limit || '500', 10), 2000);
    const offset = parseInt(ctx.query.offset || '0', 10);
    const where = ['deleted_at is null'], binds = [];
    if (ctx.query.search) { where.push('(name like ? or skillset like ? or city like ?)');
      const s = '%' + ctx.query.search + '%'; binds.push(s, s, s); }
    if (ctx.query.status) { where.push('status = ?'); binds.push(ctx.query.status); }
    const rows = await ctx.env.DB.prepare(
      `select * from vendors where ${where.join(' and ')} order by name limit ? offset ?`
    ).bind(...binds, limit, offset).all();
    const total = await ctx.env.DB.prepare(
      `select count(*) as n from vendors where ${where.join(' and ')}`).bind(...binds).first();
    return { vendors: rows.results, total: total.n };
  });

  router.get('/vendors/search', async (ctx) => {
    requirePerm(ctx, MODULE.VENDOR, 'view');
    const q = (ctx.query.q || '').trim();
    if (!q) return { vendors: [] };
    const rows = await ctx.env.DB.prepare(
      `select id, name, vendor_code, city, phone, email, skillset from vendors
       where deleted_at is null and name like ? order by name limit 25`
    ).bind('%' + q + '%').all();
    return { vendors: rows.results };
  });

  router.get('/vendors/:id', async (ctx) => {
    requirePerm(ctx, MODULE.VENDOR, 'view');
    const row = await ctx.env.DB.prepare('select * from vendors where id = ?').bind(ctx.params.id).first();
    if (!row) throw errors.notFound('Vendor not found.');
    return { vendor: row };
  });

  router.post('/vendors', async (ctx) => {
    requirePerm(ctx, MODULE.VENDOR, 'create');
    const v = validate(ctx.body)
      .string('name', { required: true, max: 200 })
      .string('legalName', { max: 200 }).string('skillset', { max: 200 })
      .string('phone', { max: 40 }).email('email')
      .string('address', { max: 500 }).string('city', { max: 80 })
      .string('state', { max: 80 }).string('pincode', { max: 12 })
      .string('pan', { max: 20 }).string('gstin', { max: 20 })
      .string('contactPerson', { max: 120 }).string('notes', { max: 2000 })
      .string('vendorCode', { max: 40 })
      .done();

    const norm = normalize(v.name);
    const exact = await ctx.env.DB.prepare(
      'select id, name from vendors where name_normalized = ? and deleted_at is null').bind(norm).first();
    if (exact) return { id: exact.id, duplicate: true, action: 'existing', matched: exact.name };

    if (!ctx.body?.force) {
      // Shortlist on the first token, then score in JS — avoids scanning 949 rows.
      const token = norm.split(' ')[0] || norm;
      const near = await ctx.env.DB.prepare(
        'select id, name from vendors where deleted_at is null and name_normalized like ? limit 40'
      ).bind('%' + token + '%').all();
      const similar = near.results
        .map((r) => ({ id: r.id, name: r.name, similarity: Math.round(similarity(r.name, v.name) * 1000) / 1000 }))
        .filter((r) => r.similarity > 0.62)
        .sort((a, b) => b.similarity - a.similarity).slice(0, 5);
      if (similar.length) {
        throw errors.conflict('This vendor looks like an existing one. Confirm to add it anyway.',
                              { needsReview: true, similar });
      }
    }

    const id = newId();
    await ctx.env.DB.prepare(
      `insert into vendors (id, vendor_code, name, name_normalized, legal_name, skillset, phone, email,
        address, city, state, pincode, pan, gstin, contact_person, notes, created_by, updated_by)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, v.vendorCode, v.name, norm, v.legalName, v.skillset, v.phone, v.email,
           v.address, v.city, v.state, v.pincode, v.pan, v.gstin, v.contactPerson, v.notes,
           ctx.user.id, ctx.user.id).run();

    await logAudit(ctx, { module: 'Vendor', action: 'create', entityType: 'vendors', entityId: id, target: v.name });
    return { id, duplicate: false, action: 'created' };
  });

  router.put('/vendors/:id', async (ctx) => {
    requirePerm(ctx, MODULE.VENDOR, 'edit');
    const id = ctx.params.id;
    const before = await ctx.env.DB.prepare('select * from vendors where id = ?').bind(id).first();
    if (!before) throw errors.notFound('Vendor not found.');

    const b = ctx.body || {};
    const map = { name: 'name', legalName: 'legal_name', vendorCode: 'vendor_code', skillset: 'skillset',
      phone: 'phone', email: 'email', address: 'address', city: 'city', state: 'state',
      pincode: 'pincode', pan: 'pan', gstin: 'gstin', contactPerson: 'contact_person',
      notes: 'notes', status: 'status', rating: 'rating' };
    const sets = [], binds = [];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] !== undefined) { sets.push(`${col} = ?`); binds.push(b[k] === '' ? null : b[k]); }
    }
    // name_normalized must track name, or duplicate detection silently rots.
    if (b.name !== undefined) { sets.push('name_normalized = ?'); binds.push(normalize(b.name)); }
    if (!sets.length) return { vendor: before };
    sets.push('updated_by = ?'); binds.push(ctx.user.id);
    binds.push(id);

    await ctx.env.DB.prepare(`update vendors set ${sets.join(', ')} where id = ?`).bind(...binds).run();
    const after = await ctx.env.DB.prepare('select * from vendors where id = ?').bind(id).first();
    await logAudit(ctx, { module: 'Vendor', action: 'update', entityType: 'vendors', entityId: id, oldValue: before, newValue: after });
    return { vendor: after };
  });

  router.delete('/vendors/:id', async (ctx) => {
    requirePerm(ctx, MODULE.VENDOR, 'delete');
    await ctx.env.DB.prepare('update vendors set deleted_at = ?, deleted_by = ? where id = ?')
      .bind(nowIso(), ctx.user.id, ctx.params.id).run();
    await logAudit(ctx, { module: 'Vendor', action: 'delete', entityType: 'vendors', entityId: ctx.params.id });
    return { ok: true };
  });

  /* Bulk import used by the vendor-master seeding step. Chunked because D1
     caps statements per batch. */
  router.post('/vendors/bulk', async (ctx) => {
    requirePerm(ctx, MODULE.VENDOR, 'import');
    const list = Array.isArray(ctx.body?.vendors) ? ctx.body.vendors : [];
    if (!list.length) return { inserted: 0, skipped: 0 };

    let inserted = 0, skipped = 0;
    const seen = new Set();
    const stmts = [];
    for (const raw of list) {
      const name = String(raw?.name || raw || '').trim();
      if (!name) { skipped++; continue; }
      const norm = normalize(name);
      if (!norm || seen.has(norm)) { skipped++; continue; }
      seen.add(norm);
      stmts.push(ctx.env.DB.prepare(
        `insert into vendors (id, name, name_normalized, skillset, phone, email, city, created_by)
         values (?,?,?,?,?,?,?,?) on conflict do nothing`
      ).bind(newId(), name, norm, raw?.skillset || null, raw?.phone || null,
             raw?.email || null, raw?.city || null, ctx.user.id));
    }
    for (let i = 0; i < stmts.length; i += 100) {
      const res = await ctx.env.DB.batch(stmts.slice(i, i + 100));
      inserted += res.reduce((n, r) => n + (r.meta?.changes || 0), 0);
    }
    skipped += stmts.length - inserted;
    await logAudit(ctx, { module: 'Vendor', action: 'bulk_import', entityType: 'vendors',
                          newValue: { received: list.length, inserted, skipped } });
    return { inserted, skipped, received: list.length };
  });
}
