// The Summit tab's numbers, kept out of the view so they can be tested.
//   earned    work earned in the period: the change in Aspire's ActualEarnedRevenue between two nights (deal_motion)
//   closed    contracts won in the period, at what they were won for
//   created   every deal created in the period, whatever its status now, at its estimate
//   forecast  won work still to bill: its billing schedule from this month to the end of the period. A won deal with
//             no schedule counts in full when it starts, between tomorrow and the end of the period
// Every number reads the same deals the rest of the board reads, with the same test data left out.
import { isWon, isOpen, isLost, sum, createdOf, divisionOf } from './rules.js';
import { inPeriod, monthEnd, monthsIn } from './period.js';
import { validDate, addDays, iso } from './format.js';

export const est = (o) => +(o.estimated ?? o.value) || 0;
const wonValue = (o) => +o.value || 0;

const monthOf = (d) => `${d.slice(0, 7)}-01`;

// a deal's billing schedule as dated lines. Aspire gives a month number only: each lands on the first time that month
// comes round on or after the contract's start month. null when the deal has no schedule or no start date.
export function billingLines(o) {
  if (!Array.isArray(o.billing) || !o.billing.length || !validDate(o.start_date)) return null;
  const y = +o.start_date.slice(0, 4), m0 = +o.start_date.slice(5, 7);
  return o.billing.map(([m, amt]) => ({ month: iso(m >= m0 ? y : y + 1, m, 1), amount: +amt || 0 }));
}

// what a won deal still has to bill inside the period: schedule lines from this month on, each at its share of the
// month's days that fall in the period (all of it for Month, Quarter and Year). No schedule: all of it, on its start date.
export function forecastValue(o, p, today) {
  const lines = billingLines(o);
  if (!lines) return validDate(o.start_date) && o.start_date > today && o.start_date <= p.end ? wonValue(o) : 0;
  const share = Object.fromEntries(monthsIn(p).map((x) => [x.month, x.share]));
  return lines.reduce((a, l) => a + (l.month >= monthOf(today) && share[l.month] ? l.amount * share[l.month] : 0), 0);
}

// p.motion is deal_motion for the period: { earned: Map(deal id -> earned), advanced: Map(deal id -> day) }
const earnedOf = (o, p) => p?.motion?.earned?.get(o.id) || 0;

export const METRICS = {
  earned: { label: 'Earned revenue', value: earnedOf, rows: (cfg, R, p) => R.filter((o) => earnedOf(o, p) !== 0) },
  closed: { label: 'Closed contracts', value: wonValue, rows: (cfg, R, p) => R.filter((o) => isWon(cfg, o) && inPeriod(o.actual_close, p)) },
  created: { label: 'Pipeline created', value: est, rows: (cfg, R, p) => R.filter((o) => inPeriod(createdOf(o), p)) },
  forecast: {
    label: 'Forecast',
    value: (o, p, today) => (p && today ? forecastValue(o, p, today) : wonValue(o)),
    rows: (cfg, R, p, today) => R.filter((o) => isWon(cfg, o) && forecastValue(o, p, today) > 0),
  },
};
export const metricRows = (cfg, metric, R, p, today) => METRICS[metric].rows(cfg, R, p, today);
export const metricValue = (metric, rows, p, today) => sum(rows, (o) => METRICS[metric].value(o, p, today));

// won work still to bill, all of it: schedule lines from this month on, and unscheduled work not started yet
export function forecastRemaining(cfg, rows, today) {
  let total = 0;
  for (const o of rows) {
    if (!isWon(cfg, o)) continue;
    const lines = billingLines(o);
    if (lines) total += lines.reduce((a, l) => a + (l.month >= monthOf(today) ? l.amount : 0), 0);
    else if (validDate(o.start_date) && o.start_date > today) total += wonValue(o);
  }
  return total;
}

// the Maintenance / Install and Enhancement / Net New filters
export function filterDeals(cfg, rows, { division = 'all', kind = 'all' }, isNew) {
  return rows.filter((o) => (division === 'all' || divisionOf(cfg, o) === division)
    && (kind === 'all' || (isNew(o) ? 'netnew' : 'enhancement') === kind));
}

// open / won / lost inside a set of deals. "other" is a status the config does not map.
export function split(cfg, rows, val = est) {
  const part = (f) => { const x = rows.filter(f); return { n: x.length, value: sum(x, val) }; };
  return {
    open: part((o) => isOpen(cfg, o)), won: part((o) => isWon(cfg, o)), lost: part((o) => isLost(cfg, o)),
    other: part((o) => !isOpen(cfg, o) && !isWon(cfg, o) && !isLost(cfg, o)),
  };
}

// won contracts renewing in the period: RenewalDate where Aspire has one, EndDate otherwise.
// Each row says which date it used.
export function renewalsIn(cfg, rows, p) {
  const out = [];
  for (const o of rows) {
    if (!isWon(cfg, o)) continue;
    const date = validDate(o.renewal_date) ? o.renewal_date : validDate(o.end_date) ? o.end_date : null;
    if (date && inPeriod(date, p)) out.push({ o, date, source: validDate(o.renewal_date) ? 'renewal' : 'end' });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : wonValue(b.o) - wonValue(a.o)));
}

// won work still to bill, by month, for the next n months from this one: each schedule line in its month, and
// unscheduled work in its start month. n counts the deals billing that month.
export function forecastByMonth(cfg, rows, today, n = 12) {
  const out = [];
  let m = monthOf(today);
  for (let i = 0; i < n; i++) { out.push({ month: m, n: 0, value: 0 }); m = addDays(monthEnd(m), 1); }
  const at = Object.fromEntries(out.map((b) => [b.month, b]));
  for (const o of rows) {
    if (!isWon(cfg, o)) continue;
    const lines = billingLines(o);
    if (lines) {
      const hit = new Set();
      for (const l of lines) if (at[l.month] && l.amount) { at[l.month].value += l.amount; hit.add(l.month); }
      for (const k of hit) at[k].n++;
    } else if (validDate(o.start_date) && o.start_date > today && at[monthOf(o.start_date)]) {
      at[monthOf(o.start_date)].n++; at[monthOf(o.start_date)].value += wonValue(o);
    }
  }
  return out;
}

// every deal lands in one row: a branch's roster reps, that branch's reps not on the roster, or no branch.
// The rows add up to the tile.
export function branchGroups(rows, branches) {
  const out = [];
  for (const b of branches) {
    const R = rows.filter((o) => o.branch === b);
    out.push({ key: `${b}|r`, branch: b, unassigned: false, rows: R.filter((o) => !o.unassigned) });
    const U = R.filter((o) => o.unassigned);
    if (U.length) out.push({ key: `${b}|u`, branch: b, unassigned: true, rows: U });
  }
  const none = rows.filter((o) => !o.branch || !branches.includes(o.branch));
  if (none.length) out.push({ key: '|n', branch: '', unassigned: false, rows: none });
  return out;
}

// the CRM's rep names behind a set of unassigned deals, biggest first
export function repBreakdown(rows, val = est) {
  const by = new Map();
  for (const o of rows) {
    const k = o.rep_name || '';
    const x = by.get(k) || { name: k, n: 0, value: 0 };
    x.n++; x.value += val(o);
    by.set(k, x);
  }
  return [...by.values()].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

// without branches, every deal lands on its rep's row, or one row for deals with no rep. Same shape as
// branchGroups, so the table and the drill-down read it the same way. The rows add up to the tile.
export function repGroups(rows, reps) {
  const out = reps.map((r) => ({ key: `m:${r.id}`, branch: r.full_name, person: true, unassigned: false, rows: rows.filter((o) => o.owner_member_id === r.id) }));
  const ids = new Set(reps.map((r) => r.id));
  const rest = rows.filter((o) => !ids.has(o.owner_member_id));
  if (rest.length) out.push({ key: 'm:', branch: '', person: false, unassigned: true, rows: rest });
  return out;
}

// typed deals whose stage moved forward inside the period, from their stage history. A move to a lost stage
// is not forward. The first stage a deal was created at is not a move.
export function advancedIn(cfg, rows, p) {
  const idx = (n) => cfg.stages.findIndex((s) => s.name === n);
  return rows.filter((o) => {
    const ev = [...(o.stage_events || [])].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    for (let i = 1; i < ev.length; i++) {
      const s = cfg.stages[idx(ev[i].stage)];
      if (s && s.status !== 'lost' && idx(ev[i].stage) > idx(ev[i - 1].stage) && inPeriod(ev[i].d, p)) return true;
    }
    return false;
  });
}
