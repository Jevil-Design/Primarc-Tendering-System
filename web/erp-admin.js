/* ════════════════════════════════════════════════════════════════════════
   PRIMARC TENDERING SYSTEM — ADMINISTRATION MODULE  (ERP-grade RBAC)
   Self-contained. Shares the existing `ts_users` store so the login that
   already gates the app keeps working. Everything else is data-driven and
   lives under erp_* localStorage keys. No build step, no dependencies.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ───────────────────────── storage helpers ───────────────────────── */
  const K = {
    users: 'ts_users',            // shared with the login system
    hist: 'ts_login_hist',        // shared login history
    dept: 'erp_departments',
    desig: 'erp_designations',
    mod: 'erp_modules',
    proj: 'erp_projects',
    branch: 'erp_branches',
    company: 'erp_companies',
    audit: 'erp_audit',
    notif: 'erp_notifications',
    flow: 'erp_workflows',
    policy: 'erp_policy',
    seeded: 'erp_seeded_v1',
    settings: 'erp_settings'
  };
  function load(k, f) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? f : v; } catch (e) { return f; } }
  function save(k, v) { try { (window.safeSetItem || localStorage.setItem.bind(localStorage))(k, JSON.stringify(v)); } catch (e) { console.warn('save failed', k, e); } }
  const uid = (p) => (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* data accessors */
  const users = () => load(K.users, []);
  const setUsers = (u) => save(K.users, u);
  const depts = () => load(K.dept, []);
  const desigs = () => load(K.desig, []);
  const modules = () => load(K.mod, []);
  const projects = () => load(K.proj, []);
  const branches = () => load(K.branch, []);
  const companies = () => load(K.company, []);
  const audit = () => load(K.audit, []);
  const notifs = () => load(K.notif, []);
  const flows = () => load(K.flow, []);
  const policy = () => load(K.policy, {});
  const settings = () => load(K.settings, {});

  const deptName = (id) => (depts().find(d => d.id === id) || {}).name || '—';
  const desigById = (id) => desigs().find(d => d.id === id) || null;
  const desigName = (id) => (desigById(id) || {}).name || '—';
  const branchName = (id) => (branches().find(b => b.id === id) || {}).name || '—';
  const companyName = (id) => (companies().find(c => c.id === id) || {}).name || '—';
  const userById = (id) => users().find(u => u.id === id) || null;
  const userName = (id) => (userById(id) || {}).name || '—';

  /* ───────────────────────── permission engine ───────────────────────── */
  const ACTIONS = [
    ['view', 'View'], ['create', 'Create'], ['edit', 'Edit'], ['delete', 'Delete'],
    ['approve', 'Approve'], ['reject', 'Reject'], ['import', 'Import'], ['export', 'Export'],
    ['print', 'Print'], ['lock', 'Lock'], ['unlock', 'Unlock'], ['share', 'Share']
  ];
  const STATUS = {
    active: { label: 'Active', color: 'var(--green)', dot: '●' },
    inactive: { label: 'Inactive', color: 'var(--faint)', dot: '○' },
    suspended: { label: 'Suspended', color: 'var(--accent2)', dot: '◐' },
    locked: { label: 'Locked', color: 'var(--red)', dot: '⊘' },
    pending: { label: 'Pending Approval', color: 'var(--blue)', dot: '◔' },
    archived: { label: 'Archived', color: 'var(--violet)', dot: '▣' }
  };
  // effective permission for a user on a module/action: designation default, then user override
  function effPerm(user, modId, action) {
    const d = desigById(user.designationId);
    let v = d && d.perms && d.perms[modId] ? !!d.perms[modId][action] : false;
    if (user.overrides && user.overrides[modId] && user.overrides[modId][action] != null) v = !!user.overrides[modId][action];
    return v;
  }

  /* ───────────────────────── current admin / session ───────────────────────── */
  function currentName() { try { const s = JSON.parse(localStorage.getItem('ts_session') || sessionStorage.getItem('ts_session')); return s ? s.name : 'Administrator'; } catch (e) { return 'Administrator'; } }
  function canAdmin() { return !window.Auth || (window.Auth.can && window.Auth.can('users')); }
  /* A browser cannot see its own public IP. This used to invent a random
     "10.20.x.y" address and stamp it on every audit entry as if it were real;
     the field is now left empty rather than recording a made-up value. */
  function myIP() { return ''; }
  function browserName() { const u = navigator.userAgent; if (/Edg\//.test(u)) return 'Edge'; if (/Chrome\//.test(u)) return 'Chrome'; if (/Firefox\//.test(u)) return 'Firefox'; if (/Safari\//.test(u)) return 'Safari'; return 'Browser'; }
  function osName() { const u = navigator.userAgent; if (/Windows/.test(u)) return 'Windows'; if (/Mac OS/.test(u)) return 'macOS'; if (/Android/.test(u)) return 'Android'; if (/iPhone|iPad/.test(u)) return 'iOS'; if (/Linux/.test(u)) return 'Linux'; return 'Desktop'; }

  /* ───────────────────────── audit + notifications ───────────────────────── */
  function logAudit(o) {
    const a = audit();
    a.unshift(Object.assign({ id: uid('au'), ts: Date.now(), admin: currentName(), ip: myIP(), browser: browserName() }, o));
    save(K.audit, a.slice(0, 800));
  }
  function notify(type, title, msg) {
    const n = notifs();
    n.unshift({ id: uid('n'), ts: Date.now(), type, title, msg, read: false });
    save(K.notif, n.slice(0, 200));
    refreshBadge();
  }
  /* Unread count now lives on the Notifications nav item (the separate bell
     button went with the old header bar). */
  function refreshBadge() { renderNav(); }

  /* ───────────────────────── password hashing (compatible w/ Auth) ───────────────────────── */
  function simpleHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  async function hash(pw, salt) {
    const txt = salt + '|' + pw;
    if (window.crypto && crypto.subtle) {
      try { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt)); return { algo: 'sha256', h: [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('') }; } catch (e) {}
    }
    let acc = txt; for (let i = 0; i < 997; i++) acc = simpleHash(acc + i); return { algo: 'simple', h: acc };
  }
  const rndSalt = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  /* ════════════════════════════════════════════════════════════════════
     SEED  — rich Primarc-flavoured sample data
     ════════════════════════════════════════════════════════════════════ */
  async function seed() {
    if (load(K.seeded, false)) { migrate(); return; }

    const companiesD = [
      { id: 'co_pp', name: 'Primarc Projects Pvt Ltd', code: 'PPPL', gst: '19AABCP1234A1Z5' },
      { id: 'co_ps', name: 'Primarc Spaces', code: 'PSPC', gst: '19AABCP5678B1Z2' }
    ];
    const branchesD = [
      { id: 'br_kol', name: 'Kolkata — Head Office', code: 'KOL', companyId: 'co_pp', city: 'Kolkata' },
      { id: 'br_mum', name: 'Mumbai', code: 'MUM', companyId: 'co_pp', city: 'Mumbai' },
      { id: 'br_blr', name: 'Bengaluru', code: 'BLR', companyId: 'co_ps', city: 'Bengaluru' },
      { id: 'br_pun', name: 'Pune', code: 'PUN', companyId: 'co_ps', city: 'Pune' }
    ];
    const deptD = [
      ['Management', 'MGT'], ['Administration', 'ADM'], ['QS & Contracts', 'QSC'], ['Planning', 'PLN'],
      ['Purchase', 'PUR'], ['Accounts', 'ACC'], ['Execution', 'EXE'], ['Projects', 'PRJ'],
      ['HR', 'HR'], ['Store', 'STR'], ['Quality', 'QLT'], ['Safety', 'SFT']
    ].map(([name, code]) => ({ id: 'dp_' + code.toLowerCase(), name, code, status: 'active' }));
    const D = (n) => deptD.find(d => d.name === n).id;

    const modD = ['Dashboard', 'Projects', 'BOQ Master', 'BOQ Creation', 'Rate Analysis', 'Enquiry', 'Tender',
      'Vendor', 'Comparison', 'Work Order', 'Purchase Order', 'Material Master', 'Reports', 'Administration', 'Settings']
      .map((name, i) => ({ id: 'm_' + name.toLowerCase().replace(/[^a-z]/g, ''), name, order: i, core: true }));

    const projD = [
      ['RDB Techpark', 'RDBT'], ['Aaranya', 'ARNY'], ['Aadvika', 'ADVK'], ['Anandavilas', 'ANDV'],
      ['Primarc Square', 'PSQR'], ['Akriti', 'AKRT']
    ].map(([name, code]) => ({ id: 'pr_' + code.toLowerCase(), name, code, status: 'active' }));

    // designations with hierarchy, default perms, financial limits
    const desigSpec = [
      ['Director', 'Management', null, 1, 'all', { quotation: 1e9, tender: 1e9, workorder: 1e9, purchase: 1e9 }],
      ['General Manager', 'Management', 'Director', 2, 'all', { quotation: 5e7, tender: 1e8, workorder: 1.5e8, purchase: 1e8 }],
      ['System Administrator', 'Administration', 'Director', 2, 'all', { quotation: 0, tender: 0, workorder: 0, purchase: 0 }],
      ['Project Manager', 'Projects', 'General Manager', 3, 'pm', { quotation: 1e7, tender: 2.5e7, workorder: 5e7, purchase: 2e7 }],
      ['Commercial Manager', 'QS & Contracts', 'Project Manager', 4, 'comm', { quotation: 25e5, tender: 1e7, workorder: 25e5, purchase: 1e7 }],
      ['Purchase Manager', 'Purchase', 'General Manager', 4, 'purch', { quotation: 0, tender: 0, workorder: 1e7, purchase: 2e7 }],
      ['Accounts Manager', 'Accounts', 'General Manager', 4, 'acct', { quotation: 0, tender: 0, workorder: 0, purchase: 5e6 }],
      ['HR Manager', 'HR', 'General Manager', 4, 'hr', { quotation: 0, tender: 0, workorder: 0, purchase: 5e5 }],
      ['Senior QS', 'QS & Contracts', 'Commercial Manager', 5, 'sqs', { quotation: 1e6, tender: 0, workorder: 0, purchase: 0 }],
      ['Planning Engineer', 'Planning', 'Project Manager', 5, 'plan', { quotation: 0, tender: 0, workorder: 0, purchase: 0 }],
      ['QS Engineer', 'QS & Contracts', 'Senior QS', 6, 'qs', { quotation: 5e5, tender: 0, workorder: 0, purchase: 0 }],
      ['Purchase Executive', 'Purchase', 'Purchase Manager', 6, 'pexec', { quotation: 0, tender: 0, workorder: 0, purchase: 25e4 }],
      ['Site Engineer', 'Execution', 'Project Manager', 6, 'site', { quotation: 0, tender: 0, workorder: 0, purchase: 0 }],
      ['Store Incharge', 'Store', 'Project Manager', 6, 'store', { quotation: 0, tender: 0, workorder: 0, purchase: 1e5 }],
      ['QA/QC Engineer', 'Quality', 'Project Manager', 6, 'qa', { quotation: 0, tender: 0, workorder: 0, purchase: 0 }],
      ['Safety Officer', 'Safety', 'Project Manager', 6, 'safety', { quotation: 0, tender: 0, workorder: 0, purchase: 0 }]
    ];
    const mId = (n) => modD.find(m => m.name === n).id;
    function permTemplate(kind) {
      const p = {}; modD.forEach(m => p[m.id] = {});
      const grant = (names, acts) => names.forEach(n => { const id = mId(n); acts.forEach(a => p[id][a] = 1); });
      const ALL = ACTIONS.map(a => a[0]);
      const VIEW = ['view']; const RW = ['view', 'create', 'edit', 'export', 'print']; const RWX = RW.concat(['import', 'share']);
      grant(['Dashboard'], VIEW);
      if (kind === 'all') { modD.forEach(m => ALL.forEach(a => p[m.id][a] = 1)); return p; }
      if (kind === 'pm') { grant(['Projects', 'BOQ Master', 'BOQ Creation', 'Rate Analysis', 'Enquiry', 'Tender', 'Vendor', 'Comparison', 'Work Order', 'Purchase Order', 'Material Master', 'Reports'], RWX.concat(['approve', 'reject', 'lock', 'unlock', 'delete'])); }
      else if (kind === 'comm') { grant(['Projects', 'BOQ Master', 'BOQ Creation', 'Rate Analysis', 'Enquiry', 'Tender', 'Vendor', 'Comparison', 'Reports'], RWX.concat(['approve', 'reject', 'lock'])); grant(['Work Order', 'Purchase Order'], VIEW.concat(['export', 'print'])); }
      else if (kind === 'sqs') { grant(['Projects', 'BOQ Master', 'BOQ Creation', 'Rate Analysis', 'Enquiry', 'Comparison', 'Reports'], RWX); grant(['Tender', 'Vendor'], VIEW.concat(['export'])); }
      else if (kind === 'qs') { grant(['BOQ Master', 'BOQ Creation', 'Rate Analysis', 'Enquiry', 'Comparison'], RW); grant(['Projects', 'Vendor', 'Reports'], VIEW); }
      else if (kind === 'plan') { grant(['Projects', 'BOQ Master', 'BOQ Creation', 'Reports'], RW); grant(['Enquiry', 'Comparison'], VIEW); }
      else if (kind === 'purch') { grant(['Vendor', 'Purchase Order', 'Work Order', 'Material Master', 'Comparison', 'Reports'], RWX.concat(['approve', 'reject', 'lock', 'unlock', 'delete'])); grant(['Enquiry', 'Projects'], VIEW.concat(['export'])); }
      else if (kind === 'pexec') { grant(['Vendor', 'Purchase Order', 'Material Master'], RW); grant(['Comparison', 'Work Order', 'Projects'], VIEW); }
      else if (kind === 'acct') { grant(['Work Order', 'Purchase Order', 'Reports'], VIEW.concat(['export', 'print', 'approve'])); grant(['Projects'], VIEW); }
      else if (kind === 'site') { grant(['Projects', 'BOQ Master', 'Material Master', 'Reports'], VIEW); grant(['BOQ Creation'], ['view', 'edit']); }
      else if (kind === 'store') { grant(['Material Master', 'Purchase Order'], RW); grant(['Projects', 'Work Order'], VIEW); }
      else if (kind === 'qa' || kind === 'safety') { grant(['Projects', 'Reports', 'Material Master'], VIEW.concat(['export', 'print'])); }
      else if (kind === 'hr') { grant(['Reports'], VIEW.concat(['export'])); grant(['Administration'], ['view']); }
      return p;
    }
    const desigD = desigSpec.map(([name, dept, reports, level, kind, limits]) => ({
      id: 'dg_' + name.toLowerCase().replace(/[^a-z]/g, ''), name, departmentId: D(dept), reportsToName: reports,
      level, description: name + ' — ' + dept, status: 'active', perms: permTemplate(kind), limits
    }));
    desigD.forEach(d => { if (d.reportsToName) { const r = desigD.find(x => x.name === d.reportsToName); d.reportsTo = r ? r.id : null; } delete d.reportsToName; });
    const dgId = (n) => desigD.find(d => d.name === n).id;

    // employees
    const empSpec = [
      ['Subir Bose', 'Director', 'Management', 'br_kol', 'active'],
      ['Anjali Mehra', 'General Manager', 'Management', 'br_kol', 'active'],
      ['Rahul Sharma', 'Project Manager', 'Projects', 'br_kol', 'active'],
      ['Pradeep Nair', 'Project Manager', 'Projects', 'br_mum', 'active'],
      ['Sourav Ganguly', 'Commercial Manager', 'QS & Contracts', 'br_kol', 'active'],
      ['Meghna Iyer', 'Commercial Manager', 'QS & Contracts', 'br_blr', 'active'],
      ['Arjun Das', 'Senior QS', 'QS & Contracts', 'br_kol', 'active'],
      ['Farhan Qureshi', 'Senior QS', 'QS & Contracts', 'br_mum', 'active'],
      ['Priya Verma', 'QS Engineer', 'QS & Contracts', 'br_kol', 'active'],
      ['Karan Malhotra', 'QS Engineer', 'QS & Contracts', 'br_blr', 'active'],
      ['Sneha Pillai', 'QS Engineer', 'QS & Contracts', 'br_kol', 'suspended'],
      ['Vikram Rao', 'Planning Engineer', 'Planning', 'br_mum', 'active'],
      ['Deepa Krishnan', 'Purchase Manager', 'Purchase', 'br_kol', 'active'],
      ['Imran Sheikh', 'Purchase Executive', 'Purchase', 'br_kol', 'active'],
      ['Ritu Agarwal', 'Purchase Executive', 'Purchase', 'br_pun', 'inactive'],
      ['Manoj Gupta', 'Accounts Manager', 'Accounts', 'br_kol', 'active'],
      ['Lakshmi Menon', 'HR Manager', 'HR', 'br_blr', 'active'],
      ['Rohit Sen', 'Site Engineer', 'Execution', 'br_kol', 'active'],
      ['Ayesha Khan', 'Site Engineer', 'Execution', 'br_mum', 'active'],
      ['Tarun Joshi', 'Store Incharge', 'Store', 'br_pun', 'active'],
      ['Nikhil Reddy', 'QA/QC Engineer', 'Quality', 'br_blr', 'active'],
      ['Sandeep Yadav', 'Safety Officer', 'Safety', 'br_mum', 'locked']
    ];
    const COLORS = ['#ff6a2c', '#5e9bf0', '#34d399', '#a78bfa', '#ffd23f', '#f87171', '#2dd4bf', '#fb923c'];
    const slug = (n) => n.toLowerCase().split(' ')[0] + '.' + n.toLowerCase().split(' ').slice(-1)[0][0];
    const salt = rndSalt(); const { algo, h } = await hash('demo123', salt);
    const startTs = Date.now() - 1000 * 86400 * 400;
    const empD = [];
    for (let i = 0; i < empSpec.length; i++) {
      const [name, desig, dept, br, status] = empSpec[i];
      const co = branchesD.find(b => b.id === br).companyId;
      const designationId = dgId(desig);
      const dObj = desigD.find(x => x.id === designationId);
      // map designation -> coarse Auth role so the rest of the app behaves
      let role = 'Viewer';
      if (/Director|General Manager|System Admin/.test(desig)) role = 'Admin';
      else if (/Project Manager|Commercial Manager|Senior QS|QS Engineer|Planning/.test(desig)) role = 'QS Engineer';
      else if (/Purchase/.test(desig)) role = 'Purchase';
      const initials = name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
      empD.push({
        id: 'u_' + slug(name).replace(/[^a-z.]/g, '') + i,
        empId: 'PRMC-' + String(101 + i),
        username: slug(name), name,
        email: slug(name).replace('.', '') + '@primarc.in',
        mobile: '+91 ' + (90000 + Math.floor(Math.random() * 9999)) + ' ' + (10000 + Math.floor(Math.random() * 89999)),
        photo: null, avatarColor: COLORS[i % COLORS.length], initials,
        departmentId: D(dept), designationId,
        reportingManagerName: dObj.reportsTo ? null : null,
        branchId: br, companyId: co,
        status, platformAccess: status === 'active' || status === 'suspended',
        joiningDate: new Date(startTs + i * 1000 * 86400 * 12).toISOString().slice(0, 10),
        lastLogin: status === 'active' ? Date.now() - Math.floor(Math.random() * 1000 * 3600 * 50) : 0,
        signature: null, remarks: '',
        projectAccess: i % 4 === 0 ? 'all' : { mode: 'selected', ids: projD.slice(0, 2 + (i % 3)).map(p => p.id) },
        expiryDate: '', lockReason: status === 'locked' ? 'Multiple failed login attempts' : '',
        failedLogins: status === 'locked' ? 5 : 0,
        sessions: status === 'active' && i % 3 === 0 ? [{ id: uid('s'), browser: browserName(), os: osName(), ip: '10.20.' + (10 + i) + '.' + (40 + i), since: Date.now() - 1000 * 3600 * (1 + i), last: Date.now() - 1000 * 60 * (i + 1) }] : [],
        overrides: {}, role, salt, hash: h, algo, active: status === 'active', created: startTs + i * 1000 * 86400 * 12
      });
    }
    // a couple of meaningful per-user overrides for the demo
    const pv = empD.find(e => e.name === 'Priya Verma');
    if (pv) pv.overrides = { [mId('BOQ Master')]: { delete: 1 }, [mId('Tender')]: { approve: 1 }, [mId('Comparison')]: { export: 1 } };
    // reporting managers (by designation reportsTo -> pick a person)
    empD.forEach(e => { const dg = desigD.find(d => d.id === e.designationId); if (dg && dg.reportsTo) { const mgr = empD.find(x => x.designationId === dg.reportsTo); e.reportingManagerId = mgr ? mgr.id : null; } });

    // merge employees into ts_users, preserving any existing accounts (e.g. admin)
    const existing = users();
    const adminUser = existing.find(u => u.id === 'u_admin');
    if (adminUser) { adminUser.empId = adminUser.empId || 'PRMC-100'; adminUser.designationId = dgId('System Administrator'); adminUser.departmentId = D('Administration'); adminUser.branchId = 'br_kol'; adminUser.companyId = 'co_pp'; adminUser.status = 'active'; adminUser.platformAccess = true; adminUser.projectAccess = 'all'; adminUser.avatarColor = '#ff6a2c'; adminUser.initials = 'AD'; adminUser.overrides = adminUser.overrides || {}; adminUser.sessions = adminUser.sessions || []; adminUser.email = adminUser.email || 'admin@primarc.in'; }
    const merged = existing.slice();
    empD.forEach(e => { if (!merged.find(m => m.username.toLowerCase() === e.username.toLowerCase())) merged.push(e); });
    setUsers(merged);

    save(K.company, companiesD); save(K.branch, branchesD); save(K.dept, deptD);
    save(K.desig, desigD); save(K.mod, modD); save(K.proj, projD);

    // workflows
    save(K.flow, [
      { id: 'wf_quote', name: 'Enquiry Approval', moduleId: mId('Enquiry'), steps: [dgId('QS Engineer'), dgId('Senior QS'), dgId('Commercial Manager'), dgId('Project Manager'), dgId('Director')] },
      { id: 'wf_tender', name: 'Tender Approval', moduleId: mId('Tender'), steps: [dgId('Commercial Manager'), dgId('Project Manager'), dgId('General Manager'), dgId('Director')] },
      { id: 'wf_wo', name: 'Work Order Approval', moduleId: mId('Work Order'), steps: [dgId('Purchase Manager'), dgId('Project Manager'), dgId('General Manager'), dgId('Director')] }
    ]);

    save(K.policy, {
      minLen: 8, complexity: true, expiryDays: 90, history: 3, mustChangeFirst: true,
      lockAfter: 5, idleLockDays: 60, sessionTimeout: 30, concurrent: 'multi', concurrentMax: 2,
      twoFactor: false, rememberMe: true,
      ipMode: 'any', ipList: '203.122.45.0/24',
      scheduleEnabled: false, scheduleDays: [1, 2, 3, 4, 5], scheduleFrom: '09:00', scheduleTo: '19:00',
      license: { total: 50, expires: '2027-03-31' }
    });

    /* Audit trail and notifications start empty. They used to be seeded with
       invented entries (named staff, a made-up work order value) that the
       dashboard then presented as real activity in an "immutable" log. */
    save(K.audit, []);
    save(K.notif, []);

    save(K.seeded, true);
  }
  function migrate() {
    // ensure future modules added by other code show up; ensure admin enriched
    const u = users(); let ch = false;
    u.forEach(x => { if (x.overrides == null) { x.overrides = {}; ch = true; } if (x.sessions == null) { x.sessions = []; ch = true; } });
    if (ch) setUsers(u);
    // one-time: rename the "Quotation" module + workflow display labels to "Enquiry"
    // (internal ids and permission keys are left untouched so saved access stays valid)
    try {
      const mods = modules(); let mch = false;
      mods.forEach(m => { if (m.name === 'Quotation') { m.name = 'Enquiry'; mch = true; } });
      if (mch) save(K.mod, mods);
      const fl = flows(); let fch = false;
      fl.forEach(w => { if (w.name === 'Quotation Approval') { w.name = 'Enquiry Approval'; fch = true; } });
      if (fch) save(K.flow, fl);
    } catch (e) {}
  }
  function ensureModule(name) {
    const m = modules(); if (m.find(x => x.name.toLowerCase() === name.toLowerCase())) return;
    m.push({ id: 'm_' + name.toLowerCase().replace(/[^a-z]/g, ''), name, order: m.length, core: false });
    save(K.mod, m);
  }

  /* ════════════════════════════════════════════════════════════════════
     STYLES
     ════════════════════════════════════════════════════════════════════ */
  function injectCSS() {
    if (document.getElementById('erpCSS')) return;
    const s = document.createElement('style'); s.id = 'erpCSS';
    s.textContent = `
    /* Administration — compact enterprise layout. Every rule is scoped to
       .erp-* / #admin / #erpCmd, so nothing here reaches other modules. Colours
       come from the app's theme tokens, so light and dark both follow. */
    /* drawers, dialogs, menus and the palette are attached to <body>, outside
       #admin — so the shared variables are defined on each of them too */
    #admin,.erp-ov,.erp-rowmenu,#erpCmd{--erp-r:10px;--erp-r-sm:7px;--erp-fl:var(--field-line,var(--line));--erp-fb:var(--field-bg,var(--panel));--erp-ring:var(--focus-ring,0 0 0 3px rgba(91,147,245,.3))}
    #admin{font-family:'Archivo',sans-serif}
    .erp-wrap{display:flex;width:100%;height:100%;overflow:hidden;background:var(--bg)}

    /* side navigation */
    .erp-side{width:220px;flex-shrink:0;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;transition:width .16s ease;position:relative;z-index:2}
    .erp-side.collapsed{width:60px}
    .erp-side-head{display:flex;flex-direction:column;gap:8px;padding:12px 10px 10px;border-bottom:1px solid var(--line)}
    .erp-side-head .t{font-size:13px;font-weight:700;color:var(--ink);padding:0 4px;display:flex;align-items:center;gap:8px}
    .erp-side-head .t svg{width:16px;height:16px;stroke:var(--accent);fill:none;stroke-width:2;flex-shrink:0}
    .erp-side-head .t span{display:block;font-size:10.5px;font-weight:500;color:var(--faint);margin-top:1px}
    .erp-findbtn{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 9px;background:var(--erp-fb);border:1px solid var(--erp-fl);border-radius:var(--erp-r-sm);color:var(--faint);font:inherit;font-size:12px;cursor:pointer;text-align:left}
    .erp-findbtn:hover{border-color:var(--accent);color:var(--ink)}
    .erp-findbtn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;flex-shrink:0}
    .erp-findbtn .kbd{margin-left:auto;font-size:10px;font-family:'Spline Sans Mono',monospace;border:1px solid var(--line);border-radius:4px;padding:0 4px;color:var(--faint)}
    .erp-side.collapsed .t span,.erp-side.collapsed .t b,.erp-side.collapsed .erp-findbtn .lbl,.erp-side.collapsed .erp-findbtn .kbd,
    .erp-side.collapsed .erp-nav-lbl,.erp-side.collapsed .erp-nav .pin,.erp-side.collapsed .erp-nav .ext,.erp-side.collapsed .erp-side-foot .txt{display:none}
    .erp-side.collapsed .erp-findbtn{justify-content:center;padding:0}
    .erp-side.collapsed .erp-side-head .t{justify-content:center}
    .erp-nav{flex:1;overflow-y:auto;padding:6px 8px 12px}
    .erp-nav-sec{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--faint);padding:12px 10px 4px}
    .erp-nav a{display:flex;align-items:center;gap:9px;height:32px;padding:0 10px;border-radius:var(--erp-r-sm);color:var(--dim);font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:none;position:relative;transition:background-color .12s,color .12s;margin-bottom:1px}
    .erp-nav a svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.9;flex-shrink:0}
    .erp-nav a:hover{background:var(--hi);color:var(--ink)}
    .erp-nav a:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
    .erp-nav a.on{background:rgba(var(--accent-rgb,91,147,245),.10);color:var(--accent);font-weight:700}
    .erp-nav a.on::before{content:'';position:absolute;left:-8px;top:7px;bottom:7px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
    .erp-nav a .ext{margin-left:auto;font-size:11px;color:var(--faint)}
    .erp-side.collapsed .erp-nav-sec{font-size:0;padding:0;height:1px;margin:8px 10px;background:var(--line)}
    .erp-side.collapsed .erp-nav-sec:first-child{display:none}
    .erp-nav a .pin{margin-left:auto;font-size:11px;color:var(--faint);opacity:0;transition:opacity .12s}
    .erp-nav a:hover .pin,.erp-nav a:focus-visible .pin{opacity:.7}
    .erp-nav a .pin.on{opacity:1;color:var(--accent2)}
    .erp-nav a .cnt{margin-left:auto;font-size:10.5px;font-variant-numeric:tabular-nums;background:var(--panel3);color:var(--dim);padding:0 6px;border-radius:9px;line-height:17px}
    .erp-nav a .cnt.hot{background:var(--accent);color:#fff}
    .erp-side.collapsed .erp-nav a{justify-content:center;padding:0}
    .erp-side.collapsed .erp-nav a .cnt{display:none}
    .erp-side-foot{padding:8px;border-top:1px solid var(--line)}
    .erp-collapse{display:flex;align-items:center;gap:9px;width:100%;height:30px;background:none;border:none;color:var(--faint);font-size:11.5px;font-weight:600;padding:0 10px;border-radius:var(--erp-r-sm);cursor:pointer;font-family:inherit}
    .erp-collapse:hover{background:var(--hi);color:var(--ink)}
    .erp-collapse svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2}

    .erp-main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
    .erp-iconbtn{position:relative;width:30px;height:30px;border-radius:var(--erp-r-sm);background:transparent;border:1px solid transparent;color:var(--dim);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .12s,color .12s}
    .erp-iconbtn:hover{background:var(--hi);color:var(--ink)}
    .erp-iconbtn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .erp-iconbtn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2}
    #erpBellDot{display:none}

    .erp-body{flex:1;overflow-y:auto;padding:18px 22px 28px}
    .erp-page{max-width:1320px}
    @media (prefers-reduced-motion: no-preference){ .erp-fade-in{animation:erpFadeIn .14s ease-out} @keyframes erpFadeIn{from{opacity:.4}to{opacity:1}} }
    .erp-h{font-size:18px;font-weight:700;color:var(--ink);margin:0 0 3px;letter-spacing:-.2px}
    .erp-sub{font-size:12.5px;color:var(--dim);margin-bottom:14px;line-height:1.5;max-width:90ch}
    .erp-sec-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px;flex-wrap:wrap}
    .erp-sec-head .erp-sub{margin-bottom:0}
    .erp-sec-head .acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .erp-h2{font-size:14px;font-weight:700;color:var(--ink);margin:22px 0 4px}
    .erp-local{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;color:var(--dim);background:var(--panel3);border:1px solid var(--line);border-radius:10px;padding:1px 8px;vertical-align:2px;margin-left:8px;white-space:nowrap}
    .erp-note{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:var(--erp-r-sm);border:1px solid var(--line);background:var(--panel2);font-size:12px;color:var(--dim);line-height:1.5;margin-bottom:14px}
    .erp-note svg{width:16px;height:16px;stroke:var(--accent);fill:none;stroke-width:2;flex-shrink:0;margin-top:1px}
    .erp-note b{color:var(--ink)}
    .erp-note.warn{background:var(--warn-bg,rgba(251,191,36,.1));border-color:var(--warn-line,rgba(251,191,36,.5))}
    .erp-note.warn svg{stroke:var(--accent2)}
    .erp-note .erp-btn{margin-left:auto;flex-shrink:0}

    /* summary strip (dashboard + page headers) — compact, real figures only */
    .erp-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px}
    .erp-tile{background:var(--panel);border:1px solid var(--line);border-radius:var(--erp-r);padding:11px 13px;text-align:left;font:inherit;color:inherit}
    button.erp-tile{cursor:pointer;transition:border-color .12s}
    button.erp-tile:hover{border-color:var(--accent)}
    button.erp-tile:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .erp-tile .l{font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--faint);font-weight:700}
    .erp-tile .n{font-size:22px;font-weight:700;color:var(--ink);line-height:1.2;margin-top:4px;font-variant-numeric:tabular-nums}
    .erp-tile .d{font-size:11px;color:var(--dim);margin-top:2px}
    .erp-tile .ic{display:none}

    .erp-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--erp-r);overflow:hidden}
    .erp-card + .erp-card{margin-top:14px}
    .erp-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line);min-height:44px}
    .erp-card-head .ttl{font-size:13px;font-weight:700;color:var(--ink)}
    .erp-card-head .ttl span{font-size:11.5px;font-weight:500;color:var(--faint);margin-left:6px}
    .erp-card-body{padding:14px}
    .erp-grid2{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:14px;align-items:start}
    .erp-grid2 > div > .erp-card + .erp-card{margin-top:14px}
    @media(max-width:1100px){.erp-grid2{grid-template-columns:minmax(0,1fr)}}
    details.erp-card > summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;min-height:44px;font-size:13px;font-weight:700;color:var(--ink)}
    details.erp-card > summary::-webkit-details-marker{display:none}
    details.erp-card > summary::after{content:'';width:8px;height:8px;border-right:2px solid var(--faint);border-bottom:2px solid var(--faint);transform:rotate(45deg);margin-right:4px;transition:transform .15s}
    details.erp-card[open] > summary{border-bottom:1px solid var(--line)}
    details.erp-card[open] > summary::after{transform:rotate(-135deg)}
    details.erp-card > summary span{font-size:11.5px;font-weight:500;color:var(--faint);margin-left:6px}
    details.erp-card > summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}

    /* admin modules directory on the dashboard */
    .erp-mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px 8px}
    .erp-mod{display:flex;gap:9px;align-items:flex-start;padding:8px 10px;border:1px solid var(--line);border-radius:var(--erp-r-sm);background:var(--panel);cursor:pointer;text-align:left;font:inherit;color:inherit;width:100%}
    .erp-mod:hover{border-color:var(--accent)}
    .erp-mod:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .erp-mod svg{width:16px;height:16px;stroke:var(--accent);fill:none;stroke-width:2;flex-shrink:0;margin-top:2px}
    .erp-mod b{display:block;font-size:12.5px;color:var(--ink)}
    .erp-mod span{display:block;font-size:11.5px;color:var(--dim);margin-top:1px;line-height:1.4}
    .erp-modgrp{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--faint);margin:10px 0 0}
    .erp-modgrp:first-child{margin-top:0}

    /* toolbar: search + filters together, secondary actions to the right */
    .erp-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
    .erp-field{position:relative}
    .erp-field>svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:14px;height:14px;stroke:var(--faint);fill:none;stroke-width:2;pointer-events:none}
    .erp-input,.erp-select{height:32px;background:var(--erp-fb);border:1px solid var(--erp-fl);border-radius:var(--erp-r-sm);color:var(--ink);font-size:12.5px;padding:0 10px;outline:none;font-family:inherit}
    .erp-field .erp-input{padding-left:30px;min-width:240px}
    .erp-input:focus,.erp-select:focus{border-color:var(--accent);box-shadow:var(--erp-ring)}
    .erp-select{cursor:pointer;max-width:200px}
    .erp-tb-sp{flex:1}
    .erp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;background:var(--panel);border:1px solid var(--erp-fl);color:var(--ink);font-size:12.5px;font-weight:600;padding:0 12px;border-radius:var(--erp-r-sm);cursor:pointer;font-family:inherit;transition:border-color .12s,color .12s,background-color .12s;white-space:nowrap;box-shadow:var(--shadow-1,none)}
    .erp-btn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;flex-shrink:0}
    .erp-btn:hover{border-color:var(--accent);color:var(--accent)}
    .erp-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .erp-btn:disabled{opacity:.5;cursor:not-allowed}
    .erp-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
    .erp-btn.primary:hover{background:var(--accent-deep,var(--accent));border-color:var(--accent-deep,var(--accent));color:#fff}
    .erp-btn.danger{color:var(--red)}
    .erp-btn.danger:hover{border-color:var(--red);color:var(--red)}
    .erp-btn.danger.solid{background:var(--red);border-color:var(--red);color:#fff}
    .erp-btn.sm{min-height:28px;padding:0 9px;font-size:11.5px}
    .erp-btn.ghost{background:none;border-color:transparent;box-shadow:none;color:var(--dim)}
    .erp-btn.ghost:hover{background:var(--hi);color:var(--ink);border-color:transparent}
    .erp-btn.icon{width:28px;min-height:28px;padding:0}

    /* tables */
    .erp-tbl-wrap{overflow:auto;max-height:calc(100vh - 230px)}
    .erp-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
    .erp-tbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--th-ink,var(--faint));font-weight:700;padding:0 12px;height:36px;border-bottom:1px solid var(--line);white-space:nowrap;background:var(--th-bg,var(--panel2));position:sticky;top:0;z-index:1;cursor:pointer;user-select:none}
    .erp-tbl th.nosort{cursor:default}
    .erp-tbl th.num,.erp-tbl td.num{text-align:right;font-variant-numeric:tabular-nums}
    .erp-tbl th .ar{color:var(--accent);margin-left:3px}
    .erp-tbl td{padding:8px 12px;height:44px;border-bottom:1px solid var(--line2,var(--line));color:var(--dim);vertical-align:middle}
    .erp-tbl tbody tr:last-child td{border-bottom:none}
    .erp-tbl tbody tr{transition:background-color .1s ease}
    .erp-tbl tbody tr:hover{background:var(--hi)}
    .erp-tbl tbody tr.sel{background:rgba(var(--accent-rgb,91,147,245),.07)}
    .erp-tbl tbody tr[data-uid]{cursor:pointer}
    .erp-tbl .mono{font-family:'Spline Sans Mono',monospace;font-size:11.5px}
    .erp-tbl .nm{color:var(--ink);font-weight:600}
    .erp-tbl .sub2{font-size:11.5px;color:var(--faint);margin-top:1px}
    .erp-tbl .acts{text-align:right;white-space:nowrap}
    .erp-tbl .acts > *{vertical-align:middle}
    .erp-cellname{display:flex;align-items:center;gap:10px;min-width:0}
    .erp-av{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;flex-shrink:0;overflow:hidden;background-size:cover;background-position:center}
    .erp-chk{width:15px;height:15px;cursor:pointer;accent-color:var(--accent)}

    .erp-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:1px 8px;border-radius:10px;white-space:nowrap;line-height:18px}
    .erp-badge::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
    .erp-badge.mute{color:var(--dim);background:var(--panel3)}
    .erp-badge.ok{color:var(--green);background:var(--green-soft,rgba(52,211,153,.13))}
    .erp-badge.warn{color:var(--accent2);background:var(--amber-soft,rgba(251,191,36,.12))}
    .erp-badge.bad{color:var(--red);background:rgba(220,38,38,.10)}
    .erp-tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;border-radius:6px;background:var(--panel3);color:var(--dim);white-space:nowrap}
    .erp-pill{display:inline-block;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:1px 6px;border-radius:9px;color:#fff;vertical-align:1px}

    /* row menu */
    .erp-rowmenu{position:fixed;z-index:100020;background:var(--panel);border:1px solid var(--line);border-radius:var(--erp-r);box-shadow:var(--shadow-pop,0 14px 36px rgba(0,0,0,.35));padding:4px;min-width:200px;display:none;font-family:'Archivo',sans-serif}
    .erp-rowmenu button{display:flex;align-items:center;gap:9px;width:100%;height:32px;text-align:left;background:none;border:none;color:var(--ink);font-size:12.5px;font-weight:500;padding:0 10px;border-radius:6px;cursor:pointer;font-family:inherit}
    .erp-rowmenu button svg{width:15px;height:15px;stroke:var(--faint);fill:none;stroke-width:1.9;flex-shrink:0}
    .erp-rowmenu button:hover,.erp-rowmenu button:focus-visible{background:var(--hi);outline:none}
    .erp-rowmenu button:hover svg{stroke:var(--accent)}
    .erp-rowmenu button.danger{color:var(--red)} .erp-rowmenu button.danger svg{stroke:var(--red)}
    .erp-rowmenu .sep{height:1px;background:var(--line);margin:4px}

    .erp-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 2px 0;font-size:12px;color:var(--faint);flex-wrap:wrap}
    .erp-pager .pg{display:flex;gap:4px;align-items:center}
    .erp-pager .pg button{min-width:30px;height:30px;border-radius:6px;background:var(--panel);border:1px solid var(--erp-fl);color:var(--ink);font-size:12px;cursor:pointer;font-family:inherit}
    .erp-pager .pg button.on{background:var(--accent);border-color:var(--accent);color:#fff}
    .erp-pager .pg button:disabled{opacity:.4;cursor:default}
    .erp-pager select{height:30px;border-radius:6px;border:1px solid var(--erp-fl);background:var(--erp-fb);color:var(--ink);font:inherit;font-size:12px;padding:0 6px}

    .erp-bulkbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:rgba(var(--accent-rgb,91,147,245),.07);border:1px solid rgba(var(--accent-rgb,91,147,245),.28);border-radius:var(--erp-r-sm);padding:6px 10px;margin-bottom:12px;font-size:12.5px;color:var(--ink)}
    .erp-bulkbar b{color:var(--accent)}

    .erp-empty{text-align:center;padding:36px 20px;color:var(--faint);font-size:12.5px}
    .erp-empty svg{display:block;width:32px;height:32px;stroke:var(--faint);fill:none;stroke-width:1.5;margin:0 auto 8px;opacity:.7}
    .erp-empty b{display:block;color:var(--ink);font-size:13px;margin-bottom:3px}
    .erp-empty .erp-btn{margin-top:12px}

    /* overlays: drawer + modal */
    .erp-ov{position:fixed;inset:0;z-index:100015;background:var(--scrim,rgba(8,10,14,.55));display:none;opacity:0;transition:opacity .16s ease;font-family:'Archivo',sans-serif}
    .erp-ov.on{display:block;opacity:1}
    .erp-drawer{position:absolute;top:0;right:0;height:100%;width:min(640px,100vw);background:var(--panel);border-left:1px solid var(--line);box-shadow:var(--shadow-pop,-16px 0 50px rgba(0,0,0,.35));transform:translateX(24px);opacity:0;transition:transform .2s ease,opacity .18s ease;display:flex;flex-direction:column}
    .erp-ov.on .erp-drawer{transform:none;opacity:1}
    .erp-modal{position:absolute;top:50%;left:50%;transform:translate(-50%,-48%);width:min(540px,94vw);max-height:88vh;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-pop,0 24px 60px rgba(0,0,0,.45));display:flex;flex-direction:column;opacity:0;transition:transform .18s ease,opacity .16s ease}
    .erp-ov.on .erp-modal{transform:translate(-50%,-50%);opacity:1}
    .erp-modal.wide{width:min(820px,96vw)}
    .erp-modal.sm{width:min(440px,94vw)}
    .erp-dh{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line);flex-shrink:0}
    .erp-dh h3{font-size:16px;font-weight:700;color:var(--ink);margin:0}
    .erp-dh .sub{font-size:12px;color:var(--faint);margin-top:2px}
    .erp-x{width:32px;height:32px;border-radius:7px;background:transparent;border:1px solid transparent;color:var(--dim);font-size:20px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .erp-x:hover{background:var(--hi);color:var(--ink)}
    .erp-x:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .erp-dbody{flex:1;overflow-y:auto;padding:16px 18px}
    .erp-dbody > p{font-size:13px;line-height:1.55;color:var(--ink);margin:0 0 12px}
    .erp-dfoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--line);flex-shrink:0;background:var(--panel2);border-radius:0 0 12px 12px}
    .erp-drawer .erp-dfoot{border-radius:0}
    .erp-dfoot .msg{margin-right:auto;font-size:12px;font-weight:600}

    /* form */
    .erp-fgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px 14px}
    .erp-fgrid .full{grid-column:1/-1}
    .erp-flbl{display:block;font-size:11.5px;color:var(--dim);font-weight:600;margin-bottom:5px}
    .erp-flbl .req{color:var(--red)}
    .erp-fin,.erp-fsel,.erp-fta{width:100%;box-sizing:border-box;height:34px;background:var(--erp-fb);border:1px solid var(--erp-fl);border-radius:var(--erp-r-sm);color:var(--ink);font-size:13px;padding:0 10px;outline:none;font-family:inherit}
    .erp-fta{height:auto;resize:vertical;min-height:64px;padding:8px 10px;line-height:1.5}
    .erp-fin:focus,.erp-fsel:focus,.erp-fta:focus{border-color:var(--accent);box-shadow:var(--erp-ring)}
    .erp-fin[aria-invalid="true"],.erp-fsel[aria-invalid="true"]{border-color:var(--red)}
    .erp-fin:disabled{background:var(--panel2);color:var(--faint)}
    .erp-fhint{font-size:11px;color:var(--faint);margin-top:4px;line-height:1.4}
    /* the section label's icon had no size rule, so in the user drawer it
       rendered as a full-width silhouette that pushed the form off-screen */
    .erp-fsec{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);font-weight:700;margin:18px 0 2px;padding-bottom:6px;border-bottom:1px solid var(--line);grid-column:1/-1;display:flex;align-items:center;gap:7px}
    .erp-fsec svg{width:14px;height:14px;stroke:var(--accent);fill:none;stroke-width:2;flex-shrink:0}
    .erp-fsec:first-child{margin-top:0}
    .erp-fset{border:1px solid var(--line);border-radius:var(--erp-r-sm);padding:10px 12px;margin:0}

    .erp-combo{position:relative}
    .erp-combo-list{position:absolute;left:0;right:0;top:calc(100% + 4px);background:var(--panel);border:1px solid var(--line);border-radius:var(--erp-r-sm);box-shadow:var(--shadow-pop,0 14px 36px rgba(0,0,0,.35));z-index:5;max-height:240px;overflow-y:auto;display:none}
    .erp-combo-list.on{display:block}
    .erp-combo-list .it{padding:8px 11px;font-size:12.5px;color:var(--ink);cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px}
    .erp-combo-list .it:hover,.erp-combo-list .it.hi{background:var(--hi)}
    .erp-combo-list .it .meta{font-size:11px;color:var(--faint)}
    .erp-combo-list .new{color:var(--accent);font-weight:600;border-top:1px solid var(--line)}
    .erp-combo-list .new svg{width:14px;height:14px;stroke:var(--accent);fill:none;stroke-width:2;vertical-align:-2px;margin-right:5px}

    .erp-avup{display:flex;align-items:center;gap:12px}
    .erp-avbig{width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:17px;font-weight:700;flex-shrink:0;background-size:cover;background-position:center;cursor:pointer;position:relative;overflow:hidden;border:0;padding:0;font-family:inherit}
    .erp-avbig:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .erp-avbig .ov{position:absolute;inset:0;background:rgba(0,0,0,.45);color:#fff;font-size:9px;display:none;align-items:center;justify-content:center;text-align:center;font-weight:600}
    .erp-avbig:hover .ov,.erp-avbig:focus-visible .ov{display:flex}

    .erp-toggle{display:inline-flex;align-items:center;cursor:pointer;gap:9px;position:relative}
    .erp-toggle input{position:absolute;opacity:0;width:1px;height:1px}
    .erp-toggle .tk{width:34px;height:20px;border-radius:10px;background:var(--panel3);border:1px solid var(--erp-fl);position:relative;transition:background-color .15s,border-color .15s;flex-shrink:0}
    .erp-toggle .tk::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--faint);transition:transform .15s,background-color .15s}
    .erp-toggle input:checked+.tk{background:var(--accent);border-color:var(--accent)}
    .erp-toggle input:checked+.tk::after{transform:translateX(14px);background:#fff}
    .erp-toggle input:focus-visible+.tk{box-shadow:var(--erp-ring)}
    .erp-toggle .tl{font-size:12.5px;color:var(--ink);font-weight:600}

    .erp-pwbar{height:4px;border-radius:2px;background:var(--panel3);margin-top:6px;overflow:hidden}
    .erp-pwbar i{display:block;height:100%;width:0;border-radius:2px;transition:width .2s}

    /* permission matrix */
    .erp-matrix{width:100%;border-collapse:collapse;font-size:12px}
    .erp-matrix th,.erp-matrix td{border-bottom:1px solid var(--line2,var(--line));padding:0;text-align:center}
    .erp-matrix thead th{background:var(--th-bg,var(--panel2));color:var(--th-ink,var(--faint));font-size:10px;text-transform:uppercase;letter-spacing:.4px;font-weight:700;padding:0 4px;height:34px;position:sticky;top:0;z-index:2;border-bottom:1px solid var(--line)}
    .erp-matrix thead th.mod{text-align:left;padding-left:12px;min-width:160px;left:0;z-index:3}
    .erp-matrix tbody td.mod{text-align:left;padding:6px 12px;color:var(--ink);font-weight:600;background:var(--panel);position:sticky;left:0;z-index:1}
    .erp-matrix .cell{width:100%;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .1s}
    .erp-matrix .cell:hover{background:var(--hi)}
    .erp-matrix .cb{width:15px;height:15px;border-radius:4px;border:1.5px solid var(--erp-fl);display:flex;align-items:center;justify-content:center}
    .erp-matrix .cell.on .cb{background:var(--accent);border-color:var(--accent)}
    .erp-matrix .cell.on .cb svg{width:10px;height:10px;stroke:#fff;stroke-width:3;fill:none}
    .erp-matrix .cell.ovr .cb{box-shadow:0 0 0 2px var(--accent2)}
    .erp-matrix tbody tr:hover td.mod{background:var(--hi)}
    .erp-colh{cursor:pointer}
    .erp-colh:hover{color:var(--accent)}

    .erp-leg{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--faint);margin-top:10px}
    .erp-leg span{display:flex;align-items:center;gap:6px}
    .erp-leg i{width:12px;height:12px;border-radius:3px;display:inline-block}

    /* workflow */
    .erp-flow{display:flex;align-items:center;gap:0;flex-wrap:wrap;row-gap:10px}
    .erp-step{display:flex;align-items:center}
    .erp-stepbox{background:var(--panel2);border:1px solid var(--line);border-radius:var(--erp-r-sm);padding:8px 12px;min-width:120px;position:relative}
    .erp-stepbox .lv{font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--faint);margin-bottom:2px}
    .erp-stepbox .nm{font-size:12.5px;font-weight:700;color:var(--ink)}
    .erp-stepbox .dp{font-size:11px;color:var(--dim);margin-top:1px;font-variant-numeric:tabular-nums}
    .erp-stepbox .rm{position:absolute;top:-8px;right:-8px;width:22px;height:22px;border-radius:50%;background:var(--panel);border:1px solid var(--line);color:var(--dim);font-size:13px;cursor:pointer;display:none;align-items:center;justify-content:center}
    .erp-stepbox:hover .rm,.erp-stepbox .rm:focus-visible{display:flex}
    .erp-stepbox .rm:hover{border-color:var(--red);color:var(--red)}
    .erp-arrow{width:26px;display:flex;align-items:center;justify-content:center;color:var(--faint)}
    .erp-arrow svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2}

    /* org tree */
    .erp-tree{font-size:12.5px}
    .erp-trow{display:flex;align-items:center;gap:9px;padding:5px 8px;border-radius:6px;cursor:default;min-height:32px}
    .erp-trow:hover{background:var(--hi)}
    .erp-tcaret{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;color:var(--dim);cursor:pointer;user-select:none;flex-shrink:0;border-radius:4px;background:none;border:0;font:inherit;padding:0}
    .erp-tcaret:hover{background:var(--panel3)}
    .erp-tkids{margin-left:18px;border-left:1px solid var(--line);padding-left:10px}
    .erp-tkind{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:0 7px;border-radius:9px;line-height:17px}

    .erp-act-feed{display:flex;flex-direction:column}
    .erp-act{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--line2,var(--line));align-items:flex-start}
    .erp-act:last-child{border-bottom:none}
    .erp-act .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:6px;background:var(--faint)}
    .erp-act .dot svg{display:none}
    .erp-act .txt{flex:1;min-width:0}
    .erp-act .txt .a{font-size:12.5px;color:var(--ink);font-weight:600}
    .erp-act .txt .m{font-size:11.5px;color:var(--faint);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .erp-act .tm{font-size:11px;color:var(--faint);white-space:nowrap;font-variant-numeric:tabular-nums}

    .erp-notif{display:flex;gap:11px;padding:11px 14px;border-bottom:1px solid var(--line2,var(--line));cursor:pointer;transition:background-color .1s;align-items:flex-start}
    .erp-notif:last-child{border-bottom:none}
    .erp-notif:hover{background:var(--hi)}
    .erp-notif:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
    .erp-notif.unread{background:rgba(var(--accent-rgb,91,147,245),.05)}
    .erp-notif .nd{width:28px;height:28px;border-radius:7px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
    .erp-notif .nd svg{width:15px;height:15px;fill:none;stroke-width:2}
    .erp-notif .ttl{font-size:12.5px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:7px}
    .erp-notif .ttl .ud{width:7px;height:7px;border-radius:50%;background:var(--accent)}
    .erp-notif .ms{font-size:12px;color:var(--dim);margin-top:1px}
    .erp-notif .tm{font-size:11px;color:var(--faint);margin-top:2px}

    /* command palette */
    #erpCmd{position:fixed;inset:0;z-index:100030;background:var(--scrim,rgba(8,10,14,.55));display:none;align-items:flex-start;justify-content:center;padding-top:12vh;font-family:'Archivo',sans-serif}
    #erpCmd.on{display:flex}
    #erpCmd .box{width:min(560px,94vw);background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-pop,0 24px 60px rgba(0,0,0,.5));overflow:hidden}
    #erpCmd .ci{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line)}
    #erpCmd .ci svg{width:16px;height:16px;stroke:var(--faint);fill:none;stroke-width:2}
    #erpCmd input{flex:1;background:none;border:none;outline:none;color:var(--ink);font-size:14px;font-family:inherit}
    #erpCmd .res{max-height:54vh;overflow-y:auto;padding:6px}
    #erpCmd .cg{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--faint);font-weight:700;padding:8px 10px 4px}
    #erpCmd .ci-row{display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;border-radius:7px;cursor:pointer;color:var(--ink);font-size:13px}
    #erpCmd .ci-row svg{width:15px;height:15px;stroke:var(--faint);fill:none;stroke-width:1.9;flex-shrink:0}
    #erpCmd .ci-row .meta{margin-left:auto;font-size:11px;color:var(--faint)}
    #erpCmd .ci-row.hi,#erpCmd .ci-row:hover{background:rgba(var(--accent-rgb,91,147,245),.10);color:var(--accent)}
    #erpCmd .ci-row.hi svg,#erpCmd .ci-row:hover svg{stroke:var(--accent)}

    .erp-deny{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;color:var(--dim);gap:10px;padding:20px}
    .erp-deny svg{width:40px;height:40px;stroke:var(--faint);fill:none;stroke-width:1.5}
    .erp-deny h2{font-size:17px;color:var(--ink);margin:0}

    .erp-kv{display:flex;flex-direction:column}
    .erp-kv .r{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:8px 0;border-bottom:1px solid var(--line2,var(--line));font-size:12.5px}
    .erp-kv .r:last-child{border-bottom:none}
    .erp-kv .r .k{color:var(--dim)} .erp-kv .r .v{color:var(--ink);font-weight:600;text-align:right}

    .erp-seg{display:inline-flex;background:var(--panel2);border:1px solid var(--erp-fl);border-radius:var(--erp-r-sm);padding:2px}
    .erp-seg button{background:none;border:none;color:var(--dim);font-size:12px;font-weight:600;height:28px;padding:0 12px;border-radius:5px;cursor:pointer;font-family:inherit}
    .erp-seg button.on{background:var(--panel);color:var(--accent);box-shadow:0 0 0 1px var(--line)}
    .erp-seg button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}

    .erp-bar2{height:6px;border-radius:3px;background:var(--panel3);overflow:hidden}
    .erp-bar2 i{display:block;height:100%;border-radius:3px}

    /* narrow screens: the admin nav becomes a scrolling tab strip above the page */
    @media (max-width:860px){
      .erp-wrap{flex-direction:column}
      .erp-side,.erp-side.collapsed{width:auto;border-right:0;border-bottom:1px solid var(--line);flex-direction:row;align-items:center}
      .erp-side-head{border-bottom:0;padding:6px 8px;flex-shrink:0}
      .erp-side-head .t,.erp-findbtn .lbl,.erp-findbtn .kbd,.erp-side-foot{display:none}
      .erp-findbtn{width:32px;justify-content:center;padding:0}
      .erp-nav{display:flex;overflow-x:auto;overflow-y:hidden;padding:6px 8px;gap:2px;scrollbar-width:thin}
      .erp-nav-sec{display:none!important}
      .erp-nav a{flex-shrink:0;justify-content:flex-start!important;padding:0 10px!important}
      .erp-nav a .erp-nav-lbl{display:inline!important}
      .erp-nav a .pin,.erp-nav a .cnt:not(.hot),.erp-nav a .ext{display:none}
      .erp-nav a.on::before{display:none}
      .erp-body{padding:14px}
      .erp-fgrid{grid-template-columns:1fr}
      .erp-field .erp-input{min-width:0;width:100%}
      .erp-toolbar > .erp-field{flex:1 1 100%}
      .erp-select{max-width:none;flex:1 1 140px}
    }
    `;
    document.head.appendChild(s);
  }

  /* ════════════════════════════════════════════════════════════════════
     ICONS
     ════════════════════════════════════════════════════════════════════ */
  const ICON = {
    dashboard: '<path d="M3 13h8V3H3zM13 21h8V3h-8zM3 21h8v-6H3z"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 11.2a3 3 0 0 0 0-6M21 20a5 5 0 0 0-3.5-4.8"/>',
    user: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    desig: '<path d="M12 3 4 7v6c0 4.5 3.5 7 8 8 4.5-1 8-3.5 8-8V7z"/><path d="M9.2 12l1.9 1.9 3.7-4"/>',
    dept: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    perm: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    project: '<path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H3z"/>',
    flow: '<rect x="4" y="3" width="7" height="6" rx="1.5"/><rect x="13" y="15" width="7" height="6" rx="1.5"/><path d="M7.5 9v4.5a2 2 0 0 0 2 2H13"/>',
    security: '<path d="M12 3 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6z"/><circle cx="12" cy="11" r="2.2"/><path d="M12 13.2V16"/>',
    audit: '<path d="M9 3h6l4 4v14H5V3z"/><path d="M9 12h6M9 16h6M9 8h3"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
    org: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2h12v2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12 21 2M18 5l2 2M15 8l2 2"/>',
    power: '<path d="M12 3v9M6.5 7a8 8 0 1 0 11 0"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    dots: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    chevL: '<path d="M15 18l-6-6 6-6"/>',
    chevR: '<path d="M9 18l6-6-6-6"/>',
    /* was an unterminated path (never rendered until used) — sliders icon instead */
    settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'
  };
  const ic = (k, cls) => `<svg viewBox="0 0 24 24" ${cls ? 'class="' + cls + '"' : ''}>${ICON[k] || ''}</svg>`;

  /* ════════════════════════════════════════════════════════════════════
     FORMAT HELPERS
     ════════════════════════════════════════════════════════════════════ */
  const fmtDate = (t) => t ? new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const fmtDT = (t) => t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
  function ago(t) { if (!t) return 'never'; const s = (Date.now() - t) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; }
  function inr(n) { if (!n) return '₹0'; if (n >= 1e7) return '₹' + (n / 1e7).toFixed(n % 1e7 ? 2 : 0) + ' Cr'; if (n >= 1e5) return '₹' + (n / 1e5).toFixed(n % 1e5 ? 2 : 0) + ' L'; return '₹' + n.toLocaleString('en-IN'); }
  function inrFull(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }
  function avatar(u, size) {
    const s = size || 30;
    const style = u.photo ? `background-image:url('${u.photo}')` : `background:${u.avatarColor || 'var(--accent)'}`;
    return `<div class="erp-av" style="width:${s}px;height:${s}px;font-size:${Math.round(s / 2.6)}px;${style}">${u.photo ? '' : (u.initials || (u.name || '?').slice(0, 1).toUpperCase())}</div>`;
  }
  function statusBadge(st) {
    /* compact badge: one dot (CSS) + the label, so status is never colour alone;
       green / amber / red are kept for genuine states only */
    const s = STATUS[st] || STATUS.inactive;
    const tone = { active: 'ok', suspended: 'warn', pending: 'warn', locked: 'bad' }[st] || 'mute';
    return `<span class="erp-badge ${tone}">${s.label}</span>`;
  }
  function desigTag(id) {
    const d = desigById(id); if (!d) return '<span style="color:var(--faint)">—</span>';
    return `<span class="erp-tag" title="${esc(deptName(d.departmentId))}">${esc(d.name)}</span>`;
  }

  /* ════════════════════════════════════════════════════════════════════
     STATE + ROUTER
     ════════════════════════════════════════════════════════════════════ */
  /* Grouped by purpose. Entries with `id` are admin sections; `act` runs an
     existing dialog; `ext` opens an existing app module (via the shell's own
     router). Nothing here is a new feature — only a place to find it. */
  const NAV = [
    { sec: 'Overview' },
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { sec: 'Users & Access' },
    { id: 'users', label: 'Users', icon: 'users', cnt: () => users().length },
    { act: 'roleAccess', label: 'Role Access', icon: 'key', tip: 'Sign-in roles and what each role may do — this is what the app enforces' },
    { id: 'designations', label: 'Designations', icon: 'desig', cnt: () => desigs().length },
    { id: 'permissions', label: 'Designation Matrix', icon: 'perm' },
    { id: 'workflow', label: 'Approval & Limits', icon: 'flow' },
    { id: 'security', label: 'Security Policy', icon: 'security' },
    { sec: 'Organisation & Data' },
    { id: 'departments', label: 'Departments', icon: 'dept', cnt: () => depts().length },
    { id: 'organization', label: 'Organization', icon: 'org' },
    { id: 'projects', label: 'Projects', icon: 'project', cnt: () => projects().length },
    { ext: 'bmaster', label: 'BOQ Master', icon: 'audit', tip: 'Opens the BOQ Master library' },
    { ext: 'vmaster', label: 'Vendor Master', icon: 'user', tip: 'Opens the Vendor Master' },
    { id: 'system', label: 'System & Data', icon: 'settings' },
    { sec: 'Audit & Maintenance' },
    { id: 'audit', label: 'Audit Trail', icon: 'audit' },
    { id: 'notifications', label: 'Notifications', icon: 'bell', cnt: () => notifs().filter(n => !n.read).length, hot: true },
    { ext: 'del', label: 'Deleted Items', icon: 'trash', tip: 'Opens Deleted Items' }
  ];
  const TITLES = { dashboard: 'Administration', users: 'Users', designations: 'Designations', departments: 'Departments', organization: 'Organization', permissions: 'Designation Matrix', projects: 'Projects', workflow: 'Approval & Limits', security: 'Security Policy', audit: 'Audit Trail', notifications: 'Notifications', system: 'System & Data' };

  const S = {
    view: 'dashboard',
    rendered: false,
    collapsed: load('erp_side_collapsed', false),
    pinned: load('erp_pinned', []),
    u: { q: '', dept: '', desig: '', status: '', sort: 'name', dir: 1, page: 1, per: 8, sel: [] },
    permDesig: null,
    projUser: null,
    auditQ: '', auditMod: '',
    notifFilter: 'all'
  };

  function go(view) { S.view = view; renderMain(); }

  /* ════════════════════════════════════════════════════════════════════
     SHELL
     ════════════════════════════════════════════════════════════════════ */
  function renderShell() {
    const root = document.getElementById('admin');
    if (!root) return;
    /* One header for the whole workspace: the app's top bar already shows
       "Administration / <section>", so the old second bar (breadcrumb +
       search + bell) is gone. Search moved into the side panel; unread
       notifications show as a count on the Notifications item. */
    root.innerHTML = `
      <div class="erp-wrap">
        <aside class="erp-side ${S.collapsed ? 'collapsed' : ''}" id="erpSide" aria-label="Administration sections">
          <div class="erp-side-head">
            <div class="t">${ic('security')}<b>Administration<span>Users, access &amp; settings</span></b></div>
            <button type="button" class="erp-findbtn" id="erpGlobal" title="Search sections, users and actions (Ctrl/⌘ K)">${ic('search')}<span class="lbl">Search admin…</span><span class="kbd">⌘K</span></button>
          </div>
          <nav class="erp-nav" id="erpNav"></nav>
          <div class="erp-side-foot">
            <button type="button" class="erp-collapse" id="erpCollapse" aria-expanded="${S.collapsed ? 'false' : 'true'}">${ic(S.collapsed ? 'chevR' : 'chevL')}<span class="txt">Collapse</span></button>
          </div>
        </aside>
        <div class="erp-main">
          <div class="erp-body" id="erpBody"></div>
        </div>
      </div>`;
    document.getElementById('erpCollapse').onclick = () => { S.collapsed = !S.collapsed; save('erp_side_collapsed', S.collapsed); document.getElementById('erpSide').classList.toggle('collapsed', S.collapsed); const b = document.getElementById('erpCollapse'); b.innerHTML = ic(S.collapsed ? 'chevR' : 'chevL') + '<span class="txt">Collapse</span>'; b.setAttribute('aria-expanded', S.collapsed ? 'false' : 'true'); };
    document.getElementById('erpGlobal').onclick = openCmd;
    renderNav();
    refreshBadge();
  }
  function navAct(it) {
    if (it.act === 'roleAccess') {
      /* the existing User Management dialog (user-chip menu) — its role matrix is the one sign-in enforces */
      try { if (window.Auth && typeof window.Auth._users === 'function') window.Auth._users(); }
      catch (e) { console.error('[admin] Role Access', e); }
      return;
    }
    if (it.ext && window.PShell) window.PShell.go(it.ext);
  }
  function renderNav() {
    const nav = document.getElementById('erpNav'); if (!nav) return;
    let h = '';
    // pinned section
    if (S.pinned.length) {
      h += `<div class="erp-nav-sec">Pinned</div>`;
      S.pinned.forEach(id => { const it = NAV.find(n => n.id === id); if (it) h += navLink(it, true); });
    }
    NAV.forEach(it => {
      if (it.sec) { h += `<div class="erp-nav-sec">${it.sec}</div>`; return; }
      h += navLink(it, false);
    });
    nav.innerHTML = h;
    nav.querySelectorAll('a[data-v]').forEach(a => a.onclick = (e) => { e.preventDefault(); if (e.target.closest('.pin')) return; go(a.dataset.v); });
    nav.querySelectorAll('a[data-x]').forEach(a => a.onclick = (e) => { e.preventDefault(); const it = NAV.find(n => (n.act || n.ext) === a.dataset.x); if (it) navAct(it); });
    nav.querySelectorAll('.pin').forEach(p => p.onclick = (e) => { e.preventDefault(); e.stopPropagation(); togglePin(p.dataset.pin); });
  }
  function navLink(it, isPinned) {
    if (it.act || it.ext) {
      return `<a href="#" data-x="${it.act || it.ext}" title="${esc(it.tip || it.label)}">${ic(it.icon)}<span class="erp-nav-lbl">${esc(it.label)}</span>${it.ext ? '<span class="ext" aria-hidden="true">↗</span>' : ''}</a>`;
    }
    const n = it.cnt ? it.cnt() : 0;
    const cnt = it.cnt && (n || !it.hot) ? `<span class="cnt${it.hot && n ? ' hot' : ''}"${it.hot ? ` aria-label="${n} unread"` : ''}>${n}</span>` : '';
    const pinned = S.pinned.includes(it.id);
    const pin = isPinned || it.cnt ? '' : `<span class="pin ${pinned ? 'on' : ''}" data-pin="${it.id}" title="${pinned ? 'Unpin' : 'Pin to top'}" role="button" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(it.label)}">${pinned ? '★' : '☆'}</span>`;
    const on = S.view === it.id;
    return `<a href="#" data-v="${it.id}" class="${on ? 'on' : ''}"${on ? ' aria-current="page"' : ''} title="${esc(it.label)}">${ic(it.icon)}<span class="erp-nav-lbl">${esc(it.label)}</span>${cnt || pin}</a>`;
  }
  function togglePin(id) { const i = S.pinned.indexOf(id); if (i >= 0) S.pinned.splice(i, 1); else S.pinned.push(id); save('erp_pinned', S.pinned); renderNav(); }

  let _lastRenderedView = null;
  function renderMain() {
    if (!document.getElementById('erpBody')) renderShell();
    // active nav
    document.querySelectorAll('#erpNav a[data-v]').forEach(a => { const on = a.dataset.v === S.view; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const body = document.getElementById('erpBody');
    if (!canAdmin()) { body.parentElement.innerHTML = denyHTML(); return; }
    const fn = VIEWS[S.view] || VIEWS.dashboard;
    body.innerHTML = '<div class="erp-page">' + fn() + '</div>';
    // Fade the content in only when actually switching sections — not on every
    // in-place re-render after a save/toggle, which would flicker on rapid clicks.
    if (S.view !== _lastRenderedView) {
      body.classList.remove('erp-fade-in'); void body.offsetWidth; body.classList.add('erp-fade-in');
      _lastRenderedView = S.view;
    }
    if (BIND[S.view]) BIND[S.view]();
    body.scrollTop = 0;
  }
  function denyHTML() {
    return `<div class="erp-deny">${ic('lock')}<h2>Administrator access required</h2><div style="max-width:340px;font-size:13px">Your account does not have permission to manage users, roles, or system settings. Contact your System Administrator.</div></div>`;
  }

  /* placeholder maps, filled below */
  const VIEWS = {};
  const BIND = {};

  /* ════════════════════════════════════════════════════════════════════
     DASHBOARD
     ════════════════════════════════════════════════════════════════════ */
  VIEWS.dashboard = function () {
    /* Every figure here is counted from data the app already holds — no
       estimates. (This used to add a hard-coded +3 to "Pending Approvals" and
       showed "Online now" / "Today's logins" from this browser's local
       session list, which is always empty once sign-in is server-side.) */
    const u = users();
    const by = (k) => u.filter(x => (x.status || 'active') === k).length;
    const active = by('active'), locked = by('locked'), pending = by('pending');
    const inactive = u.length - active;
    const pr = projects(), prOpen = pr.filter(p => p.status !== 'inactive').length;
    const lib = (typeof CATALOG !== 'undefined' && CATALOG) ? CATALOG.length : null;
    const comp = (typeof COMP !== 'undefined' && COMP) ? COMP.length : null;
    let vendors = null; try { if (window.QM && typeof window.QM.metrics === 'function') vendors = window.QM.metrics().vendorsOnFile; } catch (e) {}
    const num = (n) => n == null ? '—' : Number(n).toLocaleString('en-IN');
    const tile = (l, n, d, go, ext) => `<button type="button" class="erp-tile" ${ext ? `onclick="PShell.go('${ext}')"` : `onclick="ERP.go('${go}')"`}><div class="l">${l}</div><div class="n">${n}</div>${d ? `<div class="d">${d}</div>` : ''}</button>`;
    const userDetail = [active + ' active', inactive ? inactive + ' inactive' : '', locked ? locked + ' locked' : '', pending ? pending + ' pending' : ''].filter(Boolean).join(' · ');

    const acts = audit().slice(0, 6).map(a => `<div class="erp-act"><span class="dot" aria-hidden="true"></span><div class="txt"><div class="a">${esc(a.action)}${a.target ? ' · ' + esc(a.target) : ''}</div><div class="m">${esc(a.module || '')}${a.admin ? ' · by ' + esc(a.admin) : ''}</div></div><div class="tm">${ago(a.ts)}</div></div>`).join('');

    /* the admin modules, grouped the same way as the side navigation */
    const DESC = {
      users: 'Accounts, status, password resets', roleAccess: 'What each sign-in role may do (enforced)',
      designations: 'Job titles, hierarchy and limits', permissions: 'Reference permissions per designation',
      workflow: 'Approval chains and ₹ limits', security: 'Password and session policy',
      departments: 'Department master', organization: 'Company › branch › department tree',
      projects: 'Project master and user access', bmaster: 'Item library and rate history',
      vmaster: 'Contractor and supplier records', system: 'Backup, import, theme, AI provider',
      audit: 'Who changed what, and when', notifications: 'Administrative alerts', del: 'Restore soft-deleted records'
    };
    let mods = '', sec = '';
    NAV.forEach(it => {
      if (it.sec) { sec = it.sec === 'Overview' ? '' : it.sec; if (sec) mods += `<div class="erp-modgrp" style="grid-column:1/-1">${esc(sec)}</div>`; return; }
      if (!sec) return;
      const key = it.id || it.act || it.ext;
      const click = it.id ? `ERP.go('${it.id}')` : it.ext ? `PShell.go('${it.ext}')` : `ERP._navAct('${it.act}')`;
      mods += `<button type="button" class="erp-mod" onclick="${click}">${ic(it.icon)}<div><b>${esc(it.label)}${it.ext ? ' ↗' : ''}</b><span>${esc(DESC[key] || '')}</span></div></button>`;
    });

    const server = !!(window.TSApi && window.TSApi.active && window.TSApi.session && window.CloudflareAPI);
    const pol = policy(), lic = pol.license;
    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">Administration</h1><div class="erp-sub">Users, access, organisation data and audit for the Tendering System.</div></div>
        <div class="acts"><button class="erp-btn" onclick="ERP.go('audit')">${ic('audit')}Audit trail</button><button class="erp-btn primary" onclick="ERP.addUser()">${ic('plus')}Add user</button></div></div>
      <div class="erp-tiles">
        ${tile('Users', num(u.length), userDetail, 'users')}
        ${tile('Projects', num(pr.length), prOpen + ' active', 'projects')}
        ${tile('BOQ library', num(lib), comp != null ? num(comp) + ' multi-vendor items' : '', '', 'bmaster')}
        ${tile('Vendors', num(vendors), 'on file', '', 'vmaster')}
        ${tile('Designations', num(desigs().length), depts().length + ' departments', 'designations')}
      </div>
      <div class="erp-grid2">
        <div class="erp-card"><div class="erp-card-head"><div class="ttl">Admin modules</div></div>
          <div class="erp-card-body"><div class="erp-mods">${mods}</div></div></div>
        <div>
          <div class="erp-card"><div class="erp-card-head"><div class="ttl">Recent activity</div><button class="erp-btn sm ghost" onclick="ERP.go('audit')">View all</button></div>
            <div class="erp-card-body" style="padding:4px 14px">${acts ? `<div class="erp-act-feed">${acts}</div>` : `<div class="erp-empty"><b>No activity recorded yet</b>Changes made in Administration are listed here.</div>`}</div></div>
          <div class="erp-card"><div class="erp-card-head"><div class="ttl">Status</div></div>
            <div class="erp-card-body erp-kv">
              <div class="r"><span class="k">User accounts &amp; sign-in</span><span class="v">${server ? 'Server' : 'This browser only'}</span></div>
              <div class="r"><span class="k">Admin master data</span><span class="v">This browser</span></div>
              <div class="r"><span class="k">Session limits</span><span class="v">${server ? '30 min idle · 12 h max' : (pol.sessionTimeout || 30) + ' min idle'}</span></div>
              <div class="r"><span class="k">Min. password length</span><span class="v">${pol.minLen || 8} characters</span></div>
              ${lic && lic.total ? `<div class="r"><span class="k">Licensed seats</span><span class="v">${u.filter(x => x.status !== 'archived').length} of ${lic.total} used</span></div>` : ''}
            </div></div>
        </div>
      </div>`;
  };
  function greeting() { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; }

  // expose minimal API early so inline handlers in dashboard work after assignment below
  window.ERP = window.ERP || {};

  /* The remaining views (users, designations, departments, permissions, projects,
     workflow, security, audit, notifications, organization) + modals + command
     palette are defined in erp-admin-2.js style continuation below. */

  /* ════════════════════════════════════════════════════════════════════
     PUBLIC API + BOOT
     ════════════════════════════════════════════════════════════════════ */
  const api = {
    go, addUser: () => {}, _seedReady: false,
    _navAct: (k) => { const it = NAV.find(n => (n.act || n.ext) === k); if (it) navAct(it); },
    open: async function () {
      injectCSS();
      if (!this._seedReady) { await seed(); this._seedReady = true; }
      if (!S.rendered) { renderShell(); S.rendered = true; }
      renderMain();
    }
  };
  // merge into any early stub
  Object.assign(window.ERP, api);

  // wire the nav button (existing setMode shows #admin; we fill it)
  function wire() {
    const btn = document.getElementById('navAdminBtn');
    if (btn) btn.addEventListener('click', () => {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('on'));
      const av = document.getElementById('admin'); if (av) av.classList.add('on');
      document.querySelectorAll('#modes button').forEach(b => b.classList.remove('on'));
      btn.classList.add('active');
      window.ERP.open();
    });
    // drop the gear highlight when a primary mode tab is chosen
    document.querySelectorAll('#modes button').forEach(b => b.addEventListener('click', () => { if (btn) btn.classList.remove('active'); }));
    // Ctrl/Cmd+K opens command palette only while admin view is active
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        const adminOn = document.getElementById('admin') && document.getElementById('admin').classList.contains('on');
        if (adminOn) { e.preventDefault(); e.stopPropagation(); openCmd(); }
      }
    }, true);
    // pre-seed silently so dashboard counts are ready & login users exist
    seed().then(() => { window.ERP._seedReady = true; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  /* command palette + remaining views are attached by the continuation file */
  window.__ERP_INTERNAL = { S, NAV, TITLES, VIEWS, BIND, load, save, K, esc, ic, ICON, ACTIONS, STATUS, users, setUsers, depts, desigs, modules, projects, branches, companies, audit, notifs, flows, policy, settings, deptName, desigById, desigName, branchName, companyName, userById, userName, effPerm, logAudit, notify, refreshBadge, hash, rndSalt, uid, fmtDate, fmtDT, ago, inr, inrFull, avatar, statusBadge, desigTag, ensureModule, go, renderMain, renderNav, renderShell, canAdmin, currentName, myIP, browserName, osName };
  function openCmd() { if (window.__ERP_openCmd) window.__ERP_openCmd(); }
})();
