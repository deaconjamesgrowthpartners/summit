import { S, wk, isLeader, reps, scope, oppsScoped, repsScoped, commitFor } from '../data/store.js';
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
  if (isLeader()) {
    const sc = scope();
    const opts = [['company', 'All'], ...cfg.branches.map((b) => [`branch:${b}`, `${b} branch`]), ...reps().map((r) => [`member:${r.id}`, r.full_name])];
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
