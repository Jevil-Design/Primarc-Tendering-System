import { can, MODULE } from '../permissions.js';
import { errors } from './response.js';

/* ═══════════════════════════════════════════════════════════════
   Access control for the shared app-state document.

   The live app still keeps the whole tender dataset in one JSON blob
   (see routes/app-state.js). That is an architectural fact we are not
   unwinding here — but it meant every signed-in account, whatever its
   designation, could GET the complete database: every vendor's quoted
   rates, every comparison, every work order. The route had no
   requirePerm() call at all.

   This module applies the SAME designation matrix the normalised routes
   already enforce, section by section, in two directions:

     redactState()  — read  : blanks sections the caller may not view,
                              preserving each section's SHAPE so the
                              frontend renders an empty list rather than
                              crashing on undefined.

     mergeStateWrite() — write : a redacted client sends back the blanks it
                              was given. Accepting that verbatim would
                              DELETE the hidden sections, so anything the
                              caller could not see is re-grafted from the
                              stored copy. Anything the caller COULD see but
                              may not edit is compared, and a real change is
                              refused with 403 — never silently dropped, and
                              never silently applied.

   The asymmetry is deliberate. "Could not see it" → restore quietly, the
   user never had that data and loses nothing of their own. "Could see it
   but may not change it" → tell them plainly that the save was refused.
   ═══════════════════════════════════════════════════════════════ */

/* Section → the module whose permissions govern it. `empty` keeps the shape
   the frontend's loadDB() expects when a section is withheld. */
const SECTIONS = [
  { key: 'quotations',   module: MODULE.ENQUIRY,    empty: () => [] },
  { key: 'deleted',      module: MODULE.ENQUIRY,    empty: () => [] },
  { key: 'vendorMaster', module: MODULE.VENDOR,     empty: () => [] },
  { key: 'workOrders',   module: MODULE.WORK_ORDER, empty: () => [] },
  { key: 'masterCustom', module: MODULE.BOQ_MASTER, empty: () => [] },
];

/* `notifications` and `seq` carry no commercial detail — notifications are
   this team's own activity feed and seq is the running document-number
   counter, which every user needs in order to create anything at all. */

/** Key order varies between round-trips; compare by value, not by spelling. */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
const same = (a, b) => stable(a) === stable(b);

/** Vendor rate lines live inside each quotation, under their own module. */
function stripVendorCommercials(quotations) {
  return (quotations || []).map((q) => (q && Array.isArray(q.vendors) && q.vendors.length)
    ? { ...q, vendors: [] }
    : q);
}

/**
 * What the caller is allowed to do with each section of the document.
 * Computed once and shared by the read and write paths so they can never
 * disagree about who may see what.
 */
export function stateAccess(ctx) {
  const view = {}, edit = {};
  for (const s of SECTIONS) {
    view[s.key] = can(ctx, s.module, 'view');
    edit[s.key] = can(ctx, s.module, 'edit');
  }
  return {
    isAdmin: !!ctx.user?.is_admin,
    view, edit,
    /* Vendor quotes/rates are Comparison data even though they are nested
       inside a quotation the caller may otherwise read. */
    viewRates: can(ctx, MODULE.COMPARISON, 'view'),
    editRates: can(ctx, MODULE.COMPARISON, 'edit'),
    /** True when the caller holds no read right over any section at all. */
    get blind() { return !this.isAdmin && !Object.values(this.view).some(Boolean); },
  };
}

/**
 * Read path. Returns the document the caller is entitled to, plus the list of
 * sections that were withheld so the response can say so out loud rather than
 * letting the user believe the database is empty.
 */
export function redactState(state, acl) {
  if (!state || typeof state !== 'object') return { state, withheld: [] };
  if (acl.isAdmin) return { state, withheld: [] };

  const out = { ...state };
  const withheld = [];

  for (const s of SECTIONS) {
    if (!acl.view[s.key]) { out[s.key] = s.empty(); withheld.push(s.key); }
  }

  /* Visible enquiries, but no right to see what anyone quoted. */
  if (!acl.viewRates) {
    if (acl.view.quotations) { out.quotations = stripVendorCommercials(out.quotations); }
    if (acl.view.deleted)    { out.deleted    = stripVendorCommercials(out.deleted); }
    withheld.push('vendorQuotes');
  }
  return { state: out, withheld };
}

/**
 * Write path. `incoming` is what the browser sent; `stored` is what is on the
 * server right now. Produces the document to persist, or throws 403.
 */
export function mergeStateWrite(incoming, stored, acl) {
  if (acl.isAdmin) return { data: incoming, restored: [] };
  if (!incoming || typeof incoming !== 'object') throw errors.validation('data must be an object.');

  const base = (stored && typeof stored === 'object') ? stored : {};
  const out = { ...incoming };
  const restored = [];

  for (const s of SECTIONS) {
    const k = s.key;
    if (acl.edit[k] && acl.view[k]) continue;              // free to change it

    if (!acl.view[k]) {
      /* Never had it — put the server's copy back untouched. Without this,
         a redacted client's next save wipes the section for everyone. */
      if (k in base) out[k] = base[k]; else delete out[k];
      restored.push(k);
      continue;
    }

    /* Could read it, may not write it. A real change is a permission
       violation and is reported, not absorbed. */
    if (!same(incoming[k], base[k])) {
      throw errors.forbidden(
        `Your role does not permit changes to ${label(k)}. That section was not saved — reload to get the current copy.`
      );
    }
    out[k] = base[k];
  }

  /* Vendor rates, nested one level down. */
  if (!acl.editRates) {
    const guarded = guardVendorLines(out.quotations, base.quotations, incoming.quotations, acl);
    if (guarded.changed) restored.push('vendorQuotes');
    out.quotations = guarded.list;
  }
  return { data: out, restored };
}

/**
 * Re-grafts each quotation's `vendors` array from the stored copy when the
 * caller may not edit Comparison data. Matched by quotation id, so reordering
 * or adding enquiries is still allowed — only the rate-bearing part is frozen.
 */
function guardVendorLines(list, storedList, incomingList, acl) {
  if (!Array.isArray(list)) return { list, changed: false };
  const byId = new Map((storedList || []).filter((q) => q && q.id).map((q) => [q.id, q]));
  let changed = false;

  const out = list.map((q, i) => {
    if (!q || !q.id) return q;
    const prior = byId.get(q.id);
    if (!prior) return q;                                  // brand-new enquiry
    const priorV = prior.vendors || [];
    const sentV = (incomingList && incomingList[i] && incomingList[i].vendors) || q.vendors || [];
    if (same(sentV, priorV)) return q;

    if (acl.viewRates) {
      /* Saw the real rates and altered them without the right to do so. */
      throw errors.forbidden(
        `Your role does not permit changes to vendor quotes on ${q.base || q.id}. Nothing was saved.`
      );
    }
    changed = true;                                        // was blanked on read
    return { ...q, vendors: priorV };
  });
  return { list: out, changed };
}

function label(key) {
  return {
    quotations: 'enquiries', deleted: 'the deleted-items bin',
    vendorMaster: 'the Vendor Master', workOrders: 'work orders',
    masterCustom: 'the BOQ Master',
  }[key] || key;
}

export const __test = { stable, same, SECTIONS };
