// Fake data shaped exactly like the database. Test names only.
import { addDays, iso } from '../lib/format.js';
import { displayKeyAt } from '../lib/time.js';

const WS = {
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'elevation-outdoors',
  name: 'Elevation Outdoors',
  brand: { head: '#1F3E0F', accent: '#017543', bg: '#F4F3EE', panel: '#ECE9E2', muted: '#8C9A8B', font: 'Instrument Sans', logo: null },
  branches: ['Oakwood', 'Sugar Hill', 'Knoxville'],
  lock_dow: 2, lock_time: '17:00:00', lock_tz: 'America/New_York', late_policy: 'flag', active: true,
  stages: [
    { name: '1 - Prospecting', prob: 0.1, status: 'open' },
    { name: '2 - Qualified', prob: 0.25, status: 'open' },
    { name: '3 - Site Walk / Assessment', prob: 0.4, status: 'open', needs_close: true },
    { name: '4 - Proposal / Bid Sent', prob: 0.6, status: 'open', needs_close: true, bid: true },
    { name: '5 - Negotiation', prob: 0.8, status: 'open', needs_close: true, bid: true },
    { name: '6 - Won', prob: 1, status: 'won', bid: true },
    { name: '7 - Lost', prob: 0, status: 'lost' },
    { name: '8 - On Hold', prob: 0.05, status: 'open', needs_close: true, bid: true, hold: true },
  ],
  categories: [
    { name: 'Maintenance', recurring: true, default_for: 'netnew' },
    { name: 'Install', recurring: false },
    { name: 'Enhancement', recurring: false, default_for: 'grow' },
  ],
  measures: [
    { key: 'audits', type: 'count', label: 'Site audits', label_grow: 'Site audits', label_netnew: 'Site walks' },
    { key: 'visits', type: 'count', label: 'Client visits', label_grow: 'Client visits', label_netnew: 'Meetings' },
    { key: 'bidsN', type: 'count', label: 'Bids', label_grow: 'Bids sent', label_netnew: 'Bids sent', auto: 'bids_count' },
    { key: 'bidsD', type: 'money', label: 'Bid $', label_grow: 'Bid $', label_netnew: 'Bid $', auto: 'bids_value' },
    { key: 'wonD', type: 'money', label: 'Won $', label_grow: 'Won $', label_netnew: 'Signed $', auto: 'won_value' },
    { key: 'startsD', type: 'money', label: 'Starting next week $', label_grow: 'Starting next week $', label_netnew: 'Installing next week $', auto: 'starts_next_week_value' },
  ],
  tabs: [
    { key: 'summit', label: 'Summit', tiles: [{ type: 'book_value', label: 'Maintenance book' }, { type: 'book_at_risk', label: 'Accounts at risk' }], note: 'Goals: new maintenance plus current-client growth by Sept 30 (July 9 offsite). Enhancement growth comes from Aspire and is updated by leadership on the Data Check tab.' },
    { key: 'climb', label: 'The Climb' },
    { key: 'grow', label: 'Grow', team: 'grow', title: 'Grow', sub: 'existing clients, enhancements', team_label: 'Account Managers',
      note_prompt: 'What do you need from Allan, Brooks or ops this week?', branch_measures: ['audits', 'bidsN', 'bidsD', 'wonD'],
      ratio: { label: 'Bids/audit', num: 'bidsN', den: 'audits', goal: 'bidsPerAudit', sub: 'standard: 1 bid per site audit' },
      branch_note: "Allan's standard: find one thing to propose at every site audit.",
      book: { label: 'Maintenance book', audit_days: 90, risk: ['Yellow', 'Red'],
        levels: [{ value: 'Green', color: 'g' }, { value: 'Yellow', color: 'y' }, { value: 'Red', color: 'r' }] } },
    { key: 'netnew', label: 'Net New', team: 'netnew', title: 'Net New', sub: 'new maintenance and install contracts', team_label: 'BDMs',
      note_prompt: 'What do you need from Allan, Brooks or ops this week?', branch_measures: ['audits', 'bidsN', 'bidsD', 'wonD'],
      branch_note: 'Expected close and target start are required once a bid is out. That is what feeds the cash ladder.' },
    { key: 'accounts', label: 'All Accounts' },
    { key: 'datacheck', label: 'Data Check', crm_label: 'Aspire' },
  ],
  goal_tiles: [
    { key: 'newMaint', label: 'New maintenance', source: 'won_recurring', goal: 'newMaintGoal', deadline: 'deadline', coverage: true },
    { key: 'growth', label: 'Enhancement growth', source: 'manual', goal: 'growthGoal', actual: 'growthActual', as_of: 'growthAsOf', actual_label: 'Enhancement growth actual (Aspire)' },
  ],
};

// migration 008's config, used when the demo runs with ?pipeline=aspire
export const ASPIRE_PIPELINE = {
  source: 'aspire',
  statuses: [
    { name: 'New', status: 'open', prob: 0.1 },
    { name: 'Bidding', status: 'open', prob: 0.4, needs_close: true },
    { name: 'Pending Approval', status: 'open', prob: 0.6, needs_close: true, bid: true },
    { name: 'Approved', status: 'open', prob: 0.8, needs_close: true, bid: true },
    { name: 'Won', status: 'won', prob: 1 },
    { name: 'Delivered', status: 'won', prob: 1 },
    { name: 'Lost', status: 'lost', prob: 0 },
  ],
  divisions: [
    { match: 'Maintenance', category: 'Maintenance' },
    { match: 'Enhancement', category: 'Enhancement' },
    { match: 'Construction', category: 'Install' },
  ],
  win_rate: 'properties',
  new_maintenance_basis: 'new_properties',
  exclude: { names: ['John Test Property', 'Test All Out Door', 'Billy Bob Residence TEST'], words: ['test', 'sample'] },
};

// the 5 test rows, same addresses and teams as migration 003
const MEMBERS = [
  ['Test Leader', 'leader', null, 'Oakwood', 'leader'],
  ['Test Grow One', 'rep', 'grow', 'Oakwood', 'grow1'],
  ['Test Grow Two', 'rep', 'grow', 'Sugar Hill', 'grow2'],
  ['Test NetNew One', 'rep', 'netnew', 'Knoxville', 'bdm1'],
  ['Test NetNew Two', 'rep', 'netnew', 'Oakwood', 'bdm2'],
];

function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

export function fixtures(now = new Date()) {
  const r = rng(42);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const d = now.toISOString().slice(0, 10);
  const members = MEMBERS.map(([full_name, role, team, branch, tag], i) => ({
    id: `00000000-0000-4000-8000-00000000010${i}`, workspace_id: WS.id, user_id: `00000000-0000-4000-8000-00000000020${i}`,
    email: `joe+${tag}@deaconjames.com`, full_name, role, team, branch, active: true,
  }));
  const reps = members.filter((m) => m.role === 'rep');
  const names = ['Riverside HOA', 'Peachtree Office Park', 'Lakeview Commons', 'Summit Ridge Apartments', 'Oak Hollow Church', 'Hillcrest Medical',
    'Northgate Plaza', 'Willow Creek HOA', 'Magnolia Senior Living', 'Cedar Point Retail', 'Brookhaven Schools', 'Stonebridge Estates',
    'Pinecrest Industrial', 'Harbor View Condos', 'Maple Grove Townhomes', 'Foxfield Business Center', 'Laurel Park', 'Ashford Village',
    'Creekside Clinic', 'Glenwood Storage', 'Eastlake Tower', 'Heritage Bank Branches', 'Parkview Library', 'Fairway Golf Club'];
  const opps = names.map((account, i) => {
    const o = reps[i % reps.length];
    const s = WS.stages[[0, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 5, 6, 7][Math.floor(r() * 14)]];
    const cat = o.team === 'grow' ? pick(['Enhancement', 'Enhancement', 'Install']) : pick(['Maintenance', 'Maintenance', 'Install']);
    const off = (n) => addDays(d, Math.round(n));
    const won = s.status === 'won';
    return {
      id: `00000000-0000-4000-8000-${String(1000 + i).padStart(12, '0')}`, workspace_id: WS.id, ext_id: null,
      owner_member_id: o.id, account, pipeline: o.team, category: cat, branch: o.branch, stage: s.name,
      value: Math.round((cat === 'Maintenance' ? 20000 + r() * 90000 : 4000 + r() * 40000) / 100) * 100,
      recurring: cat === 'Maintenance', start_date: r() > 0.25 ? off(-10 + r() * 60) : null,
      close_date: s.status === 'open' && r() > 0.2 ? off(-7 + r() * 45) : null, actual_close: won ? off(-r() * 14) : null,
      installed: won && r() > 0.6,
      segment: pick(['HOA', 'Commercial', 'Multifamily', 'Healthcare', 'Municipal']), contact: r() > 0.3 ? pick(['Dana, PM', 'Chris, board chair', 'Sam, facilities', 'Pat, owner']) : null, next_step: r() > 0.2 ? pick(['Walk the site with the property manager', 'Send revised bid', 'Follow up on board vote', 'Schedule kickoff', 'Call about budget']) : null,
      next_step_date: r() > 0.2 ? off(-5 + r() * 14) : null, last_activity: off(-r() * 20), notes: null,
      priority: r() > 0.7, bid_date: s.bid ? off(-r() * 12) : null, stage_date: off(-r() * 10), crm_ref: r() > 0.4 ? String(4400 + i) : null,
      created_at: now.toISOString(), updated_at: now.toISOString(),
    };
  });
  const key = displayKeyAt(WS, now), prev = addDays(key, -7);
  const commits = [];
  reps.forEach((m, i) => {
    const c = { audits: 3 + i, visits: 5, bidsN: 2 + (i % 2), bidsD: 20000 + i * 5000, wonD: 15000, startsD: 10000 };
    commits.push({ id: `00000000-0000-4000-8000-0000000003${i}0`, workspace_id: WS.id, member_id: m.id, week_key: prev, committed: c,
      actual: { audits: 2 + i, visits: 4 + (i % 3) }, note: '', submitted_at: now.toISOString(), late: i === 3, accepted_by: null, updated_at: now.toISOString() });
    if (i < 3) commits.push({ id: `00000000-0000-4000-8000-0000000003${i}1`, workspace_id: WS.id, member_id: m.id, week_key: key, committed: c,
      actual: {}, note: '', submitted_at: now.toISOString(), late: false, accepted_by: null, updated_at: now.toISOString() });
  });
  const goals = [{ workspace_id: WS.id, period: String(now.getFullYear()), values: { newMaintGoal: 706000, growthGoal: 480000, growthActual: 149994, growthAsOf: 'Aug 2026 Aspire pull', deadline: iso(now.getFullYear(), 9, 30), bidsPerAudit: 1.0 } }];
  // the maintenance book, split across the grow reps
  const props = ['Oakmont HOA', 'Riverbend Office Park', 'Lakeside Village', 'Peachtree Commons', 'Magnolia Terrace', 'Harbor Pointe', 'Stone Mountain Plaza',
    'Cedar Grove Condos', 'Willow Park', 'Brookstone Medical', 'Sugarloaf Estates', 'Northpoint Center', 'Laurel Ridge', 'Hidden Creek HOA', 'Cypress Landing', 'Ashton Place'];
  const growReps = members.filter((m) => m.team === 'grow');
  const accounts = props.map((property, i) => {
    const o = growReps[i % growReps.length];
    return {
      id: `00000000-0000-4000-8000-${String(5000 + i).padStart(12, '0')}`, workspace_id: WS.id, owner_member_id: o.id, property,
      annual_value: Math.round((12000 + r() * 60000) / 100) * 100,
      contact_name: pick(['Dana Reyes', 'Chris Patel', 'Sam Ortiz', 'Pat Nguyen', 'Jordan Blake']), contact_email: `pm${i}@example.test`, contact_phone: `404-555-01${String(i).padStart(2, '0')}`,
      last_audit: r() > 0.1 ? addDays(d, -Math.round(r() * 140)) : null, last_meeting: addDays(d, -Math.round(r() * 60)),
      next_meeting: r() > 0.3 ? addDays(d, Math.round(r() * 30)) : null,
      satisfaction: pick(['Green', 'Green', 'Green', 'Yellow', 'Red']), notes: null,
    };
  });
  // the Aspire sync log, as migration 007 writes it
  const at = (h) => new Date(now.getTime() - h * 3600000).toISOString();
  const sync = {
    runs: [
      { id: 3, started_at: at(9), finished_at: at(8.98), trigger: 'cron', mode: 'incremental', status: 'ok', rows_pulled: 38, rows_inserted: 2, rows_updated: 11, rows_unchanged: 25, rows_removed: 0, calls: 2, errors: [], notes: [] },
      { id: 2, started_at: at(33), finished_at: at(32.98), trigger: 'cron', mode: 'incremental', status: 'partial', rows_pulled: 1000, rows_inserted: 0, rows_updated: 4, rows_unchanged: 996, rows_removed: 0, calls: 2, errors: [], notes: ['stopped at page 2 to stay inside the time budget. The next run picks up the rest'] },
      { id: 1, started_at: at(40), finished_at: at(39.9), trigger: 'manual', mode: 'full', status: 'ok', rows_pulled: 2410, rows_inserted: 2410, rows_updated: 0, rows_unchanged: 0, rows_removed: 0, calls: 4, errors: [], notes: [] },
    ],
    unmatched: [
      { sales_rep_name: 'Matthew Royer', deals: 41, open_deals: 12, open_estimated: 184000, won_deals: 29 },
      { sales_rep_name: 'Jamy August', deals: 17, open_deals: 6, open_estimated: 52500, won_deals: 11 },
      { sales_rep_name: 'Genaro Martinez', deals: 9, open_deals: 2, open_estimated: 18800, won_deals: 7 },
      { sales_rep_name: 'Fermin Hernandez Aldaco', deals: 4, open_deals: 1, open_estimated: 6200, won_deals: 3 },
    ],
  };
  // aspire_pipeline rows, the way the view returns them. Status mix close to Elevation's real one,
  // plus reps who are not on the roster, a blank status, a blank branch and a division with no category.
  const statusMix = [['Won', 30], ['Delivered', 8], ['Lost', 4], ['Bidding', 10], ['Approved', 5], ['', 2], ['New', 3], ['Pending Approval', 2]];
  const statusBag = statusMix.flatMap(([s, n]) => Array(n).fill(s));
  const aspireReps = [...reps.map((m) => m.full_name), 'Matthew Royer', 'Jamy August'];
  const pipeline = Array.from({ length: 128 }, (_, i) => {
    const status = statusBag[i % statusBag.length];
    const repName = aspireReps[(i * 7) % aspireReps.length];
    const m = members.find((x) => x.full_name === repName);
    const wonish = status === 'Won' || status === 'Delivered';
    const division = pick(['COM - Maintenance', 'RES - Maintenance', 'COM - Enhancements', 'RES - Enhancements', 'COM - Construction', 'IRR - Irrigation', 'PHC - Plant health Care', 'SNW - Snow', 'Indirect']);
    const maint = division.includes('Maintenance');
    const est = Math.round((maint ? 15000 + r() * 80000 : 3000 + r() * 45000) / 100) * 100;
    const wonDate = wonish ? addDays(d, -Math.round(r() * 420)) : null;
    return {
      workspace_id: WS.id, opportunity_id: 20000 + i, opportunity_number: 7000 + i, property_id: null,
      opportunity_name: `${maint ? 'Annual maintenance' : pick(['Spring color', 'Irrigation repair', 'Hardscape', 'Tree work', 'Mulch'])} ${2026 - (i % 3)}`,
      // a quarter of the work repeats a property: renewals and change orders, the way Aspire logs them
      property_name: names[i % names.length] + (i % 4 === 0 || i < names.length ? '' : ` ${Math.floor(i / names.length) + 1}`),
      sales_rep_name: repName, member_id: m ? m.id : null, member_name: m ? m.full_name : null, member_role: m?.role || null,
      member_team: m?.team || null, member_active: m ? true : null, unassigned: !m,
      branch_name: i % 41 === 5 ? null : m?.branch || pick(WS.branches), division_name: division, status_name: status || null,
      status: wonish ? 'won' : status === 'Lost' ? 'lost' : status ? 'open' : 'unknown',
      estimated_dollars: est, won_dollars: wonish ? Math.round(est * (0.85 + r() * 0.2)) : null,
      start_date: wonish || r() > 0.4 ? addDays(d, Math.round(-30 + r() * 90)) : null,
      anticipated_close_date: !wonish && status !== 'Lost' && r() > 0.25 ? addDays(d, Math.round(-10 + r() * 60)) : null,
      won_date: wonDate, lost_date: status === 'Lost' ? addDays(d, -Math.round(r() * 200)) : null,
      aspire_modified_at: addDays(d, -Math.round(r() * 30)) + 'T10:00:00', synced_at: now.toISOString(),
    };
  });
  // PropertyID by property, the way Aspire keys them
  const pid = {};
  pipeline.forEach((x) => { x.property_id = String(pid[x.property_name] ??= 5000 + Object.keys(pid).length); });
  // test data Aspire carries, which the exclude list keeps off the board
  [['John Test Property', 'Mulch install', 'Won'], ['Test All Out Door', 'Spring color', 'Bidding'], ['Billy Bob Residence TEST', 'Sod', 'Won'],
    ['Riverside HOA', 'Sample estimate', 'Approved']].forEach(([prop, opp, status], i) => pipeline.push({
    ...pipeline[i], opportunity_id: 29000 + i, opportunity_number: 9900 + i, property_name: prop, opportunity_name: opp, status_name: status,
    won_dollars: status === 'Won' ? 99000 : null, won_date: status === 'Won' ? d : null, division_name: 'RES - Maintenance' }));
  return { workspaces: [WS], members, opps, commits, goals, accounts, sync, pipeline };
}
