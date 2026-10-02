-- Summit  migration 011  the Summit tab rebuild: dates, targets, status snapshots, login link
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 010.
-- Safe to run more than once. No deal, commit, goal or book row changes. Nothing is written to Aspire.
--
-- 1. aspire_pipeline gains three dates from the raw record the sync already stores (no re-sync needed):
--      created_date  CreatedDateTime   Pipeline created, and bids on Grow, Net New and The Climb
--      end_date      EndDate           the renewal fallback
--      renewal_date  RenewalDate       the renewals strip
-- 2. summit_targets: monthly targets per branch. Leaders and admins write, the workspace reads.
--      branch    '' is the whole company. A branch name is that branch.
--      month     the first of the month
--      metric    closed | created | forecast  (the Summit tiles)
--      division  all | maintenance | install
--      kind      all | enhancement | netnew   (the editor sets "all" only, for now)
--    Empty until leadership fills it in. A tile with no target says "no target set".
-- 3. aspire_status_snapshots: every deal's status and dollars, once a day, written when a sync run
--    finishes. Aspire keeps no stage history, so "pipeline advanced" is measurable from the first
--    snapshot forward. About 2,000 rows a night.
-- 4. summit_link_member(): ties a signed-in login to its roster row and admin row by email. The app
--    calls it on every sign-in, so a login made by a dashboard invite still lands on the board.

-- ============================================================
-- 1. THE DATES
-- ============================================================

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
  nullif(btrim(a.raw->>'PropertyID'), '') as property_id,
  aspire_date(coalesce(a.raw->>'CreatedDateTime', a.raw->>'CreatedDate')) as created_date,
  aspire_date(a.raw->>'EndDate')     as end_date,
  aspire_date(a.raw->>'RenewalDate') as renewal_date
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

-- ============================================================
-- 2. TARGETS
-- ============================================================

create table if not exists summit_targets (
  workspace_id uuid    not null references workspaces(id) on delete cascade,
  branch       text    not null default '',
  month        date    not null check (extract(day from month) = 1),
  metric       text    not null check (metric in ('closed', 'created', 'forecast')),
  division     text    not null default 'all' check (division in ('all', 'maintenance', 'install')),
  kind         text    not null default 'all' check (kind in ('all', 'enhancement', 'netnew')),
  amount       numeric not null check (amount >= 0),
  updated_by   uuid    default auth.uid(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, branch, month, metric, division, kind)
);

alter table summit_targets enable row level security;
revoke all on summit_targets from anon;
grant select, insert, update, delete on summit_targets to authenticated;

drop policy if exists summit_targets_read on summit_targets;
create policy summit_targets_read on summit_targets for select to authenticated using (
  exists (select 1 from members m where m.workspace_id = summit_targets.workspace_id and m.user_id = auth.uid() and m.active)
  or exists (select 1 from app_admins a where a.user_id = auth.uid()));

drop policy if exists summit_targets_write on summit_targets;
create policy summit_targets_write on summit_targets for all to authenticated using (
  exists (select 1 from members m where m.workspace_id = summit_targets.workspace_id and m.user_id = auth.uid() and m.active and m.role = 'leader')
  or exists (select 1 from app_admins a where a.user_id = auth.uid()))
with check (
  exists (select 1 from members m where m.workspace_id = summit_targets.workspace_id and m.user_id = auth.uid() and m.active and m.role = 'leader')
  or exists (select 1 from app_admins a where a.user_id = auth.uid()));

-- ============================================================
-- 3. STATUS SNAPSHOTS
-- ============================================================

create table if not exists aspire_status_snapshots (
  workspace_id      uuid   not null references workspaces(id) on delete cascade,
  opportunity_id    bigint not null,
  snap_date         date   not null,
  status_name       text,
  estimated_dollars numeric,
  won_dollars       numeric,
  run_id            bigint,
  recorded_at       timestamptz not null default now(),
  primary key (workspace_id, opportunity_id, snap_date)
);
create index if not exists aspire_status_snapshots_day on aspire_status_snapshots (workspace_id, snap_date);

alter table aspire_status_snapshots enable row level security;
revoke all on aspire_status_snapshots from anon;
revoke insert, update, delete on aspire_status_snapshots from authenticated;
grant select on aspire_status_snapshots to authenticated;
drop policy if exists aspire_status_snapshots_read on aspire_status_snapshots;
create policy aspire_status_snapshots_read on aspire_status_snapshots for select to authenticated using (
  exists (select 1 from members m where m.workspace_id = aspire_status_snapshots.workspace_id and m.user_id = auth.uid() and m.active)
  or exists (select 1 from app_admins a where a.user_id = auth.uid()));

-- one row per deal for the day, in the workspace's clock. A second run the same day overwrites it.
create or replace function aspire_snapshot(p_ws uuid, p_run bigint default null)
returns int language plpgsql security definer set search_path = public as $$
declare d date; n int;
begin
  select (now() at time zone coalesce(nullif(w.lock_tz, ''), 'America/New_York'))::date into d from workspaces w where w.id = p_ws;
  insert into aspire_status_snapshots as s (workspace_id, opportunity_id, snap_date, status_name, estimated_dollars, won_dollars, run_id)
  select a.workspace_id, a.opportunity_id, d, a.status_name, a.estimated_dollars, a.won_dollars, p_run
    from aspire_opps a
   where a.workspace_id = p_ws and a.removed_at is null
  on conflict (workspace_id, opportunity_id, snap_date) do update set
    status_name = excluded.status_name, estimated_dollars = excluded.estimated_dollars,
    won_dollars = excluded.won_dollars, run_id = excluded.run_id, recorded_at = now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function aspire_snapshot(uuid, bigint) from public, anon, authenticated;
grant execute on function aspire_snapshot(uuid, bigint) to service_role;

-- 007's finish, plus the snapshot after any run that saved rows (ok or partial). Same signature.
create or replace function aspire_sync_finish(p_run bigint, p_status text, p_calls int default 0,
  p_errors jsonb default '[]'::jsonb, p_notes jsonb default '[]'::jsonb, p_complete boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r aspire_sync_runs; n_rem int := 0; um jsonb; n_snap int := 0;
begin
  select * into r from aspire_sync_runs where id = p_run;
  if r.id is null then raise exception 'no run %', p_run; end if;
  if r.mode = 'full' and p_status = 'ok' and p_complete then
    update aspire_opps set removed_at = now()
     where workspace_id = r.workspace_id and removed_at is null and seen_run is distinct from r.id;
    get diagnostics n_rem = row_count;
  end if;
  if p_status in ('ok', 'partial') then
    n_snap := aspire_snapshot(r.workspace_id, r.id);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', sales_rep_name, 'deals', deals, 'open_deals', open_deals,
           'open_estimated', open_estimated, 'won_deals', won_deals) order by deals desc, sales_rep_name), '[]'::jsonb)
    into um from aspire_unmatched where workspace_id = r.workspace_id;
  update aspire_sync_runs set status = p_status, finished_at = now(), calls = coalesce(p_calls, 0),
         errors = coalesce(p_errors, '[]'::jsonb),
         notes = coalesce(p_notes, '[]'::jsonb) || case when n_snap > 0 then jsonb_build_array(format('status snapshot: %s deals', n_snap)) else '[]'::jsonb end,
         rows_removed = n_rem, unmatched = um
   where id = p_run
   returning * into r;
  return to_jsonb(r);
end $$;
revoke execute on function aspire_sync_finish(bigint, text, int, jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function aspire_sync_finish(bigint, text, int, jsonb, jsonb, boolean) to service_role;

-- the first snapshot, today, so the count starts now rather than tonight
select aspire_snapshot(id) from workspaces where crm_source = 'aspire';

-- ============================================================
-- 4. LOGIN LINK
-- ============================================================

-- the signed-in login, tied to the active roster rows and the admin row that carry its email.
-- Only fills an empty link or one pointing at a login that no longer exists. Never moves a row
-- from one live login to another.
create or replace function summit_link_member() returns int
language plpgsql security definer set search_path = public as $$
declare em text; n int := 0; k int;
begin
  if auth.uid() is null then return 0; end if;
  select lower(email) into em from auth.users where id = auth.uid();
  if coalesce(em, '') = '' then return 0; end if;
  update members m set user_id = auth.uid()
   where lower(m.email) = em and m.active
     and (m.user_id is null or not exists (select 1 from auth.users u where u.id = m.user_id));
  get diagnostics n = row_count;
  update app_admins a set user_id = auth.uid()
   where lower(a.email) = em
     and (a.user_id is null or not exists (select 1 from auth.users u where u.id = a.user_id));
  get diagnostics k = row_count;
  return n + k;
end $$;
revoke execute on function summit_link_member() from public, anon;
grant execute on function summit_link_member() to authenticated;

-- ============================================================
-- show the result
-- ============================================================

select count(*) as opportunities, count(created_date) as with_created, count(end_date) as with_end,
       count(renewal_date) as with_renewal, count(coalesce(renewal_date, end_date)) as with_renewal_or_end
  from aspire_pipeline p join workspaces w on w.id = p.workspace_id
 where w.slug = 'elevation-outdoors';
select snap_date, count(*) as deals_snapshotted from aspire_status_snapshots group by 1 order by 1 desc limit 3;
-- Joe's login: does it exist, is it tied to a roster row, is it an admin
select u.email, u.created_at::date as created, u.last_sign_in_at, u.email_confirmed_at is not null as confirmed,
       (select count(*) from members m where m.user_id = u.id and m.active) as roster_rows,
       exists (select 1 from app_admins a where a.user_id = u.id) as admin_by_login,
       exists (select 1 from app_admins a where lower(a.email) = lower(u.email)) as admin_by_email
  from auth.users u where lower(u.email) = 'joe@deaconjames.com';
