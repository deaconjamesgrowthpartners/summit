-- Migrations 013 and 014 on top of 012: CSV upload with a preview, and deals typed in Summit.
\set ON_ERROR_STOP on
-- the typed opps columns 001 and 002 give the real table
alter table opps add column if not exists owner_member_id uuid, add column if not exists stage text, add column if not exists value numeric,
  add column if not exists actual_close date, add column if not exists priority boolean default false, add column if not exists crm_ref text,
  add column if not exists created_at timestamptz default now(), add column if not exists lock_tz text;
alter table workspaces add column if not exists lock_tz text;
insert into workspaces (id, slug, name) values ('00000000-0000-0000-0000-0000000000c0', 'csvco', 'CSV Co'),
                                               ('00000000-0000-0000-0000-0000000000d0', 'native1', 'Native One');
insert into members (id, workspace_id, full_name, role, team, user_id) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c0', 'Cara Lead', 'leader', null, '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c0', 'Ray Rep', 'rep', 'sales', '00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d0', 'Nia Lead', 'leader', null, '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d0', 'Ana Rep', 'rep', 'pipeline', '00000000-0000-0000-0000-0000000000e2'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000d0', 'Bo Rep', 'rep', 'sourcing', '00000000-0000-0000-0000-0000000000e3');
insert into opps (id, workspace_id, account, owner_member_id, stage, value, crm_ref) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d0', 'Typed Co', '00000000-0000-0000-0000-0000000000d2', 'Meeting sat', 9000, 'Q-7');
\i :mig13
\i :mig13
\i :mig14
\i :mig14
do $$
declare csvws uuid := '00000000-0000-0000-0000-0000000000c0'; nat uuid := '00000000-0000-0000-0000-0000000000d0';
  elev uuid := '00000000-0000-0000-0000-00000000000e';
  csv bigint; p jsonb; r jsonb; did uuid; n int;
  rows jsonb := '[{"Deal ID": "C1", "Company": "Acme", "Stage": "Proposal", "Amount": "12,000", "Owner": "Ray Rep"},
                  {"Deal ID": "C2", "Company": "Beta", "Stage": "Won", "Amount": "800", "Owner": "Ray Rep"},
                  {"Deal ID": "C3", "Company": "Gone Co", "Stage": "Proposal", "Amount": "50"}]';
  mp jsonb := '{"external_id": "Deal ID", "account": "Company", "stage": "Stage", "value_estimated": "Amount", "rep_name": "Owner"}';
begin
  -- a workspace made after 012 starts native
  assert (select mode from deal_sources where workspace_id = nat) = 'native', 'new workspace, native source';
  update deal_sources set mode = 'csv', label = 'CSV upload' where workspace_id = csvws returning id into csv;

  -- 014 copied the typed opp, same id, only in the native workspace
  assert (select account || '/' || stage || '/' || value_estimated || '/' || external_number from deals where id = '00000000-0000-0000-0000-0000000000f1')
    = 'Typed Co/Meeting sat/9000/Q-7', 'typed opp copied';
  assert not exists (select 1 from deals where account = 'typed in Summit'), 'opps in a connected workspace stay off the board';
  assert (select count(*) from deal_changes) = 0, 'the copy is not logged as anyone''s change';

  -- ---------- CSV, as the leader ----------
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000b1', true);
  set local role authenticated;
  p := csv_import_preview(csvws, rows, mp);
  assert (p->>'added')::int = 3 and (p->>'changed')::int = 0 and (p->>'missing')::int = 0, 'first file: three added ' || p::text;
  assert not exists (select 1 from deals where source_id = csv), 'preview writes nothing';
  r := csv_import_apply(csvws, rows, '{}', 'deals-oct.csv', mp);
  assert r->>'status' = 'ok', 'applied';
  assert (select mapping->>'account' from deal_sources where id = csv) = 'Company', 'mapping remembered';
  assert (select file_name from source_runs where id = (r->>'id')::bigint) = 'deals-oct.csv', 'file name logged';
  assert (select run_by from source_runs where id = (r->>'id')::bigint) = '00000000-0000-0000-0000-0000000000b1', 'who uploaded';
  assert (select member_name from deal_board where source_id = csv and external_id = 'C1') = 'Ray Rep', 'rep matched';

  -- second file: one changed, one dropped, one new. Saved mapping, so no mapping passed.
  rows := '[{"Deal ID": "C1", "Company": "Acme", "Stage": "Won", "Amount": "12000", "Owner": "Ray Rep"},
            {"Deal ID": "C2", "Company": "Beta", "Stage": "Won", "Amount": "800", "Owner": "Ray Rep"},
            {"Deal ID": "C4", "Company": "Delta", "Stage": "Proposal", "Amount": "70"},
            {"Deal ID": "C4", "Company": "Delta", "Stage": "Proposal", "Amount": "75"}, {"Company": "no id"}]';
  p := csv_import_preview(csvws, rows);
  assert (p->>'added')::int = 1 and (p->>'changed')::int = 1 and (p->>'unchanged')::int = 1, 'diff counts ' || p::text;
  assert p->'changes'->0->'fields' = '[{"to": "Won", "from": "Proposal", "field": "stage"}]', 'field diff: only the stage ' || (p->'changes')::text;
  assert (p->>'missing')::int = 1 and p->'missing_rows'->0->>'external_id' = 'C3', 'C3 listed as missing';
  assert (p->>'skipped_no_id')::int = 1 and p->'duplicates'->0->>'external_id' = 'C4', 'no id and duplicates said';
  assert p->'added_sample'->0->>'value' = '75', 'last row of a repeated id wins';
  -- apply without ticking C3: it stays
  r := csv_import_apply(csvws, rows, '{}', 'deals-nov.csv');
  assert (select removed_at from deals where source_id = csv and external_id = 'C3') is null, 'never removed without a confirm';
  assert (select stage from deals where source_id = csv and external_id = 'C1') = 'Won', 'change written';
  -- tick C3, and try C1 too: only what the file does not have is removed
  r := csv_import_apply(csvws, rows, array['C3', 'C1'], 'deals-nov.csv');
  assert (select removed_at from deals where source_id = csv and external_id = 'C3') is not null, 'confirmed removal marks removed';
  assert exists (select 1 from deals where source_id = csv and external_id = 'C3'), 'kept, never deleted';
  assert (select removed_at from deals where source_id = csv and external_id = 'C1') is null, 'a row in the file stays';
  assert (r->>'rows_removed')::int = 1, 'one removed';
  -- C3 comes back in a later file: restored
  p := csv_import_preview(csvws, '[{"Deal ID": "C3", "Company": "Gone Co", "Stage": "Proposal", "Amount": "50"}]');
  assert (p->>'restored')::int = 1, 'a removed deal coming back is said';
  reset role;

  -- a rep cannot upload
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000b2', true);
  set local role authenticated;
  begin perform csv_import_preview(csvws, rows); assert false, 'rep refused';
  exception when insufficient_privilege then null; end;
  -- and nobody types into a csv workspace
  begin
    insert into deals (workspace_id, source_id, account, owner_member_id) values (csvws, csv, 'typed', '00000000-0000-0000-0000-0000000000c2');
    assert false, 'no typing into a csv workspace';
  exception when insufficient_privilege then null; end;
  reset role;

  -- a rep in Elevation is refused, and no upload there either
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000a1', true);
  set local role authenticated;
  begin
    insert into deals (workspace_id, source_id, account, owner_member_id) values (elev, 1, 'typed', '00000000-0000-0000-0000-000000000001');
    assert false, 'connected workspace refuses a typed deal';
  exception when insufficient_privilege then null; end;
  begin
    update deals set stage = 'Won' where workspace_id = elev;
    get diagnostics n = row_count;
    assert n = 0, 'connected deals cannot be edited';
  exception when insufficient_privilege then null; end;
  reset role;

  -- ---------- native ----------
  -- a rep adds a deal of their own. source, dates and who are set by the database
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000e2', true);
  set local role authenticated;
  insert into deals (workspace_id, source_id, account, owner_member_id, stage, value_estimated, external_id)
  values (nat, 999999, 'Fresh Co', '00000000-0000-0000-0000-0000000000d2', 'Conversation', 5000, 'sneaky') returning id into did;
  reset role;
  assert (select source_id from deals where id = did) = (select id from deal_sources where workspace_id = nat), 'source set by the database';
  assert (select external_id from deals where id = did) is null, 'external id cannot be typed';
  assert (select created_date from deals where id = did) = summit_today(nat), 'created today';
  assert (select updated_by from deals where id = did) = '00000000-0000-0000-0000-0000000000e2', 'who';
  assert (select count(*) from deal_changes where deal_id = did and action = 'created') >= 4, 'created logged field by field';
  assert (select member_id from deal_changes where deal_id = did limit 1) = '00000000-0000-0000-0000-0000000000d2', 'logged against the roster row';
  assert (select stage from deal_snapshots where deal_id = did) = 'Conversation', 'snapshot on create';
  assert (select member_name from deal_board where deal_id = did) = 'Ana Rep', 'on the board under its owner';

  set local role authenticated;
  update deals set stage = 'Meeting booked', next_step = 'send deck' where id = did;
  reset role;
  assert (select stage_date from deals where id = did) = summit_today(nat), 'stage date moves with the stage';
  assert (select old_value || '>' || new_value from deal_changes where deal_id = did and field = 'stage' and action = 'updated') = 'Conversation>Meeting booked', 'stage change logged';
  assert (select stage from deal_snapshots where deal_id = did and snap_date = summit_today(nat)) = 'Meeting booked', 'snapshot follows the stage';

  -- a rep cannot take another rep's deal, or give theirs away
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000e3', true);
  set local role authenticated;
  update deals set stage = 'Lost' where id = did;
  get diagnostics n = row_count;
  assert n = 0, 'another rep''s deal is not theirs to edit';
  begin
    insert into deals (workspace_id, source_id, account, owner_member_id) values (nat, 0, 'for Ana', '00000000-0000-0000-0000-0000000000d2');
    assert false, 'a rep cannot add a deal for someone else';
  exception when insufficient_privilege then null; end;
  begin delete from deals where id = did; get diagnostics n = row_count; assert n = 0, 'reps cannot delete';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000e2', true);
  set local role authenticated;
  begin
    update deals set owner_member_id = '00000000-0000-0000-0000-0000000000d3' where id = did;
    assert false, 'a rep cannot hand a deal to someone else';
  exception when insufficient_privilege then null; end;
  -- reps add accounts, cannot rename them
  insert into deal_accounts (workspace_id, name) values (nat, 'Fresh Co');
  begin insert into deal_accounts (workspace_id, name) values (nat, ' fresh co '); assert false, 'one account per name';
  exception when unique_violation then null; end;
  update deal_accounts set name = 'Renamed' where workspace_id = nat;
  get diagnostics n = row_count;
  assert n = 0, 'reps do not rename accounts';
  reset role;

  -- a viewer reads everything and writes nothing
  insert into members (id, workspace_id, full_name, role, user_id) values
    ('00000000-0000-0000-0000-0000000000d4', nat, 'Vee Viewer', 'viewer', '00000000-0000-0000-0000-0000000000e4');
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000e4', true);
  set local role authenticated;
  assert (select count(*) from deal_board where workspace_id = nat) = 2, 'viewer reads the board';
  assert (select count(*) from deal_changes where workspace_id = nat) > 0, 'viewer reads the log';
  update deals set stage = 'Signed' where id = did;
  get diagnostics n = row_count;
  assert n = 0, 'viewer cannot edit';
  begin
    insert into deals (workspace_id, source_id, account, owner_member_id) values (nat, 0, 'viewer typed', '00000000-0000-0000-0000-0000000000d4');
    assert false, 'viewer cannot add';
  exception when insufficient_privilege then null; end;
  begin insert into deal_accounts (workspace_id, name) values (nat, 'Viewer Co'); assert false, 'viewer cannot add accounts';
  exception when insufficient_privilege then null; end;
  reset role;
  begin
    insert into members (workspace_id, full_name, role) values (nat, 'Odd', 'boss');
    assert false, 'role is leader, rep or viewer';
  exception when check_violation then null; end;

  -- the leader edits anything, hands deals over, and deletes. The log keeps a deleted deal.
  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000e1', true);
  set local role authenticated;
  update deals set owner_member_id = '00000000-0000-0000-0000-0000000000d3', stage = 'Signed', won_date = summit_today(nat) where id = did;
  get diagnostics n = row_count;
  assert n = 1, 'leader edits';
  update deal_accounts set name = 'Fresh Company' where workspace_id = nat;
  delete from deals where id = '00000000-0000-0000-0000-0000000000f1';
  reset role;
  assert (select member_name from deal_board where deal_id = did) = 'Bo Rep', 'handed over';
  assert exists (select 1 from deal_changes where deal_id = '00000000-0000-0000-0000-0000000000f1' and action = 'deleted'), 'delete logged';
  assert (select count(*) from deal_changes where deal_id = did and field = 'owner_member_id' and action = 'updated') = 1, 'owner change logged';
  raise notice 'csv and native checks passed';
end $$;

-- 015: the two proof workspaces are config only. The stub needs the config columns 001 and 002 give the real table.
alter table workspaces add column if not exists brand jsonb, add column if not exists branches text[], add column if not exists categories jsonb,
  add column if not exists measures jsonb, add column if not exists pipeline jsonb, add column if not exists crm_source text,
  add column if not exists lock_dow int default 2;
update workspaces set lock_dow = 3 where slug = 'elevation-outdoors';
\i :mig15
\i :mig15
do $$
declare a uuid; b uuid;
begin
  select id into a from workspaces where slug = '29029';
  select id into b from workspaces where slug = 'deacon-james';
  assert a is not null and b is not null, 'both made';
  assert (select count(*) from workspaces where slug in ('29029', 'deacon-james')) = 2, 'once each';
  assert (select lock_dow from workspaces where id = a) = 3, 'settings copied from Elevation';
  assert (select mode from deal_sources where workspace_id = a) = 'native' and (select mode from deal_sources where workspace_id = b) = 'native', 'native';
  assert (select count(*) from members where workspace_id = a) = 3, 'Joe and two viewers, once';
  assert (select string_agg(role, ',' order by role) from members where workspace_id = a) = 'rep,viewer,viewer', 'roles';
  assert (select count(*) from members where workspace_id = a and active and email like '%.invalid') = 0, 'placeholders never active';
  assert (select jsonb_array_length(measures) from workspaces where id = a) = 5, 'five measures';
  assert (select measures->1->'auto'->>'stage_entered' from workspaces where id = a) = 'Meeting booked', 'booked from the deals';
  assert (select tabs->2->>'team' || '/' || (tabs->3->'measures'->>0) from workspaces where id = b) = 'pipeline/src_booked', 'two teams, two measure sets';
  assert (select crm_source from workspaces where slug = 'elevation-outdoors') = 'aspire', 'Elevation untouched';
  raise notice 'workspace checks passed';
end $$;

-- 016: the nightly job moves to source-sync, one job per connected source, the old one gone
select cron.schedule('aspire-sync-nightly', '17 7 * * *', 'select 1') where not exists (select 1 from cron.job where jobname = 'aspire-sync-nightly');
\i :mig16
\i :mig16
do $$
begin
  assert not exists (select 1 from cron.job where jobname = 'aspire-sync-nightly'), 'old job gone';
  assert (select count(*) from cron.job where jobname like 'source-sync-%') = (select count(*) from deal_sources where mode = 'connected' and enabled and schedule is not null), 'one job per connected source';
  assert (select command from cron.job where jobname like 'source-sync-%' limit 1) like 'select source_sync_now(%', 'calls source_sync_now';
  raise notice 'cutover checks passed';
end $$;
