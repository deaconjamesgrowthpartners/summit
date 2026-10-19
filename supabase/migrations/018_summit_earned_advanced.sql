-- Summit  migration 018  the Summit tab for Tuesday: earned revenue, pipeline advanced, the billing forecast
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 014. Safe to run more than once. One transaction.
--
-- 1. deal_snapshots.earned: Aspire's ActualEarnedRevenue, every night, next to each deal's status. It is cumulative
--    to date (work done, not invoices), so earned in a period is the change between two nights. Counting starts with
--    the snapshot this migration takes, today. /Invoices replaces it as the earned number once it is synced.
-- 2. Elevation's status config:
--    - Delivered is a proposal out, not sold work. Aspire puts all 189 at stage Propose, none has a won date, and
--      93 of them have since gone to Lost. Open, a bid, weighted 0.8.
--    - rank: Aspire's stage ladder, Pre Bid 1, Estimate 2, Propose 3, Won 4. Lost has none. A deal advanced when it
--      reaches a higher rank than any night before. Moves inside Estimate (Bidding, Approved) are not a stage.
--    - exclude.divisions: Indirect, off every tile, counted on Data Check.
-- 3. summit_targets takes an "earned" target.
-- 4. deal_board: Indirect is excluded, and each deal carries its billing schedule for the forecast.
-- 5. deal_motion(workspace, from, to): per deal, earned in the period and the day it first advanced a stage.

begin;

-- Never redefine a function this migration did not make (see 013).
do $$
declare clash text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into clash
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = any (array['deal_stage_rank', 'deal_motion'])
     and coalesce(obj_description(p.oid, 'pg_proc'), '') not like 'summit 018%';
  if clash is not null then raise exception 'these functions already exist and are not from 018: %. Nothing changed. Send this to Claude.', clash; end if;
end $$;

-- ============================================================
-- 1. EARNED, NIGHTLY
-- ============================================================

alter table deal_snapshots add column if not exists earned numeric;

-- 012's snapshot, plus earned from the deal's own record. The nightly sync calls this through source_sync_finish,
-- so the old aspire-sync and the new source-sync both start writing it tonight.
create or replace function source_snapshot(p_source bigint, p_run bigint default null)
returns int language plpgsql security definer set search_path = public as $$
declare d date; n int;
begin
  select (now() at time zone coalesce(nullif(to_jsonb(w) ->> 'lock_tz', ''), 'America/New_York'))::date into d
    from deal_sources s join workspaces w on w.id = s.workspace_id where s.id = p_source;
  insert into deal_snapshots as t (deal_id, workspace_id, snap_date, stage, value_estimated, value_won, earned, run_id)
  select x.id, x.workspace_id, d, x.stage, x.value_estimated, x.value_won, source_num(x.raw ->> 'ActualEarnedRevenue'), p_run
    from deals x where x.source_id = p_source and x.removed_at is null
  on conflict (deal_id, snap_date) do update set stage = excluded.stage, value_estimated = excluded.value_estimated,
    value_won = excluded.value_won, earned = excluded.earned, run_id = coalesce(excluded.run_id, t.run_id), recorded_at = now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function source_snapshot(bigint, bigint) from public, anon, authenticated;
grant execute on function source_snapshot(bigint, bigint) to service_role;

-- ============================================================
-- 2. ELEVATION'S STATUSES
-- ============================================================

update workspaces w set pipeline = jsonb_set(w.pipeline, '{statuses}', (
  select jsonb_agg(
           case summit_name_key(s ->> 'name')
             when 'delivered' then s || '{"status": "open", "prob": 0.8, "bid": true, "needs_close": true}'::jsonb
             else s end
           || coalesce((select jsonb_build_object('rank', r) from (values ('new', 1), ('bidding', 2), ('pending approval', 2),
                          ('approved', 2), ('delivered', 3), ('won', 4)) v(k, r) where v.k = summit_name_key(s ->> 'name')), '{}'::jsonb)
           order by ord)
    from jsonb_array_elements(w.pipeline -> 'statuses') with ordinality x(s, ord)))
 where w.slug = 'elevation-outdoors' and jsonb_typeof(w.pipeline -> 'statuses') = 'array';

update workspaces set pipeline = jsonb_set(pipeline, '{exclude,divisions}', '["Indirect"]'::jsonb, true)
 where slug = 'elevation-outdoors' and jsonb_typeof(pipeline -> 'exclude') = 'object';

-- a status's place on the stage ladder. null for a status with no rank (Lost, or anything unmapped).
create or replace function deal_stage_rank(p_cfg jsonb, p_name text) returns int
language sql stable as $$
  select (s ->> 'rank')::int from jsonb_array_elements(coalesce(p_cfg -> 'statuses', '[]')) s
   where summit_name_key(s ->> 'name') = summit_name_key(p_name) and (s ->> 'rank') ~ '^\d+$' limit 1 $$;

-- ============================================================
-- 3. AN EARNED TARGET
-- ============================================================

-- 011 named it inline, so drop whichever check limits metric, by what it says rather than by name
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.summit_targets'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ~* '\mmetric\M' loop
    execute format('alter table summit_targets drop constraint %I', c.conname);
  end loop;
end $$;
alter table summit_targets add constraint summit_targets_metric_check check (metric in ('closed', 'created', 'forecast', 'earned'));

-- ============================================================
-- 4. THE BOARD: Indirect excluded, the billing schedule on each deal
-- ============================================================

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
    (select jsonb_agg(jsonb_build_array((x ->> 'BillMonth')::int, (x ->> 'InvoiceAmount')::numeric)
                      order by (x ->> 'SortOrder')::int nulls last, (x ->> 'BillMonth')::int)
       from jsonb_array_elements(d.raw -> 'OpportunityBillings') x
      where jsonb_typeof(x) = 'object' and coalesce(x ->> 'Active', 'true') <> 'false'
        and (x ->> 'BillMonth') ~ '^([1-9]|1[0-2])$' and (x ->> 'InvoiceAmount') ~ '^-?\d+(\.\d+)?$'
        and coalesce(x ->> 'SortOrder', '0') ~ '^-?\d+$')
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

-- ============================================================
-- 5. EARNED AND ADVANCED, FOR A PERIOD
-- Runs as the caller: row level security on deal_snapshots decides what anyone sees.
-- earned    the deal's earned revenue at the last night on or before p_to, less the last night before p_from.
--           A deal first seen inside the period counts from its first night, so nothing before tracking counts.
-- advanced  the first night in the period it reached a stage higher than any it had been at before. A deal that slides
--           back and returns has not advanced; one that comes back from Lost and is won has.
-- ============================================================

create or replace function deal_motion(p_ws uuid, p_from date, p_to date)
returns table (deal_id uuid, earned numeric, advanced_on date)
language sql stable set search_path = public as $$
  with cfg as (select pipeline from workspaces where id = p_ws),
  s as (
    select p.deal_id, p.snap_date, p.earned, deal_stage_rank((select pipeline from cfg), p.stage) as rnk,
           max(deal_stage_rank((select pipeline from cfg), p.stage))
             over (partition by p.deal_id order by p.snap_date rows between unbounded preceding and 1 preceding) as prev_rnk
      from deal_snapshots p
     where p.workspace_id = p_ws and p.snap_date <= p_to
  ),
  e as (
    select s.deal_id,
           (array_agg(s.earned order by s.snap_date desc) filter (where s.earned is not null))[1] as at_end,
           coalesce((array_agg(s.earned order by s.snap_date desc) filter (where s.earned is not null and s.snap_date < p_from))[1],
                    (array_agg(s.earned order by s.snap_date) filter (where s.earned is not null))[1]) as at_start
      from s group by s.deal_id
  ),
  a as (
    select s.deal_id, min(s.snap_date) as advanced_on from s
     where s.snap_date between p_from and p_to and s.rnk > s.prev_rnk
     group by s.deal_id
  )
  select coalesce(e.deal_id, a.deal_id), coalesce(e.at_end - e.at_start, 0), a.advanced_on
    from e full join a on a.deal_id = e.deal_id
   where coalesce(e.at_end - e.at_start, 0) <> 0 or a.deal_id is not null $$;

revoke execute on function deal_stage_rank(jsonb, text), deal_motion(uuid, date, date) from public, anon;
grant execute on function deal_stage_rank(jsonb, text), deal_motion(uuid, date, date) to authenticated, service_role;
comment on function deal_stage_rank(jsonb, text) is 'summit 018';
comment on function deal_motion(uuid, date, date) is 'summit 018';

-- ============================================================
-- 6. START COUNTING TODAY: tonight's sync adds the second night
-- ============================================================

select source_snapshot(id) from deal_sources where mode = 'connected' and enabled;

commit;

-- what changed
select w.slug, s ->> 'name' as status, s ->> 'status' as counts_as, s ->> 'prob' as prob, s ->> 'rank' as rank
  from workspaces w cross join jsonb_array_elements(w.pipeline -> 'statuses') s where w.slug = 'elevation-outdoors';
select status, count(*) as deals, round(sum(value_won)) as won_dollars, round(sum(value_estimated)) as estimated,
       count(*) filter (where excluded) as excluded, count(billing) as with_schedule
  from deal_board b join workspaces w on w.id = b.workspace_id where w.slug = 'elevation-outdoors' group by 1 order by 1;
