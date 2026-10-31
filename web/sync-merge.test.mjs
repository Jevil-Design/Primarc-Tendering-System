import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Loads the exact file the browser loads, in a bare context. */
const ctx = {};
vm.runInNewContext(readFileSync(new URL('./sync-merge.js', import.meta.url), 'utf8'), ctx);
const { merge, fingerprint } = ctx.TSSyncMerge;
const clone = (x) => JSON.parse(JSON.stringify(x));

/* Test fixture — fictitious enquiries, not production records. */
const base = () => ({
  quotations: [
    { id: 'q1', ref: 'AAD', serial: 1, base: 'ENQ/AAD/2026/001', subject: 'Earthwork', items: [{ id: 'i1', desc: 'Excavation' }] },
    { id: 'q2', ref: 'AAD', serial: 2, base: 'ENQ/AAD/2026/002', subject: 'Plaster', items: [] },
  ],
  deleted: [], vendorMaster: [{ id: 'v1', name: 'TEST Vendor A' }], workOrders: [],
  masterCustom: [['TEST ITEM', 'desc', 'cum']], notifications: [], seq: { AAD: 2 }, vmImported: true,
});

test('edits to different enquiries on two computers both survive', () => {
  const b = base(), fp = fingerprint(b);
  const local = clone(b); local.quotations[0].subject = 'Earthwork — revised here';
  const server = clone(b); server.quotations[1].subject = 'Plaster — revised there';
  const r = merge(fp, local, server);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.state.quotations[0].subject, 'Earthwork — revised here');
  assert.equal(r.state.quotations[1].subject, 'Plaster — revised there');
});

test('the same enquiry edited on both sides keeps the server copy and reports ours', () => {
  const b = base(), fp = fingerprint(b);
  const local = clone(b); local.quotations[0].subject = 'mine';
  const server = clone(b); server.quotations[0].subject = 'theirs';
  const r = merge(fp, local, server);
  assert.equal(r.state.quotations[0].subject, 'theirs');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].local.subject, 'mine', 'our version is handed back for recovery');
  assert.equal(r.conflicts[0].label, 'ENQ/AAD/2026/001');
});

test('a record created here is added, in place', () => {
  const b = base(), fp = fingerprint(b);
  const local = clone(b); local.vendorMaster.unshift({ id: 'v2', name: 'TEST Vendor B' });
  const server = clone(b); server.vendorMaster.push({ id: 'v3', name: 'TEST Vendor C' });
  const r = merge(fp, local, server);
  assert.deepEqual(r.state.vendorMaster.map((v) => v.id), ['v2', 'v1', 'v3']);
});

test('a delete here applies when the other side did not touch the record', () => {
  const b = base(), fp = fingerprint(b);
  const local = clone(b); local.vendorMaster = [];
  const r = merge(fp, local, clone(b));
  assert.equal(r.state.vendorMaster.length, 0);
  assert.equal(r.conflicts.length, 0);
});

test('a delete here does not erase an edit made there', () => {
  const b = base(), fp = fingerprint(b);
  const local = clone(b); local.vendorMaster = [];
  const server = clone(b); server.vendorMaster[0].name = 'TEST Vendor A (renamed)';
  const r = merge(fp, local, server);
  assert.equal(r.state.vendorMaster.length, 1);
  assert.equal(r.conflicts.length, 1);
});

test('an enquiry deleted here while edited there ends up in one list only', () => {
  const b = base(), fp = fingerprint(b);
  const local = clone(b); local.deleted.push(local.quotations.shift());
  const server = clone(b); server.quotations[0].subject = 'edited there';
  const r = merge(fp, local, server);
  const inQ = r.state.quotations.some((q) => q.id === 'q1');
  const inD = r.state.deleted.some((q) => q.id === 'q1');
  assert.ok(inQ && !inD, 'the server placement wins');
  assert.equal(r.state.quotations.find((q) => q.id === 'q1').subject, 'edited there');
});

test('document counters only move forward and colliding new numbers are reissued', () => {
  const b = base(), fp = fingerprint(b);
  const local = clone(b);
  local.quotations.unshift({ id: 'qL', ref: 'AAD', serial: 3, base: 'ENQ/AAD/2026/003', items: [] });
  local.seq.AAD = 3;
  const server = clone(b);
  server.quotations.unshift({ id: 'qS', ref: 'AAD', serial: 3, base: 'ENQ/AAD/2026/003', items: [] });
  server.seq.AAD = 3;
  const r = merge(fp, local, server);
  const ours = r.state.quotations.find((q) => q.id === 'qL');
  const theirs = r.state.quotations.find((q) => q.id === 'qS');
  assert.equal(theirs.base, 'ENQ/AAD/2026/003', 'first to reach the server keeps its number');
  assert.equal(ours.base, 'ENQ/AAD/2026/004');
  assert.equal(r.state.seq.AAD, 4);
  assert.equal(r.renumbered.length, 1);
});

test('key order alone is not a change', () => {
  const b = base(), fp = fingerprint(b);
  const local = clone(b);
  const q = local.quotations[0];
  local.quotations[0] = { items: q.items, subject: q.subject, base: q.base, serial: q.serial, ref: q.ref, id: q.id };
  const server = clone(b); server.quotations[0].subject = 'theirs';
  const r = merge(fp, local, server);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.state.quotations[0].subject, 'theirs');
});

test('BOQ Master rows (bare arrays) merge by item name', () => {
  const b = base(), fp = fingerprint(b);
  const local = clone(b); local.masterCustom.push(['TEST ITEM 2', 'd', 'sqm']);
  const server = clone(b); server.masterCustom.push(['TEST ITEM 3', 'd', 'rmt']);
  const r = merge(fp, local, server);
  assert.deepEqual(r.state.masterCustom.map((x) => x[0]).sort(), ['TEST ITEM', 'TEST ITEM 2', 'TEST ITEM 3']);
});

test('nothing changed here means the server copy is taken verbatim', () => {
  const b = base(), fp = fingerprint(b);
  const server = clone(b); server.workOrders.push({ id: 'w1', no: 'WO/AAD/2026/001' });
  server.vmImported = false;
  const r = merge(fp, clone(b), server);
  assert.equal(JSON.stringify(r.state.workOrders), JSON.stringify(server.workOrders));
  assert.equal(r.state.vmImported, false);
});
