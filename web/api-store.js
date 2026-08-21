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
    try { var r = await api.request('GET', '/settings'); _settings = (r && r.settings) || {}; }
    catch (e) { _settings = {}; }
    return _settings;
  }
  async function saveSetting(key, value) {
    await api.request('POST', '/settings', { key: key, value: value });
    if (_settings) _settings[key] = value;
  }
  async function uiPerms() { return (await settings()).ui_perms || {}; }
  async function uiRoles() { return (await settings()).ui_user_roles || {}; }

  /* ── user shape mapping (backend → the UI's ts_users record) ── */
  function mapUser(u, roles) {
    var role = u.is_admin ? 'Super Admin' : ((roles && roles[u.id]) || 'Viewer');
    return {
      id: u.id, username: u.username, name: u.full_name || u.username,
      email: u.email || '', role: role, active: u.status !== 'inactive' && u.status !== 'suspended',
      invite: !!u.must_change_password,
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
    // enrich role from the UI-role map without blocking
    if (u && !u.is_admin) uiRoles().then(function (r) { if (session && r[u.id]) session.role = r[u.id]; }).catch(function () {});
    return session;
  }

  /* ═══ core data sync ═══ */
  var _ver = 0;                 // server version this client last saw
  var _seeded = false;

  // The app is wrapped in an IIFE, so its DB/render are not reachable from here.
  // It exposes window.__tsHooks (getDB/setDB) inside its own scope for us.
  function currentDB() { try { return window.__tsHooks ? window.__tsHooks.getDB() : null; } catch (e) { return null; } }
  function adoptDB(state) { try { if (window.__tsHooks) window.__tsHooks.setDB(state); } catch (e) {} }

  var _resyncing = false;
  async function resync() {
    if (_resyncing) return; _resyncing = true;
    try {
      var r = await api.request('GET', '/app-state');
      _ver = (r && r.version) || 0;
      if (r && r.state) {
        adoptDB(r.state);
        emit('resynced');
      } else {
        // First computer to arrive seeds the server from its local data.
        var local = currentDB();
        if (local && !_seeded) { _seeded = true; await push(true); }
      }
    } catch (e) {
      emit('error', { message: (e && e.message) || 'Could not reach the server' });
    } finally { _resyncing = false; }
  }

  var _pushTimer = null, _pushing = false, _pendingForce = false;
  async function doPush(force) {
    if (_pushing) { _pendingForce = _pendingForce || force; return; }
    _pushing = true;
    var db = currentDB();
    if (!db) { _pushing = false; return; }
    emit('saving');
    try {
      var body = { data: db };
      if (!force) body.baseVersion = _ver;             // omit on force = seed / accept-server
      var r = await api.request('PUT', '/app-state', body);
      _ver = (r && r.version) || (_ver + 1);
      emit('saved');
    } catch (e) {
      if (e && (e.status === 409 || e.code === 'CONFLICT')) {
        // Someone else saved first. Take the server copy so nothing is lost.
        var sv = e.details && e.details.state;
        if (sv) { _ver = (e.details.serverVersion) || _ver; adoptDB(sv); }
        else { await resync(); }
        emit('conflict', e);
      } else if (e && e.status && e.status >= 400 && e.status < 500) {
        emit('rejected', e);
      } else {
        emit('error', { message: (e && e.message) || 'Could not reach the server' });
      }
    } finally {
      _pushing = false;
      if (_pendingForce !== false && _pendingForce !== undefined && _pendingForce) { _pendingForce = false; doPush(true); }
    }
  }
  function push(force) {
    // debounce rapid saveDB() bursts into one network write
    if (force) { if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; } return doPush(true); }
    emit('pending');
    if (_pushTimer) clearTimeout(_pushTimer);
    _pushTimer = setTimeout(function () { _pushTimer = null; doPush(false); }, 800);
  }
  async function flushNow() { if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; } return doPush(true); }

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
    logout: async function () { try { await api.auth.logout(); } catch (e) {} session = null; },
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
        var roles = await uiRoles(); roles[id] = dto.role; await saveSetting('ui_user_roles', roles);
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
      if (patch.role !== undefined) { var roles = await uiRoles(); roles[id] = patch.role; await saveSetting('ui_user_roles', roles); }
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
    flushNow: flushNow,
    push: push,
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
