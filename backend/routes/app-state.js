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
  if (!row) return { version: 0, data: null };
  try {
    const parsed = JSON.parse(row.setting_value);
    return { version: parsed.__version || 0, data: parsed.data ?? null };
  } catch {
    return { version: 0, data: null };
  }
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

    const { version: curVersion, data: curData } = await readRow(ctx.env);

    // Optimistic concurrency. baseVersion omitted = force (used only for the
    // very first seed); otherwise it must match what is on the server.
    if (body.baseVersion !== undefined && body.baseVersion !== null &&
        Number(body.baseVersion) !== curVersion) {
      // The conflict body hands the client the server's copy so it can adopt
      // it without a second round trip — so it has to be redacted exactly like
      // a GET, or a losing save would become a way to read the whole document.
      throw errors.conflict('The data was changed on another computer. Reload before saving.',
        { serverVersion: curVersion, state: redactState(curData, acl).state });
    }

    // Throws 403 on an unauthorised edit; re-grafts sections the caller
    // was not allowed to see so their blanks cannot delete anyone's data.
    const { data: merged, restored } = mergeStateWrite(body.data, curData, acl);

    const next = { __version: curVersion + 1, data: merged };
    await ctx.env.DB.prepare(
      `insert into system_settings (id, setting_key, setting_value, updated_by) values (?,?,?,?)
       on conflict(setting_key) do update set setting_value = excluded.setting_value,
         updated_by = excluded.updated_by`
    ).bind(newId(), KEY, JSON.stringify(next), ctx.user.id).run();

    if (restored.length) {
      await logAudit(ctx, { module: 'Administration', action: 'app_state_section_preserved',
        entityType: 'system_settings', target: KEY,
        reason: `Caller cannot view: ${restored.join(', ')} — server copy kept.` });
    }
    return { ok: true, version: next.__version, preserved: restored };
  });
}
