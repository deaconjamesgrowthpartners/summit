// Demo adapter. Same surface as data/api.js, all in memory, nothing leaves the browser.
// Only bundled when VITE_DEMO=1. Production builds never include it.
//   ?mode=connected   Elevation as it runs on Aspire (?pipeline=aspire still works)
//   ?mode=csv         Elevation with deals from an uploaded file
//   ?mode=native      Elevation with typed deals (the default)
//   /29029, /deacon-james   the two workspaces with no CRM. ?as=joe, ?as=lisa (viewer), ?as=sourcer1, ?as=djlead
import { fixtures, ASPIRE_PIPELINE, noCrmFixtures } from './fixtures.js';
import { clock } from '../lib/time.js';
import { aspireToBoard } from '../data/pipeline.js';

// ?now=2026-09-29T22:30:00Z pins the demo clock, to check lock night
const q = new URLSearchParams(location.search);
const pinned = q.get('now');
if (pinned && !isNaN(Date.parse(pinned))) { const t0 = Date.parse(pinned), s0 = Date.now(); clock.now = () => new Date(t0 + Date.now() - s0); }

export const demo = true;
const db = fixtures(clock.now());
const MODE = q.get('pipeline') === 'aspire' ? 'connected' : ['connected', 'csv', 'native'].includes(q.get('mode')) ? q.get('mode') : 'native';
const ELEV = db.workspaces[0];
if (MODE !== 'native') {
  db.workspaces.forEach((w) => Object.assign(w, { pipeline: ASPIRE_PIPELINE, crm_source: MODE === 'connected' ? 'aspire' : null,
    goal_tiles: w.goal_tiles.map((t) => (t.key === 'newMaint' ? { ...t, start: 'newMaintStart' } : t)) }));
}
const nc = noCrmFixtures(clock.now());
db.workspaces.push(...nc.workspaces);
db.members.push(...nc.members);
db.commits.push(...nc.commits);

// every workspace's source and deals, the way deal_sources and deal_board return them
const boardFromOpp = (o) => ({ ...o, deal_id: o.id, source_mode: 'native', value_estimated: o.value, won_date: o.actual_close, external_number: o.crm_ref,
  member_id: o.owner_member_id, created_date: (o.created_at || '').slice(0, 10) || null });
const nowIso = () => clock.now().toISOString();
const ws = {
  [ELEV.id]: {
    source: MODE === 'connected' ? { id: 1, mode: 'connected', connector: 'aspire', label: 'Aspire', mapping: {} }
      : MODE === 'csv' ? { id: 2, mode: 'csv', connector: null, label: 'CSV upload', mapping: { external_id: 'Opportunity ID', account: 'Property', job: 'Opportunity', rep_name: 'Sales Rep', stage: 'Status', value_estimated: 'Estimated $', value_won: 'Won $', branch: 'Branch', division: 'Division', close_date: 'Close', start_date: 'Start', won_date: 'Won', created_date: 'Created' } }
      : { id: 3, mode: 'native', connector: null, label: 'Summit', mapping: {} },
    deals: MODE === 'native' ? db.opps.map(boardFromOpp) : db.pipeline.map((r) => ({ ...aspireToBoard(r), deal_id: `d${r.opportunity_id}`, source_mode: MODE, created_at: nowIso() })),
    events: [], accounts: [], changes: [],
    sync: MODE === 'connected' ? db.sync : MODE === 'csv' ? { runs: [{ id: 9, started_at: db.sync.runs[0].started_at, finished_at: db.sync.runs[0].finished_at, trigger: 'upload', mode: 'full', status: 'ok', file_name: 'aspire-export-oct.csv', run_by: db.members[0].user_id, rows_pulled: 132, rows_inserted: 4, rows_updated: 9, rows_unchanged: 119, rows_removed: 0, errors: [], notes: [] }], unmatched: db.sync.unmatched } : null,
  },
};
for (const w of nc.workspaces) {
  ws[w.id] = { source: { id: w.slug === '29029' ? 29 : 30, mode: 'native', connector: null, label: 'Summit', mapping: {} },
    deals: nc.deals.filter((x) => x.workspace_id === w.id), events: nc.events.filter((e) => nc.deals.some((x) => x.deal_id === e.deal_id && x.workspace_id === w.id)),
    accounts: [], changes: [], sync: null };
}

const listeners = [];
const as = q.get('as') || 'leader';
const me = db.members.find((m) => m.email.includes(`+${as}@`)) || db.members[0];
const admin = q.get('admin') === '1';
let user = { id: me.user_id, email: me.email };
let authCb = () => {};
const clone = (x) => JSON.parse(JSON.stringify(x));
const emit = (table, type, row) => listeners.forEach((l) => setTimeout(() => l(table, type, clone(row), null), 30));
const meIn = (wsId) => db.members.find((m) => m.workspace_id === wsId && m.user_id === user.id && m.active) || null;
const denied = () => ({ code: '42501', message: 'row-level security' });

export async function session() { return user ? { user } : null; }
export function onAuth(cb) { authCb = cb; }
export async function sendCode() {}
export async function verifyCode() { user = { id: me.user_id, email: me.email }; authCb({ user }); return { user }; }
export async function signOut() { user = null; authCb(null); }

export async function workspaces() {
  return db.workspaces.filter((w) => admin || meIn(w.id)).map(({ id, slug, name }) => ({ id, slug, name }));
}
export async function workspace(slug) { return clone(db.workspaces.find((w) => w.slug === slug) || null); }
export async function isAdmin() { return admin; }
export async function linkMember() { return 0; }
export const linkError = null;
export async function source(wsId) { return clone(ws[wsId]?.source || null); }
export async function load(wsId, _since, src = {}) {
  const W = ws[wsId];
  const native = W.source.mode === 'native';
  return clone({
    members: db.members.filter((m) => m.workspace_id === wsId), deals: W.deals.filter((x) => !x.removed), shape: 'board', events: native ? W.events : null,
    commits: db.commits.filter((c) => (c.workspace_id || ELEV.id) === wsId), goals: wsId === ELEV.id ? db.goals : [],
    accounts: wsId === ELEV.id ? db.accounts : [], sync: W.sync, targets: wsId === ELEV.id ? db.targets : [],
    tracking: src.mode !== 'native' ? db.tracking : null, dealAccounts: W.accounts, changes: W.changes,
  });
}
export async function syncLog(wsId) { return clone(ws[wsId]?.sync || null); }
export async function recentChanges(wsId) { return clone((ws[wsId]?.changes || []).slice(0, 40)); }
export async function stageEvents(wsId) { return clone(ws[wsId]?.events || []); }
export async function runSync() { throw new Error('the demo does not reach Aspire'); }
export function subscribe(_ws, onChange, onStatus) {
  listeners.push(onChange);
  setTimeout(() => onStatus && onStatus('SUBSCRIBED'), 10);
  return () => listeners.splice(listeners.indexOf(onChange), 1);
}

/* ---------- typed deals: the same rules as 014's policies ---------- */
function canWrite(wsId, owner) {
  if (admin) return true;
  const m = meIn(wsId);
  if (!m || ws[wsId].source.mode !== 'native') return false;
  return m.role === 'leader' || (m.role === 'rep' && owner === m.id);
}
function log(W, deal, action, before, after) {
  const m = meIn(deal.workspace_id);
  for (const k of Object.keys(after)) {
    if (['id', 'workspace_id', 'updated_at', 'stage_date'].includes(k) || before[k] === after[k]) continue;
    W.changes.unshift({ id: Date.now() + Math.random(), deal_id: deal.id, workspace_id: deal.workspace_id, changed_at: nowIso(), changed_on: nowIso().slice(0, 10),
      member_id: m?.id || null, action, field: k, old_value: before[k] ?? null, new_value: after[k] ?? null });
  }
}
export async function insertDeal(row) {
  const W = ws[row.workspace_id];
  if (!canWrite(row.workspace_id, row.owner_member_id)) throw denied();
  const r = { ...row, deal_id: row.id, member_id: row.owner_member_id, created_at: nowIso(), created_date: nowIso().slice(0, 10), updated_at: nowIso() };
  W.deals.push(r);
  if (r.stage) W.events.push({ deal_id: r.id, d: r.created_date, stage: r.stage });
  log(W, r, 'created', {}, row);
  emit('deals', 'INSERT', r);
  return clone(r);
}
export async function updateDeal(id, patch) {
  const W = Object.values(ws).find((x) => x.deals.some((o) => (o.deal_id || o.id) === id));
  const r = W?.deals.find((o) => (o.deal_id || o.id) === id);
  if (!r) throw { code: 'PGRST116' };
  if (!canWrite(r.workspace_id, r.owner_member_id ?? r.member_id) || !canWrite(r.workspace_id, patch.owner_member_id ?? r.owner_member_id ?? r.member_id)) throw denied();
  const before = { ...r };
  Object.assign(r, patch, { updated_at: nowIso() });
  if ('owner_member_id' in patch) r.member_id = patch.owner_member_id;
  log(W, { ...r, id }, 'updated', before, patch);
  emit('deals', 'UPDATE', { ...r, id });
  return clone({ ...r, id });
}
export async function insertDealAccount(row) {
  const W = ws[row.workspace_id];
  if (W.accounts.some((a) => a.name.trim().toLowerCase() === row.name.trim().toLowerCase())) throw { code: '23505', message: 'duplicate' };
  const a = { id: `acct-${W.accounts.length + 1}`, ...row };
  W.accounts.push(a);
  return clone(a);
}

/* ---------- CSV upload: the same arithmetic as 013, in the browser ---------- */
const get = (rec, spec) => (Array.isArray(spec) ? spec.map((f) => rec[f]).find((v) => String(v ?? '').trim() !== '') : rec[spec]);
const numOf = (t) => { const s = String(t ?? '').replace(/[$,\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(s) ? +s : null; };
const dateOf = (t) => {
  const s = String(t ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
};
function mapRow(mapping, rec) {
  const out = {};
  for (const [f, spec] of Object.entries(mapping)) {
    let v = get(rec, spec);
    if (f.startsWith('value_')) v = numOf(v); else if (f.endsWith('_date')) v = dateOf(v); else if (v !== undefined) v = String(v);
    if (f === 'external_id') v = v && v.trim() ? v.trim() : null;
    if (v !== null && v !== undefined) out[f] = v;
  }
  return out;
}
function leadsCsv(wsId) {
  const m = meIn(wsId);
  if (!admin && (!m || m.role !== 'leader')) throw new Error('Only a leader can upload deals');
  if (ws[wsId].source.mode !== 'csv') throw new Error('This workspace does not take uploads');
}
export async function csvPreview(wsId, rows, mapping) {
  leadsCsv(wsId);
  const W = ws[wsId], m = mapping || W.source.mapping;
  const byId = new Map(), count = {};
  let noid = 0;
  rows.forEach((rec) => { const d = mapRow(m, rec); if (!d.external_id) { noid++; return; } count[d.external_id] = (count[d.external_id] || 0) + 1; byId.set(d.external_id, d); });
  const fields = Object.keys(m).filter((k) => k !== 'external_id').sort();
  const added = [], changes = [];
  let same = 0, back = 0;
  for (const [ext, d] of byId) {
    const cur = W.deals.find((x) => x.external_id === ext);
    if (!cur) { added.push({ external_id: ext, account: d.account, job: d.job, stage: d.stage, value: d.value_estimated ?? null }); continue; }
    const diff = fields.filter((k) => String(cur[k] ?? '') !== String(d[k] ?? '')).map((k) => ({ field: k, from: cur[k] ?? null, to: d[k] ?? null }));
    if (cur.removed) back++;
    if (diff.length || cur.removed) changes.push({ external_id: ext, account: cur.account || '', back: !!cur.removed, fields: diff }); else same++;
  }
  const missing = W.deals.filter((x) => !x.removed && !byId.has(x.external_id));
  return clone({ rows: rows.length, skipped_no_id: noid, duplicates: Object.entries(count).filter(([, n]) => n > 1).map(([external_id, n]) => ({ external_id, rows: n })),
    added: added.length, added_sample: added.slice(0, 50), changed: changes.length, restored: back, changes: changes.slice(0, 200), unchanged: same,
    missing: missing.length, missing_rows: missing.slice(0, 2000).map((x) => ({ external_id: x.external_id, account: x.account, job: x.job, stage: x.stage, value: x.value_estimated, rep: x.rep_name })),
    fields, mapping: m });
}
export async function csvApply(wsId, rows, remove, fileName, mapping) {
  const p = await csvPreview(wsId, rows, mapping);
  const W = ws[wsId];
  if (mapping) W.source.mapping = mapping;
  const m = mapping || W.source.mapping;
  const seen = new Set();
  for (const rec of rows) {
    const d = mapRow(m, rec);
    if (!d.external_id) continue;
    seen.add(d.external_id);
    const cur = W.deals.find((x) => x.external_id === d.external_id);
    if (cur) { Object.assign(cur, d); cur.removed = false; }
    else W.deals.push({ ...d, deal_id: `d-up-${d.external_id}`, workspace_id: wsId, source_mode: 'csv', created_at: nowIso() });
  }
  let n = 0;
  for (const x of W.deals) if (!x.removed && remove.includes(x.external_id) && !seen.has(x.external_id)) { x.removed = true; n++; }
  const run = { id: Date.now(), started_at: nowIso(), finished_at: nowIso(), trigger: 'upload', mode: 'full', status: 'ok', file_name: fileName, run_by: user.id,
    rows_pulled: rows.length, rows_inserted: p.added, rows_updated: p.changed, rows_unchanged: p.unchanged, rows_removed: n, errors: [], notes: [] };
  W.sync = { runs: [run, ...(W.sync?.runs || [])], unmatched: W.sync?.unmatched || [] };
  return clone(run);
}

/* ---------- the rest, as before ---------- */
function guardOpp(row) {
  if (me.role === 'leader') return;
  if (row.owner_member_id !== me.id) throw denied();
}
export async function insertOpp(row) { return insertDeal(row); }
export async function updateOpp(id, patch) { return updateDeal(id, patch); }
export async function updateAccount(id, patch) {
  const r = db.accounts.find((a) => a.id === id);
  if (!r) throw { code: 'PGRST116' };
  guardOpp(r);
  Object.assign(r, patch); emit('accounts', 'UPDATE', r); return clone(r);
}
export async function insertCommit(row) {
  const r = { ...row, submitted_at: nowIso(), updated_at: nowIso(), late: false, accepted_by: null };
  db.commits.push(r); emit('commits', 'INSERT', r); return clone(r);
}
export async function updateCommit(id, patch) {
  const r = db.commits.find((c) => c.id === id);
  if (!r) throw { code: 'PGRST116' };
  Object.assign(r, patch, { updated_at: nowIso() }); emit('commits', 'UPDATE', r); return clone(r);
}
export async function saveTarget(row, amount) {
  if (me.role !== 'leader') throw denied();
  const same = (t) => ['branch', 'month', 'metric', 'division', 'kind'].every((k) => t[k] === row[k]);
  db.targets = db.targets.filter((t) => !same(t));
  if (amount !== null) db.targets.push({ ...row, amount });
  return amount === null ? null : clone({ ...row, amount });
}
export async function saveGoals(wsId, period, values) {
  let g = db.goals.find((x) => x.period === period);
  if (!g) { g = { workspace_id: wsId, period, values }; db.goals.push(g); } else g.values = values;
  emit('goals', 'UPDATE', g); return clone(g);
}
