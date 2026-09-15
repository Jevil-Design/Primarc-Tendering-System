import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateAccess, redactState, mergeStateWrite } from './lib/state-acl.js';
import { MODULE } from './permissions.js';

/* A ctx whose permission matrix grants exactly what is asked for.
   `grants` is { moduleCode: ['view','edit'] }. */
function ctxWith(grants, isAdmin = false) {
  const permissions = {};
  for (const [mod, actions] of Object.entries(grants || {})) {
    permissions[mod] = {};
    for (const a of actions) permissions[mod][a] = true;
  }
  return { user: { id: 'u1', is_admin: isAdmin }, permissions };
}

/* redactState() shallow-copies, so a section the caller MAY see is the same
   array object the server holds. In the route that is harmless — curData is
   parsed fresh from the database and body.data arrives off the wire, so they
   are never the same object. In a test they would alias, and a tampering case
   would silently "pass" by mutating both sides. Round-trip through JSON the
   way the browser actually does. */
const wire = (x) => JSON.parse(JSON.stringify(x));

const ALL = {
  [MODULE.ENQUIRY]: ['view', 'edit'], [MODULE.VENDOR]: ['view', 'edit'],
  [MODULE.WORK_ORDER]: ['view', 'edit'], [MODULE.BOQ_MASTER]: ['view', 'edit'],
  [MODULE.COMPARISON]: ['view', 'edit'],
};

const sampleState = () => ({
  quotations: [{ id: 'q1', base: 'ENQ/AAD/2026/001', items: [{ desc: 'Earthwork' }],
                 vendors: [{ name: 'Cheap Co', lines: [{ rate: 385, gst: 18 }] }] }],
  deleted: [],
  vendorMaster: [{ id: 'v1', name: 'Cheap Co', gst: '27ABCDE1234F1Z0' }],
  workOrders: [{ id: 'w1', no: 'WO/001', amount: 770000 }],
  masterCustom: [{ id: 'm1', desc: 'Custom item' }],
  notifications: [{ id: 'n1', msg: 'hi' }],
  seq: { ENQ: 3 },
});

/* ── read path ── */

test('an admin sees the document untouched', () => {
  const s = sampleState();
  const { state, withheld } = redactState(s, stateAccess(ctxWith({}, true)));
  assert.equal(state, s);
  assert.deepEqual(withheld, []);
});

test('a user with every right sees the document untouched', () => {
  const { state, withheld } = redactState(sampleState(), stateAccess(ctxWith(ALL)));
  assert.equal(state.workOrders.length, 1);
  assert.equal(state.quotations[0].vendors.length, 1);
  assert.deepEqual(withheld, []);
});

test('a section the caller cannot view comes back empty, not missing', () => {
  const acl = stateAccess(ctxWith({ [MODULE.ENQUIRY]: ['view'], [MODULE.COMPARISON]: ['view'] }));
  const { state, withheld } = redactState(sampleState(), acl);
  assert.deepEqual(state.workOrders, [], 'shape preserved so the UI renders empty, not undefined');
  assert.deepEqual(state.vendorMaster, []);
  assert.deepEqual(state.masterCustom, []);
  assert.ok(withheld.includes('workOrders'));
  assert.equal(state.quotations.length, 1, 'what it may see is still there');
});

test('without Comparison view the enquiry is readable but the rates are not', () => {
  const acl = stateAccess(ctxWith({ [MODULE.ENQUIRY]: ['view'] }));
  const { state, withheld } = redactState(sampleState(), acl);
  assert.equal(state.quotations[0].base, 'ENQ/AAD/2026/001', 'enquiry itself still visible');
  assert.deepEqual(state.quotations[0].vendors, [], 'no vendor rates');
  assert.ok(withheld.includes('vendorQuotes'));
});

test('a rate-less read does not mutate the stored document', () => {
  const s = sampleState();
  redactState(s, stateAccess(ctxWith({ [MODULE.ENQUIRY]: ['view'] })));
  assert.equal(s.quotations[0].vendors.length, 1, 'redaction is a copy, never in place');
});

test('an account with no view right anywhere is refused outright', () => {
  assert.equal(stateAccess(ctxWith({})).blind, true);
  assert.equal(stateAccess(ctxWith({ [MODULE.VENDOR]: ['view'] })).blind, false);
  assert.equal(stateAccess(ctxWith({}, true)).blind, false, 'admins are never blind');
});

/* ── write path ── */

test('a redacted client cannot delete the sections it never received', () => {
  const stored = sampleState();
  const acl = stateAccess(ctxWith({ [MODULE.ENQUIRY]: ['view', 'edit'], [MODULE.COMPARISON]: ['view', 'edit'] }));
  const sent = wire(redactState(stored, acl).state);     // workOrders/vendorMaster blanked

  sent.quotations[0].items.push({ desc: 'New line' });   // a legitimate edit
  const { data, restored } = mergeStateWrite(sent, stored, acl);

  assert.equal(data.workOrders.length, 1, 'server copy re-grafted, not wiped');
  assert.equal(data.vendorMaster.length, 1);
  assert.equal(data.masterCustom.length, 1);
  assert.equal(data.quotations[0].items.length, 2, 'their own edit still lands');
  assert.ok(restored.includes('workOrders'));
});

test('changing a section you can see but not edit is refused, not absorbed', () => {
  const stored = sampleState();
  const acl = stateAccess(ctxWith({
    [MODULE.ENQUIRY]: ['view', 'edit'], [MODULE.COMPARISON]: ['view', 'edit'],
    [MODULE.WORK_ORDER]: ['view'],                        // view only
  }));
  const sent = wire(redactState(stored, acl).state);
  sent.workOrders[0].amount = 1;                          // tampering

  assert.throws(() => mergeStateWrite(sent, stored, acl), (e) => {
    assert.equal(e.status ?? e.statusCode ?? 403, 403);
    assert.match(String(e.message), /work orders/i);
    return true;
  });
});

test('leaving a view-only section untouched saves fine', () => {
  const stored = sampleState();
  const acl = stateAccess(ctxWith({
    [MODULE.ENQUIRY]: ['view', 'edit'], [MODULE.COMPARISON]: ['view', 'edit'],
    [MODULE.WORK_ORDER]: ['view'],
  }));
  const sent = wire(redactState(stored, acl).state);
  const { data } = mergeStateWrite(sent, stored, acl);
  assert.equal(data.workOrders[0].amount, 770000);
});

test('key order alone never counts as a change', () => {
  const stored = sampleState();
  const acl = stateAccess(ctxWith({ ...ALL, [MODULE.WORK_ORDER]: ['view'] }));
  const sent = wire(redactState(stored, acl).state);
  sent.workOrders = [{ amount: 770000, no: 'WO/001', id: 'w1' }];   // same values, reordered
  assert.doesNotThrow(() => mergeStateWrite(sent, stored, acl));
});

test('a vendor rate cannot be rewritten without Comparison edit', () => {
  const stored = sampleState();
  const acl = stateAccess(ctxWith({
    [MODULE.ENQUIRY]: ['view', 'edit'], [MODULE.COMPARISON]: ['view'],   // can see rates, cannot change
  }));
  const sent = wire(stored);
  sent.quotations[0].vendors[0].lines[0].rate = 1;

  assert.throws(() => mergeStateWrite(sent, stored, acl), (e) => {
    assert.match(String(e.message), /vendor quotes/i);
    assert.match(String(e.message), /ENQ\/AAD\/2026\/001/);
    return true;
  });
});

test('a rate-blind editor keeps the real rates instead of blanking them', () => {
  const stored = sampleState();
  const acl = stateAccess(ctxWith({ [MODULE.ENQUIRY]: ['view', 'edit'] }));  // no Comparison at all
  const sent = wire(redactState(stored, acl).state);                         // vendors blanked
  sent.quotations[0].items.push({ desc: 'Another line' });

  const { data, restored } = mergeStateWrite(sent, stored, acl);
  assert.equal(data.quotations[0].vendors.length, 1, 'rates survive their save');
  assert.equal(data.quotations[0].vendors[0].lines[0].rate, 385);
  assert.equal(data.quotations[0].items.length, 2, 'their edit still applies');
  assert.ok(restored.includes('vendorQuotes'));
});

test('a brand-new enquiry may carry vendors even from a rate-blind editor', () => {
  const stored = sampleState();
  const acl = stateAccess(ctxWith({ [MODULE.ENQUIRY]: ['view', 'edit'] }));
  const sent = wire(redactState(stored, acl).state);
  sent.quotations.push({ id: 'q2', base: 'ENQ/AAD/2026/002', items: [], vendors: [{ name: 'New Co', lines: [] }] });

  const { data } = mergeStateWrite(sent, stored, acl);
  assert.equal(data.quotations[1].vendors.length, 1, 'no stored copy to protect, so it is theirs');
  assert.equal(data.quotations[0].vendors[0].lines[0].rate, 385, 'the existing one is still guarded');
});

test('an admin write is passed through untouched', () => {
  const stored = sampleState();
  const acl = stateAccess(ctxWith({}, true));
  const sent = { ...sampleState(), workOrders: [] };
  const { data, restored } = mergeStateWrite(sent, stored, acl);
  assert.deepEqual(data.workOrders, [], 'admins really can clear a section');
  assert.deepEqual(restored, []);
});

test('notifications and seq are never withheld — the app cannot number documents without them', () => {
  const { state } = redactState(sampleState(), stateAccess(ctxWith({ [MODULE.VENDOR]: ['view'] })));
  assert.equal(state.seq.ENQ, 3);
  assert.equal(state.notifications.length, 1);
});
