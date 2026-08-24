import { requirePerm, MODULE } from '../permissions.js';
import { logAudit } from '../audit.js';
import { newId, nowIso, normalize } from '../lib/util.js';
import { errors } from '../lib/response.js';

/* ═══════════════════════════════════════════════════════════════
   One-time import of the browser's localStorage into D1.

   Admin-only, dry-run capable, and idempotent: records carry their original
   key in legacy_id, so a second run updates rather than duplicates.

   localStorage is never cleared by this endpoint — the frontend tool does that
   only after the operator confirms the data looks right.
   ═══════════════════════════════════════════════════════════════ */
export default function register(router) {
  router.post('/migrate/import', async (ctx) => {
    requirePerm(ctx, MODULE.ADMIN, 'import');
    const ls = ctx.body?.localStorage;
    const dryRun = !!ctx.body?.dryRun;
    if (!ls || typeof ls !== 'object') throw errors.validation('Expected { localStorage: { key: value } }.');

    const report = { dryRun, found: {}, migrated: {}, skipped: {}, errors: [], warnings: [], review: [] };
    const bump = (b, k, n = 1) => { report[b][k] = (report[b][k] || 0) + n; };
    const parse = (k) => {
      if (!(k in ls)) return undefined;
      try { return typeof ls[k] === 'string' ? JSON.parse(ls[k]) : ls[k]; }
      catch { report.errors.push(k + ': not valid JSON'); return undefined; }
    };

    // ── vendors ──
    const qm = parse('qm_data_v2');
    const vendorNames = new Map();
    const addVendor = (n) => {
      const name = String(n || '').trim();
      if (!name) return;
      const key = normalize(name);
      if (key && !vendorNames.has(key)) vendorNames.set(key, name);
    };
    (Array.isArray(ctx.body?.vendorMaster) ? ctx.body.vendorMaster : []).forEach((v) =>
      addVendor(typeof v === 'string' ? v : v?.name));
    if (qm?.quotations) for (const q of qm.quotations) for (const v of (q.vendors || [])) addVendor(v.name);
    (qm?.vendorMaster || []).forEach((v) => addVendor(typeof v === 'string' ? v : v?.name));
    bump('found', 'vendors', vendorNames.size);

    if (!dryRun && vendorNames.size) {
      const rows = [...vendorNames.entries()];
      for (let i = 0; i < rows.length; i += 100) {
        const stmts = rows.slice(i, i + 100).map(([norm, name]) => ctx.env.DB.prepare(
          `insert into vendors (id, name, name_normalized, created_by) values (?,?,?,?)
           on conflict do nothing`
        ).bind(newId(), name, norm, ctx.user.id));
        const res = await ctx.env.DB.batch(stmts);
        bump('migrated', 'vendors', res.reduce((n, r) => n + (r.meta?.changes || 0), 0));
      }
      bump('skipped', 'vendors', vendorNames.size - (report.migrated.vendors || 0));
    }

    // ── BOQ master custom items ──
    // Stored shape: [name, desc, uom, cat, vendors[], projects[], subcat]
    const master = parse('tnd_master_custom_v1') || [];
    bump('found', 'boq_master_items', master.length);
    if (!dryRun) {
      for (const r of master) {
        if (!Array.isArray(r) || !r[0]) continue;
        const name = String(r[0]).trim();
        const norm = normalize(name);
        const existing = await ctx.env.DB.prepare(
          `select id from boq_master_items where short_name_normalized = ?
           and coalesce(category,'') = coalesce(?,'') and deleted_at is null`
        ).bind(norm, r[3] || null).first();

        let itemId = existing?.id;
        if (!itemId) {
          itemId = newId();
          await ctx.env.DB.prepare(
            `insert into boq_master_items (id, short_name, short_name_normalized, description, unit,
              category, subcategory, source, created_by) values (?,?,?,?,?,?,?, 'migration', ?)`
          ).bind(itemId, name, norm, r[1] || name, r[2] || null, r[3] || null, r[6] || null, ctx.user.id).run();
          bump('migrated', 'boq_master_items');
        } else bump('skipped', 'boq_master_items');

        for (const v of (r[4] || [])) {
          if (!v || !v[0] || !(Number(v[1]) > 0)) continue;
          await ctx.env.DB.prepare(
            `insert into boq_master_rates (id, master_item_id, vendor_name, project_name, rate, unit, source)
             values (?,?,?,?,?,?, 'migration')`
          ).bind(newId(), itemId, v[0], (v[2] && v[2][0]) || (r[5] && r[5][0]) || null,
                 Number(v[1]), r[2] || null).run();
          bump('migrated', 'boq_master_rates');
        }
      }
    }

    // ── enquiries, vendors, quote lines, work orders ──
    if (qm?.quotations) {
      const all = qm.quotations.concat(qm.deleted || []);
      bump('found', 'enquiries', all.length);

      if (!dryRun) {
        const vres = await ctx.env.DB.prepare('select id, name from vendors').all();
        const vidByNorm = new Map(vres.results.map((v) => [normalize(v.name), v.id]));

        for (const q of all) {
          try {
            const enqId = newId();
            const ins = await ctx.env.DB.prepare(
              `insert into enquiries (id, enquiry_no, legacy_id, project_name, reference_code,
                client_name, title, notes, status, revision, terms, created_by, updated_by, deleted_at)
               values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               on conflict(legacy_id) do nothing`
            ).bind(enqId, q.base, q.base, q.projectName || null, q.ref || null, q.clientName || null,
                   q.subject || q.title || null, q.notes || null,
                   q.status === 'submitted' ? 'received' : (q.status || 'draft'),
                   q.rev || 0, JSON.stringify(q.terms || {}), ctx.user.id, ctx.user.id,
                   (qm.deleted || []).includes(q) ? nowIso() : null).run();

            const row = await ctx.env.DB.prepare('select id from enquiries where legacy_id = ?').bind(q.base).first();
            const eid = row?.id;
            if (!eid) { report.errors.push('enquiry ' + q.base + ': could not resolve id'); continue; }
            if (ins.meta.changes) bump('migrated', 'enquiries'); else bump('skipped', 'enquiries');

            await ctx.env.DB.prepare('delete from enquiry_items where enquiry_id = ?').bind(eid).run();
            const itemIds = [];
            const itemStmts = (q.items || []).map((it, i) => {
              const iid = newId(); itemIds.push(iid);
              return ctx.env.DB.prepare(
                `insert into enquiry_items (id, enquiry_id, item_no, item_type, level, short_name,
                  description, category, subcategory, unit, quantity, remarks)
                 values (?,?,?,?,?,?,?,?,?,?,?,?)`
              ).bind(iid, eid, i + 1, it.type || 'item', it.level || 0, it.name || null,
                     it.desc || null, it.cat || null, it.subcat || null, it.uom || null,
                     Number(it.qty) || 0, it.remarks || null);
            });
            for (let i = 0; i < itemStmts.length; i += 100) await ctx.env.DB.batch(itemStmts.slice(i, i + 100));
            bump('migrated', 'enquiry_items', itemIds.length);

            for (let vi = 0; vi < (q.vendors || []).length; vi++) {
              const v = q.vendors[vi];
              const evId = newId();
              await ctx.env.DB.prepare(
                `insert into enquiry_vendors (id, enquiry_id, vendor_id, vendor_name, vendor_number,
                  invitation_status, revision, invited_at, viewed_at, submitted_at, locked_at)
                 values (?,?,?,?,?,?,?,?,?,?,?) on conflict(enquiry_id, vendor_number) do nothing`
              ).bind(evId, eid, vidByNorm.get(normalize(v.name)) || null, v.name || null, v.vno || vi + 1,
                     v.status || ((v.lines || []).some((l) => Number(l?.rate) > 0) ? 'submitted' : 'pending'),
                     v.rev || 0, v.sentAt ? new Date(v.sentAt).toISOString() : null,
                     v.openedAt ? new Date(v.openedAt).toISOString() : null,
                     v.submittedAt ? new Date(v.submittedAt).toISOString() : null,
                     v.locked ? nowIso() : null).run();

              const evRow = await ctx.env.DB.prepare(
                'select id from enquiry_vendors where enquiry_id = ? and vendor_number = ?')
                .bind(eid, v.vno || vi + 1).first();
              if (!evRow) continue;
              bump('migrated', 'enquiry_vendors');

              // The old model indexed lines by array position against q.items.
              let orphans = 0;
              const lineStmts = [];
              (v.lines || []).forEach((l, li) => {
                if (!l || !(Number(l.rate) > 0)) return;
                if (!itemIds[li]) { orphans++; return; }
                // quantity is copied from the enquiry item so the generated
                // amount/GST columns compute against the right basis.
                lineStmts.push(ctx.env.DB.prepare(
                  `insert into vendor_quote_lines
                     (id, enquiry_vendor_id, enquiry_item_id, quantity, rate, gst_percent, remarks)
                   select ?, ?, ?, coalesce(quantity, 0), ?, ?, ?
                   from enquiry_items where id = ?`
                ).bind(newId(), evRow.id, itemIds[li], Number(l.rate) || 0,
                       Number(l.gst) || 0, l.remarks || null, itemIds[li]));
              });
              for (let i = 0; i < lineStmts.length; i += 100) await ctx.env.DB.batch(lineStmts.slice(i, i + 100));
              bump('migrated', 'vendor_quote_lines', lineStmts.length);
              if (orphans) {
                report.review.push(`${q.base} / ${v.name || 'vendor ' + (vi + 1)}: ${orphans} quoted line(s) had no matching item and were not imported.`);
              }

              if (v.terms && Object.keys(v.terms).length) {
                await ctx.env.DB.prepare(
                  `insert into vendor_quote_terms (id, enquiry_vendor_id, payment_terms, credit_period,
                    delivery_schedule, material_base_rate, warranty, validity, escalation, gst_inclusion, custom_terms)
                   values (?,?,?,?,?,?,?,?,?,?,?) on conflict(enquiry_vendor_id) do nothing`
                ).bind(newId(), evRow.id, v.terms.paymentTerms || null, v.terms.creditPeriod || null,
                       v.terms.deliverySchedule || null, v.terms.materialBaseRate || null,
                       v.terms.warranty || null, v.terms.validity || null, v.terms.escalation || null,
                       v.terms.gstInclusion || null, JSON.stringify(v.terms.custom || {})).run();
              }

              for (const ver of (v.versions || [])) {
                await ctx.env.DB.prepare(
                  `insert into vendor_quote_revisions (id, enquiry_vendor_id, revision_no, submitted_at,
                    total_amount, snapshot_json) values (?,?,?,?,?,?)
                   on conflict(enquiry_vendor_id, revision_no) do nothing`
                ).bind(newId(), evRow.id, ver.rev || 1,
                       ver.at ? new Date(ver.at).toISOString() : nowIso(),
                       Number(ver.total) || 0, JSON.stringify(ver)).run();
              }
            }
          } catch (err) {
            report.errors.push('enquiry ' + (q.base || '?') + ': ' + err.message);
          }
        }
      }

      bump('found', 'work_orders', (qm.workOrders || []).length);
      if (!dryRun) {
        for (const w of (qm.workOrders || [])) {
          try {
            await ctx.env.DB.prepare(
              `insert into work_orders (id, work_order_no, legacy_id, vendor_name, project_name,
                project_reference, amount, gst_amount, total_amount, status, issue_date, terms, created_by)
               values (?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(legacy_id) do nothing`
            ).bind(newId(), w.no || w.id, w.id || w.no, w.vendorName || null, w.projectName || null,
                   w.ref || null, Number(w.base) || 0, Number(w.gst) || 0, Number(w.total) || 0,
                   w.status || 'issued', w.date ? String(w.date).slice(0, 10) : null,
                   JSON.stringify(w.terms || {}), ctx.user.id).run();
            bump('migrated', 'work_orders');
          } catch (e) { report.errors.push('work order: ' + e.message); }
        }
      }
    }

    // ── ERP audit + policy ──
    const audit = parse('erp_audit') || [];
    bump('found', 'erp_audit', audit.length);
    if (!dryRun && audit.length) {
      const rows = audit.slice(0, 2000);
      for (let i = 0; i < rows.length; i += 100) {
        const stmts = rows.slice(i, i + 100).map((a) => ctx.env.DB.prepare(
          `insert into audit_logs (id, user_name, module, action, entity_type, target, reason, created_at)
           values (?,?,?,?,?,?,?,?)`
        ).bind(newId(), a.user || null, a.module || null, a.action || 'unknown',
               a.entity || null, a.target || null, a.reason || null,
               a.ts ? new Date(a.ts).toISOString() : nowIso()));
        await ctx.env.DB.batch(stmts);
        bump('migrated', 'erp_audit', stmts.length);
      }
    }

    const policy = parse('erp_policy');
    if (policy) {
      bump('found', 'erp_policy', 1);
      if (!dryRun) {
        await ctx.env.DB.prepare(
          `update system_policy set password_min_length = ?, password_expiry_days = ?,
           lock_after_attempts = ?, session_timeout_minutes = ?, two_factor_enabled = ?,
           concurrent_session_max = ? where id = 1`
        ).bind(policy.pwMin || 8, policy.pwExpiry || 90, policy.lockAttempts || 5,
               policy.sessionTimeout || 30, policy.twoFactor ? 1 : 0, policy.concurrentMax || 3).run();
        bump('migrated', 'erp_policy', 1);
      }
    }

    // Users cannot be migrated: the old SHA-256 hashes are not PBKDF2, and
    // re-hashing a hash is not the same credential. Each is listed for
    // re-invitation instead of silently creating an unusable account.
    const users = parse('ts_users') || [];
    if (users.length) {
      bump('found', 'ts_users', users.length);
      bump('skipped', 'ts_users', users.length);
      for (const u of users) {
        report.review.push(`User "${u.username || '?'}" (${u.role || 'no role'}) must be re-created — password hashes cannot be imported.`);
      }
    }

    if (!dryRun) {
      await ctx.env.DB.prepare(
        `insert into system_settings (id, setting_key, setting_value, updated_by) values (?,?,?,?)
         on conflict(setting_key) do update set setting_value = excluded.setting_value`
      ).bind(newId(), 'migration_report', JSON.stringify(report), ctx.user.id).run();
      await logAudit(ctx, { module: 'Administration', action: 'migrate_localstorage', newValue: report.migrated });
    }

    return report;
  });
}
