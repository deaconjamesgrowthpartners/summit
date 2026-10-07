-- Migration 012 on top of 011: every source in one deals table, Elevation's numbers unchanged.
\set ON_ERROR_STOP on
alter table workspaces add column if not exists stages jsonb;
-- the earlier tests typed columns straight into aspire_opps with raw = '{}'. Real rows carry the record their
-- columns came from, so put it back before 012 reads raw, or the parity check would rightly refuse.
update aspire_opps set raw = coalesce(raw, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
  'OpportunityID', opportunity_id, 'OpportunityNumber', opportunity_number, 'OpportunityName', opportunity_name,
  'PropertyName', property_name, 'SalesRepContactName', sales_rep_name, 'BranchName', branch_name, 'DivisionName', division_name,
  'OpportunityStatusName', status_name, 'EstimatedDollars', estimated_dollars, 'WonDollars', won_dollars, 'StartDate', start_date,
  'AnticipatedCloseDate', anticipated_close_date, 'WonDate', won_date, 'LostDate', lost_date));
create temp table _old as select * from aspire_pipeline;
\i :mig12
\i :mig12
do $$
declare ws uuid := '00000000-0000-0000-0000-00000000000e'; other uuid := '00000000-0000-0000-0000-00000000000f';
  src bigint; csv bigint; b jsonb; run bigint; n int;
begin
  -- one source per workspace, Aspire is a connector with its mapping in config
  select id into src from deal_sources where workspace_id = ws;
  assert (select mode || '/' || connector from deal_sources where id = src) = 'connected/aspire', 'Elevation is connected to Aspire';
  assert (select mapping->>'account' from deal_sources where id = src) = 'PropertyName', 'mapping is config';
  begin
    insert into deal_sources (workspace_id, mode, label) values (ws, 'native', 'Summit');
    assert false, 'a second source refused';
  exception when unique_violation then null; end;
  begin
    insert into deal_sources (workspace_id, mode, label) values (gen_random_uuid(), 'connected', 'x');
    assert false, 'connected without a connector refused';
  exception when check_violation or foreign_key_violation then null; end;

  -- the old view, row for row, now reads deals
  assert (select count(*) from aspire_pipeline) = (select count(*) from _old), 'same rows';
  assert not exists (
    select opportunity_id, status, estimated_dollars, won_dollars, member_id, excluded, property_id, created_date, start_date, won_date
      from _old except
    select opportunity_id, status, estimated_dollars, won_dollars, member_id, excluded, property_id, created_date, start_date, won_date
      from aspire_pipeline), 'every row the same';
  assert (select count(*) from deal_board where workspace_id = ws) = (select count(*) from _old where workspace_id = ws), 'deal_board matches';
  assert (select count(*) from aspire_status_snapshots) > 0, '011 snapshots moved';
  assert (select count(*) from aspire_sync_runs) = (select count(*) from source_runs), 'runs readable by the old name';

  -- the deployed aspire-sync still works through the old names, and writes deals
  b := aspire_sync_begin('elevation-outdoors', 'manual', true);
  run := (b->>'run_id')::bigint;
  perform aspire_sync_upsert(run, '[{"OpportunityID": 11, "OpportunityName": "Oak mulch", "SalesRepContactName": "Greg Hill",
    "OpportunityStatusName": "Bidding", "EstimatedDollars": 1300, "ModifiedDate": "2026-10-05T10:00:00"},
    {"OpportunityID": 501, "PropertyName": "New HOA", "OpportunityStatusName": "Won", "WonDollars": "$4,500", "WonDate": "10/3/2026",
     "ModifiedDate": "2026-10-05T11:00:00"}]');
  assert (select value_estimated from deals where source_id = src and external_id = '11') = 1300, 'existing deal updated';
  assert (select value_won from deals where source_id = src and external_id = '501') = 4500, '$4,500 reads as 4500';
  assert (select won_date from deals where source_id = src and external_id = '501') = '2026-10-03', 'US date reads';
  perform aspire_sync_finish(run, 'ok', 2, '[]', '[]', true);
  assert (select count(*) from deals where source_id = src and removed_at is null) = 2, 'complete full pull marks the rest removed';
  assert (select rows_removed from source_runs where id = run) > 0, 'logged';
  assert (select count(*) from deal_snapshots s join deals d on d.id = s.deal_id where d.source_id = src and s.snap_date = current_date) >= 2, 'snapshot';

  -- a CSV source: its own field names, a mapping, and removal only of what a leader confirmed
  insert into deal_sources (workspace_id, mode, label, mapping) values (other, 'csv', 'CSV upload',
    '{"external_id": "Deal ID", "account": "Company", "stage": "Stage", "value_estimated": "Amount", "close_date": "Close", "rep_name": "Owner"}')
  on conflict (workspace_id) do update set mode = 'csv', connector = null, label = 'CSV upload', mapping = excluded.mapping
  returning id into csv;
  b := source_sync_begin(csv, 'upload');
  assert b->>'mode' = 'full', 'an upload is a full file';
  run := (b->>'run_id')::bigint;
  perform source_sync_upsert(run, '[{"Deal ID": "A1", "Company": "Acme", "Stage": "Proposal", "Amount": "12,000", "Close": "11/15/2026", "Owner": "Matthew Royer"},
                                   {"Deal ID": "A2", "Company": "Beta", "Stage": "Won", "Amount": "800"}, {"Company": "no id"}]');
  perform source_sync_finish(run, 'ok', 0, '[]', '[]', true);
  assert (select count(*) from deals where source_id = csv and removed_at is null) = 2, 'two rows with ids';
  assert (select close_date from deals where source_id = csv and external_id = 'A1') = '2026-11-15', 'mapped and typed';
  assert (select member_name from deal_board where source_id = csv and external_id = 'A1') = 'Matthew Royer', 'rep matched by name';
  b := source_sync_begin(csv, 'upload'); run := (b->>'run_id')::bigint;
  perform source_sync_upsert(run, '[{"Deal ID": "A1", "Company": "Acme", "Stage": "Proposal", "Amount": "12000"}]');
  perform source_sync_finish(run, 'ok', 0, '[]', '[]', true);
  assert (select count(*) from deals where source_id = csv and removed_at is null) = 2, 'a missing row is never removed on its own';
  b := source_sync_begin(csv, 'upload'); run := (b->>'run_id')::bigint;
  perform source_sync_upsert(run, '[{"Deal ID": "A1", "Company": "Acme", "Stage": "Proposal", "Amount": "12000"}]');
  perform source_sync_finish(run, 'ok', 0, '[]', '[]', true, array['A2', 'A1']);
  assert (select removed_at from deals where source_id = csv and external_id = 'A2') is not null, 'confirmed removal';
  assert (select removed_at from deals where source_id = csv and external_id = 'A1') is null, 'a row in the file is never removed';

  -- native: nothing syncs into it
  update deal_sources set mode = 'native', mapping = '{}' where id = csv;
  assert source_sync_begin(csv)->>'error' like '%types its deals in Summit%', 'native refuses a sync';

  -- signed-in users read, never write
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000a1', true);
  set local role authenticated;
  assert (select count(*) from deal_board) > 0, 'a member reads the board';
  begin
    insert into deals (workspace_id, source_id, account) values (ws, src, 'typed into a connected workspace');
    assert false, 'no client writes';
  exception when insufficient_privilege then null; end;
  begin
    perform source_sync_begin(src);
    assert false, 'sync functions are service role only';
  exception when insufficient_privilege then null; end;
  reset role;

  assert source_date('2026-02-30') is null and source_date('13/40/2026') is null, 'impossible dates are null, not errors';
  assert source_num('abc') is null and source_num('-1,250.50') = -1250.50, 'numbers';
  raise notice 'deal source checks passed';
end $$;
