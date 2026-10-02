// The Week / Month / Quarter / Year toggle. Week is Summit's week (the lock week, Wed to Tue by
// default), so Summit, The Climb and the commit lock always agree. Month, Quarter and Year are
// calendar periods in the workspace clock.
import { addDays, iso, daysBetween, fmtDate } from './format.js';

export const PERIODS = [['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const monthStart = (d) => `${d.slice(0, 7)}-01`;
const nextMonth = (m) => { const y = +m.slice(0, 4), mo = +m.slice(5, 7); return mo === 12 ? iso(y + 1, 1, 1) : iso(y, mo + 1, 1); };
export const monthEnd = (m) => addDays(nextMonth(m), -1);
export const monthLabel = (m, short = false) => `${(short ? MONTHS[+m.slice(5, 7) - 1].slice(0, 3) : MONTHS[+m.slice(5, 7) - 1])} ${m.slice(0, 4)}`;

// the period containing today. w is weekInfo(): the week on screen runs w.start to w.key.
export function periodRange(kind, w) {
  const t = w.today, y = +t.slice(0, 4), m = +t.slice(5, 7);
  if (kind === 'week') return { kind, start: w.start, end: w.key, label: `Week of ${fmtDate(w.start)} to ${fmtDate(w.key)}` };
  if (kind === 'quarter') {
    const q = Math.floor((m - 1) / 3), start = iso(y, q * 3 + 1, 1);
    return { kind, start, end: addDays(q === 3 ? iso(y + 1, 1, 1) : iso(y, q * 3 + 4, 1), -1), label: `Q${q + 1} ${y}` };
  }
  if (kind === 'year') return { kind, start: iso(y, 1, 1), end: iso(y, 12, 31), label: String(y) };
  const start = iso(y, m, 1);
  return { kind: 'month', start, end: monthEnd(start), label: monthLabel(start) };
}
export const inPeriod = (d, p) => typeof d === 'string' && d.length >= 10 && d.slice(0, 10) >= p.start && d.slice(0, 10) <= p.end;

// the months a period touches, with the share of each month's days inside it
export function monthsIn(p) {
  const out = [];
  for (let m = monthStart(p.start); m <= p.end; m = nextMonth(m)) {
    const e = monthEnd(m), s0 = p.start > m ? p.start : m, e0 = p.end < e ? p.end : e;
    out.push({ month: m, share: (daysBetween(s0, e0) + 1) / (daysBetween(m, e) + 1) });
  }
  return out;
}

// the lock weeks whose closing day falls in the period, up to the week on screen. Week mode is the
// scored week alone, the way The Climb has always read.
export function weeksIn(p, w) {
  if (p.kind === 'week') return [w.scoreKey];
  const out = [];
  for (let k = w.key; k >= p.start; k = addDays(k, -7)) if (k <= p.end) out.push(k);
  return out.reverse();
}

// a target for a period: each month's target times the share of that month inside the period.
// branch null is the whole company: the company row for a month when there is one, else the branch
// rows added up. null when no month has a target, so the tile says "no target set", never 0%.
export function targetFor(targets, { metric, division = 'all', kind = 'all', branch = null }, p) {
  let total = 0, found = false;
  for (const { month, share } of monthsIn(p)) {
    const rows = targets.filter((t) => t.month === month && t.metric === metric && t.division === division && t.kind === kind);
    let amt = null;
    if (branch === null) {
      const co = rows.find((t) => t.branch === '');
      if (co) amt = +co.amount;
      else if (rows.length) amt = rows.reduce((a, t) => a + (+t.amount || 0), 0);
    } else {
      const b = rows.find((t) => t.branch === branch);
      if (b) amt = +b.amount;
    }
    if (amt !== null) { found = true; total += amt * share; }
  }
  return found ? total : null;
}
