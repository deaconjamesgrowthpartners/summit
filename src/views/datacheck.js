import { S, wk, goals, isLeader, scopeLabel, oppsScoped, oppsAll, repsScoped, commitFor, memberById, repOf, fromCrm } from '../data/store.js';
import { esc, money, fmtDate } from '../lib/format.js';
import { lockLabel } from '../lib/time.js';
import { goalFields } from '../data/workspace.js';
import { rowIssues, flag, isUnknown, isOpen } from '../lib/rules.js';

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
        ${gr.rows.slice(0, 25).map(({ o }) => `<div class="issue"><span class="dot ${flag(cfg, o, w.today, S.crm)}"></span><div class="what"><b>${esc(o.account)}</b> <small>${esc(repOf(o) || 'no rep')} · ${esc(o.branch)} · ${esc(o.stage || o.status_name || 'no status')} · ${money(o.value)}${o.src === 'aspire' ? ` · ${esc(S.cfg.crmLabel)} #${esc(o.crm_ref)}` : ''}</small></div><button class="btn sm sec" data-open="${esc(o.id)}">Open row</button></div>`).join('')}
        ${gr.rows.length > 25 ? `<div class="note">and ${gr.rows.length - 25} more</div>` : ''}</div>`; }).join('') : '<div class="card empty mb">Zero board. Nice.</div>'}
      ${late.length ? `<div class="card mb"><div class="sec-h"><h2 class="s15">Changed after the lock</h2><span class="pill y">${late.length}</span></div>
        ${late.map((c) => `<div class="issue"><div class="what"><span class="person">${esc(memberById(c.member_id)?.full_name || '')}</span><small>week ending ${fmtDate(c.week_key)} · edited ${esc(new Date(c.updated_at || c.submitted_at || Date.now()).toLocaleString('en-US', { timeZone: cfg.lock_tz }))}</small></div>${leader ? `<button class="btn sm sec" data-accept="${esc(c.id)}">Accept</button>` : ''}</div>`).join('')}</div>` : ''}
    </div>
    <div>
      <div class="card mb"><h2 class="s15" style="margin-bottom:8px">Commits not in · week ending ${fmtDate(w.key)}</h2>
        ${missing.length ? missing.map((r) => `<div class="kv"><span class="person">${esc(r.full_name)}</span><span class="pill n">${w.locked ? 'not in' : `due ${esc(lock)}`}</span></div>`).join('') : '<div class="kv"><span>Everyone is in.</span><span class="pill g">all in</span></div>'}</div>
      ${syncCard(cfg)}
      ${fromCrm() ? '' : `<div class="card mb"><h2 class="s15" style="margin-bottom:6px">${esc(cfg.crmLabel)} cross-check</h2>
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
    </div>
  </div>`;
}

// The Aspire sync: the last run, the ones before it, and the Aspire names nobody on the roster matches.
// Color goes on the status and the counts, never on a name.
const RUN_PILL = { ok: ['g', 'synced'], partial: ['y', 'partial'], error: ['r', 'failed'], running: ['n', 'running'] };
function syncCard(cfg) {
  const sy = S.sync;
  if (cfg.crmSource !== 'aspire' && !sy?.runs?.length) return '';
  const when = (t) => (t ? new Date(t).toLocaleString('en-US', { timeZone: cfg.lock_tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const pill = (st) => { const [c, l] = RUN_PILL[st] || ['n', st]; return `<span class="pill ${c}">${esc(l)}</span>`; };
  const changed = (r) => (r.rows_inserted || 0) + (r.rows_updated || 0);
  const runs = sy?.runs || [];
  const last = runs[0];
  const um = sy?.unmatched || [];
  const btn = S.admin ? `<div class="row-actions"><button class="btn sm" data-sync ${S.syncing ? 'disabled' : ''}>${S.syncing ? 'Syncing...' : 'Run sync now'}</button><button class="lnk" data-sync="full" ${S.syncing ? 'disabled' : ''}>full re-pull</button></div>` : '';
  return `<div class="card mb"><div class="sec-h"><h2 class="s15">${esc(cfg.crmLabel)} sync</h2>${last ? pill(last.status) : '<span class="pill n">not run yet</span>'}</div>
    ${last ? `<p class="help">Last run ${esc(when(last.started_at))} · ${esc(last.mode)} · ${esc(last.trigger)}. ${last.rows_pulled} pulled, ${changed(last)} changed${last.rows_removed ? `, ${last.rows_removed} gone from ${esc(cfg.crmLabel)}` : ''}.</p>` : `<p class="help">Runs nightly. Nothing has synced yet.</p>`}
    ${last?.errors?.length ? last.errors.map((e) => `<div class="issue"><span class="dot r"></span><div class="what"><small>${esc(e)}</small></div></div>`).join('') : ''}
    ${last?.notes?.filter((n) => !/^(full pull|incremental:)/.test(n)).map((n) => `<p class="note">${esc(n)}</p>`).join('') || ''}
    ${um.length ? `<h3 style="font-size:13px;margin:12px 0 4px">Not on the roster <span class="pill y">${um.length}</span></h3>
      <p class="help">These ${esc(cfg.crmLabel)} reps match nobody in Summit. Their deals still show, as unassigned. Add them to the roster, or put their ${esc(cfg.crmLabel)} spelling in crm_name.</p>
      ${um.map((u) => `<div class="kv"><span>${esc(u.sales_rep_name)}</span><span><span class="pill y">${u.open_deals} open</span> <small>${money(u.open_estimated)} · ${u.deals} deals</small></span></div>`).join('')}` : last ? '<div class="kv"><span>Every rep matches the roster.</span><span class="pill g">all matched</span></div>' : ''}
    ${mapCheck(cfg)}
    ${runs.length > 1 ? `<h3 style="font-size:13px;margin:12px 0 4px">Earlier runs</h3>${runs.slice(1).map((r) => `<div class="kv"><span><small>${esc(when(r.started_at))} · ${esc(r.mode)}</small></span><span><small>${r.rows_pulled} pulled · ${changed(r)} changed</small> ${pill(r.status)}</span></div>`).join('')}` : ''}
    ${btn}
  </div>`;
}

// every deal on the board is counted somewhere. Statuses the config does not map and divisions with no
// Summit category are listed here with counts, so nothing drops out of the numbers unseen.
function mapCheck(cfg) {
  if (!fromCrm()) return '';
  const all = oppsAll();
  const tally = (rows, key) => Object.entries(rows.reduce((t, o) => ((t[key(o)] = (t[key(o)] || 0) + 1), t), {})).sort((a, b) => b[1] - a[1]);
  const unknown = tally(all.filter((o) => isUnknown(cfg, o)), (o) => o.status_name || 'blank');
  const unmapped = tally(all.filter((o) => o.category && !o.category_mapped), (o) => o.category);
  const noDivision = all.filter((o) => !o.category).length;
  const counted = all.length - unknown.reduce((a, [, n]) => a + n, 0);
  return `<h3 style="font-size:13px;margin:12px 0 4px">Every deal accounted for</h3>
    <div class="kv"><span>Deals from ${esc(cfg.crmLabel)}</span><b>${all.length}</b></div>
    <div class="kv"><span>Counted as open, won or lost</span><b>${counted}</b></div>
    ${unknown.length ? `<div class="kv"><span>Status not mapped: ${unknown.map(([k, n]) => `${esc(k)} ${n}`).join(', ')}</span><span class="pill y">${unknown.reduce((a, [, n]) => a + n, 0)}</span></div>
      <p class="help">Not counted as open, won or lost until the status is added to the workspace's pipeline config.</p>` : ''}
    ${unmapped.length ? `<div class="kv"><span>Type with no Summit category: ${unmapped.map(([k, n]) => `${esc(k)} ${n}`).join(', ')}</span><span class="pill y">${unmapped.reduce((a, [, n]) => a + n, 0)}</span></div>
      <p class="help">Counted everywhere, but never as recurring. Map the division in the pipeline config to count it toward recurring goals and coverage.</p>` : ''}
    ${noDivision ? `<div class="kv"><span>No division in ${esc(cfg.crmLabel)}</span><span class="pill y">${noDivision}</span></div>` : ''}
    ${all.some((o) => o.unassigned && isOpen(cfg, o)) ? `<div class="kv"><span>Open deals with a rep not on the roster</span><span class="pill y">${all.filter((o) => o.unassigned && isOpen(cfg, o)).length}</span></div>` : ''}`;
}
