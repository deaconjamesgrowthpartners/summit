import { S, wk, goals, isCompany, scopeLabel, oppsScoped, repsScoped, commitFor, nameOf, tabFor } from '../data/store.js';
import { esc, money, pct, fmtDate, addDays, dow, daysBetween, validDate } from '../lib/format.js';
import { mLabel } from '../data/workspace.js';
import { isOpen, isWon, isLost, isRecurring, weighted, bidOut, sum, ryg, autoDid, didValue, comValue, flag, rowIssues } from '../lib/rules.js';

const tile = (cls, l, v, s, extra = '') =>
  `<div class="tile ${cls}"><span class="stripe"></span><div class="l">${l}</div><div class="v">${v}</div>${extra}${s ? `<div class="s">${s}</div>` : ''}</div>`;

// actual for a goal tile, from the board or typed in by leadership
function tileActual(cfg, t, won, g) {
  return t.source === 'won_recurring' ? sum(won.filter((o) => isRecurring(cfg, o))) : +g[t.actual] || 0;
}

export function renderSummit(el) {
  const cfg = S.cfg, w = wk(), g = goals(), company = isCompany();
  const rows = oppsScoped();
  const yr = String(w.year);
  const won = rows.filter((o) => isWon(cfg, o) && (!o.actual_close || o.actual_close.startsWith(yr)));
  const open = rows.filter((o) => isOpen(cfg, o));
  const lost = rows.filter((o) => isLost(cfg, o));
  const recurring = won.filter((o) => isRecurring(cfg, o));
  const winRate = won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : 0;
  const bids = open.filter((o) => bidOut(cfg, o));

  // goal tiles
  const gt = cfg.goalTiles.map((t) => {
    const actual = tileActual(cfg, t, won, g);
    const goal = +g[t.goal] || 0;
    const deadline = t.deadline ? g[t.deadline] : null;
    const daysLeft = validDate(deadline) ? Math.max(0, daysBetween(w.today, deadline)) : null;
    return { t, actual, goal, deadline, daysLeft };
  });
  let goalHtml = '';
  if (company) {
    goalHtml = gt.map(({ t, actual, goal, deadline, daysLeft }) => {
      if (deadline) {
        const p = Math.min(100, pct(actual, goal));
        return tile(p >= 100 ? 'g' : p >= 70 ? 'y' : 'r', `${esc(t.label)} vs ${fmtDate(deadline)}`,
          `${money(actual)} <small>/ ${money(goal)}</small>`, `${p}%${daysLeft != null ? ` · ${daysLeft} days left` : ''}`,
          `<div class="prog"><i style="width:${p}%"></i></div>`);
      }
      return tile('', esc(t.label), `${money(actual)} <small>/ ${money(goal)}</small>`, t.as_of ? esc(g[t.as_of] || '') : '');
    }).join('');
  } else {
    goalHtml = gt.filter((x) => x.t.source === 'won_recurring').map(({ t, actual, deadline, daysLeft }) =>
      tile('', `${esc(t.label)} signed`, money(actual),
        `${recurring.length} contracts${daysLeft != null ? ` · ${daysLeft} days to ${fmtDate(deadline)}` : ''}`)).join('');
  }

  // coverage on the gap, for tiles that ask for it
  const covTiles = company ? gt.filter((x) => x.t.coverage && x.t.source === 'won_recurring') : [];
  const covHtml = covTiles.length
    ? covTiles.map(({ actual, goal }) => {
        const gap = Math.max(0, goal - actual);
        const cov = gap ? sum(open.filter((o) => isRecurring(cfg, o)), (o) => weighted(cfg, o)) / gap : 0;
        return tile(cov >= 3 ? 'g' : cov >= 1.5 ? 'y' : 'r', 'Coverage on the gap', `${cov.toFixed(1)}x`, `${money(gap)} to go · weighted recurring pipeline ÷ gap`);
      }).join('')
    : tile('', 'Bids out', money(sum(bids)), `${bids.length} waiting on a yes`);

  // the scored week, committed vs did
  const RS = repsScoped();
  const tot = {};
  cfg.measures.forEach((m) => (tot[m.key] = { c: 0, d: 0 }));
  RS.forEach((r) => {
    const c = commitFor(r.id, w.scoreKey), a = autoDid(cfg, rows, r.id, w.scoreKey);
    cfg.measures.forEach((m) => { tot[m.key].c += comValue(c, m.key); tot[m.key].d += didValue(c, a, m.key); });
  });
  const inCount = RS.filter((r) => commitFor(r.id, w.key)).length;
  const fmtM = (m, v) => (m.money ? money(v) : v);

  // cash ladder, 8 weeks from this Monday
  const mon = addDays(w.today, -((dow(w.today) + 6) % 7));
  const buckets = [];
  for (let i = 0; i < 8; i++) { const s = addDays(mon, i * 7); buckets.push({ s, e: addDays(s, 6), firm: 0, soft: 0 }); }
  rows.forEach((o) => {
    if (!validDate(o.start_date)) return;
    const b = buckets.find((b) => o.start_date >= b.s && o.start_date <= b.e);
    if (!b) return;
    if (isWon(cfg, o)) b.firm += +o.value || 0;
    else if (isOpen(cfg, o)) b.soft += weighted(cfg, o);
  });
  const maxB = Math.max(1, ...buckets.map((b) => b.firm + b.soft));
  const next4 = sum(buckets.slice(0, 4), (b) => b.firm), next4s = sum(buckets.slice(0, 4), (b) => b.soft);
  const noStart = bids.filter((o) => !validDate(o.start_date));

  // by branch
  const wonM = cfg.measures.find((m) => m.auto === 'won_value');
  const br = cfg.branches
    .filter((b) => company || rows.some((o) => o.branch === b) || RS.some((r) => r.branch === b))
    .map((b) => {
      const R = rows.filter((o) => o.branch === b);
      const O = R.filter((o) => isOpen(cfg, o));
      const rr = RS.filter((r) => r.branch === b);
      const wkv = { c: 0, d: 0 };
      if (wonM) rr.forEach((r) => { const c = commitFor(r.id, w.scoreKey); wkv.c += comValue(c, wonM.key); wkv.d += didValue(c, autoDid(cfg, rows, r.id, w.scoreKey), wonM.key); });
      return { b, signed: sum(R.filter((o) => isWon(cfg, o))), open: sum(O), weighted: sum(O, (o) => weighted(cfg, o)), n: O.length, inB: rr.filter((r) => commitFor(r.id, w.key)).length, rr: rr.length, wk: wkv };
    });

  const totalAct = sum(gt, (x) => x.actual), totalGoal = sum(gt, (x) => x.goal);
  const missingDate = open.filter((o) => rowIssues(cfg, o, w.today, S.crm).some((i) => /date/i.test(i.t))).length;
  const note = tabFor('summit')?.note;
  const top = [...open].sort((a, b) => (+b.value || 0) - (+a.value || 0)).slice(0, 10);

  el.innerHTML = `
  <div class="sec-h"><h2>Where ${esc(scopeLabel())} stands</h2><span class="sub">${company ? 'Every team together. Updates the moment anyone changes a field.' : `Only ${esc(scopeLabel())}'s deals and commits. Pick All in Viewing for the whole picture.`}</span></div>
  <div class="tiles">
    ${tile('big', `Signed ${yr}`, money(sum(won)), `${won.length} contracts · ${money(sum(recurring))} recurring · ${money(sum(won) - sum(recurring))} one-time`)}
    ${goalHtml}
    ${tile('', 'Open pipeline', money(sum(open)), `${open.length} opportunities · ${money(sum(open, (o) => weighted(cfg, o)))} weighted`)}
    ${covHtml}
    ${tile('', 'Win rate', `${winRate}%`, `${won.length} won · ${lost.length} lost`)}
  </div>

  <div class="split sec">
    <div class="card">
      <div class="sec-h"><h2 class="s16">Cash ladder · work starting by week</h2><span class="sub">Next 4 weeks: <b>${money(next4)}</b> firm, ${money(next4s)} weighted</span></div>
      <div class="ladder">${buckets.map((b) => `<div class="col"><span class="lab">${b.firm + b.soft ? money(b.firm + b.soft) : ''}</span><div class="soft" style="height:${Math.round((b.soft / maxB) * 100)}%"></div><div class="firm" style="height:${Math.round((b.firm / maxB) * 100)}%"></div></div>`).join('')}</div>
      <div class="ladder-x">${buckets.map((b) => `<span>${fmtDate(b.s)}</span>`).join('')}</div>
      <div class="legend"><span><i style="background:var(--accent)"></i>Signed, starting that week</span><span><i style="background:var(--grey)"></i>Open, weighted by stage</span></div>
      ${noStart.length ? `<div class="note">${noStart.length} bids out worth ${money(sum(noStart))} have no start date, so they're invisible here. They're on the Data Check tab.</div>` : ''}
    </div>
    <div class="card">
      <div class="sec-h"><h2 class="s16">By branch</h2><span class="sub">Friendly competition</span></div>
      <div class="tw flat"><table><thead><tr><th>Branch</th><th class="num">Signed</th><th class="num">Open</th><th class="num">Weighted</th>${wonM ? `<th class="num">${esc(w.scoreLabel)} ${esc(mLabel(wonM))}</th>` : ''}<th>Commits in</th></tr></thead><tbody>
      ${br.map((x) => `<tr><td><b>${esc(x.b)}</b></td><td class="num">${money(x.signed)}</td><td class="num">${money(x.open)}<small class="m"> ·${x.n}</small></td><td class="num">${money(x.weighted)}</td>${wonM ? `<td class="num"><span class="dot ${ryg(x.wk.d, x.wk.c)}"></span> ${money(x.wk.d)}<small class="m">/${money(x.wk.c)}</small></td>` : ''}<td>${x.inB} of ${x.rr}</td></tr>`).join('')}
      </tbody></table></div>
      ${company && gt.length ? `<div class="kv top"><span>Total commitment (${gt.map((x) => esc(x.t.label.toLowerCase())).join(' + ')})</span><b>${money(totalAct)} / ${money(totalGoal)}</b></div>` : ''}
      <div class="kv"><span>Commits in this week</span><b>${inCount} of ${RS.length}</b></div>
      <div class="kv"><span>Open deals missing a date</span><b>${missingDate}</b></div>
    </div>
  </div>

  <div class="sec">
    <div class="sec-h"><h2>${esc(w.scoreLabel)} · committed vs did, ${esc(scopeLabel())}</h2><span class="sub">Week ending ${fmtDate(w.scoreKey)}${w.locked ? ', locked' : ''}. Detail on The Climb.</span></div>
    <div class="tiles">${cfg.measures.map((m) => { const t = tot[m.key]; return tile(ryg(t.d, t.c), esc(mLabel(m)), `${fmtM(m, t.d)} <small>/ ${fmtM(m, t.c)}</small>`, t.c ? `${pct(t.d, t.c)}%` : 'no commit yet'); }).join('')}</div>
  </div>

  <div class="sec card">
    <div class="sec-h"><h2 class="s16">Top open deals</h2><span class="sub">By value · ${esc(scopeLabel())}</span></div>
    ${top.length ? `<div class="tw flat"><table><thead><tr><th></th><th>Account</th><th>Rep</th><th>Type</th><th class="num">Est $</th><th>Stage</th><th>Close</th><th>Start</th><th>Next step</th></tr></thead><tbody>
    ${top.map((o) => `<tr><td><span class="dot ${flag(cfg, o, w.today, S.crm)}"></span></td><td class="acct">${esc(o.account)}<small>${esc([o.branch, o.segment].filter(Boolean).join(' · '))}</small></td><td><span class="person">${esc(nameOf(o.owner_member_id))}</span></td><td>${esc(o.category)}</td><td class="num">${money(o.value)}</td><td>${esc(o.stage)}</td><td>${o.close_date ? fmtDate(o.close_date) : '<span class="pill r">missing</span>'}</td><td>${o.start_date ? fmtDate(o.start_date) : '<span class="pill r">missing</span>'}</td><td class="wrap">${esc(o.next_step)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No open deals yet.</div>'}
  </div>
  ${company && note ? `<p class="note">${esc(note)}</p>` : ''}`;
}
