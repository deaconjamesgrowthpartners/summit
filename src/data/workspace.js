// Turns a workspaces row into the config every screen reads.
// Every label, stage, measure, category and goal comes from the row.

const SCREENS = ['summit', 'climb', 'grow', 'netnew', 'accounts', 'datacheck'];
const TEAMS = ['grow', 'netnew'];

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function normalize(ws) {
  const measures = arr(ws.measures)
    .filter((m) => m && m.key)
    .map((m) => ({
      key: String(m.key),
      type: m.type === 'money' ? 'money' : 'count',
      money: m.type === 'money',
      label: m.label || m.key,
      label_grow: m.label_grow || m.label || m.key,
      label_netnew: m.label_netnew || m.label || m.key,
      auto: m.auto || null,
    }));

  const tabs = arr(ws.tabs)
    .map((t) => (typeof t === 'string' ? { key: t } : obj(t)))
    .filter((t) => SCREENS.includes(t.key))
    .map((t) => ({ ...t, label: t.label || t.key, team: TEAMS.includes(t.team) ? t.team : TEAMS.includes(t.key) ? t.key : null }));

  const stages = arr(ws.stages)
    .map((s) => (typeof s === 'string' ? { name: s } : obj(s)))
    .filter((s) => s.name)
    .map((s) => ({
      name: String(s.name),
      prob: Math.max(0, Math.min(1, +s.prob || 0)),
      status: ['open', 'won', 'lost'].includes(s.status) ? s.status : 'open',
      needs_close: !!s.needs_close,
      bid: !!s.bid,
      hold: !!s.hold,
    }));
  const stageBy = Object.fromEntries(stages.map((s) => [s.name, s]));

  const categories = arr(ws.categories)
    .map((c) => (typeof c === 'string' ? { name: c } : obj(c)))
    .filter((c) => c.name)
    .map((c) => ({ name: String(c.name), recurring: !!c.recurring, default_for: c.default_for || null }));
  const catBy = Object.fromEntries(categories.map((c) => [c.name, c]));

  const goalTiles = arr(ws.goal_tiles)
    .map(obj)
    .filter((g) => g.key && g.label)
    .map((g) => ({ ...g, source: g.source === 'won_recurring' ? 'won_recurring' : 'manual' }));

  const teamTab = Object.fromEntries(tabs.filter((t) => t.team).map((t) => [t.team, t]));
  const check = tabs.find((t) => t.key === 'datacheck') || {};

  return {
    id: ws.id,
    slug: ws.slug,
    name: ws.name,
    brand: obj(ws.brand),
    measures,
    tabs,
    stages,
    stageBy,
    categories,
    catBy,
    goalTiles,
    teamTab,
    crmLabel: check.crm_label || 'CRM',
    branches: arr(ws.branches).map(String),
    lock_dow: +ws.lock_dow || 2,
    lock_time: ws.lock_time || '17:00',
    lock_tz: ws.lock_tz || 'America/New_York',
    late_policy: ws.late_policy === 'block' ? 'block' : 'flag',
  };
}

// label for a measure: per team, or both when they differ
export function mLabel(m, team) {
  if (team === 'grow') return m.label_grow;
  if (team === 'netnew') return m.label_netnew;
  return m.label_grow === m.label_netnew ? m.label_grow : `${m.label_grow} / ${m.label_netnew}`;
}

// every goal key the leadership editor should show, with its label and type
export function goalFields(cfg) {
  const out = [];
  const seen = new Set();
  const add = (key, label, type) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, label, type });
  };
  for (const g of cfg.goalTiles) {
    add(g.goal, `${g.label} goal`, 'money');
    if (g.source === 'manual') add(g.actual, g.actual_label || `${g.label} actual`, 'money');
    add(g.as_of, 'As of', 'text');
    add(g.deadline, 'Deadline', 'date');
  }
  for (const t of cfg.tabs) if (t.ratio && t.ratio.goal) add(t.ratio.goal, `${t.ratio.label} standard`, 'number');
  return out;
}
