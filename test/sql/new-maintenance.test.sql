-- Migration 010 on top of 009: the basis setting and PropertyID on the view.
\set ON_ERROR_STOP on
\i :mig10
\i :mig10
do $$
declare ws uuid := '00000000-0000-0000-0000-00000000000e';
begin
  assert (select pipeline->>'new_maintenance_basis' from workspaces where slug = 'elevation-outdoors') = 'new_properties', 'basis set';
  assert (select pipeline->>'win_rate' from workspaces where slug = 'elevation-outdoors') = 'properties', '009 settings kept';
  insert into aspire_opps (workspace_id, opportunity_id, status_name, property_name, raw) values
    (ws, 301, 'Won', 'Oak HOA', '{"PropertyID": 5501}'), (ws, 302, 'Won', 'Oak HOA', '{"PropertyID": " "}');
  assert (select property_id from aspire_pipeline where opportunity_id = 301) = '5501', 'PropertyID from the raw record';
  assert (select property_id from aspire_pipeline where opportunity_id = 302) is null, 'blank PropertyID is null';
  assert (select excluded from aspire_pipeline where opportunity_id = 201), '009 column still there';
  raise notice 'new maintenance checks passed';
end $$;
