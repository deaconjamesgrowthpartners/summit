// Demo adapter. Same surface as data/api.js, all in memory, nothing leaves the browser.
// Only bundled when VITE_DEMO=1. Production builds never include it.
import { fixtures } from './fixtures.js';
import { clock } from '../lib/time.js';

// ?now=2026-09-29T22:30:00Z pins the demo clock, to check lock night
const pinned = new URLSearchParams(location.search).get('now');
if (pinned && !isNaN(Date.parse(pinned))) { const t0 = Date.parse(pinned), s0 = Date.now(); clock.now = () => new Date(t0 + Date.now() - s0); }

export const demo = true;
const db = fixtures(clock.now());
const listeners = [];
const as = new URLSearchParams(location.search).get('as') || 'leader';
const me = db.members.find((m) => m.email.includes(`+${as}@`)) || db.members[0];
let user = { id: me.user_id, email: me.email };
let authCb = () => {};
const clone = (x) => JSON.parse(JSON.stringify(x));
const emit = (table, type, row) => listeners.forEach((l) => setTimeout(() => l(table, type, clone(row), null), 30));

export async function session() { return user ? { user } : null; }
export function onAuth(cb) { authCb = cb; }
export async function sendCode() {}
export async function verifyCode() { user = { id: me.user_id, email: me.email }; authCb({ user }); return { user }; }
export async function signOut() { user = null; authCb(null); }

export async function workspaces() { return db.workspaces.map(({ id, slug, name }) => ({ id, slug, name })); }
export async function workspace(slug) { return clone(db.workspaces.find((w) => w.slug === slug) || null); }
export async function isAdmin() { return false; }
export async function load() { return clone({ members: db.members, opps: db.opps, commits: db.commits, goals: db.goals }); }
export function subscribe(_ws, onChange, onStatus) {
  listeners.push(onChange);
  setTimeout(() => onStatus && onStatus('SUBSCRIBED'), 10);
  return () => listeners.splice(listeners.indexOf(onChange), 1);
}

function guardOpp(row) {
  if (me.role === 'leader') return;
  if (row.owner_member_id !== me.id) throw { code: '42501', message: 'row-level security' };
}
export async function insertOpp(row) {
  guardOpp(row);
  const r = { ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  db.opps.push(r); emit('opps', 'INSERT', r); return clone(r);
}
export async function updateOpp(id, patch) {
  const r = db.opps.find((o) => o.id === id);
  if (!r) throw { code: 'PGRST116' };
  guardOpp(r); guardOpp({ ...r, ...patch });
  Object.assign(r, patch, { updated_at: new Date().toISOString() }); emit('opps', 'UPDATE', r); return clone(r);
}
export async function insertCommit(row) {
  const r = { ...row, submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(), late: false, accepted_by: null };
  db.commits.push(r); emit('commits', 'INSERT', r); return clone(r);
}
export async function updateCommit(id, patch) {
  const r = db.commits.find((c) => c.id === id);
  if (!r) throw { code: 'PGRST116' };
  Object.assign(r, patch, { updated_at: new Date().toISOString() }); emit('commits', 'UPDATE', r); return clone(r);
}
export async function saveGoals(wsId, period, values) {
  let g = db.goals.find((x) => x.period === period);
  if (!g) { g = { workspace_id: wsId, period, values }; db.goals.push(g); } else g.values = values;
  emit('goals', 'UPDATE', g); return clone(g);
}
