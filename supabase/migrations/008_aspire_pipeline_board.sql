-- Summit  migration 008  the board reads Aspire
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 007.
-- Safe to run more than once. No data changes: opps, commits, goals and the book are untouched.
--
-- workspaces.pipeline says where the board's deals come from and what each CRM status means.
-- With source "aspire" the six screens read aspire_pipeline instead of opps.
--   status  open | won | lost. A status not in the list is "unknown": counted on Data Check,
--           never counted as open, won or lost, never dropped.
--   prob    the weight for weighted pipeline, coverage and the cash ladder.
--   bid     a bid is out (Bids out tile, "bid out, no start date" check).
--   needs_close  an open deal at this status should carry an expected close date.
-- divisions maps an Aspire DivisionName to a Summit category, only where the names differ.
-- Every name is matched ignoring case and spaces at the ends.

alter table workspaces add column if not exists pipeline jsonb;

update workspaces set pipeline = '{
  "source": "aspire",
  "statuses": [
    {"name": "New",              "status": "open", "prob": 0.10},
    {"name": "Bidding",          "status": "open", "prob": 0.40, "needs_close": true},
    {"name": "Pending Approval", "status": "open", "prob": 0.60, "needs_close": true, "bid": true},
    {"name": "Approved",         "status": "open", "prob": 0.80, "needs_close": true, "bid": true},
    {"name": "Won",              "status": "won",  "prob": 1},
    {"name": "Delivered",        "status": "won",  "prob": 1},
    {"name": "Lost",             "status": "lost", "prob": 0}
  ],
  "divisions": {}
}'::jsonb
where slug = 'elevation-outdoors';

-- the status a workspace's config gives a CRM status name. 'unknown' when the name is blank or not
-- listed. A workspace with no pipeline config falls back to the plain names Won and Lost.
create or replace function summit_pipeline_status(cfg jsonb, status_name text) returns text
language sql stable as $$
  select case
    when cfg is null or jsonb_typeof(cfg->'statuses') is distinct from 'array' then
      case when status_name ~* '^\s*won\s*$' then 'won' when status_name ~* '^\s*lost\s*$' then 'lost' else 'open' end
    else coalesce(
      (select s->>'status' from jsonb_array_elements(cfg->'statuses') s
        where summit_name_key(s->>'name') = summit_name_key(status_name)
          and s->>'status' in ('open', 'won', 'lost')
        limit 1),
      'unknown')
  end $$;

-- same columns as 007, in the same order. status now comes from the workspace config.
create or replace view aspire_pipeline with (security_invoker = true) as
select
  a.workspace_id,
  a.opportunity_id,
  a.opportunity_number,
  a.opportunity_name,
  a.property_name,
  a.sales_rep_name,
  m.id          as member_id,
  m.full_name   as member_name,
  m.role        as member_role,
  m.team        as member_team,
  m.active      as member_active,
  (m.id is null) as unassigned,
  a.branch_name,
  a.division_name,
  a.status_name,
  summit_pipeline_status(w.pipeline, a.status_name) as status,
  a.estimated_dollars,
  a.won_dollars,
  a.start_date,
  a.anticipated_close_date,
  a.won_date,
  a.lost_date,
  a.aspire_modified_at,
  a.synced_at
from aspire_opps a
join workspaces w on w.id = a.workspace_id
left join lateral (
  select mm.id, mm.full_name, mm.role, mm.team, mm.active
    from members mm
   where mm.workspace_id = a.workspace_id
     and summit_name_key(a.sales_rep_name) in (summit_name_key(mm.full_name), summit_name_key(mm.crm_name))
   order by mm.active desc, (summit_name_key(mm.crm_name) = summit_name_key(a.sales_rep_name)) desc nulls last, mm.id
   limit 1
) m on true
where a.removed_at is null;

-- 007's view, unchanged in shape. Delivered is won through the config, so it no longer counts as open.
create or replace view aspire_unmatched with (security_invoker = true) as
select workspace_id,
       coalesce(nullif(btrim(sales_rep_name), ''), '(no rep in Aspire)') as sales_rep_name,
       count(*)::int                                          as deals,
       (count(*) filter (where status = 'open'))::int         as open_deals,
       coalesce(sum(estimated_dollars) filter (where status = 'open'), 0) as open_estimated,
       (count(*) filter (where status = 'won'))::int          as won_deals,
       coalesce(sum(won_dollars) filter (where status = 'won'), 0)        as won_dollars
  from aspire_pipeline
 where unassigned
 group by 1, 2;

grant select on aspire_pipeline, aspire_unmatched to authenticated;

-- show the result: every Aspire status, what it maps to, and how many deals carry it
select coalesce(nullif(btrim(status_name), ''), '(blank)') as aspire_status, status as summit_status,
       count(*) as deals, round(sum(coalesce(estimated_dollars, 0))) as estimated
  from aspire_pipeline
 where workspace_id = (select id from workspaces where slug = 'elevation-outdoors')
 group by 1, 2
 order by 3 desc;
