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
  function myIP() { let s = settings(); if (!s.ip) { s.ip = '10.20.' + (Math.floor(Math.random() * 40) + 10) + '.' + (Math.floor(Math.random() * 200) + 20); save(K.settings, s); } return s.ip; }
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
  function refreshBadge() {
    const dot = document.getElementById('erpBellDot');
    const unread = notifs().filter(n => !n.read).length;
    if (dot) { dot.style.display = unread ? 'flex' : 'none'; dot.textContent = unread > 9 ? '9+' : unread; }
  }

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

    // seed audit + notifications
    const aud = [];
    const sampleAudit = [
      ['Administration', 'User Created', 'Priya Verma', '', 'QS Engineer · QS & Contracts'],
      ['Administration', 'Permission Modified', 'Priya Verma', 'BOQ Master: Delete OFF', 'BOQ Master: Delete ON'],
      ['Enquiry', 'Tender Approved', 'ENQ/RDBT/2026/014', 'Pending', 'Approved'],
      ['Administration', 'Account Locked', 'Sandeep Yadav', 'Active', 'Locked — Multiple failed login attempts'],
      ['Administration', 'Login Success', 'Rahul Sharma', '', ''],
      ['Administration', 'Login Failure', 'unknown', '', 'Invalid password'],
      ['Work Order', 'Work Order Issued', 'WO/ARNY/2026/008', '', '₹42,50,000'],
      ['Administration', 'Platform Access Revoked', 'Ritu Agarwal', 'Enabled', 'Disabled'],
      ['Vendor', 'Vendor Registered', 'Steelcon Infra Pvt Ltd', '', 'Active'],
      ['Administration', 'Role Changed', 'Arjun Das', 'QS Engineer', 'Senior QS']
    ];
    sampleAudit.forEach((s, i) => aud.push({ id: uid('au'), ts: Date.now() - i * 1000 * 3600 * 7 - 60000, admin: i % 3 === 0 ? 'Administrator' : 'Anjali Mehra', module: s[0], action: s[1], target: s[2], oldVal: s[3], newVal: s[4], ip: '10.20.' + (12 + i) + '.30', browser: browserName(), reason: '' }));
    save(K.audit, aud);

    save(K.notif, [
      ['perm', 'Permission changed', 'Priya Verma was granted Delete on BOQ Master.', 2],
      ['lock', 'User locked', 'Sandeep Yadav locked after 5 failed login attempts.', 5],
      ['tender', 'Tender approved', 'ENQ/RDBT/2026/014 approved by Commercial Manager.', 8],
      ['boq', 'New BOQ assigned', 'Aaranya — Structural BOQ assigned to Arjun Das.', 20],
      ['vendor', 'Vendor registered', 'Steelcon Infra Pvt Ltd added to vendor master.', 26],
      ['wo', 'Work order issued', 'WO/ARNY/2026/008 issued — ₹42.5 L.', 30]
    ].map(([type, title, msg, hAgo]) => ({ id: uid('n'), ts: Date.now() - hAgo * 3600000, type, title, msg, read: hAgo > 12 })));

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
    #admin{font-family:'Archivo',sans-serif}
    .erp-wrap{display:flex;width:100%;height:100%;overflow:hidden}
    .erp-side{width:230px;flex-shrink:0;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;transition:width .18s ease}
    .erp-side.collapsed{width:58px}
    .erp-side-head{display:flex;align-items:center;gap:9px;padding:14px 16px 12px;border-bottom:1px solid var(--line);min-height:34px}
    .erp-side-head .badge{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#c9501a);display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .erp-side-head .badge svg{width:17px;height:17px;stroke:#fff;fill:none;stroke-width:2}
    .erp-side-head .t{font-size:12.5px;font-weight:800;color:var(--ink);line-height:1.1;letter-spacing:.2px}
    .erp-side-head .t span{display:block;font-size:8.5px;font-weight:600;color:var(--faint);letter-spacing:1.2px;text-transform:uppercase;margin-top:2px}
    .erp-side.collapsed .t,.erp-side.collapsed .erp-nav-lbl,.erp-side.collapsed .erp-nav-sec,.erp-side.collapsed .erp-nav .pin,.erp-side.collapsed .erp-side-foot .txt{display:none}
    .erp-nav{flex:1;overflow-y:auto;padding:8px 8px 16px}
    .erp-nav-sec{font-size:9px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--faint);padding:14px 10px 5px}
    .erp-nav a{display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:7px;color:var(--dim);font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:none;position:relative;transition:.12s;margin-bottom:1px}
    .erp-nav a svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.9;flex-shrink:0}
    .erp-nav a:hover{background:var(--hi);color:var(--ink)}
    .erp-nav a.on{background:rgba(255,106,44,.13);color:var(--accent)}
    .erp-nav a.on::before{content:'';position:absolute;left:-8px;top:7px;bottom:7px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
    .erp-nav a .pin{margin-left:auto;font-size:11px;color:var(--faint);opacity:0;transition:.12s}
    .erp-nav a:hover .pin{opacity:.7}
    .erp-nav a .pin.on{opacity:1;color:var(--accent2)}
    .erp-nav a .cnt{margin-left:auto;font-size:10px;font-family:'Spline Sans Mono',monospace;background:var(--panel3);color:var(--faint);padding:1px 7px;border-radius:10px}
    .erp-side.collapsed .erp-nav a{justify-content:center;padding:9px 0}
    .erp-side.collapsed .erp-nav a .cnt{display:none}
    .erp-side-foot{padding:9px;border-top:1px solid var(--line)}
    .erp-collapse{display:flex;align-items:center;gap:10px;width:100%;background:none;border:none;color:var(--faint);font-size:11.5px;font-weight:600;padding:7px 10px;border-radius:7px;cursor:pointer;font-family:inherit}
    .erp-collapse:hover{background:var(--hi);color:var(--ink)}
    .erp-collapse svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2}

    .erp-main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
    .erp-bar{display:flex;align-items:center;gap:14px;padding:13px 22px;border-bottom:1px solid var(--line);background:var(--bg);flex-shrink:0}
    .erp-crumb{font-size:11px;color:var(--faint);font-weight:600}
    .erp-crumb b{color:var(--ink);font-weight:700;font-size:13px}
    .erp-crumb .sep{margin:0 7px;opacity:.5}
    .erp-search{flex:1;max-width:380px;position:relative}
    .erp-search input{width:100%;box-sizing:border-box;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--ink);font-size:12.5px;padding:8px 12px 8px 34px;outline:none;font-family:inherit}
    .erp-search input:focus{border-color:var(--accent)}
    .erp-search svg{position:absolute;left:11px;top:9px;width:15px;height:15px;stroke:var(--faint);fill:none;stroke-width:2}
    .erp-search .kbd{position:absolute;right:9px;top:8px;font-size:9.5px;font-family:'Spline Sans Mono',monospace;color:var(--faint);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
    .erp-bar-sp{flex:1}
    .erp-iconbtn{position:relative;width:34px;height:34px;border-radius:8px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.12s}
    .erp-iconbtn:hover{border-color:var(--accent);color:var(--accent)}
    .erp-iconbtn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2}
    #erpBellDot{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 3px;border-radius:9px;background:var(--red);color:#fff;font-size:9px;font-weight:700;display:none;align-items:center;justify-content:center;font-family:'Spline Sans Mono',monospace}

    .erp-body{flex:1;overflow-y:auto;padding:22px}
    .erp-h{font-size:19px;font-weight:800;color:var(--ink);margin:0 0 3px}
    .erp-sub{font-size:12.5px;color:var(--faint);margin-bottom:18px}
    .erp-sec-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:18px;flex-wrap:wrap}

    /* tiles */
    .erp-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:13px;margin-bottom:22px}
    .erp-tile{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:15px 16px;position:relative;overflow:hidden}
    .erp-tile .ic{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;margin-bottom:11px}
    .erp-tile .ic svg{width:18px;height:18px;fill:none;stroke-width:2}
    .erp-tile .n{font-size:27px;font-weight:800;color:var(--ink);line-height:1;font-family:'Archivo',sans-serif}
    .erp-tile .l{font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--faint);margin-top:5px;font-weight:600}
    .erp-tile .d{font-size:10.5px;color:var(--dim);margin-top:6px}

    .erp-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
    .erp-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line)}
    .erp-card-head .ttl{font-size:13px;font-weight:700;color:var(--ink)}
    .erp-card-head .ttl span{font-size:11px;font-weight:500;color:var(--faint);margin-left:6px}
    .erp-card-body{padding:16px}
    .erp-grid2{display:grid;grid-template-columns:1.4fr 1fr;gap:16px;align-items:start}
    @media(max-width:1100px){.erp-grid2{grid-template-columns:1fr}}

    /* toolbar */
    .erp-toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:14px}
    .erp-field{position:relative}
    .erp-field>svg{position:absolute;left:10px;top:9px;width:15px;height:15px;stroke:var(--faint);fill:none;stroke-width:2;pointer-events:none}
    .erp-input,.erp-select{background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--ink);font-size:12.5px;padding:8px 11px;outline:none;font-family:inherit}
    .erp-field .erp-input{padding-left:32px;min-width:230px}
    .erp-input:focus,.erp-select:focus{border-color:var(--accent)}
    .erp-select{cursor:pointer}
    .erp-tb-sp{flex:1}
    .erp-btn{display:inline-flex;align-items:center;gap:7px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-size:12px;font-weight:600;padding:8px 13px;border-radius:8px;cursor:pointer;font-family:inherit;transition:.12s;white-space:nowrap}
    .erp-btn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2}
    .erp-btn:hover{border-color:var(--accent);color:var(--accent)}
    .erp-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
    .erp-btn.primary:hover{filter:brightness(1.08);color:#fff}
    .erp-btn.danger:hover{border-color:var(--red);color:var(--red)}
    .erp-btn.sm{padding:5px 9px;font-size:11px}
    .erp-btn.ghost{background:none}

    /* tables */
    .erp-tbl-wrap{overflow-x:auto}
    .erp-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
    .erp-tbl th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--faint);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap;background:var(--panel2);position:sticky;top:0;cursor:pointer;user-select:none}
    .erp-tbl th.nosort{cursor:default}
    .erp-tbl th .ar{color:var(--accent);margin-left:3px}
    .erp-tbl td{padding:10px 12px;border-bottom:1px solid var(--line);color:var(--dim);vertical-align:middle}
    .erp-tbl tbody tr{transition:.1s}
    .erp-tbl tbody tr:hover{background:var(--hi)}
    .erp-tbl tbody tr.sel{background:rgba(255,106,44,.07)}
    .erp-tbl .mono{font-family:'Spline Sans Mono',monospace;font-size:11px}
    .erp-tbl .nm{color:var(--ink);font-weight:600}
    .erp-cellname{display:flex;align-items:center;gap:10px}
    .erp-av{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;flex-shrink:0;overflow:hidden;background-size:cover;background-position:center}
    .erp-chk{width:15px;height:15px;cursor:pointer;accent-color:var(--accent)}

    .erp-badge{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:2px 9px;border-radius:11px}
    .erp-tag{display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:6px;background:var(--panel3);color:var(--dim)}
    .erp-pill{display:inline-block;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:2px 8px;border-radius:10px;color:#fff}

    /* row menu */
    .erp-rowmenu{position:fixed;z-index:100020;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.45);padding:5px;min-width:190px;display:none}
    .erp-rowmenu button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:none;color:var(--ink);font-size:12.5px;font-weight:500;padding:8px 11px;border-radius:7px;cursor:pointer;font-family:inherit}
    .erp-rowmenu button svg{width:15px;height:15px;stroke:var(--faint);fill:none;stroke-width:1.9}
    .erp-rowmenu button:hover{background:var(--hi)}
    .erp-rowmenu button:hover svg{stroke:var(--accent)}
    .erp-rowmenu button.danger{color:var(--red)} .erp-rowmenu button.danger svg{stroke:var(--red)}
    .erp-rowmenu button.danger:hover{background:rgba(248,113,113,.1)}
    .erp-rowmenu .sep{height:1px;background:var(--line);margin:4px}

    .erp-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 4px 2px;font-size:11.5px;color:var(--faint)}
    .erp-pager .pg{display:flex;gap:5px}
    .erp-pager .pg button{width:28px;height:28px;border-radius:7px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-size:12px;cursor:pointer;font-family:inherit}
    .erp-pager .pg button.on{background:var(--accent);border-color:var(--accent);color:#fff}
    .erp-pager .pg button:disabled{opacity:.4;cursor:default}

    .erp-bulkbar{display:flex;align-items:center;gap:10px;background:rgba(255,106,44,.1);border:1px solid rgba(255,106,44,.3);border-radius:9px;padding:8px 14px;margin-bottom:13px;font-size:12px;color:var(--ink)}
    .erp-bulkbar b{color:var(--accent)}

    .erp-empty{text-align:center;padding:44px 20px;color:var(--faint)}
    .erp-empty svg{width:40px;height:40px;stroke:var(--line);fill:none;stroke-width:1.5;margin-bottom:10px}

    /* overlays: drawer + modal */
    .erp-ov{position:fixed;inset:0;z-index:100015;background:rgba(8,10,14,.62);display:none;opacity:0;transition:opacity .16s}
    .erp-ov.on{display:block;opacity:1}
    .erp-drawer{position:absolute;top:0;right:0;height:100%;width:min(680px,96vw);background:var(--bg);border-left:1px solid var(--line);box-shadow:-16px 0 60px rgba(0,0,0,.4);transform:translateX(40px);opacity:0;transition:.2s;display:flex;flex-direction:column}
    .erp-ov.on .erp-drawer{transform:none;opacity:1}
    .erp-modal{position:absolute;top:50%;left:50%;transform:translate(-50%,-46%);width:min(560px,94vw);max-height:88vh;background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.5);display:flex;flex-direction:column;opacity:0;transition:.18s}
    .erp-ov.on .erp-modal{transform:translate(-50%,-50%);opacity:1}
    .erp-modal.wide{width:min(820px,96vw)}
    .erp-dh{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 22px;border-bottom:1px solid var(--line);flex-shrink:0}
    .erp-dh h3{font-size:15px;font-weight:800;color:var(--ink);margin:0}
    .erp-dh .sub{font-size:11.5px;color:var(--faint);margin-top:2px}
    .erp-x{width:30px;height:30px;border-radius:8px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center}
    .erp-x:hover{border-color:var(--red);color:var(--red)}
    .erp-dbody{flex:1;overflow-y:auto;padding:20px 22px}
    .erp-dfoot{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid var(--line);flex-shrink:0;background:var(--panel)}
    .erp-dfoot .msg{margin-right:auto;font-size:12px}

    /* form */
    .erp-fgrid{display:grid;grid-template-columns:1fr 1fr;gap:14px 16px}
    .erp-fgrid .full{grid-column:1/-1}
    .erp-flbl{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--faint);font-weight:700;margin-bottom:5px}
    .erp-flbl .req{color:var(--accent)}
    .erp-fin,.erp-fsel,.erp-fta{width:100%;box-sizing:border-box;background:var(--panel);border:1px solid var(--line);border-radius:8px;color:var(--ink);font-size:13px;padding:9px 11px;outline:none;font-family:inherit}
    .erp-fta{resize:vertical;min-height:62px}
    .erp-fin:focus,.erp-fsel:focus,.erp-fta:focus{border-color:var(--accent)}
    .erp-fhint{font-size:10.5px;color:var(--faint);margin-top:4px}
    .erp-fsec{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--accent);font-weight:700;margin:22px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line);grid-column:1/-1;display:flex;align-items:center;gap:8px}
    .erp-fsec:first-child{margin-top:0}

    .erp-combo{position:relative}
    .erp-combo-list{position:absolute;left:0;right:0;top:calc(100% + 4px);background:var(--panel);border:1px solid var(--line);border-radius:9px;box-shadow:0 14px 40px rgba(0,0,0,.4);z-index:5;max-height:240px;overflow-y:auto;display:none}
    .erp-combo-list.on{display:block}
    .erp-combo-list .it{padding:9px 12px;font-size:12.5px;color:var(--ink);cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px}
    .erp-combo-list .it:hover,.erp-combo-list .it.hi{background:var(--hi)}
    .erp-combo-list .it .meta{font-size:10.5px;color:var(--faint)}
    .erp-combo-list .new{color:var(--accent);font-weight:600;border-top:1px solid var(--line)}
    .erp-combo-list .new svg{width:14px;height:14px;stroke:var(--accent);fill:none;stroke-width:2;vertical-align:-2px;margin-right:5px}

    .erp-avup{display:flex;align-items:center;gap:14px}
    .erp-avbig{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;font-weight:800;flex-shrink:0;background-size:cover;background-position:center;cursor:pointer;position:relative;overflow:hidden}
    .erp-avbig .ov{position:absolute;inset:0;background:rgba(0,0,0,.45);color:#fff;font-size:9px;display:none;align-items:center;justify-content:center;text-align:center;font-weight:600}
    .erp-avbig:hover .ov{display:flex}

    .erp-toggle{display:inline-flex;align-items:center;cursor:pointer;gap:9px}
    .erp-toggle input{display:none}
    .erp-toggle .tk{width:38px;height:21px;border-radius:11px;background:var(--panel3);border:1px solid var(--line);position:relative;transition:.16s;flex-shrink:0}
    .erp-toggle .tk::after{content:'';position:absolute;top:1px;left:1px;width:17px;height:17px;border-radius:50%;background:var(--faint);transition:.16s}
    .erp-toggle input:checked+.tk{background:rgba(52,211,153,.25);border-color:var(--green)}
    .erp-toggle input:checked+.tk::after{transform:translateX(17px);background:var(--green)}
    .erp-toggle .tl{font-size:12.5px;color:var(--ink);font-weight:600}

    .erp-pwbar{height:5px;border-radius:3px;background:var(--panel3);margin-top:7px;overflow:hidden}
    .erp-pwbar i{display:block;height:100%;width:0;border-radius:3px;transition:.2s}

    /* permission matrix */
    .erp-matrix{width:100%;border-collapse:collapse;font-size:11.5px}
    .erp-matrix th,.erp-matrix td{border:1px solid var(--line);padding:0;text-align:center}
    .erp-matrix thead th{background:var(--panel2);color:var(--faint);font-size:9px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;padding:8px 4px;position:sticky;top:0;z-index:2}
    .erp-matrix thead th.mod{text-align:left;padding-left:12px;min-width:150px}
    .erp-matrix tbody td.mod{text-align:left;padding:8px 12px;color:var(--ink);font-weight:600;background:var(--panel);position:sticky;left:0;z-index:1}
    .erp-matrix .cell{width:100%;height:34px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.1s}
    .erp-matrix .cell:hover{background:var(--hi)}
    .erp-matrix .cb{width:15px;height:15px;border-radius:4px;border:1.5px solid var(--line);display:flex;align-items:center;justify-content:center}
    .erp-matrix .cell.on .cb{background:var(--green);border-color:var(--green)}
    .erp-matrix .cell.on .cb svg{width:10px;height:10px;stroke:#06281d;stroke-width:3;fill:none}
    .erp-matrix .cell.ovr .cb{box-shadow:0 0 0 2px var(--accent2)}
    .erp-matrix tbody tr:hover td.mod{background:var(--hi)}
    .erp-colh{cursor:pointer}
    .erp-colh:hover{color:var(--accent)}

    .erp-leg{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--faint);margin-top:12px}
    .erp-leg span{display:flex;align-items:center;gap:6px}
    .erp-leg i{width:13px;height:13px;border-radius:4px;display:inline-block}

    /* workflow */
    .erp-flow{display:flex;align-items:center;gap:0;flex-wrap:wrap;padding:6px 0}
    .erp-step{display:flex;align-items:center}
    .erp-stepbox{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px 15px;min-width:130px;position:relative}
    .erp-stepbox .lv{font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--accent);margin-bottom:3px}
    .erp-stepbox .nm{font-size:12.5px;font-weight:700;color:var(--ink)}
    .erp-stepbox .dp{font-size:10px;color:var(--faint);margin-top:2px}
    .erp-stepbox .rm{position:absolute;top:-7px;right:-7px;width:20px;height:20px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);color:var(--faint);font-size:12px;cursor:pointer;display:none;align-items:center;justify-content:center}
    .erp-stepbox:hover .rm{display:flex}
    .erp-stepbox .rm:hover{border-color:var(--red);color:var(--red)}
    .erp-arrow{width:34px;display:flex;align-items:center;justify-content:center;color:var(--faint)}
    .erp-arrow svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2}

    /* org tree */
    .erp-tree{font-size:12.5px}
    .erp-tnode{margin-left:0}
    .erp-trow{display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:8px;cursor:default}
    .erp-trow:hover{background:var(--hi)}
    .erp-tcaret{width:16px;text-align:center;color:var(--faint);cursor:pointer;user-select:none;flex-shrink:0}
    .erp-tkids{margin-left:20px;border-left:1px dashed var(--line);padding-left:10px}
    .erp-tkind{font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:1px 7px;border-radius:9px}

    .erp-act-feed{display:flex;flex-direction:column}
    .erp-act{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}
    .erp-act:last-child{border-bottom:none}
    .erp-act .dot{width:30px;height:30px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
    .erp-act .dot svg{width:15px;height:15px;fill:none;stroke-width:2}
    .erp-act .txt{flex:1;min-width:0}
    .erp-act .txt .a{font-size:12.5px;color:var(--ink);font-weight:600}
    .erp-act .txt .m{font-size:11px;color:var(--faint);margin-top:2px}
    .erp-act .tm{font-size:10.5px;color:var(--faint);white-space:nowrap;font-family:'Spline Sans Mono',monospace}

    .erp-notif{display:flex;gap:13px;padding:13px 16px;border-bottom:1px solid var(--line);cursor:pointer;transition:.1s}
    .erp-notif:hover{background:var(--hi)}
    .erp-notif.unread{background:rgba(94,155,240,.05)}
    .erp-notif .nd{width:34px;height:34px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
    .erp-notif .nd svg{width:17px;height:17px;fill:none;stroke-width:2}
    .erp-notif .ttl{font-size:12.5px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:7px}
    .erp-notif .ttl .ud{width:7px;height:7px;border-radius:50%;background:var(--blue)}
    .erp-notif .ms{font-size:11.5px;color:var(--dim);margin-top:2px}
    .erp-notif .tm{font-size:10px;color:var(--faint);margin-top:3px;font-family:'Spline Sans Mono',monospace}

    /* command palette */
    #erpCmd{position:fixed;inset:0;z-index:100030;background:rgba(8,10,14,.6);display:none;align-items:flex-start;justify-content:center;padding-top:13vh}
    #erpCmd.on{display:flex}
    #erpCmd .box{width:min(560px,94vw);background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.55);overflow:hidden}
    #erpCmd .ci{display:flex;align-items:center;gap:11px;padding:15px 18px;border-bottom:1px solid var(--line)}
    #erpCmd .ci svg{width:18px;height:18px;stroke:var(--faint);fill:none;stroke-width:2}
    #erpCmd input{flex:1;background:none;border:none;outline:none;color:var(--ink);font-size:15px;font-family:inherit}
    #erpCmd .res{max-height:54vh;overflow-y:auto;padding:7px}
    #erpCmd .cg{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:var(--faint);font-weight:700;padding:9px 12px 5px}
    #erpCmd .ci-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:9px;cursor:pointer;color:var(--ink);font-size:13px}
    #erpCmd .ci-row svg{width:16px;height:16px;stroke:var(--faint);fill:none;stroke-width:1.9;flex-shrink:0}
    #erpCmd .ci-row .meta{margin-left:auto;font-size:11px;color:var(--faint)}
    #erpCmd .ci-row.hi,#erpCmd .ci-row:hover{background:var(--accent);color:#fff}
    #erpCmd .ci-row.hi svg,#erpCmd .ci-row:hover svg{stroke:#fff}
    #erpCmd .ci-row.hi .meta,#erpCmd .ci-row:hover .meta{color:rgba(255,255,255,.8)}

    .erp-deny{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;color:var(--faint);gap:14px}
    .erp-deny svg{width:54px;height:54px;stroke:var(--line);fill:none;stroke-width:1.5}
    .erp-deny h2{font-size:20px;color:var(--ink);margin:0}

    .erp-kv{display:flex;flex-direction:column;gap:0}
    .erp-kv .r{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12.5px}
    .erp-kv .r:last-child{border-bottom:none}
    .erp-kv .r .k{color:var(--faint)} .erp-kv .r .v{color:var(--ink);font-weight:600;text-align:right}

    .erp-seg{display:inline-flex;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:3px}
    .erp-seg button{background:none;border:none;color:var(--dim);font-size:11.5px;font-weight:600;padding:6px 13px;border-radius:6px;cursor:pointer;font-family:inherit}
    .erp-seg button.on{background:var(--accent);color:#fff}

    .erp-bar2{height:7px;border-radius:4px;background:var(--panel3);overflow:hidden}
    .erp-bar2 i{display:block;height:100%;border-radius:4px}
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
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 2.6 15H2a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4 9.4l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 6.6V6a2 2 0 0 1 4 0v.1A1.6 1.6 0 0 0 17 7.6l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 21.4 13H21'
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
    const s = STATUS[st] || STATUS.inactive;
    return `<span class="erp-badge" style="color:${s.color};background:${s.color.replace('var(--', 'rgba(').replace(')', '')};background:color-mix(in srgb, ${s.color} 15%, transparent)">${s.dot} ${s.label}</span>`;
  }
  function desigTag(id) {
    const d = desigById(id); if (!d) return '<span class="erp-tag">—</span>';
    return `<span class="erp-tag" title="${esc(deptName(d.departmentId))}">${esc(d.name)}</span>`;
  }

  /* ════════════════════════════════════════════════════════════════════
     STATE + ROUTER
     ════════════════════════════════════════════════════════════════════ */
  const NAV = [
    { sec: 'Overview' },
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { sec: 'Identity' },
    { id: 'users', label: 'Users', icon: 'users', cnt: () => users().length },
    { id: 'designations', label: 'Designations', icon: 'desig', cnt: () => desigs().length },
    { id: 'departments', label: 'Departments', icon: 'dept', cnt: () => depts().length },
    { id: 'organization', label: 'Organization', icon: 'org' },
    { sec: 'Access' },
    { id: 'permissions', label: 'Permissions', icon: 'perm' },
    { id: 'projects', label: 'Projects', icon: 'project', cnt: () => projects().length },
    { id: 'workflow', label: 'Approval & Limits', icon: 'flow' },
    { id: 'security', label: 'Security', icon: 'security' },
    { sec: 'Monitor' },
    { id: 'audit', label: 'Audit Trail', icon: 'audit' },
    { id: 'notifications', label: 'Notifications', icon: 'bell' }
  ];
  const TITLES = { dashboard: 'Dashboard', users: 'User Management', designations: 'Designation Master', departments: 'Department Master', organization: 'Organization Hierarchy', permissions: 'Permission Management', projects: 'Projects', workflow: 'Approval Workflow & Financial Limits', security: 'Security & Access Control', audit: 'Audit Trail', notifications: 'Notification Center' };

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
    root.innerHTML = `
      <div class="erp-wrap">
        <aside class="erp-side ${S.collapsed ? 'collapsed' : ''}" id="erpSide">
          <div class="erp-side-head">
            <div class="badge">${ic('security')}</div>
            <div class="t">Administration<span>Control Centre</span></div>
          </div>
          <nav class="erp-nav" id="erpNav"></nav>
          <div class="erp-side-foot">
            <button class="erp-collapse" id="erpCollapse">${ic('chevL')}<span class="txt">Collapse</span></button>
          </div>
        </aside>
        <div class="erp-main">
          <div class="erp-bar">
            <div class="erp-crumb" id="erpCrumb"></div>
            <div class="erp-bar-sp"></div>
            <div class="erp-search" style="max-width:300px">
              <svg viewBox="0 0 24 24">${ICON.search}</svg>
              <input id="erpGlobal" placeholder="Search users, designations…" readonly>
              <span class="kbd">⌘K</span>
            </div>
            <button class="erp-iconbtn" id="erpBell" title="Notifications">${ic('bell')}<span id="erpBellDot"></span></button>
          </div>
          <div class="erp-body" id="erpBody"></div>
        </div>
      </div>`;
    document.getElementById('erpCollapse').onclick = () => { S.collapsed = !S.collapsed; save('erp_side_collapsed', S.collapsed); document.getElementById('erpSide').classList.toggle('collapsed', S.collapsed); document.getElementById('erpCollapse').innerHTML = ic(S.collapsed ? 'chevR' : 'chevL') + '<span class="txt">Collapse</span>'; };
    document.getElementById('erpBell').onclick = () => go('notifications');
    const gs = document.getElementById('erpGlobal'); gs.onclick = openCmd; gs.onfocus = openCmd;
    renderNav();
    refreshBadge();
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
    nav.querySelectorAll('a[data-v]').forEach(a => a.onclick = (e) => { if (e.target.closest('.pin')) return; go(a.dataset.v); });
    nav.querySelectorAll('.pin').forEach(p => p.onclick = (e) => { e.stopPropagation(); togglePin(p.dataset.pin); });
  }
  function navLink(it, isPinned) {
    const cnt = it.cnt ? `<span class="cnt">${it.cnt()}</span>` : '';
    const pinned = S.pinned.includes(it.id);
    const pin = isPinned ? '' : `<span class="pin ${pinned ? 'on' : ''}" data-pin="${it.id}" title="${pinned ? 'Unpin' : 'Pin to top'}">${pinned ? '★' : '☆'}</span>`;
    return `<a data-v="${it.id}" class="${S.view === it.id ? 'on' : ''}" title="${esc(it.label)}">${ic(it.icon)}<span class="erp-nav-lbl">${esc(it.label)}</span>${cnt || pin}</a>`;
  }
  function togglePin(id) { const i = S.pinned.indexOf(id); if (i >= 0) S.pinned.splice(i, 1); else S.pinned.push(id); save('erp_pinned', S.pinned); renderNav(); }

  function renderMain() {
    if (!document.getElementById('erpBody')) renderShell();
    // active nav
    document.querySelectorAll('#erpNav a[data-v]').forEach(a => a.classList.toggle('on', a.dataset.v === S.view));
    const cr = document.getElementById('erpCrumb');
    if (cr) cr.innerHTML = `Administration<span class="sep">›</span><b>${esc(TITLES[S.view] || S.view)}</b>`;
    const body = document.getElementById('erpBody');
    if (!canAdmin()) { body.parentElement.innerHTML = denyHTML(); return; }
    const fn = VIEWS[S.view] || VIEWS.dashboard;
    body.innerHTML = fn();
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
    const u = users();
    const online = u.filter(x => (x.sessions || []).length).length;
    const pending = u.filter(x => x.status === 'pending').length + 3;
    const today = load(K.hist, []).filter(h => h.ok && Date.now() - h.ts < 86400000).length + u.filter(x => x.lastLogin && Date.now() - x.lastLogin < 86400000).length;
    const pol = policy();
    const activeUsers = u.filter(x => x.status === 'active').length;
    const lic = pol.license || { total: 50 };
    const used = u.filter(x => x.status !== 'archived').length;
    // storage
    let bytes = 0; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); bytes += (localStorage.getItem(k) || '').length + k.length; } } catch (e) {}
    const mb = (bytes / 1048576);
    const tile = (icon, color, n, l, d) => `<div class="erp-tile"><div class="ic" style="background:color-mix(in srgb,${color} 16%,transparent)">${ic(icon).replace('<svg', '<svg style="stroke:' + color + '"')}</div><div class="n">${n}</div><div class="l">${l}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;

    const acts = audit().slice(0, 7).map(a => {
      const map = { 'User Created': ['var(--green)', 'user'], 'Permission Modified': ['var(--accent)', 'perm'], 'Account Locked': ['var(--red)', 'lock'], 'Login Success': ['var(--blue)', 'power'], 'Login Failure': ['var(--red)', 'power'], 'Platform Access Revoked': ['var(--red)', 'power'], 'Role Changed': ['var(--violet)', 'desig'] };
      const m = map[a.action] || ['var(--faint)', 'audit'];
      return `<div class="erp-act"><div class="dot" style="background:color-mix(in srgb,${m[0]} 16%,transparent)">${ic(m[1]).replace('<svg', '<svg style="stroke:' + m[0] + '"')}</div><div class="txt"><div class="a">${esc(a.action)}${a.target ? ' · ' + esc(a.target) : ''}</div><div class="m">${esc(a.module)} • by ${esc(a.admin)}${a.newVal ? ' → ' + esc(a.newVal) : ''}</div></div><div class="tm">${ago(a.ts)}</div></div>`;
    }).join('');

    const dist = depts().map(d => ({ d, n: u.filter(x => x.departmentId === d.id).length })).filter(x => x.n).sort((a, b) => b.n - a.n);
    const maxD = Math.max(1, ...dist.map(x => x.n));

    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">Good ${greeting()}, ${esc(currentName().split(' ')[0])}</h1><div class="erp-sub">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · Primarc Projects</div></div>
        <div style="display:flex;gap:9px"><button class="erp-btn" onclick="ERP.go('audit')">${ic('audit')}Audit trail</button><button class="erp-btn primary" onclick="ERP.addUser()">${ic('plus')}Add user</button></div></div>
      <div class="erp-tiles">
        ${tile('users', 'var(--accent)', u.length, 'Total Users', activeUsers + ' active')}
        ${tile('power', 'var(--green)', online, 'Online Now', 'live sessions')}
        ${tile('dept', 'var(--blue)', depts().length, 'Departments', desigs().length + ' designations')}
        ${tile('project', 'var(--violet)', projects().length, 'Projects', 'active sites')}
        ${tile('flow', 'var(--accent2)', pending, 'Pending Approvals', 'awaiting action')}
        ${tile('power', 'var(--blue)', today, "Today's Logins", 'last 24h')}
      </div>
      <div class="erp-grid2">
        <div class="erp-card"><div class="erp-card-head"><div class="ttl">Recent Activity<span>live audit feed</span></div><button class="erp-btn sm ghost" onclick="ERP.go('audit')">View all</button></div>
          <div class="erp-card-body" style="padding:6px 16px"><div class="erp-act-feed">${acts || '<div class="erp-empty">No activity yet</div>'}</div></div></div>
        <div style="display:flex;flex-direction:column;gap:16px">
          <div class="erp-card"><div class="erp-card-head"><div class="ttl">License</div>${statusBadge('active')}</div>
            <div class="erp-card-body">
              <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px"><div><div style="font-size:24px;font-weight:800;color:var(--ink);line-height:1">${used}<span style="font-size:14px;color:var(--faint)"> / ${lic.total}</span></div><div style="font-size:10.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.5px;margin-top:3px">Seats used</div></div><div style="text-align:right;font-size:11px;color:var(--dim)">${lic.total - used} available<br><span style="color:var(--faint)">expires ${fmtDate(new Date(lic.expires).getTime())}</span></div></div>
              <div class="erp-bar2"><i style="width:${Math.min(100, used / lic.total * 100)}%;background:${used / lic.total > .9 ? 'var(--red)' : 'var(--green)'}"></i></div>
            </div></div>
          <div class="erp-card"><div class="erp-card-head"><div class="ttl">System Health</div></div>
            <div class="erp-card-body erp-kv">
              <div class="r"><span class="k">Storage used</span><span class="v">${mb.toFixed(2)} MB</span></div>
              <div class="r"><span class="k">Auth method</span><span class="v">SHA-256 + salt</span></div>
              <div class="r"><span class="k">Session timeout</span><span class="v">${pol.sessionTimeout || 30} min</span></div>
              <div class="r"><span class="k">2-Factor</span><span class="v" style="color:var(--faint)">Ready (off)</span></div>
              <div class="r"><span class="k">Backups</span><span class="v" style="color:var(--green)">● Local</span></div>
            </div></div>
        </div>
      </div>
      <div class="erp-card" style="margin-top:16px"><div class="erp-card-head"><div class="ttl">Headcount by Department</div></div>
        <div class="erp-card-body" style="display:flex;flex-direction:column;gap:9px">
          ${dist.map(x => `<div style="display:flex;align-items:center;gap:12px"><div style="width:140px;font-size:12px;color:var(--ink);font-weight:600">${esc(x.d.name)}</div><div style="flex:1"><div class="erp-bar2" style="height:9px"><i style="width:${x.n / maxD * 100}%;background:var(--accent)"></i></div></div><div style="width:30px;text-align:right;font-size:12px;font-weight:700;color:var(--ink)">${x.n}</div></div>`).join('')}
        </div></div>`;
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
