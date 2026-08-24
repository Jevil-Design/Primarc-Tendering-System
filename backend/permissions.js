import { errors } from './lib/response.js';
import { parseJson } from './lib/util.js';

/* ═══════════════════════════════════════════════════════════════
   Effective permission = designation default, overridden per user where the
   override column is not NULL.

   This is enforced on every mutating route. Hiding a button in the UI is a
   courtesy; the Worker is the control. The old client trusted the browser,
   which meant the whole matrix could be bypassed from the console.
   ═══════════════════════════════════════════════════════════════ */

export const ACTIONS = ['view','create','edit','delete','approve','reject',
                        'import','export','print','lock','unlock','share'];

/** Module code per business area — matches the seeded modules table. */
export const MODULE = {
  DASHBOARD: 'dashboard',   PROJECTS: 'projects',       BOQ_MASTER: 'boqmaster',
  BOQ: 'boqcreation',       RATE_ANALYSIS: 'rateanalysis', ENQUIRY: 'enquiry',
  TENDER: 'tender',         VENDOR: 'vendor',           COMPARISON: 'comparison',
  WORK_ORDER: 'workorder',  PURCHASE_ORDER: 'purchaseorder',
  MATERIAL: 'materialmaster', REPORTS: 'reports',
  ADMIN: 'administration',  SETTINGS: 'settings',
};

/** Loads the whole effective matrix in two queries and caches it per request. */
export async function loadPermissions(env, user) {
  if (!user) return {};
  const mods = await env.DB.prepare('select id, code from modules').all();
  const byId = new Map(mods.results.map((m) => [m.id, m.code]));

  const out = {};
  for (const m of mods.results) out[m.code] = {};

  if (user.is_admin) {
    for (const code of Object.keys(out)) for (const a of ACTIONS) out[code][a] = true;
    return out;
  }

  if (user.designation_id) {
    const base = await env.DB.prepare('select * from permissions where designation_id = ?')
      .bind(user.designation_id).all();
    for (const row of base.results) {
      const code = byId.get(row.module_id);
      if (!code) continue;
      for (const a of ACTIONS) out[code][a] = !!row['can_' + a];
    }
  }

  const over = await env.DB.prepare('select * from user_permission_overrides where user_id = ?')
    .bind(user.id).all();
  for (const row of over.results) {
    const code = byId.get(row.module_id);
    if (!code) continue;
    for (const a of ACTIONS) {
      const v = row['can_' + a];
      if (v !== null && v !== undefined) out[code][a] = !!v;   // NULL = inherit
    }
  }
  return out;
}

export function can(ctx, moduleCode, action) {
  if (!ctx.user) return false;
  if (ctx.user.is_admin) return true;
  const m = ctx.permissions?.[moduleCode];
  return !!(m && m[action]);
}

/** Throws 403 unless the caller holds the right. Use at the top of handlers. */
export function requirePerm(ctx, moduleCode, action) {
  if (!ctx.user) throw errors.unauthorized();
  if (!can(ctx, moduleCode, action)) {
    throw errors.forbidden(`Your role does not permit "${action}" on ${moduleCode}.`);
  }
}

/** Approval ceiling from the user's designation, in rupees. */
export function financialLimit(ctx, kind) {
  if (!ctx.user) return 0;
  const limits = parseJson(ctx.user.financial_limits, {});
  return Number(limits[kind] || 0);
}

/**
 * Enforces the designation's approval ceiling.
 *
 * This is deliberately a backend rule. The old client checked it in JavaScript,
 * which any user could edit — meaning approval limits were advisory in practice.
 */
export function assertCanApprove(ctx, kind, amount) {
  if (ctx.user?.is_admin) return;
  const limit = financialLimit(ctx, kind);
  if (limit <= 0) {
    throw errors.forbidden(`Your designation has no ${kind} approval authority.`);
  }
  if (Number(amount) > limit) {
    throw errors.forbidden(
      `This amount (₹${Number(amount).toLocaleString('en-IN')}) exceeds your ${kind} approval limit of ₹${limit.toLocaleString('en-IN')}.`
    );
  }
}
