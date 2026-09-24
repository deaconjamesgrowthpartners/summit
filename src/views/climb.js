import { S, wk, scopeLabel, repsScoped, commitFor, oppsAll, teamTabs } from '../data/store.js';
import { esc, money, fmtDate, pct } from '../lib/format.js';
import { mLabel } from '../data/workspace.js';
import { lockLabel } from '../lib/time.js';
import { ryg, autoDid, didValue, comValue } from '../lib/rules.js';

export function commitPill(c, locked) {
  if (c) return `<span class="pill ${c.late && !c.accepted_by ? 'y' : 'g'}">in${c.late && !c.accepted_by ? ' · late edit' : ''}</span>`;
  return `<span class="pill ${locked ? 'r' : 'n'}">${locked ? 'missed' : 'not yet'}</span>`;
}

export function renderClimb(el) {
  const cfg = S.cfg, w = wk(), opps = oppsAll();
  const RS = repsScoped();
  const fmtM = (m, v) => (m.money ? money(v) : v);
  const tot = {};
  cfg.measures.forEach((m) => (tot[m.key] = { c: 0, d: 0, tc: 0 }));
  RS.forEach((r) => {
    const c = commitFor(r.id, w.scoreKey), a = autoDid(cfg, opps, r.id, w.scoreKey), tc = commitFor(r.id, w.key);
    cfg.measures.forEach((m) => { tot[m.key].c += comValue(c, m.key); tot[m.key].d += didValue(c, a, m.key); tot[m.key].tc += comValue(tc, m.key); });
  });
  const inCount = RS.filter((r) => commitFor(r.id, w.key)).length;

  const teams = teamTabs().map((t) => {
    const rr = RS.filter((r) => r.team === t.team);
    if (!rr.length) return '';
    return `
    <div class="sec"><div class="sec-h"><h2 class="s16">${esc(t.title || t.label)}${t.team_label ? ' · ' + esc(t.team_label) : ''}</h2><span class="sub">${w.locked ? 'this week did / committed · locked' : 'last week did / committed · this week committed'}</span></div>
    <div class="tw"><table><thead><tr><th>Rep</th><th>Branch</th>${cfg.measures.map((m) => `<th class="num">${esc(mLabel(m, t.team))}</th>`).join('')}<th>This week</th></tr></thead><tbody>
    ${rr.map((r) => {
      const c = commitFor(r.id, w.scoreKey), a = autoDid(cfg, opps, r.id, w.scoreKey), tc = commitFor(r.id, w.key);
      return `<tr><td><span class="person">${esc(r.full_name)}</span></td><td>${esc(r.branch)}</td>${cfg.measures.map((m) => {
        const com = comValue(c, m.key), did = didValue(c, a, m.key), tcv = comValue(tc, m.key);
        return `<td class="num"><span class="dot ${c ? ryg(did, com) : 'n'}"></span> ${fmtM(m, did)}<small class="m">/${fmtM(m, com)}</small>${w.locked ? '' : `<br><small class="i">→ ${fmtM(m, tcv)}</small>`}</td>`;
      }).join('')}<td>${commitPill(tc, w.locked)}</td></tr>`;
    }).join('')}
    </tbody></table></div></div>`;
  }).join('');

  const autoNames = cfg.measures.filter((m) => m.auto).map((m) => mLabel(m));
  el.innerHTML = `
  <div class="sec-h"><h2>The Climb · ${esc(scopeLabel())}</h2><span class="sub">${w.locked ? `The week ending ${fmtDate(w.key)} is locked. What we said we'd do and what we did. ${inCount} of ${RS.length} commits in.` : `What we said we'd do last week, what we did, and what we're committing to this week. ${inCount} of ${RS.length} commits in for the week ending ${fmtDate(w.key)}.`}</span></div>
  <div class="tiles">${cfg.measures.map((m) => { const t = tot[m.key]; return `<div class="tile ${ryg(t.d, t.c)}"><span class="stripe"></span><div class="l">${esc(mLabel(m))}</div><div class="v">${fmtM(m, t.d)} <small>/ ${fmtM(m, t.c)}</small></div><div class="s">${w.locked ? (t.c ? `${pct(t.d, t.c)}%` : 'no commit') : `this week's commit: <b>${fmtM(m, t.tc)}</b>`}</div></div>`; }).join('')}</div>
  ${teams || '<div class="sec card empty">No reps in this view.</div>'}
  <p class="note">Green did 100%+ of committed. Yellow 70 to 99. Red under 70 or no commit by ${esc(lockLabel(cfg))}. Colors go on numbers, never on people.${autoNames.length ? ` ${esc(autoNames.join(', '))} fill in from the board automatically and can be overridden on your tab.` : ''}</p>`;
}
