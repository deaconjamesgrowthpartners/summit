// Deal and commit rules, driven by the workspace config.
import { validDate, addDays, daysBetween, money } from './format.js';

const NO_STAGE = { name: '', prob: 0, status: 'open', needs_close: false, bid: false, hold: false };
// a CRM status the workspace config does not list: never open, won or lost, never weighted
const UNKNOWN = { name: '', prob: 0, status: 'unknown', needs_close: false, bid: false, hold: false };

export const stageOf = (cfg, o) => cfg.stageBy[o.stage] || (o.src === 'aspire' ? UNKNOWN : NO_STAGE);
export const prob = (cfg, o) => stageOf(cfg, o).prob;
export const weighted = (cfg, o) => (+o.value || 0) * prob(cfg, o);
export const isOpen = (cfg, o) => stageOf(cfg, o).status === 'open';
export const isWon = (cfg, o) => stageOf(cfg, o).status === 'won';
export const isLost = (cfg, o) => stageOf(cfg, o).status === 'lost';
export const isUnknown = (cfg, o) => stageOf(cfg, o).status === 'unknown';
export const bidOut = (cfg, o) => isOpen(cfg, o) && stageOf(cfg, o).bid;
export function isRecurring(cfg, o) {
  const c = cfg.catBy[o.category];
  return c ? c.recurring : !!o.recurring;
}
// the day a deal was created: Aspire's CreatedDateTime, or when it was typed into Summit
export const createdOf = (o) => o.created_date || (typeof o.created_at === 'string' && validDate(o.created_at.slice(0, 10)) ? o.created_at.slice(0, 10) : null);
export const sum = (arr, f = (o) => +o.value || 0) => arr.reduce((a, o) => a + f(o), 0);

// green 100%+, yellow 70 to 99, red under 70
export function ryg(did, com) {
  if (!com) return did > 0 ? 'g' : 'n';
  const p = did / com;
  return p >= 1 ? 'g' : p >= 0.7 ? 'y' : 'r';
}

// bids from Aspire: every opportunity created in the range, whatever its status now. A bid that won
// in nine days still counts as a bid that week. Split open / won / lost so the tile can say so.
export function bidsIn(cfg, rows, start, end) {
  const B = rows.filter((o) => { const d = createdOf(o); return !!d && d >= start && d <= end; });
  const est = (o) => +(o.estimated ?? o.value) || 0;
  const part = (f) => { const x = B.filter(f); return { n: x.length, value: sum(x, est) }; };
  return { n: B.length, value: sum(B, est), rows: B, open: part((o) => isOpen(cfg, o)), won: part((o) => isWon(cfg, o)), lost: part((o) => isLost(cfg, o)) };
}

// what the board says a set of deals did in a week, for measures marked auto
export function autoDidRows(cfg, rows, key) {
  const start = addDays(key, -6), end = key, nextStart = addDays(key, 1), nextEnd = addDays(key, 7);
  const inWeek = (d) => validDate(d) && d >= start && d <= end;
  const won = rows.filter((o) => isWon(cfg, o) && inWeek(o.actual_close || o.stage_date));
  const starts = rows.filter((o) => isWon(cfg, o) && validDate(o.start_date) && o.start_date >= nextStart && o.start_date <= nextEnd);
  let bidsN, bidsV;
  if (cfg.pipelineSource === 'aspire') {
    // Aspire sends no bid-sent date. A bid is any opportunity created that week.
    const b = bidsIn(cfg, rows, start, end);
    bidsN = b.n; bidsV = b.value;
  } else {
    const bids = rows.filter((o) => { const s = stageOf(cfg, o); return s.bid && !s.hold && s.status !== 'lost' && inWeek(o.bid_date); });
    bidsN = bids.length; bidsV = sum(bids);
  }
  const src = { bids_count: bidsN, bids_value: bidsV, won_value: sum(won), starts_next_week_value: sum(starts) };
  const out = {};
  for (const m of cfg.measures) if (m.auto && m.auto in src) out[m.key] = src[m.auto];
  return out;
}
export const autoDid = (cfg, opps, memberId, key) => autoDidRows(cfg, opps.filter((o) => o.owner_member_id === memberId), key);

// where an auto number comes from, said on the screen. Bids from Aspire read differently than the
// typed bids reps are used to, so the tile says where they come from.
export const isBidMeasure = (m) => m.auto === 'bids_count' || m.auto === 'bids_value';
export const autoSource = (cfg, m) => (cfg.pipelineSource === 'aspire' && isBidMeasure(m) ? `from ${cfg.crmLabel}` : 'from board');
export const bidNote = (cfg) => `Bids count every ${cfg.crmLabel} opportunity created that week, open, won or lost. Not typed. A typed number still overrides.`;

// a goal tile's window: from its start (Jan 1 of the goal period if unset) to its deadline
export function goalWindow(t, g, period) {
  const deadline = t.deadline && validDate(g[t.deadline]) ? g[t.deadline] : null;
  const start = t.start && validDate(g[t.start]) ? g[t.start] : `${String(period).slice(0, 4)}-01-01`;
  return { start, deadline };
}

// one property, however Aspire spells it: PropertyID when there is one, else the name
export const propertyKey = (o) => (o.property_id ? `id:${o.property_id}` : `name:${String(o.account || '').trim().toLowerCase()}`);

// is this deal on a property new to the book? With new_maintenance_basis "new_properties" (the default
// for CRM deals), a property is new when none of its deals was won recurring work before the window
// opened. History is every deal the workspace holds, whatever the screen's scope. A won recurring
// deal with no won date counts as history, since it cannot be placed inside the window.
export function newPropertyTest(cfg, history, start) {
  if (cfg.newMaintenanceBasis !== 'new_properties') return () => true;
  const before = new Set();
  for (const o of history) {
    if (!isWon(cfg, o) || !isRecurring(cfg, o)) continue;
    if (!validDate(o.actual_close) || o.actual_close < start) before.add(propertyKey(o));
  }
  return (o) => !before.has(propertyKey(o));
}

// actual for a goal tile, from the board or typed in by leadership. A won_recurring tile with a
// deadline counts recurring work won inside its window, on properties new to the book unless the
// config says all_recurring. Without a deadline, recurring work signed this year.
export function goalDetail(cfg, t, g, rows, wonThisYear, period, history = rows) {
  if (t.source !== 'won_recurring') return { actual: +g[t.actual] || 0 };
  const { start, deadline } = goalWindow(t, g, period);
  if (!deadline) return { actual: sum(wonThisYear.filter((o) => isRecurring(cfg, o))) };
  const isNew = newPropertyTest(cfg, history, start);
  const inWindow = rows.filter((o) => isWon(cfg, o) && isRecurring(cfg, o) && (o.actual_close
    ? o.actual_close >= start && o.actual_close <= deadline
    : o.src !== 'aspire'));
  const fresh = inWindow.filter(isNew);
  return {
    actual: sum(fresh),
    properties: new Set(fresh.map(propertyKey)).size,
    renewals: sum(inWindow) - sum(fresh),
    basis: cfg.newMaintenanceBasis,
    start,
    isNew,
  };
}
export const goalActual = (...a) => goalDetail(...a).actual;

// Maintenance or Install: maintenance is the recurring work, install is everything else
export const divisionOf = (cfg, o) => (isRecurring(cfg, o) ? 'maintenance' : 'install');

// Enhancement or Net New, for every division. A deal is net new when its property had no won deal,
// in any division, before this one: before its won date when won, before it was created otherwise.
// A won deal with no won date counts as history from the start. History is every deal the workspace
// holds, whatever the screen's scope.
export function netNewTest(cfg, history) {
  const won = new Map();
  for (const o of history) {
    if (!isWon(cfg, o)) continue;
    const k = propertyKey(o);
    if (!won.has(k)) won.set(k, []);
    won.get(k).push({ id: o.id, d: validDate(o.actual_close) ? o.actual_close : '0000-00-00' });
  }
  return (o) => {
    const ref = isWon(cfg, o) ? (validDate(o.actual_close) ? o.actual_close : '0000-00-00') : (createdOf(o) || '9999-12-31');
    return !(won.get(propertyKey(o)) || []).some((x) => x.id !== o.id && x.d < ref);
  };
}

// win rate, by the workspace's rule. "properties": each property once, won if any of its deals was
// won, lost if it only lost. Renewals and change orders do not stack up wins. "off": no tile.
export function winRateOf(cfg, won, lost) {
  if (cfg.winRate === 'off') return null;
  if (cfg.winRate === 'properties') {
    const key = (o) => String(o.account || '').trim().toLowerCase();
    const w = new Set(won.map(key)), l = new Set(lost.map(key).filter((k) => !w.has(k)));
    return { w: w.size, l: l.size, unit: 'properties' };
  }
  return { w: won.length, l: lost.length, unit: '' };
}

export const hasVal = (v) => v !== undefined && v !== null && v !== '';
export function didValue(c, auto, k) {
  if (c && c.actual && hasVal(c.actual[k])) return +c.actual[k];
  return auto[k] ?? 0;
}
export const comValue = (c, k) => (c ? +(c.committed?.[k]) || 0 : 0);

// an Aspire deal: only what can be fixed in Aspire, and only for live work. Open deals, deals
// with a status the config does not know, and work won this year. Old won and lost work stays quiet.
function aspireIssues(cfg, o, today) {
  const iss = [];
  const s = stageOf(cfg, o), crm = cfg.crmLabel;
  const thisYear = isWon(cfg, o) && validDate(o.actual_close) && o.actual_close.slice(0, 4) === today.slice(0, 4);
  if (!o.status_known) iss.push({ t: o.status_name ? `${crm} status not mapped: ${o.status_name}` : `No status in ${crm}`, f: 'stage', sev: 'y' });
  if (o.unassigned && (isOpen(cfg, o) || isUnknown(cfg, o) || thisYear)) iss.push({ t: `${crm} rep not on the roster`, f: 'owner', sev: 'y' });
  if (isOpen(cfg, o)) {
    if (validDate(o.close_date) && o.close_date < today) iss.push({ t: 'Expected close is in the past', f: 'close_date', sev: 'r' });
    if (s.bid && !validDate(o.start_date)) iss.push({ t: 'Bid sent, no target start date', f: 'start_date', sev: 'r' });
    if (s.needs_close && !validDate(o.close_date)) iss.push({ t: 'No expected close date', f: 'close_date', sev: 'y' });
    if (!(+o.value)) iss.push({ t: 'No estimated value', f: 'value', sev: 'y' });
  }
  if (thisYear && !validDate(o.start_date)) iss.push({ t: 'Won with no start date (cash forecast blind)', f: 'start_date', sev: 'y' });
  return iss;
}

// everything wrong with a row. sev r = red flag, y = yellow
export function rowIssues(cfg, o, today, crm) {
  if (o.src === 'aspire') return aspireIssues(cfg, o, today);
  const iss = [];
  const s = stageOf(cfg, o);
  if (isOpen(cfg, o)) {
    if (validDate(o.close_date) && o.close_date < today) iss.push({ t: 'Expected close is in the past', f: 'close_date', sev: 'r' });
    if (s.bid && !validDate(o.start_date)) iss.push({ t: 'Bid sent, no target start date', f: 'start_date', sev: 'r' });
    if (s.needs_close && !validDate(o.close_date)) iss.push({ t: 'No expected close date', f: 'close_date', sev: 'y' });
    if (!o.next_step) iss.push({ t: 'No next step', f: 'next_step', sev: 'y' });
    if (validDate(o.next_step_date) && o.next_step_date < today) iss.push({ t: 'Next step past due', f: 'next_step_date', sev: 'r' });
    if (validDate(o.last_activity) && daysBetween(o.last_activity, today) > 14) iss.push({ t: 'No touch in 14+ days', f: 'last_activity', sev: 'r' });
    if (!(+o.value)) iss.push({ t: 'No estimated value', f: 'value', sev: 'y' });
  }
  if (isWon(cfg, o)) {
    if (validDate(o.start_date) && o.start_date < today && !o.installed) iss.push({ t: 'Start date passed, not marked installed', f: 'installed', sev: 'r' });
    if (!validDate(o.start_date)) iss.push({ t: 'Won with no start date (cash forecast blind)', f: 'start_date', sev: 'y' });
  }
  if (crm && o.crm_ref && crm[o.crm_ref]) {
    const a = crm[o.crm_ref];
    if (isWon(cfg, o) && a.status && !/won|sold|signed|closed won/i.test(a.status)) iss.push({ t: `Won here, ${cfg.crmLabel} says ${a.status}`, f: 'stage', sev: 'r', crm: true });
    if (a.value && +o.value && Math.abs(a.value - o.value) / a.value > 0.1) iss.push({ t: `$ off vs ${cfg.crmLabel} (${money(a.value)})`, f: 'value', sev: 'r', crm: true });
  }
  return iss;
}

export function flag(cfg, o, today, crm) {
  if (!isOpen(cfg, o) && !isWon(cfg, o)) return isUnknown(cfg, o) ? 'y' : 'n';
  const iss = rowIssues(cfg, o, today, crm);
  if (iss.some((i) => i.sev === 'r')) return 'r';
  if (validDate(o.next_step_date) && daysBetween(today, o.next_step_date) <= 3) return 'y';
  return iss.length ? 'y' : 'g';
}

// an account in the book: what is wrong with it and how loud to say it.
// red: satisfaction marked red, or the last audit is past the window.
// yellow: satisfaction marked yellow, or no audit on record.
export function bookIssues(cfg, a, today) {
  const bk = cfg.book;
  if (!bk) return [];
  const iss = [];
  const lvl = bk.levels.find((l) => l.value === a.satisfaction);
  if (a.satisfaction && bk.risk.includes(a.satisfaction)) iss.push({ t: `Satisfaction ${a.satisfaction}`, f: 'satisfaction', sev: lvl && lvl.color === 'r' ? 'r' : 'y' });
  if (!validDate(a.last_audit)) iss.push({ t: 'No audit on record', f: 'last_audit', sev: 'y' });
  else if (daysBetween(a.last_audit, today) > bk.audit_days) iss.push({ t: `Last audit over ${bk.audit_days} days`, f: 'last_audit', sev: 'r' });
  return iss;
}
export function bookFlag(cfg, a, today) {
  const iss = bookIssues(cfg, a, today);
  return iss.some((i) => i.sev === 'r') ? 'r' : iss.length ? 'y' : 'g';
}
export const atRisk = (cfg, a, today) => bookIssues(cfg, a, today).length > 0;

// parse a pasted CRM export: id, status, value. tab or comma separated
export function parseCrm(txt) {
  const map = {};
  let n = 0;
  txt.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const parts = line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => s.replace(/^"|"$/g, '').trim());
    if (i === 0 && /opp|status|id/i.test(line) && !/\d{3,}/.test(parts[0])) return;
    if (parts.length < 2 || !parts[0]) return;
    map[parts[0]] = { status: parts[1] || '', value: +String(parts[2] || '').replace(/[^0-9.]/g, '') || 0 };
    n++;
  });
  return { map, n };
}
