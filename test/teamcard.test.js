// Grow and Net New built from the deals: every deal of the tab's kind in its own branch, whoever sold it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/data/workspace.js';
import { fromDeal } from '../src/data/pipeline.js';
import { autoDidRows, netNewTest } from '../src/lib/rules.js';
import { teamDealTest, dealBranchRows } from '../src/lib/teamcard.js';

const cfg = normalize({ id: 'e', pipeline: { source: 'aspire', statuses: [
  { name: 'Bidding', status: 'open', prob: 0.4 }, { name: 'Won', status: 'won', prob: 1 }, { name: 'Lost', status: 'lost' }] },
  measures: [{ key: 'audits', label: 'Site audits' }, { key: 'bidsN', label: 'Bids', auto: 'bids_count' }, { key: 'wonD', type: 'money', label: 'Won $', auto: 'won_value' }],
  tabs: [{ key: 'grow', deals: { kind: 'enhancement' } }, { key: 'netnew', deals: { kind: 'netnew' } }, { key: 'datacheck', crm_label: 'Aspire' }] },
{ mode: 'connected', label: 'Aspire' });
let n = 0;
const d = (o) => fromDeal(cfg, { deal_id: `d${n++}`, stage: 'Bidding', value_estimated: 100, value_won: 100, member_id: o.member_id ?? 'x', ...o }, 'connected');
// Oak HOA was won before: its new deals are existing-client work. Pine Plaza is new.
const history = [d({ property_id: 'oak', account: 'Oak HOA', stage: 'Won', won_date: '2025-05-01', branch: 'Oakwood', created_date: '2025-04-01' })];
const deals = [
  ...history,
  d({ property_id: 'oak', account: 'Oak HOA', branch: 'Oakwood', created_date: '2026-10-08', member_id: 'greg' }),
  d({ property_id: 'oak', account: 'Oak HOA', branch: 'Oakwood', stage: 'Won', won_date: '2026-10-09', created_date: '2026-10-01', member_id: 'greg' }),
  d({ property_id: 'pine', account: 'Pine Plaza', branch: 'Oakwood', created_date: '2026-10-08', member_id: 'greg' }),
  d({ property_id: 'oak', account: 'Oak HOA', branch: '', created_date: '2026-10-09', member_id: 'oscar' }),
];
const reps = [{ id: 'oscar', branch: 'Sugar Hill', team: 'grow' }];
const commits = { oscar: { committed: { audits: 4, bidsN: 2 }, actual: { audits: 3 } } };
const run = (tab) => dealBranchRows(cfg, { branches: ['Oakwood', 'Sugar Hill'], deals, reps,
  inTeam: teamDealTest(tab, netNewTest(cfg, deals)), week: '2026-10-13', commitOf: (id) => commits[id] || null, autoRows: autoDidRows });

test('Grow shows Oakwood from the deals, though no one on Grow is rostered there', () => {
  const rows = run(cfg.tabs[0]);
  const oak = rows.find((x) => x.b === 'Oakwood');
  assert.ok(oak, 'Oakwood has a row');
  assert.equal(oak.deals, 2, 'the two existing-client deals at Oak HOA, sold by a Net New rep; Pine Plaza is new');
  assert.equal(oak.t.bidsN.d, 1, 'bids from the deals created that week');
  assert.equal(oak.t.wonD.d, 100, 'won from the deals');
  assert.equal(oak.t.audits, null, 'no Grow rep at Oakwood: typed numbers read no one, never 0');
  assert.equal(oak.reps, 0);
  const sh = rows.find((x) => x.b === 'Sugar Hill');
  assert.deepEqual([sh.deals, sh.t.audits.d, sh.t.audits.c, sh.t.bidsN.c], [0, 3, 4, 2], 'Oscar types and commits at Sugar Hill');
  assert.equal(rows.find((x) => x.b === '').deals, 1, 'a deal with no branch gets its own row');
});

test('Net New counts the new property, and a tab without deals config keeps the old way', () => {
  const rows = run(cfg.tabs[1]);
  assert.equal(rows.find((x) => x.b === 'Oakwood').deals, 2, 'Pine Plaza, and the first win at Oak HOA, which was new business then');
  assert.equal(teamDealTest({ key: 'x' }, () => true), null);
  const byDiv = teamDealTest({ deals: { division: 'Enhancement' } }, () => true);
  assert.ok(byDiv({ division: 'COM - Enhancements' }) && !byDiv({ division: 'COM - Maintenance' }), 'or by division, by config');
});
