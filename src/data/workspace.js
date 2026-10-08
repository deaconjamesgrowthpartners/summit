// Turns a workspaces row into the config every screen reads.
// Every label, stage, measure, category, team and goal comes from the row. Where the deals come from
// comes from the workspace's deal source (migration 012): connected, csv or native.

// screens with their own view. Any other tab key is a team tab when it names a team.
const SCREENS = ['summit', 'climb', 'accounts', 'datacheck'];
// before team tabs were named in config, these two keys were the teams
const LEGACY_TEAMS = ['grow', 'netnew'];
export const MODES = ['connected', 'csv', 'native'];

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

// the workspace's one source of truth for deals. Before migration 012 there is no deal_sources row,
// so it is read off the old pipeline config: Aspire, or typed in Summit.
export function dealSource(ws, src) {
  if (src && MODES.includes(src.mode)) {
    return { mode: src.mode, label: src.label || (src.mode === 'native' ? 'Summit' : src.connector || 'CRM'), connector: src.connector || null, id: src.id ?? null, mapping: obj(src.mapping), legacy: false };
  }
  return obj(ws.pipeline).source === 'aspire'
    ? { mode: 'connected', label: 'Aspire', connector: 'aspire', id: null, legacy: true }
    : { mode: 'native', label: 'Summit', connector: null, id: null, legacy: true };
}

// an auto measure: a board number by name (bids_count, won_value, ...), or the deals that reached a stage
// that week: { stage_entered: "Meeting booked" }, counted, or { stage_entered: ..., sum: "value" } in dollars.
function toAuto(a) {
  if (typeof a === 'string' && a) return a;
  const o = obj(a);
  if (o.stage_entered) return { stage_entered: String(o.stage_entered), sum: o.sum === 'value' ? 'value' : 'count' };
  return null;
}

export function normalize(ws, src = null) {
  const source = dealSource(ws, src);
  const readOnly = source.mode !== 'native';
  const measures = arr(ws.measures)
    .filter((m) => m && m.key)
    .map((m) => {
      // labels per team: { grow: 'Site audits', netnew: 'Site walks' }. label_<team> still reads.
      const labels = { ...obj(m.labels) };
      for (const [k, v] of Object.entries(m)) if (k.startsWith('label_') && v) labels[k.slice(6)] = String(v);
      return {
        key: String(m.key),
        type: m.type === 'money' ? 'money' : 'count',
        money: m.type === 'money',
        label: m.label || m.key,
        labels,
        // a team tab's own word for it ({ labels: { src_booked: 'Meetings booked' } }): on that tab only
        tabLabels: {},
        auto: toAuto(m.auto),
      };
    });

  // a team tab names its team: { key: 'outreach', team: 'outreach', measures: ['conv', 'booked'] }.
  // measures, when set, are the ones that team commits to; otherwise every measure.
  const tabs = arr(ws.tabs)
    .map((t) => (typeof t === 'string' ? { key: t } : obj(t)))
    .map((t) => ({ ...t, team: t.team ? String(t.team) : LEGACY_TEAMS.includes(t.key) ? t.key : null }))
    .filter((t) => t.key && (SCREENS.includes(t.key) || t.team))
    .map((t) => ({ ...t, key: String(t.key), label: t.label || t.key, measures: arr(t.measures).map(String) }));
  for (const t of tabs) for (const [k, v] of Object.entries(obj(t.labels))) {
    const m = measures.find((x) => x.key === k);
    if (m && t.team && v) m.tabLabels[t.team] = String(v);
  }

  // the stages: a connected or csv source's statuses from the pipeline config (each says open, won or
  // lost), or the workspace's own stages when people type their deals.
  const pl = obj(ws.pipeline);
  const pipelineSource = readOnly ? 'aspire' : 'summit';
  const fromStatuses = readOnly && Array.isArray(pl.statuses);
  const stageList = fromStatuses ? arr(pl.statuses) : arr(ws.stages);
  const stages = stageList
    .map((s) => (typeof s === 'string' ? { name: s } : obj(s)))
    .filter((s) => s.name && (!fromStatuses || ['open', 'won', 'lost'].includes(s.status)))
    .map(toStage);
  const stageBy = Object.fromEntries(stages.map((s) => [s.name, s]));
  const stageByKey = Object.fromEntries(stages.map((s) => [nameKey(s.name), s]));
  // divisions: a list of rules, "match" found anywhere in the division name. An object of exact
  // names also works. A division nothing matches keeps its name and is one-time.
  const divisions = Object.fromEntries(Object.entries(obj(pl.divisions)).map(([k, v]) => [nameKey(k), String(v)]));
  const divisionRules = arr(pl.divisions).map(obj).filter((r) => r.match && r.category).map((r) => ({ match: nameKey(r.match), category: String(r.category) }));
  const ex = obj(pl.exclude);
  const exclude = {
    names: arr(ex.names).map(nameKey).filter(Boolean),
    words: arr(ex.words).map((w) => String(w).trim()).filter(Boolean),
  };
  // win rate: properties (a property once a year), deals (every record), or off
  const winRate = ['properties', 'deals', 'off'].includes(pl.win_rate) ? pl.win_rate : 'deals';
  // what counts toward a new maintenance goal: properties new to the book (the default), or every
  // recurring dollar. Only CRM deals carry the history to tell them apart.
  const newMaintenanceBasis = !readOnly ? 'all_recurring'
    : pl.new_maintenance_basis === 'all_recurring' ? 'all_recurring' : 'new_properties';

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
  // the Summit filters and their words. Maintenance / Install needs a recurring category to mean anything.
  const hasRecurring = categories.some((c) => c.recurring) || readOnly;
  const filters = (Array.isArray(summitTab.filters) ? summitTab.filters : ['division', 'kind']).filter((f) => f !== 'division' || hasRecurring);
  const words = obj(summitTab.words);
  const branches = arr(ws.branches).map(String);

  return {
    id: ws.id,
    slug: ws.slug,
    name: ws.name,
    brand: obj(ws.brand),
    measures,
    tabs,
    source,
    readOnly,
    // what a deal is called on screen, and whether the board splits by branch
    dealWord: summitTab.deal_word || (readOnly ? 'deal' : 'account'),
    filters,
    words: {
      maintenance: words.maintenance || 'Maintenance', install: words.install || 'Install',
      enhancement: words.enhancement || 'Enhancement', netnew: words.netnew || 'Net New',
    },
    byBranch: branches.length > 1 || readOnly,
    pipelineSource,
    stages,
    stageBy,
    stageByKey,
    divisions,
    divisionRules,
    exclude,
    winRate,
    newMaintenanceBasis,
    categories,
    catBy,
    goalTiles,
    teamTab,
    book,
    summitTiles,
    crmLabel: check.crm_label || (readOnly ? source.label : 'CRM'),
    // the paste-an-export cross-check, for typed deals: only when the workspace names a CRM to check against
    crossCheck: !readOnly && !!check.crm_label,
    crmSource: ws.crm_source || null,
    branches,
    lock_dow: +ws.lock_dow || 2,
    lock_time: ws.lock_time || '17:00',
    lock_tz: ws.lock_tz || 'America/New_York',
    late_policy: ws.late_policy === 'block' ? 'block' : 'flag',
  };
}

// label for a measure: the team's word for it, or every team's word when they differ
export function mLabel(m, team) {
  if (team) return m.tabLabels?.[team] || m.labels[team] || m.label;
  const all = [...new Set(Object.values(m.labels))];
  return all.length ? all.join(' / ') : m.label;
}

// the measures a team commits to: its tab's list, in that order, or every measure
export function teamMeasures(cfg, team) {
  const t = cfg.teamTab[team];
  if (!t || !t.measures.length) return cfg.measures;
  return t.measures.map((k) => cfg.measures.find((m) => m.key === k)).filter(Boolean);
}
// the measures a member commits to, by their team
export const memberMeasures = (cfg, member) => teamMeasures(cfg, member?.team);

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
    add(g.start, `${g.label} window opens`, 'date');
    add(g.deadline, 'Deadline', 'date');
  }
  for (const t of cfg.tabs) if (t.ratio && t.ratio.goal) add(t.ratio.goal, `${t.ratio.label} standard`, 'number');
  return out;
}
