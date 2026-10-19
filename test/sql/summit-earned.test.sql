-- Migration 018 on top of 017: earned snapshots, Delivered as a proposal, stage ranks, Indirect off the board,
-- the billing schedule on each deal, and deal_motion.
\set ON_ERROR_STOP on
do $$
declare src bigint := (select id from deal_sources where connector = 'aspire');
begin
  -- a deal with a billing schedule and earned revenue, one in Indirect, one Delivered
  update deals set raw = raw || '{"ActualEarnedRevenue": "9555", "OpportunityBillings": [
      {"Active": true, "BillMonth": 4, "SortOrder": 1, "InvoiceAmount": 1516.67},
      {"Active": false, "BillMonth": 5, "SortOrder": 2, "InvoiceAmount": 999},
      {"Active": true, "BillMonth": 5, "SortOrder": 3, "InvoiceAmount": 1516.67},
      {"Active": true, "BillMonth": "x", "SortOrder": 4, "InvoiceAmount": 5}]}'::jsonb
   where source_id = src and external_id = '11';
  insert into deals (workspace_id, source_id, external_id, account, stage, division, value_estimated, value_won, raw)
  values ('00000000-0000-0000-0000-00000000000e', src, '9001', 'Shop overhead', 'Won', 'Indirect', 0, 0, '{}'),
         ('00000000-0000-0000-0000-00000000000e', src, '9002', 'Proposal Co', 'Delivered', 'COM - Maintenance', 5000, 5000, '{}')
  on conflict do nothing;
end $$;
\i :mig18
\i :mig18
do $$
declare ws uuid := '00000000-0000-0000-0000-00000000000e'; src bigint := (select id from deal_sources where connector = 'aspire');
  d uuid; n int; r record;
begin
  -- Delivered is a proposal out, and the ranks are set
  select status into r from deal_board where workspace_id = ws and external_id = '9002';
  assert r.status = 'open', 'Delivered counts as open';
  assert deal_stage_rank((select pipeline from workspaces where id = ws), ' delivered ') = 3, 'rank, ignoring case and spaces';
  assert deal_stage_rank((select pipeline from workspaces where id = ws), 'Lost') is null, 'Lost has no rank';
  assert (select count(*) from jsonb_array_elements((select pipeline -> 'statuses' from workspaces where id = ws))) = 7, 'no status lost or added';
  -- Indirect is excluded, still on the board for Data Check
  assert (select excluded from deal_board where external_id = '9001'), 'Indirect excluded';
  assert not (select excluded from deal_board where external_id = '9002'), 'others are not';
  -- the billing schedule: active, well-formed lines, in order
  assert (select billing from deal_board where external_id = '11') = '[[4, 1516.67], [5, 1516.67]]'::jsonb, 'billing ' || (select billing::text from deal_board where external_id = '11');
  assert (select billing from deal_board where external_id = '9002') is null, 'no schedule, null';
  -- earned is snapshotted today
  assert (select s.earned from deal_snapshots s join deals x on x.id = s.deal_id where x.external_id = '11' and s.snap_date = (now() at time zone 'America/New_York')::date) = 9555, 'earned snapshotted';
  -- an earned target is allowed
  insert into summit_targets (workspace_id, month, metric, amount) values (ws, date_trunc('month', current_date), 'earned', 1000)
  on conflict do nothing;

  -- deal_motion, over a made-up week of nights for one deal: New, Bidding, Approved (same stage), Delivered, Lost
  select id into d from deals where external_id = '9002';
  delete from deal_snapshots where deal_id = d;
  insert into deal_snapshots (deal_id, workspace_id, snap_date, stage, earned) values
    (d, ws, '2026-09-28', 'New', null), (d, ws, '2026-09-29', 'Bidding', 100), (d, ws, '2026-09-30', 'Approved', 120),
    (d, ws, '2026-10-01', 'Delivered', 150), (d, ws, '2026-10-02', 'Lost', 150), (d, ws, '2026-10-05', 'Won', 400);
  select * into r from deal_motion(ws, '2026-09-30', '2026-10-01') where deal_id = d;
  assert r.earned = 50, 'earned in the period: last night in it less the last night before it, got ' || r.earned;
  assert r.advanced_on = '2026-10-01', 'Approved inside Estimate is no stage; Delivered is';
  select * into r from deal_motion(ws, '2026-09-28', '2026-09-28') where deal_id = d;
  assert not found, 'the first night is not a move, and no earned yet';
  select * into r from deal_motion(ws, '2026-09-29', '2026-09-29') where deal_id = d;
  assert r.advanced_on = '2026-09-29' and r.earned = 0, 'New to Bidding is a stage. First earned night counts from itself';
  select count(*) into n from deal_motion(ws, '2026-10-02', '2026-10-02') where deal_id = d;
  assert n = 0, 'going to Lost is not advancing';
  select * into r from deal_motion(ws, '2026-10-03', '2026-10-31') where deal_id = d;
  assert r.advanced_on = '2026-10-05' and r.earned = 250, 'Lost to Won is a move up; earned 150 to 400';
  -- sliding back and returning is not advancing
  insert into deal_snapshots (deal_id, workspace_id, snap_date, stage) values (d, ws, '2026-10-06', 'Delivered'), (d, ws, '2026-10-07', 'Won');
  select count(*) into n from deal_motion(ws, '2026-10-06', '2026-10-07') where deal_id = d and advanced_on is not null;
  assert n = 0, 'back to Won after Won is not a new stage';

  -- only members see it
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000ff', true);
  set local role authenticated;
  assert (select count(*) from deal_motion(ws, '2026-09-01', '2026-10-31')) = 0, 'a stranger sees nothing';
  reset role;
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000a1', true);
  set local role authenticated;
  assert (select count(*) from deal_motion(ws, '2026-09-01', '2026-10-31')) >= 1, 'a member sees their workspace';
  reset role;
  set local role anon;
  begin perform deal_motion(ws, '2026-09-01', '2026-10-31'); assert false, 'anon refused';
  exception when insufficient_privilege then null; end;
  reset role;
  raise notice '018 checks passed';
end $$;
