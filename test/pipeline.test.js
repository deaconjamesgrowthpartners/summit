// The board reading Aspire: the status map comes from config, Delivered is sold work, and no deal
// drops out of the counts because its rep or status is unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/data/workspace.js';
import { fromAspire, categoryFor } from '../src/data/pipeline.js';
import { isOpen, isWon, isLost, isUnknown, weighted, sum, rowIssues, flag, autoDid } from '../src/lib/rules.js';

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
