/* ═══════════════════════════════════════════════════════════════
   cloudflare-migration.js — localStorage → D1, plus backup / restore.

   Principles:
     · Nothing in localStorage is deleted. The old data stays until you
       explicitly clear it, so a failed import costs nothing.
     · Dry run first. Every step is counted; skips and conflicts are reported,
       not swallowed.
     · Repeatable. Records carry their original key in legacy_id, so a second
       run updates rather than duplicates.

   Usage (console, signed in as an administrator):
       CFMigrate.survey()          what is in localStorage
       CFMigrate.backup()          download a JSON snapshot first
       await CFMigrate.dryRun()    report only — writes nothing
       await CFMigrate.run()       perform the import
       CFMigrate.clearLocal()      only after verifying the data
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var LS_KEYS = [
    'ts_users', 'ts_session', 'ts_login_hist', 'ts_perms',
    'qm_data_v2', 'tnd_master_custom_v1', 'boq_autosave_v3', 'boq_vendor_logos',
    'erp_departments', 'erp_designations', 'erp_modules', 'erp_projects',
    'erp_branches', 'erp_companies', 'erp_audit', 'erp_notifications',
    'erp_workflows', 'erp_policy', 'erp_settings',
  ];

  function dump() {
    var out = {};
    LS_KEYS.forEach(function (k) {
      var raw = null;
      try { raw = localStorage.getItem(k); } catch (e) {}
      if (raw !== null) out[k] = raw;
    });
    return out;
  }

  /** The bundled ~949 contractors, sent alongside so the Worker can seed them. */
  function vendorMaster() {
    var v = window.VENDOR_MASTER || window.VENDORS || [];
    if (!Array.isArray(v)) return [];
    return v.map(function (x) { return typeof x === 'string' ? { name: x } : x; }).filter(Boolean);
  }

  /* Asks the API who the caller is rather than trusting a global the app may
     never have set. Also proves the session cookie is actually working before
     a long import starts. */
  async function ensureReady() {
    if (!window.CloudflareAPI) throw new Error('cloudflare-api.js is not loaded.');
    var me;
    try { me = await window.CloudflareAPI.auth.me(); }
    catch (e) { throw new Error('Could not reach the API: ' + e.message); }
    if (!me || !me.user) throw new Error('Sign in as an administrator before migrating.');
    if (!me.user.is_admin) throw new Error('Only an administrator can run the migration.');
    return me.user;
  }

  function summarise(report) {
    var total = function (o) { return Object.values(o || {}).reduce(function (a, b) { return a + b; }, 0); };
    return {
      found: total(report.found), migrated: total(report.migrated), skipped: total(report.skipped),
      errors: (report.errors || []).length, needsReview: (report.review || []).length,
      detail: report,
    };
  }

  var TSMigrate = {
    keys: LS_KEYS,

    /** Local survey — what exists, before contacting the server. */
    survey: function () {
      var found = {}, corrupt = [];
      LS_KEYS.forEach(function (k) {
        var raw = null;
        try { raw = localStorage.getItem(k); } catch (e) { return; }
        if (raw === null) return;
        try {
          var v = JSON.parse(raw);
          found[k] = Array.isArray(v) ? v.length
                   : (k === 'qm_data_v2' ? ((v.quotations || []).length + (v.workOrders || []).length) : 1);
        } catch (e) { corrupt.push(k); }
      });
      return { found: found, corrupt: corrupt, vendorMaster: vendorMaster().length };
    },

    async dryRun() {
      await ensureReady();
      var report = await window.CloudflareAPI.migrate.dryRun(dump(), vendorMaster());
      console.log('[migration dry run]', summarise(report));
      if (report.review?.length) console.warn('Needs manual review:', report.review);
      if (report.errors?.length) console.error('Errors:', report.errors);
      return report;
    },

    async run() {
      await ensureReady();
      TSMigrate.backup(true);                    // always snapshot before writing
      var report = await window.CloudflareAPI.migrate.run(dump(), vendorMaster());
      console.log('[migration complete]', summarise(report));
      if (report.review?.length) console.warn('Needs manual review:', report.review);
      if (report.errors?.length) console.error('Errors:', report.errors);
      console.info('localStorage was NOT cleared. Verify the data, then run TSMigrate.clearLocal().');
      return report;
    },

    backup: function (silent) {
      var payload = { exportedAt: new Date().toISOString(), app: 'primarc-tendering', localStorage: dump() };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'tendering-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      if (!silent) console.log('[backup] ' + Object.keys(payload.localStorage).length + ' keys downloaded');
      return payload;
    },

    /** Restores a snapshot into localStorage. Does not touch D1. */
    restore: function (json) {
      var parsed = typeof json === 'string' ? JSON.parse(json) : json;
      var ls = parsed.localStorage || {};
      var n = 0;
      Object.keys(ls).forEach(function (k) {
        if (LS_KEYS.indexOf(k) < 0) return;
        try { localStorage.setItem(k, ls[k]); n++; } catch (e) {}
      });
      console.log('[restore] wrote ' + n + ' keys — reload to apply.');
      return n;
    },

    clearLocal: function () {
      if (!confirm('Remove the migrated localStorage data?\n\nA backup downloads first. D1 is unaffected.')) return;
      TSMigrate.backup(true);
      // Theme and UI preferences are device-local and deliberately kept.
      var business = LS_KEYS.filter(function (k) { return k !== 'ts_session'; });
      business.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
      console.log('[migration] cleared ' + business.length + ' keys. Theme and layout preferences kept.');
    },
  };

  // Explicit namespace — the only migration tool the page loads.
  window.CFMigrate = TSMigrate;
})();
