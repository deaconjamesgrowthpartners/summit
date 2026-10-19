// The branch card on a team tab (Grow, Net New) when the tab counts deals by kind, not by who sold them.
// A tab with deals: { kind: 'enhancement' | 'netnew' } (or { division: '<match>' }) puts every deal of that kind in its
// own CRM branch, whoever sold it, so a branch's work shows even when nobody on the team is rostered there.
//   deal measures (auto: bids, won $, starting next week) come from those deals
//   typed measures and every commitment come from the team's reps rostered at that branch: only people type and commit.
//   A branch with none of the team's reps reads "no one" for typed numbers, never 0.
import { comValue, hasVal, isOpen, sum } from './rules.js';
import { nameKey } from '../data/workspace.js';

// does a deal belong to this tab? isNew is netNewTest's answer for the deal
export function teamDealTest(tab, isNew) {
  const d = tab.deals || {};
  if (d.kind === 'netnew') return (o) => isNew(o);
  if (d.kind === 'enhancement') return (o) => !isNew(o);
  if (d.division) { const k = nameKey(d.division); return (o) => nameKey(o.division).includes(k); }
  return null;
}

export function dealBranchRows(cfg, { branches, deals, reps, inTeam, week, commitOf, autoRows }) {
  const mine = deals.filter(inTeam);
  const keys = [...branches];
  if (mine.some((o) => !o.branch || !branches.includes(o.branch))) keys.push('');
  return keys.map((b) => {
    const D = mine.filter((o) => (b ? o.branch === b : !o.branch || !branches.includes(o.branch)));
    const rs = b ? reps.filter((r) => r.branch === b) : [];
    const auto = autoRows(cfg, D, week);
    const t = {};
    for (const m of cfg.measures) {
      const cs = rs.map((r) => commitOf(r.id, week));
      const c = cs.reduce((a, x) => a + comValue(x, m.key), 0);
      if (m.key in auto) t[m.key] = { c, d: auto[m.key] };
      else if (rs.length) t[m.key] = { c, d: cs.reduce((a, x) => a + (x && x.actual && hasVal(x.actual[m.key]) ? +x.actual[m.key] : 0), 0) };
      else t[m.key] = null;
    }
    const open = D.filter((o) => isOpen(cfg, o));
    return { b, t, reps: rs.length, deals: D.length, open: sum(open), openN: open.length };
  }).filter((x) => x.deals || x.reps);
}
