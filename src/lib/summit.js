// The Summit tab's numbers, kept out of the view so they can be tested.
//   closed    contracts won in the period, at what they were won for
//   created   every deal created in the period, whatever its status now, at its estimate
//   forecast  won work that has not started yet, starting between tomorrow and the end of the period
// Every number reads the same deals the rest of the board reads, with the same test data left out.
import { isWon, isOpen, isLost, sum, createdOf, divisionOf } from './rules.js';
import { inPeriod, monthEnd } from './period.js';
import { validDate, addDays } from './format.js';

export const est = (o) => +(o.estimated ?? o.value) || 0;
const wonValue = (o) => +o.value || 0;

export const METRICS = {
  closed: { label: 'Closed contracts', value: wonValue, rows: (cfg, R, p) => R.filter((o) => isWon(cfg, o) && inPeriod(o.actual_close, p)) },
  created: { label: 'Pipeline created', value: est, rows: (cfg, R, p) => R.filter((o) => inPeriod(createdOf(o), p)) },
  forecast: { label: 'Forecast', value: wonValue, rows: (cfg, R, p, today) => R.filter((o) => isWon(cfg, o) && validDate(o.start_date) && o.start_date > today && o.start_date <= p.end) },
};
export const metricRows = (cfg, metric, R, p, today) => METRICS[metric].rows(cfg, R, p, today);
export const metricValue = (metric, rows) => sum(rows, METRICS[metric].value);

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

// won work not started yet, by start month, for the next n months from today
export function forecastByMonth(cfg, rows, today, n = 12) {
  const out = [];
  let m = `${today.slice(0, 7)}-01`;
  for (let i = 0; i < n; i++) { out.push({ month: m, n: 0, value: 0 }); m = addDays(monthEnd(m), 1); }
  for (const o of rows) {
    if (!isWon(cfg, o) || !validDate(o.start_date) || o.start_date <= today) continue;
    const b = out.find((x) => x.month === `${o.start_date.slice(0, 7)}-01`);
    if (b) { b.n++; b.value += wonValue(o); }
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
