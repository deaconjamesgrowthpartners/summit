// Migration 018 on the Summit tab: earned revenue from the nightly snapshots, the forecast from each contract's billing
// schedule, Delivered as a proposal, and whole divisions left off the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/data/workspace.js';
import { fromDeal, isExcluded } from '../src/data/pipeline.js';
import { isOpen, isWon, bidOut } from '../src/lib/rules.js';
import { billingLines, forecastValue, forecastRemaining, forecastByMonth, metricRows, metricValue } from '../src/lib/summit.js';
import { periodRange } from '../src/lib/period.js';

const cfg = normalize({ id: 'e', pipeline: { source: 'aspire', statuses: [
  { name: 'Approved', status: 'open', prob: 0.8, bid: true, rank: 2 },
  { name: 'Delivered', status: 'open', prob: 0.8, bid: true, needs_close: true, rank: 3 },
  { name: 'Won', status: 'won', prob: 1, rank: 4 }, { name: 'Lost', status: 'lost' }],
  exclude: { names: [], words: ['test'], divisions: ['Indirect'] } }, tabs: [{ key: 'datacheck', crm_label: 'Aspire' }] },
{ mode: 'connected', label: 'Aspire', connector: 'aspire' });
const deal = (o) => fromDeal(cfg, { deal_id: o.id || 'd1', account: 'Oak HOA', stage: 'Won', value_estimated: 1200, value_won: 1200, member_id: 'm1', ...o }, 'connected');
const w = { today: '2026-10-19', start: '2026-10-14', key: '2026-10-20' };

test('Delivered is a proposal out: open, a bid, never won', () => {
  const d = deal({ stage: 'Delivered', won_date: null });
  assert.ok(isOpen(cfg, d) && bidOut(cfg, d) && !isWon(cfg, d));
});

test('a whole division can be left off the board, by name, whatever its case', () => {
  assert.ok(isExcluded(cfg, { account: 'Shop', division: ' indirect ' }));
  assert.ok(isExcluded(cfg, { property_name: 'Shop', division_name: 'Indirect' }), 'the old Aspire shape too');
  assert.ok(!isExcluded(cfg, { account: 'Oak HOA', division: 'COM - Maintenance' }));
});

test('billing months land the first time they come round from the contract start', () => {
  const d = deal({ start_date: '2026-03-01', billing: [[3, 100], [12, 100], [1, 100], [2, 100]] });
  assert.deepEqual(billingLines(d).map((l) => l.month), ['2026-03-01', '2026-12-01', '2027-01-01', '2027-02-01']);
  assert.equal(billingLines(deal({ start_date: null, billing: [[1, 5]] })), null, 'no start date, no placing it');
  assert.equal(billingLines(deal({ start_date: '2026-03-01', billing: null })), null);
});

test('forecast: what is still to bill in the period, from this month, at its share of the period', () => {
  const d = deal({ start_date: '2026-04-01', billing: [[4, 100], [9, 100], [10, 310], [11, 300], [12, 300]] });
  const month = periodRange('month', w), quarter = periodRange('quarter', w), year = periodRange('year', w);
  assert.equal(forecastValue(d, month, w.today), 310, 'October, all of it');
  assert.equal(forecastValue(d, quarter, w.today), 910, 'October to December; September is billed already');
  assert.equal(forecastValue(d, year, w.today), 910);
  assert.equal(Math.round(forecastValue(d, periodRange('week', w), w.today)), 70, 'a week takes its 7 of 31 days of October');
  // no schedule: all of it in the month it starts, from tomorrow
  const u = deal({ id: 'u', start_date: '2026-10-25', billing: null });
  assert.equal(forecastValue(u, month, w.today), 1200);
  assert.equal(forecastValue(deal({ id: 'v', start_date: '2026-10-19' }), month, w.today), 0, 'started today: not ahead');
  // the tile and the totals
  const R = [d, u, deal({ id: 'open', stage: 'Approved', start_date: '2026-10-25' })];
  assert.equal(metricValue('forecast', metricRows(cfg, 'forecast', R, month, w.today), month, w.today), 1510, 'won work only');
  assert.equal(forecastRemaining(cfg, R, w.today), 910 + 1200);
  const by = forecastByMonth(cfg, R, w.today, 3);
  assert.deepEqual(by.map((b) => [b.month, b.value, b.n]), [['2026-10-01', 1510, 2], ['2026-11-01', 300, 1], ['2026-12-01', 300, 1]]);
});

test('earned: from deal_motion for the period, per deal, and only deals that earned', () => {
  const a = deal({ id: 'a' }), b = deal({ id: 'b' }), c = deal({ id: 'c' });
  const p = { ...periodRange('month', w), motion: { ok: true, earned: new Map([['a', 500], ['b', -20]]), advanced: new Map() } };
  const rows = metricRows(cfg, 'earned', [a, b, c], p, w.today);
  assert.deepEqual(rows.map((o) => o.id), ['a', 'b'], 'a correction in Aspire counts too, as it is');
  assert.equal(metricValue('earned', rows, p, w.today), 480);
  assert.deepEqual(metricRows(cfg, 'earned', [a], { ...p, motion: null }, w.today), [], 'still loading: nothing, never a guess');
});
