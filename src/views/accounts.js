import { S, oppsScoped, isLeader, reps, repOf, fromCrm, branchList } from '../data/store.js';
import { esc, money } from '../lib/format.js';
import { isOpen, isWon, isLost, isUnknown, weighted, sum } from '../lib/rules.js';
import { renderGrid, canEditOpp } from './grid.js';

export function renderAccounts(el) {
  const cfg = S.cfg, f = S.filters;
  if (f.all_rep === undefined) f.all_rep = S.me && S.me.role === 'rep' ? S.me.id : '';
  const fk = (k) => f['all_' + k] || '';
  const crm = fromCrm();
  let rows = oppsScoped();
  if (fk('q')) {
    const q = fk('q').toLowerCase();
    rows = rows.filter((o) => [o.account, o.job, o.contact, o.segment, repOf(o), o.notes, o.next_step, o.crm_ref, o.status_name].join(' ').toLowerCase().includes(q));
  }
  if (fk('cat')) rows = rows.filter((o) => o.category === fk('cat'));
  if (fk('branch')) rows = rows.filter((o) => o.branch === fk('branch'));
  if (fk('rep') === '_unassigned') rows = rows.filter((o) => o.unassigned);
  else if (fk('rep')) rows = rows.filter((o) => o.owner_member_id === fk('rep'));
  if (fk('status') === 'open') rows = rows.filter((o) => isOpen(cfg, o));
  else if (fk('status') === 'won') rows = rows.filter((o) => isWon(cfg, o));
  else if (fk('status') === 'lost') rows = rows.filter((o) => isLost(cfg, o));
  else if (fk('status') === 'unknown') rows = rows.filter((o) => isUnknown(cfg, o));

  const sk = S.sort.all || 'value', sd = S.sort.allDir || -1;
  const valOf = (o) => {
    if (sk === 'value') return +o.value || 0;
    if (sk === 'weighted') return weighted(cfg, o);
    if (sk === 'prob') return cfg.stageBy[o.stage]?.prob || 0;
    if (sk === 'owner') return repOf(o);
    return o[sk];
  };
  rows.sort((a, b) => {
    const x = valOf(a), y = valOf(b);
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sd;
    const xs = String(x ?? '') || '￿', ys = String(y ?? '') || '￿';
    return xs < ys ? -sd : xs > ys ? sd : 0;
  });

  const open = rows.filter((o) => isOpen(cfg, o)), won = rows.filter((o) => isWon(cfg, o));
  const unassigned = rows.filter((o) => o.unassigned), unknown = rows.filter((o) => isUnknown(cfg, o));
  const canAdd = S.admin || (S.me && S.me.active);
  const addFor = S.me && S.me.role === 'rep' ? S.me.id : '';
  const addTeam = S.me && S.me.role === 'rep' ? S.me.team || '' : '';
  const probs = [...new Set(cfg.stages.filter((s) => s.status !== 'lost').map((s) => Math.round(s.prob * 100)))].sort((a, b) => a - b);

  el.innerHTML = `
  <div class="sec-h"><h2>All accounts · ${rows.length}</h2><span class="sub">${open.length} open · ${money(sum(open))} · ${won.length} won · ${money(sum(won))}${crm && unassigned.length ? ` · ${unassigned.length} with a rep not on the roster` : ''}${crm && unknown.length ? ` · ${unknown.length} status not mapped` : ''}</span></div>
  <div class="bar">
    <input type="search" class="ed" data-f="all_q" placeholder="Search account, contact, notes" value="${esc(fk('q'))}" aria-label="Search">
    <select class="ed" data-f="all_status"><option value="">Status: all</option>${(crm ? ['open', 'won', 'lost', 'unknown'] : ['open', 'won', 'lost']).map((s) => `<option value="${s}" ${fk('status') === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
    <select class="ed" data-f="all_cat"><option value="">Type: all</option>${[...new Set([...cfg.categories.map((c) => c.name), ...(crm ? oppsScoped().map((o) => o.category).filter(Boolean) : [])])].map((c) => `<option ${fk('cat') === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <select class="ed" data-f="all_branch"><option value="">Branch: all</option>${branchList().map((b) => `<option ${fk('branch') === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
    <select class="ed" data-f="all_rep"><option value="">Rep: all</option>${reps().map((r) => `<option value="${esc(r.id)}" ${fk('rep') === r.id ? 'selected' : ''}>${esc(r.full_name)}</option>`).join('')}${crm ? `<option value="_unassigned" ${fk('rep') === '_unassigned' ? 'selected' : ''}>Not on the roster</option>` : ''}</select>
    ${!crm && canAdd && (addFor || isLeader()) ? `<button class="btn sm" data-add="${esc(addFor)}" data-team="${esc(addTeam)}">+ Add account</button>` : ''}
  </div>
  ${renderGrid(rows, { canEdit: canEditOpp, full: true })}
  ${crm
    ? `<p class="note">From ${esc(cfg.crmLabel)}, synced nightly, read only. Click a header to sort. Status sets probability: ${cfg.stages.filter((s) => s.status === 'open').map((s) => `${esc(s.name)} ${Math.round(s.prob * 100)}%`).join(' · ')}. Won and lost are not pipeline.</p>`
    : `<p class="note">Click a header to sort. Every edit saves and updates the Summit instantly. Stage sets probability: ${probs.join(' / ')}.</p>`}`;
}
