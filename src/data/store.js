// App state and the selectors every screen shares.
import { weekInfo } from '../lib/time.js';

export const S = {
  api: null,
  cfg: null,          // normalized workspace
  user: null,         // auth user
  admin: false,
  me: null,           // my members row in this workspace, if any
  members: [],
  opps: {},           // every deal on the board, id -> row (one shape whatever the source)
  dealShape: 'opps',  // where the deals were read from: board (migration 012), aspire, or opps
  commits: {},        // `${member_id}|${week_key}` -> row
  accounts: {},       // the book, id -> row
  goalsRow: null,     // { period, values }
  view: 'summit',
  scope: 'company',   // 'company' | 'branch:<name>' | 'member:<id>'
  filters: {},
  sort: {},
  crm: null,          // pasted CRM export, id -> { status, value }
  sync: null,         // sync and upload log: { runs, unmatched }. null when the workspace has none
  dealAccounts: {},   // native: the account list, id -> row
  changes: [],        // native: the latest changes, newest first
  upload: null,       // csv: the file being mapped and previewed
  excluded: [],       // CRM deals the workspace's exclude list keeps off the board (test data)
  targets: [],        // Summit tile targets, migration 011
  tracking: null,     // the first status snapshot day: "pipeline advanced" is measurable from here
  syncing: false,
  live: 'connecting',
};

export const wk = () => weekInfo(S.cfg);
export const ckey = (memberId, week) => `${memberId}|${week}`;
export const commitFor = (memberId, week) => S.commits[ckey(memberId, week)] || null;

export const isLeader = () => S.admin || (S.me && S.me.role === 'leader' && S.me.active);
// a viewer reads every screen a leader reads and writes nothing
export const isViewer = () => !S.admin && !!S.me && S.me.role === 'viewer';
export const canSeeAll = () => isLeader() || isViewer();
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
// deals come from a CRM or a file: read only, and the words say where from
export const fromCrm = () => !!S.cfg.readOnly;
// where the board's deals come from, in a few words
export function sourceNote(cfg = S.cfg) {
  const s = cfg.source;
  if (s.mode === 'connected') return `From ${cfg.crmLabel}, synced nightly`;
  if (s.mode === 'csv') {
    const last = (S.sync?.runs || []).find((r) => r.status === 'ok');
    const when = last ? new Date(last.finished_at || last.started_at).toLocaleDateString('en-US', { timeZone: cfg.lock_tz, month: 'short', day: 'numeric' }) : '';
    return `From ${s.label}${when ? `, uploaded ${when}` : ', nothing uploaded yet'}`;
  }
  return 'Typed in Summit';
}
// may this person type deals here at all
export const canAddDeals = () => !S.cfg.readOnly && (S.admin || (S.me && S.me.active && ['leader', 'rep'].includes(S.me.role)));
// the configured branches, plus any branch an Aspire deal carries that the config does not list
export function branchList() {
  const out = [...S.cfg.branches];
  if (fromCrm()) for (const o of oppsAll()) if (o.branch && !out.includes(o.branch)) out.push(o.branch);
  return out;
}
// split the board by branch: when the config lists two or more, or the deals carry two or more. Otherwise by rep.
export const byBranch = () => S.cfg.branches.length > 1 || (fromCrm() && branchList().length > 1);
// who a deal belongs to, for display: the roster name, or the CRM's name when it matches nobody
export const repOf = (o) => nameOf(o.owner_member_id) || o.rep_name || '';
export const oppsScoped = () => oppsAll().filter((o) => scopeMatch(o.branch, o.owner_member_id));
export const repsScoped = () => reps().filter((r) => scopeMatch(r.branch, r.id));
// the book has no branch column. an account sits in its owner's branch.
export const accountsScoped = () => Object.values(S.accounts).filter((a) => scopeMatch(memberById(a.owner_member_id)?.branch, a.owner_member_id));

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
