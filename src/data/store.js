// App state and the selectors every screen shares.
import { weekInfo } from '../lib/time.js';

export const S = {
  api: null,
  cfg: null,          // normalized workspace
  user: null,         // auth user
  admin: false,
  me: null,           // my members row in this workspace, if any
  members: [],
  opps: {},           // id -> row
  commits: {},        // `${member_id}|${week_key}` -> row
  goalsRow: null,     // { period, values }
  view: 'summit',
  scope: 'company',   // 'company' | 'branch:<name>' | 'member:<id>'
  filters: {},
  sort: {},
  crm: null,          // pasted CRM export, id -> { status, value }
  live: 'connecting',
};

export const wk = () => weekInfo(S.cfg);
export const ckey = (memberId, week) => `${memberId}|${week}`;
export const commitFor = (memberId, week) => S.commits[ckey(memberId, week)] || null;

export const isLeader = () => S.admin || (S.me && S.me.role === 'leader' && S.me.active);
export const memberById = (id) => S.members.find((m) => m.id === id) || null;
export const nameOf = (id) => memberById(id)?.full_name || '';
export const reps = () => S.members.filter((m) => m.active && m.role === 'rep');
export const goals = () => (S.goalsRow && S.goalsRow.values) || {};

// a rep always sees themselves. leaders pick.
export function scope() {
  if (S.me && S.me.role === 'rep') return `member:${S.me.id}`;
  return S.scope || 'company';
}
export const isCompany = () => scope() === 'company';
export function scopeLabel() {
  const sc = scope();
  if (sc === 'company') return S.cfg.name;
  if (sc.startsWith('branch:')) return sc.slice(7);
  return nameOf(sc.slice(7));
}
function scopeMatch(branch, memberId) {
  const sc = scope();
  if (sc === 'company') return true;
  if (sc.startsWith('branch:')) return branch === sc.slice(7);
  return memberId === sc.slice(7);
}
export const oppsAll = () => Object.values(S.opps);
export const oppsScoped = () => oppsAll().filter((o) => scopeMatch(o.branch, o.owner_member_id));
export const repsScoped = () => reps().filter((r) => scopeMatch(r.branch, r.id));

export function tabFor(key) {
  return S.cfg.tabs.find((t) => t.key === key) || null;
}
export const teamTabs = () => S.cfg.tabs.filter((t) => t.team);

export function pickGoals(rows, year) {
  if (!rows.length) return null;
  const exact = rows.find((r) => r.period === String(year));
  if (exact) return exact;
  return [...rows].sort((a, b) => (a.period < b.period ? 1 : -1))[0];
}
