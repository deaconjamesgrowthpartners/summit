import { S, wk, goals, isLeader, scopeLabel, oppsScoped, repsScoped, commitFor, nameOf, memberById } from '../data/store.js';
import { esc, money, fmtDate } from '../lib/format.js';
import { lockLabel } from '../lib/time.js';
import { goalFields } from '../data/workspace.js';
import { rowIssues, flag } from '../lib/rules.js';

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
        ${gr.rows.slice(0, 25).map(({ o }) => `<div class="issue"><span class="dot ${flag(cfg, o, w.today, S.crm)}"></span><div class="what"><b>${esc(o.account)}</b> <small>${esc(nameOf(o.owner_member_id) || 'no rep')} · ${esc(o.branch)} · ${esc(o.stage)} · ${money(o.value)}</small></div><button class="btn sm sec" data-open="${esc(o.id)}">Open row</button></div>`).join('')}
        ${gr.rows.length > 25 ? `<div class="note">and ${gr.rows.length - 25} more</div>` : ''}</div>`; }).join('') : '<div class="card empty mb">Zero board. Nice.</div>'}
      ${late.length ? `<div class="card mb"><div class="sec-h"><h2 class="s15">Changed after the lock</h2><span class="pill y">${late.length}</span></div>
        ${late.map((c) => `<div class="issue"><div class="what"><span class="person">${esc(memberById(c.member_id)?.full_name || '')}</span><small>week ending ${fmtDate(c.week_key)} · edited ${esc(new Date(c.updated_at || c.submitted_at || Date.now()).toLocaleString('en-US', { timeZone: cfg.lock_tz }))}</small></div>${leader ? `<button class="btn sm sec" data-accept="${esc(c.id)}">Accept</button>` : ''}</div>`).join('')}</div>` : ''}
    </div>
    <div>
      <div class="card mb"><h2 class="s15" style="margin-bottom:8px">Commits not in · week ending ${fmtDate(w.key)}</h2>
        ${missing.length ? missing.map((r) => `<div class="kv"><span class="person">${esc(r.full_name)}</span><span class="pill n">${w.locked ? 'not in' : `due ${esc(lock)}`}</span></div>`).join('') : '<div class="kv"><span>Everyone is in.</span><span class="pill g">all in</span></div>'}</div>
      <div class="card mb"><h2 class="s15" style="margin-bottom:6px">${esc(cfg.crmLabel)} cross-check</h2>
        <p class="help">Paste the ${esc(cfg.crmLabel)} export (tab or comma separated: id, status, estimated $). Rows with a matching ${esc(cfg.crmLabel)} # get compared. Nothing is saved or sent. It stays in this browser tab.</p>
        <textarea class="paste" id="crmPaste" placeholder="Id&#9;Status&#9;Est $&#10;4471&#9;Proposed&#9;14200" aria-label="${esc(cfg.crmLabel)} export"></textarea>
        <div class="row-actions"><button class="btn sm" data-crm>Compare</button>${S.crm ? `<span class="pill g">${Object.keys(S.crm).length} rows loaded</span> <button class="lnk" data-crm-clear>clear</button>` : ''}</div>
      </div>
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
