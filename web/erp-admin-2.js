/* ════════════════════════════════════════════════════════════════════════
   ADMINISTRATION MODULE — continuation (views, drawers, command palette).
   Populates the VIEWS/BIND maps & window.ERP methods exposed by erp-admin.js.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const I = window.__ERP_INTERNAL;
  if (!I) { console.error('ERP internals missing'); return; }
  const { S, NAV, TITLES, VIEWS, BIND, load, save, K, esc, ic, ICON, ACTIONS, STATUS,
    users, setUsers, depts, desigs, modules, projects, branches, companies, audit, notifs, policy, settings,
    deptName, desigById, desigName, branchName, companyName, userById, userName,
    logAudit, notify, refreshBadge, hash, rndSalt, uid, fmtDate, fmtDT, ago, inr, inrFull,
    avatar, statusBadge, desigTag, go, renderMain, renderNav, currentName, myIP, browserName, osName } = I;

  const toast = (m) => { if (window.showToast) window.showToast(m); else { const t = document.createElement('div'); t.textContent = m; t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:10px 18px;border-radius:9px;font-size:13px;font-weight:600;z-index:100050;box-shadow:0 10px 30px rgba(0,0,0,.4);font-family:Archivo,sans-serif'; document.body.appendChild(t); setTimeout(() => t.remove(), 2200); } };
  const $ = (s, r) => (r || document).querySelector(s);
  const val = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };

  /* ───────── server mode ─────────
     With the API connected, sign-in is checked by the server — so creating,
     locking, deleting or re-passwording a user only in this browser's
     localStorage reported success while changing nothing that matters.
     These helpers send the account change to the server and then reload the
     list from it. ERP-only details the server has no column for yet
     (department, designation, photo, project access …) stay on this
     computer and are re-attached to the server record after each reload. */
  const SERVER = () => !!(window.TSApi && window.TSApi.active && window.TSApi.session && window.CloudflareAPI);
  const LOCAL_ONLY = ['empId', 'mobile', 'photo', 'signature', 'departmentId', 'designationId', 'reportingManagerId',
    'branchId', 'companyId', 'joiningDate', 'expiryDate', 'remarks', 'overrides', 'avatarColor', 'initials',
    'projectAccess', 'lockReason', 'created'];
  async function serverRefresh(extra) {
    const before = new Map(users().map(u => [u.id, u]));
    if (extra) before.set(extra.id, Object.assign({}, before.get(extra.id) || {}, extra));
    const fresh = await window.TSApi.listUsers();
    setUsers(fresh.map(f => {
      const old = before.get(f.id) || {}, keep = {};
      LOCAL_ONLY.forEach(k => { if (old[k] !== undefined) keep[k] = old[k]; });
      const status = f.status === 'suspended' ? 'locked' : (f.status === 'inactive' ? 'inactive' : 'active');
      return Object.assign(keep, f, { status, platformAccess: f.active, active: f.active });
    }));
  }
  async function serverDo(fn, okMsg, extra) {
    try { const r = await fn(); await serverRefresh(extra && extra(r)); if (okMsg) toast(okMsg); renderMain(); return r || true; }
    catch (e) { renderMain(); notice('Not saved', 'The server did not accept the change: ' + ((e && e.message) || 'no reason given') + '. Check the details or your connection and try again.'); return false; }
  }
  const setStatus = (id, status) => window.CloudflareAPI.users.update(id, { status });
  /* With server sign-in, user accounts are shared but the admin master data
     below (departments, designations, projects, approval chains, policy,
     audit, notifications) is still kept in this browser's storage only. Say
     so on those pages rather than let it look centrally saved. */
  const localBadge = () => SERVER() ? '<span class="erp-local" title="Kept in this browser\'s storage — not shared with other computers or users">Saved in this browser</span>' : '';

  /* ───────── overlay (drawer / modal) ───────── */
  /* Typing in a drawer / modal marks it dirty; closing it by ×, Cancel,
     Escape or a click on the backdrop then asks before throwing the edits
     away. Saving closes through closeOv() directly, so it never asks. */
  let ovDirty = false, ovPrevFocus = null;
  function ensureOv() {
    let ov = document.getElementById('erpOv');
    if (!ov) {
      ov = document.createElement('div'); ov.className = 'erp-ov'; ov.id = 'erpOv'; document.body.appendChild(ov);
      ov.addEventListener('mousedown', e => { if (e.target === ov) requestClose(); });
      const dirty = (e) => { if (e.target.closest('input,select,textarea')) ovDirty = true; };
      ov.addEventListener('input', dirty); ov.addEventListener('change', dirty);
    }
    return ov;
  }
  function openOv(kind, html) {
    const ov = ensureOv();
    if (!ov.classList.contains('on')) ovPrevFocus = document.activeElement;
    const cls = kind === 'drawer' ? 'erp-drawer' : 'erp-modal' + (kind === 'wide' ? ' wide' : '');
    ov.innerHTML = `<div class="${cls}" role="dialog" aria-modal="true">${html}</div>`;
    ovDirty = false;
    ov.querySelectorAll('label.erp-flbl:not([for])').forEach(l => { const c = l.parentElement && l.parentElement.querySelector('input:not([type=checkbox]):not([type=file]),select,textarea'); if (c && c.id) { l.htmlFor = c.id; if (l.querySelector('.req')) c.setAttribute('aria-required', 'true'); } });
    const h3 = ov.querySelector('.erp-dh h3'); if (h3) { h3.id = 'erpOvT'; ov.firstElementChild.setAttribute('aria-labelledby', 'erpOvT'); }
    requestAnimationFrame(() => ov.classList.add('on'));
    document.onkeydown = (e) => { if (e.key === 'Escape') requestClose(); };
    setTimeout(() => { if (!ov.contains(document.activeElement)) { const f = ov.querySelector('input:not([type=hidden]):not([type=file]):not([disabled]),select,textarea'); if (f) f.focus(); } }, 80);
  }
  function closeOv() {
    ovDirty = false;
    const ov = document.getElementById('erpOv');
    if (ov) { ov.classList.remove('on'); setTimeout(() => { if (ov && !ov.classList.contains('on')) ov.innerHTML = ''; }, 200); }
    document.onkeydown = null;
    if (ovPrevFocus && ovPrevFocus.isConnected) { try { ovPrevFocus.focus(); } catch (e) {} } ovPrevFocus = null;
  }
  function requestClose() {
    if (!ovDirty) return closeOv();
    dialog({ title: 'Discard changes?', text: 'This form has changes that have not been saved. Close it and lose them?', ok: 'Discard changes', cancel: 'Keep editing', danger: true })
      .then(ok => { if (ok) closeOv(); });
  }
  window.ERP._closeOv = requestClose;

  /* ───────── in-app dialog (confirm / small forms) ─────────
     Replaces the browser's confirm() / prompt() for admin actions. Sits above
     drawers and modals. Resolves to false on cancel; otherwise to true, or to
     whatever o.validate(root, setMsg) returns (return false to keep it open). */
  function dialog(o) {
    return new Promise(resolve => {
      const prev = document.activeElement;
      const ov = document.createElement('div'); ov.className = 'erp-ov on'; ov.id = 'erpDlg'; ov.style.zIndex = '100025';
      ov.innerHTML = `<div class="erp-modal sm" role="${o.danger ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="erpDlgT" aria-describedby="erpDlgB">
        <div class="erp-dh"><div><h3 id="erpDlgT"></h3><div class="sub" id="erpDlgS"></div></div><button type="button" class="erp-x" data-r="0" aria-label="Close">×</button></div>
        <div class="erp-dbody" id="erpDlgB">${o.html || '<p></p>'}</div>
        <div class="erp-dfoot"><span class="msg" id="erpDlgMsg" role="alert" style="color:var(--red)"></span><button type="button" class="erp-btn" data-r="0"></button><button type="button" class="erp-btn ${o.danger ? 'danger solid' : 'primary'}" data-r="1"></button></div></div>`;
      ov.querySelector('#erpDlgT').textContent = o.title || 'Are you sure?';
      const sub = ov.querySelector('#erpDlgS'); if (o.sub) sub.textContent = o.sub; else sub.remove();
      if (!o.html) ov.querySelector('#erpDlgB p').textContent = o.text || '';
      if (o.alert) ov.querySelector('.erp-dfoot [data-r="0"]').remove();
      else ov.querySelector('.erp-dfoot [data-r="0"]').textContent = o.cancel || 'Cancel';
      const okBtn = ov.querySelector('[data-r="1"]'); okBtn.textContent = o.ok || 'OK';
      const setMsg = (t) => { ov.querySelector('#erpDlgMsg').textContent = t || ''; };
      let busy = false;
      const done = (v) => { document.removeEventListener('keydown', key, true); ov.remove(); if (prev && prev.isConnected) { try { prev.focus(); } catch (e) {} } resolve(v); };
      const submit = async () => {
        if (busy) return; busy = true; okBtn.disabled = true;
        try { const r = o.validate ? await o.validate(ov, setMsg) : true; if (r !== false) return done(r === undefined ? true : r); }
        finally { busy = false; if (ov.isConnected) okBtn.disabled = false; }
      };
      function key(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(false); return; }
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && ov.contains(e.target)) { e.preventDefault(); submit(); return; }
        if (e.key === 'Tab') {
          const f = [...ov.querySelectorAll('button,input,select,textarea')].filter(x => !x.disabled);
          if (!f.length) return;
          if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
        }
      }
      ov.addEventListener('mousedown', e => { if (e.target === ov) done(false); });
      ov.addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (!b) return; if (b.dataset.r === '1') submit(); else done(false); });
      document.addEventListener('keydown', key, true);
      document.body.appendChild(ov);
      const first = ov.querySelector('.erp-dbody input,.erp-dbody select,.erp-dbody textarea');
      (first || ov.querySelector(o.danger && !o.alert ? '.erp-dfoot [data-r="0"]' : '[data-r="1"]')).focus();
    });
  }
  const confirmBox = (title, text, ok, danger) => dialog({ title, text, ok, danger: danger !== false });
  const notice = (title, text) => dialog({ title, text, ok: 'OK', alert: true });
  window.ERP._dialog = dialog;

  /* ───────── row context menu ───────── */
  function ensureMenu() { let m = document.getElementById('erpRowMenu'); if (!m) { m = document.createElement('div'); m.className = 'erp-rowmenu'; m.id = 'erpRowMenu'; document.body.appendChild(m); document.addEventListener('click', e => { if (!e.target.closest('#erpRowMenu') && !e.target.closest('[data-rowmenu]')) m.style.display = 'none'; }); } return m; }
  function rowMenu(ev, items) {
    ev.stopPropagation();
    const m = ensureMenu();
    m.innerHTML = items.map(it => it === '-' ? '<div class="sep"></div>' : `<button class="${it.danger ? 'danger' : ''}" data-act="${it.act}">${ic(it.icon)}${esc(it.label)}</button>`).join('');
    m.querySelectorAll('button[data-act]').forEach(b => b.onclick = () => { m.style.display = 'none'; const it = items.find(x => x.act === b.dataset.act); if (it && it.fn) it.fn(); });
    m.style.display = 'block';
    const r = ev.currentTarget.getBoundingClientRect();
    const w = 200, h = m.offsetHeight || 320;
    m.style.left = Math.min(r.left, window.innerWidth - w - 10) + 'px';
    m.style.top = (r.bottom + h > window.innerHeight ? r.top - h : r.bottom + 4) + 'px';
  }

  /* ════════════════════════════════════════════════════════════════════
     USERS
     ════════════════════════════════════════════════════════════════════ */
  function filteredUsers() {
    let u = users().slice();
    const f = S.u;
    if (f.q) { const q = f.q.toLowerCase(); u = u.filter(x => ((x.name || '') + (x.username || '') + (x.email || '') + (x.empId || '') + desigName(x.designationId)).toLowerCase().includes(q)); }
    if (f.dept) u = u.filter(x => x.departmentId === f.dept);
    if (f.desig) u = u.filter(x => x.designationId === f.desig);
    if (f.status) u = u.filter(x => (x.status || 'active') === f.status);
    const key = f.sort;
    u.sort((a, b) => {
      let av, bv;
      if (key === 'designation') { av = desigName(a.designationId); bv = desigName(b.designationId); }
      else if (key === 'department') { av = deptName(a.departmentId); bv = deptName(b.departmentId); }
      else if (key === 'lastLogin') { av = a.lastLogin || 0; bv = b.lastLogin || 0; }
      else { av = (a[key] || '').toString().toLowerCase(); bv = (b[key] || '').toString().toLowerCase(); }
      return (av < bv ? -1 : av > bv ? 1 : 0) * f.dir;
    });
    return u;
  }
  VIEWS.users = function () {
    const f = S.u;
    const all = filteredUsers();
    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / f.per));
    if (f.page > pages) f.page = pages;
    const slice = all.slice((f.page - 1) * f.per, f.page * f.per);
    const sortArrow = (k) => f.sort === k ? `<span class="ar" aria-hidden="true">${f.dir > 0 ? '▲' : '▼'}</span>` : '';
    const ariaSort = (k) => f.sort === k ? ` aria-sort="${f.dir > 0 ? 'ascending' : 'descending'}"` : '';
    const deptOpts = `<option value="">All departments</option>` + depts().map(d => `<option value="${d.id}" ${f.dept === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
    const desigOpts = `<option value="">All designations</option>` + desigs().map(d => `<option value="${d.id}" ${f.desig === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
    const statusOpts = `<option value="">Any status</option>` + Object.keys(STATUS).map(k => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${STATUS[k].label}</option>`).join('');
    const allSel = slice.length && slice.every(x => f.sel.includes(x.id));
    const filtering = !!(f.q || f.dept || f.desig || f.status);
    const all0 = users(), nActive = all0.filter(x => (x.status || 'active') === 'active').length;

    const rows = slice.map(x => {
      const sel = f.sel.includes(x.id);
      /* platformAccess is only ever set to false explicitly (records listed from
         the server don't carry it at all) — the drawer and every action treat
         "missing" as allowed, so the table now does too. It used to show
         "access off" for every server account, including the signed-in admin. */
      const off = x.platformAccess === false && x.status !== 'locked';
      return `<tr class="${sel ? 'sel' : ''}" data-uid="${x.id}">
        <td style="width:36px"><input type="checkbox" class="erp-chk uchk" data-id="${x.id}" ${sel ? 'checked' : ''} aria-label="Select ${esc(x.name)}"></td>
        <td><div class="erp-cellname">${avatar(x)}<div style="min-width:0"><div class="nm">${esc(x.name)}${x.id === 'u_admin' ? ' <span class="erp-pill" style="background:var(--red)">Super</span>' : ''}</div><div class="sub2">${esc(x.email || x.empId || '—')}</div></div></div></td>
        <td class="mono">${esc(x.username)}</td>
        <td>${desigTag(x.designationId)}${x.role ? `<div class="sub2">${esc(x.role)}</div>` : ''}</td>
        <td>${esc(deptName(x.departmentId))}</td>
        <td>${statusBadge(x.status || 'active')}${off ? '<div class="sub2" style="color:var(--red)">Sign-in disabled</div>' : ''}</td>
        <td style="white-space:nowrap">${x.lastLogin ? ago(x.lastLogin) : '<span style="color:var(--faint)">Never</span>'}</td>
        <td class="acts"><button type="button" class="erp-btn ghost icon" title="Edit ${esc(x.name)}" aria-label="Edit ${esc(x.name)}" onclick="event.stopPropagation();ERP.editUser('${x.id}')">${ic('edit')}</button><button type="button" class="erp-btn ghost icon" data-rowmenu data-id="${x.id}" title="More actions" aria-label="More actions for ${esc(x.name)}" aria-haspopup="menu" onclick="ERP._userMenu(event,'${x.id}')">${ic('dots')}</button></td>
      </tr>`;
    }).join('');

    const pg = pageBtns(f.page, pages, 'ERP._uPage');
    const empty = filtering
      ? `<div class="erp-empty">${ic('search')}<b>No users match these filters</b>Try a different search, or <button type="button" class="erp-btn sm" onclick="ERP._uClear()">Clear filters</button></div>`
      : `<div class="erp-empty">${ic('users')}<b>No users yet</b>Add the first account to give someone access.<br><button type="button" class="erp-btn primary sm" onclick="ERP.addUser()">${ic('plus')}Add user</button></div>`;
    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">Users</h1><div class="erp-sub">${all0.length} account${all0.length === 1 ? '' : 's'} · ${nActive} active. Sign-in roles are set per user; what each role may do is under <a href="#" onclick="event.preventDefault();ERP._navAct('roleAccess')" style="color:var(--accent)">Role Access</a>.</div></div>
        <div class="acts"><button class="erp-btn" onclick="ERP._exportUsers('csv')">${ic('download')}Export CSV</button><button class="erp-btn primary" onclick="ERP.addUser()">${ic('plus')}Add user</button></div></div>
      <div class="erp-toolbar" role="search">
        <div class="erp-field"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON.search}</svg><input class="erp-input" id="uSearch" type="search" placeholder="Search name, username, email, ID…" aria-label="Search users" value="${esc(f.q)}"></div>
        <select class="erp-select" id="uDept" aria-label="Filter by department">${deptOpts}</select>
        <select class="erp-select" id="uDesig" aria-label="Filter by designation">${desigOpts}</select>
        <select class="erp-select" id="uStatus" aria-label="Filter by status">${statusOpts}</select>
        ${filtering ? `<button type="button" class="erp-btn ghost" onclick="ERP._uClear()">Clear filters</button>` : ''}
      </div>
      ${f.sel.length ? `<div class="erp-bulkbar" role="region" aria-label="Actions for selected users"><b>${f.sel.length}</b> selected
        <div class="erp-tb-sp"></div>
        <button class="erp-btn sm" onclick="ERP._bulk('activate')">${ic('check')}Activate</button>
        <button class="erp-btn sm" onclick="ERP._bulk('deactivate')">${ic('power')}Deactivate</button>
        <button class="erp-btn sm" onclick="ERP._bulk('lock')">${ic('lock')}Lock</button>
        <button class="erp-btn sm" onclick="ERP._bulk('unlock')">${ic('unlock')}Unlock</button>
        <button class="erp-btn sm danger" onclick="ERP._bulk('delete')">${ic('trash')}Delete</button>
        <button class="erp-btn sm ghost" onclick="ERP._clearSel()">Clear selection</button>
      </div>` : ''}
      <div class="erp-card"><div class="erp-tbl-wrap"><table class="erp-tbl">
        <thead><tr>
          <th class="nosort" style="width:36px"><input type="checkbox" class="erp-chk" id="uAll" ${allSel ? 'checked' : ''} aria-label="Select all users on this page"></th>
          <th data-sort="name"${ariaSort('name')}>Employee${sortArrow('name')}</th>
          <th data-sort="username"${ariaSort('username')}>Username${sortArrow('username')}</th>
          <th data-sort="designation"${ariaSort('designation')}>Designation / role${sortArrow('designation')}</th>
          <th data-sort="department"${ariaSort('department')}>Department${sortArrow('department')}</th>
          <th data-sort="status"${ariaSort('status')}>Status${sortArrow('status')}</th>
          <th data-sort="lastLogin"${ariaSort('lastLogin')}>Last sign-in${sortArrow('lastLogin')}</th>
          <th class="nosort"><span class="sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Actions</span></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="8">${empty}</td></tr>`}</tbody>
      </table></div></div>
      <div class="erp-pager"><div>Showing ${slice.length ? (f.page - 1) * f.per + 1 : 0}–${(f.page - 1) * f.per + slice.length} of ${total}
        · <label>Rows <select id="uPer" aria-label="Rows per page">${[8, 25, 50, 100].map(n => `<option ${f.per === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div><div class="pg">${pg}</div></div>`;
  };
  BIND.users = function () {
    const f = S.u;
    const s = $('#uSearch'); if (s) s.oninput = (e) => { f.q = e.target.value; f.page = 1; const p = e.target.selectionStart; renderMain(); const n = $('#uSearch'); if (n) { n.focus(); n.setSelectionRange(p, p); } };
    $('#uDept').onchange = e => { f.dept = e.target.value; f.page = 1; renderMain(); };
    $('#uDesig').onchange = e => { f.desig = e.target.value; f.page = 1; renderMain(); };
    $('#uStatus').onchange = e => { f.status = e.target.value; f.page = 1; renderMain(); };
    const per = $('#uPer'); if (per) per.onchange = e => { f.per = +e.target.value || 8; f.page = 1; renderMain(); };
    document.querySelectorAll('#erpBody th[data-sort]').forEach(th => { th.tabIndex = 0; th.onclick = () => { const k = th.dataset.sort; if (f.sort === k) f.dir *= -1; else { f.sort = k; f.dir = 1; } renderMain(); }; th.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); th.click(); } }; });
    document.querySelectorAll('.uchk').forEach(c => { c.onclick = (e) => e.stopPropagation(); c.onchange = () => { const id = c.dataset.id; const i = f.sel.indexOf(id); if (c.checked && i < 0) f.sel.push(id); else if (!c.checked && i >= 0) f.sel.splice(i, 1); renderMain(); }; });
    const ua = $('#uAll'); if (ua) ua.onchange = () => { const slice = filteredUsers().slice((f.page - 1) * f.per, f.page * f.per); if (ua.checked) slice.forEach(x => { if (!f.sel.includes(x.id)) f.sel.push(x.id); }); else slice.forEach(x => { const i = f.sel.indexOf(x.id); if (i >= 0) f.sel.splice(i, 1); }); renderMain(); };
    /* a click anywhere else on a row opens the user for editing */
    document.querySelectorAll('#erpBody tr[data-uid]').forEach(tr => tr.onclick = (e) => { if (e.target.closest('button,input,a,select')) return; window.ERP.editUser(tr.dataset.uid); });
  };
  function pageBtns(cur, pages, fn) {
    let h = `<button onclick="${fn}(${cur - 1})" ${cur <= 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>`;
    const add = (p) => h += `<button class="${p === cur ? 'on' : ''}" onclick="${fn}(${p})"${p === cur ? ' aria-current="page"' : ''} aria-label="Page ${p}">${p}</button>`;
    const set = new Set([1, pages, cur, cur - 1, cur + 1]); let last = 0;
    [...set].filter(p => p >= 1 && p <= pages).sort((a, b) => a - b).forEach(p => { if (p - last > 1) h += `<span style="padding:0 3px;color:var(--faint)">…</span>`; add(p); last = p; });
    h += `<button onclick="${fn}(${cur + 1})" ${cur >= pages ? 'disabled' : ''} aria-label="Next page">›</button>`;
    return h;
  }

  /* ───────── user drawer (create / edit) ───────── */
  let draft = null; // {photo, signature, designationId}
  function userDrawer(editId) {
    const u = editId ? userById(editId) : null;
    draft = { photo: u ? u.photo : null, signature: u ? u.signature : null, designationId: u ? u.designationId : (desigs()[0] || {}).id };
    const empId = u ? u.empId : 'PRMC-' + String(101 + users().length);
    const branchOpts = branches().map(b => `<option value="${b.id}" ${u && u.branchId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
    const compOpts = companies().map(c => `<option value="${c.id}" ${u && u.companyId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const mgrOpts = `<option value="">— None —</option>` + users().filter(x => x.id !== editId).map(x => `<option value="${x.id}" ${u && u.reportingManagerId === x.id ? 'selected' : ''}>${esc(x.name)} · ${esc(desigName(x.designationId))}</option>`).join('');
    const statusOpts = Object.keys(STATUS).filter(k => k !== 'archived' || (u && u.status === 'archived')).map(k => `<option value="${k}" ${u && (u.status || 'active') === k ? 'selected' : ''}>${STATUS[k].label}</option>`).join('');
    const pa = u ? u.platformAccess !== false : true;
    const av = { photo: draft.photo, avatarColor: u ? u.avatarColor : '#ff6a2c', initials: u ? u.initials : 'NU', name: u ? u.name : 'New' };
    openOv('drawer', `
      <div class="erp-dh"><div><h3>${u ? 'Edit User' : 'Add New User'}</h3><div class="sub">${u ? esc(u.name) + ' · ' + esc(u.empId || '') : 'Create an employee account with role-based access'}</div></div><button class="erp-x" onclick="ERP._closeOv()">×</button></div>
      <div class="erp-dbody">
        <div class="erp-avup" style="margin-bottom:20px">
          <button type="button" class="erp-avbig" id="uPhoto" aria-label="Upload profile photo" style="${draft.photo ? `background-image:url('${draft.photo}')` : `background:${av.avatarColor}`}" onclick="document.getElementById('uPhotoFile').click()">${draft.photo ? '' : (av.initials)}<div class="ov">Upload</div></button>
          <div><div style="font-size:13px;font-weight:700;color:var(--ink)">Profile Photo</div><div class="erp-fhint">JPG/PNG · click avatar to upload. Optional.</div>
            ${draft.photo ? `<button class="erp-btn sm" style="margin-top:7px" onclick="ERP._clearPhoto()">${ic('trash')}Remove</button>` : ''}</div>
          <input type="file" id="uPhotoFile" accept="image/*" style="display:none">
        </div>
        <div class="erp-fgrid">
          <div class="erp-fsec">${ic('user')}Identity</div>
          <div><label class="erp-flbl">Employee ID</label><input class="erp-fin mono" id="fEmpId" value="${esc(empId)}"><div class="erp-fhint">Auto-generated — editable</div></div>
          <div><label class="erp-flbl">Employee Name <span class="req">*</span></label><input class="erp-fin" id="fName" placeholder="e.g. Rahul Sharma" value="${u ? esc(u.name) : ''}"></div>
          <div><label class="erp-flbl">Email <span class="req">*</span></label><input class="erp-fin" id="fEmail" type="email" placeholder="name@primarc.in" value="${u ? esc(u.email || '') : ''}"></div>
          <div><label class="erp-flbl">Mobile Number</label><input class="erp-fin" id="fMobile" placeholder="+91 …" value="${u ? esc(u.mobile || '') : ''}"></div>

          <div class="erp-fsec">${ic('desig')}Role & Reporting</div>
          <div><label class="erp-flbl">Department</label><select class="erp-fsel" id="fDept">${depts().map(d => `<option value="${d.id}" ${(u ? u.departmentId : (desigById(draft.designationId) || {}).departmentId) === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
          <div><label class="erp-flbl">Designation <span class="req">*</span></label>
            <div class="erp-combo" id="fDesigCombo">
              <input class="erp-fin" id="fDesig" autocomplete="off" placeholder="Type to search or create…" value="${esc(desigName(draft.designationId))}">
              <div class="erp-combo-list" id="fDesigList"></div>
            </div><div class="erp-fhint">Type a new title to create it on the fly</div></div>
          <div><label class="erp-flbl">Reporting Manager</label><select class="erp-fsel" id="fMgr">${mgrOpts}</select></div>
          <div><label class="erp-flbl">Branch</label><select class="erp-fsel" id="fBranch">${branchOpts}</select></div>
          <div><label class="erp-flbl">Company</label><select class="erp-fsel" id="fComp">${compOpts}</select></div>
          <div><label class="erp-flbl">Employee Status</label><select class="erp-fsel" id="fStatus">${statusOpts}</select></div>

          <div class="erp-fsec">${ic('key')}Credentials & Access</div>
          <div><label class="erp-flbl">Username <span class="req">*</span></label><input class="erp-fin mono" id="fUser" autocomplete="off" placeholder="login id" value="${u ? esc(u.username) : ''}" ${u && u.id === 'u_admin' ? 'disabled' : ''}></div>
          <div><label class="erp-flbl">Joining Date</label><input class="erp-fin" id="fJoin" type="date" value="${u ? esc(u.joiningDate || '') : ''}"></div>
          <div><label class="erp-flbl">${u ? 'New Password' : 'Password'} ${u ? '' : '<span class="req">*</span>'}</label>
            <div style="display:flex;gap:6px"><input class="erp-fin" id="fPw" type="password" placeholder="${u ? 'leave blank to keep' : 'min 8 chars'}" oninput="ERP._pwMeter()"><button class="erp-btn sm" onclick="ERP._genPw()" title="Generate">⚄</button></div>
            <div class="erp-pwbar"><i id="fPwBar"></i></div></div>
          <div><label class="erp-flbl">Confirm Password</label><input class="erp-fin" id="fPw2" type="password" placeholder="re-enter"></div>
          <div class="full"><label class="erp-toggle"><input type="checkbox" id="fPa" ${pa ? 'checked' : ''}><span class="tk"></span><span class="tl">Allow Platform Access</span></label><div class="erp-fhint">When off, the user cannot sign in and active sessions are terminated.</div></div>

          <div class="erp-fsec">${ic('audit')}Notes</div>
          <div class="full"><label class="erp-flbl">Remarks</label><textarea class="erp-fta" id="fRemarks" placeholder="Internal notes about this employee…">${u ? esc(u.remarks || '') : ''}</textarea></div>
        </div>
      </div>
      <div class="erp-dfoot"><span class="msg" id="uMsg"></span><button class="erp-btn" onclick="ERP._closeOv()">Cancel</button><button class="erp-btn primary" onclick="ERP._saveUser('${editId || ''}')">${ic('check')}${u ? 'Save Changes' : 'Create User'}</button></div>
    `);
    bindDrawer();
  }
  function bindDrawer() {
    const pf = $('#uPhotoFile'); if (pf) pf.onchange = (e) => readImg(e, (d) => { draft.photo = d; const el = $('#uPhoto'); el.style.backgroundImage = `url('${d}')`; el.textContent = ''; const ov = document.createElement('div'); ov.className = 'ov'; ov.textContent = 'Change'; el.appendChild(ov); });
    // designation combo
    const inp = $('#fDesig'); const list = $('#fDesigList');
    function renderList() {
      const q = inp.value.toLowerCase().trim();
      let ds = desigs().filter(d => d.status !== 'inactive');
      const match = ds.filter(d => d.name.toLowerCase().includes(q));
      let h = match.map(d => `<div class="it" data-id="${d.id}"><span>${esc(d.name)}</span><span class="meta">${esc(deptName(d.departmentId))} · ${userCount(d.id)} users</span></div>`).join('');
      const exact = ds.find(d => d.name.toLowerCase() === q);
      if (q && !exact) h += `<div class="it new" data-new="1">${ic('plus')}Create “${esc(inp.value.trim())}”</div>`;
      list.innerHTML = h || `<div class="it" style="color:var(--faint);cursor:default">No designations</div>`;
      list.classList.add('on');
      list.querySelectorAll('.it[data-id]').forEach(it => it.onmousedown = (e) => { e.preventDefault(); draft.designationId = it.dataset.id; inp.value = desigName(it.dataset.id); list.classList.remove('on'); syncDeptFromDesig(); });
      const nw = list.querySelector('[data-new]'); if (nw) nw.onmousedown = (e) => { e.preventDefault(); list.classList.remove('on'); quickDesig(inp.value.trim()); };
    }
    inp.onfocus = renderList; inp.oninput = renderList;
    inp.onblur = () => setTimeout(() => list.classList.remove('on'), 180);
  }
  function syncDeptFromDesig() { const d = desigById(draft.designationId); const sel = $('#fDept'); if (d && sel) sel.value = d.departmentId; }
  function userCount(desigId) { return users().filter(u => u.designationId === desigId).length; }
  function readImg(e, cb) { const f = e.target.files[0]; if (!f) return; if (f.size > 1.2e6) { toast('Image too large (max ~1.2 MB)'); return; } const r = new FileReader(); r.onload = () => cb(r.result); r.readAsDataURL(f); }

  /* quick "create designation" modal launched from the combo */
  function quickDesig(presetName) {
    const deptOpts = depts().map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    const reportOpts = `<option value="">— Top level —</option>` + desigs().map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    openOv('modal', `
      <div class="erp-dh"><div><h3>Create Designation</h3><div class="sub">Added instantly — no page refresh</div></div><button class="erp-x" onclick="ERP._reopenDrawerFromQuick()">×</button></div>
      <div class="erp-dbody"><div class="erp-fgrid">
        <div class="full"><label class="erp-flbl">Designation Name <span class="req">*</span></label><input class="erp-fin" id="qdName" value="${esc(presetName || '')}" placeholder="e.g. Senior Commercial Engineer"></div>
        <div><label class="erp-flbl">Department</label><select class="erp-fsel" id="qdDept">${deptOpts}</select></div>
        <div><label class="erp-flbl">Reports To</label><select class="erp-fsel" id="qdReports">${reportOpts}</select></div>
        <div class="full"><label class="erp-flbl">Description</label><textarea class="erp-fta" id="qdDesc" placeholder="What this role does…"></textarea></div>
        <div class="full"><label class="erp-toggle"><input type="checkbox" id="qdActive" checked><span class="tk"></span><span class="tl">Active</span></label></div>
      </div></div>
      <div class="erp-dfoot"><span class="msg" id="qdMsg"></span><button class="erp-btn" onclick="ERP._reopenDrawerFromQuick()">Cancel</button><button class="erp-btn primary" onclick="ERP._createDesigInline()">${ic('plus')}Create & Select</button></div>
    `);
    setTimeout(() => { const n = $('#qdName'); if (n) n.focus(); }, 60);
  }

  /* ════════════════════════════════════════════════════════════════════
     DESIGNATIONS
     ════════════════════════════════════════════════════════════════════ */
  VIEWS.designations = function () {
    const ds = desigs().slice().sort((a, b) => (a.level || 9) - (b.level || 9) || a.name.localeCompare(b.name));
    const rows = ds.map(d => `<tr>
      <td><div class="nm">${esc(d.name)}</div><div style="font-size:10.5px;color:var(--faint);margin-top:1px">${esc(d.description || '')}</div></td>
      <td>${esc(deptName(d.departmentId))}</td>
      <td>${d.reportsTo ? esc(desigName(d.reportsTo)) : '<span style="color:var(--faint)">Top level</span>'}</td>
      <td><span class="erp-tag">L${d.level || '—'}</span></td>
      <td class="num">${userCount(d.id)}</td>
      <td>${d.status === 'inactive' ? '<span class="erp-badge mute">Disabled</span>' : '<span class="erp-badge ok">Active</span>'}</td>
      <td class="acts">
        <button type="button" class="erp-btn ghost icon" title="Edit ${esc(d.name)}" aria-label="Edit ${esc(d.name)}" onclick="ERP.editDesig('${d.id}')">${ic('edit')}</button>
        <button type="button" class="erp-btn ghost icon" data-rowmenu title="More actions" aria-label="More actions for ${esc(d.name)}" aria-haspopup="menu" onclick="ERP._desigMenu(event,'${d.id}')">${ic('dots')}</button>
      </td></tr>`).join('');
    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">Designations${localBadge()}</h1><div class="erp-sub">${ds.length} job titles across ${depts().length} departments, with their reporting line.</div></div>
        <div class="acts"><button class="erp-btn primary" onclick="ERP.editDesig('')">${ic('plus')}New designation</button></div></div>
      <div class="erp-card"><div class="erp-tbl-wrap"><table class="erp-tbl">
        <thead><tr><th class="nosort">Designation</th><th class="nosort">Department</th><th class="nosort">Reports To</th><th class="nosort">Level</th><th class="nosort num">Users</th><th class="nosort">Status</th><th class="nosort"><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Actions</span></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7"><div class="erp-empty"><b>No designations yet</b>Create the job titles people hold.</div></td></tr>`}</tbody></table></div></div>
      <h2 class="erp-h2">Reporting hierarchy</h2><div class="erp-sub">Main reporting line, top to bottom.</div>
      ${hierarchyChain()}`;
  };
  function hierarchyChain() {
    const chain = ['Director', 'General Manager', 'Project Manager', 'Commercial Manager', 'Senior QS', 'QS Engineer'];
    const items = chain.map(n => desigs().find(d => d.name === n)).filter(Boolean);
    return `<div class="erp-card"><div class="erp-card-body"><div class="erp-flow">${items.map((d, i) => `<div class="erp-step"><div class="erp-stepbox"><div class="lv">Level ${d.level}</div><div class="nm">${esc(d.name)}</div><div class="dp">${userCount(d.id)} users</div></div>${i < items.length - 1 ? `<div class="erp-arrow">${ic('chevR')}</div>` : ''}</div>`).join('')}</div></div></div>`;
  }
  function desigEditor(editId) {
    const d = editId ? desigById(editId) : null;
    const deptOpts = depts().map(x => `<option value="${x.id}" ${d && d.departmentId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    const reportOpts = `<option value="">— Top level —</option>` + desigs().filter(x => x.id !== editId).map(x => `<option value="${x.id}" ${d && d.reportsTo === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    openOv('modal', `
      <div class="erp-dh"><div><h3>${d ? 'Edit Designation' : 'New Designation'}</h3><div class="sub">${d ? esc(d.name) : 'Define a role and its place in the hierarchy'}</div></div><button class="erp-x" onclick="ERP._closeOv()">×</button></div>
      <div class="erp-dbody"><div class="erp-fgrid">
        <div class="full"><label class="erp-flbl">Designation Name <span class="req">*</span></label><input class="erp-fin" id="dgName" value="${d ? esc(d.name) : ''}" placeholder="e.g. Senior Commercial Engineer"></div>
        <div><label class="erp-flbl">Department</label><select class="erp-fsel" id="dgDept">${deptOpts}</select></div>
        <div><label class="erp-flbl">Reports To</label><select class="erp-fsel" id="dgReports">${reportOpts}</select></div>
        <div><label class="erp-flbl">Hierarchy Level</label><input class="erp-fin" id="dgLevel" type="number" min="1" max="10" value="${d ? (d.level || 5) : 5}"></div>
        <div><label class="erp-flbl">Status</label><select class="erp-fsel" id="dgStatus"><option value="active" ${d && d.status === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${d && d.status === 'inactive' ? 'selected' : ''}>Disabled</option></select></div>
        <div class="full"><label class="erp-flbl">Description</label><textarea class="erp-fta" id="dgDesc" placeholder="Role summary…">${d ? esc(d.description || '') : ''}</textarea></div>
      </div></div>
      <div class="erp-dfoot"><span class="msg" id="dgMsg"></span><button class="erp-btn" onclick="ERP._closeOv()">Cancel</button><button class="erp-btn primary" onclick="ERP._saveDesig('${editId || ''}')">${ic('check')}${d ? 'Save' : 'Create'}</button></div>`);
    setTimeout(() => { const n = $('#dgName'); if (n) n.focus(); }, 60);
  }

  /* ════════════════════════════════════════════════════════════════════
     DEPARTMENTS
     ════════════════════════════════════════════════════════════════════ */
  VIEWS.departments = function () {
    const rows = depts().map(d => {
      const head = users().find(u => u.designationId && desigById(u.designationId) && desigById(u.designationId).departmentId === d.id && (desigById(u.designationId).level || 9) <= 4);
      return `<tr>
        <td><div class="nm">${esc(d.name)}</div></td>
        <td class="mono">${esc(d.code || '—')}</td>
        <td>${head ? `<div class="erp-cellname">${avatar(head, 24)}<span style="font-size:12px">${esc(head.name)}</span></div>` : '<span style="color:var(--faint)">—</span>'}</td>
        <td class="num">${users().filter(u => u.departmentId === d.id).length}</td>
        <td class="num">${desigs().filter(x => x.departmentId === d.id).length}</td>
        <td>${d.status === 'inactive' ? '<span class="erp-badge mute">Disabled</span>' : '<span class="erp-badge ok">Active</span>'}</td>
        <td class="acts"><button type="button" class="erp-btn ghost icon" title="Edit ${esc(d.name)}" aria-label="Edit ${esc(d.name)}" onclick="ERP.editDept('${d.id}')">${ic('edit')}</button><button type="button" class="erp-btn ghost icon danger" title="Delete ${esc(d.name)}" aria-label="Delete ${esc(d.name)}" onclick="ERP._delDept('${d.id}')">${ic('trash')}</button></td>
      </tr>`;
    }).join('');
    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">Departments${localBadge()}</h1><div class="erp-sub">${depts().length} departments, used by users and designations.</div></div>
        <div class="acts"><button class="erp-btn primary" onclick="ERP.editDept('')">${ic('plus')}New department</button></div></div>
      <div class="erp-card"><div class="erp-tbl-wrap"><table class="erp-tbl">
        <thead><tr><th class="nosort">Department</th><th class="nosort">Code</th><th class="nosort">Head</th><th class="nosort num">Users</th><th class="nosort num">Designations</th><th class="nosort">Status</th><th class="nosort"><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Actions</span></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7"><div class="erp-empty"><b>No departments yet</b></div></td></tr>`}</tbody></table></div></div>`;
  };
  function deptEditor(editId) {
    const d = editId ? depts().find(x => x.id === editId) : null;
    openOv('modal', `
      <div class="erp-dh"><div><h3>${d ? 'Edit Department' : 'New Department'}</h3></div><button class="erp-x" onclick="ERP._closeOv()">×</button></div>
      <div class="erp-dbody"><div class="erp-fgrid">
        <div><label class="erp-flbl">Department Name <span class="req">*</span></label><input class="erp-fin" id="dpName" value="${d ? esc(d.name) : ''}" placeholder="e.g. Planning"></div>
        <div><label class="erp-flbl">Code</label><input class="erp-fin mono" id="dpCode" value="${d ? esc(d.code || '') : ''}" placeholder="PLN"></div>
        <div class="full"><label class="erp-flbl">Status</label><select class="erp-fsel" id="dpStatus"><option value="active" ${d && d.status !== 'inactive' ? 'selected' : ''}>Active</option><option value="inactive" ${d && d.status === 'inactive' ? 'selected' : ''}>Disabled</option></select></div>
      </div></div>
      <div class="erp-dfoot"><span class="msg" id="dpMsg"></span><button class="erp-btn" onclick="ERP._closeOv()">Cancel</button><button class="erp-btn primary" onclick="ERP._saveDept('${editId || ''}')">${ic('check')}${d ? 'Save' : 'Create'}</button></div>`);
    setTimeout(() => { const n = $('#dpName'); if (n) n.focus(); }, 60);
  }
  function projectEditor(editId) {
    const p = editId ? projects().find(x => x.id === editId) : null;
    const mgrOpts = '<option value="">— Unassigned —</option>' + users().map(u =>
      `<option value="${u.id}" ${p && p.managerId === u.id ? 'selected' : ''}>${esc(u.name)} · ${esc(desigName(u.designationId))}</option>`).join('');
    openOv('modal', `
      <div class="erp-dh"><div><h3>${p ? 'Edit Project' : 'New Project'}</h3></div><button class="erp-x" onclick="ERP._closeOv()">×</button></div>
      <div class="erp-dbody"><div class="erp-fgrid">
        <div><label class="erp-flbl">Project Name <span class="req">*</span></label><input class="erp-fin" id="prName" value="${p ? esc(p.name) : ''}" placeholder="e.g. Aaranya Phase 2"></div>
        <div><label class="erp-flbl">Project Code</label><input class="erp-fin mono" id="prCode" value="${p ? esc(p.code || '') : ''}" placeholder="e.g. ARNY2"></div>
        <div><label class="erp-flbl">Client</label><input class="erp-fin" id="prClient" value="${p ? esc(p.client || '') : ''}" placeholder="Client / owner name"></div>
        <div><label class="erp-flbl">Location</label><input class="erp-fin" id="prLocation" value="${p ? esc(p.location || '') : ''}" placeholder="Site location"></div>
        <div><label class="erp-flbl">Project Manager</label><select class="erp-fsel" id="prManager">${mgrOpts}</select></div>
        <div><label class="erp-flbl">Status</label><select class="erp-fsel" id="prStatus"><option value="active" ${!p || p.status !== 'inactive' ? 'selected' : ''}>Active</option><option value="inactive" ${p && p.status === 'inactive' ? 'selected' : ''}>Closed</option></select></div>
        <div><label class="erp-flbl">Start Date</label><input class="erp-fin" type="date" id="prStart" value="${p && p.startDate ? p.startDate : ''}"></div>
        <div><label class="erp-flbl">Target Completion</label><input class="erp-fin" type="date" id="prEnd" value="${p && p.endDate ? p.endDate : ''}"></div>
      </div></div>
      <div class="erp-dfoot"><span class="msg" id="prMsg"></span><button class="erp-btn" onclick="ERP._closeOv()">Cancel</button><button class="erp-btn primary" onclick="ERP._saveProject('${editId || ''}')">${ic('check')}${p ? 'Save' : 'Create'}</button></div>`);
    setTimeout(() => { const n = $('#prName'); if (n) n.focus(); }, 60);
  }

  /* ════════════════════════════════════════════════════════════════════
     PROJECTS
     ════════════════════════════════════════════════════════════════════ */
  VIEWS.projects = function () {
    const masterRows = projects().map(p => `<tr>
        <td><div class="nm">${esc(p.name)}</div></td>
        <td class="mono">${esc(p.code || '—')}</td>
        <td>${esc(p.client || '—')}</td>
        <td>${esc(p.location || '—')}</td>
        <td>${p.managerId && userById(p.managerId) ? esc(userName(p.managerId)) : '<span style="color:var(--faint)">—</span>'}</td>
        <td>${p.status === 'inactive' ? '<span class="erp-badge mute">Closed</span>' : '<span class="erp-badge ok">Active</span>'}</td>
        <td class="acts"><button type="button" class="erp-btn ghost icon" title="Edit ${esc(p.name)}" aria-label="Edit ${esc(p.name)}" onclick="ERP.editProject('${p.id}')">${ic('edit')}</button><button type="button" class="erp-btn ghost icon danger" title="Delete ${esc(p.name)}" aria-label="Delete ${esc(p.name)}" onclick="ERP._delProject('${p.id}')">${ic('trash')}</button></td>
      </tr>`).join('');
    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">Projects${localBadge()}</h1><div class="erp-sub">${projects().length} project${projects().length === 1 ? '' : 's'} in the project master list.</div></div>
        <div class="acts"><button class="erp-btn primary" onclick="ERP.editProject('')">${ic('plus')}New project</button></div></div>
      <div class="erp-card"><div class="erp-tbl-wrap"><table class="erp-tbl">
        <thead><tr><th class="nosort">Project</th><th class="nosort">Code</th><th class="nosort">Client</th><th class="nosort">Location</th><th class="nosort">Project Manager</th><th class="nosort">Status</th><th class="nosort"></th></tr></thead>
        <tbody>${masterRows || `<tr><td colspan="7"><div class="erp-empty"><b>No projects yet</b><button class="erp-btn primary sm" onclick="ERP.editProject('')">${ic('plus')}New project</button></div></td></tr>`}</tbody></table></div></div>`;
  };
  /* ════════════════════════════════════════════════════════════════════
     PASSWORDS & LOCKED ACCOUNTS  (only settings the app actually applies)
     ════════════════════════════════════════════════════════════════════ */
  VIEWS.security = function () {
    const p = policy();
    const u = users();
    const blocked = u.filter(x => x.status === 'locked' || x.platformAccess === false);
    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">Passwords &amp; Lockouts${localBadge()}</h1><div class="erp-sub">${blocked.length} locked or restricted account${blocked.length === 1 ? '' : 's'}.</div></div></div>
      <div class="erp-note">${ic('security')}<div>The minimum length applies whenever a password is set in Administration. ${SERVER() ? 'Sign-in sessions are controlled by the server (30 min idle, 12 h maximum).' : ''}</div></div>
      <div class="erp-grid2">
        <div class="erp-card"><div class="erp-card-head"><div class="ttl">Password rule</div><button class="erp-btn sm primary" id="pSave" onclick="ERP._savePolicy()">${ic('check')}Save</button></div><div class="erp-card-body">
          <label class="erp-flbl" for="pMin">Minimum password length</label><input class="erp-fin mono" id="pMin" type="number" min="6" max="64" value="${p.minLen || 8}" style="max-width:160px">
        </div></div>
        <div class="erp-card"><div class="erp-card-head"><div class="ttl">Locked / Restricted</div></div><div class="erp-card-body" style="padding:6px 0">
          ${blocked.map(x => `<div class="erp-act" style="padding:11px 16px"><div class="dot" style="background:color-mix(in srgb,var(--red) 16%,transparent)">${ic('lock').replace('<svg', '<svg style="stroke:var(--red)"')}</div><div class="txt"><div class="a">${esc(x.name)}</div><div class="m">${esc(x.lockReason || (x.platformAccess === false ? 'Platform access disabled' : 'Locked'))}</div></div><button class="erp-btn sm" onclick="ERP.unlockUser('${x.id}')">${ic('unlock')}Unlock</button></div>`).join('') || '<div class="erp-empty">No locked accounts</div>'}
        </div></div>
      </div>`;
  };

  /* ════════════════════════════════════════════════════════════════════
     AUDIT TRAIL  (read-only)
     ════════════════════════════════════════════════════════════════════ */
  VIEWS.audit = function () {
    let a = audit();
    if (S.auditQ) { const q = S.auditQ.toLowerCase(); a = a.filter(x => ((x.action || '') + (x.target || '') + (x.admin || '') + (x.module || '')).toLowerCase().includes(q)); }
    if (S.auditMod) a = a.filter(x => x.module === S.auditMod);
    const modOpts = `<option value="">All Modules</option>` + [...new Set(audit().map(x => x.module))].map(m => `<option value="${m}" ${S.auditMod === m ? 'selected' : ''}>${esc(m)}</option>`).join('');
    const rows = a.slice(0, 200).map(x => `<tr>
      <td class="mono" style="font-size:10.5px;white-space:nowrap">${fmtDT(x.ts)}</td>
      <td><span class="erp-tag">${esc(x.module)}</span></td>
      <td><div class="nm">${esc(x.action)}</div>${x.target ? `<div style="font-size:10.5px;color:var(--faint)">${esc(x.target)}</div>` : ''}</td>
      <td style="font-size:11.5px">${esc(x.admin)}</td>
      <td style="font-size:11px;color:var(--faint);max-width:160px">${x.oldVal ? esc(x.oldVal) : '<span style="opacity:.4">—</span>'}</td>
      <td style="font-size:11px;color:var(--ink);max-width:160px">${x.newVal ? esc(x.newVal) : (x.reason ? esc(x.reason) : '<span style="opacity:.4">—</span>')}</td>
      <td style="font-size:11.5px;color:var(--faint)">${esc(x.browser || '—')}</td>
    </tr>`).join('');
    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">Audit Trail${localBadge()}</h1><div class="erp-sub">${audit().length} entr${audit().length === 1 ? 'y' : 'ies'} recorded by Administration, newest first (last 800 kept).${SERVER() ? ' Enquiry, quotation and approval history is kept by the server under Audit &amp; Logs.' : ''}</div></div>
        <div class="acts"><button class="erp-btn" onclick="ERP._exportAudit()">${ic('download')}Export CSV</button></div></div>
      <div class="erp-toolbar">
        <div class="erp-field"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON.search}</svg><input class="erp-input" id="audSearch" type="search" aria-label="Search the audit trail" placeholder="Search action, user, target…" value="${esc(S.auditQ)}"></div>
        <select class="erp-select" id="audMod" aria-label="Filter by module">${modOpts}</select>
        ${S.auditQ || S.auditMod ? '<button type="button" class="erp-btn ghost" onclick="ERP._audClear()">Clear filters</button>' : ''}
        ${a.length > 200 ? `<span style="font-size:12px;color:var(--faint)">Showing the newest 200 of ${a.length} — export for the full list</span>` : ''}
      </div>
      <div class="erp-card"><div class="erp-tbl-wrap"><table class="erp-tbl">
        <thead><tr><th class="nosort">Date & Time</th><th class="nosort">Module</th><th class="nosort">Action</th><th class="nosort">By</th><th class="nosort">Before</th><th class="nosort">After</th><th class="nosort">Browser</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7"><div class="erp-empty">${ic('audit')}<b>${audit().length ? 'No entries match' : 'Nothing recorded yet'}</b>${audit().length ? 'Try a different search or module.' : 'Changes made in Administration appear here.'}</div></td></tr>`}</tbody></table></div></div>`;
  };
  BIND.audit = function () {
    const s = $('#audSearch'); if (s) s.oninput = e => { S.auditQ = e.target.value; const p = e.target.selectionStart; renderMain(); const n = $('#audSearch'); if (n) { n.focus(); n.setSelectionRange(p, p); } };
    const m = $('#audMod'); if (m) m.onchange = e => { S.auditMod = e.target.value; renderMain(); };
  };

  /* ════════════════════════════════════════════════════════════════════
     NOTIFICATIONS
     ════════════════════════════════════════════════════════════════════ */
  VIEWS.notifications = function () {
    let n = notifs();
    if (S.notifFilter === 'unread') n = n.filter(x => !x.read);
    const map = { perm: ['var(--accent)', 'perm'], lock: ['var(--red)', 'lock'], tender: ['var(--green)', 'check'], boq: ['var(--blue)', 'dept'], vendor: ['var(--violet)', 'user'], wo: ['var(--accent2)', 'flow'], user: ['var(--blue)', 'user'] };
    const rows = n.map(x => { const m = map[x.type] || ['var(--faint)', 'bell']; return `<div class="erp-notif ${x.read ? '' : 'unread'}" role="button" tabindex="0" aria-label="${esc(x.title)}${x.read ? '' : ' (unread)'}" onclick="ERP._readNotif('${x.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}"><div class="nd" style="background:color-mix(in srgb,${m[0]} 16%,transparent)">${ic(m[1]).replace('<svg', '<svg style="stroke:' + m[0] + '"')}</div><div style="flex:1"><div class="ttl">${esc(x.title)}${x.read ? '' : '<span class="ud"></span>'}</div><div class="ms">${esc(x.msg)}</div><div class="tm">${ago(x.ts)}</div></div></div>`; }).join('');
    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">Notifications${localBadge()}</h1><div class="erp-sub">${notifs().filter(x => !x.read).length} unread of ${notifs().length}. Raised by administrative changes such as locks and new users.</div></div>
        <div class="acts">${notifs().some(x => !x.read) ? `<button class="erp-btn" onclick="ERP._readAll()">${ic('check')}Mark all read</button>` : ''}</div></div>
      <div class="erp-toolbar"><div class="erp-seg" id="nFilter"><button class="${S.notifFilter === 'all' ? 'on' : ''}" data-f="all">All</button><button class="${S.notifFilter === 'unread' ? 'on' : ''}" data-f="unread">Unread</button></div></div>
      <div class="erp-card">${rows || `<div class="erp-empty">${ic('bell')}<b>${S.notifFilter === 'unread' ? 'No unread notifications' : 'No notifications yet'}</b></div>`}</div>`;
  };
  BIND.notifications = function () { document.querySelectorAll('#nFilter button').forEach(b => b.onclick = () => { S.notifFilter = b.dataset.f; renderMain(); }); };

  /* ════════════════════════════════════════════════════════════════════
     ORGANIZATION HIERARCHY
     ════════════════════════════════════════════════════════════════════ */
  const orgOpen = {};
  VIEWS.organization = function () {
    const kind = (txt, color) => `<span class="erp-tkind" style="color:${color};background:color-mix(in srgb,${color} 15%,transparent)">${txt}</span>`;
    let h = '';
    companies().forEach(co => {
      const cid = 'co_' + co.id; const op = orgOpen[cid] !== false;
      h += `<div class="erp-tnode"><div class="erp-trow"><span class="erp-tcaret" onclick="ERP._orgT('${cid}')">${op ? '▾' : '▸'}</span>${kind('Company', 'var(--accent)')}<b style="color:var(--ink)">${esc(co.name)}</b><span style="color:var(--faint);font-size:11px">${esc(co.code)}</span></div>`;
      if (op) {
        h += `<div class="erp-tkids">`;
        branches().filter(b => b.companyId === co.id).forEach(br => {
          const bid = 'br_' + br.id; const bop = orgOpen[bid];
          const brUsers = users().filter(u => u.branchId === br.id);
          h += `<div class="erp-tnode"><div class="erp-trow"><span class="erp-tcaret" onclick="ERP._orgT('${bid}')">${bop ? '▾' : '▸'}</span>${kind('Branch', 'var(--blue)')}<b style="color:var(--ink)">${esc(br.name)}</b><span style="color:var(--faint);font-size:11px">${brUsers.length} staff</span></div>`;
          if (bop) {
            h += `<div class="erp-tkids">`;
            depts().forEach(dp => {
              const du = brUsers.filter(u => u.departmentId === dp.id); if (!du.length) return;
              const did = 'dp_' + br.id + dp.id; const dop = orgOpen[did];
              h += `<div class="erp-tnode"><div class="erp-trow"><span class="erp-tcaret" onclick="ERP._orgT('${did}')">${dop ? '▾' : '▸'}</span>${kind('Dept', 'var(--green)')}<span style="color:var(--ink);font-weight:600">${esc(dp.name)}</span><span style="color:var(--faint);font-size:11px">${du.length}</span></div>`;
              if (dop) { h += `<div class="erp-tkids">` + du.sort((a, b) => (desigById(a.designationId) || {}).level - (desigById(b.designationId) || {}).level).map(u => `<div class="erp-trow">${avatar(u, 24)}<span style="color:var(--ink)">${esc(u.name)}</span>${kind(desigName(u.designationId), 'var(--violet)')}${u.status !== 'active' ? statusBadge(u.status) : ''}</div>`).join('') + `</div>`; }
              h += `</div>`;
            });
            h += `</div>`;
          }
          h += `</div>`;
        });
        h += `</div>`;
      }
      h += `</div>`;
    });
    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">Organization${localBadge()}</h1><div class="erp-sub">Company › branch › department › people. Expand a level to see who sits under it.</div></div></div>
      <div class="erp-card"><div class="erp-card-body erp-tree">${h}</div></div>`;
  };

  /* ════════════════════════════════════════════════════════════════════
     SYSTEM & DATA — one place for tools that already existed elsewhere:
     workspace backup / restore (its links lived on the old landing page and
     became unreachable when that page was replaced by the dashboard), Excel
     import, theme, AI provider settings and login history. Every button
     calls the existing implementation; nothing is re-done here.
     ════════════════════════════════════════════════════════════════════ */
  VIEWS.system = function () {
    const server = SERVER();
    const sess = (window.TSApi && window.TSApi.session) || null;
    let bytes = 0; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); bytes += ((localStorage.getItem(k) || '').length + k.length) * 2; } } catch (e) {}
    const mb = (bytes / 1048576).toFixed(2);
    const syncTxt = (document.getElementById('tsSyncTxt') || {}).textContent || '';
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    let ai = null; try { ai = (typeof AI !== 'undefined' && AI && typeof AI.hasKey === 'function') ? AI.hasKey() : null; } catch (e) {}
    const has = (id) => !!document.getElementById(id);
    const hasBackup = !!(window.TSBackup && window.TSBackup.backup);
    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">System &amp; Data</h1><div class="erp-sub">Where data is kept, backups, imports and app preferences.</div></div></div>
      <div class="erp-grid2">
        <div>
          <div class="erp-card"><div class="erp-card-head"><div class="ttl">Storage &amp; sync</div></div>
            <div class="erp-card-body erp-kv">
              <div class="r"><span class="k">User accounts &amp; sign-in</span><span class="v">${server ? 'Server' : 'This browser only'}</span></div>
              <div class="r"><span class="k">Enquiries, quotations, work orders</span><span class="v">${server ? 'Server (cached in this browser)' : 'This browser only'}</span></div>
              <div class="r"><span class="k">Admin master data &amp; audit trail</span><span class="v">This browser only</span></div>
              ${server && sess ? `<div class="r"><span class="k">Signed in as</span><span class="v">${esc(sess.name || sess.username || '')}${sess.role ? ' · ' + esc(sess.role) : ''}</span></div>` : ''}
              ${syncTxt ? `<div class="r"><span class="k">Sync status</span><span class="v">${esc(syncTxt)}</span></div>` : ''}
              <div class="r"><span class="k">Browser storage used</span><span class="v">${mb} MB</span></div>
            </div></div>
          <div class="erp-card"><div class="erp-card-head"><div class="ttl">Backup &amp; restore</div></div>
            <div class="erp-card-body">
              <p style="margin:0 0 12px;font-size:12.5px;color:var(--dim);line-height:1.55">Downloads everything this browser holds for the app as a JSON file — including saved settings such as the AI provider key, so keep the file private.${server ? ' Restoring replaces this browser\'s copy; at the next sync it is merged with the server, so restored records can reach the server.' : ' Restoring replaces the data in this browser.'}</p>
              ${hasBackup ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="erp-btn" onclick="TSBackup.backup()">${ic('download')}Download backup</button><button class="erp-btn" onclick="TSBackup.restore()">Restore from file…</button></div>` : '<div class="erp-fhint">Backup is not available in this build.</div>'}
            </div></div>
        </div>
        <div>
          <div class="erp-card"><div class="erp-card-head"><div class="ttl">Import</div></div>
            <div class="erp-card-body">
              <p style="margin:0 0 12px;font-size:12.5px;color:var(--dim);line-height:1.55">Bring a BOQ in from Excel or CSV. A BOQ can also be opened straight into the BOQ Builder from its File menu.</p>
              ${has('topImportBtn') ? `<button class="erp-btn" onclick="document.getElementById('topImportBtn').click()">${ic('download')}Import from Excel…</button>` : ''}
            </div></div>
          <div class="erp-card"><div class="erp-card-head"><div class="ttl">Preferences</div></div>
            <div class="erp-card-body erp-kv">
              <div class="r"><span class="k">Theme <span style="color:var(--faint)">(this browser)</span></span><span class="v"><span class="erp-seg" id="sysTheme" role="group" aria-label="Theme"><button type="button" data-t="light" class="${light ? 'on' : ''}" aria-pressed="${light}">Light</button><button type="button" data-t="dark" class="${light ? '' : 'on'}" aria-pressed="${!light}">Dark</button></span></span></div>
              ${has('topGemBtn') ? `<div class="r"><span class="k">AI description provider</span><span class="v">${ai == null ? '' : (ai ? '<span class="erp-badge ok">Configured</span> ' : '<span class="erp-badge mute">Not set up</span> ')}<button class="erp-btn sm" onclick="document.getElementById('topGemBtn').click()">Settings…</button></span></div>` : ''}
              ${window.Auth && typeof window.Auth._hist === 'function' ? `<div class="r"><span class="k">Sign-in history</span><span class="v"><button class="erp-btn sm" onclick="ERP._loginHist()">View…</button></span></div>` : ''}
            </div></div>
        </div>
      </div>`;
  };
  BIND.system = function () {
    document.querySelectorAll('#sysTheme button').forEach(b => b.onclick = () => {
      const want = b.dataset.t, now = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      if (want !== now) { const t = document.getElementById('themeTog'); if (t) t.click(); }
      renderMain();
    });
  };

  /* ════════════════════════════════════════════════════════════════════
     MAJOR TERMS — master versions of the 35 standard contract clauses.
     The data lives in the enquiry database (QM), which is synced to the
     server, not in this browser's admin storage. An import never edits an
     existing version: it adds a new one, and every enquiry keeps the version
     it was created with.
     ════════════════════════════════════════════════════════════════════ */
  let mtView = null;            // version being viewed (null = current)
  const QMok = () => !!(window.QM && typeof window.QM.mtInfo === 'function');
  VIEWS.majorterms = function () {
    if (!QMok()) return `<div class="erp-sec-head"><div><h1 class="erp-h">Major Terms</h1></div></div><div class="erp-note warn">${ic('security')}<div>The enquiry module has not loaded, so the master terms cannot be shown. Reload the page and try again.</div></div>`;
    const info = window.QM.mtInfo();
    const show = mtView || info.current;
    const ver = window.QM.mtVersion(show) || window.QM.mtVersion(info.current);
    const secs = window.QM.mtSections || [];
    const secOf = (sl) => secs.find(s => sl >= s[2] && sl <= s[3]) || ['O', 'Other clauses', 0, 0];
    const groups = {}; ver.clauses.forEach(c => { const s = secOf(c.sl); (groups[s[0]] = groups[s[0]] || { s, cs: [] }).cs.push(c); });
    const rows = info.versions.slice().reverse().map(x => `<tr${x.v === show ? ' class="sel"' : ''}>
        <td class="mono">v${x.v}</td>
        <td><div class="nm">${esc(x.source || '—')}</div>${x.title ? `<div class="sub2">${esc(x.title)}</div>` : ''}${x.note ? `<div class="sub2">${esc(x.note)}</div>` : ''}</td>
        <td style="white-space:nowrap">${x.ts ? fmtDT(x.ts) : 'Built in'}${x.by ? `<div class="sub2">${esc(x.by)}</div>` : ''}</td>
        <td class="num">${x.count}</td><td class="num">${x.enquiries}</td>
        <td>${x.v === info.current ? '<span class="erp-badge ok">Current</span>' : '<span class="erp-badge mute">Kept</span>'}</td>
        <td class="acts"><button type="button" class="erp-btn sm ghost" onclick="ERP._mtShow(${x.v})">${x.v === show ? 'Viewing' : 'View'}</button></td></tr>`).join('');
    const clauses = Object.keys(groups).map(k => `<details class="erp-card"${k === 'A' ? ' open' : ''}><summary>${k === 'O' ? '' : 'Section ' + k + ' — '}${esc(groups[k].s[1])}<span>${groups[k].cs.length} clauses</span></summary>
        <div class="erp-tbl-wrap" style="max-height:none"><table class="erp-tbl"><thead><tr><th class="nosort" style="width:44px">#</th><th class="nosort" style="width:220px">Major clause</th><th class="nosort">Primarc standard terms</th><th class="nosort" style="width:160px">Contractor acceptance</th></tr></thead><tbody>
        ${groups[k].cs.map(c => `<tr><td class="mono">${c.sl}</td><td class="nm" style="white-space:pre-wrap">${esc(c.heading)}</td><td style="white-space:pre-wrap;line-height:1.5;color:var(--ink)">${esc(c.text)}</td><td style="white-space:pre-wrap">${c.acceptance ? esc(c.acceptance) : '<span style="color:var(--faint)">blank</span>'}</td></tr>`).join('')}
        </tbody></table></div></details>`).join('');
    return `
      <div class="erp-sec-head"><div><h1 class="erp-h">Major Terms</h1><div class="erp-sub">The standard contract clauses loaded into every new enquiry, where they can be edited for that enquiry. Importing creates a new version; enquiries already created keep the version they were made with.</div></div>
        <div class="acts">${window.QM.mtIsAdmin() ? `<label class="erp-btn primary" style="cursor:pointer" tabindex="0" role="button" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.querySelector('input').click()}">${ic('download')}Import from Excel…<input type="file" id="mtFile" accept=".xlsx,.xls" style="display:none"></label>` : ''}</div></div>
      <div class="erp-note">${ic('audit')}<div>Expected file: the <b>SUMMARY</b> sheet with columns <b>Sl No</b>, <b>Major Clauses</b>, <b>Primarc Standard Terms</b> and <b>Contractor Acceptance</b> — ${window.QM.mtVersion(1).clauses.length} clauses. You see every addition, change and missing clause before anything is saved. Text is taken exactly as written in the file.</div></div>
      <div class="erp-card"><div class="erp-card-head"><div class="ttl">Versions<span>newest first</span></div></div>
        <div class="erp-tbl-wrap" style="max-height:none"><table class="erp-tbl"><thead><tr><th class="nosort">Version</th><th class="nosort">Source</th><th class="nosort">Imported</th><th class="nosort num">Clauses</th><th class="nosort num">Enquiries using it</th><th class="nosort">Status</th><th class="nosort"></th></tr></thead><tbody>${rows}</tbody></table></div></div>
      <h2 class="erp-h2">Clauses in v${ver.v}${ver.v === info.current ? ' (current)' : ''}</h2><div class="erp-sub">${ver.clauses.length} clauses${ver.title ? ' · ' + esc(ver.title) : ''}</div>
      ${clauses}`;
  };
  BIND.majorterms = function () {
    const f = $('#mtFile'); if (!f) return;
    f.onchange = () => { const file = f.files && f.files[0]; f.value = ''; if (file) mtImportPreview(file); };
  };
  async function mtImportPreview(file) {
    if (typeof XLSX === 'undefined') { notice('Excel reader not loaded', 'The spreadsheet library has not loaded yet (it needs internet the first time). Wait a moment and try again.'); return; }
    let wb;
    try { wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' }); }
    catch (e) { notice('Could not read the file', '“' + file.name + '” could not be read as an Excel workbook: ' + ((e && e.message) || 'unknown error') + '.'); return; }
    const parsed = window.QM.mtParseWorkbook(wb);
    const info = window.QM.mtInfo(); const cur = window.QM.mtVersion(info.current);
    const d = window.QM.mtDiff(parsed.clauses, cur);
    const nChanges = d.added.length + d.changed.length + d.missing.length;
    const clip = (s) => { s = String(s || ''); return s.length > 260 ? s.slice(0, 260) + '…' : s; };
    const changed = d.changed.map(x => `<details class="erp-card"><summary>Clause ${x.c.sl} · ${esc(x.c.heading.trim())}<span>${x.f.join(', ')} changed</span></summary><div class="erp-card-body" style="font-size:12px;display:grid;gap:8px">
        ${x.f.map(k => `<div><div class="erp-flbl">${k === 'text' ? 'Terms' : k === 'heading' ? 'Heading' : 'Contractor acceptance'}</div><div style="white-space:pre-wrap;color:var(--red);text-decoration:line-through">${esc(clip(x.b[k])) || '<i>blank</i>'}</div><div style="white-space:pre-wrap;color:var(--green);margin-top:3px">${esc(clip(x.c[k])) || '<i>blank</i>'}</div></div>`).join('')}</div></details>`).join('');
    const list = (arr, lbl) => arr.length ? `<div class="erp-note${lbl === 'Missing from the file' ? ' warn' : ''}">${ic('audit')}<div><b>${lbl}:</b> ${arr.map(c => c.sl + ' ' + esc(c.heading.trim())).join(' · ')}</div></div>` : '';
    openOv('wide', `
      <div class="erp-dh"><div><h3>Import preview</h3><div class="sub">${esc(file.name)} · compared with the current master v${cur.v}</div></div><button class="erp-x" onclick="ERP._closeOv()" aria-label="Close">×</button></div>
      <div class="erp-dbody">
        ${parsed.errors.length ? `<div class="erp-note warn">${ic('security')}<div><b>This file cannot be imported:</b><ul style="margin:6px 0 0 16px">${parsed.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div></div>` : ''}
        ${parsed.warnings.map(w => `<div class="erp-note">${ic('audit')}<div>${esc(w)}</div></div>`).join('')}
        <div class="erp-tiles" style="grid-template-columns:repeat(4,minmax(0,1fr))">
          <div class="erp-tile"><div class="l">Clauses read</div><div class="n">${parsed.clauses.length}</div></div>
          <div class="erp-tile"><div class="l">Changed</div><div class="n">${d.changed.length}</div></div>
          <div class="erp-tile"><div class="l">Added</div><div class="n">${d.added.length}</div></div>
          <div class="erp-tile"><div class="l">Missing</div><div class="n">${d.missing.length}</div></div>
        </div>
        ${list(d.added, 'Added')}${list(d.missing, 'Missing from the file')}
        ${changed}
        ${!parsed.errors.length && !nChanges ? `<div class="erp-note">${ic('check')}<div>Identical to the current master v${cur.v} — there is nothing to import.</div></div>` : ''}
        ${!parsed.errors.length && nChanges ? `<label class="erp-flbl" for="mtNote" style="margin-top:12px">Note for this version <span style="color:var(--faint);font-weight:500">(optional)</span></label><input class="erp-fin" id="mtNote" placeholder="e.g. Revised LD and payment terms for FY 2027">
          <div class="erp-fhint">Saving creates master v${info.versions.length ? Math.max(...info.versions.map(x => x.v)) + 1 : 2} and makes it current for new enquiries. Existing enquiries and submitted quotations are not changed.</div>` : ''}
      </div>
      <div class="erp-dfoot"><span class="msg" id="mtMsg"></span><button class="erp-btn" onclick="ERP._closeOv()">Cancel</button><button class="erp-btn primary" id="mtApply" ${parsed.errors.length || !nChanges ? 'disabled' : ''}>${ic('check')}Create new version</button></div>`);
    const ap = $('#mtApply');
    if (ap) ap.onclick = () => {
      try { const v = window.QM.mtApplyImport(parsed, { file: file.name, note: val('mtNote').trim() }); logAudit({ module: 'Administration', action: 'Major Terms imported', target: 'v' + v, newVal: file.name }); closeOv(); mtView = null; toast('✓ Master terms v' + v + ' is now current'); renderMain(); }
      catch (e) { const m = $('#mtMsg'); if (m) { m.style.color = 'var(--red)'; m.textContent = e.message; } }
    };
  }
  window.ERP._mtShow = (v) => { mtView = v; renderMain(); };

  /* ════════════════════════════════════════════════════════════════════
     COMMAND PALETTE
     ════════════════════════════════════════════════════════════════════ */
  let cmdIdx = 0, cmdItems = [];
  function buildCmd(q) {
    q = (q || '').toLowerCase().trim();
    const items = [];
    NAV.filter(n => n.id || n.act || n.ext).forEach(n => { const lbl = n.id ? (TITLES[n.id] === 'Administration' ? 'Admin dashboard' : (TITLES[n.id] || n.label)) : n.label; if (!q || lbl.toLowerCase().includes(q)) items.push({ g: 'Navigate', label: lbl + (n.ext ? ' ↗' : ''), icon: n.icon, fn: () => { closeCmd(); if (n.id) go(n.id); else window.ERP._navAct(n.act || n.ext); } }); });
    const actions = [
      { label: 'Add User', icon: 'plus', fn: () => { closeCmd(); window.ERP.addUser(); } },
      { label: 'New Designation', icon: 'plus', fn: () => { closeCmd(); window.ERP.editDesig(''); } },
      { label: 'New Department', icon: 'plus', fn: () => { closeCmd(); window.ERP.editDept(''); } },
      { label: 'Export Audit Trail', icon: 'download', fn: () => { closeCmd(); window.ERP._exportAudit(); } }
    ];
    actions.forEach(a => { if (!q || a.label.toLowerCase().includes(q)) items.push(Object.assign({ g: 'Actions' }, a)); });
    if (q) users().filter(u => (u.name + u.username + u.email).toLowerCase().includes(q)).slice(0, 6).forEach(u => items.push({ g: 'Users', label: u.name, icon: 'user', meta: desigName(u.designationId), fn: () => { closeCmd(); S.view = 'users'; renderMain(); setTimeout(() => userDrawer(u.id), 60); } }));
    return items;
  }
  function ensureCmd() {
    let c = document.getElementById('erpCmd');
    if (!c) {
      c = document.createElement('div'); c.id = 'erpCmd';
      c.innerHTML = `<div class="box"><div class="ci"><svg viewBox="0 0 24 24">${ICON.search}</svg><input id="erpCmdIn" placeholder="Search or jump to…"></div><div class="res" id="erpCmdRes"></div></div>`;
      document.body.appendChild(c);
      c.addEventListener('mousedown', e => { if (e.target === c) closeCmd(); });
      const inp = c.querySelector('#erpCmdIn');
      inp.addEventListener('input', () => renderCmd(inp.value));
      inp.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); cmdIdx = Math.min(cmdItems.length - 1, cmdIdx + 1); hiCmd(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); cmdIdx = Math.max(0, cmdIdx - 1); hiCmd(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (cmdItems[cmdIdx]) cmdItems[cmdIdx].fn(); }
        else if (e.key === 'Escape') closeCmd();
      });
    }
    return c;
  }
  function renderCmd(q) {
    cmdItems = buildCmd(q); cmdIdx = 0;
    const res = document.getElementById('erpCmdRes');
    let h = '', lastG = '';
    cmdItems.forEach((it, i) => { if (it.g !== lastG) { h += `<div class="cg">${it.g}</div>`; lastG = it.g; } h += `<div class="ci-row ${i === 0 ? 'hi' : ''}" data-i="${i}">${ic(it.icon)}<span>${esc(it.label)}</span>${it.meta ? `<span class="meta">${esc(it.meta)}</span>` : ''}</div>`; });
    res.innerHTML = h || `<div class="erp-empty" style="padding:30px">No matches</div>`;
    res.querySelectorAll('.ci-row').forEach(r => { r.onmouseenter = () => { cmdIdx = +r.dataset.i; hiCmd(); }; r.onclick = () => cmdItems[+r.dataset.i].fn(); });
  }
  function hiCmd() { const res = document.getElementById('erpCmdRes'); if (!res) return; res.querySelectorAll('.ci-row').forEach((r, i) => r.classList.toggle('hi', i === cmdIdx)); const el = res.querySelector('.ci-row.hi'); if (el) el.scrollIntoViewIfNeeded ? el.scrollIntoViewIfNeeded() : null; }
  function openCmd() { const c = ensureCmd(); c.classList.add('on'); const inp = c.querySelector('#erpCmdIn'); inp.value = ''; renderCmd(''); setTimeout(() => inp.focus(), 30); }
  function closeCmd() { const c = document.getElementById('erpCmd'); if (c) c.classList.remove('on'); }
  window.__ERP_openCmd = openCmd;

  /* ════════════════════════════════════════════════════════════════════
     IMPORT / EXPORT
     ════════════════════════════════════════════════════════════════════ */
  function exportCSV(name, head, rows) {
    const esc2 = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const csv = [head.join(',')].concat(rows.map(r => r.map(esc2).join(','))).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = name + '-' + new Date().toISOString().slice(0, 10) + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  /* ════════════════════════════════════════════════════════════════════
     PUBLIC METHODS  (referenced by inline handlers)
     ════════════════════════════════════════════════════════════════════ */
  function persistUser(u) { const all = users(); const i = all.findIndex(x => x.id === u.id); if (i >= 0) all[i] = u; setUsers(all); }
  function syncSessionRole(u) { try { ['localStorage', 'sessionStorage'].forEach(st => { const raw = window[st].getItem('ts_session'); if (raw) { const s = JSON.parse(raw); if (s.uid === u.id) { s.name = u.name; s.role = u.role; window[st].setItem('ts_session', JSON.stringify(s)); } } }); } catch (e) {} }

  Object.assign(window.ERP, {
    addUser: () => userDrawer(''),
    editUser: (id) => userDrawer(id),
    editDesig: (id) => desigEditor(id),
    editDept: (id) => deptEditor(id),
    editProject: (id) => projectEditor(id),

    _uPage: (p) => { const f = S.u; const pages = Math.max(1, Math.ceil(filteredUsers().length / f.per)); f.page = Math.max(1, Math.min(pages, p)); renderMain(); },
    _clearSel: () => { S.u.sel = []; renderMain(); },
    _uClear: () => { Object.assign(S.u, { q: '', dept: '', desig: '', status: '', page: 1 }); renderMain(); },
    _userMenu: (ev, id) => {
      const u = userById(id); const self = id === 'u_admin';
      rowMenu(ev, [
        { act: 'edit', icon: 'edit', label: 'Edit user', fn: () => userDrawer(id) },
        { act: 'reset', icon: 'key', label: 'Reset password', fn: () => window.ERP.resetPw(id) },
        u.status === 'locked' ? { act: 'unlock', icon: 'unlock', label: 'Unlock account', fn: () => window.ERP.unlockUser(id) } : { act: 'lock', icon: 'lock', label: 'Lock account', fn: () => window.ERP.lockUser(id) },
        { act: 'pa', icon: 'power', label: (u.platformAccess !== false ? 'Revoke platform access' : 'Grant platform access'), fn: () => window.ERP.togglePA(id) },
        '-',
        { act: 'clone', icon: 'copy', label: 'Clone user', fn: () => window.ERP.cloneUser(id) },
        ...(self ? [] : [{ act: 'del', icon: 'trash', label: 'Delete user', danger: true, fn: () => window.ERP.delUser(id) }])
      ]);
    },
    _bulk: async (action) => {
      const ids = S.u.sel.slice(); if (!ids.length) return;
      const ask = { delete: ['Delete ' + ids.length + ' user(s)?', 'Their accounts are removed and they can no longer sign in. This cannot be undone.', 'Delete users'],
        deactivate: ['Deactivate ' + ids.length + ' user(s)?', 'They will not be able to sign in until reactivated.', 'Deactivate'],
        lock: ['Lock ' + ids.length + ' user(s)?', 'Locked accounts cannot sign in until unlocked.', 'Lock accounts'] }[action];
      if (ask && !(await confirmBox(ask[0], ask[1], ask[2]))) return;
      if (SERVER()) {
        const run = action === 'delete' ? () => window.TSApi.bulkDelete(ids)
          : action === 'activate' || action === 'deactivate' ? () => window.TSApi.bulkActive(ids, action === 'activate')
          : () => Promise.all(ids.map(id => setStatus(id, action === 'lock' ? 'suspended' : 'active')));
        serverDo(run, '✓ ' + ids.length + ' user(s) updated').then(ok => { if (ok) { logAudit({ module: 'Administration', action: 'Bulk ' + action, target: ids.length + ' users', newVal: action }); S.u.sel = []; renderMain(); } });
        return;
      }
      const all = users();
      ids.forEach(id => {
        if (id === 'u_admin') return;
        const u = all.find(x => x.id === id); if (!u) return;
        if (action === 'activate') { u.status = 'active'; u.platformAccess = true; u.active = true; }
        else if (action === 'deactivate') { u.status = 'inactive'; u.active = false; }
        else if (action === 'lock') { u.status = 'locked'; u.lockReason = 'Bulk lock by administrator'; u.sessions = []; }
        else if (action === 'unlock') { u.status = 'active'; u.lockReason = ''; u.failedLogins = 0; u.active = true; }
      });
      let next = all;
      if (action === 'delete') next = all.filter(x => !ids.includes(x.id) || x.id === 'u_admin');
      setUsers(next);
      logAudit({ module: 'Administration', action: 'Bulk ' + action, target: ids.length + ' users', newVal: action });
      S.u.sel = []; toast('✓ ' + ids.length + ' user(s) updated'); renderMain();
    },
    lockUser: async (id) => {
      const u00 = userById(id);
      const reason = await dialog({ title: 'Lock ' + (u00 ? u00.name : 'account') + '?', sub: 'A locked account cannot sign in until it is unlocked.', ok: 'Lock account', danger: true,
        html: `<label class="erp-flbl" for="lkReason">Reason</label><select class="erp-fsel" id="lkReason">${['Security Investigation', 'Employee Resigned', 'Terminated', 'Policy Violation', 'Other'].map(r => `<option>${r}</option>`).join('')}</select>
               <label class="erp-flbl" for="lkNote" style="margin-top:12px">Note <span style="color:var(--faint);font-weight:500">(optional)</span></label><input class="erp-fin" id="lkNote" placeholder="Shown to administrators only">`,
        validate: (root) => { const r = root.querySelector('#lkReason').value, n = root.querySelector('#lkNote').value.trim(); return n ? r + ' — ' + n : r; } });
      if (!reason) return;
      if (SERVER()) {
        const u0 = userById(id);
        serverDo(() => setStatus(id, 'suspended'), '🔒 ' + (u0 ? u0.name : 'User') + ' locked', () => ({ id, lockReason: reason }))
          .then(ok => { if (ok) logAudit({ module: 'Administration', action: 'Account Locked', target: u0 && u0.name, oldVal: 'Active', newVal: 'Locked — ' + reason, reason }); });
        return;
      }
      const u = userById(id); u.status = 'locked'; u.lockReason = reason; u.active = false; u.sessions = []; persistUser(u);
      logAudit({ module: 'Administration', action: 'Account Locked', target: u.name, oldVal: 'Active', newVal: 'Locked — ' + reason, reason });
      notify('lock', 'User locked', u.name + ' was locked — ' + reason); toast('🔒 ' + u.name + ' locked'); renderMain();
    },
    unlockUser: (id) => { if (SERVER()) { const u0 = userById(id); serverDo(() => setStatus(id, 'active'), '🔓 ' + (u0 ? u0.name : 'User') + ' unlocked', () => ({ id, lockReason: '' })); return; } const u = userById(id); u.status = 'active'; u.lockReason = ''; u.failedLogins = 0; u.active = u.platformAccess !== false; persistUser(u); logAudit({ module: 'Administration', action: 'Account Unlocked', target: u.name, oldVal: 'Locked', newVal: 'Active' }); toast('🔓 ' + u.name + ' unlocked'); renderMain(); },
    resetPw: async (id) => {
      const u = userById(id); const minL = policy().minLen || 8;
      const np = await dialog({ title: 'Reset password', sub: u.name + ' (' + u.username + ')', ok: 'Set password',
        html: `<label class="erp-flbl" for="rpPw">New password <span class="req">*</span></label><input class="erp-fin" id="rpPw" type="password" autocomplete="new-password" placeholder="At least ${minL} characters">
               <label class="erp-flbl" for="rpPw2" style="margin-top:12px">Confirm password <span class="req">*</span></label><input class="erp-fin" id="rpPw2" type="password" autocomplete="new-password">
               <div class="erp-fhint">The user is asked to choose their own password at next sign-in. Share this one with them privately.</div>`,
        validate: (root, msg) => { const a = root.querySelector('#rpPw').value, b = root.querySelector('#rpPw2').value;
          if (a.length < minL) { msg('Use at least ' + minL + ' characters.'); root.querySelector('#rpPw').focus(); return false; }
          if (a !== b) { msg('The two passwords do not match.'); root.querySelector('#rpPw2').focus(); return false; } return a; } });
      if (!np) return;
      if (SERVER()) { serverDo(() => window.TSApi.updateUser(id, { password: np }), '✓ Password reset for ' + u.name + ' — they must change it at next sign-in'); return; }
      const salt = rndSalt(); const { algo, h } = await hash(np, salt); u.salt = salt; u.hash = h; u.algo = algo; u.mustChange = true; persistUser(u);
      logAudit({ module: 'Administration', action: 'Password Reset', target: u.name, newVal: 'Forced change on next login' });
      toast('✓ Password reset for ' + u.name);
    },
    togglePA: async (id) => {
      { const u1 = userById(id); if (u1 && u1.platformAccess !== false && !(await confirmBox('Revoke sign-in for ' + u1.name + '?', 'They will not be able to sign in until access is granted again.', 'Revoke access'))) return; }
      if (SERVER()) { const u0 = userById(id); const on = u0 && u0.platformAccess === false; serverDo(() => window.TSApi.updateUser(id, { active: on }), on ? '✓ Access granted' : '⊘ Access revoked'); return; }
      const u = userById(id); u.platformAccess = u.platformAccess === false; u.active = u.platformAccess && u.status === 'active';
      if (!u.platformAccess) u.sessions = [];
      persistUser(u);
      logAudit({ module: 'Administration', action: u.platformAccess ? 'Platform Access Granted' : 'Platform Access Revoked', target: u.name, oldVal: u.platformAccess ? 'Disabled' : 'Enabled', newVal: u.platformAccess ? 'Enabled' : 'Disabled' });
      notify('lock', 'Platform access ' + (u.platformAccess ? 'granted' : 'revoked'), u.name); toast(u.platformAccess ? '✓ Access granted' : '⊘ Access revoked'); renderMain();
    },
    cloneUser: (id) => {
      const u = userById(id); userDrawer('');
      setTimeout(() => {
        $('#fName').value = u.name + ' (Copy)'; $('#fEmail').value = ''; $('#fUser').value = '';
        $('#fDept').value = u.departmentId; draft.designationId = u.designationId; $('#fDesig').value = desigName(u.designationId);
        $('#fBranch').value = u.branchId; $('#fComp').value = u.companyId; $('#fMobile').value = '';
        toast('Cloned settings — set name, email & username');
      }, 80);
    },
    delUser: async (id) => { if (id === 'u_admin') { notice('Cannot delete', 'The Super Admin account cannot be deleted.'); return; } const u = userById(id); if (!(await confirmBox('Delete ' + u.name + '?', 'Their account is removed and they can no longer sign in. This cannot be undone.', 'Delete user'))) return; if (SERVER()) { serverDo(() => window.TSApi.bulkDelete([id]), '🗑 ' + u.name + ' deleted').then(ok => { if (ok) logAudit({ module: 'Administration', action: 'User Deleted', target: u.name }); }); return; } setUsers(users().filter(x => x.id !== id)); logAudit({ module: 'Administration', action: 'User Deleted', target: u.name }); toast('🗑 ' + u.name + ' deleted'); renderMain(); },

    _clearPhoto: () => { draft.photo = null; const el = $('#uPhoto'); if (el) { el.style.backgroundImage = ''; el.style.background = '#ff6a2c'; el.innerHTML = (val('fName').trim().split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'NU') + '<div class="ov">Upload</div>'; } },
    _pwMeter: () => { const v = val('fPw'); const bar = $('#fPwBar'); if (!bar) return; let s = 0; if (v.length >= 8) s++; if (/[A-Z]/.test(v)) s++; if (/[0-9]/.test(v)) s++; if (/[^A-Za-z0-9]/.test(v)) s++; const pct = [0, 30, 55, 80, 100][s]; const col = ['', 'var(--red)', 'var(--accent2)', 'var(--blue)', 'var(--green)'][s]; bar.style.width = pct + '%'; bar.style.background = col; },
    _genPw: () => { const ch = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$%'; let p = ''; for (let i = 0; i < 12; i++) p += ch[Math.floor(Math.random() * ch.length)]; const f = $('#fPw'), f2 = $('#fPw2'); f.type = 'text'; f.value = p; if (f2) f2.value = p; window.ERP._pwMeter(); toast('Generated — copy before saving'); },
    _saveUser: async (editId) => {
      const msg = $('#uMsg'); const fail = t => { if (msg) { msg.style.color = 'var(--red)'; msg.textContent = t; } };
      const name = val('fName').trim(), email = val('fEmail').trim(), un = val('fUser').trim();
      if (!name) return fail('Enter employee name'); if (!un) return fail('Enter a username');
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email');
      const dup = users().find(x => x.username.toLowerCase() === un.toLowerCase() && x.id !== editId); if (dup) return fail('Username already taken');
      const pw = val('fPw'), pw2 = val('fPw2');
      const minL = policy().minLen || 8;
      const editing = !!editId; const u = editing ? userById(editId) : {};
      if (!editing || pw) { if (pw.length < minL) return fail('Password needs min ' + minL + ' characters'); if (pw !== pw2) return fail('Passwords do not match'); }
      const status = val('fStatus') || 'active';
      const rec = Object.assign({}, u, {
        id: u.id || ('u_' + un.toLowerCase().replace(/[^a-z0-9]/g, '') + Date.now().toString(36).slice(-4)),
        empId: val('fEmpId').trim(), name, username: un, email, mobile: val('fMobile').trim(),
        photo: draft.photo, signature: draft.signature,
        departmentId: val('fDept'), designationId: draft.designationId,
        reportingManagerId: val('fMgr') || null, branchId: val('fBranch'), companyId: val('fComp'),
        status, platformAccess: $('#fPa').checked, joiningDate: val('fJoin'),
        remarks: val('fRemarks'), overrides: u.overrides || {}, sessions: u.sessions || [],
        active: status === 'active' && $('#fPa').checked,
        avatarColor: u.avatarColor || ['#ff6a2c', '#5e9bf0', '#34d399', '#a78bfa'][Math.floor(Math.random() * 4)],
        initials: name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
      });
      // map designation -> coarse auth role
      const dg = desigById(rec.designationId);
      let role = 'Viewer';
      if (dg) { const lv = dg.level || 9; if (lv <= 2) role = 'Admin'; else if (/purchase/i.test(dg.name)) role = 'Purchase'; else if (lv <= 6) role = 'QS Engineer'; }
      rec.role = u.role === 'Super Admin' ? 'Super Admin' : role;
      if (SERVER()) {
        const extras = {}; LOCAL_ONLY.forEach(k => { if (rec[k] !== undefined) extras[k] = rec[k]; });
        const active = status === 'active' && $('#fPa').checked;
        const r = await serverDo(async () => {
          if (editing) { await window.TSApi.updateUser(editId, { name, email, role: rec.role, active, ...(pw ? { password: pw } : {}) }); return { userId: editId }; }
          const c = await window.TSApi.createUser({ username: un, name, email, password: pw, role: rec.role });
          if (!active && c && c.userId) await window.TSApi.updateUser(c.userId, { active: false });
          return c;
        }, editing ? '✓ User updated' : '✓ User created', (res) => Object.assign({ id: (res && res.userId) || editId }, extras));
        if (!r) return fail('Not saved — see the message above.');
        logAudit({ module: 'Administration', action: editing ? 'User Edited' : 'User Created', target: name, newVal: desigName(rec.designationId) + ' · ' + deptName(rec.departmentId) });
        closeOv(); renderMain(); return;
      }
      if (pw) { const salt = rndSalt(); const { algo, h } = await hash(pw, salt); rec.salt = salt; rec.hash = h; rec.algo = algo; rec.mustChange = !editing && (policy().mustChangeFirst !== false); }
      if (!editing && !rec.created) rec.created = Date.now();
      const all = users(); const i = all.findIndex(x => x.id === rec.id); if (i >= 0) all[i] = rec; else all.push(rec); setUsers(all);
      if (editing) syncSessionRole(rec);
      logAudit({ module: 'Administration', action: editing ? 'User Edited' : 'User Created', target: name, newVal: desigName(rec.designationId) + ' · ' + deptName(rec.departmentId) });
      notify('user', editing ? 'User updated' : 'New user created', name + ' — ' + desigName(rec.designationId));
      toast(editing ? '✓ User updated' : '✓ User created'); closeOv(); renderMain();
    },

    /* dynamic designation create (from user drawer combo) */
    _createDesigInline: () => {
      const name = val('qdName').trim(); const msg = $('#qdMsg'); if (!name) { if (msg) { msg.style.color = 'var(--red)'; msg.textContent = 'Enter a name'; } return; }
      if (desigs().find(d => d.name.toLowerCase() === name.toLowerCase())) { if (msg) { msg.style.color = 'var(--red)'; msg.textContent = 'Already exists'; } return; }
      const d = { id: uid('dg'), name, departmentId: val('qdDept'), reportsTo: val('qdReports') || null, description: val('qdDesc'), status: $('#qdActive').checked ? 'active' : 'inactive', level: 5 };
      const ds = desigs(); ds.push(d); save(K.desig, ds);
      logAudit({ module: 'Administration', action: 'Designation Created', target: name, newVal: deptName(d.departmentId) });
      toast('✓ Designation “' + name + '” created');
      // reopen drawer (openOv overwrites the modal content) with new designation selected
      const editId = draft._editId || '';
      userDrawer(editId);
      setTimeout(() => { draft.designationId = d.id; $('#fDesig').value = name; syncDeptFromDesig(); }, 80);
    },
    _reopenDrawerFromQuick: () => { userDrawer(draft._editId || ''); },

    _saveDesig: (editId) => {
      const name = val('dgName').trim(); const msg = $('#dgMsg'); if (!name) { if (msg) { msg.style.color = 'var(--red)'; msg.textContent = 'Enter a name'; } return; }
      const dup = desigs().find(d => d.name.toLowerCase() === name.toLowerCase() && d.id !== editId); if (dup) { if (msg) { msg.style.color = 'var(--red)'; msg.textContent = 'Designation exists'; } return; }
      const ds = desigs();
      if (editId) {
        const d = ds.find(x => x.id === editId); Object.assign(d, { name, departmentId: val('dgDept'), reportsTo: val('dgReports') || null, level: +val('dgLevel') || 5, status: val('dgStatus'), description: val('dgDesc') });
      } else {
        ds.push({ id: uid('dg'), name, departmentId: val('dgDept'), reportsTo: val('dgReports') || null, level: +val('dgLevel') || 5, status: val('dgStatus'), description: val('dgDesc') });
      }
      save(K.desig, ds);
      logAudit({ module: 'Administration', action: editId ? 'Designation Edited' : 'Designation Created', target: name });
      toast('✓ Saved'); closeOv(); renderNav(); renderMain();
    },
    _desigMenu: (ev, id) => {
      const d = desigById(id);
      rowMenu(ev, [
        { act: 'edit', icon: 'edit', label: 'Edit', fn: () => desigEditor(id) },
        { act: 'clone', icon: 'copy', label: 'Clone designation', fn: () => window.ERP._cloneDesig(id) },
        { act: 'toggle', icon: 'power', label: d.status === 'inactive' ? 'Enable' : 'Disable', fn: () => { d.status = d.status === 'inactive' ? 'active' : 'inactive'; save(K.desig, desigs().map(x => x.id === id ? d : x)); renderMain(); } },
        '-',
        { act: 'del', icon: 'trash', label: 'Delete', danger: true, fn: () => window.ERP._delDesig(id) }
      ]);
    },
    _cloneDesig: (id) => { const d = desigById(id); const ds = desigs(); ds.push(Object.assign({}, JSON.parse(JSON.stringify(d)), { id: uid('dg'), name: d.name + ' (Copy)' })); save(K.desig, ds); logAudit({ module: 'Administration', action: 'Designation Cloned', target: d.name }); toast('✓ Cloned'); renderMain(); },
    _delDesig: async (id) => { const d = desigById(id); const n = userCount(id); if (n) { notice('Cannot delete', n + ' user(s) hold the designation “' + d.name + '”. Move them to another designation first.'); return; } if (!(await confirmBox('Delete designation “' + d.name + '”?', 'This cannot be undone.', 'Delete'))) return; save(K.desig, desigs().filter(x => x.id !== id)); logAudit({ module: 'Administration', action: 'Designation Deleted', target: d.name }); toast('🗑 Deleted'); renderNav(); renderMain(); },

    _saveDept: (editId) => {
      const name = val('dpName').trim(); const msg = $('#dpMsg'); if (!name) { if (msg) { msg.style.color = 'var(--red)'; msg.textContent = 'Enter a name'; } return; }
      const dl = depts();
      if (editId) { const d = dl.find(x => x.id === editId); Object.assign(d, { name, code: val('dpCode').trim(), status: val('dpStatus') }); }
      else dl.push({ id: uid('dp'), name, code: val('dpCode').trim(), status: val('dpStatus') });
      save(K.dept, dl); logAudit({ module: 'Administration', action: editId ? 'Department Edited' : 'Department Created', target: name }); toast('✓ Saved'); closeOv(); renderNav(); renderMain();
    },
    _delDept: async (id) => { const d = depts().find(x => x.id === id); const n = users().filter(u => u.departmentId === id).length; if (n) { notice('Cannot delete', n + ' user(s) belong to “' + d.name + '”. Move them to another department first.'); return; } if (!(await confirmBox('Delete department “' + d.name + '”?', 'This cannot be undone.', 'Delete'))) return; save(K.dept, depts().filter(x => x.id !== id)); toast('🗑 Deleted'); renderNav(); renderMain(); },

    /* project master */
    _saveProject: (editId) => {
      const name = val('prName').trim(); const msg = $('#prMsg'); if (!name) { if (msg) { msg.style.color = 'var(--red)'; msg.textContent = 'Enter a project name'; } return; }
      const code = val('prCode').trim();
      const pl = projects();
      const dupe = pl.find(x => x.id !== editId && code && (x.code || '').toLowerCase() === code.toLowerCase());
      if (dupe) { if (msg) { msg.style.color = 'var(--red)'; msg.textContent = 'Project code already used by “' + dupe.name + '”'; } return; }
      const fields = { name, code, client: val('prClient').trim(), location: val('prLocation').trim(),
        managerId: val('prManager') || null, startDate: val('prStart') || null, endDate: val('prEnd') || null,
        status: val('prStatus') };
      if (editId) { const p = pl.find(x => x.id === editId); Object.assign(p, fields); }
      else pl.push(Object.assign({ id: uid('pr') }, fields));
      save(K.proj, pl); logAudit({ module: 'Administration', action: editId ? 'Project Edited' : 'Project Created', target: name }); toast('✓ Saved'); closeOv(); renderMain();
    },
    _delProject: async (id) => {
      const p = projects().find(x => x.id === id); if (!p) return;
      const n = users().filter(u => typeof u.projectAccess === 'object' && (u.projectAccess.ids || []).includes(id)).length;
      if (!(await confirmBox('Delete project “' + p.name + '”?', (n ? 'It is individually assigned to ' + n + ' user(s) — they will lose that assignment. ' : '') + 'This cannot be undone.', 'Delete project'))) return;
      save(K.proj, projects().filter(x => x.id !== id));
      const ul = users();
      ul.forEach(u => { if (typeof u.projectAccess === 'object') u.projectAccess.ids = (u.projectAccess.ids || []).filter(x => x !== id); });
      setUsers(ul);
      logAudit({ module: 'Administration', action: 'Project Deleted', target: p.name }); toast('🗑 Deleted'); renderMain();
    },

    /* security */
    _savePolicy: () => {
      const p = policy();
      p.minLen = Math.max(6, Math.min(64, +val('pMin') || 8)); // other stored policy fields are left as they are
      save(K.policy, p); logAudit({ module: 'Administration', action: 'Security Policy Updated', newVal: 'Minimum password length ' + p.minLen }); toast('✓ Saved'); renderMain();
    },

    /* audit + notif */
    _exportAudit: () => { exportCSV('audit-trail', ['Date', 'Module', 'Action', 'Target', 'By', 'Before', 'After', 'Reason', 'IP', 'Browser'], audit().map(x => [new Date(x.ts).toISOString(), x.module, x.action, x.target, x.admin, x.oldVal, x.newVal, x.reason, x.ip, x.browser])); toast('⤓ Audit exported'); },
    _exportUsers: () => { exportCSV('users', ['Emp ID', 'Name', 'Username', 'Email', 'Mobile', 'Designation', 'Department', 'Branch', 'Status', 'Last Login'], users().map(x => [x.empId, x.name, x.username, x.email, x.mobile, desigName(x.designationId), deptName(x.departmentId), branchName(x.branchId), x.status, x.lastLogin ? new Date(x.lastLogin).toISOString() : ''])); toast('⤓ Users exported'); },

    _readNotif: (id) => { const n = notifs(); const x = n.find(i => i.id === id); if (x) x.read = true; save(K.notif, n); refreshBadge(); renderMain(); },
    _readAll: () => { const n = notifs(); n.forEach(x => x.read = true); save(K.notif, n); refreshBadge(); toast('✓ All marked read'); renderMain(); },

    _orgT: (id) => { orgOpen[id] = !orgOpen[id]; renderMain(); },
    _audClear: () => { S.auditQ = ''; S.auditMod = ''; renderMain(); },
    _loginHist: () => { try { window.Auth._hist(); } catch (e) { notice('Not available', 'Sign-in history could not be opened: ' + ((e && e.message) || 'unknown error') + '.'); } }
  });

  // keep _editId on draft so quick-designation flow can reopen the right drawer
  const _origDrawer = userDrawer;
  // (userDrawer sets draft fresh each call; remember edit id)
  const _wrapDrawer = function (id) { _origDrawer(id); draft._editId = id; };
  window.ERP.addUser = () => _wrapDrawer('');
  window.ERP.editUser = (id) => _wrapDrawer(id);
})();
