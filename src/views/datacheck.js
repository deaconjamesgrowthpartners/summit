import { S, wk, goals, isLeader, scopeLabel, oppsScoped, oppsAll, repsScoped, commitFor, memberById, repOf, fromCrm, branchList, tabFor, byBranch } from '../data/store.js';
import { monthLabel, monthEnd } from '../lib/period.js';
import { addDays } from '../lib/format.js';
import { esc, money, fmtDate } from '../lib/format.js';
import { lockLabel } from '../lib/time.js';
import { goalFields } from '../data/workspace.js';
import { rowIssues, flag, isUnknown, isOpen } from '../lib/rules.js';
import { uploadCard } from './upload.js';

export function renderCheck(el) {
  const cfg = S.cfg, w = wk(), g = goals(), leader = isLeader();
  const list = [];
  oppsScoped().forEach((o) => rowIssues(cfg, o, w.today, S.crm).forEach((i) => list.push({ o, i })));
  const RS = repsScoped();
  const ids = new Set(RS.map((r) => r.id));
  const late = Object.values(S.commits).filter((c) => c.late && !c.accepted_by && ids.has(c.member_id))
    .sort((a, b) => (a.week_key < b.week_key ? 1 : -1));
  const groups = {};
  list.forEach((x) => (groups[x.i.t] = groups[x.i.t] || { sev: x.i.sev, rows: [] }).rows.push(x));
  const order = Object.keys(groups).sort((a, b) => groups[b].rows.length - groups[a].rows.length);
  const missing = RS.filter((r) => !commitFor(r.id, w.key));
  const fields = goalFields(cfg);
  const lock = lockLabel(cfg);

  el.innerHTML = `
  <div class="sec-h"><h2>Data check · ${esc(scopeLabel())} · ${list.length + late.length} open</h2><span class="sub">The goal is zero. Fix a row and it disappears.</span></div>
  <div class="split">
    <div>
      ${order.length ? order.map((t) => { const gr = groups[t]; return `<div class="card mb"><div class="sec-h"><h2 class="s15">${esc(t)}</h2><span class="pill ${gr.sev}">${gr.rows.length}</span></div>
        ${gr.rows.slice(0, 25).map(({ o }) => `<div class="issue"><span class="dot ${flag(cfg, o, w.today, S.crm)}"></span><div class="what"><b>${esc(o.account)}</b> <small>${esc(repOf(o) || 'no rep')}${o.branch ? ` · ${esc(o.branch)}` : ''} · ${esc(o.stage || o.status_name || 'no status')} · ${money(o.value)}${o.readOnly ? ` · ${esc(S.cfg.crmLabel)} #${esc(o.crm_ref)}` : ''}</small></div><button class="btn sm sec" data-open="${esc(o.id)}">Open row</button></div>`).join('')}
        ${gr.rows.length > 25 ? `<div class="note">and ${gr.rows.length - 25} more</div>` : ''}</div>`; }).join('') : '<div class="card empty mb">Zero board. Nice.</div>'}
      ${late.length ? `<div class="card mb"><div class="sec-h"><h2 class="s15">Changed after the lock</h2><span class="pill y">${late.length}</span></div>
        ${late.map((c) => `<div class="issue"><div class="what"><span class="person">${esc(memberById(c.member_id)?.full_name || '')}</span><small>week ending ${fmtDate(c.week_key)} · edited ${esc(new Date(c.updated_at || c.submitted_at || Date.now()).toLocaleString('en-US', { timeZone: cfg.lock_tz }))}</small></div>${leader ? `<button class="btn sm sec" data-accept="${esc(c.id)}">Accept</button>` : ''}</div>`).join('')}</div>` : ''}
    </div>
    <div>
      <div class="card mb"><h2 class="s15" style="margin-bottom:8px">Commits not in · week ending ${fmtDate(w.key)}</h2>
        ${missing.length ? missing.map((r) => `<div class="kv"><span class="person">${esc(r.full_name)}</span><span class="pill n">${w.locked ? 'not in' : `due ${esc(lock)}`}</span></div>`).join('') : '<div class="kv"><span>Everyone is in.</span><span class="pill g">all in</span></div>'}</div>
      ${uploadCard(cfg)}
      ${syncCard(cfg)}
      ${changesCard(cfg)}
      ${!cfg.crossCheck ? '' : `<div class="card mb"><h2 class="s15" style="margin-bottom:6px">${esc(cfg.crmLabel)} cross-check</h2>
        <p class="help">Paste the ${esc(cfg.crmLabel)} export (tab or comma separated: id, status, estimated $). Rows with a matching ${esc(cfg.crmLabel)} # get compared. Nothing is saved or sent. It stays in this browser tab.</p>
        <textarea class="paste" id="crmPaste" placeholder="Id&#9;Status&#9;Est $&#10;4471&#9;Proposed&#9;14200" aria-label="${esc(cfg.crmLabel)} export"></textarea>
        <div class="row-actions"><button class="btn sm" data-crm>Compare</button>${S.crm ? `<span class="pill g">${Object.keys(S.crm).length} rows loaded</span> <button class="lnk" data-crm-clear>clear</button>` : ''}</div>
      </div>`}
      ${leader && fields.length ? `<div class="card"><h2 class="s15" style="margin-bottom:6px">Goals (leadership)</h2>
        ${fields.map((x) => `<div class="kv"><span>${esc(x.label)}</span>${x.type === 'date'
          ? `<input class="ed date" type="date" data-g="${esc(x.key)}" data-gt="date" value="${esc(g[x.key] || '')}">`
          : x.type === 'text'
          ? `<input class="ed txt" style="width:170px" data-g="${esc(x.key)}" data-gt="text" value="${esc(g[x.key] || '')}">`
          : `<input class="ed num" inputmode="decimal" data-g="${esc(x.key)}" data-gt="num" value="${esc(g[x.key] ?? '')}">`}</div>`).join('')}
        <p class="note">Period ${esc(S.goalsRow?.period || String(w.year))}.</p>
      </div>` : ''}
      ${leader && tabFor('summit') ? targetsCard(cfg, w) : ''}
    </div>
  </div>`;
}

// The sync or the uploads: the last run, the ones before it, and the source's rep names nobody on the roster
// matches. Color goes on the status and the counts, never on a name.
const RUN_PILL = { ok: ['g', 'synced'], partial: ['y', 'partial'], error: ['r', 'failed'], running: ['n', 'running'] };
function syncCard(cfg) {
  const sy = S.sync;
  if (cfg.source.mode === 'native') return '';
  const csv = cfg.source.mode === 'csv';
  const when = (t) => (t ? new Date(t).toLocaleString('en-US', { timeZone: cfg.lock_tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const pill = (st) => { const [c, l] = RUN_PILL[st] || ['n', st]; return `<span class="pill ${c}">${esc(l)}</span>`; };
  const changed = (r) => (r.rows_inserted || 0) + (r.rows_updated || 0);
  const runs = sy?.runs || [];
  const last = runs[0];
  const um = sy?.unmatched || [];
  const btn = S.admin && !csv ? `<div class="row-actions"><button class="btn sm" data-sync ${S.syncing ? 'disabled' : ''}>${S.syncing ? 'Syncing...' : 'Run sync now'}</button><button class="lnk" data-sync="full" ${S.syncing ? 'disabled' : ''}>full re-pull</button></div>` : '';
  const who = (r) => (r.run_by ? S.members.find((m) => m.user_id === r.run_by)?.full_name || '' : '');
  return `<div class="card mb"><div class="sec-h"><h2 class="s15">${esc(csv ? `${cfg.source.label} uploads` : `${cfg.crmLabel} sync`)}</h2>${last ? pill(last.status) : `<span class="pill n">${csv ? 'nothing uploaded yet' : 'not run yet'}</span>`}</div>
    ${last ? (csv
      ? `<p class="help">Last upload ${esc(when(last.started_at))}${last.file_name ? ` · ${esc(last.file_name)}` : ''}${who(last) ? ` · ${esc(who(last))}` : ''}. ${last.rows_pulled} rows, ${last.rows_inserted || 0} added, ${last.rows_updated || 0} changed${last.rows_removed ? `, ${last.rows_removed} removed by a leader` : ''}.</p>`
      : `<p class="help">Last run ${esc(when(last.started_at))} · ${esc(last.mode)} · ${esc(last.trigger)}. ${last.rows_pulled} pulled, ${changed(last)} changed${last.rows_removed ? `, ${last.rows_removed} gone from ${esc(cfg.crmLabel)}` : ''}.</p>`)
      : `<p class="help">${csv ? 'A leader uploads a file on Data Check. Deals are read only between uploads.' : 'Runs nightly. Nothing has synced yet.'}</p>`}
    ${last?.errors?.length ? last.errors.map((e) => `<div class="issue"><span class="dot r"></span><div class="what"><small>${esc(e)}</small></div></div>`).join('') : ''}
    ${last?.notes?.filter((n) => !/^(full pull|incremental:|upload:)/.test(n)).map((n) => `<p class="note">${esc(n)}</p>`).join('') || ''}
    ${um.length ? `<h3 style="font-size:13px;margin:12px 0 4px">Not on the roster <span class="pill y">${um.length}</span></h3>
      <p class="help">These ${esc(cfg.crmLabel)} reps match nobody in Summit. Their deals still show, as unassigned. Add them to the roster, or put their ${esc(cfg.crmLabel)} spelling in crm_name.</p>
      ${um.map((u) => `<div class="kv"><span>${esc(u.sales_rep_name)}</span><span><span class="pill y">${u.open_deals} open</span> <small>${money(u.open_estimated)} · ${u.deals} deals</small></span></div>`).join('')}` : last ? '<div class="kv"><span>Every rep matches the roster.</span><span class="pill g">all matched</span></div>' : ''}
    ${mapCheck(cfg)}
    ${runs.length > 1 ? `<h3 style="font-size:13px;margin:12px 0 4px">Earlier ${csv ? 'uploads' : 'runs'}</h3>${runs.slice(1).map((r) => `<div class="kv"><span><small>${esc(when(r.started_at))} · ${esc(csv ? r.file_name || 'file' : r.mode)}</small></span><span><small>${r.rows_pulled} pulled · ${changed(r)} changed</small> ${pill(r.status)}</span></div>`).join('')}` : ''}
    ${btn}
  </div>`;
}

// every deal on the board is counted somewhere. Excluded test data, statuses the config does not map and
// divisions no rule matches are listed with counts, so nothing drops out of the numbers unseen.
function mapCheck(cfg) {
  if (!fromCrm()) return '';
  const all = oppsAll(), ex = S.excluded || [];
  const tally = (rows, key) => Object.entries(rows.reduce((t, o) => ((t[key(o)] = (t[key(o)] || 0) + 1), t), {})).sort((a, b) => b[1] - a[1]);
  const total = (t) => t.reduce((a, [, n]) => a + n, 0);
  const unknown = tally(all.filter((o) => isUnknown(cfg, o)), (o) => o.status_name || 'blank');
  const oneTime = tally(all.filter((o) => o.category && !o.category_mapped), (o) => o.category);
  const noDivision = all.filter((o) => !o.category).length;
  const exNames = tally(ex, (o) => o.account);
  return `<h3 style="font-size:13px;margin:12px 0 4px">Every deal accounted for</h3>
    <div class="kv"><span>Deals from ${esc(cfg.crmLabel)}</span><b>${all.length + ex.length}</b></div>
    ${ex.length ? `<div class="kv"><span>Left off as test data: ${exNames.slice(0, 8).map(([k, n]) => `${esc(k)}${n > 1 ? ` (${n})` : ''}`).join(', ')}${exNames.length > 8 ? `, and ${exNames.length - 8} more` : ''}</span><span class="pill n">${ex.length}</span></div>
      <p class="help">Matched by the exclude list in the workspace's pipeline config. Not in any number on any screen.</p>` : ''}
    <div class="kv"><span>On the board</span><b>${all.length}</b></div>
    <div class="kv"><span>Counted as open, won or lost</span><b>${all.length - total(unknown)}</b></div>
    ${unknown.length ? `<div class="kv"><span>Status not mapped: ${unknown.map(([k, n]) => `${esc(k)} ${n}`).join(', ')}</span><span class="pill y">${total(unknown)}</span></div>
      <p class="help">Not counted as open, won or lost until the status is added to the workspace's pipeline config.</p>` : ''}
    ${oneTime.length ? `<div class="kv"><span>One-time, no category rule: ${oneTime.map(([k, n]) => `${esc(k)} ${n}`).join(', ')}</span><span class="pill n">${total(oneTime)}</span></div>` : ''}
    ${noDivision ? `<div class="kv"><span>No division in ${esc(cfg.crmLabel)}</span><span class="pill y">${noDivision}</span></div>` : ''}
    ${all.some((o) => o.unassigned && isOpen(cfg, o)) ? `<div class="kv"><span>Open deals with a rep not on the roster</span><span class="pill y">${all.filter((o) => o.unassigned && isOpen(cfg, o)).length}</span></div>` : ''}`;
}

// Summit tile targets, leadership only. One month and one tile at a time: the company and each
// branch, for All, Maintenance and Install. The table can hold Enhancement / Net New too; this
// editor leaves them out on purpose. Blank means no target, and the tile says "no target set".
const T_METRICS = [['closed', 'Closed contracts'], ['created', 'Pipeline created'], ['forecast', 'Forecast']];
function targetsCard(cfg, w) {
  const T_DIVS = cfg.filters.includes('division') ? [['all', 'All'], ['maintenance', cfg.words.maintenance], ['install', cfg.words.install]] : [['all', 'Target']];
  const months = [];
  for (let m = `${w.year}-01-01`, i = 0; i < 15; i++, m = addDays(monthEnd(m), 1)) months.push(m);
  const cur = `${w.today.slice(0, 7)}-01`;
  const month = months.includes(S.filters.tgt_month) ? S.filters.tgt_month : cur;
  const metric = T_METRICS.some(([k]) => k === S.filters.tgt_metric) ? S.filters.tgt_metric : 'closed';
  const val = (branch, division) => {
    const t = (S.targets || []).find((x) => x.branch === branch && x.month === month && x.metric === metric && x.division === division && x.kind === 'all');
    return t ? Math.round(+t.amount) : '';
  };
  const rows = [['', 'Company'], ...(byBranch() ? branchList().map((b) => [b, b]) : [])];
  return `<div class="card mb tgt"><h2 class="s15" style="margin-bottom:6px">Summit targets (leadership)</h2>
    <div class="bar"><select class="ed" data-f="tgt_month" aria-label="Month">${months.map((m) => `<option value="${m}" ${m === month ? 'selected' : ''}>${esc(monthLabel(m))}</option>`).join('')}</select>
      <select class="ed" data-f="tgt_metric" aria-label="Tile">${T_METRICS.map(([k, l]) => `<option value="${k}" ${k === metric ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <div class="tw flat"><table><thead><tr><th></th>${T_DIVS.map(([, l]) => `<th class="num">${esc(l)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(([b, l]) => `<tr><td>${esc(l)}</td>${T_DIVS.map(([d, dl]) => `<td class="num"><input class="ed num" inputmode="decimal" placeholder="$" data-tgt="${esc(b)}|${month}|${metric}|${d}" value="${val(b, d)}" aria-label="${esc(`${l} ${dl} ${monthLabel(month)}`)}"></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    <p class="note">Monthly. Quarter and Year add up the months, and Week takes its share of the month by days. A company number wins over the branches for that month; leave it blank and the tile adds up the branches.</p>
  </div>`;
}

// typed deals: the latest changes, who made them and when. Every change is logged; this is the tail of it.
const FIELD_WORDS = { stage: 'stage', value_estimated: 'value', value_won: 'won $', owner_member_id: 'rep', account: 'account', account_id: 'account',
  close_date: 'expected close', start_date: 'start', won_date: 'won date', lost_date: 'lost date', next_step: 'next step', next_step_date: 'next step due',
  notes: 'notes', priority: 'priority', installed: 'installed', category: 'type', bid_date: 'bid date', last_activity: 'last touch', contact: 'contact' };
function changesCard(cfg) {
  if (cfg.source.mode !== 'native' || S.dealShape !== 'board') return '';
  // a new deal logs every field it was made with. One line for it here.
  const rows = (S.changes || []).filter((c) => (c.action !== 'created' || c.field === 'account') && !['account_id', 'last_activity', 'stage_date'].includes(c.field)).slice(0, 15);
  const deal = (c) => S.opps[c.deal_id]?.account || (c.action === 'deleted' ? c.old_value : '') || 'a deal';
  const val = (c, v) => (c.field === 'owner_member_id' ? memberById(v)?.full_name || '' : v ?? '');
  const when = (t) => new Date(t).toLocaleString('en-US', { timeZone: cfg.lock_tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<div class="card mb"><div class="sec-h"><h2 class="s15">Latest changes</h2><span class="pill n">every change is logged</span></div>
    ${rows.length ? rows.map((c) => `<div class="kv"><span><b>${esc(deal(c))}</b> <small>${c.action === 'created' ? 'added' : c.action === 'deleted' ? 'deleted' : `${esc(FIELD_WORDS[c.field] || c.field)}: ${esc(val(c, c.old_value) || 'blank')} → ${esc(val(c, c.new_value) || 'blank')}`}</small></span><small class="m">${esc(memberById(c.member_id)?.full_name || '')} · ${esc(when(c.changed_at))}</small></div>`).join('')
      : '<p class="help">Nothing changed yet. Add a deal on a team tab or All Accounts.</p>'}
  </div>`;
}
