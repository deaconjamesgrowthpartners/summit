-- Migration 009 on top of 008: test data exclusion and the goal window config.
\set ON_ERROR_STOP on
\i :mig9
\i :mig9
do $$
declare ws uuid := '00000000-0000-0000-0000-00000000000e';
  cfg jsonb := (select pipeline from workspaces where slug = 'elevation-outdoors');
begin
  -- the stub's elevation row is a different id from ws in the earlier tests; give ws the same config
  update workspaces set pipeline = cfg where id = ws;
  assert cfg->>'win_rate' = 'properties', 'win rate by property';
  assert jsonb_array_length(cfg->'divisions') = 3, 'division rules';
  assert (select goal_tiles->0->>'start' from workspaces where slug = 'elevation-outdoors') = 'newMaintStart', 'goal window start key';
  assert (select goal_tiles->1->>'start' from workspaces where slug = 'elevation-outdoors') is null, 'other tiles untouched';
  -- the same cases the JS test uses: SQL and the screens must agree
  assert summit_pipeline_excluded(cfg, 'John Test Property', 'Mulch');
  assert summit_pipeline_excluded(cfg, 'test all out door', 'Mulch');
  assert summit_pipeline_excluded(cfg, 'Billy Bob Residence TEST', 'Mulch');
  assert summit_pipeline_excluded(cfg, 'Sample Street HOA', 'Mulch');
  assert summit_pipeline_excluded(cfg, 'The Test Site', 'Mulch');
  assert summit_pipeline_excluded(cfg, 'Oak HOA', 'Sample estimate'), 'opportunity name counts';
  assert not summit_pipeline_excluded(cfg, 'Contest Park', 'Mulch');
  assert not summit_pipeline_excluded(cfg, 'Testa Farms', 'Mulch');
  assert not summit_pipeline_excluded(cfg, 'Samples Hardware', 'Mulch');
  assert not summit_pipeline_excluded(cfg, 'Oak HOA', null);
  assert not summit_pipeline_excluded(null, 'Test HOA', null), 'no config, nothing excluded';

  insert into aspire_opps (workspace_id, opportunity_id, status_name, sales_rep_name, property_name, opportunity_name, estimated_dollars, raw) values
    (ws, 201, 'Bidding', 'Matthew Royer', 'John Test Property', 'Mulch', 7777, '{}');
  assert (select excluded from aspire_pipeline where opportunity_id = 201), 'flagged in the view';
  assert exists (select 1 from aspire_pipeline where opportunity_id = 201), 'kept in the view so Data Check can count it';
  assert (select open_deals from aspire_unmatched where workspace_id = ws and sales_rep_name = 'Matthew Royer') = 1, 'test data left out of unmatched';
  raise notice 'board rules checks passed';
end $$;
