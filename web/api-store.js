/* ═══════════════════════════════════════════════════════════════
   api-store.js — the bridge the app was always missing.

   The HTML calls window.TSApi.* for auth, user management and data sync, but
   TSApi was never defined (api-store.js did not exist), so every API branch
   was dead and the app silently ran on localStorage. This file defines
   window.TSApi on top of window.CloudflareAPI (the REST client) and the
   Cloudflare Worker + D1 backend, turning the browser store into a cache and
   making D1 the central source of truth every computer shares.

   Design:
   • active=true synchronously, because the app checks API() the moment its
     boot() runs (before any async probe could resolve). If the server is
     actually unreachable the auth calls fail and the app shows the sign-in
     gate — a centralised app cannot run offline, by design.
   • Auth/users/permissions map the backend shapes to the UI's model.
   • The core tender dataset (the former qm_data_v2 blob = window.DB) is pulled
     from / pushed to GET|PUT /app-state. localStorage is kept only as an
     offline-readable cache; the server row is authoritative.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var api = window.CloudflareAPI;
  if (!api) { console.error('[TSApi] CloudflareAPI missing — load cloudflare-api.js first'); return; }

  var QKEY = 'qm_data_v2';
  var UKEY = 'ts_users';
  var HKEY = 'ts_login_hist';
  var ADMIN_ROLES = { 'Super Admin': 1, 'Admin': 1 };

  var listeners = [];
  function emit(state, detail) {
    listeners.forEach(function (fn) { try { fn(state, detail); } catch (e) {} });
  }

  /* ── settings-backed side tables (UI perm matrix + per-user UI role) ── */
  var _settings = null;
  async function settings(force) {
    if (_settings && !force) return _settings;
    try {
      var r = await api.request('GET', '/settings');
      _settings = (r && r.settings) || {};
    } catch (e) {
      // A transient failure must NOT be cached as if it were real (empty)
      // settings: saveSetting() merges into whatever this returns and writes
      // the merged object back, so a poisoned {} here would silently destroy
      // every previously-saved role/permission on the next save. Leave
      // _settings untouched (still null, or the last good value) so the next
      // call retries instead of working from empty data forever.
      return {};
    }
    return _settings;
  }
  async function saveSetting(key, value) {
    await api.request('POST', '/settings', { key: key, value: value });
    if (_settings) _settings[key] = value;
  }
  async function uiPerms() { return (await settings()).ui_perms || {}; }
  // force=true bypasses the cache — used right before a read-merge-write save
  // so the merge starts from the latest known state, not a snapshot from
  // earlier in the session (narrows, doesn't eliminate, the lost-update
  // window against a concurrent edit from another admin).
  async function uiRoles(force) { return (await settings(force)).ui_user_roles || {}; }

  /* ── user shape mapping (backend → the UI's ts_users record) ── */
  function mapUser(u, roles) {
    // The explicitly-chosen role label always wins. is_admin only supplies a
    // default for users who were never assigned one (both 'Super Admin' and
    // 'Admin' set is_admin=true on the backend, so that flag alone can't tell
    // them apart — trusting it unconditionally is what made role changes into
    // an admin-tagged role appear to silently revert to 'Super Admin').
    var role = (roles && roles[u.id]) || (u.is_admin ? 'Super Admin' : 'Viewer');
    return {
      id: u.id, username: u.username, name: u.full_name || u.username,
      email: u.email || '', role: role, active: u.status !== 'inactive' && u.status !== 'suspended',
      status: u.status || 'active',   // 'suspended' is what ERP Admin shows as Locked
      // Named to match what every consumer actually reads: the login
      // handler's r.user.mustChange (forces the change-password prompt right
      // after sign-in) and pwStatus()'s x.mustChange (the "Temporary" badge
      // in User Management). This used to be called `invite`, which nothing
      // checked — so a freshly invited/reset-password backend user was never
      // prompted to change their password, and never showed as temporary.
      mustChange: !!u.must_change_password,
    };
  }
  function setLocal(key, val) {
    try { (window.safeSetItem || localStorage.setItem.bind(localStorage))(key, JSON.stringify(val)); } catch (e) {}
  }

  /* ── session ── */
  var session = null;
  function setSession(u) {
    session = u ? {
      uid: u.id, username: u.username, name: u.full_name || u.username,
      role: u.is_admin ? 'Super Admin' : 'Viewer', ts: Date.now(), last: Date.now(),
      mustChange: !!u.must_change_password,
    } : null;
    // enrich role from the UI-role map without blocking (also for admins —
    // 'Super Admin' vs 'Admin' is a label choice, not implied by is_admin)
    if (u) uiRoles().then(function (r) { if (session && r[u.id]) session.role = r[u.id]; }).catch(function () {});
    return session;
  }

  /* ═══ core data sync ═══
     The whole tender dataset is one versioned document on the server. Rules:
     • Every save names the version it was based on; the server refuses it
       (409) if someone else saved first.
     • A refused save is MERGED record by record (sync-merge.js) instead of
       being thrown away: different enquiries edited on two computers both
       survive; the same record edited on both keeps the server's copy and
       ours is kept in a recovery list the user can download.
     • "Unsent changes" is remembered across reloads (ts_sync_meta.dirty), so
       work done offline, or not yet pushed when the tab closed, is sent on the
       next sign-in rather than being replaced by the server copy.
     • Network/server failures really are retried, with backoff. */
  var M = window.TSSyncMerge;
  var META_KEY = 'ts_sync_meta', BASE_KEY = 'ts_sync_base', RECOVERY_KEY = 'ts_sync_recovery';
  function readJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  var meta = readJSON(META_KEY) || {};     // { uid, ver, dirty } — survives reloads
  var _ver = meta.ver || 0;                 // server version the local copy is based on
  var _editSeq = 0;
  function saveMeta() { meta.ver = _ver; writeJSON(META_KEY, meta); }
  function setBase(state) { if (M) writeJSON(BASE_KEY, M.fingerprint(state)); }
  function uid() { return session && session.uid; }

  // The app is wrapped in an IIFE, so its DB/render are not reachable from here.
  // It exposes window.__tsHooks (getDB/setDB) inside its own scope for us.
  function currentDB() { try { return window.__tsHooks ? window.__tsHooks.getDB() : null; } catch (e) { return null; } }
  function adoptDB(state) { try { if (window.__tsHooks) window.__tsHooks.setDB(state); } catch (e) {} }

  // "Empty" = none of the meaningful entities present. Used to make sure an
  // accidentally empty server copy never overwrites a computer that has data.
  function isEmptyDB(db) {
    if (!db) return true;
    var n = function (a) { return (a && a.length) || 0; };
    return n(db.quotations) === 0 && n(db.workOrders) === 0 &&
           n(db.vendorMaster) === 0 && n(db.deleted) === 0 &&
           n(db.masterCustom) === 0;
  }

  /* Take the server copy as the new agreed base. Meta is written BEFORE
     setDB re-renders, so a save triggered by that render still counts. */
  function adopt(state, version) {
    _ver = version; setBase(state);
    meta.dirty = false; meta.uid = uid() || meta.uid; saveMeta();
    adoptDB(state);
  }

  /* Recovery list: the user's own versions of records that could not be
     saved. Kept small (only changed records) and capped. */
  function stashRecovery(items, reason) {
    if (!items || !items.length) return;
    var list = readJSON(RECOVERY_KEY) || [];
    list.unshift({ ts: Date.now(), user: session && session.username, reason: reason,
      items: items.map(function (c) { return { collection: c.collection, label: c.label, local: c.local }; }) });
    list = list.slice(0, 10);
    while (!writeJSON(RECOVERY_KEY, list)) {
      if (list.length === 1) { downloadJSON(list); break; }   // storage full: hand it to the user now
      list = list.slice(0, Math.ceil(list.length / 2));
    }
  }
  function downloadJSON(data) {
    try {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = 'tendering-unsaved-changes-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    } catch (e) {}
  }

  /* Our unsent edits meet a server copy that moved on: merge them. */
  var _conflictStreak = 0;
  function reconcile(server, version) {
    var local = currentDB();
    var baseFp = readJSON(BASE_KEY);
    if (!M || !baseFp || !local) {
      // No record of the last agreed copy (first sync after an upgrade):
      // nothing to merge against, so keep the server copy and save ours aside.
      stashRecovery(M ? M.changes(null, local || {}) : [], 'conflict');
      adopt(server, version);
      emit('conflict', { conflicts: [{ label: 'Unsent changes' }] });
      return;
    }
    var res = M.merge(baseFp, local, server);
    if (res.conflicts.length) stashRecovery(res.conflicts, 'conflict');
    var changed = M.hash(res.state) !== M.hash(server);
    _ver = version; setBase(server);
    meta.dirty = changed; meta.uid = uid() || meta.uid; saveMeta();
    adoptDB(res.state);
    emit(res.conflicts.length ? 'conflict' : 'merged', { conflicts: res.conflicts, renumbered: res.renumbered });
    if (changed) {
      // Bounded: two computers saving in lock-step must not ping-pong forever.
      if (++_conflictStreak > 5) { _conflictStreak = 0; scheduleRetry(); }
      else doPush();
    }
  }

  var _resyncing = false, _withheld = [];
  async function resync() {
    if (_resyncing) return; _resyncing = true;
    try {
      var r = await api.request('GET', '/app-state');
      var server = r && r.state, version = (r && r.version) || 0;
      /* The server redacts sections this role may not read (see
         backend/lib/state-acl.js). Say so, or an empty Work Orders list
         reads as lost data and someone re-enters it. */
      _withheld = (r && r.withheld) || [];
      if (_withheld.length) emit('restricted', { withheld: _withheld });
      var local = currentDB();
      var mine = !meta.uid || meta.uid === uid();
      if (meta.dirty && mine && !isEmptyDB(local)) {
        // Unsent work from this account (offline, or the tab closed mid-save).
        if (version === _ver) doPush();          // nothing new upstream: just send it
        else reconcile(server, version);           // upstream moved on: merge
        return;
      }
      if (meta.dirty && !mine && !isEmptyDB(local)) {
        // Another account's unsent edits on this shared computer: never send
        // them under this login, but do not silently destroy them either.
        stashRecovery(M ? M.changes(readJSON(BASE_KEY), local) : [], 'other-account');
      }
      if (!isEmptyDB(server)) {
        adopt(server, version);
        emit('resynced');
      } else if (!isEmptyDB(local) && mine) {
        // Server is empty but THIS computer has data — send it up rather than
        // wiping local work (seeds a fresh server; repairs an empty seed).
        _ver = version; meta.dirty = true; meta.uid = uid(); saveMeta();
        doPush();
      } else {
        _ver = version; setBase(server || {}); meta.dirty = false; meta.uid = uid(); saveMeta();
      }
    } catch (e) {
      emit(e && e.offline ? 'offline' : 'error', { message: (e && e.message) || 'Could not reach the server' });
    } finally { _resyncing = false; }
  }

  /* Retry with backoff for failures that may clear by themselves. */
  var RETRY_DELAYS = [2, 5, 10, 20, 30, 60];
  var _retryTimer = null, _retryN = 0;
  function scheduleRetry() {
    if (_retryTimer) return;
    var d = RETRY_DELAYS[Math.min(_retryN++, RETRY_DELAYS.length - 1)] * 1000;
    _retryTimer = setTimeout(function () { _retryTimer = null; if (meta.dirty) doPush(); }, d);
  }
  window.addEventListener('online', function () {
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    if (meta.dirty && session) doPush();
  });

  /* _pushingPromise, not a boolean flag: a caller that finds a push already in
     flight must be able to await its actual completion — logout() depends on
     this. A save requested meanwhile is NOT dropped: _again re-runs the push
     as soon as the current one settles. */
  var _pushTimer = null, _pushingPromise = null, _again = false;
  function doPush() {
    if (_pushingPromise) { _again = true; return _pushingPromise; }
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    var db = currentDB();
    if (!db || !session || !meta.dirty) return Promise.resolve();
    emit('saving');
    var startSeq = _editSeq;
    // Fingerprinted synchronously, before the request body is serialised, so
    // both describe exactly the same snapshot.
    var fp = M ? M.fingerprint(db) : null;
    var rejected = false;
    _pushingPromise = (async () => {
      try {
        var r = await api.request('PUT', '/app-state', { data: db, baseVersion: _ver });
        _ver = (r && r.version) || (_ver + 1);
        if (fp) writeJSON(BASE_KEY, fp);
        meta.dirty = _editSeq !== startSeq;          // edited while the request was out?
        saveMeta();
        _retryN = 0; _conflictStreak = 0;
        emit(meta.dirty ? 'pending' : 'saved');
      } catch (e) {
        if (e && (e.status === 409 || e.code === 'CONFLICT') && e.details && e.details.state) {
          reconcile(e.details.state, e.details.serverVersion || 0);
        } else if (e && e.status === 401) {
          // Kept as unsent; pushed again after the next sign-in.
          emit('signed-out', e);
        } else if (e && e.status && e.status >= 400 && e.status < 500) {
          // The server's considered refusal (e.g. no edit right): retrying
          // cannot succeed. Keep the user's version for recovery and return
          // to the server's copy so the screen shows what is really stored.
          stashRecovery(M ? M.changes(readJSON(BASE_KEY), db) : [], 'rejected');
          meta.dirty = false; saveMeta();
          emit('rejected', e);
          rejected = true;
        } else {
          emit(e && e.offline ? 'offline' : 'error', { message: (e && e.message) || 'Could not reach the server' });
          scheduleRetry();
        }
      } finally {
        _pushingPromise = null;
        if (rejected) resync();
        else if (_again) { _again = false; if (meta.dirty) doPush(); }
      }
    })();
    return _pushingPromise;
  }
  function push() {
    // Called by the app's saveDB() after every change: remember the change
    // durably first, then debounce bursts into one network write.
    _editSeq++;
    if (!meta.dirty || (uid() && meta.uid !== uid())) { meta.dirty = true; meta.uid = uid() || meta.uid; saveMeta(); }
    emit('pending');
    if (_pushTimer) clearTimeout(_pushTimer);
    _pushTimer = setTimeout(function () { _pushTimer = null; doPush(); }, 800);
  }
  /* Send everything now and wait for it (logout). A bounded loop, because a
     merge after a conflict queues one more push. */
  async function flushNow() {
    if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
    for (var i = 0; i < 4; i++) {
      if (_pushingPromise) await _pushingPromise;
      else if (meta.dirty && session) await doPush();
      else break;
    }
  }

  /* Closing the tab with changes not yet on the server: the browser copy is
     kept and sent on the next sign-in, but warn — another computer will not
     see them until then. */
  window.addEventListener('beforeunload', function (e) {
    if (session && (meta.dirty || _pushTimer || _pushingPromise)) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ═══ the public TSApi surface the HTML expects ═══ */
  window.TSApi = {
    active: true,                 // optimistic — see header note
    get session() { return session; },
    onStatus: function (fn) { if (typeof fn === 'function') listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },

    // ── auth ──
    login: async function (username, password) {
      var r = await api.auth.login(username, password);
      setSession(r.user);
      return { user: mapUser(r.user, await uiRoles()), perms: await uiPerms() };
    },
    logout: async function () {
      try { await flushNow(); } catch (e) {}   // last edit must reach the server before the session that carries it is revoked
      try { await api.auth.logout(); } catch (e) {}
      session = null;
    },
    me: async function () {
      var r = await api.auth.me();
      if (r && r.user) { setSession(r.user); scheduleResync(); }
      else session = null;
      return { user: session ? mapUser(r.user, await uiRoles()) : null, perms: await uiPerms() };
    },
    changePassword: async function (curPw, newPw) { return api.auth.changePassword(curPw, newPw); },

    // ── users ──
    listUsers: async function () {
      var r = await api.users.list();
      var roles = await uiRoles();
      var mapped = (r.users || []).map(function (u) { return mapUser(u, roles); });
      setLocal(UKEY, mapped);        // the UI table reads ts_users
      return mapped;
    },
    createUser: async function (dto) {
      var r = await api.users.create({ username: dto.username, fullName: dto.name, email: dto.email, password: dto.password });
      var id = r && r.userId;
      if (id && dto.role) {
        var roles = await uiRoles(true); roles[id] = dto.role; await saveSetting('ui_user_roles', roles);
        if (ADMIN_ROLES[dto.role]) { try { await api.users.update(id, { isAdmin: true }); } catch (e) {} }
      }
      return r;
    },
    updateUser: async function (id, patch) {
      var body = {};
      if (patch.active !== undefined) body.status = patch.active ? 'active' : 'inactive';
      if (patch.name !== undefined) body.fullName = patch.name;
      if (patch.email !== undefined) body.email = patch.email;
      if (patch.password) body.password = patch.password;
      if (patch.role !== undefined) body.isAdmin = !!ADMIN_ROLES[patch.role];
      var r = await api.users.update(id, body);
      if (patch.role !== undefined) { var roles = await uiRoles(true); roles[id] = patch.role; await saveSetting('ui_user_roles', roles); }
      return r;
    },
    resetPassword: async function (id) { return api.users.resetPassword(id); },
    bulkActive: async function (ids, on) { return api.users.setActive(ids, on); },
    bulkDelete: async function (ids) { return api.users.remove(ids); },
    history: async function () {
      try {
        var r = await api.request('GET', '/audit?module=Authentication&action=login&limit=200');
        var hist = (r.events || []).map(function (e) {
          return { username: e.user_name || e.target || '—', role: '', ok: true, ts: Date.parse(e.created_at) || Date.now(),
                   device: (e.browser || e.user_agent || '').slice(0, 60) };
        });
        setLocal(HKEY, hist);
        return hist;
      } catch (e) { return []; }
    },

    // ── permissions (UI 6×8 matrix, stored centrally) ──
    setPerms: async function (role, flags) {
      var m = await uiPerms(); m[role] = flags; return saveSetting('ui_perms', m);
    },
    resetPerms: async function () { return saveSetting('ui_perms', {}); },

    // ── data sync ──
    resync: resync,
    /* Which sections this account is not allowed to see, from the last sync. */
    withheld: function () { return _withheld.slice(); },
    flushNow: flushNow,
    push: push,
    /* True while some change has not yet been confirmed by the server. */
    hasUnsent: function () { return !!(meta.dirty || _pushTimer || _pushingPromise); },
    /* Versions of records that could not be saved (conflict / refusal). */
    recovery: function () { return readJSON(RECOVERY_KEY) || []; },
    downloadRecovery: function () { var r = readJSON(RECOVERY_KEY) || []; if (r.length) downloadJSON(r); return r.length; },
  };

  /* Trigger a single resync shortly after a session is confirmed (covers the
     page-reload case, where the app's boot() sets up auth but never resyncs). */
  var _resyncScheduled = false;
  function scheduleResync() {
    if (_resyncScheduled) return; _resyncScheduled = true;
    setTimeout(function () { _resyncScheduled = false; resync(); }, 0);
  }

  /* The app's saveDB() calls window.TSApi.push() directly (one line added there),
     so no runtime wrapping is needed — reading DB stays synchronous and the UI
     is unaffected. */
})();
