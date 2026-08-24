import { errors } from '../lib/response.js';
import { newId } from '../lib/util.js';

/* ═══════════════════════════════════════════════════════════════
   Shared application state — the central copy of the whole-team tender
   dataset that used to live in each browser's localStorage `qm_data_v2`
   blob. Storing it in D1 is what makes every computer see the same data:
   the frontend pulls it on load/login (resync) and pushes it on save.

   Any signed-in user may read and write it — the whole team edits the
   same tender data. The rich normalised tables (enquiries, work_orders,
   vendors, …) remain the structured/reporting layer and the target of the
   /migrate/import path; this document is the live app's source of truth.

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
    const { version, data } = await readRow(ctx.env);
    return { state: data, version };
  });

  router.put('/app-state', async (ctx) => {
    if (!ctx.user) throw errors.unauthorized();
    const body = ctx.body || {};
    if (body.data === undefined) throw errors.validation('data is required.');

    const { version: curVersion, data: curData } = await readRow(ctx.env);

    // Optimistic concurrency. baseVersion omitted = force (used only for the
    // very first seed); otherwise it must match what is on the server.
    if (body.baseVersion !== undefined && body.baseVersion !== null &&
        Number(body.baseVersion) !== curVersion) {
      throw errors.conflict('The data was changed on another computer. Reload before saving.',
        { serverVersion: curVersion, state: curData });
    }

    const next = { __version: curVersion + 1, data: body.data };
    await ctx.env.DB.prepare(
      `insert into system_settings (id, setting_key, setting_value, updated_by) values (?,?,?,?)
       on conflict(setting_key) do update set setting_value = excluded.setting_value,
         updated_by = excluded.updated_by`
    ).bind(newId(), KEY, JSON.stringify(next), ctx.user.id).run();

    return { ok: true, version: next.__version };
  });
}
