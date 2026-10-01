-- Migration 008 on top of 007's test data: status comes from the workspace config.
\set ON_ERROR_STOP on
\i :mig8
\i :mig8
do $$
declare ws uuid := '00000000-0000-0000-0000-00000000000e';
begin
  update workspaces set pipeline = (select pipeline from workspaces where slug = 'elevation-outdoors') where id = ws;
  insert into aspire_opps (workspace_id, opportunity_id, status_name, sales_rep_name, estimated_dollars, won_dollars, raw) values
    (ws, 101, 'Delivered', 'Matthew Royer', 5000, 5000, '{}'),
    (ws, 102, 'Bidding',   'Matthew Royer', 300,  null, '{}'),
    (ws, 103, '  pending approval ', 'Greg Hill', 200, null, '{}'),
    (ws, 104, null,        'Greg Hill', 900,  null, '{}'),
    (ws, 105, 'On Hold',   'Greg Hill', 50,   null, '{}');
  assert (select status from aspire_pipeline where opportunity_id = 101) = 'won', 'Delivered is won';
  assert (select status from aspire_pipeline where opportunity_id = 102) = 'open', 'Bidding is open';
  assert (select status from aspire_pipeline where opportunity_id = 103) = 'open', 'matched ignoring case and spaces';
  assert (select status from aspire_pipeline where opportunity_id = 104) = 'unknown', 'blank is unknown';
  assert (select status from aspire_pipeline where opportunity_id = 105) = 'unknown', 'unlisted is unknown';
  assert (select status from aspire_pipeline where opportunity_id = 12) = 'won', 'Won still won';
  -- 007's test rows use the status "Open", which Elevation's config does not list
  assert (select status from aspire_pipeline where opportunity_id = 13) = 'unknown', '"Open" is not in the config, so unknown';
end $$;
do $$
declare ws uuid := '00000000-0000-0000-0000-00000000000e';
begin
  -- Matthew: Delivered (won) and Bidding (open). Delivered must not count as open.
  assert (select open_deals from aspire_unmatched where workspace_id = ws and sales_rep_name = 'Matthew Royer') = 1, 'Delivered is not open';
  assert (select open_estimated from aspire_unmatched where workspace_id = ws and sales_rep_name = 'Matthew Royer') = 300, 'open $ excludes Delivered';
  assert (select won_deals from aspire_unmatched where workspace_id = ws and sales_rep_name = 'Matthew Royer') = 1, 'Delivered is won';
  -- no workspace config: the plain Won/Lost fallback, as before
  assert summit_pipeline_status(null, 'Won') = 'won' and summit_pipeline_status(null, 'Bidding') = 'open', 'fallback without config';
  assert (select pipeline->>'source' from workspaces where slug = 'elevation-outdoors') = 'aspire', 'Elevation reads Aspire';
  raise notice 'pipeline board checks passed';
end $$;
