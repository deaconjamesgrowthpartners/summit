-- Summit  migration 014  native deals: no CRM, Summit is the system of record
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 013.
-- Safe to run more than once. One transaction.
--
-- In a native workspace people type their deals:
--   a rep creates and edits deals they own. A leader or admin edits anything in the workspace. A viewer reads.
--   every change is logged in deal_changes, one row per field, with who and when.
--   every stage change writes the day's row in deal_snapshots, so "pipeline advanced" works from day one.
--   deal_accounts is the workspace's account list. A deal can point at one.
-- In a connected or csv workspace nothing changes: deals stay read only to everyone but the sync.
--
-- Also here: members.role takes 'viewer' (reads everything, writes nothing), and members.team is free text,
-- so a workspace can name its own groups. Typed opps in native workspaces are copied into deals, same ids.
-- opps itself is left alone.

begin;

-- Never redefine a function this migration did not make. Production has functions from before this repo
-- (summit_member_id is one), and create or replace would quietly change what their policies do.
-- A name taken by anything not tagged 'summit 014' stops the run here, before anything changes.
do $$
declare clash text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into clash
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = any (array['deal_writable', 'deal_ws_today', 'deal_guard', 'deal_log', 'deal_stage_snapshot', 'workspace_default_source'])
     and coalesce(obj_description(p.oid, 'pg_proc'), '') not like 'summit 014%';
  if clash is not null then raise exception 'these functions already exist and are not from 014: %. Nothing changed. Send this to Claude.', clash; end if;
end $$;

-- ============================================================
-- 1. ROLES AND TEAMS
-- ============================================================

do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.members'::regclass and contype = 'c'
              and (pg_get_constraintdef(oid) ~* '\mrole\M' or pg_get_constraintdef(oid) ~* '\mteam\M') loop
    execute format('alter table members drop constraint %I', c.conname);
  end loop;
end $$;
-- not valid: new and changed rows are checked, rows already there are left alone
alter table members add constraint members_role_check check (role in ('leader', 'rep', 'viewer')) not valid;

-- ============================================================
-- 2. THE ACCOUNT LIST
-- ============================================================

create table if not exists deal_accounts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name         text not null check (btrim(name) <> ''),
  notes        text,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);
create unique index if not exists deal_accounts_name on deal_accounts (workspace_id, lower(btrim(name)));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deals_account_id_fkey') then
    alter table deals add constraint deals_account_id_fkey foreign key (account_id) references deal_accounts(id) on delete set null;
  end if;
end $$;

-- can I write deals in this workspace, for this owner? Native only. Leaders and admins: anything. Reps: their own.
create or replace function deal_writable(p_ws uuid, p_owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from deal_sources s where s.workspace_id = p_ws and s.mode = 'native' and s.enabled)
     and (deal_ws_can_lead(p_ws) or (deal_ws_role(p_ws) = 'rep' and p_owner is not null and p_owner = deal_ws_member(p_ws))) $$;
revoke execute on function deal_writable(uuid, uuid) from public, anon;
grant execute on function deal_writable(uuid, uuid) to authenticated, service_role;

alter table deal_accounts enable row level security;
revoke all on deal_accounts from anon, authenticated;
grant select, insert, update, delete on deal_accounts to authenticated;
grant all on deal_accounts to service_role;
drop policy if exists deal_accounts_read on deal_accounts;
create policy deal_accounts_read on deal_accounts for select to authenticated using (
  exists (select 1 from members m where m.workspace_id = deal_accounts.workspace_id and m.user_id = auth.uid() and m.active)
  or exists (select 1 from app_admins a where a.user_id = auth.uid()));
-- reps add accounts as they add deals. Leaders rename and remove.
drop policy if exists deal_accounts_add on deal_accounts;
create policy deal_accounts_add on deal_accounts for insert to authenticated with check (
  exists (select 1 from deal_sources s where s.workspace_id = deal_accounts.workspace_id and s.mode = 'native')
  and deal_ws_role(workspace_id) in ('admin', 'leader', 'rep'));
drop policy if exists deal_accounts_edit on deal_accounts;
create policy deal_accounts_edit on deal_accounts for update to authenticated using (deal_ws_can_lead(workspace_id)) with check (deal_ws_can_lead(workspace_id));
drop policy if exists deal_accounts_drop on deal_accounts;
create policy deal_accounts_drop on deal_accounts for delete to authenticated using (deal_ws_can_lead(workspace_id));

-- ============================================================
-- 3. WRITING DEALS
-- ============================================================

grant insert, update, delete on deals to authenticated;
drop policy if exists deals_add on deals;
create policy deals_add on deals for insert to authenticated with check (deal_writable(workspace_id, owner_member_id));
drop policy if exists deals_edit on deals;
create policy deals_edit on deals for update to authenticated
  using (deal_writable(workspace_id, owner_member_id)) with check (deal_writable(workspace_id, owner_member_id));
drop policy if exists deals_drop on deals;
create policy deals_drop on deals for delete to authenticated using (
  deal_ws_can_lead(workspace_id) and exists (select 1 from deal_sources s where s.workspace_id = deals.workspace_id and s.mode = 'native'));

-- today in the workspace's clock
create or replace function deal_ws_today(p_ws uuid) returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce((select nullif(to_jsonb(w) ->> 'lock_tz', '') from workspaces w where w.id = p_ws), 'America/New_York'))::date $$;

-- what a person may not set. Runs as the caller, so a signed-in person reads as 'authenticated'.
-- The sync runs as the owner inside its own functions and is not touched by this.
create or replace function deal_guard() returns trigger
language plpgsql set search_path = public as $$
declare sid bigint; lbl text; d date;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  select s.id into sid from deal_sources s where s.workspace_id = new.workspace_id and s.mode = 'native';
  if sid is null then
    select s.label into lbl from deal_sources s where s.workspace_id = new.workspace_id;
    raise exception 'Deals here come from %. Change them there.', coalesce(lbl, 'another system') using errcode = '42501';
  end if;
  d := deal_ws_today(new.workspace_id);
  if tg_op = 'INSERT' then
    new.source_id := sid; new.external_id := null; new.raw := null; new.removed_at := null;
    new.seen_run := null; new.seen_at := null; new.rep_name := null;
    new.created_at := now(); new.created_date := coalesce(new.created_date, d);
    if new.stage is not null then new.stage_date := coalesce(new.stage_date, d); end if;
  else
    if new.workspace_id <> old.workspace_id then raise exception 'A deal cannot move to another workspace'; end if;
    new.source_id := old.source_id; new.external_id := old.external_id; new.raw := old.raw; new.removed_at := old.removed_at;
    new.seen_run := old.seen_run; new.seen_at := old.seen_at; new.created_at := old.created_at; new.rep_name := old.rep_name;
    if new.stage is distinct from old.stage and new.stage_date is not distinct from old.stage_date then new.stage_date := d; end if;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists deal_guard on deals;
create trigger deal_guard before insert or update on deals for each row execute function deal_guard();

-- ============================================================
-- 4. THE CHANGE LOG
-- ============================================================

create table if not exists deal_changes (
  id           bigint generated always as identity primary key,
  deal_id      uuid not null,               -- no foreign key: the log outlives a deleted deal
  workspace_id uuid not null references workspaces(id) on delete cascade,
  changed_at   timestamptz not null default now(),
  changed_on   date not null,               -- the day, in the workspace's clock
  changed_by   uuid,                        -- the login
  member_id    uuid,                        -- their roster row, when they have one
  action       text not null check (action in ('created', 'updated', 'deleted')),
  field        text,
  old_value    text,
  new_value    text
);
create index if not exists deal_changes_deal on deal_changes (deal_id, changed_at);
create index if not exists deal_changes_stage on deal_changes (workspace_id, changed_on) where field = 'stage';

alter table deal_changes enable row level security;
revoke all on deal_changes from anon, authenticated;
grant select on deal_changes to authenticated;
grant all on deal_changes to service_role;
drop policy if exists deal_changes_read on deal_changes;
create policy deal_changes_read on deal_changes for select to authenticated using (
  exists (select 1 from members m where m.workspace_id = deal_changes.workspace_id and m.user_id = auth.uid() and m.active)
  or exists (select 1 from app_admins a where a.user_id = auth.uid()));

-- the fields a person edits. Logged one row each. A created deal logs every field it was created with.
create or replace function deal_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare r deals; o jsonb; n jsonb; k text; d date; who uuid := auth.uid(); mid uuid; act text;
  fields text[] := array['account', 'account_id', 'job', 'owner_member_id', 'stage', 'value_estimated', 'value_won', 'category',
    'branch', 'close_date', 'start_date', 'won_date', 'lost_date', 'bid_date', 'created_date', 'end_date', 'renewal_date',
    'next_step', 'next_step_date', 'last_activity', 'notes', 'contact', 'segment', 'priority', 'installed', 'external_number'];
begin
  if current_setting('summit.no_log', true) = 'on' then return null; end if;
  r := case when tg_op = 'DELETE' then old else new end;
  if not exists (select 1 from deal_sources s where s.id = r.source_id and s.mode = 'native') then return null; end if;
  d := deal_ws_today(r.workspace_id);
  mid := case when who is not null then deal_ws_member(r.workspace_id) end;
  act := case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
  o := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  n := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  if tg_op = 'DELETE' then
    insert into deal_changes (deal_id, workspace_id, changed_on, changed_by, member_id, action, field, old_value)
    values (r.id, r.workspace_id, d, who, mid, act, 'account', o ->> 'account');
    return null;
  end if;
  foreach k in array fields loop
    if (o -> k) is distinct from (n -> k) and not (tg_op = 'INSERT' and jsonb_typeof(n -> k) = 'null') then
      insert into deal_changes (deal_id, workspace_id, changed_on, changed_by, member_id, action, field, old_value, new_value)
      values (r.id, r.workspace_id, d, who, mid, act, k, o ->> k, n ->> k);
    end if;
  end loop;
  return null;
end $$;
drop trigger if exists deal_log on deals;
create trigger deal_log after insert or update or delete on deals for each row execute function deal_log();

-- a stage or value change writes today's snapshot row. Native only: the sync snapshots connected and csv deals.
create or replace function deal_stage_snapshot() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('summit.no_log', true) = 'on' then return null; end if;
  if new.removed_at is not null then return null; end if;
  if not exists (select 1 from deal_sources s where s.id = new.source_id and s.mode = 'native') then return null; end if;
  if tg_op = 'UPDATE' and new.stage is not distinct from old.stage and new.value_estimated is not distinct from old.value_estimated
     and new.value_won is not distinct from old.value_won then return null; end if;
  insert into deal_snapshots as t (deal_id, workspace_id, snap_date, stage, value_estimated, value_won)
  values (new.id, new.workspace_id, deal_ws_today(new.workspace_id), new.stage, new.value_estimated, new.value_won)
  on conflict (deal_id, snap_date) do update set stage = excluded.stage, value_estimated = excluded.value_estimated,
    value_won = excluded.value_won, recorded_at = now();
  return null;
end $$;
drop trigger if exists deal_stage_snapshot on deals;
create trigger deal_stage_snapshot after insert or update on deals for each row execute function deal_stage_snapshot();

revoke execute on function deal_guard(), deal_log(), deal_stage_snapshot(), deal_ws_today(uuid) from public, anon;
grant execute on function deal_guard(), deal_ws_today(uuid) to authenticated;
revoke execute on function deal_log(), deal_stage_snapshot() from authenticated;

-- a workspace made after 012 starts native. Make it connected or csv by updating its source.
create or replace function workspace_default_source() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into deal_sources (workspace_id, mode, label) values (new.id, 'native', 'Summit') on conflict (workspace_id) do nothing;
  return null;
end $$;
revoke execute on function workspace_default_source() from public, anon, authenticated;
drop trigger if exists workspace_default_source on workspaces;
create trigger workspace_default_source after insert on workspaces for each row execute function workspace_default_source();
insert into deal_sources (workspace_id, mode, label)
select w.id, 'native', 'Summit' from workspaces w where not exists (select 1 from deal_sources s where s.workspace_id = w.id)
on conflict (workspace_id) do nothing;

-- ============================================================
-- 5. TYPED OPPS INTO DEALS, native workspaces only. Same ids. opps is left alone.
-- ============================================================

set local summit.no_log = 'on';
do $$
begin
  if to_regclass('public.opps') is not null then
    insert into deals (id, workspace_id, source_id, account, owner_member_id, branch, category, stage, value_estimated,
      close_date, start_date, won_date, lost_date, bid_date, stage_date, next_step, next_step_date, last_activity, notes,
      contact, segment, priority, installed, external_number, created_date, created_at, updated_at)
    select (j->>'id')::uuid, s.workspace_id, s.id, j->>'account',
           (select m.id from members m where m.id::text = j->>'owner_member_id' and m.workspace_id = s.workspace_id), j->>'branch', j->>'category', j->>'stage',
           source_num(j->>'value'), source_date(j->>'close_date'), source_date(j->>'start_date'), source_date(j->>'actual_close'),
           source_date(j->>'lost_date'), source_date(j->>'bid_date'), source_date(j->>'stage_date'), j->>'next_step',
           source_date(j->>'next_step_date'), source_date(j->>'last_activity'), j->>'notes', j->>'contact', j->>'segment',
           coalesce((j->>'priority')::boolean, false), coalesce((j->>'installed')::boolean, false), j->>'crm_ref',
           source_date(j->>'created_at'), coalesce((j->>'created_at')::timestamptz, now()), coalesce((j->>'updated_at')::timestamptz, now())
      from opps o
      cross join lateral (select to_jsonb(o) j) x
      join deal_sources s on s.workspace_id = o.workspace_id and s.mode = 'native'
    on conflict (id) do nothing;
  end if;
end $$;
-- the first snapshot for what was copied, so their stages count from today
insert into deal_snapshots (deal_id, workspace_id, snap_date, stage, value_estimated, value_won)
select d.id, d.workspace_id, deal_ws_today(d.workspace_id), d.stage, d.value_estimated, d.value_won
  from deals d join deal_sources s on s.id = d.source_id and s.mode = 'native'
 where d.removed_at is null
on conflict (deal_id, snap_date) do nothing;
set local summit.no_log = 'off';

-- ============================================================
-- 6. LIVE: deals and the account list on the realtime channel. Row level security still applies.
-- ============================================================

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['deals', 'deal_accounts'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;


-- tag what this migration owns, so a re-run knows them and the guard above knows what is not
comment on function deal_writable(uuid, uuid) is 'summit 014';
comment on function deal_ws_today(uuid) is 'summit 014';
comment on function deal_guard() is 'summit 014';
comment on function deal_log() is 'summit 014';
comment on function deal_stage_snapshot() is 'summit 014';
comment on function workspace_default_source() is 'summit 014';

commit;

-- what is native now, and how many deals each holds
select w.slug, s.mode, s.label, count(d.id) filter (where d.removed_at is null) as deals
  from deal_sources s join workspaces w on w.id = s.workspace_id
  left join deals d on d.source_id = s.id
 group by 1, 2, 3 order by 1;
