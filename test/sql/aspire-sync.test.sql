-- Runs migration 007's functions end to end against the stub. Any failed check raises and stops.
\set ON_ERROR_STOP on
insert into workspaces (id, slug, name) values ('00000000-0000-0000-0000-00000000000e', 'elevation-outdoors', 'Elevation'),
                                               ('00000000-0000-0000-0000-00000000000f', 'other', 'Other');
insert into members (id, workspace_id, full_name, role, user_id) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000e', 'Greg Hill', 'rep', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000e', 'Kit Fox', 'rep', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000f', 'Matthew Royer', 'rep', '00000000-0000-0000-0000-0000000000a3');
insert into opps (workspace_id, account) values ('00000000-0000-0000-0000-00000000000e', 'typed in Summit');
insert into commits (workspace_id, note) values ('00000000-0000-0000-0000-00000000000e', 'typed in Summit');

-- :mig is migration 007 with the create extension lines taken out (the stub stands in for them)
\i :mig
\i :mig

update members set crm_name = 'Christopher Fox' where full_name = 'Kit Fox';

do $$
declare b jsonb; u jsonb; f jsonb; run bigint; n int;
  page jsonb := '[
    {"OpportunityID": 11, "OpportunityName": "Oak mulch", "SalesRepContactName": "Greg Hill", "OpportunityStatusName": "Open",
     "EstimatedDollars": 1200.5, "StartDate": "2026-10-01T00:00:00", "ModifiedDate": "2026-09-28T14:05:00"},
    {"OpportunityID": 12, "OpportunityName": "Pine install", "SalesRepContactName": "christopher  fox", "OpportunityStatusName": "Won",
     "WonDollars": 900, "WonDate": "2026-09-01T00:00:00", "ModifiedDate": "2026-09-29T08:00:00"},
    {"OpportunityID": 13, "OpportunityName": "Elm", "SalesRepContactName": "Matthew Royer", "OpportunityStatusName": "Open",
     "EstimatedDollars": "3000", "ModifiedDate": "2026-09-20T00:00:00"},
    {"OpportunityID": 14, "OpportunityName": "Birch", "SalesRepContactName": null, "OpportunityStatusName": "Lost", "ModifiedDate": "2026-09-10T00:00:00"},
    {"OpportunityID": "junk"}
  ]';
begin
  -- 1. first run is full
  b := aspire_sync_begin(null, 'manual', false);
  assert b->>'mode' = 'full', 'first run should be full: ' || b::text;
  assert b->>'workspace_id' = '00000000-0000-0000-0000-00000000000e', 'picks the crm_source workspace';
  run := (b->>'run_id')::bigint;
  assert aspire_sync_begin(null, 'manual', false)->>'error' = 'a sync is already running for this workspace', 'no two runs at once';
  u := aspire_sync_upsert(run, page);
  assert u = '{"pulled": 4, "inserted": 4, "updated": 0, "unchanged": 0}', 'first page: ' || u::text;
  u := aspire_sync_upsert(run, page);
  assert u = '{"pulled": 4, "inserted": 0, "updated": 0, "unchanged": 4}', 'same page again changes nothing: ' || u::text;
  f := aspire_sync_finish(run, 'ok', 3, '[]', '[]', true);
  assert f->>'status' = 'ok' and (f->>'rows_pulled')::int = 8 and (f->>'pages')::int = 2 and (f->>'calls')::int = 3, 'log: ' || f::text;
  assert f->>'max_modified' = '2026-09-29T08:00:00', 'watermark ' || (f->>'max_modified');
  assert f->'unmatched' @> '[{"name": "Matthew Royer", "deals": 1, "open_deals": 1, "open_estimated": 3000}]', 'Matthew is unmatched: ' || (f->>'unmatched');
  assert f->'unmatched' @> '[{"name": "(no rep in Aspire)", "deals": 1}]', 'a blank rep is listed too';
  assert jsonb_array_length(f->'unmatched') = 2, 'only two unmatched: ' || (f->>'unmatched');

  -- typed columns come out of the raw record
  assert (select estimated_dollars from aspire_opps where opportunity_id = 11) = 1200.5, 'dollars';
  assert (select estimated_dollars from aspire_opps where opportunity_id = 13) = 3000, 'string dollars';
  assert (select start_date from aspire_opps where opportunity_id = 11) = '2026-10-01', 'date';
  assert (select raw->>'OpportunityName' from aspire_opps where opportunity_id = 12) = 'Pine install', 'raw kept';

  -- the view: matched by full name, by crm_name (case and spaces ignored), unmatched stays visible
  assert (select member_id from aspire_pipeline where opportunity_id = 11) = '00000000-0000-0000-0000-000000000001', 'Greg matched';
  assert (select member_id from aspire_pipeline where opportunity_id = 12) = '00000000-0000-0000-0000-000000000002', 'Kit matched on crm_name';
  assert (select unassigned and member_id is null from aspire_pipeline where opportunity_id = 13), 'Matthew stays, unassigned (the other workspace''s Matthew does not count)';
  assert (select status from aspire_pipeline where opportunity_id = 12) = 'won', 'won bucket';
  assert (select status from aspire_pipeline where opportunity_id = 14) = 'lost', 'lost bucket';

  -- 2. next run is incremental from a day before the watermark
  b := aspire_sync_begin(null, 'cron', false);
  assert b->>'mode' = 'incremental' and b->>'since' = '2026-09-28T08:00:00', 'incremental: ' || b::text;
  run := (b->>'run_id')::bigint;
  u := aspire_sync_upsert(run, '[{"OpportunityID": 11, "OpportunityName": "Oak mulch", "SalesRepContactName": "Greg Hill",
        "OpportunityStatusName": "Won", "WonDollars": 1100, "ModifiedDate": "2026-09-30T09:00:00"}]');
  assert u = '{"pulled": 1, "inserted": 0, "updated": 1, "unchanged": 0}', 'changed row: ' || u::text;
  f := aspire_sync_finish(run, 'ok', 2, '[]', '[]', true);
  assert (f->>'rows_removed')::int = 0, 'incremental never removes';

  -- 3. a partial run does not move the watermark
  b := aspire_sync_begin(null, 'manual', false);
  run := (b->>'run_id')::bigint;
  perform aspire_sync_upsert(run, '[{"OpportunityID": 15, "ModifiedDate": "2027-01-01T00:00:00"}]');
  perform aspire_sync_finish(run, 'partial', 1, '["time budget"]', '[]', false);
  assert aspire_sync_begin(null, 'manual', false)->>'since' = '2026-09-29T09:00:00', 'watermark comes from ok runs only';
  update aspire_sync_runs set status = 'ok' where status = 'running' and id > run; -- close it out
  delete from aspire_sync_runs where id > run;

  -- 4. a full pull that no longer sees a row marks it removed; it leaves the view, not the table
  b := aspire_sync_begin(null, 'manual', true);
  assert b->>'mode' = 'full', 'forced full';
  run := (b->>'run_id')::bigint;
  perform aspire_sync_upsert(run, jsonb_path_query_array(page, '$[0 to 2]'));
  perform aspire_sync_upsert(run, '[{"OpportunityID": 15, "ModifiedDate": "2027-01-01T00:00:00"}]');
  f := aspire_sync_finish(run, 'ok', 4, '[]', '[]', true);
  assert (f->>'rows_removed')::int = 1, 'row 14 removed: ' || f::text;
  assert (select removed_at is not null from aspire_opps where opportunity_id = 14), 'kept in the table';
  assert not exists (select 1 from aspire_pipeline where opportunity_id = 14), 'gone from the view';

  -- 5. a run the function never closed is closed out, not left blocking
  insert into aspire_sync_runs (workspace_id, mode, started_at) values ('00000000-0000-0000-0000-00000000000e', 'full', now() - interval '1 hour');
  b := aspire_sync_begin(null, 'manual', false);
  assert b ? 'run_id', 'stale run closed: ' || b::text;
  assert exists (select 1 from aspire_sync_runs where status = 'error' and errors ? 'never finished. the function stopped before it could log the end'), 'stale run logged';
  perform aspire_sync_finish((b->>'run_id')::bigint, 'ok', 0, '[]', '[]', true);

  -- 6. nothing typed in Summit moved
  assert (select count(*) from opps) = 1 and (select account from opps) = 'typed in Summit', 'opps untouched';
  assert (select note from commits) = 'typed in Summit', 'commits untouched';

  -- 7. schedule and the by-hand run
  assert (select count(*) from cron.job where jobname = 'aspire-sync-nightly' and schedule = '17 7 * * *') = 1, 'one nightly job';
  begin
    perform aspire_sync_now();
    raise exception 'should have refused without the vault secret';
  exception when others then
    assert sqlerrm like 'no vault secret named aspire_sync_key%', sqlerrm;
  end;
  insert into vault.decrypted_secrets values ('aspire_sync_key', 'sk-test');
  perform aspire_sync_now(true);
  assert (select body from net.calls order by id desc limit 1) = '{"full": true, "trigger": "manual"}', 'manual body';
  assert (select headers->>'Authorization' from net.calls order by id desc limit 1) = 'Bearer sk-test', 'key sent';
  assert (select url from net.calls order by id desc limit 1) like '%/functions/v1/aspire-sync', 'url';
  assert (select proconfig @> '{statement_timeout=60s}' from pg_proc where proname = 'aspire_sync_upsert'), 'upsert carries its own 60s statement timeout';
  raise notice 'sync checks passed';
end $$;

-- 8. row level security: members read their own workspace, nobody but the service role writes
set role authenticated;
select set_config('test.uid', '00000000-0000-0000-0000-0000000000a1', false);
do $$ begin
  assert (select count(*) from aspire_opps) > 0, 'a member reads their workspace';
  assert (select count(*) from aspire_sync_runs) > 0, 'a member reads the log';
  assert (select count(*) from aspire_unmatched) = 2, 'a member reads the unmatched names';
end $$;
select set_config('test.uid', '00000000-0000-0000-0000-0000000000a3', false);
do $$ begin
  assert (select count(*) from aspire_opps) = 0, 'another workspace reads nothing';
  assert (select count(*) from aspire_pipeline) = 0, 'the view obeys row level security';
end $$;
do $$ begin
  begin insert into aspire_opps (workspace_id, opportunity_id, raw) values ('00000000-0000-0000-0000-00000000000e', 99, '{}');
        raise exception 'insert should be refused'; exception when insufficient_privilege then null; end;
  begin perform aspire_sync_begin(null, 'manual', true);
        raise exception 'begin should be refused'; exception when insufficient_privilege then null; end;
  begin perform aspire_sync_now();
        raise exception 'sync_now should be refused'; exception when insufficient_privilege then null; end;
  raise notice 'row level security checks passed';
end $$;
reset role;
