-- Summit  migration 010  new maintenance means properties new to the book
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 009.
-- Safe to run more than once. Config and views only.
--
-- pipeline.new_maintenance_basis decides what the New maintenance goal tile (and its coverage) counts:
--   new_properties  (the default) a won recurring deal counts only when its property had no won
--                   recurring deal before the goal window opened. Renewals and add-ons to contracts
--                   already in the book do not count. A property's history comes from every Aspire
--                   opportunity the sync holds. A won recurring deal with no won date counts as history.
--   all_recurring   every recurring dollar won inside the window, renewals included.
--
-- aspire_pipeline gains property_id (Aspire's PropertyID from the raw record), so two properties that
-- share a name are told apart, and one property spelled two ways is still one property.

update workspaces set pipeline = pipeline || '{"new_maintenance_basis": "new_properties"}'::jsonb
where slug = 'elevation-outdoors' and pipeline is not null;

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
  summit_pipeline_excluded(w.pipeline, a.property_name, a.opportunity_name) as excluded,
  nullif(btrim(a.raw->>'PropertyID'), '') as property_id
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

grant select on aspire_pipeline to authenticated;

-- show the result: how many opportunities carry a PropertyID, and the basis now set
select count(*) as opportunities, count(property_id) as with_property_id,
       (select pipeline->>'new_maintenance_basis' from workspaces where slug = 'elevation-outdoors') as basis
  from aspire_pipeline p join workspaces w on w.id = p.workspace_id
 where w.slug = 'elevation-outdoors';
