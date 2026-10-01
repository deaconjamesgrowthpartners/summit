// Turns a workspaces row into the config every screen reads.
// Every label, stage, measure, category and goal comes from the row.

const SCREENS = ['summit', 'climb', 'grow', 'netnew', 'accounts', 'datacheck'];
const TEAMS = ['grow', 'netnew'];

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// how a CRM name is matched: case and spaces at the ends ignored, runs of spaces collapsed
export const nameKey = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const toStage = (s) => ({
  name: String(s.name),
  prob: Math.max(0, Math.min(1, +s.prob || 0)),
  status: ['open', 'won', 'lost'].includes(s.status) ? s.status : 'open',
  needs_close: !!s.needs_close,
  bid: !!s.bid,
  hold: !!s.hold,
});

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

  // where the deals come from. "aspire": the board reads aspire_pipeline, and the stages are the
  // Aspire statuses from the config. Anything else: the opps table and the workspace's own stages.
  const pl = obj(ws.pipeline);
  const pipelineSource = pl.source === 'aspire' ? 'aspire' : 'summit';
  const stageList = pipelineSource === 'aspire' ? arr(pl.statuses) : arr(ws.stages);
  const stages = stageList
    .map((s) => (typeof s === 'string' ? { name: s } : obj(s)))
    .filter((s) => s.name && (pipelineSource !== 'aspire' || ['open', 'won', 'lost'].includes(s.status)))
    .map(toStage);
  const stageBy = Object.fromEntries(stages.map((s) => [s.name, s]));
  const stageByKey = Object.fromEntries(stages.map((s) => [nameKey(s.name), s]));
  const divisions = Object.fromEntries(Object.entries(obj(pl.divisions)).map(([k, v]) => [nameKey(k), String(v)]));

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

  // the account book. lives on whichever team tab carries a "book" block.
  const bookTab = tabs.find((t) => t.book && typeof t.book === 'object');
  const b = bookTab ? obj(bookTab.book) : null;
  const book = b ? {
    tab: bookTab.key,
    label: b.label || 'Book',
    audit_days: +b.audit_days > 0 ? +b.audit_days : 90,
    levels: arr(b.levels).map(obj).filter((l) => l.value).map((l) => ({ value: String(l.value), color: ['g', 'y', 'r'].includes(l.color) ? l.color : 'n' })),
    risk: arr(b.risk).map(String),
    note: b.note || '',
  } : null;
  const summitTab = tabs.find((t) => t.key === 'summit') || {};
  const summitTiles = arr(summitTab.tiles).map(obj).filter((x) => x.type && x.label);
  const check = tabs.find((t) => t.key === 'datacheck') || {};

  return {
    id: ws.id,
    slug: ws.slug,
    name: ws.name,
    brand: obj(ws.brand),
    measures,
    tabs,
    pipelineSource,
    stages,
    stageBy,
    stageByKey,
    divisions,
    categories,
    catBy,
    goalTiles,
    teamTab,
    book,
    summitTiles,
    crmLabel: check.crm_label || 'CRM',
    crmSource: ws.crm_source || null,
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
