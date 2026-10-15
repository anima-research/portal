/* Portal Admin SPA — vanilla JS, no dependencies, no build step.
 *
 * Resource-first IA: top-level tabs (Personas / Invites / Access roles / Audit,
 * plus Guilds for super-admins) with a persistent guild scope in the header.
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
// Capabilities grouped for display/editing (purely a UI grouping — the wire
// model is still the flat per-cap set). Read / Write / and the three "elevated"
// singletons that each deserve their own line.
const CAP_GROUPS = [
  { label: 'Read', caps: ['VIEW_CHANNEL', 'READ_HISTORY'] },
  { label: 'Write', caps: ['SEND_MESSAGES', 'SEND_IN_THREADS', 'CREATE_THREADS', 'ATTACH_FILES', 'ADD_REACTIONS', 'EDIT_OWN', 'DELETE_OWN'] },
  { label: 'Mention everyone', caps: ['MENTION_EVERYONE'] },
  { label: 'Manage messages', caps: ['MANAGE_MESSAGES'] },
  { label: 'Manage channels', caps: ['MANAGE_CHANNELS'] },
];
const CAP_SHORT = {
  VIEW_CHANNEL: 'view', READ_HISTORY: 'history', SEND_MESSAGES: 'send',
  SEND_IN_THREADS: 'in-threads', CREATE_THREADS: 'threads', ATTACH_FILES: 'files',
  ADD_REACTIONS: 'react', EDIT_OWN: 'edit', DELETE_OWN: 'delete',
  MENTION_EVERYONE: 'mention', MANAGE_MESSAGES: 'manage-msgs', MANAGE_CHANNELS: 'manage-chans',
};
const capShort = (c) => CAP_SHORT[c] || c.toLowerCase();

// Compact read-only summary: a fully-present group shows as its label; partial
// groups list their present caps (short). e.g. "Read · Write" or "Read · send, files".
function capsSummary(caps) {
  const set = new Set(caps || []);
  if (!set.size) return '—';
  const out = [];
  for (const g of CAP_GROUPS) {
    const present = g.caps.filter((c) => set.has(c));
    if (!present.length) continue;
    if (present.length === g.caps.length) out.push(g.label);
    else out.push(present.map(capShort).join(', '));
  }
  return out.join(' · ');
}

const LIMIT = 50;

const state = {
  me: null,        // { user, isSuper, guilds, csrf }
  guildId: null,   // selected guild id (null when no guild is selectable)
  tab: 'personas',
  personaScope: 'guild', // super-admins: 'guild' (access here) or 'all' personas
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
  // Super-admin-only tabs (Guilds).
  for (const t of document.querySelectorAll('.tab-super')) t.classList.toggle('hidden', !me.isSuper);

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
  // Preserve the current selection across repopulation (e.g. allow-list edits).
  state.guildId = guilds.some((g) => g.id === state.guildId)
    ? state.guildId
    : guilds.length ? guilds[0].id : null;
  sel.value = state.guildId || (me.isSuper ? '__custom__' : '');
  if (!setupScope._bound) {
    setupScope._bound = true;
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
      // Drawers were built for the previous guild (its pickers, its ids) and
      // submit against the current one — close them rather than let a form
      // opened in one guild write into another.
      closeDrawer();
      render();
    });
  }
}

/** Re-fetch the manageable-guild list and rebuild the scope switcher (used
 *  after allow-list edits so new guilds appear without a re-login). */
async function refreshScope() {
  let guilds = [];
  try { guilds = (await api('GET', '/admin/guilds')).guilds || []; }
  catch { guilds = (state.me && state.me.guilds) || []; }
  setupScope(state.me, guilds);
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
  // Super-admins reach the global persona list (profile, token) without a
  // guild — e.g. before the relay has joined any.
  const globalPersonas = state.tab === 'personas' && state.me && state.me.isSuper;
  if (GUILD_TABS.has(state.tab) && !state.guildId && !globalPersonas) {
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
    else if (state.tab === 'guilds') await renderGuilds(view);
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

// ── Personas ─────────────────────────────────────────────────────────────────
// One place for a persona — the only kind of speaker portal has. The list is
// scoped to the selected guild (personas with access there); super-admins can
// widen it to every persona. The drawer shows what an admin of this guild may
// change, and — for super-admins — the persona's profile, its access in every
// guild, and its token.

async function renderPersonas(view) {
  const isSuper = !!(state.me && state.me.isSuper);
  const all = isSuper && (state.personaScope === 'all' || !state.guildId);
  const meta = state.guildId ? await guildMeta() : null;
  const data = all
    ? await api('GET', '/admin/personas' + qs({ q: state.q, limit: LIMIT, offset: state.offset }))
    : await api('GET', G() + '/personas' + qs({ q: state.q, limit: LIMIT, offset: state.offset }));
  clear(view);

  const actions = [];
  if (isSuper && state.guildId) {
    const scope = el('select', { class: 'scope-select', title: 'Which personas to list' }, [
      el('option', { value: 'guild', text: 'With access in ' + currentGuildName() }),
      el('option', { value: 'all', text: 'All personas' }),
    ]);
    scope.value = all ? 'all' : 'guild';
    scope.addEventListener('change', () => { state.personaScope = scope.value; state.q = ''; state.offset = 0; render(); });
    actions.push(scope);
  }
  if (!all) {
    const grantById = el('button', { class: 'btn btn-sm btn-primary', text: '+ Grant access by id' });
    grantById.addEventListener('click', () => {
      const id = (prompt('Persona id to grant access to (must already exist):') || '').trim();
      if (id) openPersonaDrawer(id, meta);
    });
    actions.push(grantById);
  }
  view.appendChild(toolbar(all ? 'Search all personas…' : 'Search personas with access here…', actions));

  const rows = (data.personas || []).map((p) => rowClick(el('tr', { onclick: () => openPersonaDrawer(p.id, meta) }, [
    el('td', { class: 'col-narrow' }, [avatarThumb(p.avatarUrl, p.displayName || p.id)]),
    el('td', { text: p.displayName || p.id }),
    el('td', {}, [el('code', { text: p.id })]),
    el('td', { class: 'cell-roles', text: (p.roles || []).join(', ') || '—' }),
    all
      ? el('td', { class: 'col-narrow', text: String(p.guildCount != null ? p.guildCount : '—') })
      : el('td', {}, [p.hasOverride ? el('span', { class: 'badge badge-warn', text: 'direct grants' }) : el('span', { class: 'muted', text: '—' })]),
  ])));
  view.appendChild(table([
    { label: '', cls: 'col-narrow' }, { label: 'Name' }, { label: 'Id' }, { label: 'Access roles' },
    all ? { label: 'Guilds', cls: 'col-narrow' } : { label: 'Direct grants', cls: 'col-narrow' },
  ], rows));
  view.appendChild(pager(data));
  view.appendChild(el('p', { class: 'hint muted', text: all
    ? 'Every persona the relay knows. Open one to see its access in every guild, its profile picture and its token.'
    : 'Personas with access in this guild. To add one that has none yet, use “Grant access by id”' +
      (isSuper ? ', switch to All personas,' : '') + ' or mint an invite for an agent to claim.' }));
}

async function openPersonaDrawer(id, meta) {
  const isSuper = !!(state.me && state.me.isSuper);
  // What an admin of this guild may see and change…
  let local = null;
  if (state.guildId) {
    try { local = await api('GET', G() + '/personas/' + encodeURIComponent(id)); }
    catch (e) {
      if (e.status !== 404) { banner('Load failed: ' + e.message, 'err'); return; }
      if (!isSuper) local = { id, displayName: id, roles: [], guildPolicy: null }; // grant by id
    }
  }
  // …and, for super-admins, the persona everywhere.
  let global = null;
  if (isSuper) {
    try { global = await api('GET', '/admin/personas/' + encodeURIComponent(id)); }
    catch (e) { banner('Load failed: ' + e.message, 'err'); return; }
  }
  const displayName = (global && global.displayName) || (local && local.displayName) || id;
  const body = el('div', { class: 'drawer-sections' });

  // "Access in every guild" is rebuilt after any change made in this drawer,
  // so the two sections never disagree.
  const everywhere = el('div', {});
  let refreshSeq = 0; // only the latest refresh may draw: replies can land out of order
  const refreshEverywhere = async () => {
    if (!isSuper) return;
    const seq = ++refreshSeq;
    try {
      const fresh = await api('GET', '/admin/personas/' + encodeURIComponent(id));
      if (seq !== refreshSeq) return;
      clear(everywhere);
      everywhere.appendChild(everywhereSection(fresh));
    } catch { /* keep what is shown; the next open refreshes */ }
  };
  if (global) body.appendChild(profileSection(id, global));
  if (state.guildId && meta && (local || global)) {
    body.appendChild(guildAccessSection(id, local || { id, roles: (global && global.roles || []).map((r) => r.name), guildPolicy: null }, meta, refreshEverywhere));
  }
  if (global) {
    everywhere.appendChild(everywhereSection(global));
    body.appendChild(everywhere);
    body.appendChild(tokenSection(id));
  }

  openDrawer(displayName, body);
  $('#drawer-title').appendChild(el('span', { class: 'muted mono', text: ' ' + id }));
}

function section(title, children) {
  return el('section', { class: 'drawer-section' }, [el('h3', { text: title }), el('div', {}, children)]);
}

/** Super-admin: the persona's profile picture (global — it shows everywhere). */
function profileSection(id, d) {
  const avImg = avatarThumb(d.avatarUrl, d.displayName || id, 'avatar-preview');
  const avInput = el('input', { type: 'text', value: d.avatar || '', placeholder: 'https://…/avatar.png' });
  const saveAv = el('button', { class: 'btn btn-sm btn-primary', text: 'Save' });
  saveAv.addEventListener('click', async () => {
    try {
      const r = await api('PUT', '/admin/personas/' + encodeURIComponent(id) + '/avatar', { avatar: avInput.value.trim() });
      avInput.value = r.avatar || '';
      if (r.avatarUrl) { avImg.src = r.avatarUrl; avImg.classList.remove('hidden'); } else { avImg.removeAttribute('src'); avImg.classList.add('hidden'); }
      banner('Avatar updated — applies to the persona’s next message.');
    } catch (e) { banner('Avatar update failed: ' + e.message, 'err'); }
  });
  const clearAv = el('button', { class: 'btn btn-sm', text: 'Clear', onclick: () => { avInput.value = ''; saveAv.click(); } });
  return section('Profile picture', [
    el('div', { class: 'avatar-row' }, [avImg, el('div', { class: 'avatar-edit' }, [avInput, el('div', { class: 'inline' }, [saveAv, clearAv])])]),
    avatarCropper(id, avImg, avInput),
    el('p', { class: 'muted', text: 'Paste an image URL above, or upload + crop a file. Discord fetches it on the next message; past messages keep their old picture.' }),
  ]);
}

/** Access in the selected guild: access roles, claiming an invite, direct grants. */
function guildAccessSection(id, detail, meta, onChange = () => {}) {
  const roleTags = el('div', { class: 'tags' });
  function drawRoles(roles) {
    clear(roleTags);
    (roles || []).forEach((r) => roleTags.appendChild(el('span', { class: 'tag' }, [
      r, el('span', { class: 'x', text: '✕', title: 'revoke', onclick: () => revokeRole(id, r, drawRoles, onChange) }),
    ])));
    if (!roles || !roles.length) roleTags.appendChild(el('span', { class: 'muted', text: 'no access roles' }));
  }
  drawRoles(detail.roles);
  const roleNames = Object.keys(meta.catalog || {});
  const addRole = el('select', {}, [el('option', { value: '', text: '+ add access role…' })].concat(
    roleNames.map((n) => el('option', { value: n, text: n }))));
  addRole.addEventListener('change', async () => {
    if (!addRole.value) return;
    try { const r = await api('POST', G() + '/personas/' + encodeURIComponent(id) + '/roles', { role: addRole.value }); drawRoles(r.roles); banner('Access role assigned'); addRole.value = ''; onChange(); }
    catch (e) { banner('Assign failed: ' + e.message, 'err'); }
  });

  const claimCode = el('input', { type: 'text', placeholder: 'invite code' });
  const claimBtn = el('button', { class: 'btn btn-sm', text: 'Claim' });
  claimBtn.addEventListener('click', async () => {
    if (!claimCode.value.trim()) return banner('Enter an invite code.', 'err');
    try { const r = await api('POST', G() + '/personas/' + encodeURIComponent(id) + '/claim', { code: claimCode.value.trim() }); drawRoles(r.roles); banner('Invite applied'); claimCode.value = ''; onChange(); }
    catch (e) { banner('Claim failed: ' + e.message, 'err'); }
  });

  return el('section', { class: 'drawer-section' }, [
    el('h3', { text: 'Access in ' + currentGuildName() }),
    el('div', { class: 'field' }, [el('label', { text: 'Access roles' }), el('div', { class: 'inline' }, [roleTags, addRole])]),
    el('div', { class: 'field' }, [el('label', { text: 'Claim an invite for it' }), el('div', { class: 'inline' }, [claimCode, claimBtn])]),
    grantEditor(id, detail.guildPolicy, meta.channels, withChannelList(detail.names, meta.channels), onChange),
  ]);
}

/** Super-admin: where the persona can act, what each access role confers, and
 *  its direct grants in every guild (read-only — edit them per guild). */
function everywhereSection(d) {
  const guilds = d.guilds || [];
  const names = d.names || {};
  names.guilds = Object.assign({}, names.guilds);
  guilds.forEach((g) => { if (g.name && !names.guilds[g.id]) names.guilds[g.id] = g.name; });

  const kids = [];
  kids.push(el('div', { class: 'field' }, [el('label', { text: 'Guilds it can act in' }),
    guilds.length
      ? el('ul', { class: 'plain' }, guilds.map((g) => el('li', {}, [g.name || g.id, el('span', { class: 'muted mono', text: ' ' + g.id })])))
      : el('p', { class: 'muted', text: 'None.' })]));

  const roles = d.roles || [];
  kids.push(el('div', { class: 'field' }, [el('label', { text: 'Access roles' }),
    roles.length
      ? el('ul', { class: 'plain' }, roles.map((r) => el('li', {}, [
          el('strong', { text: r.name }),
          r.scope ? el('span', { class: 'muted', title: scopeIds(r.scope), text: ' — ' + scopeSummary(r.scope, names) + (r.guildId ? ' in ' + guildText(r.guildId, names) : '') }) : null,
          el('div', { class: 'cell-roles', text: capsSummary(r.caps) }),
        ])))
      : el('p', { class: 'muted', text: 'None.' })]));

  const pol = d.policy;
  const polGuilds = pol && pol.guilds ? Object.entries(pol.guilds) : [];
  if ((pol && pol.default && pol.default.length) || polGuilds.length) {
    const grantKids = [];
    if (pol.default && pol.default.length) grantKids.push(el('div', { class: 'cell-roles', text: 'everywhere: ' + capsSummary(pol.default) }));
    for (const [gid, gp] of polGuilds) {
      const lines = [];
      if (gp.default && gp.default.length) lines.push(el('div', { class: 'cell-roles', text: 'whole guild: ' + capsSummary(gp.default) }));
      const rows = Object.entries(gp.channels || {}).sort((a, b) => byName(chanText(a[0], names), chanText(b[0], names)));
      for (const [cid, caps] of rows) lines.push(el('div', { class: 'grant-line' }, [chanNode(cid, names), el('span', { class: 'muted', text: ' — ' + capsSummary(caps) })]));
      grantKids.push(el('div', { class: 'grant-guild' }, [el('strong', { text: guildText(gid, names), title: gid }), ...lines]));
    }
    kids.push(el('div', { class: 'field' }, [el('label', { text: 'Direct grants' }), ...grantKids]));
  }
  return section('Access in every guild', kids);
}

/** Super-admin: the token authenticates the persona everywhere, so its
 *  lifecycle isn't a per-guild action. */
function tokenSection(id) {
  const rotate = el('button', { class: 'btn btn-sm', text: 'Rotate token' });
  rotate.addEventListener('click', () => tokenAction(id, 'rotate'));
  const revoke = el('button', { class: 'btn btn-sm btn-danger', text: 'Revoke token' });
  revoke.addEventListener('click', () => tokenAction(id, 'revoke'));
  return section('Token', [
    el('p', { class: 'muted', text: 'The token is how an agent logs in as this persona, in every guild. Rotate issues a new one (shown once); revoke invalidates it and drops live sessions.' }),
    el('div', { class: 'inline' }, [rotate, revoke]),
  ]);
}

function grantEditor(id, policy0, channels, names, onChange = () => {}) {
  const det = el('details', { class: 'advanced' }, [el('summary', { text: 'Direct grants (this guild only)' })]);
  const body = el('div', {});
  function draw(policy) {
    clear(body);
    const gd = (policy && policy.default) || [];
    const chans = (policy && policy.channels) || {};
    const keys = Object.keys(chans).sort((a, b) => byName(chanText(a, names), chanText(b, names)));
    const rows = [];
    if (gd.length) rows.push(el('tr', {}, [el('td', { text: 'guild-default' }), el('td', { class: 'cell-roles', text: capsSummary(gd) }), el('td', {}, [el('button', { class: 'btn btn-sm btn-danger', text: 'clear', onclick: () => clearGrant(id, null, draw, onChange) })])]));
    for (const cid of keys) rows.push(el('tr', {}, [
      el('td', {}, [chanNode(cid, names)]),
      el('td', { class: 'cell-roles', text: capsSummary(chans[cid] || []) }),
      el('td', {}, [el('button', { class: 'btn btn-sm btn-danger', text: 'clear', onclick: () => clearGrant(id, cid, draw, onChange) })]),
    ]));
    body.appendChild(table([{ label: 'Target' }, { label: 'Caps' }, { label: '', cls: 'col-narrow' }], rows));

    const target = el('select', {}, [el('option', { value: '', text: 'guild-default' })].concat(
      channelOptions(channels).map((o) => el('option', { value: o.value, text: o.text }))));
    const caps = capsCheckboxes();
    const setBtn = el('button', { class: 'btn btn-sm btn-primary', text: 'Set grant' });
    setBtn.addEventListener('click', async () => {
      const reqBody = { caps: caps.values() };
      if (target.value) reqBody.channelId = target.value;
      try { const r = await api('PUT', G() + '/personas/' + encodeURIComponent(id) + '/grants', reqBody); draw(r.guildPolicy); banner('Grant updated'); onChange(); }
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

async function clearGrant(id, channelId, draw, onChange = () => {}) {
  let path = G() + '/personas/' + encodeURIComponent(id) + '/grants';
  if (channelId) path += '?channelId=' + encodeURIComponent(channelId);
  try { const r = await api('DELETE', path); draw(r.guildPolicy); banner('Grant cleared'); onChange(); }
  catch (e) { banner('Clear failed: ' + e.message, 'err'); }
}
async function revokeRole(id, role, drawRoles, onChange = () => {}) {
  try { const r = await api('DELETE', G() + '/personas/' + encodeURIComponent(id) + '/roles/' + encodeURIComponent(role)); drawRoles(r.roles); banner('Access role revoked'); onChange(); }
  catch (e) { banner('Revoke failed: ' + e.message, 'err'); }
}

// ── Invites (guild-scoped) ─────────────────────────────────────────────────────

async function renderInvites(view) {
  const meta = await guildMeta();
  const data = await api('GET', G() + '/invites' + qs({ q: state.q, limit: LIMIT, offset: state.offset }));
  const names = withChannelList(data.names, meta.channels, meta.discordRoles);
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
    el('td', { class: 'cell-roles', text: grantSummary(inv, names), title: scopeIds(inv.grant && inv.grant.scope) || undefined }),
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
  const chanSel = multiSelect(channelOptions(meta.channels), 'No channels.');
  const mirrorSel = el('select', {}, [...(meta.discordRoles || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((r) => el('option', { value: r.id, text: r.name + (r.pooled ? ' (pool)' : '') })));
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

function scopeSummary(scope, names) {
  if (!scope) return '—';
  if (scope.all) return 'all channels';
  if (Array.isArray(scope.channels)) return listSummary(scope.channels.map((c) => chanText(c, names)), 'no channels');
  if (Array.isArray(scope.mirrorRoles)) return 'mirrors ' + listSummary(scope.mirrorRoles.map((r) => roleText(r, names)), 'no roles');
  if (typeof scope.mirrorRole === 'string') return 'mirrors ' + roleText(scope.mirrorRole, names);
  return '?';
}
function grantSummary(inv, names) {
  if (inv.roles && inv.roles.length) return 'roles: ' + inv.roles.join(', ');
  if (inv.grant) return scopeSummary(inv.grant.scope, names) + ' — ' + capsSummary(inv.grant.caps);
  if (inv.caps && inv.caps.length) return 'blanket(deprecated): ' + capsSummary(inv.caps);
  return 'deny';
}

// ── Roles (guild-scoped read, global authoring) ─────────────────────────────────

async function renderRoles(view) {
  const meta = await guildMeta();
  const { catalog, discordRoles, canAuthor, names: rawNames } = await api('GET', G() + '/roles' + qs({ names: '1' }));
  const names = withChannelList(rawNames, meta.channels, discordRoles);
  clear(view);

  const actions = [];
  if (canAuthor) {
    const add = el('button', { class: 'btn btn-sm btn-primary', text: '+ Define access role' });
    add.addEventListener('click', () => openRoleDrawer(discordRoles, meta.channels));
    actions.push(add);
  }
  view.appendChild(toolbar('Filter access roles…', actions));

  const roleNames = Object.keys(catalog || {}).filter((n) => !state.q || n.toLowerCase().includes(state.q.toLowerCase()));
  const rows = roleNames.map((n) => {
    const r = catalog[n];
    const cells = [
      el('td', {}, [el('code', { text: n })]),
      el('td', { class: 'cell-roles', text: (r.caps || []).join(', ') }),
      el('td', { class: 'cell-roles', text: scopeSummary(r.scope, names), title: scopeIds(r.scope) }),
      el('td', {}, [r.guildId ? el('span', { text: guildText(r.guildId, names), title: r.guildId }) : el('span', { class: 'muted', text: '—' })]),
    ];
    if (canAuthor) cells.push(el('td', {}, [el('button', { class: 'btn btn-sm btn-danger', text: 'Delete', onclick: () => deleteRole(n) })]));
    return el('tr', {}, cells);
  });
  const headers = [{ label: 'Name' }, { label: 'Caps' }, { label: 'Scope' }, { label: 'Guild' }];
  if (canAuthor) headers.push({ label: '', cls: 'col-narrow' });
  view.appendChild(table(headers, rows));
  view.appendChild(el('p', { class: 'hint muted', text: canAuthor
    ? 'The access-role catalog is global (shared across all guilds). Editing here is super-admin only.'
    : 'The role catalog is global and authored by operators. Express access by minting invites that mirror your Discord roles or pick channels.' }));
}

function openRoleDrawer(discordRoles, channels) {
  // The guild this drawer was opened for — its pickers list this guild's
  // channels and roles, so the role must be saved to it whatever happens to
  // the scope switcher meanwhile.
  const gid = state.guildId;
  const name = el('input', { type: 'text', placeholder: 'role name' });
  const caps = capsCheckboxes();
  // Roles are guild-scoped (the API requires guildId): a role is defined in the
  // guild being viewed, from that guild's channels and Discord roles. To define
  // one for another guild, switch the guild scope first.
  const kind = el('select', {}, [
    el('option', { value: 'all', text: 'all channels' }),
    el('option', { value: 'channels', text: 'channels' }),
    el('option', { value: 'mirrorRole', text: 'mirror Discord role' }),
    el('option', { value: 'mirrorRoles', text: 'mirror several Discord roles' }),
  ]);
  const roleOpts = [...(discordRoles || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((r) => ({ value: r.id, text: r.name }));
  const mirrorSel = el('select', {}, roleOpts.map((o) => el('option', { value: o.value, text: o.text })));
  const mirrorMulti = multiSelect(roleOpts, 'No Discord roles.');
  const chanMulti = multiSelect(channelOptions(channels), 'No channels.');
  const scopeArea = el('div', { class: 'field' });
  function sync() {
    clear(scopeArea);
    if (kind.value === 'mirrorRole') scopeArea.appendChild(mirrorSel);
    else if (kind.value === 'mirrorRoles') scopeArea.appendChild(mirrorMulti.node);
    else if (kind.value === 'channels') scopeArea.appendChild(chanMulti.node);
  }
  kind.addEventListener('change', sync); sync();

  const submit = el('button', { class: 'btn btn-primary', text: 'Create role' });
  submit.addEventListener('click', async () => {
    if (!name.value.trim()) return banner('Name required.', 'err');
    let scope;
    if (kind.value === 'all') scope = { all: true };
    else if (kind.value === 'mirrorRole') { if (!mirrorSel.value) return banner('Pick a Discord role.', 'err'); scope = { mirrorRole: mirrorSel.value }; }
    else if (kind.value === 'mirrorRoles') { const ids = mirrorMulti.values(); if (!ids.length) return banner('Pick at least one Discord role.', 'err'); scope = { mirrorRoles: ids }; }
    else { const ids = chanMulti.values(); if (!ids.length) return banner('Pick at least one channel.', 'err'); scope = { channels: ids }; }
    const role = { caps: caps.values(), scope, guildId: gid };
    try { await api('POST', '/admin/roles', { name: name.value.trim(), role }); banner('Role created'); invalidateGuildMeta(); closeDrawer(); render(); }
    catch (e) { banner('Create failed: ' + e.message, 'err'); }
  });

  openDrawer('Define access role', el('div', { class: 'drawer-sections' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Name' }), name]),
    el('div', { class: 'field' }, [el('label', { text: 'Scope kind' }), kind]),
    scopeArea,
    el('div', { class: 'field' }, [el('label', { text: 'Guild' }), el('div', { title: gid, text: currentGuildName() })]),
    el('div', { class: 'field' }, [el('label', { text: 'Capabilities' }), caps.node]),
    submit,
  ]));
}

async function deleteRole(name) {
  if (!confirm('Delete access role "' + name + '"? Assignees lose those caps on their next action.')) return;
  try { await api('DELETE', '/admin/roles/' + encodeURIComponent(name)); banner('Role deleted'); invalidateGuildMeta(); render(); }
  catch (e) { banner('Delete failed: ' + e.message, 'err'); }
}

// ── Guilds (super-admin, GLOBAL): the relay's guild allow-list ────────────────

async function renderGuilds(view) {
  const data = await api('GET', '/admin/guilds/all');
  clear(view);

  const allowed = (data.guilds || []).filter((g) => g.allowed);
  const candidates = (data.guilds || []).filter((g) => !g.allowed);

  if (!data.editable) {
    view.appendChild(el('div', { class: 'banner', text:
      'Read-only: the allow-list is env-managed (DISCORD_GUILD_ID). Set PORTAL_GUILDS on the relay to edit it here.' }));
    if ((data.allowlist || []).length === 0) {
      view.appendChild(el('p', { class: 'hint muted', text:
        'No restriction configured — ALL joined guilds are relayed.' }));
    }
  } else if ((data.allowlist || []).length === 0) {
    view.appendChild(el('div', { class: 'banner err', text:
      'Allow-list is EMPTY — the relay is ignoring every guild (deny-all).' }));
  }

  if (data.editable) {
    const input = el('input', { class: 'search', type: 'text', placeholder: 'guild id to allow…' });
    const add = el('button', { class: 'btn btn-sm btn-primary', text: 'Allow id' });
    add.addEventListener('click', () => allowGuild(input.value.trim()));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') allowGuild(input.value.trim()); });
    view.appendChild(el('div', { class: 'toolbar' }, [input, el('div', { class: 'toolbar-actions' }, [add])]));
  }

  const rows = allowed.map((g) => {
    const cells = [
      el('td', {}, g.present === false
        ? [el('span', { class: 'muted', text: '(unknown)' }), ' ', el('span', { class: 'badge badge-warn', text: 'not joined' })]
        : [g.name || g.id]),
      el('td', {}, [el('code', { text: g.id })]),
      el('td', { class: 'col-narrow', text: g.memberCount != null ? String(g.memberCount) : '—' }),
    ];
    if (data.editable) {
      cells.push(el('td', { class: 'col-narrow' }, [
        el('button', { class: 'btn btn-sm btn-danger', text: 'Remove', onclick: () => disallowGuild(g, allowed.length) }),
      ]));
    }
    return el('tr', {}, cells);
  });
  const headers = [{ label: 'Allowed guild' }, { label: 'Id' }, { label: 'Members', cls: 'col-narrow' }];
  if (data.editable) headers.push({ label: '', cls: 'col-narrow' });
  view.appendChild(table(headers, rows));

  if (candidates.length) {
    view.appendChild(el('h3', { class: 'muted', text: 'Bot is in these guilds, but they are not allowed' }));
    view.appendChild(table(
      [{ label: 'Guild' }, { label: 'Id' }, { label: 'Members', cls: 'col-narrow' },
       ...(data.editable ? [{ label: '', cls: 'col-narrow' }] : [])],
      candidates.map((g) => el('tr', {}, [
        el('td', { text: g.name || g.id }),
        el('td', {}, [el('code', { text: g.id })]),
        el('td', { class: 'col-narrow', text: g.memberCount != null ? String(g.memberCount) : '—' }),
        ...(data.editable
          ? [el('td', { class: 'col-narrow' }, [el('button', { class: 'btn btn-sm btn-primary', text: 'Allow', onclick: () => allowGuild(g.id) })])]
          : []),
      ])),
    ));
  }

  view.appendChild(el('p', { class: 'hint muted', text:
    'The allow-list controls which Discord guilds the relay serves at all (events, history, sending). ' +
    'Changes apply immediately — no relay restart, no Discord reconnect. Edits are audited.' }));
}

async function allowGuild(gid) {
  if (!gid) return;
  if (!/^\d{5,25}$/.test(gid)) return banner('Not a Discord guild id (snowflake).', 'err');
  try {
    const r = await api('POST', '/admin/guilds', { guildId: gid });
    banner(r.warning ? 'Allowed (dormant): ' + r.warning : 'Guild allowed');
    await refreshScope();
    render();
  } catch (e) { banner('Allow failed: ' + e.message, 'err'); }
}

async function disallowGuild(g, allowedCount) {
  const name = g.name || g.id;
  let msg = 'Remove "' + name + '" from the allow-list? The relay stops serving it immediately.';
  if (allowedCount === 1) msg += '\n\nThis is the LAST allowed guild — the relay will deny ALL guilds.';
  if (!confirm(msg)) return;
  try {
    const r = await api('DELETE', '/admin/guilds/' + encodeURIComponent(g.id));
    banner(r.denyAll ? 'Guild removed — allow-list now EMPTY (deny-all)' : 'Guild removed', r.denyAll ? 'err' : undefined);
    await refreshScope();
    render();
  } catch (e) { banner('Remove failed: ' + e.message, 'err'); }
}

// ── Audit (guild-scoped) ───────────────────────────────────────────────────────

async function renderAudit(view) {
  const meta = await guildMeta();
  const { records, names: rawNames } = await api('GET', G() + '/audit' + qs({ limit: 200 }));
  const names = withChannelList(rawNames, meta.channels);
  clear(view);
  view.appendChild(toolbar('Filter audit…', []));
  const q = state.q.toLowerCase();
  const filtered = (records || []).filter((r) => !q || (JSON.stringify(r) + ' ' + auditTargetText(r, names)).toLowerCase().includes(q));
  const rows = filtered.map((r) => el('tr', {}, [
    el('td', { class: 'mono', text: r.ts ? new Date(r.ts).toLocaleString() : '—' }),
    el('td', {}, [(r.actor && r.actor.name) || '?', ' ', el('span', { class: 'muted', text: r.actor ? '(' + r.actor.kind + ')' : '' })]),
    el('td', {}, [el('code', { text: r.action })]),
    el('td', { class: 'cell-roles', title: r.detail ? JSON.stringify(r.detail) : undefined }, auditTarget(r, names)),
    el('td', {}, [el('span', { class: r.ok ? 'badge-ok' : 'badge-no', text: r.ok ? '✓' : '✗' })]),
  ]));
  view.appendChild(table([{ label: 'Time' }, { label: 'Actor' }, { label: 'Action' }, { label: 'Target' }, { label: 'OK', cls: 'col-narrow' }], rows));
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

function avatarThumb(url, alt, cls) {
  const img = el('img', { class: 'avatar-thumb' + (cls ? ' ' + cls : ''), alt: alt || '' });
  if (url) img.src = url; else img.classList.add('hidden');
  return img;
}

// Upload + square-crop control for a persona avatar. Reads a chosen image, lets
// the admin pan/zoom inside a circular 240px viewport (Discord masks avatars to a
// circle), renders the selected square to a 256×256 canvas, and POSTs the PNG to
// /admin/personas/:id/avatar/upload. On success it updates the preview img and URL
// field passed in. Pure client-side crop — no server image library needed.
function avatarCropper(id, avImg, avInput) {
  const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'hidden' });
  const pick = el('button', { class: 'btn btn-sm', text: 'Upload image…', onclick: () => fileInput.click() });
  const stage = el('div', {}); // cropper renders here once a file is chosen
  const wrap = el('div', { class: 'avatar-upload' }, [el('div', { class: 'inline' }, [pick, fileInput]), stage]);

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) { banner('Please choose an image file.', 'err'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => buildCropper(img);
      img.onerror = () => banner('Could not read that image.', 'err');
      img.src = reader.result;
    };
    reader.onerror = () => banner('Could not read that file.', 'err');
    reader.readAsDataURL(file);
  });

  function buildCropper(img) {
    clear(stage);
    const V = 240, O = 256;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) { banner('That image has no dimensions.', 'err'); return; }
    const base = Math.max(V / iw, V / ih); // cover the viewport
    let zoom = 1, scale = base, ox = 0, oy = 0;

    const display = el('img', { class: 'cropper-img', src: img.src, alt: '' });
    const viewport = el('div', { class: 'cropper' }, [display]);
    const zoomInput = el('input', { type: 'range', min: '1', max: '3', step: '0.01', value: '1', class: 'cropper-zoom' });

    function apply() {
      const dw = iw * scale, dh = ih * scale;
      ox = Math.min(0, Math.max(V - dw, ox));
      oy = Math.min(0, Math.max(V - dh, oy));
      display.style.width = dw + 'px';
      display.style.height = dh + 'px';
      display.style.left = ox + 'px';
      display.style.top = oy + 'px';
    }
    ox = (V - iw * scale) / 2; oy = (V - ih * scale) / 2; apply();

    zoomInput.addEventListener('input', () => {
      const old = scale;
      zoom = parseFloat(zoomInput.value) || 1;
      scale = base * zoom;
      // Keep the viewport centre fixed across zoom.
      const cx = (-ox + V / 2) / old, cy = (-oy + V / 2) / old;
      ox = V / 2 - cx * scale; oy = V / 2 - cy * scale;
      apply();
    });

    let dragging = false, lx = 0, ly = 0;
    viewport.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; try { viewport.setPointerCapture(e.pointerId); } catch (x) {} });
    viewport.addEventListener('pointermove', (e) => { if (!dragging) return; ox += e.clientX - lx; oy += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply(); });
    const end = (e) => { dragging = false; try { viewport.releasePointerCapture(e.pointerId); } catch (x) {} };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);

    const up = el('button', { class: 'btn btn-sm btn-primary', text: 'Upload' });
    const cancel = el('button', { class: 'btn btn-sm', text: 'Cancel', onclick: () => { clear(stage); fileInput.value = ''; } });
    up.addEventListener('click', () => {
      up.disabled = true; up.textContent = 'Uploading…';
      const canvas = el('canvas');
      canvas.width = O; canvas.height = O;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, -ox / scale, -oy / scale, V / scale, V / scale, 0, 0, O, O);
      canvas.toBlob(async (blob) => {
        if (!blob) { up.disabled = false; up.textContent = 'Upload'; banner('Could not render the cropped image.', 'err'); return; }
        try {
          const res = await fetch('/admin/personas/' + encodeURIComponent(id) + '/avatar/upload', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'image/png', 'X-CSRF-Token': (state.me && state.me.csrf) || '' },
            body: blob,
          });
          if (res.status === 401) { showLogin(); return; }
          const text = await res.text();
          let data = null; if (text) { try { data = JSON.parse(text); } catch (x) { /* non-JSON */ } }
          if (!res.ok) { const e = (data && data.error) || {}; throw new Error(e.message || ('HTTP ' + res.status)); }
          avInput.value = (data && data.avatar) || '';
          if (data && data.avatarUrl) { avImg.src = data.avatarUrl; avImg.classList.remove('hidden'); }
          banner('Avatar uploaded — applies to the persona’s next message.');
          clear(stage); fileInput.value = '';
        } catch (e) {
          up.disabled = false; up.textContent = 'Upload';
          banner('Upload failed: ' + e.message, 'err');
        }
      }, 'image/png');
    });

    stage.appendChild(el('div', { class: 'cropper-wrap' }, [
      viewport,
      el('div', { class: 'cropper-controls' }, [
        el('label', { class: 'muted', text: 'Drag to position · zoom' }),
        zoomInput,
        el('div', { class: 'inline' }, [up, cancel]),
      ]),
    ]));
  }

  return wrap;
}

function capsCheckboxes(selected) {
  const sel = new Set(selected || []);
  const node = el('div', { class: 'caps-groups' });
  const boxes = [];
  for (const g of CAP_GROUPS) {
    if (g.caps.length === 1) {
      // Elevated singleton: one checkbox, labelled with the group name.
      const cb = el('input', { type: 'checkbox', value: g.caps[0], checked: sel.has(g.caps[0]) });
      boxes.push(cb);
      node.appendChild(el('label', { class: 'cap-row' }, [cb, el('span', { class: 'cap-name', text: g.label })]));
      continue;
    }
    // Multi-cap group: a roll-up toggle + the individual caps as small chips.
    const children = g.caps.map((c) => { const cb = el('input', { type: 'checkbox', value: c, checked: sel.has(c) }); boxes.push(cb); return cb; });
    const roll = el('input', { type: 'checkbox' });
    const sync = () => { const on = children.filter((b) => b.checked).length; roll.checked = on === children.length; roll.indeterminate = on > 0 && on < children.length; };
    roll.addEventListener('change', () => { children.forEach((b) => { b.checked = roll.checked; }); });
    children.forEach((b) => b.addEventListener('change', sync));
    sync();
    node.appendChild(el('div', { class: 'cap-group' }, [
      el('label', { class: 'cap-row' }, [roll, el('span', { class: 'cap-name', text: g.label })]),
      el('div', { class: 'cap-chips' }, children.map((cb, i) => el('label', { class: 'cap-chip' }, [cb, el('span', { text: capShort(g.caps[i]) })]))),
    ]));
  }
  return { node, values: () => boxes.filter((b) => b.checked).map((b) => b.value) };
}

function multiSelect(options, emptyText) {
  const opts = (options || []).map((o) => (typeof o === 'string' ? { value: o, text: o } : o));
  if (!opts.length) return { node: el('span', { class: 'muted', text: emptyText || 'none' }), values: () => [] };
  const node = el('select', { multiple: true, size: String(Math.min(6, Math.max(2, opts.length))) }, opts.map((o) => el('option', { value: o.value, text: o.text })));
  return { node, values: () => Array.from(node.selectedOptions).map((o) => o.value) };
}

// ── Names ─────────────────────────────────────────────────────────────────────
// API responses carry `names` maps — {channels, discordRoles, guilds, personas},
// keyed by id — so the panel shows names and keeps ids in tooltips. Channel
// labels come from the relay, which also names archived threads and deleted
// channels (the guild channel list only holds live ones).

/** Fold the guild's live channel list (and Discord roles) under the server's
 *  name maps; the server's labels win (they carry parent names, flags). */
function withChannelList(names, channels, discordRoles) {
  const out = Object.assign({}, names || {});
  const byId = {};
  for (const c of channels || []) byId[c.id] = c;
  const chans = {};
  for (const c of channels || []) {
    const p = c.parentId ? byId[c.parentId] : null;
    chans[c.id] = { id: c.id, name: c.name || null, type: c.type, parentId: c.parentId, parentName: p ? p.name || null : undefined };
  }
  out.channels = Object.assign(chans, out.channels || {});
  const roles = {};
  for (const r of discordRoles || []) roles[r.id] = { name: r.name, guildId: r.guildId };
  out.discordRoles = Object.assign(roles, out.discordRoles || {});
  return out;
}

/** Plain-text channel name: "#general", "#general › thread", or a stand-in. */
function chanText(cid, names) {
  const l = names && names.channels && names.channels[cid];
  if (!l) return cid;
  if (l.unavailable) return 'unavailable channel';
  if (l.hidden) return 'channel hidden from the bot';
  if (l.missing) return 'deleted channel';
  if (!l.name) return cid;
  if (l.type === 'category') return l.name + ' (category)';
  return '#' + (l.parentName ? l.parentName + ' › ' : '') + l.name;
}

/** Channel name as a node: name + small status tags; the id lives in the tooltip
 *  (and is shown only when there is no name to show). */
function chanNode(cid, names) {
  const l = (names && names.channels && names.channels[cid]) || null;
  const kids = [];
  let title = cid;
  if (!l || (!l.name && !l.missing && !l.unavailable)) {
    kids.push(el('code', { text: cid }));
    if (l && l.pending) kids.push(el('span', { class: 'badge', text: 'name loading — reopen' }));
  } else {
    kids.push(el('span', { text: chanText(cid, names) }));
    if (l.missing || l.unavailable) kids.push(el('span', { class: 'muted mono', text: cid }));
    if (l.unavailable) title = cid + ' — deleted, hidden from the bot, or in another guild';
    if (l.archived) kids.push(el('span', { class: 'badge', text: 'archived' }));
    if (l.type === 'voice') kids.push(el('span', { class: 'badge', text: 'voice' }));
  }
  return el('span', { class: 'name-ref', title }, kids);
}

/** Discord role name ("@Mods"), or the id when unknown. */
function roleText(rid, names) {
  const l = names && names.discordRoles && names.discordRoles[rid];
  if (!l) return rid;
  return l.name.startsWith('@') ? l.name : '@' + l.name;
}

function guildText(gid, names) {
  return (names && names.guilds && names.guilds[gid]) || gid;
}

/** The scope switcher's label for the selected guild (its name). */
function currentGuildName() {
  const opt = Array.from($('#guild-select').options).find((o) => o.value === state.guildId);
  return (opt && opt.textContent) || $('#guild-static').textContent || state.guildId;
}

/** "a, b, c +4 more" — keeps table cells readable. */
function listSummary(items, empty, max = 3) {
  if (!items.length) return empty || 'none';
  const head = items.slice(0, max).join(', ');
  return items.length > max ? head + ' +' + (items.length - max) + ' more' : head;
}

/** A scope's raw ids, for tooltips. */
function scopeIds(scope) {
  if (!scope) return '';
  const arr = (v) => (Array.isArray(v) ? v : []);
  return [].concat(arr(scope.channels), arr(scope.mirrorRoles), typeof scope.mirrorRole === 'string' ? [scope.mirrorRole] : []).join(', ');
}

/** Channel picker options: named, threads under their parent, sorted. */
function channelOptions(channels) {
  const names = withChannelList(null, channels);
  return (channels || [])
    .map((c) => ({ value: c.id, text: chanText(c.id, names) }))
    .sort((a, b) => byName(a.text, b.text));
}

/** Natural order for names ("thread-3" before "thread-11"). */
function byName(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }

/** Audit "Target" cell: the persona/guild by name, plus the channel acted in. */
function auditTarget(r, names) {
  const kids = [];
  const t = r.target;
  if (t) {
    const nm = (names.personas && names.personas[t]) || (names.guilds && names.guilds[t]);
    kids.push(nm ? el('span', { text: nm, title: t }) : el('span', { text: t }));
  } else if (r.detail) {
    // No target (e.g. a denied slash command): the detail is what says what
    // happened — keep it, minus the channel, which is named below.
    const rest = Object.assign({}, r.detail);
    delete rest.channelId;
    if (Object.keys(rest).length) kids.push(JSON.stringify(rest));
  }
  const cid = auditChannel(r);
  if (cid) kids.push(kids.length ? ' in ' : '', chanNode(cid, names));
  if (!kids.length) kids.push('—');
  return kids;
}
function auditChannel(r) {
  return (r.detail && r.detail.channelId) || (r.after && r.after.channelId) || (r.before && r.before.channelId) || null;
}
function auditTargetText(r, names) {
  const t = r.target ? ((names.personas && names.personas[r.target]) || (names.guilds && names.guilds[r.target]) || '') : '';
  const cid = auditChannel(r);
  return t + (cid ? ' ' + chanText(cid, names) : '');
}

function showSecret(token) {
  const modal = $('#secret-modal');
  $('#secret-value').textContent = token;
  modal.classList.remove('hidden');
  $('#secret-copy').onclick = async () => { try { await navigator.clipboard.writeText(token); banner('Copied to clipboard'); } catch { banner('Copy failed — select manually', 'err'); } };
  $('#secret-close').onclick = () => { $('#secret-value').textContent = ''; modal.classList.add('hidden'); };
}

// ── Go ───────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', boot);
