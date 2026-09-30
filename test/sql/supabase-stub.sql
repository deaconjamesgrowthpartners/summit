-- Just enough of Supabase and Summit's 001 schema to run a migration against plain Postgres.
-- Test use only. Never run this in the real project.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; create role authenticated; create role service_role; end if;
end $$;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table workspaces (id uuid primary key default gen_random_uuid(), slug text unique, name text, active boolean default true, tabs jsonb default '[]');
create table members (id uuid primary key default gen_random_uuid(), workspace_id uuid references workspaces(id), full_name text,
  email text, role text, team text, branch text, active boolean default true, user_id uuid);
create table app_admins (user_id uuid, email text);
create table opps (id uuid primary key default gen_random_uuid(), workspace_id uuid, account text);
create table commits (id uuid primary key default gen_random_uuid(), workspace_id uuid, member_id uuid, note text);
-- pg_cron, pg_net and vault stand-ins
create schema cron;
create table cron.job (jobid serial, jobname text unique, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
create schema net;
create table net.calls (id bigserial, url text, headers jsonb, body jsonb, timeout int);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
  returns bigint language sql as $$ insert into net.calls (url, headers, body, timeout) values (url, headers, body, timeout_milliseconds) returning id $$;
create schema vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);
create schema extensions;
grant usage on schema public, auth to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated;
-- what Supabase does for every new table and function, so the migration has to take it back
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
