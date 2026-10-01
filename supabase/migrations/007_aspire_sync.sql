-- Summit  migration 007  the Aspire sync
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 006.
-- Safe to run more than once.
--
-- Aspire becomes the pipeline source for Elevation. The edge function aspire-sync reads
-- Aspire (GET only) and writes here, into aspire_opps and aspire_sync_runs. Nothing else.
-- opps, commits, goals, accounts and every other table typed in Summit are never touched.
--
-- Before the nightly run works, put the key the function accepts into the vault, once:
--   select vault.create_secret('<the service role key you ran the probe with>', 'aspire_sync_key');
-- To change it later:
--   select vault.update_secret((select id from vault.secrets where name = 'aspire_sync_key'), '<new key>');

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- ============================================================
-- 1. WHICH WORKSPACE, AND HOW A REP IS SPELLED IN THE CRM
-- ============================================================

-- the CRM a workspace's pipeline comes from. the sync runs for the workspace marked 'aspire'.
alter table workspaces add column if not exists crm_source text;
update workspaces set crm_source = 'aspire' where slug = 'elevation-outdoors';

-- when Aspire spells a rep differently from the roster, put Aspire's spelling here.
-- the view matches on full_name or crm_name. nothing else reads it.
alter table members add column if not exists crm_name text;

-- ============================================================
-- 2. TABLES. only the sync writes them (service role). everyone else reads.
-- ============================================================

create table if not exists aspire_opps (
  workspace_id           uuid   not null references workspaces(id) on delete cascade,
  opportunity_id         bigint not null,
  opportunity_number     text,
  opportunity_name       text,
  property_name          text,
  sales_rep_name         text,
  branch_name            text,
  division_name          text,
  status_name            text,
  estimated_dollars      numeric,
  won_dollars            numeric,
  start_date             date,
  anticipated_close_date date,
  won_date               date,
  lost_date              date,
  aspire_modified_at     timestamp,          -- Aspire's own clock, as Aspire sends it
  raw                    jsonb not null,     -- the whole record, untouched
  first_seen_at          timestamptz not null default now(),
  synced_at              timestamptz not null default now(),  -- last time this row's content changed
  seen_at                timestamptz not null default now(),  -- last time a run saw it
  seen_run               bigint,             -- the last run that saw it
  removed_at             timestamptz,        -- a full pull no longer returns it
  primary key (workspace_id, opportunity_id)
);
alter table aspire_opps add column if not exists seen_run bigint;
create index if not exists aspire_opps_rep on aspire_opps (workspace_id, sales_rep_name);

create table if not exists aspire_sync_runs (
  id              bigint generated always as identity primary key,
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  trigger         text not null default 'manual',   -- cron | manual
  mode            text not null,                    -- full | incremental
  since           timestamp,                        -- the ModifiedDate cutoff. null on a full pull
  status          text not null default 'running',  -- running | ok | partial | error
  rows_pulled     int not null default 0,
  rows_inserted   int not null default 0,
  rows_updated    int not null default 0,
  rows_unchanged  int not null default 0,
  rows_removed    int not null default 0,
  pages           int not null default 0,
  calls           int not null default 0,
  max_modified    timestamp,                        -- newest ModifiedDate seen. the next run starts here
  unmatched       jsonb not null default '[]'::jsonb,
  errors          jsonb not null default '[]'::jsonb,
  notes           jsonb not null default '[]'::jsonb
);
create index if not exists aspire_sync_runs_ws on aspire_sync_runs (workspace_id, started_at desc);

alter table aspire_opps enable row level security;
alter table aspire_sync_runs enable row level security;

drop policy if exists aspire_opps_read on aspire_opps;
create policy aspire_opps_read on aspire_opps for select to authenticated using (
  exists (select 1 from members m where m.workspace_id = aspire_opps.workspace_id and m.user_id = auth.uid() and m.active)
  or exists (select 1 from app_admins a where a.user_id = auth.uid()));

drop policy if exists aspire_sync_runs_read on aspire_sync_runs;
create policy aspire_sync_runs_read on aspire_sync_runs for select to authenticated using (
  exists (select 1 from members m where m.workspace_id = aspire_sync_runs.workspace_id and m.user_id = auth.uid() and m.active)
  or exists (select 1 from app_admins a where a.user_id = auth.uid()));

-- no insert, update or delete policy: signed-in users can only read. the sync uses the service role.
revoke all on aspire_opps, aspire_sync_runs from anon, authenticated;
grant select on aspire_opps, aspire_sync_runs to authenticated;
grant all on aspire_opps, aspire_sync_runs to service_role;

-- ============================================================
-- 3. THE VIEWS the board and Data Check read.
-- security_invoker: the reader's row level security applies, not the owner's.
-- ============================================================

create or replace function summit_name_key(t text) returns text
language sql immutable as $$ select nullif(lower(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g')), '') $$;

-- every live Aspire opportunity, with the Summit member it belongs to.
-- a name that matches nobody stays in, with member_id null and unassigned = true.
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
  case when a.status_name ~* '^\s*won\s*$'  then 'won'
       when a.status_name ~* '^\s*lost\s*$' then 'lost'
       else 'open' end as status,
  a.estimated_dollars,
  a.won_dollars,
  a.start_date,
  a.anticipated_close_date,
  a.won_date,
  a.lost_date,
  a.aspire_modified_at,
  a.synced_at
from aspire_opps a
left join lateral (
  select mm.id, mm.full_name, mm.role, mm.team, mm.active
    from members mm
   where mm.workspace_id = a.workspace_id
     and summit_name_key(a.sales_rep_name) in (summit_name_key(mm.full_name), summit_name_key(mm.crm_name))
   order by mm.active desc, (summit_name_key(mm.crm_name) = summit_name_key(a.sales_rep_name)) desc nulls last, mm.id
   limit 1
) m on true
where a.removed_at is null;

-- the Aspire names that match nobody on the roster, with what they carry
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

-- ============================================================
-- 4. WHAT THE SYNC CALLS. service role only.
-- ============================================================

create or replace function aspire_date(t text) returns date
language sql immutable as $$ select case when t ~ '^\d{4}-\d{2}-\d{2}' then left(t, 10)::date end $$;

create or replace function aspire_ts(t text) returns timestamp
language sql immutable as $$
  select case when t ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}' then replace(left(t, 19), 'T', ' ')::timestamp
              when t ~ '^\d{4}-\d{2}-\d{2}' then left(t, 10)::timestamp end $$;

create or replace function aspire_num(v jsonb) returns numeric
language sql immutable as $$
  select case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric
              when jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^\s*-?\d+(\.\d+)?\s*$' then btrim(v #>> '{}')::numeric end $$;

-- start a run. picks the workspace, full or incremental, and the ModifiedDate cutoff.
-- incremental starts one day before the newest ModifiedDate the last good run saw. the overlap
-- costs a few rows and covers any clock or time zone gap. rows are upserted, so repeats are harmless.
create or replace function aspire_sync_begin(p_slug text default null, p_trigger text default 'manual', p_full boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ws uuid; n int; wm timestamp; run_id bigint; m text;
begin
  if p_slug is not null then
    select id into ws from workspaces where slug = p_slug;
    if ws is null then return jsonb_build_object('error', format('no workspace %s', p_slug)); end if;
  else
    select count(*), min(id::text)::uuid into n, ws from workspaces where crm_source = 'aspire';
    if n = 0 then return jsonb_build_object('error', 'no workspace has crm_source = aspire'); end if;
    if n > 1 then return jsonb_build_object('error', 'more than one workspace has crm_source = aspire. pass {"workspace": "<slug>"}'); end if;
  end if;

  -- a run that never finished (the function was killed) is closed out, not left hanging
  update aspire_sync_runs set status = 'error', finished_at = now(),
         errors = errors || '["never finished. the function stopped before it could log the end"]'::jsonb
   where workspace_id = ws and status = 'running' and started_at < now() - interval '15 minutes';
  if exists (select 1 from aspire_sync_runs where workspace_id = ws and status = 'running') then
    return jsonb_build_object('error', 'a sync is already running for this workspace');
  end if;

  select max(max_modified) into wm from aspire_sync_runs where workspace_id = ws and status = 'ok';
  m := case when p_full or wm is null then 'full' else 'incremental' end;
  insert into aspire_sync_runs (workspace_id, trigger, mode, since)
  values (ws, coalesce(p_trigger, 'manual'), m, case when m = 'incremental' then wm - interval '1 day' end)
  returning id into run_id;
  return jsonb_build_object('run_id', run_id, 'workspace_id', ws, 'mode', m,
                            'since', case when m = 'incremental' then to_char(wm - interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS') end);
end $$;

-- one page of raw Aspire records in. a row is only rewritten when its record changed.
-- statement_timeout: the API role's default (8s on Supabase) is too short for a page of big
-- records. The function's own setting is applied by PostgREST for this call only, so a slow
-- page fails that page, not the run, and nothing else gets a longer timeout.
create or replace function aspire_sync_upsert(p_run bigint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public set statement_timeout = '60s' as $$
declare
  r aspire_sync_runs; n_src int; n_ins int; n_upd int; top_mod timestamp;
begin
  select * into r from aspire_sync_runs where id = p_run;
  if r.id is null or r.status <> 'running' then raise exception 'run % is not running', p_run; end if;

  create temp table if not exists _aspire_src (id bigint primary key, rec jsonb) on commit drop;
  truncate _aspire_src;
  insert into _aspire_src
  select distinct on ((e->>'OpportunityID')::bigint) (e->>'OpportunityID')::bigint, e
    from jsonb_array_elements(p_rows) e
   where e->>'OpportunityID' ~ '^\d+$';
  get diagnostics n_src = row_count;

  with up as (
    insert into aspire_opps as t (
      workspace_id, opportunity_id, opportunity_number, opportunity_name, property_name, sales_rep_name,
      branch_name, division_name, status_name, estimated_dollars, won_dollars, start_date,
      anticipated_close_date, won_date, lost_date, aspire_modified_at, raw, seen_run)
    select r.workspace_id, s.id, s.rec->>'OpportunityNumber', s.rec->>'OpportunityName', s.rec->>'PropertyName',
           s.rec->>'SalesRepContactName', s.rec->>'BranchName', s.rec->>'DivisionName', s.rec->>'OpportunityStatusName',
           aspire_num(s.rec->'EstimatedDollars'), aspire_num(s.rec->'WonDollars'), aspire_date(s.rec->>'StartDate'),
           aspire_date(s.rec->>'AnticipatedCloseDate'), aspire_date(s.rec->>'WonDate'), aspire_date(s.rec->>'LostDate'),
           aspire_ts(s.rec->>'ModifiedDate'), s.rec, p_run
      from _aspire_src s
    on conflict (workspace_id, opportunity_id) do update set
      opportunity_number = excluded.opportunity_number, opportunity_name = excluded.opportunity_name,
      property_name = excluded.property_name, sales_rep_name = excluded.sales_rep_name,
      branch_name = excluded.branch_name, division_name = excluded.division_name, status_name = excluded.status_name,
      estimated_dollars = excluded.estimated_dollars, won_dollars = excluded.won_dollars, start_date = excluded.start_date,
      anticipated_close_date = excluded.anticipated_close_date, won_date = excluded.won_date, lost_date = excluded.lost_date,
      aspire_modified_at = excluded.aspire_modified_at, raw = excluded.raw,
      synced_at = now(), seen_at = now(), seen_run = p_run, removed_at = null
    where t.raw is distinct from excluded.raw or t.removed_at is not null
    returning (xmax = 0) as ins
  )
  select count(*) filter (where ins), count(*) filter (where not ins) into n_ins, n_upd from up;

  -- unchanged rows: only note that this run saw them
  update aspire_opps t set seen_at = now(), seen_run = p_run
    from _aspire_src s
   where t.workspace_id = r.workspace_id and t.opportunity_id = s.id and t.seen_run is distinct from p_run;

  select max(aspire_ts(rec->>'ModifiedDate')) into top_mod from _aspire_src;
  update aspire_sync_runs set
    rows_pulled = rows_pulled + n_src, rows_inserted = rows_inserted + n_ins, rows_updated = rows_updated + n_upd,
    rows_unchanged = rows_unchanged + (n_src - n_ins - n_upd), pages = pages + 1,
    max_modified = greatest(max_modified, top_mod)
   where id = p_run;
  return jsonb_build_object('pulled', n_src, 'inserted', n_ins, 'updated', n_upd, 'unchanged', n_src - n_ins - n_upd);
end $$;

-- close the run: status, errors, the unmatched names as they stand now. after a complete full
-- pull, rows Aspire no longer returns are marked removed. they drop out of the view, not the table.
create or replace function aspire_sync_finish(p_run bigint, p_status text, p_calls int default 0,
  p_errors jsonb default '[]'::jsonb, p_notes jsonb default '[]'::jsonb, p_complete boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r aspire_sync_runs; n_rem int := 0; um jsonb;
begin
  select * into r from aspire_sync_runs where id = p_run;
  if r.id is null then raise exception 'no run %', p_run; end if;
  if r.mode = 'full' and p_status = 'ok' and p_complete then
    update aspire_opps set removed_at = now()
     where workspace_id = r.workspace_id and removed_at is null and seen_run is distinct from r.id;
    get diagnostics n_rem = row_count;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', sales_rep_name, 'deals', deals, 'open_deals', open_deals,
           'open_estimated', open_estimated, 'won_deals', won_deals) order by deals desc, sales_rep_name), '[]'::jsonb)
    into um from aspire_unmatched where workspace_id = r.workspace_id;
  update aspire_sync_runs set status = p_status, finished_at = now(), calls = coalesce(p_calls, 0),
         errors = coalesce(p_errors, '[]'::jsonb), notes = coalesce(p_notes, '[]'::jsonb),
         rows_removed = n_rem, unmatched = um
   where id = p_run
   returning * into r;
  return to_jsonb(r);
end $$;

revoke execute on function aspire_sync_begin(text, text, boolean) from public, anon, authenticated;
revoke execute on function aspire_sync_upsert(bigint, jsonb) from public, anon, authenticated;
revoke execute on function aspire_sync_finish(bigint, text, int, jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function aspire_sync_begin(text, text, boolean) to service_role;
grant execute on function aspire_sync_upsert(bigint, jsonb) to service_role;
grant execute on function aspire_sync_finish(bigint, text, int, jsonb, jsonb, boolean) to service_role;

-- ============================================================
-- 5. RUN IT. nightly, or by hand.
-- by hand, in the SQL editor:   select aspire_sync_now();        incremental
--                               select aspire_sync_now(true);    full re-pull
-- then read the log:            select * from aspire_sync_runs order by id desc limit 5;
-- ============================================================

create or replace function aspire_sync_now(p_full boolean default false, p_trigger text default 'manual')
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'aspire_sync_key';
  if k is null then
    raise exception 'no vault secret named aspire_sync_key. Run: select vault.create_secret(''<service role key>'', ''aspire_sync_key'');';
  end if;
  return net.http_post(
    url     := 'https://tyrtzxnhwjchtemytfxv.supabase.co/functions/v1/aspire-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k),
    body    := jsonb_build_object('full', p_full, 'trigger', p_trigger),
    timeout_milliseconds := 150000);
end $$;
revoke execute on function aspire_sync_now(boolean, text) from public, anon, authenticated;

-- nightly at 07:17 UTC: 3:17am Eastern in summer, 2:17am in winter. pg_cron runs in UTC.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'aspire-sync-nightly') then
    perform cron.unschedule('aspire-sync-nightly');
  end if;
  perform cron.schedule('aspire-sync-nightly', '17 7 * * *', $job$select aspire_sync_now(false, 'cron')$job$);
end $$;

-- show the result
select jobname, schedule, command from cron.job where jobname = 'aspire-sync-nightly';
select slug, crm_source from workspaces where crm_source is not null;
