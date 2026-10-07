-- Summit  migration 009  Aspire board rules: recurring, the goal window, win rate, test data
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 008.
-- Safe to run more than once. Config and views only. No deal, commit, goal or book row changes.
--
-- workspaces.pipeline gains three blocks. All of it is config: change it here, not in code.
--   divisions  rules, tried in order. "match" is found anywhere in the Aspire DivisionName,
--              ignoring case. The first rule that matches sets the Summit category. A division no
--              rule matches keeps its own name and counts as one-time (never recurring).
--              Recurring comes from the category: Maintenance is the recurring one.
--   win_rate   "properties": a property counts once a year, won if any of its deals was won that
--              year, lost if it only lost. Change orders and renewals no longer stack up wins.
--              "deals": every won and lost record. "off": no win rate tile.
--   exclude    test and sample data kept off the board. "names" are exact property or opportunity
--              names, ignoring case. "words" are whole words in either name, ignoring case.
--              Excluded deals are counted on Data Check, never dropped silently.
--
-- The New maintenance goal tile gains "start": the goal window runs from that date (a goal value
-- leadership sets on Data Check) to the deadline. With no start set, the window opens Jan 1 of the
-- goal period.

update workspaces set pipeline = pipeline || '{
  "divisions": [
    {"match": "Maintenance",  "category": "Maintenance"},
    {"match": "Enhancement",  "category": "Enhancement"},
    {"match": "Construction", "category": "Install"}
  ],
  "win_rate": "properties",
  "exclude": {
    "names": ["John Test Property", "Test All Out Door", "Billy Bob Residence TEST"],
    "words": ["test", "sample"]
  }
}'::jsonb
where slug = 'elevation-outdoors' and pipeline is not null;

update workspaces set goal_tiles = (
  select jsonb_agg(case when t->>'key' = 'newMaint' then t || '{"start": "newMaintStart"}'::jsonb else t end order by ord)
  from jsonb_array_elements(goal_tiles) with ordinality as x(t, ord)
)
where slug = 'elevation-outdoors' and jsonb_typeof(goal_tiles) = 'array';

-- is this deal test or sample data, by the workspace's exclude list
create or replace function summit_pipeline_excluded(cfg jsonb, property_name text, opportunity_name text) returns boolean
language sql stable as $$
  select coalesce(
    exists (select 1 from jsonb_array_elements_text(coalesce(cfg->'exclude'->'names', '[]')) n
             where summit_name_key(n) in (summit_name_key(property_name), summit_name_key(opportunity_name)))
    or exists (select 1 from jsonb_array_elements_text(coalesce(cfg->'exclude'->'words', '[]')) w
                where btrim(w) <> ''
                  and (coalesce(property_name, '') ~* ('\m' || regexp_replace(btrim(w), '([^[:alnum:] ])', '\\\1', 'g') || '\M')
                    or coalesce(opportunity_name, '') ~* ('\m' || regexp_replace(btrim(w), '([^[:alnum:] ])', '\\\1', 'g') || '\M'))),
    false) $$;

-- 008's view with one new column at the end: excluded. Every row stays, so Data Check can count them.
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
  a.synced_at,
  summit_pipeline_excluded(w.pipeline, a.property_name, a.opportunity_name) as excluded
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

-- unmatched reps, test data left out
create or replace view aspire_unmatched with (security_invoker = true) as
select workspace_id,
       coalesce(nullif(btrim(sales_rep_name), ''), '(no rep in Aspire)') as sales_rep_name,
       count(*)::int                                          as deals,
       (count(*) filter (where status = 'open'))::int         as open_deals,
       coalesce(sum(estimated_dollars) filter (where status = 'open'), 0) as open_estimated,
       (count(*) filter (where status = 'won'))::int          as won_deals,
       coalesce(sum(won_dollars) filter (where status = 'won'), 0)        as won_dollars
  from aspire_pipeline
 where unassigned and not excluded
 group by 1, 2;

grant select on aspire_pipeline, aspire_unmatched to authenticated;

-- show the result
select division_name,
       (select r->>'category' from jsonb_array_elements(w.pipeline->'divisions') r
         where position(lower(r->>'match') in lower(coalesce(p.division_name, ''))) > 0 limit 1) as category,
       count(*) as deals
  from aspire_pipeline p join workspaces w on w.id = p.workspace_id
 where w.slug = 'elevation-outdoors' and not p.excluded
 group by 1, 2 order by 3 desc;
select property_name, opportunity_name, status_name
  from aspire_pipeline p join workspaces w on w.id = p.workspace_id
 where w.slug = 'elevation-outdoors' and p.excluded
 order by 1;
