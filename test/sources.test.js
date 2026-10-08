// One board for every source: a CRM, a file, or deals typed in Summit. And a workspace's teams, measures
// and words from config, so a new kind of client is config, not code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, mLabel, teamMeasures, dealSource } from '../src/data/workspace.js';
import { fromAspire, fromDeal, aspireToBoard, toDealPatch } from '../src/data/pipeline.js';
import { autoDidRows, reachedOn, isOpen, isUnknown, rowIssues } from '../src/lib/rules.js';
import { advancedIn, repGroups } from '../src/lib/summit.js';
import { parseCsv, csvRecords, guessMapping, slimRows } from '../src/lib/csv.js';

const PIPELINE = { source: 'aspire', statuses: [{ name: 'Bidding', status: 'open', prob: 0.4 }, { name: 'Won', status: 'won', prob: 1 }, { name: 'Lost', status: 'lost' }] };
const elev = normalize({ id: 'e', pipeline: PIPELINE, categories: [{ name: 'Maintenance', recurring: true }], tabs: ['summit', 'grow', 'netnew', { key: 'datacheck', crm_label: 'Aspire' }] },
  { id: 1, mode: 'connected', connector: 'aspire', label: 'Aspire' });

test('the source: from deal_sources when 012 has run, from the old pipeline config before', () => {
  assert.equal(elev.source.mode, 'connected');
  assert.equal(elev.readOnly, true);
  assert.equal(dealSource({ pipeline: { source: 'aspire' } }, null).mode, 'connected');
  assert.equal(dealSource({ pipeline: {} }, null).mode, 'native');
  assert.equal(dealSource({}, { mode: 'csv', label: 'CSV upload' }).label, 'CSV upload');
  // a csv source reads its statuses from config like a connector, and is read only
  const c = normalize({ pipeline: PIPELINE }, { mode: 'csv', label: 'CSV upload' });
  assert.equal(c.readOnly, true);
  assert.deepEqual(c.stages.map((s) => s.name), ['Bidding', 'Won', 'Lost']);
  assert.equal(c.crmLabel, 'CSV upload');
});

test('a deal_board row reads the same as the aspire_pipeline row it replaced', () => {
  const r = { opportunity_id: 7, opportunity_number: 707, property_name: 'Oak HOA', opportunity_name: 'Mulch', property_id: '55', sales_rep_name: 'Greg Hill',
    member_id: 'm1', branch_name: 'Oakwood', division_name: 'Maintenance', status_name: 'Won', estimated_dollars: 1000, won_dollars: 900,
    start_date: '2026-10-20', anticipated_close_date: '2026-10-01', won_date: '2026-09-30', lost_date: null, aspire_modified_at: '2026-09-30T10:00:00',
    created_date: '2026-09-01', end_date: '2027-09-30', renewal_date: null };
  const board = { ...aspireToBoard(r), deal_id: 'uuid-7' };
  const a = fromAspire(elev, r), d = fromDeal(elev, board, 'connected');
  assert.deepEqual({ ...d, id: a.id }, a);
  assert.equal(d.readOnly, true);
  assert.equal(d.value, 900, 'won work at what it was won for');
  // a status the config does not know is unknown, never open, for any read-only source
  assert.ok(isUnknown(elev, fromDeal(elev, { ...board, stage: 'Weird' }, 'csv')));
});

const ws = normalize({
  id: 'n', stages: [{ name: 'Conversation' }, { name: 'Meeting booked' }, { name: 'Meeting sat' }, { name: 'Proposal out', bid: true }, { name: 'Signed', status: 'won' }, { name: 'Lost', status: 'lost' }],
  measures: [{ key: 'conv', label: 'Conversations' }, { key: 'booked', label: 'Meetings booked', auto: { stage_entered: 'Meeting booked' } },
    { key: 'sat', label: 'Meetings sat', auto: { stage_entered: 'Meeting sat' } }, { key: 'signedD', type: 'money', label: 'Signed $', auto: { stage_entered: 'Signed', sum: 'value' } },
    { key: 'src', label: 'Sourced meetings' }],
  tabs: [{ key: 'summit', filters: [] }, { key: 'pipeline', team: 'pipeline', measures: ['booked', 'sat', 'signedD'] },
    { key: 'sourcing', team: 'sourcing', measures: ['src'], labels: { src: 'Meetings booked' } }, 'accounts'],
}, { mode: 'native', label: 'Summit' });

test('teams come from config: any tab with a team, its own measures, its own words', () => {
  assert.deepEqual(ws.tabs.map((t) => t.key), ['summit', 'pipeline', 'sourcing', 'accounts']);
  assert.deepEqual(teamMeasures(ws, 'pipeline').map((m) => m.key), ['booked', 'sat', 'signedD']);
  assert.deepEqual(teamMeasures(ws, 'sourcing').map((m) => m.key), ['src']);
  assert.deepEqual(teamMeasures(ws, 'nobody').map((m) => m.key), ['conv', 'booked', 'sat', 'signedD', 'src'], 'no list: every measure');
  const src = ws.measures.find((m) => m.key === 'src');
  assert.equal(mLabel(src, 'sourcing'), 'Meetings booked', 'the tab says it its way');
  assert.equal(mLabel(src), 'Sourced meetings', 'company-wide it keeps its own name');
  // Elevation's two labels still read as before
  const e = normalize({ measures: [{ key: 'a', label: 'Site audits', label_grow: 'Site audits', label_netnew: 'Site walks' }], tabs: ['grow', 'netnew'] });
  assert.equal(mLabel(e.measures[0]), 'Site audits / Site walks');
  assert.equal(mLabel(e.measures[0], 'netnew'), 'Site walks');
  assert.deepEqual(e.tabs.map((t) => t.team), ['grow', 'netnew']);
  assert.equal(ws.byBranch, false, 'no branches, no branch table');
  assert.deepEqual(ws.filters, [], 'no division or kind filter when config says none');
});

test('stage-entry measures: a deal counts the week it first reaches the stage or past it, never twice', () => {
  const o = { id: 'd1', owner_member_id: 'm', value: 5000, stage: 'Signed', stage_events: [
    { d: '2026-09-25', stage: 'Conversation' }, { d: '2026-10-01', stage: 'Meeting sat' }, { d: '2026-10-08', stage: 'Signed' }] };
  assert.equal(reachedOn(ws, o, 'Meeting booked'), '2026-10-01', 'skipping a stage still reaches it');
  assert.equal(reachedOn(ws, o, 'Conversation'), '2026-09-25');
  const w1 = autoDidRows(ws, [o], '2026-10-06'), w2 = autoDidRows(ws, [o], '2026-10-13');
  assert.deepEqual([w1.booked, w1.sat, w1.signedD], [1, 1, 0]);
  assert.deepEqual([w2.booked, w2.sat, w2.signedD], [0, 0, 5000], 'signed in dollars, the week it signed');
  // lost is not past anything; a deal that went back and forward again counts once
  const lost = { id: 'd2', stage: 'Lost', stage_events: [{ d: '2026-10-01', stage: 'Conversation' }, { d: '2026-10-02', stage: 'Lost' }] };
  assert.equal(reachedOn(ws, lost, 'Meeting booked'), null);
  const back = { id: 'd3', stage: 'Meeting sat', stage_events: [{ d: '2026-10-01', stage: 'Meeting sat' }, { d: '2026-10-02', stage: 'Meeting booked' }, { d: '2026-10-09', stage: 'Meeting sat' }] };
  assert.equal(autoDidRows(ws, [back], '2026-10-06').sat + autoDidRows(ws, [back], '2026-10-13').sat, 1);
  // no history yet: the current stage from its stage date
  assert.equal(reachedOn(ws, { stage: 'Meeting booked', stage_date: '2026-10-03' }, 'Meeting booked'), '2026-10-03');
});

test('pipeline advanced: forward moves in the period, not the first stage, not a loss', () => {
  const p = { start: '2026-10-01', end: '2026-10-31' };
  const rows = [
    { id: 1, value: 10, stage_events: [{ d: '2026-09-20', stage: 'Conversation' }, { d: '2026-10-03', stage: 'Meeting booked' }] },
    { id: 2, value: 20, stage_events: [{ d: '2026-10-03', stage: 'Meeting sat' }] },
    { id: 3, value: 30, stage_events: [{ d: '2026-10-01', stage: 'Meeting sat' }, { d: '2026-10-04', stage: 'Lost' }] },
    { id: 4, value: 40, stage_events: [{ d: '2026-09-01', stage: 'Conversation' }, { d: '2026-09-03', stage: 'Signed' }] },
  ];
  assert.deepEqual(advancedIn(ws, rows, p).map((o) => o.id), [1]);
});

test('without branches, the Summit table is by rep, and every deal lands on one row', () => {
  const reps = [{ id: 'a', full_name: 'Ana' }, { id: 'b', full_name: 'Bo' }];
  const g = repGroups([{ owner_member_id: 'a' }, { owner_member_id: 'b' }, { owner_member_id: 'a' }, { owner_member_id: null }], reps);
  assert.deepEqual(g.map((x) => [x.branch, x.rows.length]), [['Ana', 2], ['Bo', 1], ['', 1]]);
});

test('a typed deal: deals columns in, the board shape out, and back', () => {
  const o = fromDeal(ws, { id: 'x', workspace_id: 'n', account: 'Acme', owner_member_id: 'm', stage: 'Signed', value_estimated: 7000, won_date: '2026-10-02', external_number: 'Q-1', priority: true }, 'native');
  assert.equal(o.readOnly, false);
  assert.equal(o.value, 7000);
  assert.equal(o.actual_close, '2026-10-02');
  assert.equal(o.crm_ref, 'Q-1');
  assert.deepEqual(toDealPatch({ value: 5, actual_close: '2026-10-03', crm_ref: 'Z', pipeline: 'grow', recurring: true, stage: 'Lost' }),
    { value_estimated: 5, won_date: '2026-10-03', external_number: 'Z', stage: 'Lost' }, 'fields deals does not keep are dropped');
  assert.ok(isOpen(ws, { ...o, stage: 'Conversation' }));
  assert.ok(rowIssues(ws, { ...o, stage: 'Conversation', next_step: '' }, '2026-10-07').some((i) => i.t === 'No next step'), 'typed deals get the typed checks');
});

test('CSV: quotes, commas, line breaks in a cell, a byte order mark, tabs', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"two\nlines",3\n\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', '3']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  const { headers, records } = csvRecords('Deal ID,Company,,Company\n1,Acme,z,dup\n');
  assert.deepEqual(headers, ['Deal ID', 'Company', 'Column 3', 'Company (2)']);
  assert.equal(records[0]['Company (2)'], 'dup');
});

test('CSV columns: guessed by name, or the saved mapping when the file has every column it names', () => {
  const h = ['Deal ID', 'Company', 'Deal Owner', 'Stage', 'Amount', 'Close Date', 'Created', 'Notes'];
  const g = guessMapping(h, {});
  assert.equal(g.fromSaved, false);
  assert.deepEqual(g.mapping, { external_id: 'Deal ID', account: 'Company', rep_name: 'Deal Owner', stage: 'Stage', value_estimated: 'Amount', close_date: 'Close Date', created_date: 'Created' });
  const saved = { external_id: 'Deal ID', account: 'Company', value_estimated: 'Amount' };
  assert.deepEqual(guessMapping(h, saved), { mapping: saved, fromSaved: true }, 'one click next time');
  assert.equal(guessMapping(['ID', 'Company'], saved).fromSaved, false, 'a column gone: map again');
  assert.deepEqual(slimRows([{ 'Deal ID': '1', Company: 'A', Notes: 'long text' }], saved), [{ 'Deal ID': '1', Company: 'A', Amount: '' }], 'only mapped columns travel');
});
