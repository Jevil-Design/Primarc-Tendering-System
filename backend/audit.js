import { newId, ipOf, uaOf } from './lib/util.js';

/* ═══════════════════════════════════════════════════════════════
   Append-only audit trail. There is no update or delete path to audit_logs
   anywhere in this Worker, and user_name is denormalised so the record
   survives the user being removed.
   ═══════════════════════════════════════════════════════════════ */

export async function logAudit(ctx, { module, action, entityType, entityId, target,
                                      oldValue, newValue, reason } = {}) {
  try {
    await ctx.env.DB.prepare(
      `insert into audit_logs (id, user_id, user_name, module, action, entity_type,
        entity_id, target, old_value, new_value, reason, ip_address, user_agent)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      newId(),
      ctx.user?.id || null,
      ctx.user?.full_name || ctx.user?.username || null,
      module || null, action, entityType || null, entityId || null, target || null,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      reason || null,
      ipOf(ctx.request), uaOf(ctx.request)
    ).run();
  } catch (err) {
    // Auditing must never block the user's action.
    console.error('[audit] failed:', err.message);
  }
}

export async function notify(env, userIds, { title, message, type = 'info', referenceType, referenceId }) {
  if (!userIds || !userIds.length) return 0;
  const stmts = userIds.map((uid) =>
    env.DB.prepare(
      `insert into notifications (id, user_id, title, message, type, reference_type, reference_id)
       values (?,?,?,?,?,?,?)`
    ).bind(newId(), uid, title, message || null, type, referenceType || null, referenceId || null)
  );
  await env.DB.batch(stmts);
  return stmts.length;
}

/** Everyone whose designation grants an action on a module — for approvals. */
export async function usersWhoCan(env, moduleCode, action = 'approve') {
  const col = 'can_' + action;
  if (!/^can_(view|create|edit|delete|approve|reject|import|export|print|lock|unlock|share)$/.test(col)) return [];
  const rows = await env.DB.prepare(
    `select distinct u.id from users u
     join permissions p on p.designation_id = u.designation_id
     join modules m on m.id = p.module_id and m.code = ?
     where u.status = 'active' and u.deleted_at is null and p.${col} = 1`
  ).bind(moduleCode).all();
  return rows.results.map((r) => r.id);
}
