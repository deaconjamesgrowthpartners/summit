// Every write. Optimistic on screen, debounced to the database,
// row level security has the final say.
import { S, ckey, memberById, wk, goals } from './store.js';
import { toast, uuid } from '../lib/format.js';

let rerender = () => {};
export const onSaved = (fn) => (rerender = fn);

const timers = {};
const queued = {};
const chains = {};

function explain(e) {
  const code = e && (e.code || '');
  const msg = String((e && e.message) || '');
  if (code === 'PGRST116' || code === '42501' || /row-level security|permission/i.test(msg)) return "You can view this but not edit it";
  if (/locked/i.test(msg)) return msg;
  return 'Save failed, try again';
}

function chain(key, fn) {
  chains[key] = (chains[key] || Promise.resolve()).then(fn, fn);
  return chains[key];
}

/* ---------- opps ---------- */
export function writeOpp(id, patch) {
  const o = S.opps[id];
  if (!o) return;
  Object.assign(o, patch);
  queued[id] = { ...(queued[id] || {}), ...patch };
  clearTimeout(timers[id]);
  timers[id] = setTimeout(() => flushOpp(id), 350);
}

function flushOpp(id) {
  const patch = queued[id];
  delete queued[id];
  if (!patch) return;
  chain(id, async () => {
    try {
      const row = await S.api.updateOpp(id, patch);
      S.opps[id] = { ...S.opps[id], ...row, ...(queued[id] || {}) };
      toast('Saved');
    } catch (e) {
      toast(explain(e));
      await refetchOpp(id);
    }
    rerender();
  });
}

async function refetchOpp(id) {
  try {
    const d = await S.api.load(S.cfg.id, wk().prevKey);
    const fresh = d.opps.find((x) => x.id === id);
    if (fresh) S.opps[id] = fresh; else delete S.opps[id];
  } catch { /* keep what we have */ }
}

export async function addOpp(ownerId, team) {
  const owner = memberById(ownerId);
  const cat = S.cfg.categories.find((c) => c.default_for === team) || S.cfg.categories[0];
  const today = wk().today;
  const row = {
    id: uuid(),
    workspace_id: S.cfg.id,
    owner_member_id: ownerId || null,
    account: 'New account',
    pipeline: team || owner?.team || null,
    category: cat ? cat.name : null,
    recurring: cat ? cat.recurring : false,
    branch: owner?.branch || S.cfg.branches[0] || null,
    stage: S.cfg.stages[0]?.name || null,
    stage_date: today,
    value: 0,
    last_activity: today,
    priority: true,
  };
  S.opps[row.id] = { ...row };
  rerender();
  // chained so an edit typed before the insert lands waits for it
  chain(row.id, async () => {
    try {
      const saved = await S.api.insertOpp(row);
      S.opps[row.id] = { ...saved, ...S.opps[row.id] };
      toast('Added');
    } catch (e) {
      delete S.opps[row.id];
      toast(explain(e));
    }
    rerender();
  });
  return row.id;
}

/* ---------- commits ---------- */
// field: 'committed' | 'actual' | 'note'
export function writeCommit(memberId, week, field, k, val) {
  const key = ckey(memberId, week);
  let c = S.commits[key];
  if (!c) {
    c = { id: uuid(), workspace_id: S.cfg.id, member_id: memberId, week_key: week, committed: {}, actual: {}, note: '', late: false, _new: true };
    S.commits[key] = c;
  }
  if (field === 'note') c.note = val;
  else c[field] = { ...(c[field] || {}), [k]: val };
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => flushCommit(key), 350);
}

function flushCommit(key) {
  chain(key, async () => {
    const c = S.commits[key];
    if (!c) return;
    try {
      let row;
      if (c._new) {
        const { _new, ...ins } = c;
        row = await S.api.insertCommit(ins);
      } else {
        row = await S.api.updateCommit(c.id, { committed: c.committed, actual: c.actual, note: c.note });
      }
      // keep anything typed while this save was in flight. the next flush sends it.
      const now = S.commits[key] || c;
      S.commits[key] = { ...row, committed: now.committed, actual: now.actual, note: now.note };
      toast('Saved');
    } catch (e) {
      toast(explain(e));
      if (c._new) delete S.commits[key];
    }
    rerender();
  });
}

export async function acceptLate(commitId) {
  const c = Object.values(S.commits).find((x) => x.id === commitId);
  if (!c) return;
  try {
    const row = await S.api.updateCommit(c.id, { late: false, accepted_by: S.me ? S.me.id : null });
    S.commits[ckey(row.member_id, row.week_key)] = row;
    toast('Accepted');
  } catch (e) {
    toast(explain(e));
  }
  rerender();
}

/* ---------- goals ---------- */
export function writeGoal(k, v) {
  const period = S.goalsRow?.period || String(wk().year);
  S.goalsRow = { period, values: { ...goals(), [k]: v } };
  clearTimeout(timers.goals);
  timers.goals = setTimeout(() => chain('goals', async () => {
    try {
      const row = await S.api.saveGoals(S.cfg.id, S.goalsRow.period, S.goalsRow.values);
      S.goalsRow = row;
      toast('Saved');
    } catch (e) {
      toast(explain(e));
    }
    rerender();
  }), 350);
}
