-- Summit  migration 013  CSV upload: a leader uploads a file, sees what would change, then writes it
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 012.
-- Safe to run more than once. Changes no deal. Only adds functions.
--
-- A csv workspace's deals change only when a leader uploads a file:
--   1. the browser reads the file and sends its rows with the column mapping
--   2. csv_import_preview says what would be added, what would change field by field, and which live deals
--      the file no longer has. It writes nothing.
--   3. csv_import_apply writes it as one sync run (trigger 'upload'), remembers the mapping on the source so the
--      next upload is one click, and marks removed only the deals the leader ticked. Removed is kept, never deleted.
-- The mapping is the same shape as a connector's: canonical field -> the file's column name.

begin;

-- Never redefine a function this migration did not make. Production has functions from before this repo
-- (summit_member_id is one), and create or replace would quietly change what their policies do.
-- A name taken by anything not tagged 'summit 013' stops the run here, before anything changes.
do $$
declare clash text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into clash
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = any (array['deal_ws_role', 'deal_ws_member', 'deal_ws_can_lead', 'source_mapped_fields', 'csv_source_for', 'csv_import_preview', 'csv_import_apply'])
     and coalesce(obj_description(p.oid, 'pg_proc'), '') not like 'summit 013%';
  if clash is not null then raise exception 'these functions already exist and are not from 013: %. Nothing changed. Send this to Claude.', clash; end if;
end $$;

-- ============================================================
-- 1. WHO YOU ARE IN A WORKSPACE
-- ============================================================

-- admin, leader, rep, viewer, or null. An admin is anyone on app_admins.
create or replace function deal_ws_role(p_ws uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from app_admins a where a.user_id = auth.uid()) then 'admin'
    else (select m.role from members m
           where m.workspace_id = p_ws and m.user_id = auth.uid() and m.active
           order by case m.role when 'leader' then 0 when 'rep' then 1 else 2 end
           limit 1) end $$;

-- my roster row in a workspace
create or replace function deal_ws_member(p_ws uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select m.id from members m
   where m.workspace_id = p_ws and m.user_id = auth.uid() and m.active
   order by case m.role when 'leader' then 0 when 'rep' then 1 else 2 end, m.id
   limit 1 $$;

create or replace function deal_ws_can_lead(p_ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(deal_ws_role(p_ws) in ('admin', 'leader'), false) $$;

revoke execute on function deal_ws_role(uuid), deal_ws_member(uuid), deal_ws_can_lead(uuid) from public, anon;
grant execute on function deal_ws_role(uuid), deal_ws_member(uuid), deal_ws_can_lead(uuid) to authenticated, service_role;

-- ============================================================
-- 2. PREVIEW. Writes nothing.
-- ============================================================

-- the fields a mapping fills, external_id aside: what a change is measured on
create or replace function source_mapped_fields(p_mapping jsonb) returns text[]
language sql immutable as $$
  select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(coalesce(p_mapping, '{}'::jsonb)) k
   where k <> 'external_id' and jsonb_typeof(p_mapping -> k) in ('string', 'array') $$;

-- the csv source of a workspace, for a leader. Raises with a plain reason otherwise.
create or replace function csv_source_for(p_ws uuid) returns deal_sources
language plpgsql stable security definer set search_path = public as $$
declare s deal_sources;
begin
  if not deal_ws_can_lead(p_ws) then raise exception 'Only a leader can upload deals' using errcode = '42501'; end if;
  select * into s from deal_sources where workspace_id = p_ws;
  if s.id is null then raise exception 'This workspace has no deal source yet'; end if;
  if s.mode <> 'csv' then raise exception 'This workspace gets its deals from %, not a file upload', s.label; end if;
  if not s.enabled then raise exception 'Uploads are turned off for this workspace'; end if;
  return s;
end $$;

create or replace function csv_import_preview(p_workspace uuid, p_rows jsonb, p_mapping jsonb default null)
returns jsonb language plpgsql security definer set search_path = public set statement_timeout = '60s' as $$
declare s deal_sources; m jsonb; f text[]; n_rows int; n_noid int; dup jsonb; added jsonb; n_added int;
        changed jsonb; n_changed int; n_same int; n_back int; missing jsonb; n_missing int;
begin
  s := csv_source_for(p_workspace);
  m := coalesce(p_mapping, s.mapping);
  if jsonb_typeof(m -> 'external_id') is null then raise exception 'Pick the column that holds each deal''s id'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be a list'; end if;
  n_rows := jsonb_array_length(p_rows);
  if n_rows > 20000 then raise exception 'That file has % rows. The limit is 20,000', n_rows; end if;
  f := source_mapped_fields(m);

  create temp table if not exists _imp (n int, ext text, d jsonb) on commit drop;
  truncate _imp;
  insert into _imp select x.n, source_map(m, x.e) ->> 'external_id', source_map(m, x.e)
    from jsonb_array_elements(p_rows) with ordinality x(e, n);
  select count(*) into n_noid from _imp where ext is null;
  select coalesce(jsonb_agg(jsonb_build_object('external_id', ext, 'rows', c) order by ext), '[]'::jsonb) into dup
    from (select ext, count(*) c from _imp where ext is not null group by ext having count(*) > 1) z;
  -- a repeated id: the last row in the file wins, the same as apply
  delete from _imp a using _imp b where a.ext = b.ext and a.n < b.n;

  -- added: not in Summit yet
  select count(*), coalesce(jsonb_agg(jsonb_build_object('external_id', i.ext, 'account', i.d->>'account', 'job', i.d->>'job',
           'stage', i.d->>'stage', 'value', i.d->'value_estimated') order by i.n) filter (where i.rn <= 50), '[]'::jsonb)
    into n_added, added
    from (select *, row_number() over (order by n) rn from _imp x
           where x.ext is not null and not exists (select 1 from deals d where d.source_id = s.id and d.external_id = x.ext)) i;

  -- changed: field by field, on the fields the mapping fills. A blank cell clears a field.
  with cmp as (
    select i.n, i.ext, x.removed_at is not null as back, x.account, to_jsonb(x) dj, i.d
      from _imp i join deals x on x.source_id = s.id and x.external_id = i.ext
  ), diff as (
    select c.n, c.ext, c.back, c.account,
           coalesce(jsonb_agg(jsonb_build_object('field', k, 'from', c.dj -> k, 'to', c.d -> k) order by k)
             filter (where (c.dj -> k) is distinct from (c.d -> k)), '[]'::jsonb) as fields
      from cmp c cross join unnest(f) k
     group by c.n, c.ext, c.back, c.account
  ), z as (select *, row_number() over (order by n) rn from diff where back or jsonb_array_length(fields) > 0)
  select (select count(*) from z), (select count(*) from z where back),
         (select count(*) from cmp) - (select count(*) from z),
         coalesce((select jsonb_agg(jsonb_build_object('external_id', ext, 'account', coalesce(account, ''), 'back', back, 'fields', fields) order by n)
                     from z where rn <= 200), '[]'::jsonb)
    into n_changed, n_back, n_same, changed;

  -- missing: live deals the file does not have. Listed for a leader to tick. Never removed here.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('external_id', d.external_id, 'account', d.account, 'job', d.job,
           'stage', d.stage, 'value', d.value_estimated, 'rep', d.rep_name) order by d.account, d.external_id) filter (where d.rn <= 2000), '[]'::jsonb)
    into n_missing, missing
    from (select x.*, row_number() over (order by x.account, x.external_id) rn from deals x
           where x.source_id = s.id and x.removed_at is null
             and not exists (select 1 from _imp i where i.ext = x.external_id)) d;

  return jsonb_build_object('rows', n_rows, 'skipped_no_id', n_noid, 'duplicates', dup,
    'added', n_added, 'added_sample', added, 'changed', n_changed, 'restored', n_back, 'changes', changed,
    'unchanged', n_same, 'missing', n_missing, 'missing_rows', missing, 'fields', to_jsonb(f), 'mapping', m);
end $$;

-- ============================================================
-- 3. APPLY. One run, logged with the file name and who uploaded it.
-- ============================================================

create or replace function csv_import_apply(p_workspace uuid, p_rows jsonb, p_remove text[] default '{}',
  p_file_name text default null, p_mapping jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s deal_sources; b jsonb; run bigint; up jsonb; n_ask int;
begin
  s := csv_source_for(p_workspace);
  if p_mapping is not null then
    if jsonb_typeof(p_mapping -> 'external_id') is null then raise exception 'Pick the column that holds each deal''s id'; end if;
    update deal_sources set mapping = p_mapping, updated_at = now() where id = s.id;
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 20000 then raise exception 'rows must be a list of at most 20,000'; end if;
  b := source_sync_begin(s.id, 'upload', true);
  if b ? 'error' then raise exception '%', b->>'error'; end if;
  run := (b->>'run_id')::bigint;
  update source_runs set file_name = left(p_file_name, 200), run_by = auth.uid() where id = run;
  up := source_sync_upsert(run, p_rows);
  n_ask := coalesce(cardinality(p_remove), 0);
  return source_sync_finish(run, 'ok', 0, '[]'::jsonb,
    jsonb_build_array(format('upload: %s rows, %s added, %s changed', up->>'pulled', up->>'inserted', up->>'updated'))
      || case when n_ask > 0 then jsonb_build_array(format('%s removal(s) confirmed by a leader', n_ask)) else '[]'::jsonb end,
    true, coalesce(p_remove, '{}'));
end $$;

revoke execute on function source_mapped_fields(jsonb), csv_source_for(uuid) from public, anon, authenticated;
revoke execute on function csv_import_preview(uuid, jsonb, jsonb), csv_import_apply(uuid, jsonb, text[], text, jsonb) from public, anon;
grant execute on function csv_import_preview(uuid, jsonb, jsonb), csv_import_apply(uuid, jsonb, text[], text, jsonb) to authenticated;


-- tag what this migration owns, so a re-run knows them and the guard above knows what is not
comment on function deal_ws_role(uuid) is 'summit 013';
comment on function deal_ws_member(uuid) is 'summit 013';
comment on function deal_ws_can_lead(uuid) is 'summit 013';
comment on function source_mapped_fields(jsonb) is 'summit 013';
comment on function csv_source_for(uuid) is 'summit 013';
comment on function csv_import_preview(uuid, jsonb, jsonb) is 'summit 013';
comment on function csv_import_apply(uuid, jsonb, text[], text, jsonb) is 'summit 013';

commit;
