// Deals, as the board sees them. Every source lands in one shape, so every screen computes open, won,
// weighted, coverage, the cash ladder and the branch table the same way whatever the source:
//   deal_board rows (migration 012), for every source mode
//   aspire_pipeline rows, before 012 runs
//   opps rows, typed deals before 014 runs
// A connected or csv deal is read only: the source is the truth, and only the sync or an upload writes it.
import { nameKey } from './workspace.js';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v);
const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

// the Summit category for an Aspire division: the config rules first (match anywhere in the name),
// then an exact config name, then the same name, then the same name without a trailing s
// (Enhancements -> Enhancement). Otherwise the division name itself, which is one-time.
export function categoryFor(cfg, division) {
  const k = nameKey(division);
  if (!k) return '';
  const rule = (cfg.divisionRules || []).find((r) => k.includes(r.match));
  if (rule) return rule.category;
  if (cfg.divisions[k]) return cfg.divisions[k];
  const hit = cfg.categories.find((c) => nameKey(c.name) === k) || cfg.categories.find((c) => nameKey(c.name) === k.replace(/s$/, ''));
  return hit ? hit.name : String(division).trim();
}

// test and sample data, by the workspace's exclude list: an exact name, or a whole word in the
// property or opportunity name. Excluded deals are kept out of every number and counted on Data Check.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function isExcluded(cfg, r) {
  const ex = cfg.exclude || { names: [], words: [] };
  const prop = r.property_name ?? r.account, opp = r.opportunity_name ?? r.job;
  r = { property_name: prop, opportunity_name: opp };
  const names = [r.property_name, r.opportunity_name].map(nameKey);
  if (names.some((n) => n && ex.names.includes(n))) return true;
  return ex.words.some((w) => {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}($|[^\\p{L}\\p{N}])`, 'iu');
    return re.test(r.property_name || '') || re.test(r.opportunity_name || '');
  });
}

// an aspire_pipeline row, as the deal_board row 012 gives the same deal
export const aspireToBoard = (r) => ({
  deal_id: `aspire:${r.opportunity_id}`, external_id: r.opportunity_id != null ? String(r.opportunity_id) : null,
  external_number: r.opportunity_number, account: r.property_name, job: r.opportunity_name, property_id: r.property_id,
  rep_name: r.sales_rep_name, member_id: r.member_id, branch: r.branch_name, division: r.division_name, stage: r.status_name,
  value_estimated: r.estimated_dollars, value_won: r.won_dollars, close_date: r.anticipated_close_date, start_date: r.start_date,
  won_date: r.won_date, lost_date: r.lost_date, ext_modified_at: r.aspire_modified_at, created_date: r.created_date,
  end_date: r.end_date, renewal_date: r.renewal_date,
});

export function fromAspire(cfg, r) {
  return fromDeal(cfg, aspireToBoard(r), 'connected');
}

// a deal_board row (or a deals row, as a write returns it) in the board's shape. mode is the source's.
export function fromDeal(cfg, r, mode = 'native') {
  if (mode === 'native') return fromTyped(cfg, r);
  const st = cfg.stageByKey[nameKey(r.stage)] || null;
  const won = st?.status === 'won', lost = st?.status === 'lost';
  const category = r.category || categoryFor(cfg, r.division);
  const est = num(r.value_estimated), wonD = num(r.value_won);
  const job = r.job && r.job !== r.account ? r.job : '';
  const ref = r.external_id ?? '';
  return {
    id: String(r.deal_id ?? r.id),
    src: mode,
    readOnly: true,
    external_id: ref,
    property_id: r.property_id != null && r.property_id !== '' ? String(r.property_id) : null,
    crm_ref: r.external_number != null && r.external_number !== '' ? String(r.external_number) : String(ref),
    account: r.account || r.job || `${cfg.crmLabel} #${ref}`,
    job: r.account ? job : '',
    owner_member_id: r.member_id || null,
    rep_name: (r.rep_name || '').trim(),
    unassigned: !r.member_id,
    branch: (r.branch || '').trim(),
    division: (r.division || '').trim(),
    category,
    category_mapped: !!cfg.catBy[category],
    recurring: !!cfg.catBy[category]?.recurring,
    stage: st ? st.name : (r.stage || '').trim(),
    status_known: !!st,
    status_name: (r.stage || '').trim(),
    // won work is worth what it was won for. open work is worth the estimate.
    value: (won ? wonD ?? est : est) ?? 0,
    estimated: est,
    won_dollars: wonD,
    close_date: day(r.close_date),
    start_date: day(r.start_date),
    actual_close: won ? day(r.won_date) : null,
    lost_date: lost ? day(r.lost_date) || day(r.ext_modified_at) : null,
    modified: r.ext_modified_at || null,
    // migration 011. Absent before it runs, so every screen copes with null.
    created_date: day(r.created_date),
    end_date: day(r.end_date),
    renewal_date: day(r.renewal_date),
  };
}

// a deal typed in Summit: a deals row or a deal_board row. Same fields the typed opps always had.
function fromTyped(cfg, r) {
  const c = cfg.catBy[r.category];
  const st = cfg.stageBy[r.stage];
  const est = num(r.value_estimated), wonD = num(r.value_won);
  return {
    id: String(r.deal_id ?? r.id),
    src: 'native',
    readOnly: false,
    workspace_id: r.workspace_id,
    account_id: r.account_id || null,
    account: r.account || '',
    job: r.job || '',
    owner_member_id: r.owner_member_id ?? r.member_id ?? null,
    rep_name: '',
    unassigned: !(r.owner_member_id ?? r.member_id),
    branch: r.branch || '',
    category: r.category || null,
    recurring: c ? c.recurring : false,
    stage: r.stage || null,
    value: (st?.status === 'won' ? wonD ?? est : est) ?? 0,
    estimated: est,
    won_dollars: wonD,
    close_date: day(r.close_date),
    start_date: day(r.start_date),
    actual_close: day(r.won_date),
    lost_date: day(r.lost_date),
    bid_date: day(r.bid_date),
    stage_date: day(r.stage_date),
    created_date: day(r.created_date),
    created_at: r.created_at || null,
    end_date: day(r.end_date),
    renewal_date: day(r.renewal_date),
    next_step: r.next_step || '',
    next_step_date: day(r.next_step_date),
    last_activity: day(r.last_activity),
    notes: r.notes || '',
    contact: r.contact || '',
    segment: r.segment || '',
    priority: !!r.priority,
    installed: !!r.installed,
    crm_ref: r.external_number || '',
  };
}

// a typed opps row (before 014): already the board's shape. Marked so writes go back to opps.
export const fromOpp = (r) => ({ ...r, src: 'opps', readOnly: false });

// a board-shape patch, as deals columns. Fields the deals table does not keep are dropped.
const PATCH = {
  value: 'value_estimated', actual_close: 'won_date', crm_ref: 'external_number',
  account: 'account', account_id: 'account_id', job: 'job', owner_member_id: 'owner_member_id', branch: 'branch',
  category: 'category', stage: 'stage', stage_date: 'stage_date', bid_date: 'bid_date', close_date: 'close_date',
  start_date: 'start_date', lost_date: 'lost_date', end_date: 'end_date', renewal_date: 'renewal_date',
  next_step: 'next_step', next_step_date: 'next_step_date', last_activity: 'last_activity', notes: 'notes',
  contact: 'contact', segment: 'segment', priority: 'priority', installed: 'installed', workspace_id: 'workspace_id',
  id: 'id', created_date: 'created_date',
};
export function toDealPatch(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) if (PATCH[k]) out[PATCH[k]] = v;
  return out;
}
