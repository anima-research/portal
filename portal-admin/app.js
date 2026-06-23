/* Portal Admin SPA — vanilla JS, no dependencies, no build step.
 *
 * Resource-first IA: top-level tabs (Personas / Invites / Roles / Audit, plus
 * Identities for super-admins) with a persistent guild scope in the header.
 * Dense tables + a right-side detail drawer for editing one row at a time.
 *
 * Pure API client: every authorization decision is server-side. The CSRF token
 * from /admin/me is echoed in X-CSRF-Token on all mutating requests.
 */
'use strict';

const CAPS = [
  'VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS',
  'CREATE_THREADS', 'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE',
  'EDIT_OWN', 'DELETE_OWN', 'MANAGE_MESSAGES', 'MANAGE_CHANNELS',
];
const LIMIT = 50;

const state = {
  me: null,        // { user, isSuper, guilds, csrf }
  guildId: null,   // selected guild id (null for Identities / no guild)
  tab: 'personas',
  q: '',           // current search query for the active list
  offset: 0,       // current page offset for the active list
  cache: {},       // per-guild { roles, channels } caches
};

// ── DOM helpers ───────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function banner(msg, kind = 'ok') {
  const b = $('#banner');
  b.className = 'banner ' + (kind === 'err' ? 'err' : 'ok');
  b.textContent = msg;
  b.classList.remove('hidden');
  clearTimeout(banner._t);
  banner._t = setTimeout(() => b.classList.add('hidden'), 5000);
}

// ── API layer ──────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, code, message) { super(message || code || ('HTTP ' + status)); this.status = status; this.code = code; }
}

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (method !== 'GET' && state.me && state.me.csrf) opts.headers['X-CSRF-Token'] = state.me.csrf;
  let res;
  try { res = await fetch(path, opts); }
  catch { throw new ApiError(0, 'NETWORK', 'network error'); }
  if (res.status === 401) { showLogin(); throw new ApiError(401, 'UNAUTHENTICATED', 'login required'); }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON */ } }
  if (!res.ok) { const e = (data && data.error) || {}; throw new ApiError(res.status, e.code, e.message); }
  return data || {};
}

const G = () => '/admin/g/' + encodeURIComponent(state.guildId);
function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

// Per-guild role catalog + channels, cached (used by editors/pickers).
async function guildMeta() {
  const key = state.guildId;
  if (!state.cache[key]) {
    const [roles, chans] = await Promise.all([api('GET', G() + '/roles'), api('GET', G() + '/channels')]);
    state.cache[key] = {
      catalog: roles.catalog || {}, discordRoles: roles.discordRoles || [],
      canAuthor: !!roles.canAuthor, channels: chans.channels || [],
    };
  }
  return state.cache[key];
}
function invalidateGuildMeta() { delete state.cache[state.guildId]; }

// ── Boot / auth ──────────────────────────────────────────────────────────────

function showLogin(errMsg) {
  $('#app').classList.add('hidden');
  closeDrawer();
  $('#login').classList.remove('hidden');
  const e = $('#login-error');
  if (errMsg) { e.textContent = errMsg; e.classList.remove('hidden'); } else e.classList.add('hidden');
}

async function boot() {
  let me;
  try { me = await api('GET', '/admin/me'); }
  catch (e) { if (e.status === 401) return; return showLogin('Could not reach the admin API: ' + e.message); }
  state.me = me;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');

  $('#user-name').textContent = (me.user && me.user.name) || 'admin';
  $('#super-badge').classList.toggle('hidden', !me.isSuper);
  // Identities tab is super-admin only.
  $('.tab-super').classList.toggle('hidden', !me.isSuper);

  // Scope the switcher to guilds the bot is actually in (named) — not every
  // guild the admin owns on Discord — so it lands where data exists.
  let guilds = [];
  try { guilds = (await api('GET', '/admin/guilds')).guilds || []; }
  catch { guilds = me.guilds || []; }
  setupScope(me, guilds);

  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => selectTab(t.dataset.tab));
  $('#logout-btn').addEventListener('click', logout);
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      const s = $('#list-search'); if (s) { e.preventDefault(); s.focus(); }
    }
  });

  selectTab('personas');
}

function setupScope(me, guilds) {
  guilds = guilds || me.guilds || [];
  const sel = $('#guild-select');
  const stat = $('#guild-static');
  clear(sel);

  if (guilds.length === 1 && !me.isSuper) {
    // Single-guild delegate: scope is fixed; show it as a static label.
    state.guildId = guilds[0].id;
    stat.textContent = guilds[0].name || guilds[0].id;
    stat.classList.remove('hidden');
    sel.classList.add('hidden');
    return;
  }
  stat.classList.add('hidden');
  sel.classList.remove('hidden');
  if (!guilds.length && !me.isSuper) sel.appendChild(el('option', { value: '', text: 'no manageable guilds' }));
  for (const g of guilds) sel.appendChild(el('option', { value: g.id, text: g.name || g.id }));
  if (me.isSuper) sel.appendChild(el('option', { value: '__custom__', text: 'other guild id…' }));
  state.guildId = guilds.length ? guilds[0].id : null;
  sel.value = state.guildId || (me.isSuper ? '__custom__' : '');
  sel.addEventListener('change', (e) => {
    let v = e.target.value;
    if (v === '__custom__') {
      v = (prompt('Enter the Discord guild id to manage:') || '').trim();
      if (!v) { e.target.value = state.guildId || ''; return; }
      // Keep a synthetic option so the chosen id stays selected.
      if (!Array.from(sel.options).some((o) => o.value === v)) {
        sel.insertBefore(el('option', { value: v, text: v }), sel.lastChild);
      }
      sel.value = v;
    }
    state.guildId = v;
    state.q = ''; state.offset = 0;
    render();
  });
}

async function logout() {
  try { await api('POST', '/admin/logout'); } catch { /* ignore */ }
  state.me = null;
  showLogin();
}

function selectTab(tab) {
  state.tab = tab;
  state.q = ''; state.offset = 0;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === tab);
  closeDrawer();
  render();
}

// ── Drawer ─────────────────────────────────────────────────────────────────────

function openDrawer(title, node) {
  $('#drawer-title').textContent = title;
  const body = $('#drawer-body');
  clear(body); body.appendChild(node);
  $('#drawer').classList.remove('hidden');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-scrim').classList.remove('hidden');
}
function closeDrawer() {
  $('#drawer').classList.add('hidden');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-scrim').classList.add('hidden');
}

// ── Render dispatch ──────────────────────────────────────────────────────────

const GUILD_TABS = new Set(['personas', 'invites', 'roles', 'audit']);

async function render() {
  const view = $('#view');
  if (GUILD_TABS.has(state.tab) && !state.guildId) {
    clear(view);
    view.appendChild(el('div', { class: 'empty' }, [
      el('p', { text: 'Select a guild to manage.' }),
      state.me.isSuper ? el('p', { class: 'muted', text: 'As a super-admin you can pick “other guild id…”.' }) : null,
    ]));
    return;
  }
  clear(view);
  view.appendChild(el('p', { class: 'muted loading', text: 'Loading…' }));
  try {
    if (state.tab === 'personas') await renderPersonas(view);
    else if (state.tab === 'invites') await renderInvites(view);
    else if (state.tab === 'roles') await renderRoles(view);
    else if (state.tab === 'audit') await renderAudit(view);
    else if (state.tab === 'identities') await renderIdentities(view);
  } catch (e) {
    clear(view);
    if (e.status === 403) view.appendChild(el('div', { class: 'banner err', text: e.message || 'Not permitted in this guild.' }));
    else if (e.status !== 401) view.appendChild(el('div', { class: 'banner err', text: 'Error: ' + e.message }));
  }
}

// ── Shared list scaffolding ──────────────────────────────────────────────────

/** Toolbar with a search box (debounced) + optional action buttons. */
function toolbar(placeholder, actions) {
  const search = el('input', {
    id: 'list-search', class: 'search', type: 'search', placeholder, value: state.q,
  });
  search.addEventListener('input', () => {
    clearTimeout(toolbar._t);
    toolbar._t = setTimeout(() => { state.q = search.value.trim(); state.offset = 0; render(); }, 250);
  });
  return el('div', { class: 'toolbar' }, [search, el('div', { class: 'toolbar-actions' }, actions || [])]);
}

/** Pager from {total, limit, offset}. */
function pager(meta) {
  const total = meta.total != null ? meta.total : 0;
  const limit = meta.limit || LIMIT;
  const offset = meta.offset || 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const prev = el('button', { class: 'btn btn-sm', text: '‹ Prev', disabled: offset <= 0 });
  const next = el('button', { class: 'btn btn-sm', text: 'Next ›', disabled: to >= total });
  prev.addEventListener('click', () => { state.offset = Math.max(0, offset - limit); render(); });
  next.addEventListener('click', () => { state.offset = offset + limit; render(); });
  return el('div', { class: 'pager' }, [
    el('span', { class: 'muted', text: total ? `${from}–${to} of ${total}` : 'none' }), prev, next,
  ]);
}

function table(headers, rows) {
  return el('table', { class: 'grid' }, [
    el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { class: h.cls, text: h.label })))]),
    el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { class: 'muted empty-row', colspan: String(headers.length), text: 'Nothing here.' })])]),
  ]);
}

function rowClick(tr) { tr.classList.add('clickable'); return tr; }

// ── Personas (guild-scoped) ────────────────────────────────────────────────────

async function renderPersonas(view) {
  const meta = await guildMeta();
  const data = await api('GET', G() + '/personas' + qs({ q: state.q, limit: LIMIT, offset: state.offset }));
  clear(view);

  const grantById = el('button', { class: 'btn btn-sm btn-primary', text: '+ Grant access by id' });
  grantById.addEventListener('click', () => {
    const id = (prompt('Persona id to grant access to (must already exist):') || '').trim();
    if (id) openPersonaDrawer(id, meta);
  });
  view.appendChild(toolbar('Search personas with access here…', [grantById]));

  const rows = (data.personas || []).map((p) => rowClick(el('tr', { onclick: () => openPersonaDrawer(p.id, meta) }, [
    el('td', { text: p.displayName || p.id }),
    el('td', {}, [el('code', { text: p.id })]),
    el('td', { class: 'cell-roles', text: (p.roles || []).join(', ') || '—' }),
    el('td', {}, [p.hasOverride ? el('span', { class: 'badge badge-warn', text: 'override' }) : el('span', { class: 'muted', text: '—' })]),
  ])));
  view.appendChild(table([
    { label: 'Name' }, { label: 'Id' }, { label: 'Roles' }, { label: 'Override', cls: 'col-narrow' },
  ], rows));
  view.appendChild(pager(data));
  view.appendChild(el('p', { class: 'hint muted', text: 'This list is scoped to personas with access in this guild. To add one that has none yet, use “Grant access by id”, or mint an invite for an agent to claim.' }));
}

async function openPersonaDrawer(id, meta) {
  let detail;
  try { detail = await api('GET', G() + '/personas/' + encodeURIComponent(id)); }
  catch (e) {
    if (e.status === 404) detail = { id, displayName: id, roles: [], guildPolicy: null };
    else { banner('Load failed: ' + e.message, 'err'); return; }
  }
  const body = el('div', { class: 'drawer-sections' });

  // 1. Roles — the primary access mechanism.
  const roleTags = el('div', { class: 'tags' });
  function drawRoles(roles) {
    clear(roleTags);
    (roles || []).forEach((r) => roleTags.appendChild(el('span', { class: 'tag' }, [
      r, el('span', { class: 'x', text: '✕', title: 'revoke', onclick: () => revokeRole(id, r, drawRoles) }),
    ])));
    if (!roles || !roles.length) roleTags.appendChild(el('span', { class: 'muted', text: 'no roles' }));
  }
  drawRoles(detail.roles);
  const roleNames = Object.keys(meta.catalog || {});
  const addRole = el('select', {}, [el('option', { value: '', text: '+ add role…' })].concat(
    roleNames.map((n) => el('option', { value: n, text: n }))));
  addRole.addEventListener('change', async () => {
    if (!addRole.value) return;
    try { const r = await api('POST', G() + '/personas/' + encodeURIComponent(id) + '/roles', { role: addRole.value }); drawRoles(r.roles); banner('Role assigned'); addRole.value = ''; }
    catch (e) { banner('Assign failed: ' + e.message, 'err'); }
  });
  body.appendChild(section('Roles', [el('div', { class: 'inline' }, [roleTags, addRole])]));

  // 2. Claim invite.
  const claimCode = el('input', { type: 'text', placeholder: 'invite code' });
  const claimBtn = el('button', { class: 'btn btn-sm', text: 'Claim' });
  claimBtn.addEventListener('click', async () => {
    if (!claimCode.value.trim()) return banner('Enter an invite code.', 'err');
    try { const r = await api('POST', G() + '/personas/' + encodeURIComponent(id) + '/claim', { code: claimCode.value.trim() }); drawRoles(r.roles); banner('Augmented'); claimCode.value = ''; }
    catch (e) { banner('Claim failed: ' + e.message, 'err'); }
  });
  body.appendChild(section('Claim invite', [el('div', { class: 'inline' }, [claimCode, claimBtn])]));

  // 3. Advanced — ad-hoc grants, clipped to this guild.
  body.appendChild(grantEditor(id, detail.guildPolicy, meta.channels));

  openDrawer((detail.displayName || id), body);
  $('#drawer-title').appendChild(el('span', { class: 'muted mono', text: ' ' + id }));
}

function section(title, children) {
  return el('section', { class: 'drawer-section' }, [el('h3', { text: title }), el('div', {}, children)]);
}

function grantEditor(id, policy0, channels) {
  const det = el('details', { class: 'advanced' }, [el('summary', { text: 'Advanced · ad-hoc grant (this guild only)' })]);
  const body = el('div', {});
  function draw(policy) {
    clear(body);
    const gd = (policy && policy.default) || [];
    const chans = (policy && policy.channels) || {};
    const keys = Object.keys(chans);
    const rows = [];
    if (gd.length) rows.push(el('tr', {}, [el('td', { text: 'guild-default' }), el('td', { class: 'cell-roles', text: gd.join(', ') }), el('td', {}, [el('button', { class: 'btn btn-sm btn-danger', text: 'clear', onclick: () => clearGrant(id, null, draw) })])]));
    for (const cid of keys) rows.push(el('tr', {}, [
      el('td', {}, [el('code', { text: channelName(channels, cid) })]),
      el('td', { class: 'cell-roles', text: (chans[cid] || []).join(', ') }),
      el('td', {}, [el('button', { class: 'btn btn-sm btn-danger', text: 'clear', onclick: () => clearGrant(id, cid, draw) })]),
    ]));
    body.appendChild(table([{ label: 'Target' }, { label: 'Caps' }, { label: '', cls: 'col-narrow' }], rows));

    const target = el('select', {}, [el('option', { value: '', text: 'guild-default' })].concat(
      (channels || []).map((c) => el('option', { value: c.id, text: '#' + (c.name || c.id) }))));
    const caps = capsCheckboxes();
    const setBtn = el('button', { class: 'btn btn-sm btn-primary', text: 'Set grant' });
    setBtn.addEventListener('click', async () => {
      const reqBody = { caps: caps.values() };
      if (target.value) reqBody.channelId = target.value;
      try { const r = await api('PUT', G() + '/personas/' + encodeURIComponent(id) + '/grants', reqBody); draw(r.guildPolicy); banner('Grant updated'); }
      catch (e) { banner('Grant failed: ' + e.message, 'err'); }
    });
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Target' }), target]));
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Capabilities' }), caps.node]));
    body.appendChild(setBtn);
  }
  draw(policy0);
  det.appendChild(body);
  return det;
}

async function clearGrant(id, channelId, draw) {
  let path = G() + '/personas/' + encodeURIComponent(id) + '/grants';
  if (channelId) path += '?channelId=' + encodeURIComponent(channelId);
  try { const r = await api('DELETE', path); draw(r.guildPolicy); banner('Grant cleared'); }
  catch (e) { banner('Clear failed: ' + e.message, 'err'); }
}
async function revokeRole(id, role, drawRoles) {
  try { const r = await api('DELETE', G() + '/personas/' + encodeURIComponent(id) + '/roles/' + encodeURIComponent(role)); drawRoles(r.roles); banner('Role revoked'); }
  catch (e) { banner('Revoke failed: ' + e.message, 'err'); }
}

// ── Invites (guild-scoped) ─────────────────────────────────────────────────────

async function renderInvites(view) {
  const meta = await guildMeta();
  const data = await api('GET', G() + '/invites' + qs({ q: state.q, limit: LIMIT, offset: state.offset }));
  clear(view);

  const mintBtn = el('button', { class: 'btn btn-sm btn-primary', text: '+ Mint invite' });
  mintBtn.addEventListener('click', () => openMintDrawer(meta));
  view.appendChild(toolbar('Search invites…', [mintBtn]));

  const rows = (data.invites || []).map((inv) => el('tr', {}, [
    el('td', {}, [el('code', { text: inv.code })]),
    el('td', { text: inv.label || '—' }),
    el('td', {}, [el('span', { class: 'badge', text: inv.mode || 'mint' })]),
    el('td', { text: (inv.uses || 0) + '/' + (inv.maxUses != null ? inv.maxUses : '∞') }),
    el('td', { text: inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString() : 'never' }),
    el('td', { class: 'cell-roles', text: grantSummary(inv) }),
    el('td', {}, [el('button', { class: 'btn btn-sm btn-danger', text: 'Revoke', onclick: (e) => { e.stopPropagation(); revokeInvite(inv.code); } })]),
  ]));
  view.appendChild(table([
    { label: 'Code' }, { label: 'Label' }, { label: 'Mode', cls: 'col-narrow' },
    { label: 'Uses', cls: 'col-narrow' }, { label: 'Expires', cls: 'col-narrow' }, { label: 'Grant' }, { label: '', cls: 'col-narrow' },
  ], rows));
  view.appendChild(pager(data));
}

function openMintDrawer(meta) {
  const label = el('input', { type: 'text', placeholder: 'label (optional)' });
  const mode = el('select', {}, ['mint', 'augment', 'both'].map((m) => el('option', { value: m, text: m })));
  const maxUses = el('input', { type: 'number', min: '1', placeholder: 'unlimited' });
  const expires = el('input', { type: 'number', min: '1', placeholder: 'never' });
  const kind = el('select', {}, [
    el('option', { value: 'roles', text: 'Access roles' }),
    el('option', { value: 'channels', text: 'Scope: channels' }),
    el('option', { value: 'mirrorRole', text: 'Scope: mirror a Discord role' }),
  ]);
  const roleSel = multiSelect(Object.keys(meta.catalog || {}), 'No access roles defined.');
  const chanSel = multiSelect((meta.channels || []).map((c) => ({ value: c.id, text: '#' + (c.name || c.id) })), 'No channels.');
  const mirrorSel = el('select', {}, (meta.discordRoles || []).map((r) => el('option', { value: r.id, text: r.name + (r.pooled ? ' (pool)' : '') })));
  const caps = capsCheckboxes();
  const scopeArea = el('div', {});
  function sync() {
    clear(scopeArea);
    if (kind.value === 'roles') scopeArea.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Access roles (union)' }), roleSel.node]));
    else if (kind.value === 'channels') { scopeArea.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Channels' }), chanSel.node])); scopeArea.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Capabilities' }), caps.node])); }
    else { scopeArea.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Mirror Discord role' }), mirrorSel])); scopeArea.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Capabilities' }), caps.node])); }
  }
  kind.addEventListener('change', sync); sync();

  const submit = el('button', { class: 'btn btn-primary', text: 'Mint invite' });
  submit.addEventListener('click', async () => {
    const body = { mode: mode.value };
    if (label.value.trim()) body.label = label.value.trim();
    if (maxUses.value) body.maxUses = parseInt(maxUses.value, 10);
    if (expires.value) body.expiresInDays = parseInt(expires.value, 10);
    if (kind.value === 'roles') {
      const roles = roleSel.values();
      if (!roles.length) return banner('Pick at least one access role.', 'err');
      body.roles = roles;
    } else {
      const c = caps.values();
      if (!c.length) return banner('Pick at least one capability.', 'err');
      if (kind.value === 'channels') { const ch = chanSel.values(); if (!ch.length) return banner('Pick at least one channel.', 'err'); body.grant = { caps: c, scope: { channels: ch } }; }
      else { if (!mirrorSel.value) return banner('Pick a Discord role.', 'err'); body.grant = { caps: c, scope: { mirrorRole: mirrorSel.value } }; }
    }
    try { const r = await api('POST', G() + '/invites', body); banner('Minted ' + (r.code || '')); closeDrawer(); render(); }
    catch (e) { banner('Mint failed: ' + e.message, 'err'); }
  });

  const form = el('div', { class: 'drawer-sections' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Label' }), label]),
    el('div', { class: 'field-row' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Mode' }), mode]),
      el('div', { class: 'field' }, [el('label', { text: 'Max uses' }), maxUses]),
      el('div', { class: 'field' }, [el('label', { text: 'Expires (days)' }), expires]),
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Grant kind' }), kind]),
    scopeArea, submit,
  ]);
  openDrawer('Mint invite', form);
}

async function revokeInvite(code) {
  if (!confirm('Revoke invite ' + code + '? Future enroll/claim is blocked (past grants persist).')) return;
  try { await api('DELETE', G() + '/invites/' + encodeURIComponent(code)); banner('Revoked ' + code); render(); }
  catch (e) { banner('Revoke failed: ' + e.message, 'err'); }
}

function scopeSummary(scope) {
  if (!scope) return '—';
  if (scope.all) return 'all channels';
  if (scope.channels) return 'channels[' + scope.channels.length + ']';
  if (scope.mirrorRoles) return 'mirror[' + scope.mirrorRoles.length + ' roles]';
  if (scope.mirrorRole) return 'mirror role ' + scope.mirrorRole;
  return '?';
}
function grantSummary(inv) {
  if (inv.roles && inv.roles.length) return 'roles: ' + inv.roles.join(', ');
  if (inv.grant) return 'grant{' + scopeSummary(inv.grant.scope) + '} ' + (inv.grant.caps || []).join(',');
  if (inv.caps && inv.caps.length) return 'blanket(deprecated): ' + inv.caps.join(',');
  return 'deny';
}

// ── Roles (guild-scoped read, global authoring) ─────────────────────────────────

async function renderRoles(view) {
  const { catalog, discordRoles, canAuthor } = await api('GET', G() + '/roles');
  clear(view);

  const actions = [];
  if (canAuthor) {
    const add = el('button', { class: 'btn btn-sm btn-primary', text: '+ Define role' });
    add.addEventListener('click', () => openRoleDrawer(discordRoles));
    actions.push(add);
  }
  view.appendChild(toolbar('Filter roles…', actions));

  const names = Object.keys(catalog || {}).filter((n) => !state.q || n.toLowerCase().includes(state.q.toLowerCase()));
  const rows = names.map((n) => {
    const r = catalog[n];
    const cells = [
      el('td', {}, [el('code', { text: n })]),
      el('td', { class: 'cell-roles', text: (r.caps || []).join(', ') }),
      el('td', { text: scopeSummary(r.scope) }),
      el('td', {}, [el('code', { text: r.guildId || '—' })]),
    ];
    if (canAuthor) cells.push(el('td', {}, [el('button', { class: 'btn btn-sm btn-danger', text: 'Delete', onclick: () => deleteRole(n) })]));
    return el('tr', {}, cells);
  });
  const headers = [{ label: 'Name' }, { label: 'Caps' }, { label: 'Scope', cls: 'col-narrow' }, { label: 'Guild' }];
  if (canAuthor) headers.push({ label: '', cls: 'col-narrow' });
  view.appendChild(table(headers, rows));
  view.appendChild(el('p', { class: 'hint muted', text: canAuthor
    ? 'The access-role catalog is global (shared across all guilds). Editing here is super-admin only.'
    : 'The role catalog is global and authored by operators. Express access by minting invites that mirror your Discord roles or pick channels.' }));
}

function openRoleDrawer(discordRoles) {
  const name = el('input', { type: 'text', placeholder: 'role name' });
  const caps = capsCheckboxes();
  const guildId = el('input', { type: 'text', placeholder: 'guild id (required for mirror)', value: state.guildId || '' });
  const kind = el('select', {}, [
    el('option', { value: 'all', text: 'all channels' }),
    el('option', { value: 'channels', text: 'channels (comma ids)' }),
    el('option', { value: 'mirrorRole', text: 'mirror Discord role' }),
    el('option', { value: 'mirrorRoles', text: 'mirror several roles (comma ids)' }),
  ]);
  const scopeInput = el('input', { type: 'text', placeholder: 'channel/role ids, comma-separated' });
  const mirrorSel = el('select', {}, (discordRoles || []).map((r) => el('option', { value: r.id, text: r.name })));
  const scopeArea = el('div', { class: 'field' });
  function sync() { clear(scopeArea); if (kind.value === 'mirrorRole') scopeArea.appendChild(mirrorSel); else if (kind.value !== 'all') scopeArea.appendChild(scopeInput); }
  kind.addEventListener('change', sync); sync();

  const submit = el('button', { class: 'btn btn-primary', text: 'Create role' });
  submit.addEventListener('click', async () => {
    if (!name.value.trim()) return banner('Name required.', 'err');
    let scope;
    if (kind.value === 'all') scope = { all: true };
    else if (kind.value === 'mirrorRole') scope = { mirrorRole: mirrorSel.value };
    else { const ids = scopeInput.value.split(',').map((s) => s.trim()).filter(Boolean); scope = kind.value === 'channels' ? { channels: ids } : { mirrorRoles: ids }; }
    const role = { caps: caps.values(), scope };
    if (guildId.value.trim()) role.guildId = guildId.value.trim();
    try { await api('POST', '/admin/roles', { name: name.value.trim(), role }); banner('Role created'); invalidateGuildMeta(); closeDrawer(); render(); }
    catch (e) { banner('Create failed: ' + e.message, 'err'); }
  });

  openDrawer('Define access role', el('div', { class: 'drawer-sections' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Name' }), name]),
    el('div', { class: 'field' }, [el('label', { text: 'Scope kind' }), kind]),
    scopeArea,
    el('div', { class: 'field' }, [el('label', { text: 'Guild id' }), guildId]),
    el('div', { class: 'field' }, [el('label', { text: 'Capabilities' }), caps.node]),
    submit,
  ]));
}

async function deleteRole(name) {
  if (!confirm('Delete access role "' + name + '"? Assignees lose those caps on their next action.')) return;
  try { await api('DELETE', '/admin/roles/' + encodeURIComponent(name)); banner('Role deleted'); invalidateGuildMeta(); render(); }
  catch (e) { banner('Delete failed: ' + e.message, 'err'); }
}

// ── Audit (guild-scoped) ───────────────────────────────────────────────────────

async function renderAudit(view) {
  const { records } = await api('GET', G() + '/audit' + qs({ limit: 200 }));
  clear(view);
  view.appendChild(toolbar('Filter audit…', []));
  const q = state.q.toLowerCase();
  const filtered = (records || []).filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q));
  const rows = filtered.map((r) => el('tr', {}, [
    el('td', { class: 'mono', text: r.ts ? new Date(r.ts).toLocaleString() : '—' }),
    el('td', {}, [(r.actor && r.actor.name) || '?', ' ', el('span', { class: 'muted', text: r.actor ? '(' + r.actor.kind + ')' : '' })]),
    el('td', {}, [el('code', { text: r.action })]),
    el('td', { class: 'cell-roles', text: r.target || (r.detail ? JSON.stringify(r.detail) : '—') }),
    el('td', {}, [el('span', { class: r.ok ? 'badge-ok' : 'badge-no', text: r.ok ? '✓' : '✗' })]),
  ]));
  view.appendChild(table([{ label: 'Time' }, { label: 'Actor' }, { label: 'Action' }, { label: 'Target' }, { label: 'OK', cls: 'col-narrow' }], rows));
}

// ── Identities (super-admin, GLOBAL) ────────────────────────────────────────────

async function renderIdentities(view) {
  const data = await api('GET', '/admin/personas' + qs({ q: state.q, limit: LIMIT, offset: state.offset }));
  clear(view);
  view.appendChild(toolbar('Search all personas…', []));
  const rows = (data.personas || []).map((p) => rowClick(el('tr', { onclick: () => openIdentityDrawer(p.id) }, [
    el('td', { text: p.displayName || p.id }),
    el('td', {}, [el('code', { text: p.id })]),
    el('td', { class: 'cell-roles', text: (p.roles || []).join(', ') || '—' }),
    el('td', { class: 'col-narrow', text: String(p.guildCount != null ? p.guildCount : '—') }),
  ])));
  view.appendChild(table([{ label: 'Name' }, { label: 'Id' }, { label: 'Roles' }, { label: 'Guilds', cls: 'col-narrow' }], rows));
  view.appendChild(pager(data));
  view.appendChild(el('p', { class: 'hint muted', text: 'Global identity registry. Token lifecycle (rotate / revoke) lives here only — a token authenticates a persona everywhere, so it is not a per-guild action.' }));
}

async function openIdentityDrawer(id) {
  let d;
  try { d = await api('GET', '/admin/personas/' + encodeURIComponent(id)); }
  catch (e) { banner('Load failed: ' + e.message, 'err'); return; }
  const body = el('div', { class: 'drawer-sections' });

  const guilds = d.guilds || [];
  const gname = {}; guilds.forEach((g) => { gname[g.id] = g.name; });

  body.appendChild(section('Access in guilds', [
    guilds.length
      ? el('ul', { class: 'plain' }, guilds.map((g) => el('li', {}, [g.name || g.id, el('span', { class: 'muted mono', text: ' ' + g.id })])))
      : el('p', { class: 'muted', text: 'No guild access.' }),
  ]));

  // Roles — show what each confers (caps + scope + bound guild).
  const roles = d.roles || [];
  body.appendChild(section('Roles', [
    roles.length
      ? el('ul', { class: 'plain' }, roles.map((r) => el('li', {}, [
          el('strong', { text: r.name }),
          r.scope ? el('span', { class: 'muted', text: ' — ' + scopeSummary(r.scope) + (r.guildId ? ' @ ' + (gname[r.guildId] || r.guildId) : '') }) : null,
          el('div', { class: 'cell-roles', text: (r.caps || []).join(', ') }),
        ])))
      : el('p', { class: 'muted', text: 'No roles.' }),
  ]));

  // Ad-hoc per-persona grants (inline policy), if any.
  const pol = d.policy;
  const polGuilds = pol && pol.guilds ? Object.entries(pol.guilds) : [];
  if ((pol && pol.default && pol.default.length) || polGuilds.length) {
    const kids = [];
    if (pol.default && pol.default.length) kids.push(el('div', { class: 'cell-roles', text: 'global default: ' + pol.default.join(', ') }));
    for (const [gid, gp] of polGuilds) {
      const lines = [];
      if (gp.default && gp.default.length) lines.push(el('div', { class: 'cell-roles', text: 'guild default: ' + gp.default.join(', ') }));
      for (const [cid, caps] of Object.entries(gp.channels || {})) lines.push(el('div', { class: 'cell-roles' }, [el('code', { text: cid }), ': ' + (caps || []).join(', ')]));
      kids.push(el('div', { class: 'grant-guild' }, [el('strong', { text: gname[gid] || gid }), el('span', { class: 'muted mono', text: ' ' + gid }), ...lines]));
    }
    body.appendChild(section('Ad-hoc grants', kids));
  }

  const rotate = el('button', { class: 'btn btn-sm', text: 'Rotate token' });
  rotate.addEventListener('click', () => tokenAction(id, 'rotate'));
  const revoke = el('button', { class: 'btn btn-sm btn-danger', text: 'Revoke token' });
  revoke.addEventListener('click', () => tokenAction(id, 'revoke'));
  body.appendChild(section('Token', [
    el('p', { class: 'muted', text: 'Rotate issues a new token (shown once). Revoke invalidates it and drops live sessions.' }),
    el('div', { class: 'inline' }, [rotate, revoke]),
  ]));

  openDrawer(d.displayName || id, body);
  $('#drawer-title').appendChild(el('span', { class: 'muted mono', text: ' ' + id }));
}

async function tokenAction(id, action) {
  const verb = action === 'rotate' ? 'Rotate' : 'Revoke';
  if (!confirm(verb + ' token for ' + id + '?' + (action === 'revoke' ? ' Live sessions will be dropped.' : ''))) return;
  try {
    const r = await api('POST', '/admin/personas/' + encodeURIComponent(id) + '/token', { action });
    if (action === 'rotate' && r.token) showSecret(r.token);
    else banner('Token revoked; sessions dropped.');
  } catch (e) { banner(verb + ' failed: ' + e.message, 'err'); }
}

// ── Shared widgets ───────────────────────────────────────────────────────────

function capsCheckboxes() {
  const node = el('div', { class: 'caps-grid' });
  const boxes = CAPS.map((c) => { const cb = el('input', { type: 'checkbox', value: c }); node.appendChild(el('label', { class: 'cap' }, [cb, c])); return cb; });
  return { node, values: () => boxes.filter((b) => b.checked).map((b) => b.value) };
}

function multiSelect(options, emptyText) {
  const opts = (options || []).map((o) => (typeof o === 'string' ? { value: o, text: o } : o));
  if (!opts.length) return { node: el('span', { class: 'muted', text: emptyText || 'none' }), values: () => [] };
  const node = el('select', { multiple: true, size: String(Math.min(6, Math.max(2, opts.length))) }, opts.map((o) => el('option', { value: o.value, text: o.text })));
  return { node, values: () => Array.from(node.selectedOptions).map((o) => o.value) };
}

function channelName(channels, cid) { const c = (channels || []).find((x) => x.id === cid); return c ? '#' + (c.name || cid) : cid; }

function showSecret(token) {
  const modal = $('#secret-modal');
  $('#secret-value').textContent = token;
  modal.classList.remove('hidden');
  $('#secret-copy').onclick = async () => { try { await navigator.clipboard.writeText(token); banner('Copied to clipboard'); } catch { banner('Copy failed — select manually', 'err'); } };
  $('#secret-close').onclick = () => { $('#secret-value').textContent = ''; modal.classList.add('hidden'); };
}

// ── Go ───────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', boot);
