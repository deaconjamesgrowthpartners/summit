// The Summit tab rebuild: the period toggle, targets, net new, the tiles, renewals, branch rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/data/workspace.js';
import { fromAspire } from '../src/data/pipeline.js';
import { netNewTest, divisionOf, autoDidRows, sum } from '../src/lib/rules.js';
import { periodRange, monthsIn, weeksIn, targetFor, inPeriod } from '../src/lib/period.js';
import { metricRows, metricValue, filterDeals, split, renewalsIn, forecastByMonth, branchGroups, repBreakdown } from '../src/lib/summit.js';

const cfg = normalize({
  id: 'w', crm_source: 'aspire', lock_dow: 2,
  pipeline: { source: 'aspire', statuses: [
    { name: 'Bidding', status: 'open', prob: 0.4 }, { name: 'Won', status: 'won', prob: 1 }, { name: 'Delivered', status: 'won', prob: 1 }, { name: 'Lost', status: 'lost', prob: 0 }],
    divisions: [{ match: 'Maintenance', category: 'Maintenance' }, { match: 'Enhancement', category: 'Enhancement' }, { match: 'Construction', category: 'Install' }] },
  categories: [{ name: 'Maintenance', recurring: true }, { name: 'Install' }, { name: 'Enhancement' }],
  measures: [{ key: 'bidsN', auto: 'bids_count' }, { key: 'audits' }],
  tabs: [{ key: 'datacheck', crm_label: 'Aspire' }],
});
let id = 1;
const deal = (o) => fromAspire(cfg, { opportunity_id: id++, property_name: 'Oak HOA', property_id: null, sales_rep_name: 'Greg Hill', member_id: 'm1',
  branch_name: 'Oakwood', division_name: 'COM - Maintenance', status_name: 'Bidding', estimated_dollars: 1000, won_dollars: null, ...o });
// Friday Oct 2 2026; the lock week runs Wed Sep 30 to Tue Oct 6
const w = { today: '2026-10-02', start: '2026-09-30', key: '2026-10-06', scoreKey: '2026-09-29', year: 2026 };

test('Week is the lock week, Month, Quarter and Year are calendar periods', () => {
  assert.deepEqual([periodRange('week', w).start, periodRange('week', w).end], ['2026-09-30', '2026-10-06']);
  assert.deepEqual([periodRange('month', w).start, periodRange('month', w).end], ['2026-10-01', '2026-10-31']);
  assert.deepEqual([periodRange('quarter', w).start, periodRange('quarter', w).end, periodRange('quarter', w).label], ['2026-10-01', '2026-12-31', 'Q4 2026']);
  assert.deepEqual([periodRange('year', w).start, periodRange('year', w).end], ['2026-01-01', '2026-12-31']);
  assert.equal(periodRange('nonsense', w).kind, 'month', 'default is Month');
  const feb = periodRange('month', { ...w, today: '2028-02-10' });
  assert.equal(feb.end, '2028-02-29', 'leap year');
  assert.ok(inPeriod('2026-10-31T23:00:00', periodRange('month', w)));
});

test('the weeks a period adds up: lock weeks that end inside it, up to the week on screen', () => {
  assert.deepEqual(weeksIn(periodRange('week', w), w), ['2026-09-29'], 'Week is the scored week, as The Climb has always read');
  assert.deepEqual(weeksIn(periodRange('month', w), w), ['2026-10-06'], 'Oct 2: the only October week is this one');
  const q3 = { ...w, today: '2026-09-30', key: '2026-10-06' };
  assert.equal(weeksIn(periodRange('quarter', q3), q3).length, 13, 'Q3 2026 has 13 Tuesdays');
});

test('targets: monthly, a share of the month for a week, the company row before the branch rows', () => {
  const T = [
    { branch: '', month: '2026-10-01', metric: 'closed', division: 'all', kind: 'all', amount: 310000 },
    { branch: 'Oakwood', month: '2026-10-01', metric: 'closed', division: 'all', kind: 'all', amount: 100000 },
    { branch: 'Oakwood', month: '2026-11-01', metric: 'closed', division: 'all', kind: 'all', amount: 90000 },
    { branch: 'Knoxville', month: '2026-11-01', metric: 'closed', division: 'all', kind: 'all', amount: 60000 },
  ];
  const q = { metric: 'closed' };
  assert.equal(targetFor(T, q, periodRange('month', w)), 310000, 'company row wins');
  assert.equal(targetFor(T, { ...q, branch: 'Oakwood' }, periodRange('month', w)), 100000);
  assert.equal(targetFor(T, q, periodRange('quarter', w)), 310000 + 150000, 'November has no company row: the branches add up');
  assert.equal(Math.round(targetFor(T, q, periodRange('week', w))), Math.round(310000 * 6 / 31), 'Oct 1 to Oct 6 of October; Sep 30 has no target');
  assert.equal(targetFor(T, { ...q, division: 'maintenance' }, periodRange('month', w)), null, 'no target set, never 0');
  assert.equal(targetFor(T, { metric: 'created' }, periodRange('year', w)), null);
  assert.equal(targetFor([], q, periodRange('month', w)), null);
  assert.deepEqual(monthsIn(periodRange('week', w)).map((m) => m.month), ['2026-09-01', '2026-10-01']);
});

test('net new: the property had no won deal in any division before this one; everything else is enhancement', () => {
  const first = deal({ property_name: 'Elm HOA', status_name: 'Won', won_dollars: 5000, won_date: '2026-03-01', division_name: 'COM - Construction' });
  const later = deal({ property_name: 'Elm HOA', status_name: 'Won', won_dollars: 900, won_date: '2026-10-01', division_name: 'COM - Maintenance' });
  const openOn = deal({ property_name: 'Elm HOA', created_date: '2026-09-01' });
  const openEarly = deal({ property_name: 'Elm HOA', created_date: '2026-02-01' });
  const brandNew = deal({ property_name: 'Pine HOA', created_date: '2026-10-01' });
  const undated = deal({ property_name: 'Ash HOA', status_name: 'Won', won_dollars: 1, won_date: null });
  const ashNew = deal({ property_name: 'Ash HOA', status_name: 'Won', won_dollars: 1, won_date: '2026-10-01' });
  const isNew = netNewTest(cfg, [first, later, openOn, openEarly, brandNew, undated, ashNew]);
  assert.equal(isNew(first), true, 'the first won deal on a property is net new');
  assert.equal(isNew(later), false, 'a maintenance deal after a construction win is enhancement: every division counts');
  assert.equal(isNew(openOn), false, 'open work on a property already won is enhancement');
  assert.equal(isNew(openEarly), true, 'created before the first win: net new');
  assert.equal(isNew(brandNew), true);
  assert.equal(isNew(ashNew), false, 'a won deal with no won date counts as history');
  const pid1 = deal({ property_name: 'Same Name', property_id: '1', status_name: 'Won', won_date: '2026-01-01' });
  const pid2 = deal({ property_name: 'Same Name', property_id: '2', status_name: 'Won', won_date: '2026-05-01' });
  assert.equal(netNewTest(cfg, [pid1, pid2])(pid2), true, 'PropertyID tells two same-name properties apart');
  assert.equal(divisionOf(cfg, first), 'install');
  assert.equal(divisionOf(cfg, later), 'maintenance');
  assert.equal(divisionOf(cfg, deal({ division_name: 'RES - Enhancements' })), 'install', 'Install is everything that is not maintenance');
  const f = filterDeals(cfg, [first, later, brandNew], { division: 'maintenance', kind: 'enhancement' }, isNew);
  assert.deepEqual(f, [later]);
});

test('the tiles: closed by won date, created by created date at any status, forecast is won work not started', () => {
  const p = periodRange('month', w);
  const R = [
    deal({ status_name: 'Won', won_dollars: 800, estimated_dollars: 900, won_date: '2026-10-01', created_date: '2026-09-15', start_date: '2026-10-20' }),
    deal({ status_name: 'Delivered', won_dollars: 300, estimated_dollars: 300, won_date: '2026-10-02', created_date: '2026-10-01', start_date: '2026-10-02' }),
    deal({ status_name: 'Won', won_dollars: 5000, won_date: '2026-09-30', start_date: '2026-11-15' }),
    deal({ status_name: 'Bidding', estimated_dollars: 400, created_date: '2026-10-01' }),
    deal({ status_name: 'Lost', estimated_dollars: 200, created_date: '2026-10-02', lost_date: '2026-10-02' }),
    deal({ status_name: 'Mystery', estimated_dollars: 50, created_date: '2026-10-02' }),
  ];
  const closed = metricRows(cfg, 'closed', R, p, w.today);
  assert.equal(metricValue('closed', closed), 800 + 300, 'won dollars, Delivered counts, September does not');
  const created = metricRows(cfg, 'created', R, p, w.today);
  assert.equal(created.length, 4, 'Delivered, open, lost and the unmapped status: every deal created in October');
  assert.equal(metricValue('created', created), 300 + 400 + 200 + 50, 'at the estimate');
  const s = split(cfg, created);
  assert.deepEqual([s.open.n, s.won.n, s.lost.n, s.other.n], [1, 1, 1, 1]);
  const fc = metricRows(cfg, 'forecast', R, p, w.today);
  assert.equal(metricValue('forecast', fc), 800, 'starting Oct 20. Today is not ahead, November is past the period');
  assert.equal(metricValue('forecast', metricRows(cfg, 'forecast', R, periodRange('quarter', w), w.today)), 5800);
  const by = forecastByMonth(cfg, R, w.today, 3);
  assert.deepEqual(by.map((x) => [x.month, x.value]), [['2026-10-01', 800], ['2026-11-01', 5000], ['2026-12-01', 0]]);
});

test('renewals: RenewalDate where present, EndDate as the fallback, and each row says which', () => {
  const p = periodRange('quarter', w);
  const a = deal({ status_name: 'Won', won_dollars: 10, renewal_date: '2026-11-01', end_date: '2027-01-31' });
  const b = deal({ status_name: 'Won', won_dollars: 20, renewal_date: null, end_date: '2026-10-15' });
  const c = deal({ status_name: 'Won', won_dollars: 30, renewal_date: '2027-02-01', end_date: '2026-12-31' });
  const d = deal({ status_name: 'Bidding', end_date: '2026-10-10' });
  const r = renewalsIn(cfg, [a, b, c, d], p);
  assert.deepEqual(r.map((x) => [x.o.won_dollars, x.source, x.date]), [[20, 'end', '2026-10-15'], [10, 'renewal', '2026-11-01']],
    'the renewal date wins even when the end date is in the period; open deals are not contracts');
});

test('branch rows: every deal on exactly one row, unassigned under its own branch, with the CRM names', () => {
  const R = [
    deal({ branch_name: 'Sugar Hill', estimated_dollars: 500 }),
    deal({ branch_name: 'Sugar Hill', member_id: null, sales_rep_name: 'Matthew Royer', estimated_dollars: 695000 }),
    deal({ branch_name: 'Sugar Hill', member_id: null, sales_rep_name: 'Jamy August', estimated_dollars: 86000 }),
    deal({ branch_name: 'Oakwood', member_id: null, sales_rep_name: 'Jamy August', estimated_dollars: 53000 }),
    deal({ branch_name: null }),
    deal({ branch_name: 'Elsewhere' }),
  ];
  const g = branchGroups(R, ['Sugar Hill', 'Oakwood', 'Knoxville']);
  assert.deepEqual(g.map((x) => [x.branch, x.unassigned, x.rows.length]), [
    ['Sugar Hill', false, 1], ['Sugar Hill', true, 2], ['Oakwood', false, 0], ['Oakwood', true, 1], ['Knoxville', false, 0], ['', false, 2]]);
  assert.equal(sum(g.flatMap((x) => x.rows), (o) => 1), R.length, 'the rows add up to the tile');
  assert.deepEqual(repBreakdown(g[1].rows).map((x) => [x.name, x.value]), [['Matthew Royer', 695000], ['Jamy August', 86000]]);
});

test('an unassigned row gets the board numbers, never the typed ones', () => {
  const U = [deal({ member_id: null, created_date: '2026-09-28' })];
  const a = autoDidRows(cfg, U, '2026-09-29');
  assert.equal(a.bidsN, 1);
  assert.equal('audits' in a, false, 'site audits are typed, nobody types for an unassigned rep');
});
