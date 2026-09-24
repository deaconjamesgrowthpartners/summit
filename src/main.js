import './styles/base.css';
import { S, wk, ckey, isLeader, memberById, pickGoals, tabFor } from './data/store.js';
import { normalize } from './data/workspace.js';
import { writeOpp, writeCommit, writeGoal, addOpp, acceptLate, onSaved } from './data/writes.js';
import { $, toast, num, addDays } from './lib/format.js';
import { applyBrand } from './lib/theme.js';
import { stageOf, parseCrm, isWon } from './lib/rules.js';
import { renderHeader } from './views/header.js';
import { renderSummit } from './views/summit.js';
import { renderClimb } from './views/climb.js';
import { renderTeam } from './views/team.js';
import { renderAccounts } from './views/accounts.js';
import { renderCheck } from './views/datacheck.js';
import { renderLogin, renderGate } from './views/login.js';

const app = $('#app');
let api, workspaces = [], unsub = null, login = { step: 'email', email: '' };

/* ---------------- routing ---------------- */
const slugFromPath = () => decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '');
const tabFromUrl = () => new URLSearchParams(location.search).get('tab');

function setView(v) {
  if (!tabFor(v)) v = S.cfg.tabs[0]?.key;
  S.view = v;
  const u = new URL(location.href);
  if (v === S.cfg.tabs[0]?.key) u.searchParams.delete('tab'); else u.searchParams.set('tab', v);
  history.replaceState(null, '', u);
  renderAll();
}

/* ---------------- rendering ---------------- */
function renderView(el) {
  const t = tabFor(S.view);
  if (!t) { el.innerHTML = '<div class="card empty">No screens are turned on for this workspace.</div>'; return; }
  if (t.key === 'summit') renderSummit(el);
  else if (t.key === 'climb') renderClimb(el);
  else if (t.team) renderTeam(el, t);
  else if (t.key === 'accounts') renderAccounts(el);
  else if (t.key === 'datacheck') renderCheck(el);
}

function renderAll() {
  if (!S.cfg) return;
  if (!$('#hdr')) app.innerHTML = '<header class="hdr" id="hdr"></header><main class="wrap"><section class="view" id="view"></section></main>';
  renderHeader($('#hdr'), workspaces);
  renderView($('#view'));
}

// live updates: never yank a field out from under someone typing
let raf = null;
function renderSoon() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = null;
    if (!S.cfg || !$('#hdr')) return;
    const a = document.activeElement;
    renderHeader($('#hdr'), workspaces);
    if (a && a.closest && a.closest('#view') && a.matches('input,select,textarea')) return;
    renderView($('#view'));
  });
}
onSaved(renderSoon);

/* ---------------- boot ---------------- */
async function boot() {
  api = import.meta.env.VITE_DEMO === '1' ? await import('./demo/api.js') : await import('./data/api.js');
  S.api = api;
  api.onAuth((s) => {
    const had = !!S.user;
    S.user = s?.user || null;
    if (!had && S.user) start();
    if (had && !S.user) { started = false; teardown(); showLogin(); }
  });
  const s = await api.session();
  S.user = s?.user || null;
  if (S.user) start(); else showLogin();
}

function teardown() {
  if (unsub) unsub();
  unsub = null;
  Object.assign(S, { cfg: null, me: null, admin: false, members: [], opps: {}, commits: {}, goalsRow: null, filters: {}, sort: {}, crm: null });
  applyBrand({});
}

function showLogin() {
  renderLogin(app, login);
}

let starting = false, started = false;
async function start() {
  if (starting || started) return;
  starting = true;
  started = true;
  try {
    app.innerHTML = '<div class="gate"><div class="card empty">Loading</div></div>';
    S.admin = await api.isAdmin(S.user.id).catch(() => false);
    workspaces = await api.workspaces().catch(() => []);
    const slug = slugFromPath();
    if (!slug) {
      if (workspaces.length === 1) { history.replaceState(null, '', `/${workspaces[0].slug}`); return openWorkspace(workspaces[0].slug); }
      return renderGate(app, workspaces.length ? { title: 'Pick a workspace', list: workspaces } : { title: 'Nothing here', body: 'This account is not on a roster yet.' });
    }
    return openWorkspace(slug);
  } finally {
    starting = false;
  }
}

async function openWorkspace(slug) {
  teardown();
  const row = await api.workspace(slug).catch(() => null);
  // same screen whether the slug does not exist or you are not on it
  if (!row) return renderGate(app, { title: 'Nothing here', body: 'Check the link, or sign in with the email your team uses.' });
  S.cfg = normalize(row);
  applyBrand(S.cfg.brand);
  document.title = `Summit · ${S.cfg.name}`;
  const w = wk();
  const data = await api.load(S.cfg.id, addDays(w.prevKey, -77));
  S.members = data.members;
  S.me = data.members.find((m) => m.user_id === S.user.id && m.active) || null;
  if (!S.me && !S.admin) { teardown(); return renderGate(app, { title: 'Nothing here', body: 'Check the link, or sign in with the email your team uses.' }); }
  S.opps = Object.fromEntries(data.opps.map((o) => [o.id, o]));
  S.commits = Object.fromEntries(data.commits.map((c) => [ckey(c.member_id, c.week_key), c]));
  S.goalsRow = pickGoals(data.goals, w.year);
  S.scope = 'company';
  try { const sc = localStorage.getItem(`summit.scope.${S.cfg.id}`); if (sc) S.scope = sc; } catch { /* private mode */ }
  const want = tabFromUrl();
  S.view = tabFor(want) ? want : S.me && S.me.role === 'rep' && S.cfg.teamTab[S.me.team] ? S.cfg.teamTab[S.me.team].key : S.cfg.tabs[0]?.key;
  app.innerHTML = '';
  renderAll();
  unsub = api.subscribe(S.cfg.id, onLive, (st) => {
    const was = S.live;
    S.live = st === 'SUBSCRIBED' ? 'up' : st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED' ? 'down' : S.live;
    if (was === 'down' && S.live === 'up') refresh();
    if (was !== S.live) renderSoon();
  });
}

async function refresh() {
  if (!S.cfg) return;
  try {
    const data = await api.load(S.cfg.id, addDays(wk().prevKey, -77));
    S.members = data.members;
    S.opps = Object.fromEntries(data.opps.map((o) => [o.id, o]));
    S.commits = Object.fromEntries(data.commits.map((c) => [ckey(c.member_id, c.week_key), c]));
    S.goalsRow = pickGoals(data.goals, wk().year) || S.goalsRow;
    renderSoon();
  } catch { /* try again next time */ }
}
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 60000) refresh();
});
// the week rolls over at the lock. re-render every minute so the header stays true.
setInterval(() => S.cfg && renderSoon(), 60000);

function onLive(table, type, row, old) {
  if (table === 'opps') {
    if (type === 'DELETE') delete S.opps[old?.id];
    else if (row) S.opps[row.id] = { ...S.opps[row.id], ...row };
  } else if (table === 'commits') {
    if (type === 'DELETE') { for (const k in S.commits) if (S.commits[k].id === old?.id) delete S.commits[k]; }
    else if (row) {
      const k = ckey(row.member_id, row.week_key);
      const mine = S.commits[k];
      // keep local text if this person is mid-edit on it
      S.commits[k] = mine && mine._new ? mine : { ...row };
    }
  } else if (table === 'goals' && row) {
    if (!S.goalsRow || S.goalsRow.period === row.period) S.goalsRow = row;
  }
  renderSoon();
}

/* ---------------- events ---------------- */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  if (form.dataset.form === 'email') {
    const email = String(new FormData(form).get('email') || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { login = { step: 'email', email, err: 'That email does not look right.' }; return showLogin(); }
    login = { step: 'email', email, busy: true }; showLogin();
    try {
      await api.sendCode(email, location.origin + location.pathname);
      login = { step: 'code', email };
    } catch (err) {
      login = { step: 'email', email, err: err?.status === 429 ? 'Too many tries. Wait a minute and try again.' : 'Could not send right now. Try again.' };
    }
    return showLogin();
  }
  if (form.dataset.form === 'code') {
    const code = String(new FormData(form).get('code') || '').replace(/\D/g, '');
    if (code.length < 6) { login = { ...login, err: 'Type the 6-digit code from the email.' }; return showLogin(); }
    login = { ...login, busy: true, err: '' }; showLogin();
    try {
      await api.verifyCode(login.email, code);
      login = { step: 'email', email: '' };
    } catch {
      login = { ...login, busy: false, err: 'That code did not work. Check it or send a new one.' };
      showLogin();
    }
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-scope]')) {
    S.scope = t.value;
    try { localStorage.setItem(`summit.scope.${S.cfg.id}`, S.scope); } catch { /* ignore */ }
    for (const k of Object.keys(S.filters)) if (k.startsWith('sel_')) delete S.filters[k];
    S.filters.all_rep = S.scope.startsWith('member:') ? S.scope.slice(7) : '';
    S.filters.all_branch = S.scope.startsWith('branch:') ? S.scope.slice(7) : '';
    return renderAll();
  }
  if (t.matches('[data-ws]')) { location.href = `/${encodeURIComponent(t.value)}`; return; }
  if (t.dataset.f) { S.filters[t.dataset.f] = t.value; return renderAll(); }
  if (t.dataset.g) {
    const v = t.dataset.gt === 'num' ? num(t.value) : t.value;
    writeGoal(t.dataset.g, v === '' ? null : v);
    return renderSoon();
  }
  if (t.dataset.cm) {
    const v = t.dataset.cf === 'note' ? t.value : num(t.value);
    writeCommit(t.dataset.cm, t.dataset.cw, t.dataset.cf, t.dataset.ck, v);
    return renderSoon();
  }
  if (t.dataset.id && t.dataset.k && !t.dataset.toggle) {
    const id = t.dataset.id, k = t.dataset.k, o = S.opps[id];
    if (!o) return;
    const today = wk().today;
    let v = t.value;
    if (t.dataset.type === 'num') v = num(v) || 0;
    if (t.type === 'date' || k === 'owner_member_id' || k === 'category' || k === 'stage') v = v || null;
    if (k === 'account' && !String(v).trim()) { toast('Account needs a name'); return renderAll(); }
    const patch = { [k]: v };
    if (k === 'owner') { delete patch.owner; patch.owner_member_id = v || null; const m = memberById(v); if (m?.team) patch.pipeline = m.team; }
    if (k === 'category') { const c = S.cfg.catBy[v]; patch.recurring = c ? c.recurring : false; }
    if (k === 'stage') {
      const s = stageOf(S.cfg, { stage: v });
      patch.stage_date = today;
      if (s.bid && !s.hold && s.status === 'open' && !o.bid_date) patch.bid_date = today;
      if (s.status === 'won' && !o.actual_close) patch.actual_close = today;
    }
    if (['next_step', 'next_step_date', 'stage', 'value'].includes(k)) patch.last_activity = today;
    writeOpp(id, patch);
    renderSoon();
  }
});

let qT;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.f === 'all_q') {
    S.filters.all_q = t.value;
    clearTimeout(qT);
    qT = setTimeout(() => { renderAll(); const i = $('[data-f="all_q"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250);
  }
});

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('[data-signout]')) { await api.signOut(); started = false; teardown(); login = { step: 'email', email: '' }; history.replaceState(null, '', location.pathname); return showLogin(); }
  if (t.closest('[data-login-back]')) { login = { step: 'email', email: login.email }; return showLogin(); }
  if (t.closest('[data-login-resend]')) {
    try { await api.sendCode(login.email, location.origin + location.pathname); toast('New code sent'); } catch { toast('Wait a minute, then try again'); }
    return;
  }
  const tab = t.closest('.tab[data-v]');
  if (tab) return setView(tab.dataset.v);
  const tog = t.closest('[data-toggle]');
  if (tog && !tog.disabled) { const o = S.opps[tog.dataset.id]; if (o) { writeOpp(o.id, { [tog.dataset.k]: !o[tog.dataset.k] }); renderAll(); } return; }
  const add = t.closest('[data-add]');
  if (add) {
    const id = await addOpp(add.dataset.add, add.dataset.team);
    setTimeout(() => { const i = document.querySelector(`tr[data-row="${id}"] input[data-k="account"]`); if (i) { i.focus(); i.select(); } }, 60);
    return;
  }
  const op = t.closest('[data-open]');
  if (op) {
    const o = S.opps[op.dataset.open];
    if (!o) return;
    Object.assign(S.filters, { all_q: o.account, all_status: '', all_cat: '', all_branch: '', all_rep: '' });
    return setView(tabFor('accounts') ? 'accounts' : S.view);
  }
  const ac = t.closest('[data-accept]');
  if (ac && isLeader()) return acceptLate(ac.dataset.accept);
  if (t.closest('[data-crm]')) {
    const txt = ($('#crmPaste')?.value || '').trim();
    if (!txt) return;
    const { map, n } = parseCrm(txt);
    S.crm = n ? map : null;
    toast(`${n} ${S.cfg.crmLabel} rows compared`);
    return renderAll();
  }
  if (t.closest('[data-crm-clear]')) { S.crm = null; return renderAll(); }
  const th = t.closest('th[data-sort]');
  if (th && S.view === 'accounts') {
    const k = th.dataset.sort;
    if (S.sort.all === k) S.sort.allDir = -(S.sort.allDir || -1);
    else { S.sort.all = k; S.sort.allDir = ['value', 'weighted', 'prob'].includes(k) ? -1 : 1; }
    return renderAll();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList?.contains('ed') && e.target.tagName === 'INPUT' && e.target.type !== 'search') e.target.blur();
});

boot();
