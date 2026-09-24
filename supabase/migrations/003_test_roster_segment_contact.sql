-- Summit  migration 003  segment, contact, test roster
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 002.
-- Safe to run more than once.

-- ============================================================
-- 1. TRACKER COLUMNS
-- ============================================================

alter table opps add column if not exists segment text;
alter table opps add column if not exists contact text;

-- ============================================================
-- 2. TEST ROSTER
-- The 5 test rows get plus addresses, so every login code lands in
-- joe@deaconjames.com. Row ids stay the same, so when the real roster
-- goes on these same rows, no deal loses its owner.
-- Stops without changing anything unless Elevation has exactly
-- 1 leader and 4 reps.
-- ============================================================

do $$
declare
  ws uuid;
  n_lead int;
  n_rep int;
begin
  select id into ws from workspaces where slug = 'elevation-outdoors';
  if ws is null then raise exception 'elevation-outdoors workspace not found'; end if;

  select count(*) filter (where role = 'leader'), count(*) filter (where role = 'rep')
    into n_lead, n_rep
    from members where workspace_id = ws;
  if n_lead <> 1 or n_rep <> 4 then
    raise exception 'Expected 1 leader and 4 reps in elevation-outdoors, found % and %. Nothing changed.', n_lead, n_rep;
  end if;

  -- park emails first so the unique (workspace_id, email) never collides mid-swap
  update members set email = 'swap-' || id || '@invalid'
   where workspace_id = ws
     and email not in ('joe+leader@deaconjames.com','joe+grow1@deaconjames.com','joe+grow2@deaconjames.com',
                       'joe+bdm1@deaconjames.com','joe+bdm2@deaconjames.com');

  update members set email = 'joe+leader@deaconjames.com', team = null
   where workspace_id = ws and role = 'leader';

  with reps as (
    select id, row_number() over (order by created_at, id) as rn
      from members where workspace_id = ws and role = 'rep'
  )
  update members m set
    email = (array['joe+grow1@deaconjames.com','joe+grow2@deaconjames.com',
                   'joe+bdm1@deaconjames.com','joe+bdm2@deaconjames.com'])[r.rn],
    team  = (array['grow','grow','netnew','netnew'])[r.rn]
    from reps r
   where m.id = r.id
     and m.email like 'swap-%@invalid';

  -- tie each row to the login for its new address. unlink anything stale,
  -- then link any account that already exists. new ones link on first login.
  update members m set user_id = u.id
    from auth.users u
   where m.workspace_id = ws and lower(u.email) = lower(m.email);
  update members m set user_id = null
   where m.workspace_id = ws
     and m.user_id is not null
     and not exists (select 1 from auth.users u where u.id = m.user_id and lower(u.email) = lower(m.email));
end $$;

-- show the result
select full_name, role, team, branch, email, user_id is not null as linked
  from members
 where workspace_id = (select id from workspaces where slug = 'elevation-outdoors')
 order by role, team nulls first, email;
