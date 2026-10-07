import { S, wk, scopeLabel, repsScoped, commitFor, oppsAll, teamTabs, fromCrm, byBranch as splitByBranch } from '../data/store.js';
import { esc, money, fmtDate, pct, addDays } from '../lib/format.js';
import { mLabel, teamMeasures } from '../data/workspace.js';
import { lockLabel } from '../lib/time.js';
import { ryg, autoDid, didValue, comValue, isBidMeasure, bidsIn, bidNote } from '../lib/rules.js';
import { periodRange, weeksIn } from '../lib/period.js';
import { periodSeg } from './controls.js';

export function commitPill(c, locked) {
  if (c) return `<span class="pill ${c.late && !c.accepted_by ? 'y' : 'g'}">in${c.late && !c.accepted_by ? ' · late edit' : ''}</span>`;
  return `<span class="pill ${locked ? 'r' : 'n'}">${locked ? 'missed' : 'not yet'}</span>`;
}

// committed and did for one rep, added up over a list of lock weeks
export function repScore(cfg, opps, memberId, weeks) {
  const out = {};
  cfg.measures.forEach((m) => (out[m.key] = { c: 0, d: 0 }));
  for (const k of weeks) {
    const c = commitFor(memberId, k), a = autoDid(cfg, opps, memberId, k);
    cfg.measures.forEach((m) => { out[m.key].c += comValue(c, m.key); out[m.key].d += didValue(c, a, m.key); });
  }
  out.any = weeks.some((k) => commitFor(memberId, k));
  return out;
}

// Aspire bids for a set of reps over the weeks shown, split open / won / lost, for the tile's note
export function bidSplitLine(cfg, opps, memberIds, weeks) {
  if (!weeks.length) return '';
  const ids = new Set(memberIds);
  const b = bidsIn(cfg, opps.filter((o) => ids.has(o.owner_member_id)), addDays(weeks[0], -6), weeks[weeks.length - 1]);
  return `${b.open.n} open · ${b.won.n} won · ${b.lost.n} lost`;
}

export function renderClimb(el) {
  const cfg = S.cfg, w = wk(), opps = oppsAll(), crm = fromCrm();
  const kind = S.filters.climb_period || 'week';
  const p = periodRange(kind, w), weeks = weeksIn(p, w), single = kind === 'week';
  const RS = repsScoped();
  const fmtM = (m, v) => (m.money ? money(v) : v);
  const tot = {};
  cfg.measures.forEach((m) => (tot[m.key] = { c: 0, d: 0, tc: 0 }));
  const score = new Map(RS.map((r) => [r.id, repScore(cfg, opps, r.id, weeks)]));
  RS.forEach((r) => {
    const sc = score.get(r.id), tc = commitFor(r.id, w.key);
    cfg.measures.forEach((m) => { tot[m.key].c += sc[m.key].c; tot[m.key].d += sc[m.key].d; tot[m.key].tc += comValue(tc, m.key); });
  });
  const inCount = RS.filter((r) => commitFor(r.id, w.key)).length;
  const split = crm && cfg.measures.some(isBidMeasure) ? bidSplitLine(cfg, opps, RS.map((r) => r.id), weeks) : '';
  const span = single ? '' : weeks.length ? `${weeks.length === 1 ? `the week ending ${fmtDate(weeks[0])}` : `${weeks.length} weeks ending ${fmtDate(weeks[0])} to ${fmtDate(weeks[weeks.length - 1])}`}${weeks.includes(w.key) && !w.locked ? ', this week still open' : ''}` : `No week has ended in ${p.label} yet`;

  const teams = teamTabs().map((t) => {
    const rr = RS.filter((r) => r.team === t.team);
    if (!rr.length) return '';
    const ms = teamMeasures(cfg, t.team), br = splitByBranch();
    return `
    <div class="sec"><div class="sec-h"><h2 class="s16">${esc(t.title || t.label)}${t.team_label ? ' · ' + esc(t.team_label) : ''}</h2><span class="sub">${single ? (w.locked ? 'this week did / committed · locked' : 'last week did / committed · this week committed') : `${esc(p.label)} did / committed`}</span></div>
    <div class="tw"><table><thead><tr><th>Rep</th>${br ? '<th>Branch</th>' : ''}${ms.map((m) => `<th class="num">${esc(mLabel(m, t.team))}</th>`).join('')}<th>This week</th></tr></thead><tbody>
    ${rr.map((r) => {
      const sc = score.get(r.id), tc = commitFor(r.id, w.key);
      return `<tr><td><span class="person">${esc(r.full_name)}</span></td>${br ? `<td>${esc(r.branch || '')}</td>` : ''}${ms.map((m) => {
        const com = sc[m.key].c, did = sc[m.key].d, tcv = comValue(tc, m.key);
        return `<td class="num"><span class="dot ${sc.any ? ryg(did, com) : 'n'}"></span> ${fmtM(m, did)}<small class="m">/${fmtM(m, com)}</small>${single && !w.locked ? `<br><small class="i">→ ${fmtM(m, tcv)}</small>` : ''}</td>`;
      }).join('')}<td>${commitPill(tc, w.locked)}</td></tr>`;
    }).join('')}
    </tbody></table></div></div>`;
  }).join('');

  const autoNames = cfg.measures.filter((m) => m.auto).map((m) => mLabel(m));
  const tileS = (m, t) => {
    if (single) return w.locked ? (t.c ? `${pct(t.d, t.c)}%` : 'no commit') : `this week's commit: <b>${fmtM(m, t.tc)}</b>`;
    return t.c ? `${pct(t.d, t.c)}% of committed` : 'no commit';
  };
  el.innerHTML = `
  <div class="sec-h"><h2>The Climb · ${esc(scopeLabel())}</h2><span class="sub">${w.locked ? `The week ending ${fmtDate(w.key)} is locked. What we said we'd do and what we did. ${inCount} of ${RS.length} commits in.` : `What we said we'd do last week, what we did, and what we're committing to this week. ${inCount} of ${RS.length} commits in for the week ending ${fmtDate(w.key)}.`}</span></div>
  <div class="controls">${periodSeg('climb_period', kind)}<span class="when">${single ? `${esc(w.scoreLabel)} · week ending ${fmtDate(w.scoreKey)}` : `${esc(p.label)} · ${esc(span)}`}</span></div>
  <div class="tiles">${cfg.measures.map((m) => { const t = tot[m.key]; return `<div class="tile ${ryg(t.d, t.c)}"><span class="stripe"></span><div class="l">${esc(mLabel(m))}</div><div class="v">${fmtM(m, t.d)} <small>/ ${fmtM(m, t.c)}</small></div><div class="s">${tileS(m, t)}</div>${crm && isBidMeasure(m) ? `<div class="src">From ${esc(cfg.crmLabel)}, every opportunity created: ${esc(split)}</div>` : ''}</div>`; }).join('')}</div>
  ${teams || '<div class="sec card empty">No reps in this view.</div>'}
  <p class="note">Green did 100%+ of committed. Yellow 70 to 99. Red under 70 or no commit by ${esc(lockLabel(cfg))}. Colors go on numbers, never on people.${autoNames.length ? ` ${esc(autoNames.join(', '))} fill in from the board automatically and can be overridden on your tab.` : ''}${crm && cfg.measures.some(isBidMeasure) ? ` ${esc(bidNote(cfg))}` : ''}${single ? '' : ' Month, Quarter and Year add up the lock weeks that end inside them, Wednesday to Tuesday, the same weeks the commit lock uses.'}</p>`;
}
