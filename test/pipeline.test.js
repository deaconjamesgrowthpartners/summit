// The board reading Aspire: the status map comes from config, Delivered is sold work, and no deal
// drops out of the counts because its rep or status is unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/data/workspace.js';
import { fromAspire, categoryFor, isExcluded } from '../src/data/pipeline.js';
import { isOpen, isWon, isLost, isUnknown, weighted, sum, rowIssues, flag, autoDid, goalActual, goalDetail, winRateOf, newPropertyTest } from '../src/lib/rules.js';

const PIPELINE = {
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
  divisions: { Construction: 'Install' },
};
const cfg = normalize({
  id: 'w', slug: 'e', name: 'E', pipeline: PIPELINE, crm_source: 'aspire',
  stages: [{ name: '6 - Won', status: 'won' }],
  categories: [{ name: 'Maintenance', recurring: true }, { name: 'Install' }, { name: 'Enhancement' }],
  tabs: [{ key: 'datacheck', crm_label: 'Aspire' }],
});
const row = (o) => ({ opportunity_id: 1, opportunity_number: 7001, property_name: 'Oak HOA', opportunity_name: 'Mulch', sales_rep_name: 'Greg Hill',
  member_id: 'm1', branch_name: 'Oakwood', division_name: 'Maintenance', status_name: 'Bidding', estimated_dollars: 1000, won_dollars: null,
  start_date: null, anticipated_close_date: '2026-10-20', won_date: null, lost_date: null, aspire_modified_at: '2026-09-01T10:00:00', ...o });
const deal = (o) => fromAspire(cfg, row(o));

test('the stages are the Aspire statuses from config, not the typed stages', () => {
  assert.equal(cfg.pipelineSource, 'aspire');
  assert.deepEqual(cfg.stages.map((s) => s.name), PIPELINE.statuses.map((s) => s.name));
  assert.equal(cfg.stageBy['6 - Won'], undefined);
});

test('open is Bidding, Approved, New and Pending Approval. Delivered is won, never open', () => {
  for (const s of ['Bidding', 'Approved', 'New', 'Pending Approval']) assert.ok(isOpen(cfg, deal({ status_name: s })), s);
  for (const s of ['Won', 'Delivered']) { const o = deal({ status_name: s }); assert.ok(isWon(cfg, o) && !isOpen(cfg, o), s); }
  assert.ok(isLost(cfg, deal({ status_name: 'Lost' })));
});

test('status names match ignoring case and spaces', () => {
  assert.ok(isWon(cfg, deal({ status_name: '  delivered ' })));
  assert.ok(isOpen(cfg, deal({ status_name: 'pending  approval' })));
});

test('blank or unrecognized status is unknown: not open, won or lost, not weighted, and flagged', () => {
  for (const s of [null, '', 'On Hold']) {
    const o = deal({ status_name: s });
    assert.ok(isUnknown(cfg, o) && !isOpen(cfg, o) && !isWon(cfg, o) && !isLost(cfg, o), String(s));
    assert.equal(weighted(cfg, o), 0);
    assert.ok(rowIssues(cfg, o, '2026-10-01').some((i) => /status/i.test(i.t)));
    assert.equal(flag(cfg, o, '2026-10-01'), 'y');
  }
});

test('the open number: Delivered work never inflates it', () => {
  const rows = [deal({ status_name: 'Bidding', estimated_dollars: 100 }), deal({ status_name: 'Delivered', estimated_dollars: 5000, won_dollars: 5000 }),
    deal({ status_name: 'Won', estimated_dollars: 700, won_dollars: 650 }), deal({ status_name: '', estimated_dollars: 900 })];
  assert.equal(sum(rows.filter((o) => isOpen(cfg, o))), 100);
  assert.equal(sum(rows.filter((o) => isWon(cfg, o))), 5650, 'won work counts what it was won for');
});

test('a rep not on the roster still shows, counted and flagged unassigned', () => {
  const o = deal({ member_id: null, sales_rep_name: 'Matthew Royer' });
  assert.equal(o.unassigned, true);
  assert.equal(o.owner_member_id, null);
  assert.equal(o.rep_name, 'Matthew Royer');
  assert.ok(isOpen(cfg, o));
  assert.ok(rowIssues(cfg, o, '2026-10-01').some((i) => /not on the roster/.test(i.t)));
});

test('old won and lost work stays quiet on Data Check; live work is checked', () => {
  assert.deepEqual(rowIssues(cfg, deal({ status_name: 'Won', won_date: '2023-05-01', member_id: null }), '2026-10-01'), []);
  assert.ok(rowIssues(cfg, deal({ status_name: 'Won', won_date: '2026-05-01' }), '2026-10-01').some((i) => /no start date/.test(i.t)));
  assert.ok(rowIssues(cfg, deal({ status_name: 'Approved', anticipated_close_date: '2026-09-01' }), '2026-10-01').some((i) => i.sev === 'r'));
});

test('divisions map to categories: config first, then the same name, then without a trailing s', () => {
  assert.equal(categoryFor(cfg, 'Maintenance'), 'Maintenance');
  assert.equal(categoryFor(cfg, 'Enhancements'), 'Enhancement');
  assert.equal(categoryFor(cfg, 'construction'), 'Install');
  assert.equal(categoryFor(cfg, 'Snow'), 'Snow');
  assert.equal(deal({ division_name: 'Maintenance' }).recurring, true);
  assert.equal(deal({ division_name: 'Snow' }).category_mapped, false);
});

test('a workspace without a pipeline block keeps its typed stages', () => {
  const typed = normalize({ id: 'w', stages: [{ name: '6 - Won', status: 'won' }], tabs: [] });
  assert.equal(typed.pipelineSource, 'summit');
  assert.ok(typed.stageBy['6 - Won']);
  assert.ok(isOpen(typed, { stage: 'whatever' }), 'typed rows keep the old default');
});

test('auto-filled commits: won and starts come from Aspire; bids do not, because Aspire has no bid date', () => {
  const c = normalize({ id: 'w', pipeline: PIPELINE, categories: [], tabs: [], measures: [
    { key: 'bidsN', auto: 'bids_count' }, { key: 'wonD', type: 'money', auto: 'won_value' }, { key: 'startsD', type: 'money', auto: 'starts_next_week_value' }] });
  const won = fromAspire(c, row({ status_name: 'Won', won_dollars: 800, won_date: '2026-09-24', start_date: '2026-10-01' }));
  const a = autoDid(c, [{ ...won, owner_member_id: 'm1' }], 'm1', '2026-09-29');
  assert.equal(a.wonD, 800);
  assert.equal(a.startsD, 800);
  assert.equal('bidsN' in a, false, 'left for the rep to type');
});

// migration 009's rules
const RULES = { ...PIPELINE,
  divisions: [{ match: 'Maintenance', category: 'Maintenance' }, { match: 'Enhancement', category: 'Enhancement' }, { match: 'Construction', category: 'Install' }],
  win_rate: 'properties',
  exclude: { names: ['John Test Property', 'Test All Out Door', 'Billy Bob Residence TEST'], words: ['test', 'sample'] } };
const cfg9 = normalize({ id: 'w', pipeline: RULES, categories: [{ name: 'Maintenance', recurring: true }, { name: 'Install' }, { name: 'Enhancement' }], tabs: [] });
const d9 = (o) => fromAspire(cfg9, row(o));

test('any division containing Maintenance is recurring; everything else is one-time', () => {
  for (const d of ['COM - Maintenance', 'RES - Maintenance']) assert.equal(d9({ division_name: d }).recurring, true, d);
  for (const d of ['COM - Enhancements', 'RES - Enhancements', 'COM - Construction', 'RES - Construction', 'IRR - Irrigation', 'PHC - Plant health Care', 'SNW - Snow', 'Indirect'])
    assert.equal(d9({ division_name: d }).recurring, false, d);
  assert.equal(d9({ division_name: 'RES - Enhancements' }).category, 'Enhancement');
  assert.equal(d9({ division_name: 'COM - Construction' }).category, 'Install');
  assert.equal(d9({ division_name: 'SNW - Snow' }).category, 'SNW - Snow');
});

test('signed this year splits into recurring and one-time', () => {
  const won = [d9({ status_name: 'Won', division_name: 'COM - Maintenance', won_dollars: 700, won_date: '2026-03-01' }),
    d9({ status_name: 'Delivered', division_name: 'RES - Enhancements', won_dollars: 300, won_date: '2026-04-01' })];
  assert.equal(sum(won.filter((o) => o.recurring)), 700);
  assert.equal(sum(won.filter((o) => !o.recurring)), 300);
});

test('all_recurring: the new maintenance goal counts every recurring dollar won inside the goal window', () => {
  const cfg9 = normalize({ id: 'w', pipeline: { ...RULES, new_maintenance_basis: 'all_recurring' }, categories: [{ name: 'Maintenance', recurring: true }, { name: 'Install' }, { name: 'Enhancement' }], tabs: [] });
  const d9 = (o) => fromAspire(cfg9, row(o));
  const tile = { source: 'won_recurring', deadline: 'deadline', start: 'newMaintStart' };
  const rows = [
    d9({ opportunity_id: 1, status_name: 'Won', division_name: 'COM - Maintenance', won_dollars: 100, won_date: '2026-07-15' }),
    d9({ opportunity_id: 2, status_name: 'Won', division_name: 'COM - Maintenance', won_dollars: 200, won_date: '2026-06-01' }),
    d9({ opportunity_id: 3, status_name: 'Won', division_name: 'COM - Maintenance', won_dollars: 400, won_date: '2026-10-05' }),
    d9({ opportunity_id: 4, status_name: 'Won', division_name: 'COM - Enhancements', won_dollars: 800, won_date: '2026-08-01' }),
    d9({ opportunity_id: 5, status_name: 'Bidding', division_name: 'COM - Maintenance', estimated_dollars: 1600 }),
  ];
  assert.equal(goalActual(cfg9, tile, { deadline: '2026-09-30', newMaintStart: '2026-07-09' }, rows, [], '2026'), 100);
  assert.equal(goalActual(cfg9, tile, { deadline: '2026-09-30' }, rows, [], '2026'), 300, 'no start set: the window opens Jan 1 of the goal period');
});

test('win rate by property: renewals and change orders count once; the tile can be switched off', () => {
  const won = [d9({ property_name: 'Oak HOA' }), d9({ property_name: 'Oak HOA' }), d9({ property_name: ' oak hoa ' }), d9({ property_name: 'Elm Park' })];
  const lost = [d9({ property_name: 'Pine Ridge' }), d9({ property_name: 'Oak HOA' })];
  assert.deepEqual(winRateOf(cfg9, won, lost), { w: 2, l: 1, unit: 'properties' });
  assert.deepEqual(winRateOf(cfg, won, lost), { w: 4, l: 2, unit: '' }, 'deals, when the config says nothing');
  assert.equal(winRateOf({ winRate: 'off' }, won, lost), null);
});

test('test data is excluded by exact name or whole word, and only then', () => {
  for (const p of ['John Test Property', 'test all out door', 'Billy Bob Residence TEST', 'Sample Street HOA', 'The Test Site'])
    assert.ok(isExcluded(cfg9, { property_name: p, opportunity_name: 'Mulch' }), p);
  assert.ok(isExcluded(cfg9, { property_name: 'Oak HOA', opportunity_name: 'Sample estimate' }), 'opportunity name counts too');
  for (const p of ['Contest Park', 'Testa Farms', 'Samples Hardware', 'Oak HOA'])
    assert.equal(isExcluded(cfg9, { property_name: p, opportunity_name: 'Mulch' }), false, p);
  assert.equal(isExcluded(cfg, { property_name: 'Test HOA' }), false, 'no exclude list, nothing excluded');
});

// migration 010: new maintenance means properties new to the book
test('new_properties is the default for Aspire workspaces; typed workspaces keep all recurring', () => {
  assert.equal(cfg9.newMaintenanceBasis, 'new_properties');
  assert.equal(normalize({ id: 'w', tabs: [] }).newMaintenanceBasis, 'all_recurring');
});

test('new_properties: renewals of contracts already in the book do not count toward new maintenance', () => {
  const tile = { source: 'won_recurring', deadline: 'deadline', start: 'newMaintStart' };
  const g = { deadline: '2026-09-30', newMaintStart: '2026-07-09' };
  let id = 0;
  const w = (prop, date, dollars, extra = {}) => d9({ opportunity_id: ++id, property_name: prop, status_name: 'Won', division_name: 'COM - Maintenance', won_dollars: dollars, won_date: date, ...extra });
  const rows = [
    w('Oak HOA', '2025-04-01', 50),           // Oak was already in the book
    w('Oak HOA', '2026-08-01', 60),           //   so its renewal in the window does not count
    w('Elm Park', '2026-07-20', 100),         // Elm is new in the window
    w('Elm Park', '2026-09-01', 30),          //   and its add-on in the window counts too
    w('Pine Ridge', '2026-03-01', 0, { division_name: 'COM - Enhancements' }), // one-time work before: still new to maintenance
    w('Pine Ridge', '2026-08-15', 200),
    w('Ash Court', null, 70),                 // won recurring, no date: history, so Ash is not new
    w('Ash Court', '2026-08-02', 40),
    w('Birch Way', '2026-10-05', 500),        // won after the deadline: not in the window
  ];
  const det = goalDetail(cfg9, tile, g, rows, [], '2026');
  assert.equal(det.actual, 330);
  assert.equal(det.properties, 2);
  assert.equal(det.renewals, 100, 'Oak 60 and Ash 40 were in the window but not new');
  assert.equal(goalActual(cfg9, tile, g, rows, [], '2026'), 330);
});

test('one property is one property: PropertyID wins over the name', () => {
  const tile = { source: 'won_recurring', deadline: 'deadline', start: 'newMaintStart' };
  const g = { deadline: '2026-09-30', newMaintStart: '2026-07-09' };
  const rows = [
    d9({ opportunity_id: 1, property_id: '55', property_name: 'Oak HOA', status_name: 'Won', won_dollars: 50, won_date: '2025-01-01' }),
    d9({ opportunity_id: 2, property_id: '55', property_name: 'Oak H.O.A.', status_name: 'Won', won_dollars: 60, won_date: '2026-08-01' }),
    d9({ opportunity_id: 3, property_id: '77', property_name: 'Oak HOA', status_name: 'Won', won_dollars: 90, won_date: '2026-08-01' }),
  ];
  assert.equal(goalActual(cfg9, tile, g, rows, [], '2026'), 90, 'a renamed renewal is still a renewal; a namesake is new');
});

test('history is the whole workspace, not the screen scope', () => {
  const prior = d9({ opportunity_id: 1, member_id: 'other', status_name: 'Won', won_dollars: 50, won_date: '2025-01-01' });
  const mine = d9({ opportunity_id: 2, member_id: 'me', status_name: 'Won', won_dollars: 60, won_date: '2026-08-01' });
  const tile = { source: 'won_recurring', deadline: 'deadline', start: 'newMaintStart' };
  const g = { deadline: '2026-09-30', newMaintStart: '2026-07-09' };
  assert.equal(goalDetail(cfg9, tile, g, [mine], [], '2026', [prior, mine]).actual, 0);
  assert.equal(newPropertyTest(cfg9, [prior], '2026-07-09')(mine), false);
});
