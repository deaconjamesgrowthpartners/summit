// Deal and commit rules, driven by the workspace config.
import { validDate, addDays, daysBetween, money } from './format.js';

const NO_STAGE = { name: '', prob: 0, status: 'open', needs_close: false, bid: false, hold: false };

export const stageOf = (cfg, o) => cfg.stageBy[o.stage] || NO_STAGE;
export const prob = (cfg, o) => stageOf(cfg, o).prob;
export const weighted = (cfg, o) => (+o.value || 0) * prob(cfg, o);
export const isOpen = (cfg, o) => stageOf(cfg, o).status === 'open';
export const isWon = (cfg, o) => stageOf(cfg, o).status === 'won';
export const isLost = (cfg, o) => stageOf(cfg, o).status === 'lost';
export const bidOut = (cfg, o) => isOpen(cfg, o) && stageOf(cfg, o).bid;
export function isRecurring(cfg, o) {
  const c = cfg.catBy[o.category];
  return c ? c.recurring : !!o.recurring;
}
export const sum = (arr, f = (o) => +o.value || 0) => arr.reduce((a, o) => a + f(o), 0);

// green 100%+, yellow 70 to 99, red under 70
export function ryg(did, com) {
  if (!com) return did > 0 ? 'g' : 'n';
  const p = did / com;
  return p >= 1 ? 'g' : p >= 0.7 ? 'y' : 'r';
}

// what the board says a person did in a week, for measures marked auto
export function autoDid(cfg, opps, memberId, key) {
  const start = addDays(key, -6), end = key, nextStart = addDays(key, 1), nextEnd = addDays(key, 7);
  const inWeek = (d) => validDate(d) && d >= start && d <= end;
  const rows = opps.filter((o) => o.owner_member_id === memberId);
  const bids = rows.filter((o) => { const s = stageOf(cfg, o); return s.bid && !s.hold && s.status !== 'lost' && inWeek(o.bid_date); });
  const won = rows.filter((o) => isWon(cfg, o) && inWeek(o.actual_close || o.stage_date));
  const starts = rows.filter((o) => isWon(cfg, o) && validDate(o.start_date) && o.start_date >= nextStart && o.start_date <= nextEnd);
  const src = {
    bids_count: bids.length,
    bids_value: sum(bids),
    won_value: sum(won),
    starts_next_week_value: sum(starts),
  };
  const out = {};
  for (const m of cfg.measures) if (m.auto && m.auto in src) out[m.key] = src[m.auto];
  return out;
}

export const hasVal = (v) => v !== undefined && v !== null && v !== '';
export function didValue(c, auto, k) {
  if (c && c.actual && hasVal(c.actual[k])) return +c.actual[k];
  return auto[k] ?? 0;
}
export const comValue = (c, k) => (c ? +(c.committed?.[k]) || 0 : 0);

// everything wrong with a row. sev r = red flag, y = yellow
export function rowIssues(cfg, o, today, crm) {
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
  if (!isOpen(cfg, o) && !isWon(cfg, o)) return 'n';
  const iss = rowIssues(cfg, o, today, crm);
  if (iss.some((i) => i.sev === 'r')) return 'r';
  if (validDate(o.next_step_date) && daysBetween(today, o.next_step_date) <= 3) return 'y';
  return iss.length ? 'y' : 'g';
}

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
