-- Summit  migration 002  front end support
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 001.
-- Safe to run more than once.

-- ============================================================
-- 1. NEW COLUMNS
-- ============================================================

alter table opps add column if not exists priority   boolean not null default false;
alter table opps add column if not exists bid_date   date;
alter table opps add column if not exists stage_date date;
alter table opps add column if not exists crm_ref    text;   -- the id in whatever CRM the client runs

-- the note lives outside committed so a note never trips the late flag
alter table commits add column if not exists note text;

-- product lines and which ones count as recurring revenue
alter table workspaces add column if not exists categories jsonb not null default '[]'::jsonb;
-- the goal tiles on the Summit tab. values live in goals.values
alter table workspaces add column if not exists goal_tiles jsonb not null default '[]'::jsonb;

-- ============================================================
-- 2. AUTH HOOK  roster only
-- Register it in Dashboard > Authentication > Hooks >
-- "Before User Created" > Postgres > public.summit_before_user_created
-- Anyone not on a roster or the admin list never gets an account,
-- so they never get a code.
-- ============================================================

create or replace function summit_before_user_created(event jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare em text := lower(coalesce(event->'user'->>'email', ''));
begin
  if em <> '' and (
       em = 'joe@deaconjames.com'
    or exists (select 1 from app_admins where lower(email) = em)
    or exists (select 1 from members where lower(email) = em and active)
  ) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'Not on the roster'));
end $$;

grant execute on function summit_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function summit_before_user_created(jsonb) from authenticated, anon, public;

-- ============================================================
-- 3. REALTIME  row level security still applies to every event
-- ============================================================

do $$
declare t text;
begin
  foreach t in array array['opps','commits','goals'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============================================================
-- 4. ELEVATION OUTDOORS CONFIG
-- Everything the app shows about Elevation comes from here.
-- ============================================================

update workspaces set
  brand = '{"head":"#1F3E0F","accent":"#017543","bg":"#F4F3EE","panel":"#ECE9E2","muted":"#8C9A8B",
            "font":"Instrument Sans","logo":null}'::jsonb,

  branches = array['Oakwood','Sugar Hill','Knoxville'],

  -- status: open / won / lost. needs_close: open deals here need an expected close.
  -- bid: a bid is out (feeds Bids, Bid $ and the "no start date" check). hold: parked.
  stages = '[
    {"name":"1 - Prospecting",             "prob":0.10, "status":"open"},
    {"name":"2 - Qualified",               "prob":0.25, "status":"open"},
    {"name":"3 - Site Walk / Assessment",  "prob":0.40, "status":"open", "needs_close":true},
    {"name":"4 - Proposal / Bid Sent",     "prob":0.60, "status":"open", "needs_close":true, "bid":true},
    {"name":"5 - Negotiation",             "prob":0.80, "status":"open", "needs_close":true, "bid":true},
    {"name":"6 - Won",                     "prob":1.00, "status":"won",  "bid":true},
    {"name":"7 - Lost",                    "prob":0.00, "status":"lost"},
    {"name":"8 - On Hold",                 "prob":0.05, "status":"open", "needs_close":true, "bid":true, "hold":true}
  ]'::jsonb,

  categories = '[
    {"name":"Maintenance", "recurring":true,  "default_for":"netnew"},
    {"name":"Install",     "recurring":false},
    {"name":"Enhancement", "recurring":false, "default_for":"grow"}
  ]'::jsonb,

  -- auto: filled from the board. bids_count, bids_value, won_value, starts_next_week_value
  measures = '[
    {"key":"audits",  "type":"count", "label":"Site audits", "label_grow":"Site audits",   "label_netnew":"Site walks"},
    {"key":"visits",  "type":"count", "label":"Client visits","label_grow":"Client visits","label_netnew":"Meetings"},
    {"key":"bidsN",   "type":"count", "label":"Bids",        "label_grow":"Bids sent",     "label_netnew":"Bids sent", "auto":"bids_count"},
    {"key":"bidsD",   "type":"money", "label":"Bid $",       "label_grow":"Bid $",         "label_netnew":"Bid $",     "auto":"bids_value"},
    {"key":"wonD",    "type":"money", "label":"Won $",       "label_grow":"Won $",         "label_netnew":"Signed $",  "auto":"won_value"},
    {"key":"startsD", "type":"money", "label":"Starting next week $", "label_grow":"Starting next week $",
                                                                      "label_netnew":"Installing next week $", "auto":"starts_next_week_value"}
  ]'::jsonb,

  -- which screens show, in order, and the words on them
  tabs = '[
    {"key":"summit", "label":"Summit",
     "note":"Goals: new maintenance plus current-client growth by Sept 30 (July 9 offsite). Enhancement growth comes from Aspire and is updated by leadership on the Data Check tab."},
    {"key":"climb",  "label":"The Climb"},
    {"key":"grow",   "label":"Grow", "team":"grow", "title":"Grow", "sub":"existing clients, enhancements",
     "team_label":"Account Managers",
     "note_prompt":"What do you need from Allan, Brooks or ops this week?",
     "branch_measures":["audits","bidsN","bidsD","wonD"],
     "ratio":{"label":"Bids/audit","num":"bidsN","den":"audits","goal":"bidsPerAudit","sub":"standard: 1 bid per site audit"},
     "branch_note":"Allan''s standard: find one thing to propose at every site audit."},
    {"key":"netnew", "label":"Net New", "team":"netnew", "title":"Net New", "sub":"new maintenance and install contracts",
     "team_label":"BDMs",
     "note_prompt":"What do you need from Allan, Brooks or ops this week?",
     "branch_measures":["audits","bidsN","bidsD","wonD"],
     "branch_note":"Expected close and target start are required once a bid is out. That is what feeds the cash ladder."},
    {"key":"accounts", "label":"All Accounts"},
    {"key":"datacheck","label":"Data Check", "crm_label":"Aspire"}
  ]'::jsonb,

  -- source: won_recurring (signed deals in recurring categories) or manual (typed in by leadership)
  goal_tiles = '[
    {"key":"newMaint", "label":"New maintenance", "source":"won_recurring",
     "goal":"newMaintGoal", "deadline":"deadline", "coverage":true},
    {"key":"growth", "label":"Enhancement growth", "source":"manual",
     "goal":"growthGoal", "actual":"growthActual", "as_of":"growthAsOf",
     "actual_label":"Enhancement growth actual (Aspire)"}
  ]'::jsonb
where slug = 'elevation-outdoors';

insert into goals (workspace_id, period, values)
select id, '2026', '{"newMaintGoal":706000,"growthGoal":480000,"growthActual":149994,
                     "growthAsOf":"Aug 2026 Aspire pull","deadline":"2026-09-30","bidsPerAudit":1.0}'::jsonb
  from workspaces where slug = 'elevation-outdoors'
on conflict (workspace_id, period) do nothing;

-- test members: spread across the real three branches.
-- only touches rows whose branch is blank or not one of the three,
-- so real roster edits later are never overwritten.
with ws as (select id, branches from workspaces where slug = 'elevation-outdoors'),
ranked as (
  select m.id, row_number() over (order by m.created_at, m.email) - 1 as rn
    from members m, ws
   where m.workspace_id = ws.id
)
update members m
   set branch = (select branches[1 + (r.rn % array_length(branches, 1))::int] from ws)
  from ranked r, ws
 where m.id = r.id
   and (m.branch is null or not (m.branch = any (ws.branches)));
