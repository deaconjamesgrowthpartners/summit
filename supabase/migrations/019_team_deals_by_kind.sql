-- Summit  migration 019  Grow and Net New count deals by kind, and milestone billing lines are kept
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 018. Safe to run more than once. One transaction.
--
-- 1. Grow and Net New build their branch rows from the deals, each in its own Aspire branch, whoever sold it:
--      Grow     existing-client work: the property had a won deal before this one
--      Net New  work on a property new to the book
--    The same property test the Summit filter uses. Typed numbers (site audits) and commitments still come from the team's
--    reps rostered at that branch. Why: Oakwood's enhancement work is sold by Net New reps, and no one on Grow is rostered
--    at Oakwood, so Grow showed no Oakwood row at all. To count by division instead, set "deals": {"division": "Enhancement"}.
-- 2. deal_board's billing schedule keeps milestone lines. 131 contracts bill a down payment or a completion payment with no
--    month; those lines now land on the contract's start month instead of being dropped.

begin;

update workspaces set tabs = (
  select jsonb_agg(case t ->> 'key'
                     when 'grow' then t || '{"deals": {"kind": "enhancement"}}'::jsonb
                     when 'netnew' then t || '{"deals": {"kind": "netnew"}}'::jsonb
                     else t end order by ord)
    from jsonb_array_elements(tabs) with ordinality x(t, ord))
 where slug = 'elevation-outdoors' and jsonb_typeof(tabs) = 'array';

create or replace view deal_board with (security_invoker = true) as
select
  d.workspace_id,
  d.id as deal_id,
  d.source_id,
  s.mode as source_mode,
  s.label as source_label,
  d.external_id,
  d.external_number,
  d.account_id,
  d.account,
  d.job,
  d.property_id,
  d.rep_name,
  m.id          as member_id,
  m.full_name   as member_name,
  m.role        as member_role,
  m.team        as member_team,
  m.active      as member_active,
  (m.id is null) as unassigned,
  d.branch,
  d.division,
  d.category,
  d.stage,
  summit_pipeline_status(summit_stage_config(w.pipeline, to_jsonb(w) -> 'stages'), d.stage) as status,
  d.value_estimated,
  d.value_won,
  d.close_date,
  d.start_date,
  d.won_date,
  d.lost_date,
  d.created_date,
  d.end_date,
  d.renewal_date,
  d.bid_date,
  d.stage_date,
  d.next_step,
  d.next_step_date,
  d.last_activity,
  d.notes,
  d.contact,
  d.segment,
  d.priority,
  d.installed,
  d.ext_modified_at,
  d.synced_at,
  d.created_at,
  d.updated_at,
  (summit_pipeline_excluded(w.pipeline, d.account, d.job)
   or exists (select 1 from jsonb_array_elements_text(coalesce(w.pipeline -> 'exclude' -> 'divisions', '[]')) x
               where summit_name_key(x) = summit_name_key(d.division))) as excluded,
  -- the billing schedule, as [month number, amount] pairs, active lines only. Aspire gives no year:
  -- the board places each month inside the contract's start and end dates.
  case when jsonb_typeof(d.raw -> 'OpportunityBillings') = 'array' then
    -- a milestone line (down payment, on completion) has no month: it lands on the contract's start month
    (select jsonb_agg(jsonb_build_array(z.mon, z.amt) order by z.ord nulls last, z.mon)
       from (select coalesce(case when (x ->> 'BillMonth') ~ '^([1-9]|1[0-2])$' then (x ->> 'BillMonth')::int end,
                             extract(month from d.start_date)::int) as mon,
                    (x ->> 'InvoiceAmount')::numeric as amt,
                    case when coalesce(x ->> 'SortOrder', '') ~ '^-?\d+$' then (x ->> 'SortOrder')::int end as ord
               from jsonb_array_elements(d.raw -> 'OpportunityBillings') x
              where jsonb_typeof(x) = 'object' and coalesce(x ->> 'Active', 'true') <> 'false'
                and (x ->> 'InvoiceAmount') ~ '^-?\d+(\.\d+)?$'
                and ((x ->> 'BillMonth') ~ '^([1-9]|1[0-2])$' or d.start_date is not null)) z)
  end as billing
from deals d
join deal_sources s on s.id = d.source_id
join workspaces w on w.id = d.workspace_id
left join lateral (
  select mm.id, mm.full_name, mm.role, mm.team, mm.active
    from members mm
   where mm.workspace_id = d.workspace_id
     and (case when d.owner_member_id is not null then mm.id = d.owner_member_id
               else summit_name_key(d.rep_name) in (summit_name_key(mm.full_name), summit_name_key(mm.crm_name)) end)
   order by mm.active desc, (summit_name_key(mm.crm_name) = summit_name_key(d.rep_name)) desc nulls last, mm.id
   limit 1
) m on true
where d.removed_at is null;

commit;

select t ->> 'key' as tab, t -> 'deals' as counts_deals
  from workspaces w cross join jsonb_array_elements(w.tabs) t where w.slug = 'elevation-outdoors' and t ->> 'key' in ('grow', 'netnew');
select count(*) filter (where billing is not null) as with_schedule, count(*) filter (where status = 'won' and billing is not null) as won_with_schedule
  from deal_board b join workspaces w on w.id = b.workspace_id where w.slug = 'elevation-outdoors';
