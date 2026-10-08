-- Summit  migration 015  two workspaces with no CRM: EXPOSURE by 29029, and Deacon James
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 014.
-- Safe to run more than once: it creates each workspace once, then sets its config every run.
-- Config only. No code knows these workspaces exist.
--
-- 29029        native. One seller, Joe. Lisa Barnes and Benjamin Sutton read everything, write nothing.
--              Measures are outreach, not landscaping: conversations, meetings booked, meetings sat,
--              proposals out, signed. No branches. MEASURE NAMES: confirm with Joe.
-- deacon-james native. Two groups on different measures: Joe's own pipeline (from his deals), and the
--              sourcing team's numbers (typed). No branches.
--
-- Meetings booked, sat, proposals and signed fill in from the deals: a deal counts the week it first
-- reaches that stage or past it (migration 014 logs every stage change). Conversations and the sourcing
-- team's numbers are typed at the weekly commit.
--
-- New workspaces copy Elevation's row for every column this file does not set (lock day and time,
-- late policy...), then overwrite the config. Elevation itself is not touched.

begin;

do $$
declare src jsonb;
begin
  select to_jsonb(w) into src from workspaces w where w.slug = 'elevation-outdoors';
  if src is null then raise exception 'Elevation''s workspace is not here to copy the settings from'; end if;
  insert into workspaces select (jsonb_populate_record(null::workspaces, src || jsonb_build_object(
    'id', gen_random_uuid(), 'slug', '29029', 'name', 'EXPOSURE by 29029', 'active', true))).*
  on conflict (slug) do nothing;
  insert into workspaces select (jsonb_populate_record(null::workspaces, src || jsonb_build_object(
    'id', gen_random_uuid(), 'slug', 'deacon-james', 'name', 'Deacon James', 'active', true))).*
  on conflict (slug) do nothing;
end $$;

-- ============================================================
-- EXPOSURE by 29029
-- ============================================================

update workspaces set
  crm_source = null,
  pipeline   = '{}'::jsonb,
  branches   = '{}',
  brand      = '{"head":"#111111","accent":"#B4532A","bg":"#F6F5F2","panel":"#ECEAE5","muted":"#8A8580","font":"Instrument Sans","logo":null}'::jsonb,
  stages     = '[
    {"name":"Conversation",   "prob":0.05, "status":"open"},
    {"name":"Meeting booked", "prob":0.15, "status":"open"},
    {"name":"Meeting sat",    "prob":0.30, "status":"open", "needs_close":true},
    {"name":"Proposal out",   "prob":0.60, "status":"open", "needs_close":true, "bid":true},
    {"name":"Signed",         "prob":1.00, "status":"won"},
    {"name":"Lost",           "prob":0.00, "status":"lost"}
  ]'::jsonb,
  categories = '[]'::jsonb,
  measures   = '[
    {"key":"conversations", "type":"count", "label":"Conversations"},
    {"key":"booked",        "type":"count", "label":"Meetings booked", "auto":{"stage_entered":"Meeting booked"}},
    {"key":"sat",           "type":"count", "label":"Meetings sat",    "auto":{"stage_entered":"Meeting sat"}},
    {"key":"proposals",     "type":"count", "label":"Proposals out",   "auto":{"stage_entered":"Proposal out"}},
    {"key":"signed",        "type":"count", "label":"Signed",          "auto":{"stage_entered":"Signed"}}
  ]'::jsonb,
  tabs       = '[
    {"key":"summit", "label":"Summit", "filters":[], "deal_word":"deal"},
    {"key":"climb", "label":"The Climb"},
    {"key":"outreach", "label":"Outreach", "team":"outreach", "title":"Outreach", "sub":"EXPOSURE by 29029", "team_label":"Seller",
     "note_prompt":"What do you need this week?"},
    {"key":"accounts", "label":"All Deals"},
    {"key":"datacheck", "label":"Data Check"}
  ]'::jsonb,
  goal_tiles = '[]'::jsonb
where slug = '29029';

-- ============================================================
-- Deacon James
-- ============================================================

update workspaces set
  crm_source = null,
  pipeline   = '{}'::jsonb,
  branches   = '{}',
  brand      = '{"head":"#0A132B","accent":"#C1440E","bg":"#F5F3EE","panel":"#ECE8E1","muted":"#8C8682","font":"Archivo","logo":null}'::jsonb,
  stages     = '[
    {"name":"Lead",           "prob":0.05, "status":"open"},
    {"name":"Meeting booked", "prob":0.15, "status":"open"},
    {"name":"Meeting sat",    "prob":0.30, "status":"open", "needs_close":true},
    {"name":"Proposal",       "prob":0.60, "status":"open", "needs_close":true, "bid":true},
    {"name":"Signed",         "prob":1.00, "status":"won"},
    {"name":"Lost",           "prob":0.00, "status":"lost"}
  ]'::jsonb,
  categories = '[]'::jsonb,
  -- two kinds of member, two sets of measures. Joe's come from his deals. The sourcing team types theirs.
  -- Different keys, so The Climb never adds a sourced meeting to the meeting it became.
  measures   = '[
    {"key":"booked",     "type":"count", "label":"Meetings booked", "auto":{"stage_entered":"Meeting booked"}},
    {"key":"sat",        "type":"count", "label":"Meetings sat",    "auto":{"stage_entered":"Meeting sat"}},
    {"key":"proposals",  "type":"count", "label":"Proposals",       "auto":{"stage_entered":"Proposal"}},
    {"key":"signed",     "type":"count", "label":"Signed",          "auto":{"stage_entered":"Signed"}},
    {"key":"src_booked", "type":"count", "label":"Sourced meetings booked"},
    {"key":"src_sat",    "type":"count", "label":"Sourced meetings sat"}
  ]'::jsonb,
  tabs       = '[
    {"key":"summit", "label":"Summit", "filters":[], "deal_word":"deal"},
    {"key":"climb", "label":"The Climb"},
    {"key":"pipeline", "label":"Pipeline", "team":"pipeline", "title":"Joe''s pipeline", "team_label":"Seller",
     "measures":["booked","sat","proposals","signed"]},
    {"key":"sourcing", "label":"Sourcing", "team":"sourcing", "title":"Sourcing", "team_label":"Sourcing team",
     "measures":["src_booked","src_sat"], "labels":{"src_booked":"Meetings booked","src_sat":"Meetings sat"},
     "note_prompt":"Who do you need an intro to this week?"},
    {"key":"accounts", "label":"All Deals"},
    {"key":"datacheck", "label":"Data Check"}
  ]'::jsonb,
  goal_tiles = '[]'::jsonb
where slug = 'deacon-james';

-- one source each: typed in Summit
insert into deal_sources (workspace_id, mode, label)
select id, 'native', 'Summit' from workspaces where slug in ('29029', 'deacon-james')
on conflict (workspace_id) do nothing;

-- ============================================================
-- The rosters. Joe's login is tied by email when he signs in (summit_link_member).
-- Lisa and Benjamin: placeholders until their emails are in. .invalid never delivers, and an inactive row
-- never gets a login. Put the real email in and set active = true to let them in.
-- ============================================================

insert into members (workspace_id, full_name, email, role, team, active)
select w.id, x.full_name, x.email, x.role, x.team, x.active
  from workspaces w
  cross join (values
    ('Joe Foor',         'joe@deaconjames.com',            'rep',    'outreach', true),
    ('Lisa Barnes',      'lisa.barnes@replace-me.invalid',  'viewer', null,       false),
    ('Benjamin Sutton',  'benjamin.sutton@replace-me.invalid', 'viewer', null,    false)
  ) as x(full_name, email, role, team, active)
 where w.slug = '29029'
   and not exists (select 1 from members m where m.workspace_id = w.id and m.full_name = x.full_name);

insert into members (workspace_id, full_name, email, role, team, active)
select w.id, 'Joe Foor', 'joe@deaconjames.com', 'rep', 'pipeline', true
  from workspaces w
 where w.slug = 'deacon-james'
   and not exists (select 1 from members m where m.workspace_id = w.id and m.full_name = 'Joe Foor');

-- the sourcing team, when their names are in:
--   insert into members (workspace_id, full_name, email, role, team, active)
--   select id, '<name>', '<email>', 'rep', 'sourcing', true from workspaces where slug = 'deacon-james';

commit;

select w.slug, w.name, s.mode, s.label, m.full_name, m.role, m.team, m.active
  from workspaces w join deal_sources s on s.workspace_id = w.id left join members m on m.workspace_id = w.id
 where w.slug in ('29029', 'deacon-james')
 order by w.slug, m.role, m.full_name;
