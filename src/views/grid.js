// The shared inline-edit grid. Every edit saves and updates every screen.
import { S, wk, memberById } from '../data/store.js';
import { esc, money, validDate } from '../lib/format.js';
import { isWon, prob, weighted, rowIssues, flag } from '../lib/rules.js';

export function renderGrid(rows, { canEdit = () => false, full = false } = {}) {
  if (!rows.length) return '<div class="card empty">Nothing here yet.</div>';
  const cfg = S.cfg, w = wk();
  const cols = full
    ? ['flag', 'pri', 'account', 'contact', 'branch', 'owner', 'category', 'segment', 'value', 'stage', 'prob', 'weighted', 'close_date', 'start_date', 'bid_date', 'next_step', 'next_step_date', 'last_activity', 'crm_ref', 'notes']
    : ['flag', 'pri', 'account', 'category', 'value', 'stage', 'close_date', 'start_date', 'next_step', 'next_step_date', 'last_activity', 'crm_ref'];
  const head = {
    flag: '', pri: '', account: 'Account', contact: 'Contact', segment: 'Segment', branch: 'Branch', owner: 'Rep', category: 'Type', value: 'Est $', stage: 'Stage',
    prob: 'Prob', weighted: 'Weighted', close_date: 'Exp. close', start_date: 'Target start', bid_date: 'Bid sent',
    next_step: 'Next step', next_step_date: 'Due', last_activity: 'Last touch', crm_ref: `${cfg.crmLabel} #`, notes: 'Notes',
  };
  const numCols = ['value', 'prob', 'weighted'];
  const people = S.members.filter((m) => m.active);
  const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  const withCur = (list, cur) => (cur && !list.includes(cur) ? [cur, ...list] : list);

  const cell = (o, c, ro, iss) => {
    const miss = iss.some((i) => i.f === c) ? 'miss' : '';
    const at = `${ro} data-id="${esc(o.id)}" data-k="${c}"`;
    switch (c) {
      case 'flag': return `<td><span class="dot ${flag(cfg, o, w.today, S.crm)}" title="${esc(iss.map((i) => i.t).join(' · '))}"></span></td>`;
      case 'pri': return isWon(cfg, o)
        ? `<td><button class="ed tog ${o.installed ? 'done' : ''} ${iss.some((i) => i.f === 'installed') ? 'miss' : ''}" ${ro} data-id="${esc(o.id)}" data-k="installed" data-toggle="1" title="Mark installed / started">${o.installed ? '✓ installed' : 'installed?'}</button></td>`
        : `<td><button class="ed tog" ${ro} data-id="${esc(o.id)}" data-k="priority" data-toggle="1" title="Priority account" aria-pressed="${!!o.priority}">${o.priority ? '★' : '☆'}</button></td>`;
      case 'account': return `<td class="acct"><input class="ed acctname" ${at} value="${esc(o.account)}" aria-label="Account">${full ? '' : `<small>${esc([o.branch, o.segment, o.contact].filter(Boolean).join(' · '))}</small>`}</td>`;
      case 'contact': return `<td><input class="ed txt" style="width:160px" ${at} value="${esc(o.contact || '')}" placeholder="name, phone"></td>`;
      case 'segment': return `<td><input class="ed txt" style="width:150px" ${at} value="${esc(o.segment || '')}"></td>`;
      case 'branch': return `<td><select class="ed" ${at}>${withCur(cfg.branches, o.branch).map((b) => opt(b, o.branch)).join('')}</select></td>`;
      case 'owner': return `<td><select class="ed" ${at}><option value=""></option>${people.map((m) => opt(m.id, o.owner_member_id, m.full_name)).join('')}</select></td>`;
      case 'category': return `<td><select class="ed" ${at}>${o.category ? '' : '<option value=""></option>'}${withCur(cfg.categories.map((x) => x.name), o.category).map((x) => opt(x, o.category)).join('')}</select></td>`;
      case 'value': return `<td class="num"><input class="ed num ${miss}" ${at} data-type="num" inputmode="decimal" value="${+o.value ? Math.round(+o.value) : ''}" placeholder="$"></td>`;
      case 'stage': return `<td><select class="ed ${miss}" ${at}>${o.stage ? '' : '<option value=""></option>'}${withCur(cfg.stages.map((s) => s.name), o.stage).map((s) => opt(s, o.stage)).join('')}</select></td>`;
      case 'prob': return `<td class="num">${Math.round(prob(cfg, o) * 100)}%</td>`;
      case 'weighted': return `<td class="num">${money(weighted(cfg, o))}</td>`;
      case 'close_date': case 'start_date': case 'bid_date': case 'next_step_date': case 'last_activity':
        return `<td><input class="ed date ${miss}" type="date" ${at} value="${validDate(o[c]) ? o[c] : ''}"></td>`;
      case 'next_step': return `<td><input class="ed txt ${miss}" ${at} value="${esc(o.next_step || '')}" placeholder="next step"></td>`;
      case 'crm_ref': return `<td><input class="ed short" ${at} value="${esc(o.crm_ref || '')}" placeholder="#"></td>`;
      case 'notes': return `<td><input class="ed txt" ${at} value="${esc(o.notes || '')}"></td>`;
    }
    return '<td></td>';
  };

  return `<div class="tw"><table><thead><tr>${cols.map((c) => `<th class="${numCols.includes(c) ? 'num' : ''}" ${full && c !== 'flag' && c !== 'pri' ? `data-sort="${c}"` : ''}>${esc(head[c])}</th>`).join('')}</tr></thead><tbody>
  ${rows.map((o) => { const ro = canEdit(o) ? '' : 'disabled'; const iss = rowIssues(cfg, o, w.today, S.crm); return `<tr data-row="${esc(o.id)}">${cols.map((c) => cell(o, c, ro, iss)).join('')}</tr>`; }).join('')}
  </tbody></table></div>`;
}

// who may edit a row: leaders anything, reps their own. RLS enforces the same.
export function canEditOpp(o) {
  if (S.admin) return true;
  if (!S.me || !S.me.active) return false;
  if (S.me.role === 'leader') return true;
  return o.owner_member_id === S.me.id;
}
export { memberById };
