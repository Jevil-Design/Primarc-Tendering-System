/* ═══════════════════════════════════════════════════════════════
   cloudflare-api.js — the single data-access layer for the Cloudflare backend.

   Every database call goes through this object. Raw fetch() calls are
   deliberately NOT scattered through the 14,000-line HTML: keeping them here
   means auth, retries, offline queueing and error wording are fixed in one
   place rather than hunted across the UI.

   Set window.CLOUDFLARE_API_URL before this script loads, or edit API_BASE.
   When the API is unreachable the adapter degrades to the app's existing
   localStorage behaviour rather than throwing — BOQ work is never lost.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var API_BASE = (window.CLOUDFLARE_API_URL || '').replace(/\/$/, '') ||
                 'https://primarc-tendering-api.suvojt740.workers.dev/api';

  var listeners = [];
  var online = navigator.onLine;
  var healthy = null;            // null = not yet probed

  function emit(state, detail) {
    listeners.forEach(function (fn) { try { fn(state, detail); } catch (e) {} });
    document.dispatchEvent(new CustomEvent('cf-status', { detail: { state: state, detail: detail } }));
  }

  window.addEventListener('online', function () { online = true; probe().then(function (r) { emit(r.ok ? 'online' : 'error', r); }); });
  window.addEventListener('offline', function () { online = false; healthy = false; emit('offline'); });

  /* ── core request ────────────────────────────────────────── */
  async function req(method, path, body, opts) {
    opts = opts || {};
    var url = API_BASE + path;
    var init = {
      method: method,
      credentials: 'include',          // session cookie
      headers: {},
    };
    if (body instanceof FormData) {
      init.body = body;                // let the browser set the boundary
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (opts.headers) Object.assign(init.headers, opts.headers);

    var attempts = opts.retry === false ? 1 : 2;
    var lastErr = null;

    for (var i = 0; i < attempts; i++) {
      try {
        var res = await fetch(url, init);
        var payload = null;
        var text = await res.text();
        try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }

        if (res.ok && payload && payload.success) { healthy = true; return payload.data; }

        var err = new Error((payload && payload.error && payload.error.message) || ('HTTP ' + res.status));
        err.code = (payload && payload.error && payload.error.code) || 'HTTP_' + res.status;
        err.status = res.status;
        err.details = payload && payload.error && payload.error.details;

        // 4xx are the server's considered answer — never retry those.
        if (res.status < 500) {
          if (res.status === 401) emit('signed-out', err);
          throw err;
        }
        lastErr = err;
      } catch (e) {
        lastErr = e;
        var networkish = /Failed to fetch|NetworkError|load failed/i.test(e.message || '');
        if (!networkish && e.status && e.status < 500) throw e;
        if (i === attempts - 1) break;
        await new Promise(function (r) { setTimeout(r, 400 * (i + 1)); });
      }
    }

    healthy = false;
    if (/Failed to fetch|NetworkError|load failed/i.test(lastErr?.message || '')) {
      var offlineErr = new Error('No connection to the server. Your work is kept locally and will sync when you are back online.');
      offlineErr.code = 'OFFLINE';
      offlineErr.offline = true;
      emit('offline', offlineErr);
      throw offlineErr;
    }
    emit('error', lastErr);
    throw lastErr;
  }

  var get = (p, q) => req('GET', p + (q ? '?' + new URLSearchParams(q) : ''));
  var post = (p, b) => req('POST', p, b === undefined ? {} : b);
  var put = (p, b) => req('PUT', p, b === undefined ? {} : b);
  var patch = (p, b) => req('PATCH', p, b === undefined ? {} : b);
  var del = (p) => req('DELETE', p);

  /**
   * Real health probe.
   *
   * navigator.onLine only means the browser has some network — it says nothing
   * about this Worker or whether its database has been migrated. The pill must
   * not claim "Connected" on that basis.
   */
  async function probe() {
    if (!navigator.onLine) return { ok: false, kind: 'offline', message: 'No network connection.' };
    try {
      var res = await fetch(API_BASE + '/health', { credentials: 'include' });
      if (!res.ok) return { ok: false, kind: 'error', message: 'The API responded with ' + res.status + '.' };
      var body = await res.json();
      if (!body || !body.success) return { ok: false, kind: 'error', message: 'Unexpected API response.' };
      healthy = true;
      return { ok: true, kind: 'ready' };
    } catch (e) {
      healthy = false;
      return { ok: false, kind: 'unreachable',
               message: 'Could not reach the API. Check CLOUDFLARE_API_URL and your connection.' };
    }
  }

  /* ── offline draft queue ─────────────────────────────────────
     BOQ editing must never lose work. Drafts are written to localStorage
     immediately and pushed when the API comes back. */
  var DRAFT_KEY = 'cf_pending_boq_draft';
  var draftTimer = null;

  function queueDraft(draft) {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ draft: draft, at: Date.now() })); } catch (e) {}
  }

  async function flushDraft() {
    var raw = null;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      var parsed = JSON.parse(raw);
      await put('/boq-draft', { draft: parsed.draft });
      localStorage.removeItem(DRAFT_KEY);
      emit('synced', 'boq-draft');
    } catch (e) { /* stays queued */ }
  }
  window.addEventListener('online', flushDraft);

  var CloudflareAPI = {
    baseUrl: API_BASE,
    probe: probe,
    isHealthy: function () { return healthy === true; },
    onStatus: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    },
    request: req,

    auth: {
      login: (username, password) => post('/auth/login', { username, password }),
      logout: () => post('/auth/logout'),
      me: () => get('/auth/me'),
      changePassword: (currentPassword, newPassword) => post('/auth/change-password', { currentPassword, newPassword }),
      refresh: () => post('/auth/refresh'),
      sessions: () => get('/auth/sessions'),
      bootstrap: (payload, token) => req('POST', '/auth/bootstrap', payload, { headers: { 'X-Bootstrap-Token': token }, retry: false }),
    },

    users: {
      list: () => get('/users'),
      get: (id) => get('/users/' + id),
      create: (dto) => post('/users', dto),
      update: (id, patchBody) => patch('/users/' + id, patchBody),
      resetPassword: (id) => post('/users/' + id + '/reset-password'),
      setActive: (ids, active) => post('/users/bulk/active', { ids, active }),
      remove: (ids) => post('/users/bulk/delete', { ids: [].concat(ids) }),
    },

    rbac: {
      modules: () => get('/rbac/modules'),
      permissions: () => get('/rbac/permissions'),
      setPermission: (designationId, moduleId, flags) => post('/rbac/permissions', { designationId, moduleId, flags }),
      overrides: (userId) => get('/rbac/overrides/' + userId),
      setOverride: (userId, moduleId, flags) => post('/rbac/overrides', { userId, moduleId, flags }),
    },

    org: {
      companies: () => get('/org/companies'),
      branches: (companyId) => get('/org/branches', companyId ? { companyId } : null),
      departments: () => get('/org/departments'),
      designations: () => get('/org/designations'),
      saveDesignation: (dto) => post('/org/designations', dto),
      settings: () => get('/settings'),
      saveSetting: (key, value) => post('/settings', { key, value }),
    },

    projects: {
      list: () => get('/projects'),
      get: (id) => get('/projects/' + id),
      create: (dto) => post('/projects', dto),
      update: (id, dto) => put('/projects/' + id, dto),
      remove: (id) => del('/projects/' + id),
    },

    vendors: {
      list: (opts) => get('/vendors', opts),
      search: (q) => get('/vendors/search', { q }),
      get: (id) => get('/vendors/' + id),
      /** Throws CONFLICT with details.similar[] on a near match — pass force:true to override. */
      create: (dto) => post('/vendors', dto),
      update: (id, dto) => put('/vendors/' + id, dto),
      remove: (id) => del('/vendors/' + id),
      bulk: (vendors) => post('/vendors/bulk', { vendors }),
    },

    materials: {
      list: (opts) => get('/materials', opts),
      create: (dto) => post('/materials', dto),
      update: (id, dto) => put('/materials/' + id, dto),
    },

    boqMaster: {
      list: (opts) => get('/boq-master', opts),
      create: (dto) => post('/boq-master', dto),
      update: (id, dto) => put('/boq-master/' + id, dto),
      remove: (id) => del('/boq-master/' + id),
      rates: (id) => get('/boq-master/' + id + '/rates'),
      addRate: (id, dto) => post('/boq-master/' + id + '/rates', dto),
      bulk: (items) => post('/boq-master/bulk', { items }),
    },

    boqs: {
      list: () => get('/boqs'),
      get: (id) => get('/boqs/' + id),
      create: (dto) => post('/boqs', dto),
      update: (id, dto) => put('/boqs/' + id, dto),
      remove: (id) => del('/boqs/' + id),
      saveItems: (id, items) => put('/boqs/' + id + '/items', { items }),
      transferToEnquiry: (boqId, itemIds, enquiryId, subject) =>
        post('/enquiries/transfer-from-boq', { boqId, itemIds, enquiryId, subject }),
    },

    /* The working draft is written locally first, then pushed. A network blip
       therefore costs nothing. */
    draft: {
      get: () => get('/boq-draft'),
      save: function (draft) {
        queueDraft(draft);
        if (draftTimer) clearTimeout(draftTimer);
        return new Promise(function (resolve) {
          draftTimer = setTimeout(async function () {
            try { await put('/boq-draft', { draft: draft }); localStorage.removeItem(DRAFT_KEY); resolve({ ok: true }); }
            catch (e) { resolve({ ok: false, queued: true }); }
          }, 1200);
        });
      },
      clear: () => del('/boq-draft'),
      flush: flushDraft,
    },

    rateAnalysis: {
      list: () => get('/rate-analyses'),
      get: (id) => get('/rate-analyses/' + id),
      create: (dto) => post('/rate-analyses', dto),
      saveComponents: (id, components) => put('/rate-analyses/' + id + '/components', { components }),
    },

    enquiries: {
      list: (opts) => get('/enquiries', opts),
      get: (id) => get('/enquiries/' + id),
      create: (dto) => post('/enquiries', dto),
      update: (id, dto) => put('/enquiries/' + id, dto),
      remove: (id) => del('/enquiries/' + id),
      saveItems: (id, items) => put('/enquiries/' + id + '/items', { items }),
      addVendor: (id, vendorId, vendorName) => post('/enquiries/' + id + '/vendors', { vendorId, vendorName }),
      removeVendor: (id, evId) => del('/enquiries/' + id + '/vendors/' + evId),
      /** Returns the raw token ONCE — build the vendor link immediately. */
      issueLink: (id, evId, expiryDays) => post('/enquiries/' + id + '/vendors/' + evId + '/link', { expiryDays }),
    },

    quotations: {
      saveLines: (enquiryId, evId, lines, terms) =>
        put('/enquiries/' + enquiryId + '/vendors/' + evId + '/lines', { lines, terms }),
      lock: (enquiryId, evId, locked) =>
        post('/enquiries/' + enquiryId + '/vendors/' + evId + '/lock', { locked }),
      revisions: (enquiryId, evId) => get('/enquiries/' + enquiryId + '/vendors/' + evId + '/revisions'),
      // Vendor portal — no session; the token is the authorisation.
      portalLoad: (token) => post('/vendor-portal/load', { token }),
      portalSave: (token, lines, terms) => post('/vendor-portal/save', { token, lines, terms }),
      portalSubmit: (token, lines, terms, remarks) => post('/vendor-portal/submit', { token, lines, terms, remarks }),
    },

    comparison: {
      get: (enquiryId) => get('/comparison/' + enquiryId),
      bidAnalysis: (enquiryId) => get('/bid-analysis/' + enquiryId),
      saveBidAnalysis: (dto) => post('/bid-analysis', dto),
      acceptRecommendation: (id) => post('/bid-analysis/' + id + '/accept'),
    },

    workOrders: {
      list: () => get('/work-orders'),
      get: (id) => get('/work-orders/' + id),
      create: (dto) => post('/work-orders', dto),
      createFromEnquiry: (enquiryId, enquiryVendorId, remarks) =>
        post('/work-orders/from-enquiry', { enquiryId, enquiryVendorId, remarks }),
      approve: (id) => post('/work-orders/' + id + '/approve'),
      reject: (id, reason) => post('/work-orders/' + id + '/reject', { reason }),
    },

    purchaseOrders: {
      list: () => get('/purchase-orders'),
      get: (id) => get('/purchase-orders/' + id),
      create: (dto) => post('/purchase-orders', dto),
      update: (id, dto) => put('/purchase-orders/' + id, dto),
      approve: (id) => post('/purchase-orders/' + id + '/approve'),
    },

    notifications: {
      list: (limit) => get('/notifications', limit ? { limit } : null),
      markRead: (id) => post('/notifications/' + id + '/read'),
      markAllRead: () => post('/notifications/read-all'),
    },

    audit: { list: (opts) => get('/audit', opts) },

    documents: {
      list: (ownerType, ownerId) => get('/documents', { ownerType, ownerId: ownerId || '' }),
      upload: function (ownerType, ownerId, file) {
        var fd = new FormData();
        fd.append('file', file);
        fd.append('ownerType', ownerType);
        if (ownerId) fd.append('ownerId', ownerId);
        return req('POST', '/documents/upload', fd);
      },
      downloadUrl: (id) => API_BASE + '/documents/' + id + '/download',
      remove: (id) => del('/documents/' + id),
    },

    migrate: {
      dryRun: (localStorageDump, vendorMaster) =>
        post('/migrate/import', { localStorage: localStorageDump, vendorMaster, dryRun: true }),
      run: (localStorageDump, vendorMaster) =>
        post('/migrate/import', { localStorage: localStorageDump, vendorMaster, dryRun: false }),
    },
  };

  window.CloudflareAPI = CloudflareAPI;
  probe().then(function (r) { emit(r.ok ? 'online' : (r.kind === 'offline' ? 'offline' : 'error'), r); });
})();
