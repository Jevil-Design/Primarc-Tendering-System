/* ═══════════════════════════════════════════════════════════════
   sync-merge.js — record-level three-way merge for the shared tender
   dataset (the app-state blob api-store.js syncs).

   The server stores the whole dataset as one document with a version
   number. Before this, a save that lost the version race simply adopted
   the server copy, throwing away everything the user had just done — even
   when the other computer had touched a completely different enquiry.

   Instead we remember a FINGERPRINT of the last copy both sides agreed on
   (one hash per record, not the data itself — cheap to keep in
   localStorage) and merge record by record:

     changed only here       → keep ours
     changed only there      → keep theirs
     changed on both sides   → keep theirs, hand ours back as a CONFLICT so
                               the caller can preserve it for recovery
     created here            → add it
     deleted here, untouched there → delete it

   Pure functions, no DOM: loaded by the page as window.TSSyncMerge and by
   web/sync-merge.test.mjs under Node.
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* Arrays of records. Everything else at the top level is merged as a
     single value, except `seq`, which is merged counter by counter. */
  var COLLECTIONS = ['quotations', 'deleted', 'vendorMaster', 'workOrders', 'masterCustom', 'notifications'];

  /** Key order varies between round-trips; compare by value, not by spelling. */
  function stable(v) {
    if (v === null || typeof v !== 'object') { var s = JSON.stringify(v); return s === undefined ? 'null' : s; }
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }

  /** cyrb53 — 53-bit string hash; collisions are negligible at this scale. */
  function hashStr(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  function h(v) { return hashStr(stable(v)); }

  /* A record's identity: its id when it has one; BOQ Master custom rows are
     bare arrays whose first cell is the item name. Repeats get #n so two
     records can never share a key. */
  function keysOf(list) {
    var seen = {};
    return list.map(function (it) {
      var k;
      if (it && typeof it === 'object' && !Array.isArray(it) && it.id != null && it.id !== '') k = 'i:' + it.id;
      else if (Array.isArray(it)) k = 'r:' + String(it[0] == null ? '' : it[0]).toLowerCase().trim();
      else k = 'v:' + h(it);
      seen[k] = (seen[k] || 0) + 1;
      return seen[k] > 1 ? k + '#' + seen[k] : k;
    });
  }

  function fingerprint(state) {
    var fp = { c: {}, s: {} };
    if (!state || typeof state !== 'object') return fp;
    Object.keys(state).forEach(function (k) {
      if (COLLECTIONS.indexOf(k) >= 0 && Array.isArray(state[k])) {
        var m = {}, keys = keysOf(state[k]);
        state[k].forEach(function (it, i) { m[keys[i]] = h(it); });
        fp.c[k] = m;
      } else {
        fp.s[k] = h(state[k]);
      }
    });
    return fp;
  }

  function label(it, key) {
    if (Array.isArray(it)) return String(it[0] || key);
    if (it && typeof it === 'object') return String(it.base || it.no || it.woNo || it.name || it.projectName || it.msg || key);
    return key;
  }

  function mergeList(name, baseMap, L, S, conflicts) {
    L = Array.isArray(L) ? L : []; S = Array.isArray(S) ? S : [];
    var lk = keysOf(L), sk = keysOf(S);
    var out = S.map(function (it, i) { return { k: sk[i], v: it }; });
    var pos = function (k) { for (var i = 0; i < out.length; i++) if (out[i].k === k) return i; return -1; };
    var created = [];
    var prev = null;
    L.forEach(function (it, i) {
      var k = lk[i], lh = h(it), bh = baseMap[k], at = pos(k);
      if (bh === lh) { prev = k; return; }                        // untouched here
      if (at >= 0) {
        var sh = h(out[at].v);
        if (sh === bh || sh === lh) out[at].v = it;                 // only we changed it
        else conflicts.push({ collection: name, key: k, label: label(it, k), local: it, server: out[at].v });
      } else if (bh === undefined) {                                // created here
        var after = prev === null ? -1 : pos(prev);
        out.splice(after + 1, 0, { k: k, v: it });
        created.push(k);
      } else {                                                      // they deleted what we edited
        conflicts.push({ collection: name, key: k, label: label(it, k), local: it, server: null });
      }
      prev = k;
    });
    var inLocal = {}; lk.forEach(function (k) { inLocal[k] = 1; });
    Object.keys(baseMap).forEach(function (k) {
      if (inLocal[k]) return;                                       // we deleted it
      var at = pos(k);
      if (at < 0) return;                                           // so did they
      if (h(out[at].v) === baseMap[k]) out.splice(at, 1);
      else conflicts.push({ collection: name, key: k, label: label(out[at].v, k), local: null, server: out[at].v });
    });
    return { list: out.map(function (o) { return o.v; }), created: created };
  }

  /**
   * @param baseFp  fingerprint() of the last copy both sides agreed on
   * @param local   this computer's state
   * @param server  the server's current state
   * @returns {{state, conflicts, renumbered}}
   */
  function merge(baseFp, local, server) {
    baseFp = baseFp || { c: {}, s: {} };
    local = local || {}; server = server || {};
    var state = {}, conflicts = [], renumbered = [], createdQ = {};
    var keys = {};
    Object.keys(server).forEach(function (k) { keys[k] = 1; });
    Object.keys(local).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      if (COLLECTIONS.indexOf(k) >= 0 && (Array.isArray(local[k]) || Array.isArray(server[k]))) {
        var r = mergeList(k, (baseFp.c && baseFp.c[k]) || {}, local[k], server[k], conflicts);
        state[k] = r.list;
        if (k === 'quotations' || k === 'deleted') r.created.forEach(function (c) { createdQ[c] = 1; });
      } else if (k === 'seq') {
        // Document-number counters only ever move forward.
        var a = local.seq || {}, b = server.seq || {}, s = {};
        Object.keys(a).concat(Object.keys(b)).forEach(function (x) {
          s[x] = Math.max(Number(a[x]) || 0, Number(b[x]) || 0);
        });
        state.seq = s;
      } else {
        var lh = h(local[k]), sh = h(server[k]), bh = baseFp.s && baseFp.s[k];
        if (!(k in server)) state[k] = local[k];
        else if (!(k in local) || lh === bh || lh === sh) state[k] = server[k];
        else if (sh === bh) state[k] = local[k];
        else { state[k] = server[k]; conflicts.push({ collection: k, key: k, label: k, local: local[k], server: server[k] }); }
      }
    });

    /* An enquiry moved to Deleted here while it was edited there would now
       sit in both lists. The server's placement wins (its edit is the
       conflict we already recorded). */
    if (Array.isArray(state.quotations) && Array.isArray(state.deleted)) {
      var serverDeleted = {};
      (server.deleted || []).forEach(function (q) { if (q && q.id != null) serverDeleted[q.id] = 1; });
      var inQ = {}; state.quotations.forEach(function (q) { if (q && q.id != null) inQ[q.id] = 1; });
      var dup = state.deleted.filter(function (q) { return q && inQ[q.id]; }).map(function (q) { return q.id; });
      dup.forEach(function (id) {
        if (serverDeleted[id]) state.quotations = state.quotations.filter(function (q) { return !(q && q.id === id); });
        else state.deleted = state.deleted.filter(function (q) { return !(q && q.id === id); });
      });

      /* Two computers numbering an enquiry at the same moment both take the
         next serial. The one that reached the server first keeps it; ours,
         created here and not yet seen by anyone, takes the next free number. */
      var taken = {};
      state.quotations.concat(state.deleted).forEach(function (q) {
        if (q && typeof q.base === 'string' && !createdQ['i:' + q.id]) taken[q.base] = 1;
      });
      state.quotations.concat(state.deleted).forEach(function (q) {
        if (!q || !createdQ['i:' + q.id] || typeof q.base !== 'string') return;
        if (!taken[q.base]) { taken[q.base] = 1; return; }
        var m = /^(.*\/)(\d+)$/.exec(q.base);
        if (!m || !q.ref) return;
        state.seq = state.seq || {};
        var next = (Number(state.seq[q.ref]) || 0) + 1, base;
        while (taken[base = m[1] + String(next).padStart(m[2].length, '0')]) next++;
        state.seq[q.ref] = next;
        renumbered.push({ id: q.id, from: q.base, to: base });
        q.serial = next; q.base = base; taken[base] = 1;
      });
    }
    return { state: state, conflicts: conflicts, renumbered: renumbered };
  }

  /** The records in `state` that differ from the fingerprinted base — what
      would be lost if this copy were discarded. */
  function changes(baseFp, state) {
    baseFp = baseFp || { c: {}, s: {} };
    var out = [];
    Object.keys(state || {}).forEach(function (k) {
      if (COLLECTIONS.indexOf(k) >= 0 && Array.isArray(state[k])) {
        var bm = (baseFp.c && baseFp.c[k]) || {}, keys = keysOf(state[k]);
        state[k].forEach(function (it, i) {
          if (bm[keys[i]] !== h(it)) out.push({ collection: k, key: keys[i], label: label(it, keys[i]), local: it });
        });
      } else if (!baseFp.s || baseFp.s[k] !== h(state[k])) {
        out.push({ collection: k, key: k, label: k, local: state[k] });
      }
    });
    return out;
  }

  var api = { merge: merge, changes: changes, fingerprint: fingerprint, stable: stable, hash: h, COLLECTIONS: COLLECTIONS };
  root.TSSyncMerge = api;
})(typeof window !== 'undefined' ? window : globalThis);
