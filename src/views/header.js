import { S, wk, canSeeAll, reps, scope, oppsScoped, repsScoped, commitFor, branchList } from '../data/store.js';
import { esc, fmtDate } from '../lib/format.js';
import { lockLabel } from '../lib/time.js';
import { rowIssues } from '../lib/rules.js';
import { safeLogo } from '../lib/theme.js';

export function issueCount() {
  const w = wk();
  const rows = oppsScoped().reduce((a, o) => a + rowIssues(S.cfg, o, w.today, S.crm).length, 0);
  const ids = new Set(repsScoped().map((r) => r.id));
  const late = Object.values(S.commits).filter((c) => c.late && !c.accepted_by && ids.has(c.member_id)).length;
  return rows + late;
}

export function renderHeader(el, workspaces = []) {
  const cfg = S.cfg, w = wk();
  const logo = safeLogo(cfg.brand.logo);
  const lock = lockLabel(cfg);
  const lockTxt = w.locked
    ? `Commits locked · ${lock}`
    : `Commits lock ${lock} · ${w.daysLeft === 0 ? 'today' : w.daysLeft + ' day' + (w.daysLeft > 1 ? 's' : '')}`;
  const who = S.me ? S.me.full_name : S.user?.email || '';
  const n = issueCount();
  let scopeSel = '';
  if (canSeeAll()) {
    const sc = scope();
    const opts = [['company', 'All'], ...branchList().map((b) => [`branch:${b}`, `${b} branch`]), ...reps().map((r) => [`member:${r.id}`, r.full_name])];
    scopeSel = `<label>Viewing <select data-scope>${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === sc ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  }
  const wsSel = S.admin && workspaces.length > 1
    ? `<select data-ws aria-label="Workspace">${workspaces.map((x) => `<option value="${esc(x.slug)}" ${x.slug === cfg.slug ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`
    : '';
  el.innerHTML = `<div class="wrap">
    <div class="row1">
      <div class="brand"><div class="mark">${logo ? `<img src="${esc(logo)}" alt="">` : esc((cfg.name || 'S').charAt(0).toUpperCase())}</div>
        <div class="t"><b>Summit</b><span>${esc(cfg.name)} · weekly scoreboard</span></div></div>
      <div class="who">
        <span class="wk">Week of ${fmtDate(w.start)} to ${fmtDate(w.key)}</span>
        <span class="lock ${w.locked ? 'locked' : ''}">${esc(lockTxt)}</span>
        <span class="lock src" title="Where the deals on this board come from">${esc(sourceBadge(cfg))}</span>
        ${S.live === 'down' ? '<span class="lock">Reconnecting</span>' : ''}
        ${wsSel}
        <span class="me">${esc(who)}${S.admin && !S.me ? ' · admin' : ''}</span>
        ${scopeSel}
        <button class="out" data-signout>Sign out</button>
      </div>
    </div>
    <nav class="tabs" aria-label="Screens">
      ${cfg.tabs.map((t) => `<button class="tab ${t.key === S.view ? 'on' : ''}" data-v="${esc(t.key)}">${esc(t.label)}${t.key === 'datacheck' && n ? `<span class="n">${n}</span>` : ''}</button>`).join('')}
    </nav>
  </div>`;
}

// one line in the header: where every deal on the board comes from, so nobody has to wonder
export function sourceBadge(cfg) {
  const s = cfg.source;
  if (s.mode === 'native') return 'Deals typed in Summit';
  const last = (S.sync?.runs || []).find((r) => r.status === 'ok' || r.status === 'partial');
  const when = last ? new Date(last.finished_at || last.started_at).toLocaleString('en-US', { timeZone: cfg.lock_tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  if (s.mode === 'csv') return `Deals from ${s.label}${when ? ` · uploaded ${when}` : ' · nothing uploaded yet'}`;
  return `Deals from ${cfg.crmLabel}${when ? ` · synced ${when}` : ''}`;
}
