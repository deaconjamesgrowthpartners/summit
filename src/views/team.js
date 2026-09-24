// Grow and Net New. Same screen, one team each, words from the tab config.
import { S, wk, goals, isLeader, repsScoped, commitFor, oppsAll } from '../data/store.js';
import { esc, money } from '../lib/format.js';
import { mLabel } from '../data/workspace.js';
import { lockLabel, isLockedWeek } from '../lib/time.js';
import { isOpen, isWon, stageOf, ryg, autoDid, didValue, comValue, hasVal, flag } from '../lib/rules.js';
import { renderGrid, canEditOpp } from './grid.js';

export function renderTeam(el, tab) {
  const cfg = S.cfg, w = wk(), team = tab.team, opps = oppsAll();
  const rr = repsScoped().filter((r) => r.team === team);
  const fkey = `sel_${team}`;
  const mine = S.me && S.me.team === team && rr.some((r) => r.id === S.me.id) ? S.me.id : null;
  const r = rr.find((x) => x.id === S.filters[fkey]) || rr.find((x) => x.id === mine) || rr[0];
  if (!r) {
    el.innerHTML = `<div class="card empty">No ${esc(tab.team_label || tab.label)} in this view.${isLeader() ? ' Change Viewing up top.' : ''}</div>`;
    return;
  }
  const lab = (m) => mLabel(m, team);
  const fmtM = (m, v) => (m.money ? money(v) : v);
  const scoreC = commitFor(r.id, w.scoreKey), scoreA = autoDid(cfg, opps, r.id, w.scoreKey), thisC = commitFor(r.id, w.key);
  const canEdit = S.admin || (S.me && S.me.active && (S.me.id === r.id || S.me.role === 'leader'));
  const blocked = (week) => cfg.late_policy === 'block' && !isLeader() && isLockedWeek(cfg, week);
  const dis = (week) => (canEdit && !blocked(week) ? '' : 'disabled');

  // accounts list
  const f = S.filters, fk = (k) => f[`${team}_${k}`] || '';
  let rows = opps.filter((o) => o.owner_member_id === r.id);
  if (!fk('all')) rows = rows.filter((o) => o.priority || (isOpen(cfg, o) && stageOf(cfg, o).needs_close) || (isWon(cfg, o) && !o.installed));
  if (fk('stage')) rows = rows.filter((o) => o.stage === fk('stage'));
  if (fk('flag')) rows = rows.filter((o) => flag(cfg, o, w.today, S.crm) === fk('flag'));
  if (fk('size')) rows = rows.filter((o) => (+o.value || 0) >= +fk('size'));
  const sortK = fk('sort') || 'start';
  const fo = { r: 0, y: 1, g: 2, n: 3 };
  rows.sort((a, b) => sortK === 'value' ? (+b.value || 0) - (+a.value || 0)
    : sortK === 'flag' ? fo[flag(cfg, a, w.today, S.crm)] - fo[flag(cfg, b, w.today, S.crm)]
    : (a.start_date || '9999') < (b.start_date || '9999') ? -1 : 1);

  // branch card
  const bm = (tab.branch_measures || cfg.measures.map((m) => m.key)).map((k) => cfg.measures.find((m) => m.key === k)).filter(Boolean);
  const ratio = tab.ratio && cfg.measures.some((m) => m.key === tab.ratio.num) && cfg.measures.some((m) => m.key === tab.ratio.den) ? tab.ratio : null;
  const ratioGoal = ratio ? +goals()[ratio.goal] || 0 : 0;
  const branchRows = cfg.branches.map((b) => {
    const rs = rr.filter((x) => x.branch === b);
    if (!rs.length) return null;
    const t = {};
    cfg.measures.forEach((m) => (t[m.key] = { c: 0, d: 0 }));
    rs.forEach((x) => { const c = commitFor(x.id, w.scoreKey), a = autoDid(cfg, opps, x.id, w.scoreKey); cfg.measures.forEach((m) => { t[m.key].c += comValue(c, m.key); t[m.key].d += didValue(c, a, m.key); }); });
    const rv = ratio && t[ratio.den].d ? t[ratio.num].d / t[ratio.den].d : 0;
    return { b, t, rv, den: ratio ? t[ratio.den].d : 0 };
  }).filter(Boolean);
  const ratioDot = (x) => (!x.den ? 'n' : !ratioGoal ? 'n' : x.rv >= ratioGoal ? 'g' : x.rv >= 0.7 * ratioGoal ? 'y' : 'r');

  const didRow = (label, week, c, a) => `<tr><td>${label}</td>${cfg.measures.map((m) => {
    const com = comValue(c, m.key), did = didValue(c, a, m.key);
    const manual = c && c.actual && hasVal(c.actual[m.key]);
    const auto = m.key in a;
    return `<td class="num"><span class="dot ${c ? ryg(did, com) : 'n'}"></span> <input class="ed num" inputmode="decimal" ${canEdit ? '' : 'disabled'} data-cm="${esc(r.id)}" data-cw="${week}" data-cf="actual" data-ck="${esc(m.key)}" value="${manual ? esc(c.actual[m.key]) : ''}" placeholder="${auto ? esc(fmtM(m, a[m.key])) : '0'}" aria-label="${esc(lab(m))} did"><div class="auto">${auto && !manual ? 'from board' : ''}</div></td>`;
  }).join('')}</tr>`;

  const committedAt = thisC && thisC.submitted_at
    ? new Date(thisC.submitted_at).toLocaleString('en-US', { timeZone: cfg.lock_tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const late = thisC && thisC.late && !thisC.accepted_by;

  el.innerHTML = `
  <div class="sec-h"><h2>${esc(tab.title || tab.label)}${tab.sub ? ' · ' + esc(tab.sub) : ''}</h2>
    <span class="sub"><label>${isLeader() ? 'Viewing' : 'Showing'} <select class="ed" data-f="${fkey}">${rr.map((x) => `<option value="${esc(x.id)}" ${x.id === r.id ? 'selected' : ''}>${esc(x.full_name)}</option>`).join('')}</select></label></span></div>

  <div class="commit">
    <div class="card cform">
      <div class="sec-h"><h2 class="s16">My week · <span class="person">${esc(r.full_name)}</span>${r.branch ? ' · ' + esc(r.branch) : ''}</h2>${canEdit ? '' : '<span class="ro">view only</span>'}</div>
      <div class="tw bare"><table><thead><tr><th></th>${cfg.measures.map((m) => `<th class="num">${esc(lab(m))}</th>`).join('')}</tr></thead><tbody>
        ${w.locked ? '' : `<tr><td>Last week committed</td>${cfg.measures.map((m) => `<td class="num">${scoreC ? fmtM(m, comValue(scoreC, m.key)) : '<span class="m" style="color:var(--muted)">none</span>'}</td>`).join('')}</tr>
        ${didRow('Last week did', w.scoreKey, scoreC, scoreA)}`}
        <tr><td>${w.locked ? 'This week committed' : 'This week I commit to'}</td>${cfg.measures.map((m) => `<td class="num"><input class="ed num ${late ? 'late' : ''}" inputmode="decimal" ${dis(w.key)} data-cm="${esc(r.id)}" data-cw="${w.key}" data-cf="committed" data-ck="${esc(m.key)}" value="${thisC && hasVal(thisC.committed?.[m.key]) ? esc(thisC.committed[m.key]) : ''}" placeholder="${m.money ? '$' : '#'}" aria-label="${esc(lab(m))} commit"></td>`).join('')}</tr>
        ${w.locked ? didRow('This week did', w.scoreKey, scoreC, scoreA) : ''}
      </tbody></table></div>
      <div class="row-actions">
        ${thisC ? `<span class="pill ${late ? 'y' : 'g'}">Committed${committedAt ? ' ' + esc(committedAt) : ''}${late ? ' · edited after lock' : ''}</span>` : `<span class="pill ${w.locked ? 'r' : 'n'}">${w.locked ? 'No commit this week' : 'Not committed yet'}</span>`}
        <span class="help">${cfg.measures.length} numbers. Two minutes. Type them and they save. ${w.locked ? 'Commits are locked. Changes show as late. Enter what you did before midnight.' : `Locks ${esc(lockLabel(cfg))}.`}</span>
      </div>
      <div style="margin-top:8px"><input class="ed txt wide" ${dis(w.key)} data-cm="${esc(r.id)}" data-cw="${w.key}" data-cf="note" placeholder="${esc(tab.note_prompt || 'What do you need this week?')}" value="${esc(thisC?.note || '')}" aria-label="Note"></div>
    </div>
    <div class="card">
      <div class="sec-h"><h2 class="s16">Branches · ${esc(w.scoreLabel.toLowerCase())}</h2><span class="sub">${esc(ratio?.sub || 'did / committed')}</span></div>
      <div class="tw flat"><table><thead><tr><th>Branch</th>${bm.map((m) => `<th class="num">${esc(lab(m))}</th>`).join('')}${ratio ? `<th class="num">${esc(ratio.label)}</th>` : ''}</tr></thead><tbody>
      ${branchRows.map((x) => `<tr><td><b>${esc(x.b)}</b></td>${bm.map((m) => `<td class="num">${m.auto === 'won_value' ? `<span class="dot ${ryg(x.t[m.key].d, x.t[m.key].c)}"></span> ` : ''}${fmtM(m, x.t[m.key].d)}<small class="m">/${fmtM(m, x.t[m.key].c)}</small></td>`).join('')}${ratio ? `<td class="num"><span class="dot ${ratioDot(x)}"></span> ${x.rv.toFixed(1)}</td>` : ''}</tr>`).join('')}
      </tbody></table></div>
      ${tab.branch_note ? `<p class="note">${esc(tab.branch_note)}</p>` : ''}
    </div>
  </div>

  <div class="sec">
    <div class="sec-h"><h2 class="s16">My accounts · ${rows.length}</h2>
      <div class="bar tight">
        <select class="ed" data-f="${team}_sort"><option value="start" ${sortK === 'start' ? 'selected' : ''}>Sort: start date</option><option value="value" ${sortK === 'value' ? 'selected' : ''}>Sort: deal size</option><option value="flag" ${sortK === 'flag' ? 'selected' : ''}>Sort: flag</option></select>
        <select class="ed" data-f="${team}_size"><option value="">Deal size: all</option>${[5000, 25000, 100000].map((v) => `<option value="${v}" ${fk('size') === String(v) ? 'selected' : ''}>${money(v)}+</option>`).join('')}</select>
        <select class="ed" data-f="${team}_stage"><option value="">Stage: all</option>${cfg.stages.map((s) => `<option ${fk('stage') === s.name ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <select class="ed" data-f="${team}_flag"><option value="">Flag: all</option><option value="r" ${fk('flag') === 'r' ? 'selected' : ''}>Red</option><option value="y" ${fk('flag') === 'y' ? 'selected' : ''}>Yellow</option><option value="g" ${fk('flag') === 'g' ? 'selected' : ''}>Green</option></select>
        <select class="ed" data-f="${team}_all"><option value="">Focus list</option><option value="1" ${fk('all') ? 'selected' : ''}>Everything of mine</option></select>
        ${canEdit ? `<button class="btn sm" data-add="${esc(r.id)}" data-team="${esc(team)}">+ Add account</button>` : ''}
      </div></div>
    ${renderGrid(rows, { canEdit: canEditOpp })}
    <p class="note">Focus list = your priority accounts plus anything past the early stages or waiting to install. Star a row to pin it. Red: next step past due, no touch in 14 days, bid out with no start date. Yellow: due in 3 days or a field missing.</p>
  </div>`;
}
