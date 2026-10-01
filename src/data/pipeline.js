// Aspire deals, as the board sees them. aspire_pipeline rows (migration 007 and 008) are turned into
// the same shape as a Summit opp, so every screen computes open, won, weighted, coverage, the cash
// ladder and the branch table the same way for both sources. They are read only: Aspire is the
// source, and the sync is the only thing that writes them.
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
  const names = [r.property_name, r.opportunity_name].map(nameKey);
  if (names.some((n) => n && ex.names.includes(n))) return true;
  return ex.words.some((w) => {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}($|[^\\p{L}\\p{N}])`, 'iu');
    return re.test(r.property_name || '') || re.test(r.opportunity_name || '');
  });
}

export function fromAspire(cfg, r) {
  const st = cfg.stageByKey[nameKey(r.status_name)] || null;
  const won = st?.status === 'won', lost = st?.status === 'lost';
  const category = categoryFor(cfg, r.division_name);
  const est = num(r.estimated_dollars), wonD = num(r.won_dollars);
  const job = r.opportunity_name && r.opportunity_name !== r.property_name ? r.opportunity_name : '';
  return {
    id: `aspire:${r.opportunity_id}`,
    src: 'aspire',
    crm_ref: r.opportunity_number != null && r.opportunity_number !== '' ? String(r.opportunity_number) : String(r.opportunity_id),
    account: r.property_name || r.opportunity_name || `${cfg.crmLabel} #${r.opportunity_id}`,
    job: r.property_name ? job : '',
    owner_member_id: r.member_id || null,
    rep_name: (r.sales_rep_name || '').trim(),
    unassigned: !r.member_id,
    branch: (r.branch_name || '').trim(),
    division: (r.division_name || '').trim(),
    category,
    category_mapped: !!cfg.catBy[category],
    recurring: !!cfg.catBy[category]?.recurring,
    stage: st ? st.name : (r.status_name || '').trim(),
    status_known: !!st,
    status_name: (r.status_name || '').trim(),
    // won work is worth what it was won for. open work is worth the estimate.
    value: (won ? wonD ?? est : est) ?? 0,
    estimated: est,
    won_dollars: wonD,
    close_date: day(r.anticipated_close_date),
    start_date: day(r.start_date),
    actual_close: won ? day(r.won_date) : null,
    lost_date: lost ? day(r.lost_date) || day(r.aspire_modified_at) : null,
    modified: r.aspire_modified_at || null,
  };
}
