import { errors } from '../lib/response.js';
import { newId } from '../lib/util.js';
import { stateAccess, redactState, mergeStateWrite } from '../lib/state-acl.js';
import { logAudit } from '../audit.js';

/* ═══════════════════════════════════════════════════════════════
   Shared application state — the central copy of the whole-team tender
   dataset that used to live in each browser's localStorage `qm_data_v2`
   blob. Storing it in D1 is what makes every computer see the same data:
   the frontend pulls it on load/login (resync) and pushes it on save.

   Authorisation is per SECTION, in lib/state-acl.js, using the same
   designation matrix the normalised routes enforce. This route used to
   require nothing but a live session, which meant any account — whatever
   its designation — could read every vendor rate, comparison and work
   order in the business, and overwrite all of it in one PUT. The rich
   normalised tables (enquiries, work_orders, vendors, …) remain the
   structured/reporting layer and the target of the /migrate/import path;
   this document is the live app's source of truth.

   Optimistic concurrency: each save carries the version it was based on.
   If the server moved on since (another computer saved first), the write
   is refused with 409 so the client reloads instead of clobbering — this
   is the data-loss guard. Stored as one row in system_settings so no new
   table is needed.
   ═══════════════════════════════════════════════════════════════ */

const KEY = 'app_state_v1';

async function readRow(env) {
  const row = await env.DB.prepare(
    'select setting_value from system_settings where setting_key = ?'
  ).bind(KEY).first();
  if (!row) return { version: 0, data: null, raw: null };
  try {
    const parsed = JSON.parse(row.setting_value);
    return { version: parsed.__version || 0, data: parsed.data ?? null, raw: row.setting_value };
  } catch {
    return { version: 0, data: null, raw: row.setting_value };
  }
}

/* Compare-and-swap on the version: the write only lands if the row still
   carries the version we read. Checking the version and then writing in two
   statements let two simultaneous saves both pass the check — the second
   silently erased the first. Returns false when someone else wrote between. */
async function writeRow(env, prevVersion, exists, nextRaw, userId) {
  const res = !exists
    ? await env.DB.prepare(
        `insert into system_settings (id, setting_key, setting_value, updated_by) values (?,?,?,?)
         on conflict(setting_key) do nothing`
      ).bind(newId(), KEY, nextRaw, userId).run()
    : await env.DB.prepare(
        `update system_settings set setting_value = ?, updated_by = ?
         where setting_key = ? and coalesce(json_extract(setting_value, '$.__version'), 0) = ?`
      ).bind(nextRaw, userId, KEY, prevVersion).run();
  return !!(res && res.meta && res.meta.changes);
}

export default function register(router) {
  router.get('/app-state', async (ctx) => {
    if (!ctx.user) throw errors.unauthorized();
    const acl = stateAccess(ctx);
    if (acl.blind) {
      throw errors.forbidden('Your role has no access to tender data. Ask an administrator to grant it.');
    }
    const { version, data } = await readRow(ctx.env);
    const { state, withheld } = redactState(data, acl);
    return { state, version, withheld };
  });

  router.put('/app-state', async (ctx) => {
    if (!ctx.user) throw errors.unauthorized();
    const body = ctx.body || {};
    if (body.data === undefined) throw errors.validation('data is required.');

    const acl = stateAccess(ctx);
    if (acl.blind) throw errors.forbidden('Your role has no access to tender data.');

    // Optimistic concurrency: every save names the version it was based on.
    // Omitting it means "I expect nothing stored yet" (version 0) — it used
    // to mean "overwrite whatever is there", which let a stale browser
    // flushing on logout erase everything saved since it last synced.
    const baseVersion = (body.baseVersion === undefined || body.baseVersion === null)
      ? 0 : Number(body.baseVersion);
    const { version: curVersion, data: curData, raw } = await readRow(ctx.env);

    // The conflict body hands the client the server's copy so it can merge
    // without a second round trip — so it has to be redacted exactly like a
    // GET, or a losing save would become a way to read the whole document.
    const conflict = (version, data) => errors.conflict(
      'The data was changed on another computer. Reload before saving.',
      { serverVersion: version, state: redactState(data, acl).state });

    if (baseVersion !== curVersion) throw conflict(curVersion, curData);

    // Throws 403 on an unauthorised edit; re-grafts sections the caller
    // was not allowed to see so their blanks cannot delete anyone's data.
    const { data: merged, restored } = mergeStateWrite(body.data, curData, acl);

    const next = { __version: curVersion + 1, data: merged };
    if (!(await writeRow(ctx.env, curVersion, raw !== null, JSON.stringify(next), ctx.user.id))) {
      const fresh = await readRow(ctx.env);
      throw conflict(fresh.version, fresh.data);
    }

    if (restored.length) {
      await logAudit(ctx, { module: 'Administration', action: 'app_state_section_preserved',
        entityType: 'system_settings', target: KEY,
        reason: `Caller cannot view: ${restored.join(', ')} — server copy kept.` });
    }
    return { ok: true, version: next.__version, preserved: restored };
  });
}
