import { S, wk, goals, isCompany, scope, scopeLabel, oppsScoped, oppsAll, repsScoped, commitFor, tabFor, accountsScoped, branchList, fromCrm, sourceNote, byBranch as splitByBranch } from '../data/store.js';
import { repCell, renderGrid, canEditOpp } from './grid.js';
import { repLines } from './team.js';
import { repScore } from './climb.js';
import { bookTile } from './book.js';
import { seg, periodSeg } from './controls.js';
import { esc, money, pct, fmtDate, daysBetween, validDate, addDays, dow } from '../lib/format.js';
import { mLabel } from '../data/workspace.js';
import { isOpen, isWon, isUnknown, isRecurring, weighted, bidOut, sum, ryg, goalDetail, netNewTest, isBidMeasure, bidNote } from '../lib/rules.js';
import { periodRange, weeksIn, monthsIn, monthLabel, targetFor } from '../lib/period.js';
import { METRICS, metricRows, metricValue, filterDeals, split, renewalsIn, forecastByMonth, branchGroups, repGroups, repBreakdown, advancedIn } from '../lib/summit.js';

const tile = (cls, l, v, s, extra = '', attrs = '') =>
  `<div class="tile ${cls}" ${attrs}><span class="stripe"></span><div class="l">${l}</div><div class="v">${v}</div>${extra}${s ? `<div class="s">${s}</div>` : ''}</div>`;

const TILE_METRICS = ['closed', 'created', 'forecast'];

// the target for the scope on screen: the whole company, one branch, or none for a single rep
function scopeTarget(metric, f, p) {
  const sc = scope();
  if (sc.startsWith('member:')) return null;
  return targetFor(S.targets || [], { metric, division: f.division, kind: f.kind, branch: sc.startsWith('branch:') ? sc.slice(7) : null }, p);
}

export function renderSummit(el) {
  const cfg = S.cfg, w = wk(), company = isCompany(), crm = fromCrm(), W = cfg.words;
  const hasDiv = cfg.filters.includes('division'), hasKind = cfg.filters.includes('kind');
  const DIVS = [['all', 'All'], ['maintenance', W.maintenance], ['install', W.install]];
  const KINDS = [['all', 'All'], ['enhancement', W.enhancement], ['netnew', W.netnew]];
  const f = { division: hasDiv ? S.filters.sum_div || 'all' : 'all', kind: hasKind ? S.filters.sum_kind || 'all' : 'all' };
  const kind = S.filters.sum_period || 'month';
  const p = periodRange(kind, w);
  // net new: the property had no won deal before this one. History is every deal, whatever the scope.
  const isNew = netNewTest(cfg, oppsAll());
  const R = filterDeals(cfg, oppsScoped(), f, isNew);
  const M = Object.fromEntries(TILE_METRICS.map((k) => {
    const rows = metricRows(cfg, k, R, p, w.today);
    return [k, { rows, value: metricValue(k, rows), target: scopeTarget(k, f, p) }];
  }));
  const drill = S.filters.sum_drill || '';
  const onDrill = (k) => (drill === `${k}|` ? 'on' : '');
  const attrs = (k) => `role="button" tabindex="0" data-drill="${k}|" aria-pressed="${drill === `${k}|`}"`;
  const vsTarget = (value, target) => (target != null
    ? { cls: ryg(value, target), v: `${money(value)} <small>/ ${money(target)}</small>`, s: `${pct(value, target)}% of target` }
    : { cls: '', v: money(value), s: 'no target set' });

  // tiles
  const cl = M.closed, cr = M.created, fc = M.forecast;
  const clT = vsTarget(cl.value, cl.target), crT = vsTarget(cr.value, cr.target), fcT = vsTarget(fc.value, fc.target);
  const crSplit = split(cfg, cr.rows);
  const unstarted = R.filter((o) => METRICS.forecast.rows(cfg, [o], { end: '9999-12-31' }, w.today).length);
  const wonNoStart = R.filter((o) => cfg.stageBy[o.stage]?.status === 'won' && !validDate(o.start_date) && validDate(o.actual_close) && o.actual_close >= `${w.year}-01-01`);
  const since = S.tracking;
  const adv = crm ? [] : advancedIn(cfg, R, p);
  const tilesHtml = [
    tile(`${clT.cls} click ${onDrill('closed')}`, 'Closed contracts', clT.v,
      `${clT.s} · ${cl.rows.length} contracts${hasDiv ? ` · ${money(sum(cl.rows.filter((o) => isRecurring(cfg, o))))} ${esc(W.maintenance.toLowerCase())}` : ''}`, '', attrs('closed')),
    tile(`${crT.cls} click ${onDrill('created')}`, 'Pipeline created', crT.v, `${crT.s} · ${cr.rows.length} deals`,
      `<div class="split3"><span>${crSplit.open.n} open ${money(crSplit.open.value)}</span><span>${crSplit.won.n} won ${money(crSplit.won.value)}</span><span>${crSplit.lost.n} lost ${money(crSplit.lost.value)}</span>${crSplit.other.n ? `<span>${crSplit.other.n} status not mapped</span>` : ''}</div>`, attrs('created')),
    tile(`${fcT.cls} click ${onDrill('forecast')}`, 'Forecast', fcT.v,
      `${fcT.s} · won, starting by ${fmtDate(p.end)} · ${money(sum(unstarted))} won and not started in all${wonNoStart.length ? ` · ${wonNoStart.length} won this year with no start date` : ''}`, '', attrs('forecast')),
    crm ? tile('off', 'Earned revenue', 'Not connected yet', `Needs the ${esc(cfg.crmLabel)} Invoices sync, a separate piece of work. Not $0, just not here yet.`) : '',
    crm ? tile('off', 'Pipeline advanced', since ? `Tracking since ${fmtDate(since)}` : `Starts with the next ${cfg.source.mode === 'csv' ? 'upload' : 'sync'}`,
      `${esc(cfg.crmLabel)} keeps no stage history. Summit records every deal's status ${cfg.source.mode === 'csv' ? 'on each upload' : 'nightly'}, so this counts from ${since ? fmtDate(since) : 'the first snapshot'} forward.`)
      : tile(`click ${onDrill('advanced')}`, 'Pipeline advanced', String(adv.length), `${money(sum(adv))} · deals that moved forward a stage in ${esc(p.label)}`, '', attrs('advanced')),
  ].join('');

  // by branch: every deal on one row, the rows add up to the tiles
  const sc = scope();
  const byBranch = splitByBranch();
  const groups = byBranch ? branchGroups(R, branchList()).filter((g) => g.rows.length || (!g.unassigned && g.branch && (company || sc === `branch:${g.branch}`)))
    : repGroups(R, repsScoped()).filter((g) => g.rows.length || company || sc === `member:${g.key.slice(2)}`);
  const cellFor = (g, k) => {
    const rows = metricRows(cfg, k, g.rows, p, w.today), v = metricValue(k, rows);
    const t = byBranch && !g.unassigned && g.branch && !sc.startsWith('member:') ? targetFor(S.targets || [], { metric: k, division: f.division, kind: f.kind, branch: g.branch }, p) : null;
    const key = `${k}|${g.key}`;
    return `<td class="num"><button type="button" class="cellbtn ${drill === key ? 'on' : ''}" data-drill="${esc(key)}"><b>${money(v)}</b>${t != null ? `<small class="m"> / ${money(t)}</small>` : ''}<small class="m"> ·${rows.length}</small></button>${g.unassigned ? repLines(repBreakdown(rows, METRICS[k].value), 3) : ''}</td>`;
  };
  const label = (g) => (g.person ? `<span class="person">${esc(g.branch)}</span>` : !byBranch ? '<b>No rep</b>'
    : g.unassigned ? `<b>${esc(g.branch)}</b> <span class="pill n">not on roster</span>` : `<b>${g.branch ? esc(g.branch) : 'No branch'}</b>`);
  const unknown = R.filter((o) => isUnknown(cfg, o));

  // renewals and the forecast by start month
  const ren = renewalsIn(cfg, R, p);
  const renEnd = ren.filter((x) => x.source === 'end').length;
  const renMonths = monthsIn(p).map(({ month }) => { const x = ren.filter((r) => r.date.slice(0, 7) === month.slice(0, 7)); return { month, n: x.length, value: sum(x.map((r) => r.o)) }; });
  const fMonths = forecastByMonth(cfg, R, w.today, 12);
  const hasDates = R.some((o) => validDate(o.end_date) || validDate(o.renewal_date));

  // the drill-down: the opportunities behind a tile or a branch cell
  let drillHtml = '';
  if (drill) {
    const [k, ...rest] = drill.split('|'), gk = rest.join('|');
    const g = gk ? groups.find((x) => x.key === gk) : null;
    const base = g ? g.rows : R;
    const rows = k === 'renewals' ? ren.map((x) => x.o) : k === 'advanced' ? adv : METRICS[k] ? metricRows(cfg, k, base, p, w.today) : [];
    const val = k === 'renewals' || k === 'advanced' ? sum(rows) : METRICS[k] ? metricValue(k, rows) : 0;
    const title = k === 'renewals' ? 'Renewals' : k === 'advanced' ? 'Pipeline advanced' : METRICS[k]?.label || '';
    const where = g ? `${g.branch || (byBranch ? 'No branch' : 'No rep')}${g.unassigned && byBranch ? ', not on roster' : ''}` : scopeLabel();
    drillHtml = `<div class="sec" id="drill"><div class="sec-h"><h2 class="s16">${esc(title)} · ${esc(where)} · ${esc(p.label)} · ${rows.length} deals · ${money(val)}</h2><button class="lnk" data-drill="${esc(drill)}">Close</button></div>
      ${renderGrid([...rows].sort((a, b) => (+b.value || 0) - (+a.value || 0)), { canEdit: canEditOpp, full: true })}</div>`;
  }

  // cash ladder: work starting by week, 8 weeks from this Monday. Signed work is firm, open work is
  // weighted by status. It always looks 8 weeks ahead; the period toggle does not move it, the filters do.
  const mon = addDays(w.today, -((dow(w.today) + 6) % 7));
  const buckets = [];
  for (let i = 0; i < 8; i++) { const s0 = addDays(mon, i * 7); buckets.push({ s: s0, e: addDays(s0, 6), firm: 0, soft: 0 }); }
  R.forEach((o) => {
    if (!validDate(o.start_date)) return;
    const b = buckets.find((x) => o.start_date >= x.s && o.start_date <= x.e);
    if (!b) return;
    if (isWon(cfg, o)) b.firm += +o.value || 0;
    else if (isOpen(cfg, o)) b.soft += weighted(cfg, o);
  });
  const maxB = Math.max(1, ...buckets.map((b) => b.firm + b.soft));
  const next4 = sum(buckets.slice(0, 4), (b) => b.firm), next4s = sum(buckets.slice(0, 4), (b) => b.soft);
  const noStart = R.filter((o) => bidOut(cfg, o) && !validDate(o.start_date));

  // goals run on their own windows. The toggle does not move them.
  const g = goals(), yr = String(w.year);
  const goalHtml = company ? cfg.goalTiles.map((t) => {
    const det = goalDetail(cfg, t, g, oppsScoped(), oppsScoped().filter((o) => cfg.stageBy[o.stage]?.status === 'won' && (!crm || (o.actual_close || '').startsWith(yr))), S.goalsRow?.period || yr, oppsAll());
    const goal = +g[t.goal] || 0, deadline = t.deadline ? g[t.deadline] : null;
    const daysLeft = validDate(deadline) ? Math.max(0, daysBetween(w.today, deadline)) : null;
    const basis = det.basis === 'new_properties' ? ` · ${det.properties} new ${det.properties === 1 ? 'property' : 'properties'}${det.renewals ? ` · ${money(det.renewals)} renewals not counted` : ''}` : '';
    if (deadline) {
      const raw = pct(det.actual, goal), pc = Math.min(100, raw);
      const goalTile = tile(pc >= 100 ? 'g' : pc >= 70 ? 'y' : 'r', `${esc(t.label)} vs ${fmtDate(deadline)}`, `${money(det.actual)} <small>/ ${money(goal)}</small>`,
        `${raw}%${daysLeft != null ? ` · ${daysLeft} days left` : ''}${basis}${det.start ? ` · window ${fmtDate(det.start)} to ${fmtDate(deadline)}` : ''}`, `<div class="prog"><i style="width:${pc}%"></i></div>`);
      if (!t.coverage || t.source !== 'won_recurring') return goalTile;
      const gap = Math.max(0, goal - det.actual);
      const pipe = oppsScoped().filter((o) => isOpen(cfg, o) && isRecurring(cfg, o) && (!det.isNew || det.isNew(o)));
      const wtd = sum(pipe, (o) => weighted(cfg, o));
      const cov = !goal ? tile('', 'Coverage on the gap', '—', 'no goal set')
        : !gap ? tile('g', 'Coverage on the gap', 'Goal met', `${money(wtd)} weighted pipeline still open · ${pipe.length} deals`)
        : tile(wtd / gap >= 3 ? 'g' : wtd / gap >= 1.5 ? 'y' : 'r', 'Coverage on the gap', `${(wtd / gap).toFixed(1)}x`, `${money(gap)} to go · ${money(wtd)} weighted ÷ gap`);
      return goalTile + cov;
    }
    return tile('', esc(t.label), `${money(det.actual)} <small>/ ${money(goal)}</small>`, t.as_of ? esc(g[t.as_of] || '') : '');
  }).join('') : '';
  const bookHtml = cfg.summitTiles.map((t) => bookTile(t, accountsScoped(), w.today)).join('');

  // committed vs did, over the same period's lock weeks
  const RS = repsScoped(), weeks = weeksIn(p, w);
  const tot = {};
  cfg.measures.forEach((m) => (tot[m.key] = { c: 0, d: 0 }));
  RS.forEach((r) => { const s = repScore(cfg, oppsAll(), r.id, weeks); cfg.measures.forEach((m) => { tot[m.key].c += s[m.key].c; tot[m.key].d += s[m.key].d; }); });
  const fmtM = (m, v) => (m.money ? money(v) : v);
  const note = tabFor('summit')?.note;

  el.innerHTML = `
  <div class="sec-h"><h2>Where ${esc(scopeLabel())} stands</h2><span class="sub">${crm ? `${cfg.source.mode === 'connected' ? `Deals from ${esc(cfg.crmLabel)}, synced nightly` : esc(sourceNote())}. Test data left off.` : 'Updates the moment anyone changes a field.'}${company ? '' : ` Only ${esc(scopeLabel())}. Pick All in Viewing for the whole picture.`}</span></div>
  <div class="controls">
    ${periodSeg('sum_period', kind)}
    ${hasDiv ? seg('sum_div', DIVS, f.division, 'Division') : ''}
    ${hasKind ? seg('sum_kind', KINDS, f.kind, `${W.enhancement} or ${W.netnew}`) : ''}
    <span class="when">${esc(p.label)} · ${fmtDate(p.start)} to ${fmtDate(p.end)}</span>
  </div>
  <div class="tiles">${tilesHtml}</div>
  ${(S.targets || []).length ? '' : `<p class="note"><b>No targets yet.</b> Every tile says "no target set" until leadership enters them on Data Check${hasDiv ? `: All, ${esc(W.maintenance)} and ${esc(W.install)}` : ''}${byBranch ? ', by branch' : ''}, by month.</p>`}
  <p class="note">Click a tile or a ${byBranch ? 'branch' : 'rep'} number for the deals behind it.${hasKind ? ` ${esc(W.netnew)}: the ${crm ? 'property' : 'account'} had no won deal, in any division, before this one. Everything else is ${esc(W.enhancement)}.` : ''}${hasDiv ? ` ${esc(W.install)} is everything that is not ${esc(W.maintenance.toLowerCase())}.` : ''}</p>

  <div class="sec card">
    <div class="sec-h"><h2 class="s16">By ${byBranch ? 'branch' : 'rep'} · ${esc(p.label)}</h2><span class="sub">${byBranch ? 'actual / target · deals' : 'actual · deals'}</span></div>
    <div class="tw flat"><table><thead><tr><th>${byBranch ? 'Branch' : 'Rep'}</th>${TILE_METRICS.map((k) => `<th class="num">${esc(METRICS[k].label)}</th>`).join('')}</tr></thead><tbody>
    ${groups.map((x) => `<tr class="${x.unassigned ? 'unas' : ''}"><td>${label(x)}</td>${TILE_METRICS.map((k) => cellFor(x, k)).join('')}</tr>`).join('')}
    <tr><td><b>Total</b></td>${TILE_METRICS.map((k) => `<td class="num"><b>${money(M[k].value)}</b><small class="m"> ·${M[k].rows.length}</small></td>`).join('')}</tr>
    </tbody></table></div>
    ${byBranch && groups.some((x) => x.unassigned) ? `<p class="note">Not on roster: deals whose ${esc(cfg.crmLabel)} rep matches nobody in Summit, with the ${esc(cfg.crmLabel)} names under the dollars. Add them to the roster, or put their ${esc(cfg.crmLabel)} spelling in crm_name.</p>` : ''}
    ${unknown.length ? `<div class="kv"><span>Deals with a status not mapped (in Pipeline created, not in Closed or Forecast)</span><b>${unknown.length}</b></div>` : ''}
  </div>

  ${drillHtml}

  <div class="sec card fixed">
    <div class="sec-h"><h2 class="s16">Cash ladder · work starting by week <span class="pill n">next 8 weeks, not the toggle</span></h2><span class="sub">Next 4 weeks: <b>${money(next4)}</b> firm, ${money(next4s)} weighted</span></div>
    <p class="fixed-why">Always the next 8 weeks from this Monday, whatever period is picked.${hasDiv && hasKind ? ` The ${esc(W.maintenance)} / ${esc(W.install)} and ${esc(W.enhancement)} / ${esc(W.netnew)} filters do apply.` : cfg.filters.length ? ' The filters above do apply.' : ''}</p>
    <div class="ladder">${buckets.map((b) => `<div class="col"><span class="lab">${b.firm + b.soft ? money(b.firm + b.soft) : ''}</span><div class="soft" style="height:${Math.round((b.soft / maxB) * 100)}%"></div><div class="firm" style="height:${Math.round((b.firm / maxB) * 100)}%"></div></div>`).join('')}</div>
    <div class="ladder-x">${buckets.map((b) => `<span>${fmtDate(b.s)}</span>`).join('')}</div>
    <div class="legend"><span><i style="background:var(--accent)"></i>Signed, starting that week</span><span><i style="background:var(--grey)"></i>Open, weighted by status</span></div>
    ${noStart.length ? `<div class="note">${noStart.length} bids out worth ${money(sum(noStart))} have no start date, so they're invisible here. They're on the Data Check tab.</div>` : ''}
  </div>

  <div class="split sec">
    ${!crm && !hasDates ? '' : `<div class="card">
      <div class="sec-h"><h2 class="s16">Renewals · ${esc(p.label)}</h2><span class="sub">${ren.length} contracts · ${money(sum(ren.map((x) => x.o)))}</span></div>
      ${renMonths.length > 1 ? `<div class="months">${renMonths.map((m) => `<span>${esc(monthLabel(m.month, true))} <b>${money(m.value)}</b> <small class="m">·${m.n}</small></span>`).join('')}</div>` : ''}
      ${ren.length ? `<div class="tw flat"><table><thead><tr><th>Property</th><th>Rep</th><th>Type</th><th class="num">$</th><th>Renews</th><th>From</th></tr></thead><tbody>
        ${ren.slice(0, 12).map(({ o, date, source }) => `<tr><td class="acct">${esc(o.account)}<small>${esc([o.job, o.branch].filter(Boolean).join(' · '))}</small></td><td>${repCell(o)}</td><td>${esc(o.category)}</td><td class="num">${money(o.value)}</td><td>${fmtDate(date)}</td><td><span class="pill n">${source === 'renewal' ? 'Renewal date' : 'End date'}</span></td></tr>`).join('')}
      </tbody></table></div>
      ${ren.length > 12 ? `<div class="row-actions"><button class="lnk" data-drill="renewals|">All ${ren.length} renewals</button></div>` : ''}`
      : `<div class="empty">${hasDates ? `No contracts renew in ${esc(p.label)}.` : `No renewal or end dates yet.${crm ? ' They come with migration 011.' : ''}`}</div>`}
      ${renEnd ? `<p class="note">${renEnd} of ${ren.length} use the end date, because ${esc(cfg.crmLabel)} has no renewal date on them.</p>` : ''}
    </div>`}
    <div class="card">
      <div class="sec-h"><h2 class="s16">Forecast · won work by start month</h2><span class="sub">not started yet · ${money(sum(unstarted))}</span></div>
      ${fMonths.map((m) => `<div class="kv"><span>${esc(monthLabel(m.month))}</span><b>${money(m.value)} <small class="m">·${m.n}</small></b></div>`).join('')}
      <p class="note">Unearned: signed, not started. It turns into earned revenue once invoices are connected.</p>
    </div>
  </div>

  ${goalHtml || bookHtml ? `<div class="sec fixed"><div class="sec-h"><h2 class="s16">Goals <span class="pill n">goal window, not the toggle</span></h2><span class="sub">The toggle and filters above do not change these.</span></div>
    <p class="fixed-why">Each goal counts from its window start to its deadline, set by leadership on Data Check. The book tiles are the book as it stands today.</p>
    <div class="tiles">${goalHtml}${bookHtml}</div></div>` : ''}

  <div class="sec">
    <div class="sec-h"><h2 class="s16">${kind === 'week' ? esc(w.scoreLabel) : esc(p.label)} · committed vs did, ${esc(scopeLabel())}</h2><span class="sub">${weeks.length ? `${weeks.length === 1 ? `Week ending ${fmtDate(weeks[0])}` : `${weeks.length} lock weeks, ending ${fmtDate(weeks[0])} to ${fmtDate(weeks[weeks.length - 1])}`}` : `No week has ended in ${esc(p.label)} yet`}. Detail on The Climb.</span></div>
    <div class="tiles">${cfg.measures.map((m) => { const t = tot[m.key]; return tile(ryg(t.d, t.c), esc(mLabel(m)), `${fmtM(m, t.d)} <small>/ ${fmtM(m, t.c)}</small>`, t.c ? `${pct(t.d, t.c)}%` : 'no commit yet', crm && isBidMeasure(m) ? `<div class="src">From ${esc(cfg.crmLabel)}: every opportunity created</div>` : ''); }).join('')}</div>
    ${crm && cfg.measures.some(isBidMeasure) ? `<p class="note">${esc(bidNote(cfg))}</p>` : ''}
  </div>
  ${company && note ? `<p class="note">${esc(note)}</p>` : ''}`;
}
