-- Summit  migration 012  one deal layer for every source
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 011.
-- Safe to run more than once. One transaction: if the parity check at the end fails, it rolls back and nothing changes.
--
-- A workspace has exactly one source of truth for deals, in deal_sources:
--   connected  a CRM feeds it through a connector. Read only in Summit. Elevation (Aspire) is this.
--   csv        a leader uploads a file. Read only between uploads. (migration 013)
--   native     people type deals in Summit, and Summit is the system of record. (migration 014)
-- The unique key on workspace_id is the rule: one workspace, one source.
--
-- Every deal, whatever its source, lives in deals, keyed on (source_id, external_id). The mapping from a
-- source's own field names to the canonical columns is config, in deal_sources.mapping. Each canonical
-- field names the source field it comes from, or a list tried in order (first non-blank wins). Types come
-- from the canonical column: *_date is a date, value_* is a number, ext_modified_at a timestamp, the rest text.
-- A connector is a fetcher (log in, page through) plus a mapping. Aspire is the first one.
--
-- What changes for Elevation: nothing on screen. aspire_opps is copied into deals through the Aspire mapping,
-- and the old names stay as compatibility views and wrapper functions, so the board on main and the deployed
-- aspire-sync function keep working untouched. aspire_opps itself is left in place, frozen, for rollback.
-- A later migration drops it and the compatibility names once source-sync is deployed.

begin;

-- ============================================================
-- 1. SOURCES
-- ============================================================

create table if not exists deal_sources (
  id             bigint generated always as identity primary key,
  workspace_id   uuid not null unique references workspaces(id) on delete cascade,
  mode           text not null check (mode in ('connected', 'csv', 'native')),
  connector      text,                                  -- connected only: aspire. hubspot, salesforce... when built
  label          text not null,                         -- what the board calls it: Aspire, CSV upload, Summit
  mapping        jsonb not null default '{}'::jsonb,    -- canonical field -> source field(s)
  schedule       text,                                  -- cron, UTC. connected only
  credential_ref text,                                  -- a name, never the secret: env:ASPIRE, vault:<name>
  options        jsonb not null default '{}'::jsonb,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((mode = 'connected') = (connector is not null))
);

alter table deal_sources enable row level security;
revoke all on deal_sources from anon, authenticated;
grant select on deal_sources to authenticated;
grant all on deal_sources to service_role;
drop policy if exists deal_sources_read on deal_sources;
create policy deal_sources_read on deal_sources for select to authenticated using (
  exists (select 1 from members m where m.workspace_id = deal_sources.workspace_id and m.user_id = auth.uid() and m.active)
  or exists (select 1 from app_admins a where a.user_id = auth.uid()));

-- Aspire's fields, as the sync has always read them. Any workspace that reads Aspire or holds Aspire rows.
do $$
begin
  insert into deal_sources (workspace_id, mode, connector, label, schedule, credential_ref, mapping)
  select w.id, 'connected', 'aspire', 'Aspire', '17 7 * * *', 'env:ASPIRE', '{
    "external_id": "OpportunityID",
    "external_number": "OpportunityNumber",
    "job": "OpportunityName",
    "account": "PropertyName",
    "property_id": "PropertyID",
    "rep_name": "SalesRepContactName",
    "branch": "BranchName",
    "division": "DivisionName",
    "stage": "OpportunityStatusName",
    "value_estimated": "EstimatedDollars",
    "value_won": "WonDollars",
    "start_date": "StartDate",
    "close_date": "AnticipatedCloseDate",
    "won_date": "WonDate",
    "lost_date": "LostDate",
    "created_date": ["CreatedDateTime", "CreatedDate"],
    "end_date": "EndDate",
    "renewal_date": "RenewalDate",
    "ext_modified_at": "ModifiedDate"
  }'::jsonb
    from workspaces w
   where to_jsonb(w) ->> 'crm_source' = 'aspire'
      or (to_regclass('public.aspire_opps') is not null and exists (select 1 from aspire_opps a where a.workspace_id = w.id))
  on conflict (workspace_id) do nothing;
end $$;

-- every other workspace types its deals in Summit
insert into deal_sources (workspace_id, mode, label)
select w.id, 'native', 'Summit' from workspaces w
 where not exists (select 1 from deal_sources s where s.workspace_id = w.id)
on conflict (workspace_id) do nothing;

-- ============================================================
-- 2. READING A SOURCE RECORD THROUGH ITS MAPPING
-- ============================================================

-- the value of one canonical field: the named source field, or the first non-blank of a list
create or replace function source_get(p_rec jsonb, p_spec jsonb) returns text
language sql immutable as $$
  select case jsonb_typeof(p_spec)
    when 'string' then p_rec ->> (p_spec #>> '{}')
    when 'array' then (select p_rec ->> f from jsonb_array_elements_text(p_spec) with ordinality x(f, i)
                        where nullif(btrim(coalesce(p_rec ->> f, '')), '') is not null order by i limit 1)
  end $$;

-- numbers: 12500, "12500.50", "$12,500" all read; anything else is null
create or replace function source_num(t text) returns numeric
language sql immutable as $$
  select case when regexp_replace(coalesce(t, ''), '[$,\s]', '', 'g') ~ '^-?\d+(\.\d+)?$'
              then regexp_replace(t, '[$,\s]', '', 'g')::numeric end $$;

-- dates: 2026-10-02, 2026-10-02T00:00:00, 10/2/2026, 10/2/26. An impossible date is null, never an error.
create or replace function source_date(t text) returns date
language plpgsql immutable as $$
begin
  if t ~ '^\d{4}-\d{2}-\d{2}' then return left(t, 10)::date; end if;
  if t ~ '^\s*\d{1,2}/\d{1,2}/\d{4}\s*$' then return to_date(btrim(t), 'MM/DD/YYYY'); end if;
  if t ~ '^\s*\d{1,2}/\d{1,2}/\d{2}\s*$' then return to_date(btrim(t), 'MM/DD/YY'); end if;
  return null;
exception when others then return null;
end $$;

create or replace function source_ts(t text) returns timestamp
language plpgsql immutable as $$
begin
  if t ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}' then return replace(left(t, 19), 'T', ' ')::timestamp; end if;
  return source_date(t)::timestamp;
exception when others then return null;
end $$;

-- a source record as Summit's canonical fields, typed by the canonical column. One function for the sync,
-- the CSV preview and the CSV upload, so they can never read a field two different ways.
create or replace function source_map(p_mapping jsonb, p_rec jsonb) returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'external_id',     nullif(btrim(coalesce(source_get(p_rec, p_mapping->'external_id'), '')), ''),
    'external_number', source_get(p_rec, p_mapping->'external_number'),
    'job',             source_get(p_rec, p_mapping->'job'),
    'account',         source_get(p_rec, p_mapping->'account'),
    'property_id',     nullif(btrim(coalesce(source_get(p_rec, p_mapping->'property_id'), '')), ''),
    'rep_name',        source_get(p_rec, p_mapping->'rep_name'),
    'branch',          source_get(p_rec, p_mapping->'branch'),
    'division',        source_get(p_rec, p_mapping->'division'),
    'stage',           source_get(p_rec, p_mapping->'stage'),
    'value_estimated', source_num(source_get(p_rec, p_mapping->'value_estimated')),
    'value_won',       source_num(source_get(p_rec, p_mapping->'value_won')),
    'start_date',      source_date(source_get(p_rec, p_mapping->'start_date')),
    'close_date',      source_date(source_get(p_rec, p_mapping->'close_date')),
    'won_date',        source_date(source_get(p_rec, p_mapping->'won_date')),
    'lost_date',       source_date(source_get(p_rec, p_mapping->'lost_date')),
    'created_date',    source_date(source_get(p_rec, p_mapping->'created_date')),
    'end_date',        source_date(source_get(p_rec, p_mapping->'end_date')),
    'renewal_date',    source_date(source_get(p_rec, p_mapping->'renewal_date')),
    'ext_modified_at', source_ts(source_get(p_rec, p_mapping->'ext_modified_at')))) $$;

-- ============================================================
-- 3. DEALS
-- ============================================================

create table if not exists deals (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  source_id       bigint not null references deal_sources(id) on delete cascade,
  external_id     text,                 -- the source's id. null for deals typed in Summit
  external_number text,                 -- the number people say out loud (Aspire's OpportunityNumber)
  account_id      uuid,                 -- native: the account list (migration 014)
  account         text,
  job             text,
  property_id     text,                 -- the source's id for the account, when it has one
  owner_member_id uuid references members(id) on delete set null,  -- native: who owns it
  rep_name        text,                 -- connected and csv: the source's rep, matched to the roster by name
  branch          text,
  division        text,
  category        text,                 -- native: typed. Others: from division rules in config
  stage           text,
  value_estimated numeric,
  value_won       numeric,
  close_date      date,
  start_date      date,
  won_date        date,
  lost_date       date,
  created_date    date,
  end_date        date,
  renewal_date    date,
  bid_date        date,
  stage_date      date,                 -- the last stage change
  next_step       text,
  next_step_date  date,
  last_activity   date,
  notes           text,
  contact         text,
  segment         text,
  priority        boolean not null default false,
  installed       boolean not null default false,
  ext_modified_at timestamp,            -- the source's own clock
  raw             jsonb,                -- the whole source record, untouched
  seen_run        bigint,
  seen_at         timestamptz,
  removed_at      timestamptz,          -- the source no longer has it. Kept, off the board
  synced_at       timestamptz not null default now(),   -- last time a sync changed it
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);
create unique index if not exists deals_source_ext on deals (source_id, external_id);
create index if not exists deals_ws on deals (workspace_id) where removed_at is null;
create index if not exists deals_rep on deals (workspace_id, rep_name);

alter table deals enable row level security;
revoke all on deals from anon, authenticated;
grant select on deals to authenticated;
grant all on deals to service_role;
drop policy if exists deals_read on deals;
create policy deals_read on deals for select to authenticated using (
  exists (select 1 from members m where m.workspace_id = deals.workspace_id and m.user_id = auth.uid() and m.active)
  or exists (select 1 from app_admins a where a.user_id = auth.uid()));

-- ============================================================
-- 4. RUNS AND SNAPSHOTS, renamed for every source
-- ============================================================

do $$
begin
  if to_regclass('public.source_runs') is null and exists (select 1 from pg_class where oid = to_regclass('public.aspire_sync_runs') and relkind = 'r') then
    alter table aspire_sync_runs rename to source_runs;
  end if;
end $$;
create table if not exists source_runs (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  started_at timestamptz not null default now(), finished_at timestamptz,
  trigger text not null default 'manual', mode text not null, since timestamp,
  status text not null default 'running',
  rows_pulled int not null default 0, rows_inserted int not null default 0, rows_updated int not null default 0,
  rows_unchanged int not null default 0, rows_removed int not null default 0, pages int not null default 0, calls int not null default 0,
  max_modified timestamp, unmatched jsonb not null default '[]'::jsonb, errors jsonb not null default '[]'::jsonb, notes jsonb not null default '[]'::jsonb
);
alter table source_runs add column if not exists source_id bigint references deal_sources(id) on delete cascade;
alter table source_runs add column if not exists file_name text;
alter table source_runs add column if not exists run_by uuid;
update source_runs r set source_id = s.id from deal_sources s where s.workspace_id = r.workspace_id and r.source_id is null;
create index if not exists source_runs_source on source_runs (source_id, started_at desc);
alter table source_runs enable row level security;
drop policy if exists aspire_sync_runs_read on source_runs;
drop policy if exists source_runs_read on source_runs;
create policy source_runs_read on source_runs for select to authenticated using (
  exists (select 1 from members m where m.workspace_id = source_runs.workspace_id and m.user_id = auth.uid() and m.active)
  or exists (select 1 from app_admins a where a.user_id = auth.uid()));
revoke all on source_runs from anon, authenticated;
grant select on source_runs to authenticated;
grant all on source_runs to service_role;

create table if not exists deal_snapshots (
  deal_id         uuid not null references deals(id) on delete cascade,
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  snap_date       date not null,
  stage           text,
  value_estimated numeric,
  value_won       numeric,
  run_id          bigint,
  recorded_at     timestamptz not null default now(),
  primary key (deal_id, snap_date)
);
create index if not exists deal_snapshots_day on deal_snapshots (workspace_id, snap_date);
alter table deal_snapshots enable row level security;
revoke all on deal_snapshots from anon, authenticated;
grant select on deal_snapshots to authenticated;
grant all on deal_snapshots to service_role;
drop policy if exists deal_snapshots_read on deal_snapshots;
create policy deal_snapshots_read on deal_snapshots for select to authenticated using (
  exists (select 1 from members m where m.workspace_id = deal_snapshots.workspace_id and m.user_id = auth.uid() and m.active)
  or exists (select 1 from app_admins a where a.user_id = auth.uid()));

-- ============================================================
-- 5. ELEVATION'S DEALS, through the Aspire mapping
-- Read from the raw record, so the copy proves the mapping, not the old columns.
-- ============================================================

do $$
begin
  if exists (select 1 from pg_class where oid = to_regclass('public.aspire_opps') and relkind = 'r') then
    insert into deals (workspace_id, source_id, external_id, external_number, job, account, property_id, rep_name, branch, division,
                       stage, value_estimated, value_won, start_date, close_date, won_date, lost_date, created_date, end_date,
                       renewal_date, ext_modified_at, raw, seen_run, seen_at, removed_at, synced_at, created_at)
    select a.workspace_id, s.id, p.external_id, p.external_number, p.job, p.account, p.property_id, p.rep_name, p.branch, p.division,
           p.stage, p.value_estimated, p.value_won, p.start_date, p.close_date, p.won_date, p.lost_date, p.created_date, p.end_date,
           p.renewal_date, p.ext_modified_at, a.raw, a.seen_run, a.seen_at, a.removed_at, a.synced_at, a.first_seen_at
      from aspire_opps a
      join deal_sources s on s.workspace_id = a.workspace_id and s.connector = 'aspire'
      cross join lateral jsonb_populate_record(null::deals, source_map(s.mapping, a.raw)) p
     where p.external_id is not null
    on conflict (source_id, external_id) do nothing;
  end if;
  if exists (select 1 from pg_class where oid = to_regclass('public.aspire_status_snapshots') and relkind = 'r') then
    insert into deal_snapshots (deal_id, workspace_id, snap_date, stage, value_estimated, value_won, run_id, recorded_at)
    select d.id, o.workspace_id, o.snap_date, o.status_name, o.estimated_dollars, o.won_dollars, o.run_id, o.recorded_at
      from aspire_status_snapshots o
      join deal_sources s on s.workspace_id = o.workspace_id
      join deals d on d.source_id = s.id and d.external_id = o.opportunity_id::text
    on conflict (deal_id, snap_date) do nothing;
  end if;
end $$;

-- ============================================================
-- 6. THE BOARD VIEW, one shape for every source
-- ============================================================

-- the statuses a workspace's config gives its stages: pipeline.statuses, else the typed stages
create or replace function summit_stage_config(p_pipeline jsonb, p_stages jsonb) returns jsonb
language sql immutable as $$
  select case when jsonb_typeof(p_pipeline -> 'statuses') = 'array' then p_pipeline
              else coalesce(p_pipeline, '{}'::jsonb) || jsonb_build_object('statuses', coalesce(p_stages, '[]'::jsonb)) end $$;

-- what the board reads right now, before anything moves. Checked again at the end.
drop table if exists _parity_before;
create temp table _parity_before as
select workspace_id, status, count(*) as n, coalesce(sum(estimated_dollars), 0) as est, coalesce(sum(won_dollars), 0) as won,
       count(member_id) as matched, count(*) filter (where excluded) as excluded
  from aspire_pipeline
 group by 1, 2;

drop view if exists aspire_unmatched;
drop view if exists aspire_pipeline;
drop view if exists deal_unmatched;
drop view if exists deal_board;

create view deal_board with (security_invoker = true) as
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
  summit_pipeline_excluded(w.pipeline, d.account, d.job) as excluded
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

-- the source's rep names nobody on the roster matches, test data left out
create view deal_unmatched with (security_invoker = true) as
select workspace_id,
       coalesce(nullif(btrim(rep_name), ''), '(no rep in the source)') as rep_name,
       count(*)::int                                                     as deals,
       (count(*) filter (where status = 'open'))::int                    as open_deals,
       coalesce(sum(value_estimated) filter (where status = 'open'), 0)  as open_estimated,
       (count(*) filter (where status = 'won'))::int                     as won_deals,
       coalesce(sum(value_won) filter (where status = 'won'), 0)         as won_dollars
  from deal_board
 where unassigned and not excluded and source_mode <> 'native'
 group by 1, 2;

-- ---- compatibility: the names the board on main and the deployed aspire-sync read. Dropped later. ----
create view aspire_pipeline with (security_invoker = true) as
select workspace_id, external_id::bigint as opportunity_id, external_number as opportunity_number, job as opportunity_name,
       account as property_name, rep_name as sales_rep_name, member_id, member_name, member_role, member_team, member_active,
       unassigned, branch as branch_name, division as division_name, stage as status_name, status,
       value_estimated as estimated_dollars, value_won as won_dollars, start_date, close_date as anticipated_close_date,
       won_date, lost_date, ext_modified_at as aspire_modified_at, synced_at, excluded, property_id, created_date, end_date, renewal_date
  from deal_board
 where source_mode = 'connected' and external_id ~ '^\d+$';

create view aspire_unmatched with (security_invoker = true) as
select workspace_id, case when rep_name = '(no rep in the source)' then '(no rep in Aspire)' else rep_name end as sales_rep_name, deals, open_deals, open_estimated, won_deals, won_dollars
  from deal_unmatched u
 where exists (select 1 from deal_sources s where s.workspace_id = u.workspace_id and s.mode = 'connected');

do $$
begin
  if exists (select 1 from pg_class where oid = to_regclass('public.aspire_sync_runs') and relkind = 'v') or to_regclass('public.aspire_sync_runs') is null then
    execute 'create or replace view aspire_sync_runs with (security_invoker = true) as select * from source_runs';
  end if;
  if exists (select 1 from pg_class where oid = to_regclass('public.aspire_status_snapshots') and relkind = 'r') then
    drop table aspire_status_snapshots;
  end if;
end $$;
create or replace view aspire_status_snapshots with (security_invoker = true) as
select p.workspace_id, d.external_id::bigint as opportunity_id, p.snap_date, p.stage as status_name,
       p.value_estimated as estimated_dollars, p.value_won as won_dollars, p.run_id, p.recorded_at
  from deal_snapshots p join deals d on d.id = p.deal_id
 where d.external_id ~ '^\d+$';

grant select on deal_board, deal_unmatched, aspire_pipeline, aspire_unmatched, aspire_sync_runs, aspire_status_snapshots to authenticated;

-- ============================================================
-- 7. THE SYNC, for any source. Service role only.
-- ============================================================

drop function if exists aspire_snapshot(uuid, bigint);

-- every live deal's stage and dollars for the day, in the workspace's clock. A second run that day overwrites it.
create or replace function source_snapshot(p_source bigint, p_run bigint default null)
returns int language plpgsql security definer set search_path = public as $$
declare d date; n int;
begin
  select (now() at time zone coalesce(nullif(to_jsonb(w) ->> 'lock_tz', ''), 'America/New_York'))::date into d
    from deal_sources s join workspaces w on w.id = s.workspace_id where s.id = p_source;
  insert into deal_snapshots as t (deal_id, workspace_id, snap_date, stage, value_estimated, value_won, run_id)
  select x.id, x.workspace_id, d, x.stage, x.value_estimated, x.value_won, p_run
    from deals x where x.source_id = p_source and x.removed_at is null
  on conflict (deal_id, snap_date) do update set stage = excluded.stage, value_estimated = excluded.value_estimated,
    value_won = excluded.value_won, run_id = excluded.run_id, recorded_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- start a run for a source: full or incremental, and the cutoff from the last good run's newest record
create or replace function source_sync_begin(p_source bigint, p_trigger text default 'manual', p_full boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s deal_sources; wm timestamp; run_id bigint; m text;
begin
  select * into s from deal_sources where id = p_source;
  if s.id is null then return jsonb_build_object('error', format('no source %s', p_source)); end if;
  if s.mode = 'native' then return jsonb_build_object('error', 'this workspace types its deals in Summit. Nothing syncs into it'); end if;
  if not s.enabled then return jsonb_build_object('error', 'this source is turned off'); end if;

  update source_runs set status = 'error', finished_at = now(),
         errors = errors || '["never finished. the run stopped before it could log the end"]'::jsonb
   where source_id = s.id and status = 'running' and started_at < now() - interval '15 minutes';
  if exists (select 1 from source_runs where source_id = s.id and status = 'running') then
    return jsonb_build_object('error', 'a sync is already running for this source');
  end if;

  select max(max_modified) into wm from source_runs where source_id = s.id and status = 'ok';
  m := case when p_full or wm is null or s.mode = 'csv' then 'full' else 'incremental' end;
  insert into source_runs (workspace_id, source_id, trigger, mode, since, run_by)
  values (s.workspace_id, s.id, coalesce(p_trigger, 'manual'), m, case when m = 'incremental' then wm - interval '1 day' end, auth.uid())
  returning id into run_id;
  return jsonb_build_object('run_id', run_id, 'source_id', s.id, 'workspace_id', s.workspace_id, 'mode', m,
    'connector', s.connector, 'credential_ref', s.credential_ref, 'options', s.options,
    'since', case when m = 'incremental' then to_char(wm - interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS') end);
end $$;

-- one page of raw source records in, through the source's mapping. A row is only rewritten when its record changed.
create or replace function source_sync_upsert(p_run bigint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public set statement_timeout = '60s' as $$
declare r source_runs; s deal_sources; m jsonb; n_src int; n_ins int; n_upd int; top_mod timestamp;
begin
  select * into r from source_runs where id = p_run;
  if r.id is null or r.status <> 'running' then raise exception 'run % is not running', p_run; end if;
  select * into s from deal_sources where id = r.source_id;
  m := s.mapping;
  if jsonb_typeof(m -> 'external_id') is null then raise exception 'source % has no external_id in its mapping', s.id; end if;

  create temp table if not exists _src (ext text primary key, rec jsonb, d jsonb) on commit drop;
  truncate _src;
  insert into _src
  select distinct on (x.d->>'external_id') x.d->>'external_id', x.e, x.d
    from (select e, source_map(m, e) as d from jsonb_array_elements(p_rows) e) x
   where x.d->>'external_id' is not null;
  get diagnostics n_src = row_count;

  with up as (
    insert into deals as t (workspace_id, source_id, external_id, external_number, job, account, property_id, rep_name, branch, division,
      stage, value_estimated, value_won, start_date, close_date, won_date, lost_date, created_date, end_date, renewal_date,
      ext_modified_at, raw, seen_run, seen_at)
    select s.workspace_id, s.id, p.external_id, p.external_number, p.job, p.account, p.property_id, p.rep_name, p.branch, p.division,
           p.stage, p.value_estimated, p.value_won, p.start_date, p.close_date, p.won_date, p.lost_date, p.created_date, p.end_date,
           p.renewal_date, p.ext_modified_at, x.rec, p_run, now()
      from _src x cross join lateral jsonb_populate_record(null::deals, x.d) p
    on conflict (source_id, external_id) do update set
      external_number = excluded.external_number, job = excluded.job, account = excluded.account, property_id = excluded.property_id,
      rep_name = excluded.rep_name, branch = excluded.branch, division = excluded.division, stage = excluded.stage,
      value_estimated = excluded.value_estimated, value_won = excluded.value_won, start_date = excluded.start_date,
      close_date = excluded.close_date, won_date = excluded.won_date, lost_date = excluded.lost_date,
      created_date = excluded.created_date, end_date = excluded.end_date, renewal_date = excluded.renewal_date,
      ext_modified_at = excluded.ext_modified_at, raw = excluded.raw,
      synced_at = now(), seen_at = now(), seen_run = p_run, removed_at = null, updated_at = now()
    where t.raw is distinct from excluded.raw or t.removed_at is not null
    returning (xmax = 0) as ins
  )
  select count(*) filter (where ins), count(*) filter (where not ins) into n_ins, n_upd from up;

  update deals t set seen_at = now(), seen_run = p_run
    from _src x where t.source_id = s.id and t.external_id = x.ext and t.seen_run is distinct from p_run;

  select max((d->>'ext_modified_at')::timestamp) into top_mod from _src;
  update source_runs set
    rows_pulled = rows_pulled + n_src, rows_inserted = rows_inserted + n_ins, rows_updated = rows_updated + n_upd,
    rows_unchanged = rows_unchanged + (n_src - n_ins - n_upd), pages = pages + 1,
    max_modified = greatest(max_modified, top_mod)
   where id = p_run;
  return jsonb_build_object('pulled', n_src, 'inserted', n_ins, 'updated', n_upd, 'unchanged', n_src - n_ins - n_upd);
end $$;

-- close a run. A connector's complete full pull marks what the source no longer returns as removed (kept, off
-- the board). A CSV upload never removes on its own: p_remove lists the external ids a leader confirmed.
create or replace function source_sync_finish(p_run bigint, p_status text, p_calls int default 0,
  p_errors jsonb default '[]'::jsonb, p_notes jsonb default '[]'::jsonb, p_complete boolean default false,
  p_remove text[] default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r source_runs; s deal_sources; n_rem int := 0; um jsonb; n_snap int := 0;
begin
  select * into r from source_runs where id = p_run;
  if r.id is null then raise exception 'no run %', p_run; end if;
  select * into s from deal_sources where id = r.source_id;
  if s.mode = 'connected' and r.mode = 'full' and p_status = 'ok' and p_complete then
    update deals set removed_at = now() where source_id = s.id and removed_at is null and seen_run is distinct from r.id;
    get diagnostics n_rem = row_count;
  elsif s.mode = 'csv' and p_status = 'ok' and p_remove is not null then
    update deals set removed_at = now()
     where source_id = s.id and removed_at is null and external_id = any (p_remove) and seen_run is distinct from r.id;
    get diagnostics n_rem = row_count;
  end if;
  if p_status in ('ok', 'partial') then n_snap := source_snapshot(s.id, r.id); end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', rep_name, 'deals', deals, 'open_deals', open_deals,
           'open_estimated', open_estimated, 'won_deals', won_deals) order by deals desc, rep_name), '[]'::jsonb)
    into um from deal_unmatched where workspace_id = s.workspace_id;
  update source_runs set status = p_status, finished_at = now(), calls = coalesce(p_calls, 0),
         errors = coalesce(p_errors, '[]'::jsonb),
         notes = coalesce(p_notes, '[]'::jsonb) || case when n_snap > 0 then jsonb_build_array(format('status snapshot: %s deals', n_snap)) else '[]'::jsonb end,
         rows_removed = n_rem, unmatched = um
   where id = p_run
   returning * into r;
  return to_jsonb(r);
end $$;

-- which source a sync run is for: a workspace's, or the only enabled connected source when none is named
create or replace function source_sync_resolve(p_slug text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare sid bigint; n int;
begin
  if p_slug is not null then
    select s.id into sid from deal_sources s join workspaces w on w.id = s.workspace_id where w.slug = p_slug;
    if sid is null then return jsonb_build_object('error', format('no deal source for workspace %s', p_slug)); end if;
  else
    select count(*), min(id) into n, sid from deal_sources where mode = 'connected' and enabled;
    if n = 0 then return jsonb_build_object('error', 'no workspace has a connected source'); end if;
    if n > 1 then return jsonb_build_object('error', 'more than one connected source. pass {"source": <id>} or {"workspace": "<slug>"}'); end if;
  end if;
  return jsonb_build_object('source_id', sid);
end $$;

-- ---- compatibility: the deployed aspire-sync calls these names. They hand off to source_sync_*. ----
create or replace function aspire_sync_begin(p_slug text default null, p_trigger text default 'manual', p_full boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare sid bigint; n int;
begin
  if p_slug is not null then
    select s.id into sid from deal_sources s join workspaces w on w.id = s.workspace_id where w.slug = p_slug and s.connector = 'aspire';
    if sid is null then return jsonb_build_object('error', format('no Aspire source for workspace %s', p_slug)); end if;
  else
    select count(*), min(id) into n, sid from deal_sources where connector = 'aspire' and enabled;
    if n = 0 then return jsonb_build_object('error', 'no workspace has an Aspire source'); end if;
    if n > 1 then return jsonb_build_object('error', 'more than one workspace has an Aspire source. pass {"workspace": "<slug>"}'); end if;
  end if;
  return source_sync_begin(sid, p_trigger, p_full);
end $$;
create or replace function aspire_sync_upsert(p_run bigint, p_rows jsonb)
returns jsonb language sql security definer set search_path = public set statement_timeout = '60s' as $$ select source_sync_upsert(p_run, p_rows) $$;
create or replace function aspire_sync_finish(p_run bigint, p_status text, p_calls int default 0,
  p_errors jsonb default '[]'::jsonb, p_notes jsonb default '[]'::jsonb, p_complete boolean default false)
returns jsonb language sql security definer set search_path = public as $$
  select source_sync_finish(p_run, p_status, p_calls, p_errors, p_notes, p_complete) $$;

-- run a connected source now, through the source-sync function. Nightly cron calls this once source-sync is deployed.
create or replace function source_sync_now(p_source bigint, p_trigger text default 'manual', p_full boolean default false)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'aspire_sync_key';
  if k is null then
    raise exception 'no vault secret named aspire_sync_key. Run: select vault.create_secret(''<service role key>'', ''aspire_sync_key'');';
  end if;
  return net.http_post(
    url     := 'https://tyrtzxnhwjchtemytfxv.supabase.co/functions/v1/source-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k),
    body    := jsonb_build_object('source', p_source, 'full', p_full, 'trigger', p_trigger),
    timeout_milliseconds := 150000);
end $$;

-- one nightly job per enabled connected source, on its schedule. Run after source-sync is deployed (see README).
create or replace function source_schedule_apply() returns setof text
language plpgsql security definer set search_path = public, extensions as $$
declare s record;
begin
  for s in select id, schedule, enabled from deal_sources where mode = 'connected' loop
    if exists (select 1 from cron.job where jobname = 'source-sync-' || s.id) then perform cron.unschedule('source-sync-' || s.id); end if;
    if s.enabled and s.schedule is not null then
      perform cron.schedule('source-sync-' || s.id, s.schedule, format('select source_sync_now(%s, %L)', s.id, 'cron'));
      return next 'source-sync-' || s.id || ' ' || s.schedule;
    end if;
  end loop;
end $$;

revoke execute on function source_sync_begin(bigint, text, boolean) from public, anon, authenticated;
revoke execute on function source_sync_upsert(bigint, jsonb) from public, anon, authenticated;
revoke execute on function source_sync_finish(bigint, text, int, jsonb, jsonb, boolean, text[]) from public, anon, authenticated;
revoke execute on function source_snapshot(bigint, bigint) from public, anon, authenticated;
revoke execute on function source_sync_resolve(text) from public, anon, authenticated;
revoke execute on function source_sync_now(bigint, text, boolean) from public, anon, authenticated;
revoke execute on function source_schedule_apply() from public, anon, authenticated;
revoke execute on function aspire_sync_begin(text, text, boolean) from public, anon, authenticated;
revoke execute on function aspire_sync_upsert(bigint, jsonb) from public, anon, authenticated;
revoke execute on function aspire_sync_finish(bigint, text, int, jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function source_sync_begin(bigint, text, boolean), source_sync_upsert(bigint, jsonb),
  source_sync_finish(bigint, text, int, jsonb, jsonb, boolean, text[]), source_snapshot(bigint, bigint), source_sync_resolve(text),
  aspire_sync_begin(text, text, boolean), aspire_sync_upsert(bigint, jsonb),
  aspire_sync_finish(bigint, text, int, jsonb, jsonb, boolean) to service_role;

-- targets: the division is whatever the workspace's filter calls it, not only maintenance and install
alter table summit_targets drop constraint if exists summit_targets_division_check;

-- ============================================================
-- 8. PARITY. The board must read exactly what it read before, or nothing above happens.
-- ============================================================

do $$
declare bad text;
begin
  select string_agg(format('%s %s: before %s deals $%s est $%s won %s matched %s test, after %s deals $%s est $%s won %s matched %s test',
                           coalesce(b.workspace_id, a.workspace_id), coalesce(b.status, a.status), b.n, b.est, b.won, b.matched, b.excluded,
                           a.n, a.est, a.won, a.matched, a.excluded), '; ')
    into bad
    from _parity_before b
    full join (select workspace_id, status, count(*) as n, coalesce(sum(estimated_dollars), 0) as est, coalesce(sum(won_dollars), 0) as won,
                      count(member_id) as matched, count(*) filter (where excluded) as excluded
                 from aspire_pipeline group by 1, 2) a
      on a.workspace_id = b.workspace_id and a.status = b.status
   where (b.n, b.est, b.won, b.matched, b.excluded) is distinct from (a.n, a.est, a.won, a.matched, a.excluded);
  if bad is not null then raise exception 'parity failed, nothing changed: %', bad; end if;
end $$;

commit;

-- show the result
select s.label, s.mode, w.slug, (select count(*) from deals d where d.source_id = s.id and d.removed_at is null) as live_deals,
       (select count(*) from deal_snapshots p where p.workspace_id = s.workspace_id) as snapshots
  from deal_sources s join workspaces w on w.id = s.workspace_id order by 1;
select status, count(*) as deals, round(sum(value_estimated)) as estimated, round(sum(value_won)) as won
  from deal_board b join workspaces w on w.id = b.workspace_id where w.slug = 'elevation-outdoors' group by 1 order by 2 desc;
