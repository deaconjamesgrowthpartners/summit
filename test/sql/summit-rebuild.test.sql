-- Migration 011 on top of 010: dates on the view, targets and who may write them, the snapshot, the login link.
\set ON_ERROR_STOP on
create table if not exists auth.users (id uuid primary key, email text, created_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz);
alter table workspaces add column if not exists lock_tz text;
\i :mig11
\i :mig11
do $$
declare ws uuid := '00000000-0000-0000-0000-00000000000e'; run bigint; leader uuid := gen_random_uuid(); rep uuid := gen_random_uuid(); n int;
begin
  insert into aspire_opps (workspace_id, opportunity_id, status_name, property_name, raw) values
    (ws, 401, 'Bidding', 'Elm HOA', '{"CreatedDateTime": "2026-09-03T14:20:00", "EndDate": "2027-03-31T00:00:00", "RenewalDate": null}'),
    (ws, 402, 'Won', 'Ash HOA', '{"CreatedDate": "2026-08-01", "EndDate": "", "RenewalDate": "2027-01-15T00:00:00"}');
  assert (select created_date from aspire_pipeline where opportunity_id = 401) = '2026-09-03', 'CreatedDateTime read';
  assert (select created_date from aspire_pipeline where opportunity_id = 402) = '2026-08-01', 'CreatedDate fallback';
  assert (select end_date from aspire_pipeline where opportunity_id = 401) = '2027-03-31', 'EndDate read';
  assert (select renewal_date from aspire_pipeline where opportunity_id = 401) is null, 'null RenewalDate';
  assert (select end_date from aspire_pipeline where opportunity_id = 402) is null, 'blank EndDate';
  assert (select renewal_date from aspire_pipeline where opportunity_id = 402) = '2027-01-15', 'RenewalDate read';
  assert (select property_id from aspire_pipeline where opportunity_id = 301) = '5501', '010 column kept';

  -- the snapshot: once at migrate time, then on every finish that saved rows
  select (aspire_sync_begin('elevation-outdoors', 'manual', false)->>'run_id')::bigint into run;
  perform aspire_sync_finish(run, 'ok');
  select count(*) into n from aspire_status_snapshots where workspace_id = ws;
  assert n = (select count(*) from aspire_opps where workspace_id = ws and removed_at is null), 'one row per live deal';
  assert (select count(distinct snap_date) from aspire_status_snapshots) = 1, 'same day overwrites';
  assert (select status_name from aspire_status_snapshots where opportunity_id = 401) = 'Bidding', 'status kept';
  assert (select notes::text from aspire_sync_runs where id = run) like '%status snapshot%', 'run notes the snapshot';
  update aspire_opps set status_name = 'Won' where opportunity_id = 401;
  select (aspire_sync_begin('elevation-outdoors', 'manual', false)->>'run_id')::bigint into run;
  perform aspire_sync_finish(run, 'error', 0, '["x"]');
  assert (select status_name from aspire_status_snapshots where opportunity_id = 401) = 'Bidding', 'a failed run writes no snapshot';

  -- targets: a leader writes, a rep reads, a stranger sees nothing
  insert into auth.users values (leader, 'lead@x.test'), (rep, 'rep@x.test');
  insert into members (workspace_id, full_name, email, role, active) values (ws, 'Lead', 'LEAD@x.test', 'leader', true), (ws, 'Rep', 'rep@x.test', 'rep', true);
  perform set_config('test.uid', leader::text, true);
  set local role authenticated;
  assert summit_link_member() = 1, 'leader linked by email, ignoring case';
  assert summit_link_member() = 0, 'linking twice changes nothing';
  insert into summit_targets (workspace_id, branch, month, metric, amount) values (ws, 'Oakwood', '2026-10-01', 'closed', 250000);
  insert into summit_targets (workspace_id, month, metric, division, amount) values (ws, '2026-10-01', 'closed', 'maintenance', 90000);
  begin
    insert into summit_targets (workspace_id, month, metric, amount) values (ws, '2026-10-15', 'closed', 1);
    assert false, 'mid-month refused';
  exception when check_violation then null; end;
  reset role;
  perform set_config('test.uid', rep::text, true);
  set local role authenticated;
  perform summit_link_member();
  assert (select count(*) from summit_targets) = 2, 'rep reads targets';
  begin
    insert into summit_targets (workspace_id, month, metric, amount) values (ws, '2026-11-01', 'closed', 1);
    assert false, 'rep write refused';
  exception when insufficient_privilege then null; end;
  update summit_targets set amount = 1;
  get diagnostics n = row_count;
  assert n = 0, 'rep update touches nothing';
  begin
    insert into aspire_status_snapshots (workspace_id, opportunity_id, snap_date) values (ws, 1, current_date);
    assert false, 'snapshot write refused';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('test.uid', gen_random_uuid()::text, true);
  set local role authenticated;
  assert (select count(*) from summit_targets) = 0, 'stranger sees no targets';
  assert summit_link_member() = 0, 'unknown login links nothing';
  reset role;
  raise notice 'summit rebuild checks passed';
end $$;
