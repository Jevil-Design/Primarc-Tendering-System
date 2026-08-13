import { requirePerm, MODULE } from '../permissions.js';
import { logAudit } from '../audit.js';
import { newId, nowIso } from '../lib/util.js';
import { errors } from '../lib/response.js';

/* ═══════════════════════════════════════════════════════════════
   R2 object storage.

   Buckets are private. Bytes are never served directly from R2 — every read
   goes through this Worker, which re-checks the caller's permission first.
   That is stricter than a presigned URL: a leaked URL cannot outlive the
   permission that produced it.

   Path convention:  <owner_type>/<owner_id>/<timestamp>_<filename>
   ═══════════════════════════════════════════════════════════════ */

const PERM_FOR = {
  vendor:         [MODULE.VENDOR, 'edit'],
  vendor_logo:    [MODULE.VENDOR, 'edit'],
  boq:            [MODULE.BOQ, 'edit'],
  enquiry:        [MODULE.ENQUIRY, 'edit'],
  quotation:      [MODULE.COMPARISON, 'edit'],
  work_order:     [MODULE.WORK_ORDER, 'edit'],
  purchase_order: [MODULE.PURCHASE_ORDER, 'edit'],
};
const VIEW_FOR = {
  vendor:         [MODULE.VENDOR, 'view'],
  vendor_logo:    [MODULE.VENDOR, 'view'],
  boq:            [MODULE.BOQ, 'view'],
  enquiry:        [MODULE.ENQUIRY, 'view'],
  quotation:      [MODULE.COMPARISON, 'view'],
  work_order:     [MODULE.WORK_ORDER, 'view'],
  purchase_order: [MODULE.PURCHASE_ORDER, 'view'],
};

const safeName = (n) => String(n || 'file').replace(/[^\w.\-]/g, '_').slice(0, 120);

export default function register(router) {
  router.post('/documents/upload', async (ctx) => {
    const form = ctx.body;
    if (!form || typeof form.get !== 'function') {
      throw errors.validation('Send the file as multipart/form-data.');
    }
    const file = form.get('file');
    const ownerType = String(form.get('ownerType') || '');
    const ownerId = form.get('ownerId') ? String(form.get('ownerId')) : null;

    if (!file || typeof file.arrayBuffer !== 'function') throw errors.validation('No file was received.');
    const rule = PERM_FOR[ownerType];
    if (!rule) throw errors.validation('Unknown ownerType.');
    requirePerm(ctx, rule[0], rule[1]);

    if (file.size > 25 * 1024 * 1024) throw errors.validation('Files must be 25 MB or smaller.');

    const key = `${ownerType}/${ownerId || 'general'}/${Date.now()}_${safeName(file.name)}`;
    await ctx.env.DOCUMENTS.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
      customMetadata: { uploadedBy: ctx.user.id, ownerType, ownerId: ownerId || '' },
    });

    const id = newId();
    await ctx.env.DB.prepare(
      `insert into documents (id, owner_type, owner_id, file_name, file_key, content_type, file_size, uploaded_by)
       values (?,?,?,?,?,?,?,?)`
    ).bind(id, ownerType, ownerId, safeName(file.name), key, file.type || null, file.size, ctx.user.id).run();

    await logAudit(ctx, { module: 'Documents', action: 'upload', entityType: ownerType,
                          entityId: ownerId, target: safeName(file.name) });
    return { id, key, fileName: safeName(file.name), size: file.size };
  });

  router.get('/documents', async (ctx) => {
    const { ownerType, ownerId } = ctx.query;
    if (!ownerType) throw errors.validation('ownerType is required.');
    const rule = VIEW_FOR[ownerType];
    if (!rule) throw errors.validation('Unknown ownerType.');
    requirePerm(ctx, rule[0], rule[1]);

    const rows = await ctx.env.DB.prepare(
      `select id, owner_type, owner_id, file_name, file_key, content_type, file_size, uploaded_by, created_at
       from documents where owner_type = ? and (? is null or owner_id = ?) and deleted_at is null
       order by created_at desc`
    ).bind(ownerType, ownerId || null, ownerId || null).all();
    return { documents: rows.results };
  });

  /* Streamed through the Worker so the permission check cannot be bypassed by
     sharing a link. */
  router.get('/documents/:id/download', async (ctx) => {
    const doc = await ctx.env.DB.prepare('select * from documents where id = ? and deleted_at is null')
      .bind(ctx.params.id).first();
    if (!doc) throw errors.notFound('Document not found.');
    const rule = VIEW_FOR[doc.owner_type] || [MODULE.ENQUIRY, 'view'];
    requirePerm(ctx, rule[0], rule[1]);

    const obj = await ctx.env.DOCUMENTS.get(doc.file_key);
    if (!obj) throw errors.notFound('That file is no longer in storage.');

    return new Response(obj.body, {
      headers: {
        'Content-Type': doc.content_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${doc.file_name}"`,
        'Cache-Control': 'private, max-age=0, no-store',
      },
    });
  });

  router.delete('/documents/:id', async (ctx) => {
    const doc = await ctx.env.DB.prepare('select * from documents where id = ?').bind(ctx.params.id).first();
    if (!doc) throw errors.notFound('Document not found.');
    const rule = PERM_FOR[doc.owner_type];
    if (rule) requirePerm(ctx, rule[0], rule[1]);

    await ctx.env.DOCUMENTS.delete(doc.file_key).catch(() => {});
    await ctx.env.DB.prepare('update documents set deleted_at = ? where id = ?').bind(nowIso(), ctx.params.id).run();
    await logAudit(ctx, { module: 'Documents', action: 'delete', entityType: doc.owner_type,
                          entityId: doc.owner_id, target: doc.file_name });
    return { ok: true };
  });
}
