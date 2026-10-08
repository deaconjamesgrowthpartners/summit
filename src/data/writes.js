// Every write. Optimistic on screen, debounced to the database,
// row level security has the final say.
import { S, ckey, memberById, wk, goals } from './store.js';
import { toast, uuid } from '../lib/format.js';
import { fromDeal, toDealPatch } from './pipeline.js';

// a typed deal saves to deals (migration 014), or to opps before 014 runs. Either way the row comes back
// in the board's shape.
const typedDeal = (o) => o && o.src === 'native';
async function saveDeal(id, patch) {
  if (typedDeal(S.opps[id])) return fromDeal(S.cfg, await S.api.updateDeal(id, toDealPatch(patch)), 'native');
  return S.api.updateOpp(id, patch);
}
async function addDeal(row) {
  if (S.dealShape === 'board') return fromDeal(S.cfg, await S.api.insertDeal(toDealPatch(row)), 'native');
  return S.api.insertOpp(row);
}

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
  if (!o || o.readOnly) return;
  // a stage change is a stage event today: the stage-entry measures count it straight away
  if ('stage' in patch && patch.stage !== o.stage && patch.stage) o.stage_events = [...(o.stage_events || []), { d: wk().today, stage: patch.stage }];
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
      const row = await saveDeal(id, patch);
      S.opps[id] = { ...S.opps[id], ...row, stage_events: S.opps[id]?.stage_events, ...(queued[id] || {}) };
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
    const d = await S.api.load(S.cfg.id, wk().prevKey, S.cfg.source);
    const r = d.deals.find((x) => String(x.deal_id ?? x.id) === id);
    if (r) S.opps[id] = { ...(d.shape === 'board' ? fromDeal(S.cfg, r, 'native') : { ...r, src: 'opps', readOnly: false }), stage_events: S.opps[id]?.stage_events };
    else delete S.opps[id];
  } catch { /* keep what we have */ }
}

export async function addOpp(ownerId, team) {
  const owner = memberById(ownerId);
  const cat = S.cfg.categories.find((c) => c.default_for === team) || S.cfg.categories[0];
  const today = wk().today;
  const board = S.dealShape === 'board';
  const row = {
    id: uuid(),
    workspace_id: S.cfg.id,
    owner_member_id: ownerId || null,
    account: `New ${S.cfg.dealWord}`,
    ...(board ? {} : { pipeline: team || owner?.team || null, recurring: cat ? cat.recurring : false }),
    category: cat ? cat.name : null,
    branch: owner?.branch || S.cfg.branches[0] || null,
    stage: S.cfg.stages[0]?.name || null,
    stage_date: today,
    value: 0,
    last_activity: today,
    priority: true,
  };
  S.opps[row.id] = { ...row, src: board ? 'native' : 'opps', readOnly: false, created_date: today, stage_events: row.stage ? [{ d: today, stage: row.stage }] : [] };
  rerender();
  // chained so an edit typed before the insert lands waits for it
  chain(row.id, async () => {
    try {
      const saved = await addDeal(row);
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

// the account list: the account a typed name belongs to, added when it is new. Saves the deal's link.
export async function linkAccount(dealId, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key || S.dealShape !== 'board') return;
  let a = Object.values(S.dealAccounts).find((x) => x.name.trim().toLowerCase() === key);
  if (!a) {
    try {
      a = await S.api.insertDealAccount({ workspace_id: S.cfg.id, name: String(name).trim() });
      S.dealAccounts[a.id] = a;
    } catch { return; }
  }
  if (S.opps[dealId] && S.opps[dealId].account_id !== a.id) writeOpp(dealId, { account_id: a.id });
}

/* ---------- the book ---------- */
export function writeAccount(id, patch) {
  const a = S.accounts[id];
  if (!a) return;
  Object.assign(a, patch);
  const key = `acct:${id}`;
  queued[key] = { ...(queued[key] || {}), ...patch };
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => {
    const p = queued[key];
    delete queued[key];
    if (!p) return;
    chain(key, async () => {
      try {
        const row = await S.api.updateAccount(id, p);
        S.accounts[id] = { ...S.accounts[id], ...row, ...(queued[key] || {}) };
        toast('Saved');
      } catch (e) {
        toast(explain(e));
        try {
          const d = await S.api.load(S.cfg.id, wk().prevKey, S.cfg.source);
          const fresh = (d.accounts || []).find((x) => x.id === id);
          if (fresh) S.accounts[id] = fresh;
        } catch { /* keep what we have */ }
      }
      rerender();
    });
  }, 350);
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

// a Summit target. Saved straight away, one row per cell. Blank removes it.
const sameTarget = (a, b) => ['branch', 'month', 'metric', 'division', 'kind'].every((k) => a[k] === b[k]);
export function writeTarget(key, amount) {
  const prev = S.targets.find((t) => sameTarget(t, key));
  S.targets = [...S.targets.filter((t) => !sameTarget(t, key)), ...(amount === null ? [] : [{ ...key, amount }])];
  chain(`t:${Object.values(key).join('|')}`, async () => {
    try {
      await S.api.saveTarget(key, amount);
      toast('Saved');
    } catch (e) {
      S.targets = [...S.targets.filter((t) => !sameTarget(t, key)), ...(prev ? [prev] : [])];
      toast(explain(e));
    }
    rerender();
  });
}
