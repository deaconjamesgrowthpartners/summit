-- Summit  migration 006  the maintenance book on screen
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, after 005.
-- Safe to run more than once. No table changes. 005 made the accounts table.

-- ============================================================
-- 1. REALTIME for the book. row level security still applies.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'accounts') then
    alter publication supabase_realtime add table public.accounts;
  end if;
end $$;

-- ============================================================
-- 2. ELEVATION CONFIG
-- grow tab gets a "book" block: what the book is called, the audit
-- window, the satisfaction levels and which ones count as at risk.
-- summit tab gets "tiles": book value and accounts at risk.
-- Change any of this here. Nothing is in the code.
-- ============================================================

update workspaces set tabs = (
  select jsonb_agg(
    case
      when t->>'key' = 'grow' then t || jsonb_build_object('book', '{
        "label": "Maintenance book",
        "audit_days": 90,
        "risk": ["Yellow", "Red"],
        "levels": [{"value":"Green","color":"g"},{"value":"Yellow","color":"y"},{"value":"Red","color":"r"}]
      }'::jsonb)
      when t->>'key' = 'summit' then t || jsonb_build_object('tiles', '[
        {"type":"book_value",   "label":"Maintenance book"},
        {"type":"book_at_risk", "label":"Accounts at risk"}
      ]'::jsonb)
      else t
    end order by ord)
  from jsonb_array_elements(tabs) with ordinality as x(t, ord)
)
where slug = 'elevation-outdoors';

-- show the result
select jsonb_path_query(tabs, '$[*] ? (@.key == "grow").book')    as grow_book,
       jsonb_path_query(tabs, '$[*] ? (@.key == "summit").tiles') as summit_tiles
  from workspaces where slug = 'elevation-outdoors';
